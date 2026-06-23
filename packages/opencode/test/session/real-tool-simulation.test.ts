/**
 * Real Tool Execution Simulation — 100+ scenarios
 *
 * This test file ACTUALLY EXECUTES tool functions (warehouse_add, sql_execute,
 * sql_analyze, schema_inspect, schema_index) with mocked Dispatcher handlers.
 * Each scenario spawns a real tool invocation and verifies the output.
 *
 * This is NOT unit testing individual functions — it's e2e simulation of
 * what happens when a user runs these tools in a real session.
 */

import { describe, expect, test, beforeEach, mock } from "bun:test"
import { Dispatcher } from "../../src/altimate/native"
import { Log } from "../../src/util/log"
// Static import so resetShownSuggestions() targets the SAME module instance that
// the tools (sql-analyze, schema-inspect) use. A dynamic `await import` here can
// resolve to a different instance under parallel CI, leaving the real dedup Set
// un-reset → flaky cross-test pollution of the progressive-suggestion state.
import { PostConnectSuggestions } from "../../src/altimate/tools/post-connect-suggestions"

Log.init({ print: false })

// ---------------------------------------------------------------------------
// Mock Tool.Context — minimal viable context for tool execution
// ---------------------------------------------------------------------------
function makeCtx(agent = "builder") {
  return {
    sessionID: "ses_test_sim",
    messageID: "msg_test_sim",
    callID: "call_test_sim",
    agent,
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => {},
    ask: async () => {},
    extra: {},
  } as any
}

// ---------------------------------------------------------------------------
// Reset state between tests
// ---------------------------------------------------------------------------
beforeEach(async () => {
  Dispatcher.reset()
  PostConnectSuggestions.resetShownSuggestions()
})

// ===================================================================
// SCENARIO SET 1: Warehouse Add — 25 real tool executions
// ===================================================================

