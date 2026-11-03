import { homedir } from "os"
import { join, resolve } from "path"
import { readFile, writeFile, mkdir } from "fs/promises"
import { existsSync } from "fs"
import { execFileSync } from "child_process"

type Config = {
  projectRoot: string
  pythonPath: string
  dbtIntegration: string
  queryLimit: number
}

function configDir() {
  return join(process.env.HOME || homedir(), ".altimate-code")
}

function configPath() {
  return join(configDir(), "dbt.json")
}

/**
 * Walk up from `start` to find the nearest directory containing dbt_project.yml.
 * Returns null if none found.
 */
export function findProjectRoot(start = process.cwd()): string | null {
  let dir = resolve(start)
  while (true) {
    if (existsSync(join(dir, "dbt_project.yml"))) return dir
    const parent = resolve(dir, "..")
    if (parent === dir) return null
    dir = parent
  }
}

const isWindows = process.platform === "win32"
// Windows venvs use Scripts/, Unix venvs use bin/
const VENV_BIN = isWindows ? "Scripts" : "bin"
// Windows executables have .exe suffix
const EXE = isWindows ? ".exe" : ""

/**
 * Discover the Python binary for a given project root.
 * Priority: project-local .venv → VIRTUAL_ENV → CONDA_PREFIX → which/where python
 */
export function discoverPython(projectRoot: string): string {
  // Candidate Python binary names (python3 first on Unix; python.exe on Windows)
  const pythonBins = isWindows ? ["python.exe", "python3.exe"] : ["python3", "python"]

  // Project-local venvs (uv, pdm, venv, poetry in-project, rye)
  for (const venvDir of [".venv", "venv", "env"]) {
    for (const bin of pythonBins) {
      const py = join(projectRoot, venvDir, VENV_BIN, bin)
      if (existsSync(py)) return py
    }
  }

  // VIRTUAL_ENV (set by activate scripts)
  const virtualEnv = process.env.VIRTUAL_ENV
  if (virtualEnv) {
    for (const bin of pythonBins) {
      const py = join(virtualEnv, VENV_BIN, bin)
      if (existsSync(py)) return py
    }
  }

  // CONDA_PREFIX (Conda places python at env root on Windows, bin/ on Unix)
  const condaPrefix = process.env.CONDA_PREFIX
  if (condaPrefix) {
    for (const bin of pythonBins) {
      const py = isWindows ? join(condaPrefix, bin) : join(condaPrefix, VENV_BIN, bin)
      if (existsSync(py)) return py
    }
  }

  // PATH-based discovery (`where` on Windows, `which` on Unix)
  const whichCmd = isWindows ? "where" : "which"
  const cmds = isWindows ? ["python.exe", "python3.exe", "python"] : ["python3", "python"]
  for (const cmd of cmds) {
    try {
      // `where` on Windows may return multiple lines — take the first
      const first = execFileSync(whichCmd, [cmd], { encoding: "utf-8", timeout: 5_000 }).trim().split(/\r?\n/)[0]
      if (first) return first
    } catch {}
  }
  return isWindows ? "python.exe" : "python3"
}

async function read(): Promise<Config | null> {
  const p = configPath()
  if (existsSync(p)) {
    try {
      const raw = await readFile(p, "utf-8")
      return JSON.parse(raw) as Config
    } catch {
      // Malformed config — fall through to auto-discovery
    }
  }
  // No config file — auto-discover from cwd so `altimate-dbt init` isn't required
  const projectRoot = findProjectRoot()
  if (!projectRoot) return null
  return {
    projectRoot,
    pythonPath: discoverPython(projectRoot),
    dbtIntegration: "corecommand",
    queryLimit: 500,
  }
}

async function write(cfg: Config) {
  const d = configDir()
  await mkdir(d, { recursive: true })
  await writeFile(join(d, "dbt.json"), JSON.stringify(cfg, null, 2))
}

export { read, write, configPath as path, type Config }
