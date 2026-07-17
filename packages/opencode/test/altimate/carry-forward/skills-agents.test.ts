/**
 * Carry-forward regression guard: the fork's bundled skills, slash commands,
 * and warehouse driver coverage survived the OpenCode v1.17.9 upstream merge.
 *
 * Skills are asserted on disk (each .opencode/skills/<name>/SKILL.md) — the
 * canonical source the Skill loader scans. Commands are asserted via the exported
 * Command.Default constants (the fork-restored built-ins). Driver coverage is
 * asserted by reading the DRIVER_MAP source (not exported) — the 10 core
 * warehouses must all resolve to an @altimateai/drivers/* module.
 */
import { describe, test, expect } from "bun:test"
import { readFileSync, readdirSync, existsSync, statSync } from "fs"
import { join } from "path"
import { Default as CommandDefault } from "../../../src/command/index"

const ROOT = join(import.meta.dir, "..", "..", "..")
const REPO_ROOT = join(ROOT, "..", "..")
const SKILLS_DIR = join(REPO_ROOT, ".opencode", "skills")

const EXPECTED_SKILLS = [
  "altimate-setup",
  "cost-report",
  "data-parity",
  "data-viz",
  "dbt-analyze",
  "dbt-develop",
  "dbt-docs",
  "dbt-pr-review",
  "dbt-schema-verify",
  "dbt-test",
  "dbt-troubleshoot",
  "dbt-unit-tests",
  "lineage-diff",
  "pii-audit",
  "query-optimize",
  "schema-migration",
  "sql-review",
  "sql-translate",
  "teach",
  "train",
  "training-status",
]

function skillDirs(): string[] {
  if (!existsSync(SKILLS_DIR)) return []
  return readdirSync(SKILLS_DIR).filter((d) => statSync(join(SKILLS_DIR, d)).isDirectory())
}

describe("carry-forward: bundled skills present", () => {
  test("at least 21 skills are bundled", () => {
    expect(skillDirs().length).toBeGreaterThanOrEqual(21)
  })

  test("every expected skill exists with a SKILL.md", () => {
    const dirs = new Set(skillDirs())
    for (const name of EXPECTED_SKILLS) {
      expect(dirs.has(name)).toBe(true)
      expect(existsSync(join(SKILLS_DIR, name, "SKILL.md"))).toBe(true)
    }
  })

  test("key differentiated skills (dbt-pr-review, query-optimize, pii-audit) present", () => {
    const dirs = new Set(skillDirs())
    expect(dirs.has("dbt-pr-review")).toBe(true)
    expect(dirs.has("query-optimize")).toBe(true)
    expect(dirs.has("pii-audit")).toBe(true)
  })

  test("query-optimize skill calls altimate_core_rewrite with verify_equivalence (PR #918)", () => {
    const md = readFileSync(join(SKILLS_DIR, "query-optimize", "SKILL.md"), "utf8")
    expect(md).toContain("altimate_core_rewrite")
    expect(md).toContain("verify_equivalence")
  })
})

describe("carry-forward: fork slash commands registered", () => {
  test("Command.Default exposes the fork-restored built-in commands", () => {
    expect(CommandDefault.CONFIGURE_CLAUDE).toBe("configure-claude")
    expect(CommandDefault.CONFIGURE_CODEX).toBe("configure-codex")
    expect(CommandDefault.DISCOVER_MCPS).toBe("discover-and-add-mcps")
    expect(CommandDefault.MCPS).toBe("mcps")
  })

  test("command templates exist on disk for the configure/discover commands", () => {
    const tplDir = join(ROOT, "src", "command", "template")
    expect(existsSync(join(tplDir, "configure-claude.txt"))).toBe(true)
    expect(existsSync(join(tplDir, "configure-codex.txt"))).toBe(true)
    expect(existsSync(join(tplDir, "discover-and-add-mcps.txt"))).toBe(true)
  })
})

describe("carry-forward: warehouse driver coverage (10 core warehouses)", () => {
  // DRIVER_MAP is module-private; assert via source so we don't need live drivers.
  const registrySrc = readFileSync(join(ROOT, "src", "altimate", "native", "connections", "registry.ts"), "utf8")

  const CORE_WAREHOUSES = [
    "postgres",
    "redshift",
    "snowflake",
    "bigquery",
    "mysql",
    "sqlserver",
    "databricks",
    "duckdb",
    "oracle",
    "sqlite",
  ]

  test("all 10 core warehouses map to an @altimateai/drivers/* module", () => {
    for (const wh of CORE_WAREHOUSES) {
      // matches e.g.  snowflake: "@altimateai/drivers/snowflake"
      const re = new RegExp(`${wh}:\\s*"@altimateai/drivers/`)
      expect(registrySrc).toMatch(re)
    }
  })

  test("postgres aliases (postgresql) and sqlserver aliases (mssql/fabric) are mapped", () => {
    expect(registrySrc).toMatch(/postgresql:\s*"@altimateai\/drivers\/postgres"/)
    expect(registrySrc).toMatch(/mssql:\s*"@altimateai\/drivers\/sqlserver"/)
    expect(registrySrc).toMatch(/fabric:\s*"@altimateai\/drivers\/sqlserver"/)
  })

  test("friendly stubs steer cockroachdb/timescaledb to postgres", () => {
    expect(registrySrc).toContain("cockroachdb")
    expect(registrySrc).toContain("timescaledb")
  })
})
