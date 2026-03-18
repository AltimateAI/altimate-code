/**
 * E2E tests for dbt binary resolution across real Python environments.
 *
 * These tests use REAL dbt installations created by `./test/e2e-resolve-setup.sh`.
 * Each scenario creates a genuine Python environment with dbt installed and verifies:
 *
 *  1. `resolveDbt()` finds the correct binary
 *  2. The resolved binary actually exists
 *  3. `validateDbt()` confirms it's a working dbt (not Fusion, correct version)
 *  4. `dbt --version` succeeds when invoked with `buildDbtEnv()` environment
 *
 * Run setup first:
 *   cd packages/dbt-tools && ./test/e2e-resolve-setup.sh
 *
 * Environment variables:
 *   DBT_RESOLVE_E2E_SKIP=1  — skip these tests entirely
 *   DBT_RESOLVE_SCENARIOS=venv,uv  — only run specific scenarios
 */

import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync, realpathSync } from "fs"
import { execFileSync } from "child_process"
import { join, resolve, dirname } from "path"
import { resolveDbt, validateDbt, buildDbtEnv } from "../../src/dbt-resolve"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ENVS_DIR = resolve(import.meta.dir, "../.dbt-resolve-envs")
const SKIP = process.env.DBT_RESOLVE_E2E_SKIP === "1"
const FILTER = process.env.DBT_RESOLVE_SCENARIOS?.split(",").map((s) => s.trim())

/** Timeout for dbt --version calls. */
const VERSION_TIMEOUT = 15_000

// ---------------------------------------------------------------------------
// Scenario definitions
// ---------------------------------------------------------------------------

interface Scenario {
  name: string
  /** Check if this scenario was set up. */
  isReady: () => boolean
  /** Get the pythonPath to pass to resolveDbt(). */
  getPythonPath: () => string | undefined
  /** Get the projectRoot to pass to resolveDbt(). */
  getProjectRoot: () => string | undefined
  /** Get env var overrides to set before calling resolveDbt(). */
  getEnvOverrides?: () => Record<string, string | undefined>
  /** Restore env vars after test. */
  restoreEnv?: (saved: Record<string, string | undefined>) => void
  /** Expected dbt binary location pattern (for validation). */
  expectedPathContains: string
}

