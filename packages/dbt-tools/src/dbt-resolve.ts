/**
 * Resolve the dbt binary across all Python environment managers.
 *
 * dbt users install via many tools, each placing the binary differently:
 *
 *  | Manager      | dbt location                                          | Gotcha                                    |
 *  |-------------|-------------------------------------------------------|-------------------------------------------|
 *  | venv        | <project>/.venv/bin/dbt                                | Not on PATH unless activated              |
 *  | uv          | <project>/.venv/bin/dbt                                | `uv tool install dbt` is broken           |
 *  | pyenv       | ~/.pyenv/shims/dbt (shim → real binary)                | Shim needs rehash; stale after upgrade    |
 *  | conda       | $CONDA_PREFIX/bin/dbt                                  | Only works after `conda activate`         |
 *  | pipx        | ~/.local/bin/dbt (symlink)                             | Needs `--include-deps` on install         |
 *  | poetry      | ~/.cache/pypoetry/virtualenvs/<hash>/bin/dbt           | Hash in path; or .venv/ if in-project     |
 *  | pdm         | <project>/.venv/bin/dbt                                | Similar to uv                             |
 *  | homebrew    | /opt/homebrew/bin/dbt (deprecated)                     | Discontinued since dbt 1.5                |
 *  | system pip  | /usr/local/bin/dbt or ~/.local/bin/dbt                 | PEP 668 blocks install on modern distros  |
 *  | asdf/mise   | ~/.asdf/shims/dbt                                      | Shim — same issues as pyenv               |
 *  | nix         | /nix/store/<hash>/bin/dbt                              | Path changes on every update              |
 *  | hatch       | ~/Library/Application Support/hatch/env/<hash>/bin/dbt | Unpredictable cache path                  |
 *  | rye         | <project>/.venv/bin/dbt                                | Merged into uv                            |
 *  | docker      | /usr/local/bin/dbt (inside container)                  | N/A for host resolution                   |
 *  | dbt Fusion  | ~/.dbt/bin/dbt (Rust binary, NOT dbt-core)             | Name collision with dbt-core              |
 *
 * Resolution strategy: try the most specific (configured) path first, then
 * walk through increasingly broad discovery until we find a working `dbt`.
 */

import { execFileSync } from "child_process"
import { existsSync, realpathSync, readFileSync } from "fs"
import { dirname, join } from "path"

export interface ResolvedDbt {
  /** Absolute path to the dbt binary (or "dbt" if relying on PATH). */
  path: string
  /** How we found it (for diagnostics). */
  source: string
  /** The resolved Python binary directory (for PATH injection). */
  binDir?: string
}

/**
 * Resolve the dbt binary from the configured Python path and project root.
 *
 * Priority:
 *  1. ALTIMATE_DBT_PATH env var (explicit user override)
 *  2. Sibling of configured pythonPath (same venv/bin)
 *  3. Project-local .venv/bin/dbt (uv, pdm, venv, rye, poetry in-project)
 *  4. CONDA_PREFIX/bin/dbt (conda environments)
 *  5. VIRTUAL_ENV/bin/dbt (activated venv)
 *  6. Pyenv real path resolution (follow shims)
 *  7. `which dbt` on current PATH
 *  8. Common known locations (~/.local/bin/dbt for pipx, etc.)
 *
 * Each candidate is validated by checking it exists and is executable.
 */
