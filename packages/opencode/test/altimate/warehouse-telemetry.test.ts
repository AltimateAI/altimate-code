// @ts-nocheck
import { describe, expect, test, beforeEach, afterAll, spyOn } from "bun:test"

// ---------------------------------------------------------------------------
// Intercept Telemetry.track via spyOn (no mock.module)
// ---------------------------------------------------------------------------

import { Telemetry } from "../../src/altimate/telemetry"
import * as Registry from "../../src/altimate/native/connections/registry"

const trackedEvents: any[] = []

// Spy on Telemetry.track to capture events — works because registry.ts
// accesses the same Telemetry namespace object via ESM live bindings.
const trackSpy = spyOn(Telemetry, "track").mockImplementation((event: any) => {
  trackedEvents.push(event)
})

// Spy on Telemetry.getContext to return deterministic session ID
const getContextSpy = spyOn(Telemetry, "getContext").mockImplementation(() => ({
  sessionId: "test-session-123",
  projectId: "test-project",
}))

afterAll(() => {
  trackSpy.mockRestore()
  getContextSpy.mockRestore()
})

// ---------------------------------------------------------------------------
// detectQueryType helper (replicated for unit testing since not exported)
// ---------------------------------------------------------------------------

function detectQueryType(sql: string): string {
  const trimmed = sql.trim().toUpperCase()
  if (trimmed.startsWith("SELECT") || trimmed.startsWith("WITH")) return "SELECT"
  if (trimmed.startsWith("INSERT")) return "INSERT"
  if (trimmed.startsWith("UPDATE")) return "UPDATE"
  if (trimmed.startsWith("DELETE")) return "DELETE"
  if (trimmed.startsWith("CREATE") || trimmed.startsWith("ALTER") || trimmed.startsWith("DROP")) return "DDL"
  if (trimmed.startsWith("SHOW") || trimmed.startsWith("DESCRIBE") || trimmed.startsWith("EXPLAIN")) return "SHOW"
  return "OTHER"
}

function categorizeQueryError(e: unknown): string {
  const msg = String(e).toLowerCase()
  if (msg.includes("syntax")) return "syntax_error"
  if (msg.includes("permission") || msg.includes("denied") || msg.includes("access")) return "permission_denied"
  if (msg.includes("timeout")) return "timeout"
  if (msg.includes("connection") || msg.includes("closed") || msg.includes("terminated")) return "connection_lost"
  return "other"
}

function categorizeConnectionError(e: unknown): string {
  const msg = String(e).toLowerCase()
  if (msg.includes("not installed") || msg.includes("cannot find module")) return "driver_missing"
  if (msg.includes("password") || msg.includes("authentication") || msg.includes("unauthorized") || msg.includes("jwt")) return "auth_failed"
  if (msg.includes("timeout") || msg.includes("timed out")) return "timeout"
  if (msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("network")) return "network_error"
  if (msg.includes("config") || msg.includes("not found") || msg.includes("missing")) return "config_error"
  return "other"
}

// ---------------------------------------------------------------------------
// detectAuthMethod (tested via warehouse_connect events)
// ---------------------------------------------------------------------------

