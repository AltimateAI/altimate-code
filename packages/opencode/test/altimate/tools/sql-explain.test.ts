/**
 * Tests for SqlExplainTool — input validation and error translation.
 *
 * These tests cover the hardening around:
 *   1. Rejecting empty/placeholder SQL before it hits the warehouse.
 *   2. Rejecting empty/placeholder warehouse names.
 *   3. Dialect-aware EXPLAIN prefix selection (unit tests on the helper).
 *   4. Translating verbatim DB errors into actionable messages.
 */
import { describe, test, expect, spyOn, afterEach, beforeEach } from "bun:test"
import * as Dispatcher from "../../../src/altimate/native/dispatcher"
import {
  SqlExplainTool,
  _sqlExplainInternal as toolInternals,
} from "../../../src/altimate/tools/sql-explain"
import {
  buildExplainPlan,
  buildExplainPrefix,
  translateExplainError,
} from "../../../src/altimate/native/connections/register"
import { SessionID, MessageID } from "../../../src/session/schema"

beforeEach(() => {
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
})

afterEach(() => {
  delete process.env.ALTIMATE_TELEMETRY_DISABLED
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "call_test",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

// ---------------------------------------------------------------------------
// Input validation helpers (pure functions)
// ---------------------------------------------------------------------------

describe("validateSqlInput", () => {
  const { validateSqlInput } = toolInternals

  test("accepts a normal SELECT query", () => {
    expect(validateSqlInput("SELECT id FROM users WHERE id = 42")).toBeNull()
  })

  test("accepts multi-line SQL", () => {
    expect(
      validateSqlInput(`
        SELECT u.id, u.name
        FROM users u
        JOIN orders o ON o.user_id = u.id
      `),
    ).toBeNull()
  })

  test("rejects non-string input", () => {
    expect(validateSqlInput(123 as unknown)).toContain("must be a string")
    expect(validateSqlInput(null as unknown)).toContain("must be a string")
    expect(validateSqlInput(undefined as unknown)).toContain("must be a string")
  })

  test("rejects empty string", () => {
    expect(validateSqlInput("")).toContain("sql is empty")
  })

  test("rejects whitespace-only string", () => {
    expect(validateSqlInput("   \n\t  ")).toContain("sql is empty")
  })

  test("rejects strings too short to be a query", () => {
    const result = validateSqlInput("WHO")
    expect(result).toContain("too short")
  })

  test("rejects bare `?` placeholder", () => {
    const result = validateSqlInput("?")
    expect(result).toContain("placeholder")
    expect(result).toContain("does not support parameterized queries")
  })

  test("rejects bare `:name` placeholder", () => {
    const result = validateSqlInput(":userid")
    expect(result).toContain("placeholder")
  })

  test("rejects bare `$1` placeholder", () => {
    const result = validateSqlInput("$1")
    expect(result).toContain("placeholder")
  })

  test("allows a query with a mid-statement `?` — warehouse will reject if it's a bind placeholder", () => {
    // We do NOT flag mid-query `?` because PostgreSQL JSONB uses `?`, `?|`, `?&`
    // as legitimate "key exists" operators. Letting it through means a real
    // Postgres query with JSONB operators still works, and a bad parameterized
    // query still fails — just at the warehouse rather than at the validator.
    expect(validateSqlInput("SELECT * FROM users WHERE id = ?")).toBeNull()
  })

  test("allows PostgreSQL JSONB `?` key-exists operator", () => {
    expect(
      validateSqlInput("SELECT id FROM users WHERE metadata ? 'email'"),
    ).toBeNull()
  })

  test("allows `?` when it appears inside a string literal", () => {
    // Quoted question marks are not bind placeholders
    expect(validateSqlInput("SELECT 'hello?' FROM dual")).toBeNull()
  })
})

describe("validateWarehouseName", () => {
  const { validateWarehouseName } = toolInternals

  test("accepts undefined (no warehouse requested)", () => {
    expect(validateWarehouseName(undefined)).toBeNull()
  })

  test("accepts a normal connection name", () => {
    expect(validateWarehouseName("snowflake_prod")).toBeNull()
  })

  test("rejects empty string", () => {
    const result = validateWarehouseName("")
    expect(result).toContain("empty string")
  })

  test("rejects whitespace-only string", () => {
    const result = validateWarehouseName("   ")
    expect(result).toContain("empty string")
  })

  test("rejects `?` placeholder", () => {
    const result = validateWarehouseName("?")
    expect(result).toContain("placeholder")
    expect(result).toContain("warehouse_list")
  })

  test("rejects `:var` placeholder", () => {
    expect(validateWarehouseName(":wh")).toContain("placeholder")
  })
})

// ---------------------------------------------------------------------------
// Dialect-aware EXPLAIN prefix
// ---------------------------------------------------------------------------

describe("buildExplainPlan", () => {
  test("Snowflake: EXPLAIN USING TEXT regardless of analyze — analyze silently downgrades", () => {
    expect(buildExplainPlan("snowflake", false)).toEqual({
      prefix: "EXPLAIN USING TEXT",
      actuallyAnalyzed: false,
    })
    // User requested analyze but Snowflake does not support it — the result
    // must reflect the true mode (plan-only) so callers are not misled.
    expect(buildExplainPlan("snowflake", true)).toEqual({
      prefix: "EXPLAIN USING TEXT",
      actuallyAnalyzed: false,
    })
  })

  test("Postgres: plain EXPLAIN or EXPLAIN (ANALYZE, BUFFERS)", () => {
    expect(buildExplainPlan("postgres", false)).toEqual({
      prefix: "EXPLAIN",
      actuallyAnalyzed: false,
    })
    expect(buildExplainPlan("postgres", true)).toEqual({
      prefix: "EXPLAIN (ANALYZE, BUFFERS)",
      actuallyAnalyzed: true,
    })
    // "postgresql" alias
    expect(buildExplainPlan("postgresql", true).prefix).toBe("EXPLAIN (ANALYZE, BUFFERS)")
  })

  test("Redshift: plain EXPLAIN only — does NOT support ANALYZE", () => {
    // Regression: earlier versions incorrectly grouped Redshift with Postgres
    // and sent EXPLAIN (ANALYZE, BUFFERS), which Redshift rejects.
    expect(buildExplainPlan("redshift", false)).toEqual({
      prefix: "EXPLAIN",
      actuallyAnalyzed: false,
    })
    expect(buildExplainPlan("redshift", true)).toEqual({
      prefix: "EXPLAIN",
      actuallyAnalyzed: false,
    })
  })

  test("MySQL / MariaDB: plain EXPLAIN or EXPLAIN ANALYZE", () => {
    expect(buildExplainPlan("mysql", false).prefix).toBe("EXPLAIN")
    expect(buildExplainPlan("mysql", true).prefix).toBe("EXPLAIN ANALYZE")
    expect(buildExplainPlan("mariadb", true).prefix).toBe("EXPLAIN ANALYZE")
  })

  test("DuckDB: plain EXPLAIN or EXPLAIN ANALYZE", () => {
    expect(buildExplainPlan("duckdb", true)).toEqual({
      prefix: "EXPLAIN ANALYZE",
      actuallyAnalyzed: true,
    })
  })

  test("Databricks / Spark: EXPLAIN or EXPLAIN FORMATTED (both plan-only)", () => {
    // FORMATTED returns a richer plan but does not actually execute — so
    // actuallyAnalyzed must stay false.
    expect(buildExplainPlan("databricks", false)).toEqual({
      prefix: "EXPLAIN",
      actuallyAnalyzed: false,
    })
    expect(buildExplainPlan("databricks", true)).toEqual({
      prefix: "EXPLAIN FORMATTED",
      actuallyAnalyzed: false,
    })
    expect(buildExplainPlan("spark", true).prefix).toBe("EXPLAIN FORMATTED")
  })

  test("ClickHouse: plain EXPLAIN", () => {
    expect(buildExplainPlan("clickhouse", false).prefix).toBe("EXPLAIN")
  })

  test("BigQuery: not supported via statement prefix", () => {
    // BigQuery requires a dry-run API call — no statement EXPLAIN.
    expect(buildExplainPlan("bigquery", false).prefix).toBe("")
    expect(buildExplainPlan("bigquery", true).prefix).toBe("")
  })

  test("Oracle: not supported via statement prefix", () => {
    // Oracle's EXPLAIN PLAN FOR stores rows in PLAN_TABLE, producing no
    // output directly — handler will short-circuit with a clear error.
    expect(buildExplainPlan("oracle", false).prefix).toBe("")
  })

  test("SQL Server: not supported via statement prefix", () => {
    expect(buildExplainPlan("mssql", false).prefix).toBe("")
    expect(buildExplainPlan("sqlserver", true).prefix).toBe("")
  })

  test("Unknown warehouse falls back to plain EXPLAIN", () => {
    expect(buildExplainPlan("exotic_db", false)).toEqual({
      prefix: "EXPLAIN",
      actuallyAnalyzed: false,
    })
    expect(buildExplainPlan(undefined, false).prefix).toBe("EXPLAIN")
  })

  test("Is case-insensitive", () => {
    expect(buildExplainPlan("SNOWFLAKE", false).prefix).toBe("EXPLAIN USING TEXT")
    expect(buildExplainPlan("PostGreSQL", true).prefix).toBe("EXPLAIN (ANALYZE, BUFFERS)")
  })
})

describe("buildExplainPrefix (legacy alias)", () => {
  test("matches buildExplainPlan.prefix for the same inputs", () => {
    const warehouses = ["snowflake", "postgres", "mysql", "redshift", "databricks", "bigquery"]
    for (const wh of warehouses) {
      for (const analyze of [false, true]) {
        expect(buildExplainPrefix(wh, analyze)).toBe(buildExplainPlan(wh, analyze).prefix)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

describe("translateExplainError", () => {
  test("translates `Connection not found` into available-warehouse hint", () => {
    const result = translateExplainError(
      new Error("Connection ? not found. Available: (none)"),
      "?",
      ["prod_snowflake", "analytics_pg"],
    )
    expect(result).toContain("not configured")
    expect(result).toContain("prod_snowflake")
    expect(result).toContain("analytics_pg")
  })

  test("tells user to run warehouse_add when none are configured", () => {
    const result = translateExplainError(
      new Error("Connection main not found"),
      "main",
      [],
    )
    expect(result).toContain("No warehouses are configured")
    expect(result).toContain("warehouse_add")
  })

  test("translates `?` placeholder compile errors", () => {
    const result = translateExplainError(
      new Error("OperationFailedError: SQL compilation error: syntax error line 1 at position 8 unexpected ?."),
      "snowflake",
      ["snowflake"],
    )
    expect(result).toContain("unsubstituted bind placeholder")
    expect(result).toContain("inline the literal values")
  })

  test("translates `$1` numbered placeholder compile errors (PostgreSQL style)", () => {
    const result = translateExplainError(
      new Error("syntax error at or near \"$1\" at position 24"),
      "postgres",
      ["postgres"],
    )
    expect(result).toContain("unsubstituted bind placeholder")
  })

  test("translates `:name` named placeholder compile errors", () => {
    const result = translateExplainError(
      new Error("syntax error, unexpected :userid near position 31"),
      "oracle",
      ["oracle"],
    )
    expect(result).toContain("unsubstituted bind placeholder")
  })

  test("translates PostgreSQL 'no parameter $N' errors", () => {
    const result = translateExplainError(
      new Error('there is no parameter $1'),
      "postgres",
      ["postgres"],
    )
    expect(result).toContain("unsubstituted bind placeholder")
  })

  test("translates EXPLAIN ANALYZE-not-supported errors", () => {
    const result = translateExplainError(
      new Error("EXPLAIN ANALYZE is not supported on this warehouse"),
      "snowflake",
      ["snowflake"],
    )
    expect(result).toContain("does not support EXPLAIN ANALYZE")
    expect(result).toContain("analyze=false")
  })

  test("translates permission errors", () => {
    const result = translateExplainError(
      new Error("permission denied for table sensitive_data"),
      "snowflake",
      ["snowflake"],
    )
    expect(result).toContain("lacks permission")
    expect(result).toContain("role grants")
  })

  test("translates generic SQL compilation errors", () => {
    const result = translateExplainError(
      new Error("SQL compilation error: unknown identifier 'nonsense'"),
      "snowflake",
      ["snowflake"],
    )
    expect(result).toContain("SQL compilation error")
    expect(result).toContain("Fix the SQL")
  })

  test("passes through truly unknown errors", () => {
    const result = translateExplainError(new Error("some exotic network failure"), "wh", ["wh"])
    expect(result).toBe("some exotic network failure")
  })

  test("accepts non-Error values", () => {
    const result = translateExplainError("raw string error", "wh", [])
    expect(result).toBe("raw string error")
  })
})

// ---------------------------------------------------------------------------
// Integration: Tool.execute with mocked Dispatcher
// ---------------------------------------------------------------------------

describe("SqlExplainTool.execute", () => {
  let dispatcherSpy: ReturnType<typeof spyOn> | undefined

  afterEach(() => {
    dispatcherSpy?.mockRestore()
    dispatcherSpy = undefined
  })

  function mockDispatcher(response: unknown) {
    dispatcherSpy?.mockRestore()
    dispatcherSpy = spyOn(Dispatcher, "call").mockImplementation(async () => response as never)
  }

  test("rejects empty sql before calling dispatcher", async () => {
    const spy = spyOn(Dispatcher, "call")
    const tool = await SqlExplainTool.init()
    const result = await tool.execute({ sql: "", analyze: false }, ctx as any)

    expect(result.metadata.success).toBe(false)
    expect(result.metadata.error_class).toBe("input_validation")
    expect(result.title).toContain("INVALID INPUT")
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  test("rejects bare `?` sql before calling dispatcher", async () => {
    const spy = spyOn(Dispatcher, "call")
    const tool = await SqlExplainTool.init()
    const result = await tool.execute({ sql: "?", analyze: false }, ctx as any)

    expect(result.metadata.success).toBe(false)
    expect(result.metadata.error_class).toBe("input_validation")
    expect(String(result.output)).toContain("placeholder")
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  test("rejects `?` warehouse name before calling dispatcher", async () => {
    const spy = spyOn(Dispatcher, "call")
    const tool = await SqlExplainTool.init()
    const result = await tool.execute(
      { sql: "SELECT 1 FROM dual", warehouse: "?", analyze: false },
      ctx as any,
    )

    expect(result.metadata.success).toBe(false)
    expect(result.metadata.error_class).toBe("input_validation")
    expect(String(result.output)).toContain("warehouse")
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  test("returns success when dispatcher reports success", async () => {
    mockDispatcher({
      success: true,
      plan_text: "Seq Scan on users",
      plan_rows: [{ line: 1, text: "Seq Scan on users" }],
      warehouse_type: "postgres",
      analyzed: false,
    })

    const tool = await SqlExplainTool.init()
    const result = await tool.execute({ sql: "SELECT * FROM users", analyze: false }, ctx as any)

    expect(result.metadata.success).toBe(true)
    expect(result.metadata.warehouse_type).toBe("postgres")
    expect(result.title).toContain("PLAN")
    expect(String(result.output)).toContain("Seq Scan on users")
  })

  test("returns failure when dispatcher reports failure", async () => {
    mockDispatcher({
      success: false,
      plan_rows: [],
      error: "Warehouse \"prod\" is not configured. Available warehouses: dev, staging.",
      warehouse_type: undefined,
      analyzed: false,
    })

    const tool = await SqlExplainTool.init()
    const result = await tool.execute(
      { sql: "SELECT * FROM users", warehouse: "prod", analyze: false },
      ctx as any,
    )

    expect(result.metadata.success).toBe(false)
    expect(result.title).toContain("FAILED")
    expect(String(result.output)).toContain("not configured")
  })

  test("returns ERROR title when dispatcher throws", async () => {
    dispatcherSpy = spyOn(Dispatcher, "call").mockImplementation(async () => {
      throw new Error("dispatcher exploded")
    })

    const tool = await SqlExplainTool.init()
    const result = await tool.execute({ sql: "SELECT 1 FROM dual", analyze: false }, ctx as any)

    expect(result.metadata.success).toBe(false)
    expect(result.title).toContain("ERROR")
    expect(String(result.output)).toContain("dispatcher exploded")
  })
})
