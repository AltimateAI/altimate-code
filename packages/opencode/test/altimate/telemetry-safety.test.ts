/**
 * Adversarial Telemetry Safety Tests
 *
 * Verifies telemetry failures NEVER break driver operations.
 * Uses direct function calls (not Dispatcher) to test the exact
 * code paths where telemetry is added.
 *
 * Background: bad telemetry code previously broke drivers.
 */

import { describe, expect, test, beforeEach, afterAll, spyOn } from "bun:test"

// ---------------------------------------------------------------------------
// Intercept Telemetry.track via spyOn (no mock.module)
// ---------------------------------------------------------------------------

import { Telemetry } from "../../src/altimate/telemetry"

// Track all telemetry calls for verification
const telemetryCalls: Array<{ type: string; threw: boolean }> = []
let shouldThrow = false

const trackSpy = spyOn(Telemetry, "track").mockImplementation((event: any) => {
  telemetryCalls.push({ type: event?.type ?? "unknown", threw: shouldThrow })
  if (shouldThrow) {
    throw new Error(`TELEMETRY EXPLOSION: ${event?.type}`)
  }
})

const getContextSpy = spyOn(Telemetry, "getContext").mockImplementation(() => {
  if (shouldThrow) throw new Error("getContext EXPLOSION")
  return { sessionId: "test-session", projectId: "test-project" }
})

afterAll(() => {
  trackSpy.mockRestore()
  getContextSpy.mockRestore()
})

// Import modules under test
import * as Registry from "../../src/altimate/native/connections/registry"
import { detectAuthMethod, categorizeConnectionError } from "../../src/altimate/native/connections/registry"
import { detectQueryType, categorizeQueryError } from "../../src/altimate/native/connections/register"

describe("Telemetry Safety: Helper functions never throw", () => {
  test("detectAuthMethod handles all config shapes", () => {
    expect(detectAuthMethod({ type: "postgres", connection_string: "pg://..." })).toBe("connection_string")
    expect(detectAuthMethod({ type: "snowflake", private_key_path: "/key.p8" })).toBe("key_pair")
    expect(detectAuthMethod({ type: "databricks", access_token: "dapi..." })).toBe("token")
    expect(detectAuthMethod({ type: "postgres", password: "secret" })).toBe("password")
    expect(detectAuthMethod({ type: "duckdb" })).toBe("file")
    expect(detectAuthMethod({ type: "sqlite" })).toBe("file")
    expect(detectAuthMethod({ type: "postgres" })).toBe("unknown")
    // Edge cases
    expect(detectAuthMethod({} as any)).toBe("unknown")
    expect(detectAuthMethod({ type: "" })).toBe("unknown")
    expect(detectAuthMethod(null as any)).toBe("unknown")
  })

  test("detectAuthMethod does not throw on bizarre input", () => {
    expect(() => detectAuthMethod(undefined as any)).not.toThrow()
    expect(() => detectAuthMethod(null as any)).not.toThrow()
    expect(() => detectAuthMethod({} as any)).not.toThrow()
    expect(() => detectAuthMethod({ type: 123 } as any)).not.toThrow()
  })

  test("categorizeConnectionError categorizes all error types", () => {
    expect(categorizeConnectionError(new Error("not installed"))).toBe("driver_missing")
    expect(categorizeConnectionError(new Error("Cannot find module"))).toBe("driver_missing")
    expect(categorizeConnectionError(new Error("Incorrect password"))).toBe("auth_failed")
    expect(categorizeConnectionError(new Error("authentication failed"))).toBe("auth_failed")
    expect(categorizeConnectionError(new Error("JWT token invalid"))).toBe("auth_failed")
    expect(categorizeConnectionError(new Error("connection timed out"))).toBe("timeout")
    expect(categorizeConnectionError(new Error("ECONNREFUSED"))).toBe("network_error")
    expect(categorizeConnectionError(new Error("ENOTFOUND host"))).toBe("network_error")
    expect(categorizeConnectionError(new Error("Connection not found"))).toBe("config_error")
    expect(categorizeConnectionError(new Error("something random"))).toBe("other")
    // Edge cases
    expect(categorizeConnectionError(null)).toBe("other")
    expect(categorizeConnectionError(undefined)).toBe("other")
    expect(categorizeConnectionError(42)).toBe("other")
    expect(categorizeConnectionError("string error")).toBe("other")
  })

  test("detectQueryType classifies all SQL types", () => {
    expect(detectQueryType("SELECT 1")).toBe("SELECT")
    expect(detectQueryType("  select * from t")).toBe("SELECT")
    expect(detectQueryType("WITH cte AS (SELECT 1) SELECT * FROM cte")).toBe("SELECT")
    expect(detectQueryType("INSERT INTO t VALUES (1)")).toBe("INSERT")
    expect(detectQueryType("UPDATE t SET x = 1")).toBe("UPDATE")
    expect(detectQueryType("DELETE FROM t")).toBe("DELETE")
    expect(detectQueryType("CREATE TABLE t (id INT)")).toBe("DDL")
    expect(detectQueryType("ALTER TABLE t ADD col INT")).toBe("DDL")
    expect(detectQueryType("DROP TABLE t")).toBe("DDL")
    expect(detectQueryType("SHOW TABLES")).toBe("SHOW")
    expect(detectQueryType("DESCRIBE TABLE t")).toBe("SHOW")
    expect(detectQueryType("EXPLAIN SELECT 1")).toBe("SHOW")
    expect(detectQueryType("GRANT SELECT ON t TO user")).toBe("OTHER")
    expect(detectQueryType("")).toBe("OTHER")
  })

  test("detectQueryType does not throw on bizarre input", () => {
    expect(() => detectQueryType("")).not.toThrow()
    expect(() => detectQueryType(null as any)).not.toThrow()
    expect(() => detectQueryType(undefined as any)).not.toThrow()
    expect(() => detectQueryType(123 as any)).not.toThrow()
  })

  test("categorizeQueryError categorizes all error types", () => {
    expect(categorizeQueryError(new Error("syntax error at position 5"))).toBe("syntax_error")
    expect(categorizeQueryError(new Error("permission denied for table"))).toBe("permission_denied")
    expect(categorizeQueryError(new Error("access denied"))).toBe("permission_denied")
    expect(categorizeQueryError(new Error("query timeout after 30s"))).toBe("timeout")
    expect(categorizeQueryError(new Error("connection closed unexpectedly"))).toBe("connection_lost")
    expect(categorizeQueryError(new Error("connection terminated"))).toBe("connection_lost")
    expect(categorizeQueryError(new Error("random error"))).toBe("other")
    expect(categorizeQueryError(null)).toBe("other")
    expect(categorizeQueryError(undefined)).toBe("other")
  })
})

