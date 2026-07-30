import { execFile } from "node:child_process"
// Direct cross-workspace import — `@altimateai/dbt-tools`'s `src/index.ts` is
// a CLI entry (runs on import), so we bypass the package entrypoint and
// consume the resolver from its file directly. This is the same pattern
// other packages use to share pure utilities across workspace boundaries
// without adding subpath-exports maps.
//
// We DON'T use validateDbt from that module — it's synchronous
// (execFileSync with 10s timeout), which would block the TUI event loop
// for up to 10s on a slow/hung dbt install. Kilo + cubic both flagged
// this after the initial dedupe. We keep resolveDbt (its exec calls are
// cheap discovery-only) but do the actual version probe via async
// execFile below.
import { resolveDbt, buildDbtEnv } from "../../../../dbt-tools/src/dbt-resolve"

/**
 * Probe the user's machine for the toolchain the sample project needs to
 * materialize + run its dbt models.
 *
 * The starter sample's "look-first" workflows (/discover, /review) work with
 * ZERO external tools — they read the shipped pre-compiled manifest. The
 * "run" workflows (dbt build, live queries) need `dbt` on PATH AND the
 * `dbt-duckdb` adapter installed against the same Python. We probe both so
 * the post-materialize UX can hide options that would silently fail.
 *
 * Delegates dbt binary lookup to `resolveDbt` + `validateDbt` from the
 * dbt-tools library. That path knows about every Python env manager
 * (venv, uv, pyenv, conda, pipx, poetry, pdm, homebrew, pip, asdf/mise,
 * nix, hatch, rye, docker, dbt Fusion) — most of which do NOT put dbt on
 * PATH. A prior implementation used plain `execFile("dbt")` which meant
 * users with dbt in a venv would see `dbt: missing` even though it was
 * right there. Reviewer flagged this; single-sourcing the resolver fixes
 * it and keeps future env-manager additions automatic.
 *
 * Detection is intentionally lightweight — we do NOT invoke `dbt debug`
 * against the materialized sample here, because this runs BEFORE
 * materialization (to decide which workflow entries to show in the first
 * place). `dbt --version` output includes the plugin list on dbt 1.x, so
 * scan for the "duckdb" plugin there rather than shelling out again.
 *
 * If probing fails for any reason (timeout, ENOENT, garbage output), we
 * treat that as "tool not usable" — the caller falls back to look-only
 * workflows. Never throws; always returns a defined result.
 */

export interface DbtRuntime {
  /** `dbt --version` succeeded (dbt-core is on PATH or found by resolveDbt). */
  hasDbt: boolean
  /** `dbt --version` output mentions duckdb — best effort at "the adapter is
   *  installed against the same Python that owns this `dbt`". */
  hasDbtDuckdb: boolean
  /** Raw dbt-core version string (e.g. `1.11.8`), when present. Surfaced to
   *  the user in the "install a newer dbt-duckdb" prompt. */
  dbtCoreVersion?: string
}

/** Cache the probe result for the process lifetime — dbt install state
 *  can't change while the CLI is running, and the probe adds a subprocess
 *  fork we don't want to pay on every activation-dialog render.
 *
 *  Callers that need up-to-date state MUST pass `{ force: true }`:
 *   - AFTER materialization (a user might have just run
 *     `pip install dbt-duckdb` in another terminal and then picked
 *     "sample project" — cache says `hasDbtDuckdb=false` but reality
 *     changed since the dialog first rendered).
 *   - BEFORE actually running any dbt-dependent workflow — even a
 *     force-refreshed probe here is cheap compared to a subprocess run
 *     that would silently fail.
 *  Cached path is used for the activation-dialog first-render only. */
let cached: Promise<DbtRuntime> | undefined

export function detectDbtRuntime(opts?: { force?: boolean }): Promise<DbtRuntime> {
  if (!cached || opts?.force) cached = probe()
  return cached
}

/** Test helper: forget the cached probe so successive `detectDbtRuntime`
 *  calls re-probe. Not exported to production code paths. */
export function _resetDbtRuntimeCacheForTests() {
  cached = undefined
}

async function probe(): Promise<DbtRuntime> {
  // resolveDbt: multi-manager search (venv/uv/pyenv/conda/pipx/poetry/…
  // + PATH + explicit override via ALTIMATE_DBT_PATH). Returns the first
  // candidate that exists.
  const resolved = resolveDbt()
  const env = buildDbtEnv(resolved)

  // Async --version invocation. Reads BOTH stdout AND stderr (some dbt 1.x
  // builds write --version output to stderr with color codes). If it fails,
  // hasDbt=false. Kilo/cubic flagged that using validateDbt (execFileSync)
  // here would block the TUI event loop for up to 10s per cache miss.
  let out = await runDbtVersion(resolved.path, env)

  // Windows fallback: resolveDbt only tries `.exe` binaries. Some Windows
  // installs (older `pip install --user`, corporate distributions,
  // WSL-bridge shims) expose dbt as `.cmd`/`.bat` which needs cmd.exe.
  // If the primary probe missed, retry through `cmd.exe /c` — its resolver
  // honours PATHEXT for `.cmd`/`.bat`. Args are constants; no injection.
  if (!out.ok && process.platform === "win32") {
    out = await runDbtVia(env, "cmd.exe", ["/c", "dbt", "--version"])
  }
  if (!out.ok) return { hasDbt: false, hasDbtDuckdb: false }

  // dbt --version on 1.x prints:
  //   Core:
  //     - installed: 1.11.8
  //   Plugins:
  //     - duckdb: 1.11.4 - Update available!
  // Match the plugin line specifically ("- duckdb:") — a generic "duckdb"
  // substring would false-positive on an "install dbt-duckdb" upgrade hint.
  const combined = `${out.stdout}\n${out.stderr}`
  const hasDbtDuckdb = /^\s*-\s*duckdb:/m.test(combined)

  const versionMatch =
    combined.match(/-\s*installed:\s*([0-9]+\.[0-9]+\.[0-9]+\S*)/) ??
    combined.match(/core=([0-9]+\.[0-9]+\.[0-9]+\S*)/)
  return {
    hasDbt: true,
    hasDbtDuckdb,
    dbtCoreVersion: versionMatch?.[1],
  }
}

interface DbtVersionResult {
  ok: boolean
  stdout: string
  stderr: string
}

/** Async `<dbt> --version` with the PATH-injected env resolveDbt/buildDbtEnv
 *  gave us. On error (ENOENT, non-zero exit, timeout) resolves ok=false;
 *  never rejects. */
function runDbtVersion(dbtPath: string, env: Record<string, string | undefined>): Promise<DbtVersionResult> {
  return runDbtVia(env, dbtPath, ["--version"])
}

function runDbtVia(
  env: Record<string, string | undefined>,
  cmd: string,
  args: string[],
): Promise<DbtVersionResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5_000, env: env as NodeJS.ProcessEnv }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: stdout || "", stderr: stderr || (error ? String(error) : "") })
    })
  })
}

