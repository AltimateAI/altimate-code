import { promises as fs } from "node:fs"
import path from "node:path"
import YAML from "yaml"
import { safeReadInside } from "./git"

/**
 * Resolve dbt's COMPILED SQL for static analysis.
 *
 * dbt models are Jinja templates; the SQL-AST engine (equivalence/check/grade)
 * needs rendered SQL. Re-implementing Jinja (regex or even minijinja) is the
 * wrong layer — dbt already renders correctly. So, exactly like Datafold and
 * Recce, and mirroring dbt-Fusion's render-then-analyze split, we consume dbt's
 * own compiled output:
 *
 *   - HEAD side → `target/compiled/<project>/<model path>` (written by `dbt compile`)
 *   - BASE side → `target-base/compiled/<project>/<model path>` (Recce's convention:
 *     the base ref compiled into a sibling target dir)
 *
 * When no compiled artifact exists (no `dbt compile` ran, or a raw single-file
 * diff), the caller falls back to raw Jinja and the engine result is treated as
 * approximate/undecidable — never fabricated. A proper offline renderer
 * (minijinja + dbt builtin stubs, à la dbt-Fusion) is the documented future
 * fallback; it is intentionally NOT a regex strip.
 */

/** Read the dbt project name from dbt_project.yml (needed for the compiled path). */
export async function dbtProjectName(cwd: string): Promise<string | undefined> {
  for (const f of ["dbt_project.yml", "dbt_project.yaml"]) {
    try {
      const doc = YAML.parse(await fs.readFile(path.join(cwd, f), "utf8"))
      if (doc?.name) return String(doc.name)
    } catch {
      /* try next */
    }
  }
  return undefined
}

export interface CompiledResolverOptions {
  /** dbt project root (the dir containing `dbt_project.yml`). */
  cwd: string
  projectName?: string
  /** Directory holding HEAD-side compiled SQL (relative to cwd, or absolute). */
  headDir?: string
  /** Directory holding BASE-side compiled SQL (relative to cwd, or absolute). */
  baseDir?: string
  /** Prefix within the repo-relative file path that maps to `cwd`.
   *  For a monorepo where the dbt project lives at `packages/dbt/`, callers
   *  pass `pathPrefix: "packages/dbt"` so a repo-relative path like
   *  `packages/dbt/models/foo.sql` resolves inside the dbt project root as
   *  `models/foo.sql` before joining with `target/compiled/<project>/`.
   *  Omit when `cwd` IS the repo root. */
  pathPrefix?: string
}

/**
 * Build a resolver that returns dbt-compiled SQL for a model file + side, or
 * undefined when no compiled artifact is present.
 */
export function makeCompiledResolver(opts: CompiledResolverOptions) {
  const project = opts.projectName
  const headDir = opts.headDir ?? "target/compiled"
  const baseDir = opts.baseDir ?? "target-base/compiled"
  // Normalise the prefix so both "" and "." mean "no prefix". Match against
  // git-style forward slashes because `git diff --name-status` always emits
  // POSIX separators regardless of platform. `path.relative()` on Windows
  // returns backslashes, so callers passing that verbatim would produce a
  // prefix that never matches — normalise here (codex R20 review HIGH).
  const prefix =
    opts.pathPrefix && opts.pathPrefix !== "."
      ? opts.pathPrefix.replace(/\\/g, "/").replace(/\/+$/, "")
      : ""

  return async (file: string, side: "old" | "new"): Promise<string | undefined> => {
    if (!project) return undefined
    // When the dbt project sits inside a subdir of the repo, `file` (from
    // `git diff --name-status`) is repo-root relative and always uses
    // POSIX separators. Strip the mapped prefix so it becomes dbt-root
    // relative before joining with `cwd` (which IS the dbt root). Without
    // this the compiled resolver silently misses in monorepo layouts.
    const rel = prefix && (file === prefix || file.startsWith(prefix + "/")) ? file.slice(prefix.length + 1) : file
    const root = side === "new" ? headDir : baseDir
    const rootAbs = path.isAbsolute(root) ? root : path.join(opts.cwd, root)
    const compiledRoot = path.join(rootAbs, project)
    // Shared realpath containment check — matches makeContentResolver's
    // symlink-safe read so a future tweak to the containment logic can't
    // leave one call site behind (cubic + kilo suggestion).
    return await safeReadInside(compiledRoot, rel)
  }
}