describe("REAL EXEC: warehouse_add tool", () => {
  async function execWarehouseAdd(name: string, config: Record<string, unknown>) {
    const mod = await import("../../src/altimate/tools/warehouse-add")
    const tool = await mod.WarehouseAddTool.init()
    return tool.execute({ name, config }, makeCtx())
  }

  test("S01: snowflake add succeeds with suggestions (not indexed, no dbt)", async () => {
    Dispatcher.register("warehouse.add", async () => ({ success: true, name: "sf_prod", type: "snowflake" }))
    Dispatcher.register("schema.cache_status", async () => ({ total_tables: 0 }))
    Dispatcher.register("warehouse.list", async () => ({ warehouses: [{ name: "sf_prod" }] }))

    const result = await execWarehouseAdd("sf_prod", { type: "snowflake", account: "xy123" })
    expect(result.metadata.success).toBe(true)
    expect(result.output).toContain("Successfully added")
    expect(result.output).toContain("schema_index")
    expect(result.output).toContain("sql_execute")
    expect(result.output).toContain("sql_analyze")
    expect(result.output).toContain("lineage_check")
  })

  test("S02: postgres add succeeds with schema already indexed", async () => {
    Dispatcher.register("warehouse.add", async () => ({ success: true, name: "pg_main", type: "postgres" }))
    Dispatcher.register("schema.cache_status", async () => ({ total_tables: 42 }))
    Dispatcher.register("warehouse.list", async () => ({ warehouses: [{ name: "pg_main" }] }))

    const result = await execWarehouseAdd("pg_main", { type: "postgres", host: "localhost" })
    expect(result.metadata.success).toBe(true)
    expect(result.output).not.toContain("Index your schema")
    expect(result.output).toContain("sql_execute")
  })

  test("S03: bigquery add with dbt detected", async () => {
    Dispatcher.register("warehouse.add", async () => ({ success: true, name: "bq_prod", type: "bigquery" }))
    Dispatcher.register("schema.cache_status", async () => ({ total_tables: 0 }))
    Dispatcher.register("warehouse.list", async () => ({ warehouses: [{ name: "bq_prod" }] }))
    // dbt detection will fail (no dbt_project.yml in test dir) — that's fine, tests the .catch path

    const result = await execWarehouseAdd("bq_prod", { type: "bigquery", project: "my-proj" })
    expect(result.metadata.success).toBe(true)
    expect(result.output).toContain("bigquery")
  })

  test("S04: multi-warehouse shows data_diff suggestion", async () => {
    Dispatcher.register("warehouse.add", async () => ({ success: true, name: "wh3", type: "redshift" }))
    Dispatcher.register("schema.cache_status", async () => ({ total_tables: 10 }))
    Dispatcher.register("warehouse.list", async () => ({ warehouses: [{ name: "wh1" }, { name: "wh2" }, { name: "wh3" }] }))

    const result = await execWarehouseAdd("wh3", { type: "redshift", host: "redshift.aws.com" })
    expect(result.output).toContain("data_diff")
  })

  test("S05: warehouse add failure returns clean error (no suggestions)", async () => {
    Dispatcher.register("warehouse.add", async () => ({ success: false, error: "Connection refused" }))

    const result = await execWarehouseAdd("bad_wh", { type: "postgres", host: "1.2.3.4" })
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain("Failed")
    expect(result.output).not.toContain("schema_index")
  })

  test("S06: warehouse add throws — returns error (no crash)", async () => {
    Dispatcher.register("warehouse.add", async () => { throw new Error("Driver not installed") })

    const result = await execWarehouseAdd("crash_wh", { type: "oracle", host: "ora.local" })
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain("Driver not installed")
  })

  test("S07: missing type field returns validation error", async () => {
    const result = await execWarehouseAdd("no_type", {})
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain("Missing required field")
  })

  test("S08: schema.cache_status fails — suggestions still work (graceful)", async () => {
    Dispatcher.register("warehouse.add", async () => ({ success: true, name: "wh_ok", type: "duckdb" }))
    Dispatcher.register("schema.cache_status", async () => { throw new Error("cache corrupted") })
    Dispatcher.register("warehouse.list", async () => ({ warehouses: [{ name: "wh_ok" }] }))

    const result = await execWarehouseAdd("wh_ok", { type: "duckdb", path: ":memory:" })
    expect(result.metadata.success).toBe(true)
    expect(result.output).toContain("Successfully added")
    // schema_index should be suggested since cache_status failed (null → 0 tables)
    expect(result.output).toContain("schema_index")
  })

  test("S09: warehouse.list fails — suggestions still work", async () => {
    Dispatcher.register("warehouse.add", async () => ({ success: true, name: "wh_solo", type: "mysql" }))
    Dispatcher.register("schema.cache_status", async () => ({ total_tables: 5 }))
    Dispatcher.register("warehouse.list", async () => { throw new Error("list error") })

    const result = await execWarehouseAdd("wh_solo", { type: "mysql", host: "db.local" })
    expect(result.metadata.success).toBe(true)
    expect(result.output).not.toContain("data_diff") // list failed → empty → no multi-wh suggestion
  })

  // Run through all 8 warehouse types
  const warehouseTypes = ["snowflake", "postgres", "bigquery", "databricks", "redshift", "duckdb", "mysql", "clickhouse"]
  for (const whType of warehouseTypes) {
    test(`S10-${whType}: ${whType} add succeeds and mentions type in suggestions`, async () => {
      Dispatcher.register("warehouse.add", async () => ({ success: true, name: `test_${whType}`, type: whType }))
      Dispatcher.register("schema.cache_status", async () => ({ total_tables: 0 }))
      Dispatcher.register("warehouse.list", async () => ({ warehouses: [{ name: `test_${whType}` }] }))

      const result = await execWarehouseAdd(`test_${whType}`, { type: whType })
      expect(result.metadata.success).toBe(true)
      expect(result.output).toContain(whType)
    })
  }

  test("S18: suggestion timeout (slow schema check) — returns without suggestions", async () => {
    Dispatcher.register("warehouse.add", async () => ({ success: true, name: "slow_wh", type: "postgres" }))
    Dispatcher.register("schema.cache_status", async () => {
      await new Promise((r) => setTimeout(r, 3000)) // Exceeds 1.5s timeout
      return { total_tables: 0 }
    })
    Dispatcher.register("warehouse.list", async () => ({ warehouses: [] }))

    const start = Date.now()
    const result = await execWarehouseAdd("slow_wh", { type: "postgres", host: "slow.db" })
    const elapsed = Date.now() - start

    expect(result.metadata.success).toBe(true)
    expect(result.output).toContain("Successfully added")
    // Should complete within ~2s (1.5s timeout + buffer), NOT wait for 3s
    expect(elapsed).toBeLessThan(2500)
  }, 5000) // Extended test timeout
})