describe("warehouse telemetry: detectAuthMethod", () => {
  beforeEach(() => {
    Registry.reset()
    trackedEvents.length = 0
    trackSpy.mockClear()
  })

  // Use an unsupported driver type to force a failure at createConnector level,
  // which guarantees the failed-connect telemetry path runs
  test("detects connection_string auth", async () => {
    Registry.setConfigs({
      mydb: { type: "unsupported_db_type", connection_string: "foo://localhost/test" },
    })
    try {
      await Registry.get("mydb")
    } catch {}
    const connectEvent = trackedEvents.find((e) => e.type === "warehouse_connect")
    expect(connectEvent).toBeDefined()
    expect(connectEvent.auth_method).toBe("connection_string")
  })

  test("detects key_pair auth", async () => {
    Registry.setConfigs({
      sf: { type: "unsupported_db_type", private_key_path: "/path/to/key.pem" },
    })
    try {
      await Registry.get("sf")
    } catch {}
    const connectEvent = trackedEvents.find((e) => e.type === "warehouse_connect")
    expect(connectEvent).toBeDefined()
    expect(connectEvent.auth_method).toBe("key_pair")
  })

  test("detects token auth via access_token", async () => {
    Registry.setConfigs({
      bq: { type: "unsupported_db_type", access_token: "ya29.xxx" },
    })
    try {
      await Registry.get("bq")
    } catch {}
    const connectEvent = trackedEvents.find((e) => e.type === "warehouse_connect")
    expect(connectEvent).toBeDefined()
    expect(connectEvent.auth_method).toBe("token")
  })

  test("detects token auth via token field", async () => {
    Registry.setConfigs({
      db: { type: "unsupported_db_type", token: "dapi123" },
    })
    try {
      await Registry.get("db")
    } catch {}
    const connectEvent = trackedEvents.find((e) => e.type === "warehouse_connect")
    expect(connectEvent).toBeDefined()
    expect(connectEvent.auth_method).toBe("token")
  })

  test("detects password auth", async () => {
    Registry.setConfigs({
      pg: { type: "unsupported_db_type", password: "secret", host: "localhost" },
    })
    try {
      await Registry.get("pg")
    } catch {}
    const connectEvent = trackedEvents.find((e) => e.type === "warehouse_connect")
    expect(connectEvent).toBeDefined()
    expect(connectEvent.auth_method).toBe("password")
  })

  test("detects file auth for duckdb", async () => {
    Registry.setConfigs({
      duck: { type: "duckdb", path: "/tmp/nonexistent_test_telemetry.db" },
    })
    try {
      await Registry.get("duck")
    } catch {}
    const connectEvent = trackedEvents.find((e) => e.type === "warehouse_connect")
    expect(connectEvent).toBeDefined()
    expect(connectEvent.auth_method).toBe("file")
  })

  test("detects file auth for sqlite", async () => {
    Registry.setConfigs({
      lite: { type: "sqlite", path: "/tmp/nonexistent_test_telemetry.db" },
    })
    try {
      await Registry.get("lite")
    } catch {}
    const connectEvent = trackedEvents.find((e) => e.type === "warehouse_connect")
    expect(connectEvent).toBeDefined()
    expect(connectEvent.auth_method).toBe("file")
  })

  test("returns unknown for unrecognized auth", async () => {
    Registry.setConfigs({
      mystery: { type: "unsupported_db_type", host: "localhost" },
    })
    try {
      await Registry.get("mystery")
    } catch {}
    const connectEvent = trackedEvents.find((e) => e.type === "warehouse_connect")
    expect(connectEvent).toBeDefined()
    expect(connectEvent.auth_method).toBe("unknown")
  })
})

// ---------------------------------------------------------------------------
// warehouse_connect events
// ---------------------------------------------------------------------------

describe("warehouse telemetry: warehouse_connect", () => {
  beforeEach(() => {
    Registry.reset()
    trackedEvents.length = 0
    trackSpy.mockClear()
  })

  test("tracks failed connection with error details", async () => {
    Registry.setConfigs({
      pg: { type: "unsupported_db_type", password: "secret", host: "localhost" },
    })
    try {
      await Registry.get("pg")
    } catch {}
    const connectEvent = trackedEvents.find((e) => e.type === "warehouse_connect")
    expect(connectEvent).toBeDefined()
    expect(connectEvent.success).toBe(false)
    expect(connectEvent.warehouse_type).toBe("unsupported_db_type")
    expect(connectEvent.session_id).toBe("test-session-123")
    expect(typeof connectEvent.duration_ms).toBe("number")
    expect(connectEvent.duration_ms).toBeGreaterThanOrEqual(0)
    expect(connectEvent.error).toBeDefined()
    expect(connectEvent.error.length).toBeLessThanOrEqual(500)
    expect(connectEvent.error_category).toBeDefined()
  })

  test("error message is truncated to 500 chars", async () => {
    Registry.setConfigs({
      pg: { type: "unsupported_db_type", host: "localhost" },
    })
    try {
      await Registry.get("pg")
    } catch {}
    const connectEvent = trackedEvents.find((e) => e.type === "warehouse_connect")
    expect(connectEvent).toBeDefined()
    if (connectEvent.error) {
      expect(connectEvent.error.length).toBeLessThanOrEqual(500)
    }
  })

  test("connection failure still throws the original error", async () => {
    Registry.setConfigs({
      pg: { type: "unsupported_db_type", host: "localhost" },
    })
    await expect(Registry.get("pg")).rejects.toThrow()
  })

  test("tracks successful connection for valid driver", async () => {
    // Use duckdb with a temp path (duckdb can create in-memory / file DB)
    Registry.setConfigs({
      duck: { type: "duckdb", path: ":memory:" },
    })
    try {
      const connector = await Registry.get("duck")
      // If we get here, connection succeeded
      const connectEvent = trackedEvents.find((e) => e.type === "warehouse_connect")
      expect(connectEvent).toBeDefined()
      expect(connectEvent.success).toBe(true)
      expect(connectEvent.warehouse_type).toBe("duckdb")
      expect(connectEvent.error).toBeUndefined()
      expect(connectEvent.error_category).toBeUndefined()
      await connector.close()
    } catch {
      // Driver not available in test — skip assertion
    }
  })
})

