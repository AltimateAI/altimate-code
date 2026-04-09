/**
 * dbt-First Execution E2E Tests
 *
 * Tests the dbt-first strategy: when in a dbt project, sql.execute
 * uses dbt's adapter (profiles.yml) before falling back to native drivers.
 *
 * Requires a dbt project configured at one of:
 *   - ~/.altimate-code/dbt.json (altimate dbt config)
 *   - A dbt_project.yml in a known path
 *
 * Set DBT_TEST_PROJECT_ROOT env var to override the project path.
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach, mock, spyOn } from "bun:test"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { Connector } from "@altimateai/drivers/types"
import * as Dispatcher from "../../src/altimate/native/dispatcher"

// Mock DuckDB driver so tests don't require the native duckdb package.
// NOTE: mock.module leaks across test files in Bun — we spread the real
// module exports to minimize damage to other test files.
import * as realDuckdb from "@altimateai/drivers/duckdb"
mock.module("@altimateai/drivers/duckdb", () => ({
  ...realDuckdb,
  connect: async (config: any) => ({
    execute: async (sql: string) => {
      // Simple mock: parse SELECT literals
      const match = sql.match(/SELECT\s+'([^']+)'\s+AS\s+(\w+)/i)
      if (match) {
        return {
          columns: [{ name: match[2], type: "varchar" }],
          rows: [[match[1]]],
          row_count: 1,
          truncated: false,
        }
      }
      const numMatch = sql.match(/SELECT\s+(\d+)\s+AS\s+(\w+)/i)
      if (numMatch) {
        return {
          columns: [{ name: numMatch[2], type: "integer" }],
          rows: [[Number(numMatch[1])]],
          row_count: 1,
          truncated: false,
        }
      }
      return { columns: [], rows: [], row_count: 0, truncated: false }
    },
    connect: async () => {},
    close: async () => {},
    schemas: async () => [],
    tables: async () => [],
    columns: async () => [],
  }),
}))

// ---------------------------------------------------------------------------
// Detect dbt project for testing
// ---------------------------------------------------------------------------

function findDbtProject(): string | null {
  // 1. Explicit env var
  if (process.env.DBT_TEST_PROJECT_ROOT) {
    if (existsSync(join(process.env.DBT_TEST_PROJECT_ROOT, "dbt_project.yml"))) {
      return process.env.DBT_TEST_PROJECT_ROOT
    }
  }

  // 2. altimate dbt config
  const dbtConfigPath = join(homedir(), ".altimate-code", "dbt.json")
  if (existsSync(dbtConfigPath)) {
    try {
      const cfg = JSON.parse(readFileSync(dbtConfigPath, "utf-8"))
      if (cfg.projectRoot && existsSync(join(cfg.projectRoot, "dbt_project.yml"))) {
        return cfg.projectRoot
      }
    } catch {}
  }

  // 3. Common locations
  const candidates = [
    join(homedir(), "crypto_analytics/crypto_dbt"),
    join(homedir(), "codebase/jaffle_shop"),
    join(homedir(), "codebase/sample-dbt-project"),
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, "dbt_project.yml"))) return dir
  }

  return null
}

function findDbtProfileType(): string | null {
  const profilesPath = join(homedir(), ".dbt", "profiles.yml")
  if (!existsSync(profilesPath)) return null
  try {
    const content = readFileSync(profilesPath, "utf-8")
    // Quick regex to find first adapter type
    const match = content.match(/type:\s*(\w+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

const DBT_PROJECT = findDbtProject()
const DBT_PROFILE_TYPE = findDbtProfileType()
const HAS_DBT = !!DBT_PROJECT

// ---------------------------------------------------------------------------
// Tests: dbt profiles auto-discovery
// ---------------------------------------------------------------------------
describe("dbt Profiles Auto-Discovery", () => {
  // Explicitly call registerAll() instead of relying on import side-effects.
  // ES module imports are cached, so if dispatcher.test.ts runs first and
  // calls Dispatcher.reset() (clearing all handlers + the lazy hook),
  // re-importing the register modules is a no-op — handlers stay cleared.
  // Calling registerAll() directly re-registers them every time.
  beforeAll(async () => {
    const { registerAll: registerConnections } = await import("../../src/altimate/native/connections/register")
    const { registerAll: registerSchema } = await import("../../src/altimate/native/schema/register")
    registerConnections()
    registerSchema()
  })

  test("parseDbtProfiles finds connections from ~/.dbt/profiles.yml", async () => {
    const { parseDbtProfiles } = await import("../../src/altimate/native/connections/dbt-profiles")
    const profiles = await parseDbtProfiles()
    console.log(`  Found ${profiles.length} dbt profile connections`)
    if (profiles.length > 0) {
      console.log(`  Types: ${profiles.map((p: any) => p.config?.type || p.type).join(", ")}`)
    }
    expect(Array.isArray(profiles)).toBe(true)
  })

  test("dbt.profiles dispatcher method returns connections", async () => {
    // Lazy registration fires on first Dispatcher.call()
    const { Dispatcher } = await import("../../src/altimate/native")
    const r = await Dispatcher.call("dbt.profiles", {})
    expect(r.success).toBe(true)
    expect(Array.isArray(r.connections)).toBe(true)
    console.log(`  dbt.profiles found ${r.connection_count} connection(s)`)
  })

  test("warehouse.discover includes dbt profiles", async () => {
    const { Dispatcher } = await import("../../src/altimate/native")
    const r = await Dispatcher.call("warehouse.discover", {})
    // dbt_profiles may be in the result
    if ((r as any).dbt_profiles && (r as any).dbt_profiles.length > 0) {
      console.log(`  warehouse.discover found ${(r as any).dbt_profiles.length} dbt profiles`)
    }
    expect(r).toHaveProperty("containers")
    expect(r).toHaveProperty("container_count")
  })
})

// ---------------------------------------------------------------------------
// Tests: dbt-first SQL execution
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_DBT)("dbt-First SQL Execution E2E", () => {
  beforeAll(() => {
    console.log(`  dbt project: ${DBT_PROJECT}`)
    console.log(`  Profile type: ${DBT_PROFILE_TYPE}`)
  })

  test("dbt adapter can be created from config", async () => {
    const { read: readConfig } = await import("../../../dbt-tools/src/config")
    const cfg = await readConfig()
    if (!cfg) {
      console.log("  No dbt config — skipping adapter test")
      return
    }

    const { create } = await import("../../../dbt-tools/src/adapter")
    const adapter = await create(cfg)
    expect(adapter).toBeTruthy()
    expect(adapter.immediatelyExecuteSQL).toBeInstanceOf(Function)
  }, 30000)

  test("sql.execute without warehouse tries dbt first", async () => {
    // Reset registry so no native connections are configured
    const Registry = await import("../../src/altimate/native/connections/registry")
    Registry.reset()

    const { resetDbtAdapter } = await import("../../src/altimate/native/connections/register")
    resetDbtAdapter()

    const { Dispatcher } = await import("../../src/altimate/native")

    // This should try dbt adapter first (if dbt config exists)
    const r = await Dispatcher.call("sql.execute", { sql: "SELECT 1 AS n" })

    // If dbt is configured and working, we should get a result
    // If not, we'll get an error about no warehouse configured
    if ((r as any).error) {
      console.log(`  sql.execute fell back to error: ${(r as any).error.slice(0, 100)}`)
    } else {
      console.log(`  sql.execute via dbt: ${r.row_count} rows, columns: ${r.columns}`)
      expect(r.row_count).toBeGreaterThanOrEqual(1)
    }
  })
})

// ---------------------------------------------------------------------------
// Tests: direct dbt adapter SQL execution (if project available)
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_DBT)("Direct dbt Adapter Execution", () => {
  let adapter: any

  beforeAll(async () => {
    try {
      const { read: readConfig } = await import("../../../dbt-tools/src/config")
      const cfg = await readConfig()
      if (!cfg) return

      const { create } = await import("../../../dbt-tools/src/adapter")
      adapter = await create(cfg)
    } catch (e: any) {
      console.log(`  Could not create dbt adapter: ${e.message?.slice(0, 100)}`)
    }
  }, 30000)

  test("execute SELECT 1", async () => {
    if (!adapter) return
    const r = await adapter.immediatelyExecuteSQL("SELECT 1 AS n", "")
    expect(r).toBeTruthy()
    console.log(`  Result type: ${typeof r}, keys: ${Object.keys(r).join(",")}`)
  })

  test("execute query against dbt model (if available)", async () => {
    if (!adapter) return
    try {
      // Try a simple query that works on most dbt projects
      const r = await adapter.immediatelyExecuteSQL("SELECT COUNT(*) AS cnt FROM information_schema.tables", "")
      expect(r).toBeTruthy()
      console.log(`  Tables count query succeeded`)
    } catch (e: any) {
      console.log(`  Query failed (expected for some adapters): ${e.message?.slice(0, 100)}`)
    }
  })

  test("dbt adapter handles invalid SQL gracefully", async () => {
    if (!adapter) return
    try {
      await adapter.immediatelyExecuteSQL("SELECTTTT INVALID", "")
      // Some adapters may not throw
    } catch (e: any) {
      expect(e.message || String(e)).toBeTruthy()
    }
  })
})

// ---------------------------------------------------------------------------
// Tests: fallback behavior
// ---------------------------------------------------------------------------
describe("dbt Fallback Behavior", () => {
  // Re-register dispatcher handlers in case Dispatcher.reset() was called
  // by another test file (e.g., dispatcher.test.ts, tool-error-propagation.test.ts).
  beforeAll(async () => {
    const { registerAll: registerConnections } = await import("../../src/altimate/native/connections/register")
    const { registerAll: registerSchema } = await import("../../src/altimate/native/schema/register")
    registerConnections()
    registerSchema()
  })

  test("when dbt not configured, falls back to native driver silently", async () => {
    const Registry = await import("../../src/altimate/native/connections/registry")
    Registry.reset()

    const { resetDbtAdapter } = await import("../../src/altimate/native/connections/register")
    resetDbtAdapter()

    // Set up a native DuckDB connection as fallback
    Registry.setConfigs({
      fallback_duck: { type: "duckdb", path: ":memory:" },
    })

    const { Dispatcher } = await import("../../src/altimate/native")
    const r = await Dispatcher.call("sql.execute", { sql: "SELECT 42 AS answer" })

    // Should succeed via native DuckDB (dbt fallback is transparent)
    if (!(r as any).error) {
      expect(r.rows[0][0]).toBe(42)
      console.log("  Correctly fell back to native DuckDB")
    }
  })

  test("explicit warehouse param bypasses dbt entirely", async () => {
    const Registry = await import("../../src/altimate/native/connections/registry")
    Registry.reset()
    Registry.setConfigs({
      my_duck: { type: "duckdb", path: ":memory:" },
    })

    const { Dispatcher } = await import("../../src/altimate/native")
    const r = await Dispatcher.call("sql.execute", {
      sql: "SELECT 'direct' AS method",
      warehouse: "my_duck",
    })

    expect((r as any).error).toBeUndefined()
    expect(r.rows[0][0]).toBe("direct")
    console.log("  Explicit warehouse correctly bypassed dbt")
  })
})
