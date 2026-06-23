// altimate_change start — shared validator utilities
/**
 * Shared utilities for altimate dbt validators.
 *
 * Centralises logic that previously existed in both dbt-tests-pass.ts and
 * dbt-schema-verify.ts to prevent behavioural divergence. Both files already
 * imported from ../../session/validators/types so the "standalone files"
 * argument for duplication was already moot; a sibling utility adds zero new
 * coupling.
 */

import { promises as fs } from "fs"
import { join, sep, basename } from "path"

// ---------------------------------------------------------------------------
// Subprocess timeout
// ---------------------------------------------------------------------------

/**
 * Maximum milliseconds to wait for an `altimate-dbt` subprocess before
 * killing it and treating the model as unverifiable. Overrideable via
 * ALTIMATE_VALIDATORS_TIMEOUT_MS for benchmark environments where dbt startup
 * time varies.
 *
 * Parses with a finite/positive guard: NaN, 0, or negative values are rejected
 * and fall back to the 60 s default, preventing immediate SIGKILL of the process.
 */
const DEFAULT_TIMEOUT_MS = 60_000
const _parsed = Number(process.env.ALTIMATE_VALIDATORS_TIMEOUT_MS)
export const VALIDATOR_TIMEOUT_MS =
  Number.isFinite(_parsed) && _parsed > 0 ? _parsed : DEFAULT_TIMEOUT_MS

// ---------------------------------------------------------------------------
// Project detection
// ---------------------------------------------------------------------------

/**
 * Find the actual dbt project root starting from `cwd`.
 *
 * Checks `cwd` itself for `dbt_project.yml`, then scans one level of
 * subdirectories (some benchmark layouts nest the project one level deep).
 *
 * Returns the directory that contains `dbt_project.yml`, or null if not
 * found. The returned path is the correct `cwd` for subprocess invocations.
 */
// Subdirectories never considered candidates for a nested dbt project.
// Mirrors `modelsModifiedSince`'s skip list so a fixture project shipped
// inside `node_modules/foo/` or a compiled artifact in `target/` doesn't get
// confused for the user's real project.
const FIND_DBT_PROJECT_SKIP_DIRS = new Set(["node_modules", "target"])

export async function findDbtProjectRoot(cwd: string): Promise<string | null> {
  try {
    const direct = join(cwd, "dbt_project.yml")
    if (await isProjectFile(direct)) return cwd
    const entries = await fs.readdir(cwd, { withFileTypes: true }).catch(
      () => [] as import("fs").Dirent[],
    )
    // Sort alphabetically so the choice is deterministic when multiple
    // subdirectories contain a dbt_project.yml. fs.readdir's order varies
    // across filesystems / Node versions. Skip dependency / build dirs.
    const sorted = entries
      .filter((e) => e.isDirectory())
      .filter((e) => !e.name.startsWith(".") && !FIND_DBT_PROJECT_SKIP_DIRS.has(e.name))
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const e of sorted) {
      const nested = join(cwd, e.name, "dbt_project.yml")
      if (await isProjectFile(nested)) return join(cwd, e.name)
    }
    return null
  } catch {
    return null
  }
}

/** True only if `path` is an existing *file* (not a directory). */
async function isProjectFile(path: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path)
    return stat.isFile()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

/**
 * Find dbt model `.sql` files under `cwd` that were modified since `sinceMs`.
 * Scans up to 8 directory levels deep (deep enough for typical dbt layouts
 * like `models/staging/sources/dl/raw/...`); skips hidden dirs, node_modules,
 * target. Only returns files under a `models/` ancestor (case-insensitive,
 * to tolerate case-insensitive volumes on macOS APFS / Windows NTFS).
 */
const MODELS_MAX_DEPTH = 8
export async function modelsModifiedSince(cwd: string, sinceMs: number): Promise<string[]> {
  const found: string[] = []
  async function scan(dir: string, depth: number): Promise<void> {
    if (depth > MODELS_MAX_DEPTH) return
    let entries: import("fs").Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (
        entry.name.startsWith(".") ||
        entry.name === "node_modules" ||
        entry.name === "target"
      )
        continue
      const full = join(dir, entry.name)
      // Follow symlinks: a symlinked SQL file should be discoverable, and a
      // symlinked directory under `models/` should be entered. Resolve the
      // target with fs.stat (follows links) instead of relying on Dirent's
      // entry.isFile()/isDirectory() which return false for symlinks.
      let isDir = entry.isDirectory()
      let isFile = entry.isFile()
      if (entry.isSymbolicLink()) {
        try {
          const target = await fs.stat(full)
          isDir = target.isDirectory()
          isFile = target.isFile()
        } catch {
          // Broken symlink — skip without crashing.
          continue
        }
      }
      if (isDir) {
        await scan(full, depth + 1)
      } else if (isFile && entry.name.toLowerCase().endsWith(".sql")) {
        try {
          const stat = await fs.stat(full)
          if (stat.mtimeMs >= sinceMs) {
            // dbt models live under a `models/` ancestor. Case-insensitive
            // comparison so `Models/` or `MODELS/` on case-insensitive volumes
            // are accepted.
            if (full.split(sep).some((p) => p.toLowerCase() === "models")) {
              found.push(full)
            }
          }
        } catch {
          // ignore unstattable files
        }
      }
    }
  }
  await scan(cwd, 0)
  return found
}

// ---------------------------------------------------------------------------
// Path utilities
// ---------------------------------------------------------------------------

