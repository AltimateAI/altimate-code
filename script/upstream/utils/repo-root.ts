// Repo-root resolution via `git rev-parse --show-toplevel`.
//
// Unlike utils/git.ts and utils/config.ts (which resolve the root by walking
// a fixed number of directories up from __dirname), the S1 de-fork tools
// (census.ts, divergence.ts, replay.ts) must work correctly no matter where
// the compiled/bundled script physically lives, and must never hardcode a
// path. `git rev-parse --show-toplevel` from cwd is the one source of truth.

import { execSync } from "child_process"

let cached: string | null = null

/**
 * Resolve the repository root by asking git, starting from `cwd`.
 * Result is cached per-process (the root cannot change mid-run).
 * Throws a clear error if `cwd` is not inside a git working tree.
 */
export function resolveRepoRoot(cwd: string = process.cwd()): string {
  if (cached) return cached
  try {
    const out = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
    }).trim()
    if (!out) throw new Error("empty output")
    cached = out
    return out
  } catch (err) {
    throw new Error(
      `Unable to resolve repository root via 'git rev-parse --show-toplevel' from ${cwd}. ` +
        `Are you running this inside a git working tree? (${(err as Error).message})`,
    )
  }
}

/** Reset the cache. Test-only. */
export function __resetRepoRootCacheForTests(): void {
  cached = null
}
