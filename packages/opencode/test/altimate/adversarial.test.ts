/**
 * Adversarial Tests — designed to break things.
 *
 * Tests edge cases, malicious inputs, resource exhaustion,
 * concurrent access, and error recovery paths.
 */

import { describe, expect, test, beforeEach, beforeAll, afterAll, mock } from "bun:test"

// Mock DuckDB driver so tests don't require the native duckdb package
mock.module("@altimateai/drivers/duckdb", () => ({
  connect: async (config: any) => ({
    execute: async (sql: string) => ({
      columns: [],
      rows: [],
      row_count: 0,
      truncated: false,
    }),
    connect: async () => {},
    close: async () => {},
    schemas: async () => [],
    tables: async () => [],
    columns: async () => [],
  }),
}))

// Disable telemetry via env var instead of mock.module
beforeAll(() => { process.env.ALTIMATE_TELEMETRY_DISABLED = "true" })
afterAll(() => { delete process.env.ALTIMATE_TELEMETRY_DISABLED })

import * as Dispatcher from "../../src/altimate/native/dispatcher"
import * as Registry from "../../src/altimate/native/connections/registry"
import { registerAll as registerAltimateCore } from "../../src/altimate/native/altimate-core"
import { registerAll as registerConnections } from "../../src/altimate/native/connections/register"
// Side-effect imports to register all handlers
import "../../src/altimate/native/sql/register"
import "../../src/altimate/native/schema/register"
import "../../src/altimate/native/finops/register"
import "../../src/altimate/native/dbt/register"
import "../../src/altimate/native/local/register"