/**
 * Extract the bare model name from a `.sql` file path.
 * `models/marts/foo.sql` -> `foo`
 *
 * Handles both POSIX (`/`) and Windows (`\\`) path separators so that the
 * helper works on a Windows-style path even when running on POSIX. Strips
 * any embedded NUL bytes so the returned name is safe to pass as a shell
 * argument downstream.
 */
export function modelNameFromPath(p: string): string {
  if (!p) return ""
  // Normalise Windows separators to POSIX so basename behaves identically
  // regardless of host. This is safe because dbt model paths never contain
  // a literal `\\` as part of the name.
  const normalised = p.replace(/\\/g, "/")
  const base = basename(normalised)
  // Strip the `.sql` extension and any embedded NUL bytes (so the returned
  // value is safe to pass as a shell argument downstream).
  // eslint-disable-next-line no-control-regex
  return base.replace(/\.sql$/i, "").replace(/\x00/g, "")
}

// ---------------------------------------------------------------------------
// Concurrency utilities
// ---------------------------------------------------------------------------

/**
 * Run `fn` over `items` with at most `limit` concurrent tasks at a time.
 *
 * Unbounded Promise.all over model lists can spawn too many simultaneous dbt
 * subprocesses, causing resource contention, port conflicts, or flaky results.
 * This helper caps the active workers while preserving output order.
 */
export async function runWithConcurrencyLimit<In, Out>(
  items: In[],
  fn: (item: In) => Promise<Out>,
  limit: number,
): Promise<Out[]> {
  const results: Out[] = new Array(items.length)
  if (items.length === 0) return results
  // Determine effective worker count:
  //   - Infinity → treat as "unbounded" = items.length (full parallel).
  //   - NaN, 0, negatives, fractional < 1 → fall back to 1 (serial) so we
  //     never silently drop work via Array.from({length: 0}).
  //   - Floor positive floats and cap at items.length so we never spawn
  //     more workers than there is work to do.
  let effective: number
  if (limit === Infinity) {
    effective = items.length
  } else if (Number.isFinite(limit) && limit >= 1) {
    effective = Math.min(Math.floor(limit), items.length)
  } else {
    effective = 1
  }
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i]!)
    }
  }
  const workers = Array.from({ length: effective }, worker)
  await Promise.all(workers)
  return results
}

/** Maximum simultaneous altimate-dbt subprocesses per validator run. */
export const VALIDATOR_CONCURRENCY =
  (() => {
    const v = Number(process.env.ALTIMATE_VALIDATORS_CONCURRENCY)
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 4
  })()

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

/**
 * Find the LAST top-level `{ ... }` block in a string and JSON-parse it.
 *
 * `altimate-dbt` may emit dbt log noise (ANSI codes, parser warnings, Python
 * tracebacks) before the verdict JSON. Strategy:
 *   1. Try JSON.parse on the full stdout (fast path for clean output).
 *   2. Scan forward for each `{`, track brace depth + string context to find
 *      the matching `}`, attempt JSON.parse on that slice, keep the last one
 *      that matches the expected envelope shape.
 *
 * Only accepts objects that look like altimate-dbt envelopes (must contain at
 * least one of: `verdict`, `error`, `model`, `stdout`, `columns_extra`,
 * `columns_missing`). This prevents stray JSON log fragments (e.g. a dbt
 * config snippet with `{"config": ...}`) from being mistaken for the verdict.
 *
 * Returns null if no valid envelope is found.
 */
export function extractLastJsonObject(stdout: string): Record<string, unknown> | null {
  if (!stdout) return null
  // Fast path: stdout is pure JSON
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>
    if (isValidEnvelope(parsed)) return parsed
  } catch {
    // fall through
  }
  let best: Record<string, unknown> | null = null
  for (let i = 0; i < stdout.length; i++) {
    if (stdout[i] !== "{") continue
    let depth = 0
    let inString: '"' | null = null
    let escaped = false
    for (let j = i; j < stdout.length; j++) {
      const ch = stdout[j]!
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === "\\") {
        escaped = true
        continue
      }
      if (inString) {
        if (ch === inString) inString = null
        continue
      }
      if (ch === '"') {
        inString = '"'
        continue
      }
      if (ch === "{") depth++
      else if (ch === "}") {
        depth--
        if (depth === 0) {
          try {
            const parsed = JSON.parse(stdout.slice(i, j + 1)) as Record<string, unknown>
            if (isValidEnvelope(parsed)) {
              best = parsed
            }
          } catch {
            // skip malformed slice
          }
          break
        }
      }
    }
  }
  return best
}

/**
 * Guard: returns true only for objects that look like altimate-dbt output
 * envelopes. Rejects stray JSON fragments that happen to be valid JSON.
 *
 * Requires at least one envelope key to have a *defined, non-null* value.
 * `{"verdict": null}` is not a real envelope — it's a stray fragment with
 * the right shape. (We do allow `error: null` because the historical
 * test contract treats a present-but-null error as "no error".)
 */
function isValidEnvelope(obj: Record<string, unknown>): boolean {
  if (typeof obj !== "object" || obj === null) return false
  const meaningful = (k: string) => k in obj && obj[k] !== undefined && obj[k] !== null
  // `error: null` is intentionally allowed (sentinel for "ran cleanly").
  return (
    meaningful("verdict") ||
    "error" in obj ||
    meaningful("model") ||
    meaningful("stdout") ||
    meaningful("columns_extra") ||
    meaningful("columns_missing")
  )
}
// altimate_change end
