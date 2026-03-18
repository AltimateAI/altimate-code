/**
 * End-to-end tests for altimate-dbt commands against a real dbt project.
 *
 * Uses the fixture project in test/fixture/ (DuckDB-based, no server needed).
 *
 * MULTI-VERSION TESTING
 * --------------------
 * Tests run against every dbt version found in test/.dbt-venvs/<version>/.
 * To set up venvs: `./test/e2e-setup.sh` (creates 1.7, 1.8, 1.9, 1.10).
 *
 * If no venvs exist, tests fall back to the system `dbt` (if available).
 * If no dbt is available at all, the entire suite is skipped.
 *
 * Environment variables:
 *   DBT_E2E_VERSIONS  — comma-separated list of versions to test (e.g. "1.8,1.9")
 *   DBT_E2E_SKIP      — set to "1" to skip e2e tests entirely
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { execFileSync, execSync } from "child_process"
import { existsSync, mkdtempSync, cpSync, rmSync, readdirSync } from "fs"
import { join, resolve } from "path"
import { tmpdir } from "os"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const FIXTURE_DIR = resolve(import.meta.dir, "../fixture")
const VENVS_DIR = resolve(import.meta.dir, "../.dbt-venvs")
const SKIP = process.env.DBT_E2E_SKIP === "1"

/** Timeout for dbt commands (seed + build can be slow on first run) */
const DBT_TIMEOUT = 120_000
/** Timeout for individual test assertions */
const TEST_TIMEOUT = 60_000

// ---------------------------------------------------------------------------
// Discover available dbt versions
// ---------------------------------------------------------------------------

interface DbtVersion {
  /** Short label, e.g. "1.8" */
  label: string
  /** Full version string, e.g. "1.8.7" */
  full: string
  /** Absolute path to dbt binary */
  dbtPath: string
  /** Absolute path to python binary (same venv) */
  pythonPath: string
}

function discoverVersions(): DbtVersion[] {
  const filterVersions = process.env.DBT_E2E_VERSIONS?.split(",").map((v) => v.trim())
  const versions: DbtVersion[] = []

  // Check venvs
  if (existsSync(VENVS_DIR)) {
    for (const entry of readdirSync(VENVS_DIR)) {
      if (filterVersions && !filterVersions.includes(entry)) continue
      const dbtPath = join(VENVS_DIR, entry, "bin", "dbt")
      const pythonPath = join(VENVS_DIR, entry, "bin", "python")
      if (!existsSync(dbtPath)) continue

      try {
        const out = execFileSync(dbtPath, ["--version"], { encoding: "utf-8", timeout: 10_000 })
        const match = out.match(/installed:\s+(\d+\.\d+\.\d+\S*)/)
        if (match) {
          versions.push({ label: entry, full: match[1]!, dbtPath, pythonPath })
        }
      } catch {}
    }
  }

  // If no venvs, try system dbt
  if (versions.length === 0) {
    try {
      const dbtPath = execSync("which dbt", { encoding: "utf-8" }).trim()
      const out = execFileSync(dbtPath, ["--version"], { encoding: "utf-8", timeout: 10_000 })
      const match = out.match(/installed:\s+(\d+\.\d+\.\d+\S*)/)
      if (match) {
        const pythonPath = execSync("which python3", { encoding: "utf-8" }).trim()
        const label = match[1]!.split(".").slice(0, 2).join(".")
        versions.push({ label: `system-${label}`, full: match[1]!, dbtPath, pythonPath })
      }
    } catch {}
  }

  return versions.sort((a, b) => a.label.localeCompare(b.label))
}

const VERSIONS = SKIP ? [] : discoverVersions()
const HAS_DBT = VERSIONS.length > 0