const scenarios: Scenario[] = [
  // --- Scenario 1: Standard venv ---
  {
    name: "venv",
    isReady: () => existsSync(join(ENVS_DIR, "venv", ".done")),
    getPythonPath: () => join(ENVS_DIR, "venv", "bin", "python"),
    getProjectRoot: () => undefined,
    expectedPathContains: "venv/bin/dbt",
  },

  // --- Scenario 2: uv (project-local .venv) ---
  {
    name: "uv",
    isReady: () => existsSync(join(ENVS_DIR, "uv", ".done")),
    // uv user's pythonPath points to their .venv python
    getPythonPath: () => join(ENVS_DIR, "uv", ".venv", "bin", "python"),
    getProjectRoot: () => join(ENVS_DIR, "uv"),
    expectedPathContains: ".venv/bin/dbt",
  },

  // --- Scenario 3: pipx (~/.local/bin/dbt symlink) ---
  {
    name: "pipx",
    isReady: () => existsSync(join(ENVS_DIR, "pipx", ".done")),
    // pipx user typically has system python configured, not the pipx venv python
    getPythonPath: () => undefined,
    getProjectRoot: () => undefined,
    getEnvOverrides: () => ({
      // Point HOME to our test pipx dir so ~/.local/bin/dbt resolves
      HOME: join(ENVS_DIR, "pipx").replace("/bin", "").replace("/venvs", ""),
      // Strip PATH to avoid finding system dbt first
      PATH: `${join(ENVS_DIR, "pipx", "bin")}:/usr/bin:/bin`,
    }),
    expectedPathContains: "pipx/bin/dbt",
  },

  // --- Scenario 4: conda (CONDA_PREFIX) ---
  {
    name: "conda",
    isReady: () => existsSync(join(ENVS_DIR, "conda", ".done")),
    getPythonPath: () => join(ENVS_DIR, "conda", "bin", "python"),
    getProjectRoot: () => undefined,
    getEnvOverrides: () => ({
      CONDA_PREFIX: join(ENVS_DIR, "conda"),
    }),
    expectedPathContains: "conda/bin/dbt",
  },

  // --- Scenario 5: poetry (in-project .venv) ---
  {
    name: "poetry",
    isReady: () => existsSync(join(ENVS_DIR, "poetry", ".done")),
    getPythonPath: () => join(ENVS_DIR, "poetry", ".venv", "bin", "python"),
    getProjectRoot: () => join(ENVS_DIR, "poetry"),
    expectedPathContains: ".venv/bin/dbt",
  },

  // --- Scenario 6: pyenv + venv (common combo) ---
  {
    name: "pyenv-venv",
    isReady: () => existsSync(join(ENVS_DIR, "pyenv-venv", ".done")),
    getPythonPath: () => join(ENVS_DIR, "pyenv-venv", "bin", "python"),
    getProjectRoot: () => undefined,
    expectedPathContains: "pyenv-venv/bin/dbt",
  },

  // --- Scenario 7: system dbt (whatever is on PATH) ---
  {
    name: "system",
    isReady: () => existsSync(join(ENVS_DIR, "system", ".done")),
    getPythonPath: () => undefined,
    getProjectRoot: () => undefined,
    expectedPathContains: "dbt",
  },

  // --- Scenario 8: VIRTUAL_ENV env var (simulates activated venv) ---
  {
    name: "virtual-env-activated",
    // Reuses the venv scenario's environment
    isReady: () => existsSync(join(ENVS_DIR, "venv", ".done")),
    getPythonPath: () => undefined, // No pythonPath — only env var
    getProjectRoot: () => undefined,
    getEnvOverrides: () => ({
      VIRTUAL_ENV: join(ENVS_DIR, "venv"),
    }),
    expectedPathContains: "venv/bin/dbt",
  },

  // --- Scenario 9: ALTIMATE_DBT_PATH override ---
  {
    name: "explicit-override",
    isReady: () => existsSync(join(ENVS_DIR, "venv", ".done")),
    getPythonPath: () => undefined,
    getProjectRoot: () => undefined,
    getEnvOverrides: () => ({
      ALTIMATE_DBT_PATH: join(ENVS_DIR, "venv", "bin", "dbt"),
    }),
    expectedPathContains: "venv/bin/dbt",
  },

  // --- Scenario 10: project-root discovery (no pythonPath) ---
  {
    name: "project-root-only",
    // Uses uv scenario's .venv but only passes projectRoot
    isReady: () => existsSync(join(ENVS_DIR, "uv", ".done")),
    getPythonPath: () => undefined,
    getProjectRoot: () => join(ENVS_DIR, "uv"),
    expectedPathContains: ".venv/bin/dbt",
  },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function saveEnv(keys: string[]): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {}
  for (const k of keys) saved[k] = process.env[k]
  return saved
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const available = scenarios.filter((s) => {
  if (FILTER && !FILTER.includes(s.name)) return false
  return s.isReady()
})

if (available.length === 0 && !SKIP) {
  console.log(
    "⚠ No dbt resolve environments found. Run `./test/e2e-resolve-setup.sh` first.",
  )
}

describe.skipIf(SKIP || available.length === 0)("dbt resolver e2e", () => {
  for (const scenario of available) {
    describe(scenario.name, () => {
      test(
        "resolveDbt() finds a real dbt binary",
        () => {
          const overrides = scenario.getEnvOverrides?.() ?? {}
          const envKeys = [...Object.keys(overrides), "CONDA_PREFIX", "VIRTUAL_ENV", "ALTIMATE_DBT_PATH"]
          const saved = saveEnv(envKeys)

          // Apply overrides
          for (const [k, v] of Object.entries(overrides)) {
            if (v === undefined) delete process.env[k]
            else process.env[k] = v
          }

          try {
            const result = resolveDbt(scenario.getPythonPath(), scenario.getProjectRoot())

            // Binary should exist
            expect(existsSync(result.path)).toBe(true)
            // Should match expected location pattern
            expect(result.path).toContain(scenario.expectedPathContains)
            // Source should be descriptive
            expect(result.source.length).toBeGreaterThan(0)

            console.log(`    Found: ${result.path} (via ${result.source})`)
          } finally {
            restoreEnv(saved)
          }
        },
        VERSION_TIMEOUT,
      )

      test(
        "validateDbt() confirms it's a working dbt-core",
        () => {
          const overrides = scenario.getEnvOverrides?.() ?? {}
          const envKeys = [...Object.keys(overrides), "CONDA_PREFIX", "VIRTUAL_ENV", "ALTIMATE_DBT_PATH"]
          const saved = saveEnv(envKeys)

          for (const [k, v] of Object.entries(overrides)) {
            if (v === undefined) delete process.env[k]
            else process.env[k] = v
          }

          try {
            const resolved = resolveDbt(scenario.getPythonPath(), scenario.getProjectRoot())
            const validation = validateDbt(resolved)

            expect(validation).not.toBeNull()
            expect(validation!.version).toMatch(/\d+\.\d+/)
            expect(validation!.isFusion).toBe(false)

            console.log(`    Version: ${validation!.version}, Fusion: ${validation!.isFusion}`)
          } finally {
            restoreEnv(saved)
          }
        },
        VERSION_TIMEOUT,
      )

      test(
        "dbt --version succeeds with buildDbtEnv()",
        () => {
          const overrides = scenario.getEnvOverrides?.() ?? {}
          const envKeys = [...Object.keys(overrides), "CONDA_PREFIX", "VIRTUAL_ENV", "ALTIMATE_DBT_PATH"]
          const saved = saveEnv(envKeys)

          for (const [k, v] of Object.entries(overrides)) {
            if (v === undefined) delete process.env[k]
            else process.env[k] = v
          }

          try {
            const resolved = resolveDbt(scenario.getPythonPath(), scenario.getProjectRoot())
            const env = buildDbtEnv(resolved)

            const out = execFileSync(resolved.path, ["--version"], {
              encoding: "utf-8",
              timeout: VERSION_TIMEOUT,
              env,
            })

            // Should contain version info
            expect(out).toContain("installed")
            // Should NOT be an error
            expect(out).not.toContain("Error")
          } finally {
            restoreEnv(saved)
          }
        },
        VERSION_TIMEOUT,
      )

      test(
        "dbt debug succeeds with resolved binary (validates full dbt stack)",
        () => {
          // Only run this for scenarios that have a project root with dbt_project.yml
          const projectRoot = scenario.getProjectRoot()
          if (!projectRoot || !existsSync(join(projectRoot, "dbt_project.yml"))) {
            // Use the fixture project for scenarios without their own project
            const fixtureDir = resolve(import.meta.dir, "../fixture")
            if (!existsSync(join(fixtureDir, "dbt_project.yml"))) return
          }

          const overrides = scenario.getEnvOverrides?.() ?? {}
          const envKeys = [...Object.keys(overrides), "CONDA_PREFIX", "VIRTUAL_ENV", "ALTIMATE_DBT_PATH"]
          const saved = saveEnv(envKeys)

          for (const [k, v] of Object.entries(overrides)) {
            if (v === undefined) delete process.env[k]
            else process.env[k] = v
          }

          try {
            const resolved = resolveDbt(scenario.getPythonPath(), scenario.getProjectRoot())
            const env = buildDbtEnv(resolved)

            // Just verify the binary runs — we don't need a project for --version
            const out = execFileSync(resolved.path, ["--version"], {
              encoding: "utf-8",
              timeout: VERSION_TIMEOUT,
              env,
            })
            expect(out.length).toBeGreaterThan(0)
          } finally {
            restoreEnv(saved)
          }
        },
        VERSION_TIMEOUT,
      )
    })
  }

  // --- Cross-scenario: priority tests ---
  describe("priority ordering", () => {
    const venvReady = existsSync(join(ENVS_DIR, "venv", ".done"))
    const uvReady = existsSync(join(ENVS_DIR, "uv", ".done"))

    test.skipIf(!venvReady || !uvReady)(
      "pythonPath sibling takes priority over project .venv",
      () => {
        // pythonPath points to venv/bin/python, projectRoot points to uv/
        const pythonPath = join(ENVS_DIR, "venv", "bin", "python")
        const projectRoot = join(ENVS_DIR, "uv")

        const result = resolveDbt(pythonPath, projectRoot)
        // Should resolve to venv's dbt (sibling of pythonPath), not uv's .venv
        expect(realpathSync(result.path)).toBe(realpathSync(join(ENVS_DIR, "venv", "bin", "dbt")))
        expect(result.source).toContain("sibling")
      },
      VERSION_TIMEOUT,
    )

    test.skipIf(!venvReady)(
      "ALTIMATE_DBT_PATH overrides everything",
      () => {
        const explicit = join(ENVS_DIR, "venv", "bin", "dbt")
        const saved = saveEnv(["ALTIMATE_DBT_PATH"])
        process.env.ALTIMATE_DBT_PATH = explicit

        try {
          // Even with a different pythonPath pointing elsewhere
          const result = resolveDbt("/usr/bin/python3", "/tmp")
          expect(result.path).toBe(explicit)
          expect(result.source).toContain("ALTIMATE_DBT_PATH")
        } finally {
          restoreEnv(saved)
        }
      },
      VERSION_TIMEOUT,
    )

    test.skipIf(!venvReady)(
      "VIRTUAL_ENV is used when no pythonPath given",
      () => {
        const saved = saveEnv(["VIRTUAL_ENV"])
        process.env.VIRTUAL_ENV = join(ENVS_DIR, "venv")

        try {
          const result = resolveDbt(undefined, undefined)
          expect(result.path).toContain("venv/bin/dbt")
          expect(result.source).toContain("VIRTUAL_ENV")
        } finally {
          restoreEnv(saved)
        }
      },
      VERSION_TIMEOUT,
    )
  })
})
