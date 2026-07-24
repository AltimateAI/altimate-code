import { execFile } from "node:child_process"

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
  /** `dbt --version` succeeded (dbt-core is on PATH). */
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
 *  fork we don't want to pay on every activation-dialog render. */
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
  const out = await tryExec("dbt", ["--version"], 5_000)
  if (!out.ok) return { hasDbt: false, hasDbtDuckdb: false }

  // dbt --version on 1.x prints something like:
  //   Core:
  //     - installed: 1.11.8
  //     - latest:    1.12.0 - Update available!
  //   Plugins:
  //     - duckdb: 1.11.4 - Update available!
  // We look for the plugin line specifically ("- duckdb:") rather than any
  // "duckdb" substring so the presence of the word inside an upgrade hint
  // ("Try dbt-duckdb...") doesn't false-positive.
  const combined = `${out.stdout}\n${out.stderr}`
  const hasDbtDuckdb = /^\s*-\s*duckdb:/m.test(combined)

  const versionMatch = combined.match(/-\s*installed:\s*([0-9]+\.[0-9]+\.[0-9]+)/)
  const dbtCoreVersion = versionMatch?.[1]

  return { hasDbt: true, hasDbtDuckdb, dbtCoreVersion }
}

interface ExecResult {
  ok: boolean
  stdout: string
  stderr: string
}

function tryExec(cmd: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        // ENOENT = not on PATH; timeout, non-zero exit, other errors all
        // resolve as "not usable". Never rejects.
        resolve({ ok: false, stdout: stdout || "", stderr: stderr || String(error) })
        return
      }
      resolve({ ok: true, stdout: stdout || "", stderr: stderr || "" })
    })
  })
}