if (!HAS_DBT && !SKIP) {
  console.log(
    "⚠ No dbt installations found. Run `./test/e2e-setup.sh` to install test versions, or set DBT_E2E_SKIP=1 to skip.",
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run a dbt command in the fixture project, return stdout. */
function dbt(
  version: DbtVersion,
  workDir: string,
  args: string[],
  timeout = DBT_TIMEOUT,
): string {
  return execFileSync(version.dbtPath, args, {
    cwd: workDir,
    encoding: "utf-8",
    timeout,
    env: {
      ...process.env,
      DBT_PROFILES_DIR: workDir,
      // Ensure the venv's python is first on PATH so dbt finds it
      PATH: `${join(version.dbtPath, "..")}:${process.env.PATH}`,
    },
  })
}

/**
 * Get the JSON log format flags for a dbt version.
 * dbt 1.7 removed --log-format in favor of --log-format-file.
 * dbt 1.8+ restored --log-format.
 */
function jsonLogFlags(version: DbtVersion): string[] {
  const parts = version.full.split(".").map(Number)
  const major = parts[0] ?? 0
  const minor = parts[1] ?? 0
  // dbt 1.7.x doesn't support --log-format (uses --log-format-file instead)
  if (major === 1 && minor <= 7) return ["--output", "json"]
  return ["--output", "json", "--log-format", "json"]
}

/** Run altimate-dbt CLI entry point. */
function altDbt(
  pythonPath: string,
  projectRoot: string,
  args: string[],
  timeout = TEST_TIMEOUT,
): any {
  const entry = resolve(import.meta.dir, "../../src/index.ts")
  const result = Bun.spawnSync(["bun", entry, ...args], {
    cwd: projectRoot,
    env: {
      ...process.env,
      // Point altimate-dbt config at our temp project
      HOME: projectRoot,
    },
    timeout,
  })

  const stdout = result.stdout.toString().trim()
  try {
    return JSON.parse(stdout)
  } catch {
    return { raw: stdout, exitCode: result.exitCode }
  }
}

/** Create a temp copy of the fixture project and bootstrap it for a specific dbt version. */
function setupProject(version: DbtVersion): string {
  const workDir = mkdtempSync(join(tmpdir(), `dbt-e2e-${version.label}-`))
  cpSync(FIXTURE_DIR, workDir, { recursive: true })

  // Write profiles.yml with absolute DuckDB path (dbt 1.7 resolves relative paths from CWD)
  const { mkdirSync, writeFileSync } = require("fs")
  const dbPath = join(workDir, "target", "test.duckdb")
  mkdirSync(join(workDir, "target"), { recursive: true })
  writeFileSync(
    join(workDir, "profiles.yml"),
    `test_jaffle_shop:\n  target: dev\n  outputs:\n    dev:\n      type: duckdb\n      path: "${dbPath}"\n      threads: 1\n`,
  )

  // Write altimate-dbt config
  const configDir = join(workDir, ".altimate-code")
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    join(configDir, "dbt.json"),
    JSON.stringify({
      projectRoot: workDir,
      pythonPath: version.pythonPath,
      dbtIntegration: "corecommand",
      queryLimit: 500,
    }),
  )

  // Seed + build so models exist in the database
  dbt(version, workDir, ["seed"])
  dbt(version, workDir, ["build"])

  return workDir
}

// ---------------------------------------------------------------------------
// Tests — run the full suite for each dbt version
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DBT)("altimate-dbt e2e", () => {
  for (const version of VERSIONS) {
    describe(`dbt ${version.label} (${version.full})`, () => {
      let workDir: string

      beforeAll(() => {
        console.log(`\n→ Setting up dbt ${version.full} project...`)
        workDir = setupProject(version)
        console.log(`  Project: ${workDir}`)
      }, DBT_TIMEOUT * 2)

      afterAll(() => {
        if (workDir) {
          try {
            rmSync(workDir, { recursive: true, force: true })
          } catch {}
        }
      })

      // ----- dbt show / execute -----

      describe("execute (dbt show)", () => {
        test(
          "executes inline SQL via raw dbt show",
          () => {
            const out = dbt(version, workDir, [
              "show",
              "--inline",
              "select 1 as n",
              ...jsonLogFlags(version),
            ])
            // Just verify dbt didn't crash — the output format varies by version
            expect(out.length).toBeGreaterThan(0)
          },
          TEST_TIMEOUT,
        )

        test(
          "dbt-cli.ts execDbtShow parses real output",
          async () => {
            // Directly test our fallback parser against real dbt output
            const { execDbtShow } = await import("../../src/dbt-cli")

            // Temporarily override PATH so our dbt-cli.ts finds the right dbt
            const origPath = process.env.PATH
            process.env.PATH = `${join(version.dbtPath, "..")}:${origPath}`
            process.env.DBT_PROFILES_DIR = workDir

            try {
              const origCwd = process.cwd()
              process.chdir(workDir)
              try {
                const result = await execDbtShow("select 42 as answer", 10)
                expect(result.columnNames).toContain("answer")
                expect(result.data.length).toBeGreaterThanOrEqual(1)
                // The value should be 42 (as number or string)
                const val = result.data[0]?.answer ?? result.data[0]?.["answer"]
                expect([42, "42", " 42"]).toContain(typeof val === "string" ? val.trim() : val as number)
              } finally {
                process.chdir(origCwd)
              }
            } finally {
              process.env.PATH = origPath
              delete process.env.DBT_PROFILES_DIR
            }
          },
          TEST_TIMEOUT,
        )

        test(
          "execDbtShow with ref query against seeded data",
          async () => {
            const { execDbtShow } = await import("../../src/dbt-cli")

            const origPath = process.env.PATH
            process.env.PATH = `${join(version.dbtPath, "..")}:${origPath}`
            process.env.DBT_PROFILES_DIR = workDir

            try {
              const origCwd = process.cwd()
              process.chdir(workDir)
              try {
                const result = await execDbtShow(
                  "select count(*) as cnt from {{ ref('stg_customers') }}",
                  100,
                )
                expect(result.columnNames).toContain("cnt")
                expect(result.data.length).toBe(1)
                const cnt = Number(result.data[0]?.cnt)
                expect(cnt).toBe(3) // 3 rows in raw_customers.csv
              } finally {
                process.chdir(origCwd)
              }
            } finally {
              process.env.PATH = origPath
              delete process.env.DBT_PROFILES_DIR
            }
          },
          TEST_TIMEOUT,
        )
      })

      // ----- dbt compile -----

      describe("compile", () => {
        test(
          "dbt compile --select produces output",
          () => {
            const out = dbt(version, workDir, [
              "compile",
              "--select",
              "customers",
              ...jsonLogFlags(version),
            ])
            expect(out.length).toBeGreaterThan(0)
          },
          TEST_TIMEOUT,
        )

        test(
          "execDbtCompile returns compiled SQL for model",
          async () => {
            const { execDbtCompile } = await import("../../src/dbt-cli")

            const origPath = process.env.PATH
            process.env.PATH = `${join(version.dbtPath, "..")}:${origPath}`
            process.env.DBT_PROFILES_DIR = workDir

            try {
              const origCwd = process.cwd()
              process.chdir(workDir)
              try {
                const result = await execDbtCompile("customers")
                expect(result.sql).toBeTruthy()
                // Compiled SQL should no longer contain Jinja refs
                expect(result.sql).not.toContain("{{ ref")
                // Should reference actual table/view names
                const upper = result.sql.toUpperCase()
                expect(upper.includes("SELECT") || upper.includes("WITH")).toBe(true)
              } finally {
                process.chdir(origCwd)
              }
            } finally {
              process.env.PATH = origPath
              delete process.env.DBT_PROFILES_DIR
            }
          },
          TEST_TIMEOUT,
        )

        test(
          "execDbtCompileInline returns compiled SQL",
          async () => {
            const { execDbtCompileInline } = await import("../../src/dbt-cli")

            const origPath = process.env.PATH
            process.env.PATH = `${join(version.dbtPath, "..")}:${origPath}`
            process.env.DBT_PROFILES_DIR = workDir

            try {
              const origCwd = process.cwd()
              process.chdir(workDir)
              try {
                const result = await execDbtCompileInline(
                  "select * from {{ ref('stg_orders') }}",
                )
                expect(result.sql).toBeTruthy()
                expect(result.sql).not.toContain("{{ ref")
              } finally {
                process.chdir(origCwd)
              }
            } finally {
              process.env.PATH = origPath
              delete process.env.DBT_PROFILES_DIR
            }
          },
          TEST_TIMEOUT,
        )
      })

      // ----- dbt ls / children / parents -----

      describe("graph (children/parents)", () => {
        test(
          "dbt ls lists models",
          () => {
            const out = dbt(version, workDir, [
              "ls",
              "--resource-types",
              "model",
            ])
            expect(out).toContain("stg_customers")
            expect(out).toContain("customers")
          },
          TEST_TIMEOUT,
        )

        test(
          "execDbtLs finds children of stg_customers",
          async () => {
            const { execDbtLs } = await import("../../src/dbt-cli")

            const origPath = process.env.PATH
            process.env.PATH = `${join(version.dbtPath, "..")}:${origPath}`
            process.env.DBT_PROFILES_DIR = workDir

            try {
              const origCwd = process.cwd()
              process.chdir(workDir)
              try {
                const result = await execDbtLs("stg_customers", "children")
                const names = result.map((r) => r.table)
                // stg_customers → customers (mart), orders (mart)
                expect(names).toContain("customers")
                expect(names).toContain("orders")
                // Should NOT include stg_customers itself
                expect(names).not.toContain("stg_customers")
              } finally {
                process.chdir(origCwd)
              }
            } finally {
              process.env.PATH = origPath
              delete process.env.DBT_PROFILES_DIR
            }
          },
          TEST_TIMEOUT,
        )

        test(
          "execDbtLs finds parents of customers",
          async () => {
            const { execDbtLs } = await import("../../src/dbt-cli")

            const origPath = process.env.PATH
            process.env.PATH = `${join(version.dbtPath, "..")}:${origPath}`
            process.env.DBT_PROFILES_DIR = workDir

            try {
              const origCwd = process.cwd()
              process.chdir(workDir)
              try {
                const result = await execDbtLs("customers", "parents")
                const names = result.map((r) => r.table)
                // customers ← stg_customers, stg_orders
                expect(names).toContain("stg_customers")
                expect(names).toContain("stg_orders")
                expect(names).not.toContain("customers")
              } finally {
                process.chdir(origCwd)
              }
            } finally {
              process.env.PATH = origPath
              delete process.env.DBT_PROFILES_DIR
            }
          },
          TEST_TIMEOUT,
        )

        test(
          "execDbtLs children of leaf model returns empty",
          async () => {
            const { execDbtLs } = await import("../../src/dbt-cli")

            const origPath = process.env.PATH
            process.env.PATH = `${join(version.dbtPath, "..")}:${origPath}`
            process.env.DBT_PROFILES_DIR = workDir

            try {
              const origCwd = process.cwd()
              process.chdir(workDir)
              try {
                // "orders" is a leaf mart model with no children
                const result = await execDbtLs("orders", "children")
                expect(result.length).toBe(0)
              } finally {
                process.chdir(origCwd)
              }
            } finally {
              process.env.PATH = origPath
              delete process.env.DBT_PROFILES_DIR
            }
          },
          TEST_TIMEOUT,
        )
      })

      // ----- JSON output format verification (diagnostic) -----
      // These tests document which JSON field paths each dbt version uses.
      // They help us maintain the Tier 1 known-field lists in dbt-cli.ts.

      describe("JSON output format", () => {
        test(
          "dbt show JSON field paths",
          () => {
            let out: string
            try {
              out = dbt(version, workDir, [
                "show",
                "--inline",
                "select 1 as n",
                ...jsonLogFlags(version),
              ])
            } catch {
              console.log(`    dbt ${version.full} show: --output json not supported as JSONL`)
              return // Older versions don't produce JSONL — that's fine, our fallbacks handle it
            }

            const lines = out
              .trim()
              .split("\n")
              .map((l: string) => {
                try { return JSON.parse(l.trim()) } catch { return null }
              })
              .filter(Boolean)

            const fieldPaths: string[] = []
            for (const line of lines) {
              if (line.data?.preview) fieldPaths.push("data.preview")
              if (line.data?.rows) fieldPaths.push("data.rows")
              if (line.data?.sql) fieldPaths.push("data.sql")
              if (line.result?.preview) fieldPaths.push("result.preview")
              if (line.result?.rows) fieldPaths.push("result.rows")
            }

            if (lines.length === 0) {
              console.log(`    dbt ${version.full} show: no JSONL output (plain text only)`)
            } else {
              console.log(`    dbt ${version.full} show fields: [${fieldPaths.join(", ")}]`)
              expect(fieldPaths.length).toBeGreaterThan(0)
            }
          },
          TEST_TIMEOUT,
        )

        test(
          "dbt compile JSON field paths",
          () => {
            let out: string
            try {
              out = dbt(version, workDir, [
                "compile",
                "--select",
                "stg_customers",
                ...jsonLogFlags(version),
              ])
            } catch {
              console.log(`    dbt ${version.full} compile: --output json not supported as JSONL`)
              return
            }

            const lines = out
              .trim()
              .split("\n")
              .map((l: string) => {
                try { return JSON.parse(l.trim()) } catch { return null }
              })
              .filter(Boolean)

            const fieldPaths: string[] = []
            for (const line of lines) {
              if (line.data?.compiled) fieldPaths.push("data.compiled")
              if (line.data?.compiled_code) fieldPaths.push("data.compiled_code")
              if (line.data?.compiled_sql) fieldPaths.push("data.compiled_sql")
              if (line.result?.node?.compiled_code) fieldPaths.push("result.node.compiled_code")
            }

            if (lines.length === 0) {
              console.log(`    dbt ${version.full} compile: no JSONL output (plain text only)`)
            } else {
              console.log(`    dbt ${version.full} compile fields: [${fieldPaths.join(", ")}]`)
              expect(fieldPaths.length).toBeGreaterThan(0)
            }
          },
          TEST_TIMEOUT,
        )
      })
    })
  }
})