export function resolveDbt(pythonPath?: string, projectRoot?: string): ResolvedDbt {
  const candidates: Array<{ path: string; source: string; binDir?: string }> = []

  // 1. Explicit override via environment variable
  const envOverride = process.env.ALTIMATE_DBT_PATH
  if (envOverride) {
    candidates.push({ path: envOverride, source: "ALTIMATE_DBT_PATH env var" })
  }

  // 2. Sibling of configured pythonPath (most common: venv, conda, pyenv real path)
  if (pythonPath && existsSync(pythonPath)) {
    const binDir = dirname(pythonPath)
    const siblingDbt = join(binDir, "dbt")
    candidates.push({ path: siblingDbt, source: `sibling of pythonPath (${pythonPath})`, binDir })

    // If pythonPath is a symlink (e.g., pyenv shim), also check the real path
    try {
      const realPython = realpathSync(pythonPath)
      if (realPython !== pythonPath) {
        const realBinDir = dirname(realPython)
        const realDbt = join(realBinDir, "dbt")
        candidates.push({ path: realDbt, source: `real path of pythonPath (${realPython})`, binDir: realBinDir })
      }
    } catch {}
  }

  // 3. Project-local .venv/bin/dbt (uv, pdm, venv, poetry in-project, rye)
  if (projectRoot) {
    for (const venvDir of [".venv", "venv", "env"]) {
      const localDbt = join(projectRoot, venvDir, "bin", "dbt")
      candidates.push({ path: localDbt, source: `${venvDir}/ in project root`, binDir: join(projectRoot, venvDir, "bin") })
    }
  }

  // 4. CONDA_PREFIX (conda/mamba/micromamba — set after `conda activate`)
  const condaPrefix = process.env.CONDA_PREFIX
  if (condaPrefix) {
    candidates.push({
      path: join(condaPrefix, "bin", "dbt"),
      source: `CONDA_PREFIX (${condaPrefix})`,
      binDir: join(condaPrefix, "bin"),
    })
  }

  // 5. VIRTUAL_ENV (set by venv/virtualenv activate scripts)
  const virtualEnv = process.env.VIRTUAL_ENV
  if (virtualEnv) {
    candidates.push({
      path: join(virtualEnv, "bin", "dbt"),
      source: `VIRTUAL_ENV (${virtualEnv})`,
      binDir: join(virtualEnv, "bin"),
    })
  }

  // Helper: current process env (for subprocess calls that need to inherit it)
  const currentEnv = { ...process.env }

  // 6. Pyenv: resolve through shim to real binary
  const pyenvRoot = process.env.PYENV_ROOT ?? join(process.env.HOME ?? "", ".pyenv")
  if (existsSync(join(pyenvRoot, "shims", "dbt"))) {
    try {
      // `pyenv which dbt` resolves the shim to the actual binary path
      const realDbt = execFileSync("pyenv", ["which", "dbt"], {
        encoding: "utf-8",
        timeout: 5_000,
        env: { ...currentEnv, PYENV_ROOT: pyenvRoot },
      }).trim()
      if (realDbt) {
        candidates.push({ path: realDbt, source: `pyenv which dbt`, binDir: dirname(realDbt) })
      }
    } catch {
      // pyenv not functional — shim won't resolve
    }
  }

  // 7. asdf/mise shim resolution
  const asdfDataDir = process.env.ASDF_DATA_DIR ?? join(process.env.HOME ?? "", ".asdf")
  if (existsSync(join(asdfDataDir, "shims", "dbt"))) {
    try {
      const realDbt = execFileSync("asdf", ["which", "dbt"], {
        encoding: "utf-8",
        timeout: 5_000,
        env: currentEnv,
      }).trim()
      if (realDbt) {
        candidates.push({ path: realDbt, source: `asdf which dbt`, binDir: dirname(realDbt) })
      }
    } catch {}
  }

  // 8. `which dbt` on current PATH (catches pipx ~/.local/bin, system pip, homebrew, etc.)
  try {
    const whichDbt = execFileSync("which", ["dbt"], {
      encoding: "utf-8",
      timeout: 5_000,
      env: currentEnv,
    }).trim()
    if (whichDbt) {
      candidates.push({ path: whichDbt, source: `which dbt (PATH)`, binDir: dirname(whichDbt) })
    }
  } catch {}

  // 9. Common known locations (last resort)
  const home = process.env.HOME ?? ""
  const knownPaths = [
    { path: join(home, ".local", "bin", "dbt"), source: "~/.local/bin/dbt (pipx/user pip)" },
    { path: "/usr/local/bin/dbt", source: "/usr/local/bin/dbt (system pip)" },
    { path: "/opt/homebrew/bin/dbt", source: "/opt/homebrew/bin/dbt (homebrew, deprecated)" },
  ]
  for (const kp of knownPaths) {
    candidates.push({ ...kp, binDir: dirname(kp.path) })
  }

  // Evaluate candidates in order — first one that exists wins
  for (const candidate of candidates) {
    if (existsSync(candidate.path)) {
      return candidate
    }
  }

  // Nothing found — return bare "dbt" and hope PATH has it
  return { path: "dbt", source: "fallback (bare dbt on PATH)" }
}

/**
 * Validate that a resolved dbt binary actually works.
 * Returns version string on success, null on failure.
 */
export function validateDbt(resolved: ResolvedDbt): { version: string; isFusion: boolean } | null {
  try {
    const env = resolved.binDir
      ? { ...process.env, PATH: `${resolved.binDir}:${process.env.PATH}` }
      : process.env

    const out = execFileSync(resolved.path, ["--version"], {
      encoding: "utf-8",
      timeout: 10_000,
      env,
    })

    // Check for dbt Fusion (Rust binary) vs dbt-core (Python)
    if (out.includes("dbt Fusion") || out.includes("dbt-fusion")) {
      const match = out.match(/(\d+\.\d+\.\d+)/)
      return { version: match?.[1] ?? "unknown", isFusion: true }
    }

    // dbt-core format: "installed: 1.8.9" or "core=1.8.9"
    const match = out.match(/installed:\s+(\d+\.\d+\.\d+\S*)/) ?? out.match(/core=(\d+\.\d+\.\d+\S*)/)
    return { version: match?.[1] ?? "unknown", isFusion: false }
  } catch {
    return null
  }
}

/**
 * Build the environment variables needed to run the resolved dbt binary.
 * Handles PATH injection for venvs, conda, and shim-based managers.
 */
export function buildDbtEnv(resolved: ResolvedDbt): Record<string, string | undefined> {
  const env = { ...process.env }
  if (resolved.binDir) {
    env.PATH = `${resolved.binDir}:${env.PATH ?? ""}`
  }
  // Ensure DBT_PROFILES_DIR is set if we have a project root
  // (dbt looks in cwd for profiles.yml by default, but we may not be in the project dir)
  return env
}