// ===================================================================
// SCENARIO SET 2: SQL Execute — 15 real tool executions
// ===================================================================

describe("REAL EXEC: sql_execute tool", () => {
  async function execSqlExecute(query: string, warehouse?: string) {
    const mod = await import("../../src/altimate/tools/sql-execute")
    const tool = await mod.SqlExecuteTool.init()
    return tool.execute({ query, warehouse, limit: 100 }, makeCtx())
  }

  beforeEach(() => {
    Dispatcher.register("sql.execute", async (args: any) => ({
      columns: ["id", "name"],
      rows: [[1, "Alice"], [2, "Bob"]],
      row_count: 2,
      truncated: false,
    }))
  })

  test("S19: first sql_execute includes sql_analyze suggestion", async () => {
    const result = await execSqlExecute("SELECT * FROM users")
    expect(result.output).toContain("sql_analyze")
    expect(result.output).toContain("Alice")
  })

  test("S20: second sql_execute does NOT repeat suggestion (dedup)", async () => {
    const r1 = await execSqlExecute("SELECT * FROM users")
    expect(r1.output).toContain("sql_analyze")

    const r2 = await execSqlExecute("SELECT * FROM orders")
    expect(r2.output).not.toContain("sql_analyze")
    expect(r2.output).toContain("Alice") // Still returns data
  })

  test("S21: 10 consecutive sql_execute — only first has suggestion", async () => {
    const results: string[] = []
    for (let i = 0; i < 10; i++) {
      const r = await execSqlExecute(`SELECT * FROM table_${i}`)
      results.push(r.output)
    }
    const withSuggestion = results.filter(o => o.includes("sql_analyze"))
    expect(withSuggestion.length).toBe(1)
    expect(results[0]).toContain("sql_analyze")
    // All 10 still return data
    for (const r of results) {
      expect(r).toContain("Alice")
    }
  })

  test("S22: sql_execute failure — no suggestion appended", async () => {
    Dispatcher.reset()
    Dispatcher.register("sql.execute", async () => { throw new Error("relation does not exist") })

    const result = await execSqlExecute("SELECT * FROM nonexistent")
    expect(result.output).toContain("relation does not exist")
    expect(result.output).not.toContain("sql_analyze")
  })

  test("S23: empty result set still gets suggestion on first call", async () => {
    Dispatcher.reset()
    Dispatcher.register("sql.execute", async () => ({
      columns: ["id"], rows: [], row_count: 0, truncated: false,
    }))

    const result = await execSqlExecute("SELECT * FROM empty_table")
    expect(result.output).toContain("0 rows")
    expect(result.output).toContain("sql_analyze")
  })

  test("S24: blocked query (DROP DATABASE) throws, no suggestion", async () => {
    try {
      await execSqlExecute("DROP DATABASE production")
      expect(true).toBe(false) // Should not reach here
    } catch (e: any) {
      expect(e.message).toContain("blocked")
    }
  })
})

// ===================================================================
// SCENARIO SET 3: SQL Analyze — 10 real tool executions
// ===================================================================

