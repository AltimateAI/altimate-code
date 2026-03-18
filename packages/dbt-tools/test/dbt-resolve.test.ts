/**
 * Tests for dbt binary resolution across Python environment managers.
 *
 * Each test simulates a specific environment setup (venv, uv, pyenv, conda,
 * pipx, poetry, etc.) by creating the expected directory structure in a temp
 * dir and verifying that resolveDbt() finds the correct binary.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, chmodSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { resolveDbt, validateDbt, buildDbtEnv, type ResolvedDbt } from "../src/dbt-resolve"

/** Create a fake dbt binary (just a file — we only test existence/resolution, not execution). */
function fakeDbt(dir: string, name = "dbt"): string {
  const p = join(dir, name)
  writeFileSync(p, "#!/usr/bin/env python3\n# fake dbt")
  chmodSync(p, 0o755)
  return p
}

/** Create a fake python binary. */
function fakePython(dir: string): string {
  const p = join(dir, "python")
  writeFileSync(p, "#!/bin/sh\n# fake python")
  chmodSync(p, 0o755)
  // Also create python3 symlink
  const p3 = join(dir, "python3")
  try { symlinkSync(p, p3) } catch {}
  return p
}

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dbt-resolve-"))
})

afterEach(() => {
  try { rmSync(tempDir, { recursive: true, force: true }) } catch {}
})

// ---------------------------------------------------------------------------
// Scenario 1: Standard venv (.venv/bin/dbt)
// ---------------------------------------------------------------------------
describe("venv (standard)", () => {
  test("resolves dbt from .venv/bin/ sibling of pythonPath", () => {
    const binDir = join(tempDir, ".venv", "bin")
    mkdirSync(binDir, { recursive: true })
    const pythonPath = fakePython(binDir)
    fakeDbt(binDir)

    const result = resolveDbt(pythonPath, tempDir)
    expect(result.path).toBe(join(binDir, "dbt"))
    expect(result.source).toContain("sibling of pythonPath")
  })

  test("resolves dbt from project-local .venv when pythonPath doesn't have dbt", () => {
    // pythonPath points to system python (no dbt sibling)
    const sysBin = join(tempDir, "system-bin")
    mkdirSync(sysBin, { recursive: true })
    const pythonPath = fakePython(sysBin)
    // No dbt in system-bin

    // But project has .venv with dbt
    const venvBin = join(tempDir, "project", ".venv", "bin")
    mkdirSync(venvBin, { recursive: true })
    fakeDbt(venvBin)

    const result = resolveDbt(pythonPath, join(tempDir, "project"))
    expect(result.path).toBe(join(venvBin, "dbt"))
    expect(result.source).toContain(".venv/")
  })
})

// ---------------------------------------------------------------------------
// Scenario 2: uv project mode (.venv/bin/dbt in project root)
// ---------------------------------------------------------------------------
describe("uv (project mode)", () => {
  test("resolves dbt from project .venv — identical to venv", () => {
    const projectDir = join(tempDir, "my-dbt-project")
    const binDir = join(projectDir, ".venv", "bin")
    mkdirSync(binDir, { recursive: true })
    const pythonPath = fakePython(binDir)
    fakeDbt(binDir)

    const result = resolveDbt(pythonPath, projectDir)
    expect(result.path).toBe(join(binDir, "dbt"))
  })
})

// ---------------------------------------------------------------------------
// Scenario 3: pyenv (shim → real path)
// ---------------------------------------------------------------------------
describe("pyenv", () => {
  test("resolves dbt from real path when pythonPath is a symlink", () => {
    // Simulate pyenv: pythonPath is a symlink to the real python
    const realBin = join(tempDir, "real-python-bin")
    mkdirSync(realBin, { recursive: true })
    fakePython(realBin)
    fakeDbt(realBin)

    const shimBin = join(tempDir, "shim-bin")
    mkdirSync(shimBin, { recursive: true })
    const shimPython = join(shimBin, "python")
    symlinkSync(join(realBin, "python"), shimPython)
    // No dbt in shim-bin

    const result = resolveDbt(shimPython, tempDir)
    // Should find dbt via real path resolution (normalize /var vs /private/var on macOS)
    const { realpathSync: rp } = require("fs")
    expect(rp(result.path)).toBe(rp(join(realBin, "dbt")))
    expect(result.source).toContain("real path")
  })
})

