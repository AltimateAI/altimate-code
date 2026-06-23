import { promises as fs } from "node:fs"
import path from "node:path"
import YAML from "yaml"

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
  cwd: string
  projectName?: string
  /** Directory holding HEAD-side compiled SQL (relative to cwd). */
  headDir?: string
  /** Directory holding BASE-side compiled SQL (relative to cwd). */
  baseDir?: string
}

/**
 * Build a resolver that returns dbt-compiled SQL for a model file + side, or
 * undefined when no compiled artifact is present.
 */
export function makeCompiledResolver(opts: CompiledResolverOptions) {
  const project = opts.projectName
  const headDir = opts.headDir ?? "target/compiled"
  const baseDir = opts.baseDir ?? "target-base/compiled"

  return async (file: string, side: "old" | "new"): Promise<string | undefined> => {
    if (!project) return undefined
    const root = side === "new" ? headDir : baseDir
    const full = path.join(opts.cwd, root, project, file)
    try {
      return await fs.readFile(full, "utf8")
    } catch {
      return undefined
    }
  }
}