describe("Telemetry Safety: Registry operations survive telemetry explosions", () => {
  beforeEach(() => {
    Registry.reset()
    telemetryCalls.length = 0
    shouldThrow = true // ALL telemetry will throw
  })

  test("list() returns correct data when telemetry (census) throws", () => {
    Registry.setConfigs({
      pg: { type: "postgres", host: "localhost" },
      sf: { type: "snowflake", account: "test" },
    })

    const result = Registry.list()
    expect(result.warehouses.length).toBe(2)
    expect(result.warehouses.map((w: any) => w.name).sort()).toEqual(["pg", "sf"])
    // Census telemetry was attempted and threw — but list worked fine
  })

  test("list() called 10 times in a row with throwing telemetry", () => {
    Registry.setConfigs({
      db: { type: "duckdb", path: ":memory:" },
    })

    for (let i = 0; i < 10; i++) {
      const r = Registry.list()
      expect(r.warehouses.length).toBe(1)
    }
  })

  test("getConfig() works regardless of telemetry state", () => {
    Registry.setConfigs({
      pg: { type: "postgres", host: "myhost", database: "mydb" },
    })

    const config = Registry.getConfig("pg")
    expect(config?.type).toBe("postgres")
    expect(config?.host).toBe("myhost")
  })

  test("add() succeeds when telemetry throws", async () => {
    const result = await Registry.add("test_add", {
      type: "duckdb",
      path: ":memory:",
    })
    expect(result.success).toBe(true)
    expect(result.name).toBe("test_add")
  })

  test("remove() succeeds when telemetry throws", async () => {
    Registry.setConfigs({
      to_remove: { type: "duckdb", path: ":memory:" },
    })
    const result = await Registry.remove("to_remove")
    expect(result.success).toBe(true)
  })

  test("test() returns error for bad connection without crashing", async () => {
    Registry.setConfigs({
      bad: { type: "postgres", host: "nonexistent.invalid" },
    })
    const result = await Registry.test("bad")
    expect(result.connected).toBe(false)
    expect(typeof result.error).toBe("string")
  })
})

describe("Telemetry Safety: Telemetry calls are attempted but swallowed", () => {
  beforeEach(() => {
    Registry.reset()
    telemetryCalls.length = 0
  })

  test("working telemetry: events are tracked", () => {
    shouldThrow = false
    Registry.setConfigs({
      pg: { type: "postgres", host: "localhost" },
    })

    Registry.list()
    const censusEvents = telemetryCalls.filter((c) => c.type === "warehouse_census")
    expect(censusEvents.length).toBeGreaterThanOrEqual(1)
    expect(censusEvents[0].threw).toBe(false)
  })

  test("throwing telemetry: list still works when census throws", () => {
    shouldThrow = true
    Registry.setConfigs({
      pg: { type: "postgres", host: "localhost" },
    })

    // This should NOT throw even though telemetry is exploding
    const result = Registry.list()
    expect(result.warehouses.length).toBe(1)
    expect(result.warehouses[0].name).toBe("pg")
  })
})
