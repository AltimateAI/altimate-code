import { existsSync } from "fs"
import { execFileSync } from "child_process"
import { join } from "path"
import type { Config } from "./config"

type Status = { ok: true } | { ok: false; error: string; fix: string }

function run(cmd: string, args: string[]): { ok: boolean; stdout: string } {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf-8", timeout: 10000 })
    return { ok: true, stdout: out.trim() }
  } catch {
    return { ok: false, stdout: "" }
  }
}

async function python(path: string): Promise<Status> {
  if (!path) return { ok: false, error: "No Python path configured", fix: "Run: altimate-dbt init --python-path /path/to/python3" }
  if (!existsSync(path)) return { ok: false, error: `Python not found at: ${path}`, fix: "Run: altimate-dbt init --python-path $(which python3)" }
  const result = run(path, ["--version"])
  if (!result.ok) return { ok: false, error: `Python at ${path} is not working`, fix: "Ensure Python 3.8+ is installed: brew install python3" }
  return { ok: true }
}

async function dbt(pythonPath: string): Promise<Status> {
  const result = run(pythonPath, ["-c", "import dbt.version; print(dbt.version.installed)"])
  if (!result.ok) {
    const pip = run(pythonPath, ["-m", "pip", "install", "dbt-core", "--dry-run"])
    const cmd = pip.ok ? `${pythonPath} -m pip install dbt-core` : "pip install dbt-core"
    return { ok: false, error: "dbt-core is not installed in the configured Python environment", fix: `Install it: ${cmd}` }
  }
  return { ok: true }
}

function project(root: string): Status {
  if (!root) return { ok: false, error: "No project root configured", fix: "Run: altimate-dbt init --project-root /path/to/dbt/project" }
  if (!existsSync(root)) return { ok: false, error: `Project directory not found: ${root}`, fix: "Check the path or re-run: altimate-dbt init" }
  if (!existsSync(join(root, "dbt_project.yml"))) return { ok: false, error: `No dbt_project.yml in: ${root}`, fix: "Ensure this is a dbt project directory, then re-run: altimate-dbt init" }
  return { ok: true }
}

export async function all(cfg: Config) {
  const checks = {
    python: await python(cfg.pythonPath),
    dbt: cfg.pythonPath && existsSync(cfg.pythonPath) ? await dbt(cfg.pythonPath) : { ok: false as const, error: "Skipped (Python not found)", fix: "Fix Python first" },
    project: project(cfg.projectRoot),
  }
  const passed = Object.values(checks).every((c) => c.ok)
  return { passed, checks }
}

export async function validate(cfg: Config): Promise<string | null> {
  const result = await all(cfg)
  if (result.passed) return null
  const errors = Object.entries(result.checks)
    .filter(([, v]) => !v.ok)
    .map(([k, v]) => {
      const s = v as { ok: false; error: string; fix: string }
      return `  ${k}: ${s.error}\n    -> ${s.fix}`
    })
  return `Prerequisites not met:\n${errors.join("\n")}`
}
