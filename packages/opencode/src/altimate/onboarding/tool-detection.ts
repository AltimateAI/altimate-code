import { execFile } from "node:child_process"
// Direct cross-workspace import — `@altimateai/dbt-tools`'s `src/index.ts` is
// a CLI entry (runs on import), so we bypass the package entrypoint and
// consume the resolver from its file directly. This is the same pattern
// other packages use to share pure utilities across workspace boundaries
// without adding subpath-exports maps.
import { resolveDbt, validateDbt, buildDbtEnv } from "../../../../dbt-tools/src/dbt-resolve"

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
  // candidate that exists + is executable.
  const resolved = resolveDbt()
  // validateDbt: runs `<path> --version`, parses version + Fusion detection.
  // Returns null on ENOENT/timeout/non-zero exit.
  const validated = validateDbt(resolved)
  if (!validated) return { hasDbt: false, hasDbtDuckdb: false }

  // For the dbt-duckdb adapter check, re-run --version and grep the plugin
  // list. buildDbtEnv() gives us the right PATH so venv-scoped dbts find
  // their adapters. validateDbt doesn't return raw output, so this is the
  // one bit of duplicate subprocess work we accept — cheaper than teaching
  // validateDbt to expose plugins.
  const versionOut = await captureVersionOutput(resolved.path, buildDbtEnv(resolved))
  // dbt --version on 1.x prints:
  //   Core:
  //     - installed: 1.11.8
  //   Plugins:
  //     - duckdb: 1.11.4 - Update available!
  // Match the plugin line specifically ("- duckdb:") — a generic "duckdb"
  // substring would false-positive on an "install dbt-duckdb" upgrade hint.
  const hasDbtDuckdb = /^\s*-\s*duckdb:/m.test(versionOut)

  // Version fallback: some dbt 1.x builds write `--version` output to
  // STDERR (with color codes). validateDbt uses execFileSync which reads
  // stdout only, so it reports "unknown" for those. We already collected
  // stdout+stderr via captureVersionOutput for the plugin check — reuse
  // that combined text to recover the version.
  let dbtCoreVersion = validated.version === "unknown" ? undefined : validated.version
  if (!dbtCoreVersion) {
    const m = versionOut.match(/-\s*installed:\s*([0-9]+\.[0-9]+\.[0-9]+\S*)/) ?? versionOut.match(/core=([0-9]+\.[0-9]+\.[0-9]+\S*)/)
    if (m) dbtCoreVersion = m[1]
  }
  return { hasDbt: true, hasDbtDuckdb, dbtCoreVersion }
}

/** One extra `<dbt> --version` invocation to grab the plugin list, using
 *  the environment resolveDbt/buildDbtEnv gave us (correct PATH for
 *  venv-scoped installs). Falls through as empty on any error — the outer
 *  `hasDbt` flag from validateDbt has already told us dbt itself works. */
function captureVersionOutput(dbtPath: string, env: Record<string, string | undefined>): Promise<string> {
  return new Promise((resolve) => {
    execFile(dbtPath, ["--version"], { timeout: 5_000, env: env as NodeJS.ProcessEnv }, (_error, stdout, stderr) => {
      resolve(`${stdout || ""}\n${stderr || ""}`)
    })
  })
}