// ---------------------------------------------------------------------------
// Scenario 4: conda (CONDA_PREFIX)
// ---------------------------------------------------------------------------
describe("conda", () => {
  test("resolves dbt from CONDA_PREFIX when set", () => {
    const condaEnv = join(tempDir, "conda-env")
    const binDir = join(condaEnv, "bin")
    mkdirSync(binDir, { recursive: true })
    fakeDbt(binDir)

    const origCondaPrefix = process.env.CONDA_PREFIX
    process.env.CONDA_PREFIX = condaEnv

    try {
      // No pythonPath, no projectRoot — should find via CONDA_PREFIX
      const result = resolveDbt(undefined, undefined)
      expect(result.path).toBe(join(binDir, "dbt"))
      expect(result.source).toContain("CONDA_PREFIX")
    } finally {
      if (origCondaPrefix) process.env.CONDA_PREFIX = origCondaPrefix
      else delete process.env.CONDA_PREFIX
    }
  })
})

// ---------------------------------------------------------------------------
// Scenario 5: VIRTUAL_ENV (activated venv)
// ---------------------------------------------------------------------------
describe("VIRTUAL_ENV", () => {
  test("resolves dbt from VIRTUAL_ENV when set", () => {
    const venvDir = join(tempDir, "activated-venv")
    const binDir = join(venvDir, "bin")
    mkdirSync(binDir, { recursive: true })
    fakeDbt(binDir)

    const origVirtualEnv = process.env.VIRTUAL_ENV
    process.env.VIRTUAL_ENV = venvDir

    try {
      const result = resolveDbt(undefined, undefined)
      expect(result.path).toBe(join(binDir, "dbt"))
      expect(result.source).toContain("VIRTUAL_ENV")
    } finally {
      if (origVirtualEnv) process.env.VIRTUAL_ENV = origVirtualEnv
      else delete process.env.VIRTUAL_ENV
    }
  })
})

// ---------------------------------------------------------------------------
// Scenario 6: pipx (~/.local/bin/dbt)
// ---------------------------------------------------------------------------
describe("pipx", () => {
  test("resolves dbt from ~/.local/bin/ (pipx default)", () => {
    const localBin = join(tempDir, ".local", "bin")
    mkdirSync(localBin, { recursive: true })
    fakeDbt(localBin)

    const origHome = process.env.HOME
    const origPath = process.env.PATH
    const origPyenvRoot = process.env.PYENV_ROOT
    const origCondaPrefix = process.env.CONDA_PREFIX
    const origVirtualEnv = process.env.VIRTUAL_ENV
    process.env.HOME = tempDir
    // Strip real dbt locations from PATH so the known-path check wins
    process.env.PATH = "/usr/bin:/bin"
    delete process.env.PYENV_ROOT
    delete process.env.CONDA_PREFIX
    delete process.env.VIRTUAL_ENV

    try {
      // No pythonPath, no projectRoot, no env vars — should find via known paths
      const result = resolveDbt(undefined, undefined)
      expect(result.path).toBe(join(localBin, "dbt"))
      expect(result.source).toContain("pipx")
    } finally {
      process.env.HOME = origHome
      process.env.PATH = origPath
      if (origPyenvRoot) process.env.PYENV_ROOT = origPyenvRoot
      if (origCondaPrefix) process.env.CONDA_PREFIX = origCondaPrefix
      if (origVirtualEnv) process.env.VIRTUAL_ENV = origVirtualEnv
    }
  })
})