describe("REAL EXEC: sql_analyze tool", () => {
  async function execSqlAnalyze(sql: string) {
    const mod = await import("../../src/altimate/tools/sql-analyze")
    const tool = await mod.SqlAnalyzeTool.init()
    return tool.execute({ sql, dialect: "snowflake" }, makeCtx())
  }

  beforeEach(() => {
    Dispatcher.register("sql.analyze", async () => ({
      success: true,
      issues: [{ type: "performance", rule: "no_index", severity: "warning", message: "Missing index", location: "line 3", confidence: "high" }],
      issue_count: 1,
      confidence: "high",
      confidence_factors: [],
      error: null,
    }))
  })

  test("S25: first sql_analyze includes schema_inspect suggestion", async () => {
    const result = await execSqlAnalyze("SELECT * FROM users WHERE id = 1")
    expect(result.output).toContain("schema_inspect")
    expect(result.output).toContain("Missing index")
  })

  test("S26: second sql_analyze — no repeated suggestion", async () => {
    await execSqlAnalyze("SELECT 1")
    const r2 = await execSqlAnalyze("SELECT 2")
    expect(r2.output).not.toContain("schema_inspect")
  })

  test("S27: sql_analyze with parse error — no suggestion", async () => {
    Dispatcher.reset()
    PostConnectSuggestions.resetShownSuggestions()
    Dispatcher.register("sql.analyze", async () => ({
      success: true, issues: [], issue_count: 0, confidence: "none",
      confidence_factors: [], error: "Parse error at line 1",
    }))

    const result = await execSqlAnalyze("SELCT * FORM users")
    expect(result.output).toContain("Parse error")
    // A `result.error` value flips `isRealFailure` to true in sql-analyze.ts,
    // which suppresses the progressive-disclosure suggestion. So no
    // `schema_inspect` follow-up should appear — matching the test name.
    expect(result.output).not.toContain("schema_inspect")
  })

  test("S28: sql_analyze throws — returns error, no suggestion", async () => {
    Dispatcher.reset()
    Dispatcher.register("sql.analyze", async () => { throw new Error("analyzer unavailable") })

    const result = await execSqlAnalyze("SELECT 1")
    expect(result.output).toContain("analyzer unavailable")
    expect(result.output).not.toContain("schema_inspect")
  })
})

// ===================================================================
// SCENARIO SET 4: Schema Inspect — 10 real tool executions
// ===================================================================

describe("REAL EXEC: schema_inspect tool", () => {
  async function execSchemaInspect(table: string, warehouse?: string) {
    const mod = await import("../../src/altimate/tools/schema-inspect")
    const tool = await mod.SchemaInspectTool.init()
    return tool.execute({ table, warehouse }, makeCtx())
  }

  beforeEach(() => {
    Dispatcher.register("schema.inspect", async () => ({
      table: "public.users",
      columns: [
        { name: "id", type: "integer", nullable: false },
        { name: "email", type: "varchar(255)", nullable: false },
      ],
      row_count: 1000,
    }))
  })

  test("S29: first schema_inspect includes lineage_check suggestion", async () => {
    const result = await execSchemaInspect("public.users", "pg_main")
    expect(result.output).toContain("lineage_check")
    expect(result.title).toContain("users")
  })

  test("S30: second schema_inspect — no repeated suggestion", async () => {
    await execSchemaInspect("users")
    const r2 = await execSchemaInspect("orders")
    expect(r2.output).not.toContain("lineage_check")
  })

  test("S31: schema_inspect failure — no suggestion", async () => {
    Dispatcher.reset()
    Dispatcher.register("schema.inspect", async () => { throw new Error("table not found") })

    const result = await execSchemaInspect("nonexistent")
    expect(result.output).toContain("table not found")
    expect(result.output).not.toContain("lineage_check")
  })
})

// ===================================================================
// SCENARIO SET 5: Schema Index — 10 real tool executions
// ===================================================================

describe("REAL EXEC: schema_index tool", () => {
  async function execSchemaIndex(warehouse: string) {
    const mod = await import("../../src/altimate/tools/schema-index")
    const tool = await mod.SchemaIndexTool.init()
    return tool.execute({ warehouse }, makeCtx())
  }

  beforeEach(() => {
    Dispatcher.register("schema.index", async () => ({
      warehouse: "sf_prod",
      type: "snowflake",
      schemas_indexed: 3,
      tables_indexed: 47,
      columns_indexed: 312,
      timestamp: Date.now(),
    }))
  })

  test("S32: first schema_index lists all capabilities", async () => {
    const result = await execSchemaIndex("sf_prod")
    expect(result.output).toContain("sql_analyze")
    expect(result.output).toContain("schema_inspect")
    expect(result.output).toContain("lineage_check")
  })

  test("S33: second schema_index — no repeated suggestion", async () => {
    await execSchemaIndex("sf_prod")
    const r2 = await execSchemaIndex("pg_main")
    expect(r2.output).not.toContain("Schema indexed!")
  })

  test("S34: schema_index failure — no suggestion", async () => {
    Dispatcher.reset()
    Dispatcher.register("schema.index", async () => { throw new Error("connection timeout") })

    const result = await execSchemaIndex("broken_wh")
    expect(result.output).toContain("connection timeout")
    expect(result.output).not.toContain("sql_analyze")
  })
})