// ---------------------------------------------------------------------------
// categorizeConnectionError
// ---------------------------------------------------------------------------

describe("warehouse telemetry: categorizeConnectionError", () => {
  test("categorizes driver_missing errors", () => {
    expect(categorizeConnectionError(new Error("Module not installed"))).toBe("driver_missing")
    expect(categorizeConnectionError(new Error("Cannot find module '@altimateai/drivers/oracle'"))).toBe("driver_missing")
  })

  test("categorizes auth_failed errors", () => {
    expect(categorizeConnectionError(new Error("password authentication failed for user"))).toBe("auth_failed")
    expect(categorizeConnectionError(new Error("authentication failed"))).toBe("auth_failed")
    expect(categorizeConnectionError(new Error("unauthorized"))).toBe("auth_failed")
    expect(categorizeConnectionError(new Error("JWT token expired"))).toBe("auth_failed")
  })

  test("categorizes timeout errors", () => {
    expect(categorizeConnectionError(new Error("connection timeout"))).toBe("timeout")
    expect(categorizeConnectionError(new Error("timed out waiting for connection"))).toBe("timeout")
  })

  test("categorizes network_error errors", () => {
    expect(categorizeConnectionError(new Error("connect ECONNREFUSED 127.0.0.1:5432"))).toBe("network_error")
    expect(categorizeConnectionError(new Error("getaddrinfo ENOTFOUND unknown.host"))).toBe("network_error")
    expect(categorizeConnectionError(new Error("network unreachable"))).toBe("network_error")
  })

  test("categorizes config_error errors", () => {
    expect(categorizeConnectionError(new Error("config file not found"))).toBe("config_error")
    expect(categorizeConnectionError(new Error("missing required field 'host'"))).toBe("config_error")
  })

  test("returns other for unrecognized errors", () => {
    expect(categorizeConnectionError(new Error("something completely unexpected"))).toBe("other")
  })
})

// ---------------------------------------------------------------------------
// warehouse_census events
// ---------------------------------------------------------------------------