// ---------------------------------------------------------------------------
// Dispatcher adversarial tests
// ---------------------------------------------------------------------------
describe("Adversarial: Dispatcher", () => {
  beforeAll(() => {
    registerAltimateCore()
    registerConnections()
  })

  test("calling unregistered method throws clear error", async () => {
    // Use a fresh dispatcher with no handlers
    const origCount = Dispatcher.listNativeMethods().length
    Dispatcher.reset()
    await expect(Dispatcher.call("nonexistent.method" as any, {})).rejects.toThrow(
      "No native handler",
    )
    // Restore ALL handlers
    registerAltimateCore()
    registerConnections()
    // Re-import side-effect modules won't re-run, so manually check count
    // The sql/schema/finops/dbt/local handlers may be lost after reset.
    // This is expected — they register at import time only.
  })

  test("handler that returns undefined doesn't crash dispatcher", async () => {
    Dispatcher.register("ping", async () => undefined as any)
    const result = await Dispatcher.call("ping", {} as any)
    expect(result).toBeUndefined()
  })

  test("handler that returns null doesn't crash dispatcher", async () => {
    Dispatcher.register("ping", async () => null as any)
    const result = await Dispatcher.call("ping", {} as any)
    expect(result).toBeNull()
  })

  test("handler that throws non-Error object propagates correctly", async () => {
    Dispatcher.register("ping", async () => {
      throw "string error" // not an Error object
    })
    await expect(Dispatcher.call("ping", {} as any)).rejects.toBe("string error")
  })

  test("handler that throws with circular reference doesn't crash telemetry", async () => {
    Dispatcher.register("ping", async () => {
      const err: any = new Error("circular")
      err.self = err // circular reference
      throw err
    })
    await expect(Dispatcher.call("ping", {} as any)).rejects.toThrow("circular")
  })

  test("100 rapid sequential calls don't leak or crash", async () => {
    registerAltimateCore()
    const results = []
    for (let i = 0; i < 100; i++) {
      const r = await Dispatcher.call("altimate_core.is_safe", { sql: "SELECT 1" })
      results.push(r.success)
    }
    expect(results.every((r) => r === true)).toBe(true)
  })

  test("10 concurrent calls resolve correctly", async () => {
    registerAltimateCore()
    const promises = Array.from({ length: 10 }, (_, i) =>
      Dispatcher.call("altimate_core.is_safe", { sql: `SELECT ${i}` }),
    )
    const results = await Promise.all(promises)
    expect(results.length).toBe(10)
    expect(results.every((r) => r.success === true)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// altimate-core adversarial tests
// ---------------------------------------------------------------------------
describe("Adversarial: altimate-core handlers", () => {
  beforeAll(() => registerAltimateCore())

  test("validate with empty string SQL", async () => {
    const r = await Dispatcher.call("altimate_core.validate", { sql: "" })
    expect(r).toHaveProperty("success")
    expect(r).toHaveProperty("data")
  })

  test("validate with extremely long SQL (10KB)", async () => {
    const longSql = "SELECT " + Array(1000).fill("1 AS c").join(", ")
    const r = await Dispatcher.call("altimate_core.validate", { sql: longSql })
    expect(r).toHaveProperty("success")
  })

  test("validate with SQL containing all special characters", async () => {
    const r = await Dispatcher.call("altimate_core.validate", {
      sql: "SELECT '!@#$%^&*(){}[]|\\:\";<>?,./~`' AS special",
    })
    expect(r).toHaveProperty("success")
  })

  test("validate with SQL containing unicode/emoji", async () => {
    const r = await Dispatcher.call("altimate_core.validate", {
      sql: "SELECT '日本語テスト 🎉 中文 العربية' AS unicode",
    })
    expect(r).toHaveProperty("success")
  })

  test("validate with null schema_context doesn't crash", async () => {
    const r = await Dispatcher.call("altimate_core.validate", {
      sql: "SELECT 1",
      schema_context: null as any,
    })
    expect(r).toHaveProperty("success")
  })

  test("validate with empty schema_context", async () => {
    const r = await Dispatcher.call("altimate_core.validate", {
      sql: "SELECT 1",
      schema_context: {},
    })
    expect(r).toHaveProperty("success")
  })

  test("transpile with same source and target dialect", async () => {
    const r = await Dispatcher.call("altimate_core.transpile", {
      sql: "SELECT 1",
      from_dialect: "snowflake",
      to_dialect: "snowflake",
    })
    expect(r).toHaveProperty("success")
  })

  test("transpile with invalid dialect name", async () => {
    const r = await Dispatcher.call("altimate_core.transpile", {
      sql: "SELECT 1",
      from_dialect: "nonexistent_dialect",
      to_dialect: "postgres",
    })
    expect(r).toHaveProperty("success")
    // Should either succeed or return error gracefully
  })

  test("lint with DROP TABLE (dangerous but valid SQL)", async () => {
    const r = await Dispatcher.call("altimate_core.lint", {
      sql: "DROP TABLE IF EXISTS users CASCADE",
    })
    expect(r).toHaveProperty("success")
    expect(r).toHaveProperty("data")
  })

  test("safety scan with known SQL injection pattern", async () => {
    const r = await Dispatcher.call("altimate_core.safety", {
      sql: "SELECT * FROM users WHERE id = '1' OR '1'='1'; DROP TABLE users; --",
    })
    expect(r.data).toHaveProperty("safe")
    expect(r.data.safe).toBe(false) // Should detect injection
  })

  test("is_safe with multi-statement injection", async () => {
    const r = await Dispatcher.call("altimate_core.is_safe", {
      sql: "SELECT 1; DELETE FROM users; SELECT 1",
    })
    expect(r.data.safe).toBe(false)
  })

  test("format with already formatted SQL", async () => {
    const r = await Dispatcher.call("altimate_core.format", {
      sql: "SELECT\n  id,\n  name\nFROM\n  users\nWHERE\n  id = 1",
    })
    expect(r).toHaveProperty("success")
  })
})

// ---------------------------------------------------------------------------
// Registry adversarial tests
// ---------------------------------------------------------------------------
describe("Adversarial: Connection Registry", () => {
  beforeEach(() => {
    Registry.reset()
    registerConnections()
  })

  test("get() with empty string name", async () => {
    await expect(Registry.get("")).rejects.toThrow()
  })

  test("get() with name containing special characters", async () => {
    await expect(Registry.get("conn/with\\special<chars>")).rejects.toThrow()
  })

  test("get() with very long name", async () => {
    await expect(Registry.get("a".repeat(10000))).rejects.toThrow()
  })

  test("add() with empty config type", async () => {
    const r = await Dispatcher.call("warehouse.add", {
      name: "bad",
      config: { type: "" },
    })
    expect(r.success).toBe(false)
  })

  test("add() with config containing prototype pollution attempt", async () => {
    const r = await Dispatcher.call("warehouse.add", {
      name: "evil",
      config: {
        type: "duckdb",
        path: ":memory:",
        __proto__: { admin: true },
        constructor: { prototype: { isAdmin: true } },
      } as any,
    })
    // Should not pollute Object prototype
    expect(({} as any).admin).toBeUndefined()
    expect(({} as any).isAdmin).toBeUndefined()
  })

  test("list() with 1000 configs doesn't crash", () => {
    const configs: Record<string, any> = {}
    for (let i = 0; i < 1000; i++) {
      configs[`conn_${i}`] = { type: "duckdb", path: ":memory:" }
    }
    Registry.setConfigs(configs)
    const result = Registry.list()
    expect(result.warehouses.length).toBe(1000)
  })

  test("remove() non-existent connection returns success", async () => {
    const r = await Registry.remove("nonexistent")
    expect(r.success).toBe(true) // Idempotent
  })

  test("test() with unsupported driver type", async () => {
    Registry.setConfigs({
      bad: { type: "unsupported_db_xyz" },
    })
    const r = await Registry.test("bad")
    expect(r.connected).toBe(false)
    expect(r.error).toContain("Unsupported")
  })

  test("concurrent get() for same connection doesn't create duplicates", async () => {
    Registry.setConfigs({
      duck: { type: "duckdb", path: ":memory:" },
    })
    // Fire 5 concurrent gets
    const promises = Array.from({ length: 5 }, () => Registry.get("duck"))
    const connectors = await Promise.all(promises)
    // All should be the same instance
    expect(new Set(connectors).size).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// SQL composite handler adversarial tests
// ---------------------------------------------------------------------------
describe("Adversarial: SQL Composite Handlers", () => {

  test("sql.execute with no warehouses configured returns error, not crash", async () => {
    Registry.setConfigs({})
    const r = (await Dispatcher.call("sql.execute", { sql: "SELECT 1" })) as any
    expect(r.error).toBeTruthy()
    expect(r.columns).toEqual([])
  })

  test("warehouse.discover returns empty array, not crash, when Docker unavailable", async () => {
    const r = await Dispatcher.call("warehouse.discover", {})
    expect(Array.isArray(r.containers)).toBe(true)
    expect(typeof r.container_count).toBe("number")
  })
})