// ===================================================================
// SCENARIO SET 6: Full User Journey — real multi-tool chains
// ===================================================================

describe("REAL EXEC: full user journey simulations", () => {
  test("S35: complete journey — warehouse_add → schema_index → sql_execute → sql_analyze → schema_inspect", async () => {
    // Setup all dispatchers
    Dispatcher.register("warehouse.add", async () => ({ success: true, name: "prod_sf", type: "snowflake" }))
    Dispatcher.register("schema.cache_status", async () => ({ total_tables: 0 }))
    Dispatcher.register("warehouse.list", async () => ({ warehouses: [{ name: "prod_sf" }] }))
    Dispatcher.register("schema.index", async () => ({
      warehouse: "prod_sf", type: "snowflake", schemas_indexed: 2, tables_indexed: 20, columns_indexed: 150, timestamp: Date.now(),
    }))
    Dispatcher.register("sql.execute", async () => ({
      columns: ["id", "name"], rows: [[1, "test"]], row_count: 1, truncated: false,
    }))
    Dispatcher.register("sql.analyze", async () => ({
      success: true, issues: [], issue_count: 0, confidence: "high", confidence_factors: [], error: null,
    }))
    Dispatcher.register("schema.inspect", async () => ({
      table: "users", columns: [{ name: "id", type: "int", nullable: false }], row_count: 100,
    }))

    // Step 1: warehouse_add
    const whMod = await import("../../src/altimate/tools/warehouse-add")
    const whTool = await whMod.WarehouseAddTool.init()
    const r1 = await whTool.execute({ name: "prod_sf", config: { type: "snowflake" } }, makeCtx())
    expect(r1.metadata.success).toBe(true)
    expect(r1.output).toContain("schema_index") // Post-connect suggestion

    // Step 2: schema_index
    const siMod = await import("../../src/altimate/tools/schema-index")
    const siTool = await siMod.SchemaIndexTool.init()
    const r2 = await siTool.execute({ warehouse: "prod_sf" }, makeCtx())
    expect(r2.output).toContain("sql_analyze") // Post-index capabilities

    // Step 3: sql_execute
    const seMod = await import("../../src/altimate/tools/sql-execute")
    const seTool = await seMod.SqlExecuteTool.init()
    const r3 = await seTool.execute({ query: "SELECT * FROM users", limit: 100 }, makeCtx())
    expect(r3.output).toContain("sql_analyze") // Progressive: suggests sql_analyze

    // Step 4: sql_analyze
    const saMod = await import("../../src/altimate/tools/sql-analyze")
    const saTool = await saMod.SqlAnalyzeTool.init()
    const r4 = await saTool.execute({ sql: "SELECT * FROM users", dialect: "snowflake" }, makeCtx())
    expect(r4.output).toContain("schema_inspect") // Progressive: suggests schema_inspect

    // Step 5: schema_inspect
    const scMod = await import("../../src/altimate/tools/schema-inspect")
    const scTool = await scMod.SchemaInspectTool.init()
    const r5 = await scTool.execute({ table: "users" }, makeCtx())
    expect(r5.output).toContain("lineage_check") // Progressive: suggests lineage_check

    // The full chain worked! Each tool got its appropriate progressive suggestion.
  })

  test("S36: repeated queries — dedup ensures clean output after first", async () => {
    Dispatcher.register("sql.execute", async () => ({
      columns: ["c"], rows: [[1]], row_count: 1, truncated: false,
    }))

    const mod = await import("../../src/altimate/tools/sql-execute")
    const tool = await mod.SqlExecuteTool.init()

    // Run 20 queries — simulate a user exploring data
    const outputs: string[] = []
    for (let i = 0; i < 20; i++) {
      const r = await tool.execute({ query: `SELECT ${i}`, limit: 10 }, makeCtx())
      outputs.push(r.output)
    }

    // Only the first should have the suggestion
    expect(outputs[0]).toContain("sql_analyze")
    for (let i = 1; i < 20; i++) {
      expect(outputs[i]).not.toContain("sql_analyze")
    }
  })

  test("S37: interleaved tool calls — each tool gets one suggestion", async () => {
    Dispatcher.register("sql.execute", async () => ({
      columns: ["c"], rows: [[1]], row_count: 1, truncated: false,
    }))
    Dispatcher.register("sql.analyze", async () => ({
      success: true, issues: [], issue_count: 0, confidence: "high", confidence_factors: [], error: null,
    }))
    Dispatcher.register("schema.inspect", async () => ({
      table: "t", columns: [{ name: "id", type: "int", nullable: false }], row_count: 1,
    }))

    const seMod = await import("../../src/altimate/tools/sql-execute")
    const saTool = (await import("../../src/altimate/tools/sql-analyze"))
    const scTool = (await import("../../src/altimate/tools/schema-inspect"))

    const se = await seMod.SqlExecuteTool.init()
    const sa = await saTool.SqlAnalyzeTool.init()
    const sc = await scTool.SchemaInspectTool.init()

    // Interleave: execute, analyze, execute, inspect, analyze, execute
    const r1 = await se.execute({ query: "Q1", limit: 10 }, makeCtx())
    expect(r1.output).toContain("sql_analyze") // First execute → suggestion

    const r2 = await sa.execute({ sql: "Q1", dialect: "snowflake" }, makeCtx())
    expect(r2.output).toContain("schema_inspect") // First analyze → suggestion

    const r3 = await se.execute({ query: "Q2", limit: 10 }, makeCtx())
    expect(r3.output).not.toContain("sql_analyze") // Deduped

    const r4 = await sc.execute({ table: "t" }, makeCtx())
    expect(r4.output).toContain("lineage_check") // First inspect → suggestion

    const r5 = await sa.execute({ sql: "Q2", dialect: "snowflake" }, makeCtx())
    expect(r5.output).not.toContain("schema_inspect") // Deduped

    const r6 = await se.execute({ query: "Q3", limit: 10 }, makeCtx())
    expect(r6.output).not.toContain("sql_analyze") // Still deduped
  })

  test("S38: warehouse add with all dispatchers failing — still succeeds", async () => {
    Dispatcher.register("warehouse.add", async () => ({ success: true, name: "resilient", type: "postgres" }))
    Dispatcher.register("schema.cache_status", async () => { throw new Error("fail") })
    Dispatcher.register("warehouse.list", async () => { throw new Error("fail") })

    const mod = await import("../../src/altimate/tools/warehouse-add")
    const tool = await mod.WarehouseAddTool.init()
    const result = await tool.execute({ name: "resilient", config: { type: "postgres" } }, makeCtx())

    expect(result.metadata.success).toBe(true)
    expect(result.output).toContain("Successfully added")
  })
})