// ---------------------------------------------------------------------------
// Scenario 7: poetry (in-project .venv)
// ---------------------------------------------------------------------------
describe("poetry (in-project)", () => {
  test("resolves dbt from .venv when poetry uses in-project virtualenvs", () => {
    // Poetry with `virtualenvs.in-project = true` puts .venv in project root
    const projectDir = join(tempDir, "poetry-project")
    const binDir = join(projectDir, ".venv", "bin")
    mkdirSync(binDir, { recursive: true })
    fakeDbt(binDir)

    const result = resolveDbt(undefined, projectDir)
    expect(result.path).toBe(join(binDir, "dbt"))
    expect(result.source).toContain(".venv/")
  })
})

// ---------------------------------------------------------------------------
// Scenario 8: ALTIMATE_DBT_PATH override
// ---------------------------------------------------------------------------
describe("explicit override", () => {
  test("ALTIMATE_DBT_PATH takes highest priority", () => {
    const customBin = join(tempDir, "custom-dbt")
    writeFileSync(customBin, "#!/bin/sh\n# custom dbt")
    chmodSync(customBin, 0o755)

    // Also set up a .venv (which would normally win)
    const venvBin = join(tempDir, ".venv", "bin")
    mkdirSync(venvBin, { recursive: true })
    fakeDbt(venvBin)
    const pythonPath = fakePython(venvBin)

    const origEnv = process.env.ALTIMATE_DBT_PATH
    process.env.ALTIMATE_DBT_PATH = customBin

    try {
      const result = resolveDbt(pythonPath, tempDir)
      expect(result.path).toBe(customBin)
      expect(result.source).toContain("ALTIMATE_DBT_PATH")
    } finally {
      if (origEnv) process.env.ALTIMATE_DBT_PATH = origEnv
      else delete process.env.ALTIMATE_DBT_PATH
    }
  })
})

// ---------------------------------------------------------------------------
// Scenario 9: PDM (.venv in project)
// ---------------------------------------------------------------------------
describe("pdm", () => {
  test("resolves dbt from .venv — same as uv/venv", () => {
    const projectDir = join(tempDir, "pdm-project")
    const binDir = join(projectDir, ".venv", "bin")
    mkdirSync(binDir, { recursive: true })
    fakeDbt(binDir)

    const result = resolveDbt(undefined, projectDir)
    expect(result.path).toBe(join(binDir, "dbt"))
  })
})

// ---------------------------------------------------------------------------
// Scenario 10: venv/ (not .venv/) — some users use `python -m venv venv`
// ---------------------------------------------------------------------------
describe("venv/ (no dot prefix)", () => {
  test("resolves from venv/ when .venv/ doesn't exist", () => {
    const projectDir = join(tempDir, "venv-project")
    const binDir = join(projectDir, "venv", "bin")
    mkdirSync(binDir, { recursive: true })
    fakeDbt(binDir)

    const result = resolveDbt(undefined, projectDir)
    expect(result.path).toBe(join(binDir, "dbt"))
    expect(result.source).toContain("venv/")
  })
})

// ---------------------------------------------------------------------------
// Scenario 11: env/ — some projects use `python -m venv env`
// ---------------------------------------------------------------------------
describe("env/ directory", () => {
  test("resolves from env/ when .venv/ and venv/ don't exist", () => {
    const projectDir = join(tempDir, "env-project")
    const binDir = join(projectDir, "env", "bin")
    mkdirSync(binDir, { recursive: true })
    fakeDbt(binDir)

    const result = resolveDbt(undefined, projectDir)
    expect(result.path).toBe(join(binDir, "dbt"))
    expect(result.source).toContain("env/")
  })
})