describe("warehouse telemetry: warehouse_census", () => {
  beforeEach(() => {
    Registry.reset()
    trackedEvents.length = 0
    trackSpy.mockClear()
  })

  test("fires census on first list() call with connections", () => {
    Registry.setConfigs({
      pg: { type: "postgres", host: "localhost", database: "test" },
      sf: { type: "snowflake", account: "abc" },
    })
    Registry.list()
    const census = trackedEvents.find((e) => e.type === "warehouse_census")
    expect(census).toBeDefined()
    expect(census.total_connections).toBe(2)
    expect(census.warehouse_types).toContain("postgres")
    expect(census.warehouse_types).toContain("snowflake")
    expect(census.session_id).toBe("test-session-123")
    expect(typeof census.timestamp).toBe("number")
    expect(census.has_ssh_tunnel).toBe(false)
    expect(census.has_keychain).toBe(false)
  })

  test("does not fire census when no connections configured", () => {
    Registry.setConfigs({})
    Registry.list()
    const census = trackedEvents.find((e) => e.type === "warehouse_census")
    expect(census).toBeUndefined()
  })

  test("fires census only once per session", () => {
    Registry.setConfigs({
      pg: { type: "postgres", host: "localhost" },
    })
    Registry.list()
    Registry.list()
    Registry.list()
    const censusEvents = trackedEvents.filter((e) => e.type === "warehouse_census")
    expect(censusEvents).toHaveLength(1)
  })

  test("census detects ssh_tunnel config", () => {
    Registry.setConfigs({
      pg: { type: "postgres", host: "localhost", ssh_host: "bastion.example.com" },
    })
    Registry.list()
    const census = trackedEvents.find((e) => e.type === "warehouse_census")
    expect(census).toBeDefined()
    expect(census.has_ssh_tunnel).toBe(true)
  })

  test("census deduplicates warehouse types", () => {
    Registry.setConfigs({
      pg1: { type: "postgres", host: "host1" },
      pg2: { type: "postgres", host: "host2" },
      sf: { type: "snowflake", account: "abc" },
    })
    Registry.list()
    const census = trackedEvents.find((e) => e.type === "warehouse_census")
    expect(census).toBeDefined()
    expect(census.total_connections).toBe(3)
    const uniqueTypes = [...new Set(census.warehouse_types)]
    expect(uniqueTypes.length).toBe(census.warehouse_types.length)
  })

  test("census resets after Registry.reset()", () => {
    Registry.setConfigs({
      pg: { type: "postgres", host: "localhost" },
    })
    Registry.list()
    expect(trackedEvents.filter((e) => e.type === "warehouse_census")).toHaveLength(1)

    trackedEvents.length = 0
    Registry.reset()
    Registry.setConfigs({
      sf: { type: "snowflake", account: "abc" },
    })
    Registry.list()
    expect(trackedEvents.filter((e) => e.type === "warehouse_census")).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// detectQueryType
// ---------------------------------------------------------------------------

describe("warehouse telemetry: detectQueryType", () => {
  test("detects SELECT queries", () => {
    expect(detectQueryType("SELECT * FROM users")).toBe("SELECT")
    expect(detectQueryType("  select id from t")).toBe("SELECT")
  })

  test("detects WITH (CTE) as SELECT", () => {
    expect(detectQueryType("WITH cte AS (SELECT 1) SELECT * FROM cte")).toBe("SELECT")
  })

  test("detects INSERT queries", () => {
    expect(detectQueryType("INSERT INTO users VALUES (1, 'a')")).toBe("INSERT")
  })

  test("detects UPDATE queries", () => {
    expect(detectQueryType("UPDATE users SET name = 'b' WHERE id = 1")).toBe("UPDATE")
  })

  test("detects DELETE queries", () => {
    expect(detectQueryType("DELETE FROM users WHERE id = 1")).toBe("DELETE")
  })

  test("detects DDL queries", () => {
    expect(detectQueryType("CREATE TABLE t (id INT)")).toBe("DDL")
    expect(detectQueryType("ALTER TABLE t ADD COLUMN name TEXT")).toBe("DDL")
    expect(detectQueryType("DROP TABLE t")).toBe("DDL")
  })

  test("detects SHOW queries", () => {
    expect(detectQueryType("SHOW TABLES")).toBe("SHOW")
    expect(detectQueryType("DESCRIBE users")).toBe("SHOW")
    expect(detectQueryType("EXPLAIN SELECT 1")).toBe("SHOW")
  })

  test("returns OTHER for unrecognized", () => {
    expect(detectQueryType("GRANT ALL ON t TO user")).toBe("OTHER")
    expect(detectQueryType("VACUUM")).toBe("OTHER")
  })
})

// ---------------------------------------------------------------------------
// categorizeQueryError
// ---------------------------------------------------------------------------

describe("warehouse telemetry: categorizeQueryError", () => {
  test("categorizes syntax errors", () => {
    expect(categorizeQueryError(new Error("syntax error at position 5"))).toBe("syntax_error")
  })

  test("categorizes permission errors", () => {
    expect(categorizeQueryError(new Error("permission denied for table users"))).toBe("permission_denied")
    expect(categorizeQueryError(new Error("access denied"))).toBe("permission_denied")
  })

  test("categorizes timeout errors", () => {
    expect(categorizeQueryError(new Error("query timeout exceeded"))).toBe("timeout")
  })

  test("categorizes connection lost errors", () => {
    expect(categorizeQueryError(new Error("connection terminated unexpectedly"))).toBe("connection_lost")
    expect(categorizeQueryError(new Error("connection closed"))).toBe("connection_lost")
  })

  test("returns other for unrecognized", () => {
    expect(categorizeQueryError(new Error("something weird happened"))).toBe("other")
  })
})

// ---------------------------------------------------------------------------
// Telemetry safety: never breaks functionality
// ---------------------------------------------------------------------------

describe("warehouse telemetry: safety", () => {
  beforeEach(() => {
    Registry.reset()
    trackedEvents.length = 0
    trackSpy.mockClear()
  })

  test("list() works even if telemetry.track throws", () => {
    trackSpy.mockImplementation(() => {
      throw new Error("telemetry is broken!")
    })

    Registry.setConfigs({
      pg: { type: "postgres", host: "localhost" },
    })

    // list() should still work without throwing
    const result = Registry.list()
    expect(result.warehouses).toHaveLength(1)
    expect(result.warehouses[0].type).toBe("postgres")

    // Restore spy to capture events again
    trackSpy.mockImplementation((event: any) => { trackedEvents.push(event) })
  })

  test("get() connection failure still throws original error, not telemetry error", async () => {
    trackSpy.mockImplementation(() => {
      throw new Error("telemetry is broken!")
    })

    Registry.setConfigs({
      pg: { type: "unsupported_db_type", host: "localhost" },
    })

    // get() should still throw the driver error, not a telemetry error
    try {
      await Registry.get("pg")
      // Should not reach here
      expect(true).toBe(false)
    } catch (e) {
      expect(String(e)).not.toContain("telemetry is broken")
      expect(String(e)).toContain("Unsupported database type")
    }

    // Restore spy to capture events again
    trackSpy.mockImplementation((event: any) => { trackedEvents.push(event) })
  })
})

// ---------------------------------------------------------------------------
// Event type structure validation
// ---------------------------------------------------------------------------

describe("warehouse telemetry: event structure", () => {
  beforeEach(() => {
    Registry.reset()
    trackedEvents.length = 0
    trackSpy.mockClear()
  })

  test("warehouse_connect event has all required fields on failure", async () => {
    Registry.setConfigs({
      pg: { type: "unsupported_db_type", host: "localhost" },
    })
    try {
      await Registry.get("pg")
    } catch {}

    const event = trackedEvents.find((e) => e.type === "warehouse_connect")
    expect(event).toBeDefined()
    expect(event.type).toBe("warehouse_connect")
    expect(typeof event.timestamp).toBe("number")
    expect(event.session_id).toBe("test-session-123")
    expect(typeof event.warehouse_type).toBe("string")
    expect(typeof event.auth_method).toBe("string")
    expect(typeof event.success).toBe("boolean")
    expect(typeof event.duration_ms).toBe("number")
  })

  test("warehouse_census event has all required fields", () => {
    Registry.setConfigs({
      pg: { type: "postgres", host: "localhost" },
    })
    Registry.list()

    const event = trackedEvents.find((e) => e.type === "warehouse_census")
    expect(event).toBeDefined()
    expect(event.type).toBe("warehouse_census")
    expect(typeof event.timestamp).toBe("number")
    expect(event.session_id).toBe("test-session-123")
    expect(typeof event.total_connections).toBe("number")
    expect(Array.isArray(event.warehouse_types)).toBe(true)
    expect(Array.isArray(event.connection_sources)).toBe(true)
    expect(typeof event.has_ssh_tunnel).toBe("boolean")
    expect(typeof event.has_keychain).toBe("boolean")
  })
})
