import { join, resolve } from "path"
import { existsSync } from "fs"
import { execFileSync } from "child_process"
import { write, type Config } from "../config"
import { all } from "../check"

function find(start: string): string | null {
  let dir = resolve(start)
  while (true) {
    if (existsSync(join(dir, "dbt_project.yml"))) return dir
    const parent = resolve(dir, "..")
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Discover the Python binary, checking multiple environment managers.
 *
 * Priority:
 *  1. Project-local .venv/bin/python (uv, pdm, venv, poetry in-project)
 *  2. VIRTUAL_ENV/bin/python (activated venv)
 *  3. CONDA_PREFIX/bin/python (conda)
 *  4. `which python3` / `which python` (system PATH)
 *  5. Fallback "python3" (hope for the best)
 */
function python(projectRoot?: string): string {
  // Check project-local venvs first (most reliable for dbt projects)
  if (projectRoot) {
    for (const venvDir of [".venv", "venv", "env"]) {
      const py = join(projectRoot, venvDir, "bin", "python")
      if (existsSync(py)) return py
    }
  }

  // Check VIRTUAL_ENV (set by activate scripts)
  const virtualEnv = process.env.VIRTUAL_ENV
  if (virtualEnv) {
    const py = join(virtualEnv, "bin", "python")
    if (existsSync(py)) return py
  }

  // Check CONDA_PREFIX (set by conda activate)
  const condaPrefix = process.env.CONDA_PREFIX
  if (condaPrefix) {
    const py = join(condaPrefix, "bin", "python")
    if (existsSync(py)) return py
  }

  // Fall back to PATH-based discovery
  for (const cmd of ["python3", "python"]) {
    try {
      return execFileSync("which", [cmd], { encoding: "utf-8" }).trim()
    } catch {}
  }
  return "python3"
}

export async function init(args: string[]) {
  const idx = args.indexOf("--project-root")
  const root = idx >= 0 ? args[idx + 1] : undefined
  const pidx = args.indexOf("--python-path")
  const py = pidx >= 0 ? args[pidx + 1] : undefined

  const project = root ? resolve(root) : find(process.cwd())
  if (!project) return { error: "No dbt_project.yml found. Use --project-root to specify." }
  if (!existsSync(join(project, "dbt_project.yml"))) return { error: `No dbt_project.yml in ${project}` }

  const cfg: Config = {
    projectRoot: project,
    pythonPath: py ?? python(project),
    dbtIntegration: "corecommand",
    queryLimit: 500,
  }

  await write(cfg)

  const health = await all(cfg)
  if (!health.passed) {
    const warnings = Object.entries(health.checks)
      .filter(([, v]) => !v.ok)
      .map(([k, v]) => ({ check: k, ...(v as { ok: false; error: string; fix: string }) }))
    return { ok: true, config: cfg, warnings }
  }

  return { ok: true, config: cfg }
}