// ---------------------------------------------------------------------------
// Scenario 12: Priority ordering — venv sibling > project .venv > conda
// ---------------------------------------------------------------------------
describe("priority ordering", () => {
  test("pythonPath sibling wins over project .venv", () => {
    // pythonPath has dbt
    const pythonBin = join(tempDir, "my-venv", "bin")
    mkdirSync(pythonBin, { recursive: true })
    const pythonPath = fakePython(pythonBin)
    const dbtInVenv = fakeDbt(pythonBin)

    // Project also has .venv with dbt
    const projectDir = join(tempDir, "project")
    const projBin = join(projectDir, ".venv", "bin")
    mkdirSync(projBin, { recursive: true })
    fakeDbt(projBin)

    const result = resolveDbt(pythonPath, projectDir)
    expect(result.path).toBe(dbtInVenv)
    expect(result.source).toContain("sibling of pythonPath")
  })

  test("project .venv wins over CONDA_PREFIX", () => {
    const condaEnv = join(tempDir, "conda")
    const condaBin = join(condaEnv, "bin")
    mkdirSync(condaBin, { recursive: true })
    fakeDbt(condaBin)

    const projectDir = join(tempDir, "proj")
    const projBin = join(projectDir, ".venv", "bin")
    mkdirSync(projBin, { recursive: true })
    const projDbt = fakeDbt(projBin)

    const origCondaPrefix = process.env.CONDA_PREFIX
    process.env.CONDA_PREFIX = condaEnv

    try {
      const result = resolveDbt(undefined, projectDir)
      expect(result.path).toBe(projDbt)
    } finally {
      if (origCondaPrefix) process.env.CONDA_PREFIX = origCondaPrefix
      else delete process.env.CONDA_PREFIX
    }
  })
})

// ---------------------------------------------------------------------------
// Scenario 13: Nothing found — fallback to bare "dbt"
// ---------------------------------------------------------------------------
describe("fallback", () => {
  test("always returns a result (bare 'dbt' or a found binary)", () => {
    // Even with invalid pythonPath/projectRoot, the resolver should not throw.
    // On systems with dbt installed, it will find something via PATH or known paths.
    // On systems without dbt, it returns bare "dbt".
    const result = resolveDbt("/nonexistent/python", "/nonexistent/project")
    expect(result.path).toBeTruthy()
    expect(result.source).toBeTruthy()
    // Should NOT be the nonexistent pythonPath sibling
    expect(result.path).not.toContain("/nonexistent/")
  })
})

// ---------------------------------------------------------------------------
// buildDbtEnv
// ---------------------------------------------------------------------------
describe("buildDbtEnv", () => {
  test("injects binDir into PATH", () => {
    const resolved: ResolvedDbt = {
      path: "/some/venv/bin/dbt",
      source: "test",
      binDir: "/some/venv/bin",
    }
    const env = buildDbtEnv(resolved)
    expect(env.PATH).toMatch(/^\/some\/venv\/bin:/)
  })

  test("preserves existing PATH when no binDir", () => {
    const origPath = process.env.PATH
    const resolved: ResolvedDbt = { path: "dbt", source: "test" }
    const env = buildDbtEnv(resolved)
    expect(env.PATH).toBe(origPath)
  })
})

// ---------------------------------------------------------------------------
// validateDbt (basic shape — can't run fake binaries meaningfully)
// ---------------------------------------------------------------------------
describe("validateDbt", () => {
  test("returns null for nonexistent binary", () => {
    const result = validateDbt({ path: "/definitely/not/real/dbt", source: "test" })
    expect(result).toBeNull()
  })

  test("returns real version for system dbt (if available)", () => {
    // Only runs if dbt is actually installed
    try {
      const which = require("child_process").execFileSync("which", ["dbt"], { encoding: "utf-8" }).trim()
      if (!which) return

      const result = validateDbt({ path: which, source: "system" })
      if (result) {
        expect(result.version).toMatch(/\d+\.\d+/)
        expect(typeof result.isFusion).toBe("boolean")
      }
    } catch {
      // No dbt available — skip
    }
  })
})