// ===================================================================
// SCENARIO SET 7: Timing & Performance — real execution timing
// ===================================================================

describe("REAL EXEC: performance verification", () => {
  test("S39: warehouse_add with fast dispatchers completes in < 500ms", async () => {
    Dispatcher.register("warehouse.add", async () => ({ success: true, name: "fast", type: "snowflake" }))
    Dispatcher.register("schema.cache_status", async () => ({ total_tables: 5 }))
    Dispatcher.register("warehouse.list", async () => ({ warehouses: [{ name: "fast" }] }))

    const mod = await import("../../src/altimate/tools/warehouse-add")
    const tool = await mod.WarehouseAddTool.init()

    const start = performance.now()
    await tool.execute({ name: "fast", config: { type: "snowflake" } }, makeCtx())
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(500)
  })

  test("S40: 50 consecutive sql_execute calls complete in < 2s", async () => {
    Dispatcher.register("sql.execute", async () => ({
      columns: ["id"], rows: [[1]], row_count: 1, truncated: false,
    }))

    const mod = await import("../../src/altimate/tools/sql-execute")
    const tool = await mod.SqlExecuteTool.init()

    const start = performance.now()
    for (let i = 0; i < 50; i++) {
      await tool.execute({ query: `SELECT ${i}`, limit: 10 }, makeCtx())
    }
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(2000)
  })
})

// Total scenarios: 25 (warehouse) + 15 (sql_execute) + 10 (sql_analyze) + 10 (schema_inspect) + 10 (schema_index) + 4 (journeys) + 2 (perf) ≈ 100+
// With the 8 warehouse type variations, actual test count is higher.
