/**
 * Tests for data engineering domain-specific trace file attributes.
 *
 * Verifies that:
 *   1. Domain attributes are purely optional — traces work without them
 *   2. setSpanAttributes merges correctly into spans
 *   3. Missing/undefined/null attributes don't corrupt traces
 *   4. The DE constants are correctly defined
 *   5. Domain attributes survive serialization to JSON and back
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { Recap, FileExporter, type TraceFile } from "../../src/altimate/observability/tracing"
import { DE } from "../../src/altimate/observability/de-attributes"

let tmpDir: string

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `tracing-de-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(tmpDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

const ZERO_STEP = {
  id: "1",
  reason: "stop",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

// ---------------------------------------------------------------------------
// DE constants validation
// ---------------------------------------------------------------------------

describe("DE attribute constants", () => {
  test("all warehouse keys start with de.warehouse.", () => {
    for (const value of Object.values(DE.WAREHOUSE)) {
      expect(value).toMatch(/^de\.warehouse\./)
    }
  })

  test("all SQL keys start with de.sql.", () => {
    for (const value of Object.values(DE.SQL)) {
      expect(value).toMatch(/^de\.sql\./)
    }
  })

  test("all dbt keys start with de.dbt.", () => {
    for (const value of Object.values(DE.DBT)) {
      expect(value).toMatch(/^de\.dbt\./)
    }
  })

  test("all quality keys start with de.quality.", () => {
    for (const value of Object.values(DE.QUALITY)) {
      expect(value).toMatch(/^de\.quality\./)
    }
  })

  test("all cost keys start with de.cost.", () => {
    for (const value of Object.values(DE.COST)) {
      expect(value).toMatch(/^de\.cost\./)
    }
  })

  test("no duplicate keys across all domains", () => {
    const allKeys = [
      ...Object.values(DE.WAREHOUSE),
      ...Object.values(DE.SQL),
      ...Object.values(DE.DBT),
      ...Object.values(DE.QUALITY),
      ...Object.values(DE.COST),
    ]
    const unique = new Set(allKeys)
    expect(unique.size).toBe(allKeys.length)
  })
})

// ---------------------------------------------------------------------------
// setSpanAttributes — targeting
// ---------------------------------------------------------------------------

describe("setSpanAttributes — targeting", () => {
  test("attaches to last tool span by default", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-tool-attrs", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "sql_execute",
      callID: "c1",
      state: {
        status: "completed",
        input: { query: "SELECT 1" },
        output: "1 row",
        time: { start: 1000, end: 2000 },
      },
    })
    tracer.setSpanAttributes({
      [DE.WAREHOUSE.SYSTEM]: "snowflake",
      [DE.WAREHOUSE.BYTES_SCANNED]: 1_500_000,
      [DE.WAREHOUSE.ESTIMATED_COST_USD]: 0.003,
      [DE.SQL.QUERY_TEXT]: "SELECT 1",
    })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()

    const traceFile: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const toolSpan = traceFile.spans.find((s) => s.kind === "tool")!
    expect(toolSpan.attributes![DE.WAREHOUSE.SYSTEM]).toBe("snowflake")
    expect(toolSpan.attributes![DE.WAREHOUSE.BYTES_SCANNED]).toBe(1_500_000)
    expect(toolSpan.attributes![DE.WAREHOUSE.ESTIMATED_COST_USD]).toBe(0.003)
    expect(toolSpan.attributes![DE.SQL.QUERY_TEXT]).toBe("SELECT 1")
  })

  test("attaches to generation span when target='generation'", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-gen-attrs", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.setSpanAttributes({ custom: "on-generation" }, "generation")
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()

    const traceFile: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const genSpan = traceFile.spans.find((s) => s.kind === "generation")!
    expect(genSpan.attributes!.custom).toBe("on-generation")
  })

  test("attaches to session span when target='session'", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-session-attrs", { prompt: "test" })
    tracer.setSpanAttributes({
      [DE.COST.TOTAL_USD]: 0.15,
      [DE.COST.ATTRIBUTION_PROJECT]: "analytics",
    }, "session")
    const filePath = await tracer.endTrace()

    const traceFile: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const sessionSpan = traceFile.spans.find((s) => s.kind === "session")!
    expect(sessionSpan.attributes![DE.COST.TOTAL_USD]).toBe(0.15)
    expect(sessionSpan.attributes![DE.COST.ATTRIBUTION_PROJECT]).toBe("analytics")
  })

  test("auto-targeting falls through: no tool → generation → session", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-fallthrough", { prompt: "test" })
    // No tool spans, no generation — should attach to session
    tracer.setSpanAttributes({ fallthrough: "to-session" })
    const filePath = await tracer.endTrace()

    const traceFile: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const sessionSpan = traceFile.spans.find((s) => s.kind === "session")!
    expect(sessionSpan.attributes!.fallthrough).toBe("to-session")
  })
})

// ---------------------------------------------------------------------------
// setSpanAttributes — graceful degradation
// ---------------------------------------------------------------------------

describe("setSpanAttributes — graceful degradation", () => {
  test("no-op before startTrace", () => {
    const tracer = Recap.withExporters([])
    // Should not throw
    tracer.setSpanAttributes({ [DE.WAREHOUSE.SYSTEM]: "snowflake" })
  })

  test("undefined values are skipped", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-undef-vals", { prompt: "test" })
    tracer.setSpanAttributes({
      [DE.WAREHOUSE.SYSTEM]: "bigquery",
      [DE.WAREHOUSE.BYTES_SCANNED]: undefined,
      [DE.WAREHOUSE.SLOT_MS]: undefined,
    }, "session")
    const filePath = await tracer.endTrace()

    const traceFile: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const sessionSpan = traceFile.spans.find((s) => s.kind === "session")!
    expect(sessionSpan.attributes![DE.WAREHOUSE.SYSTEM]).toBe("bigquery")
    expect(DE.WAREHOUSE.BYTES_SCANNED in (sessionSpan.attributes ?? {})).toBe(false)
  })

  test("null values are preserved (unlike undefined)", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-null-vals", { prompt: "test" })
    tracer.setSpanAttributes({
      [DE.DBT.MODEL_ERROR]: null,
    }, "session")
    const filePath = await tracer.endTrace()

    const traceFile: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const sessionSpan = traceFile.spans.find((s) => s.kind === "session")!
    expect(sessionSpan.attributes![DE.DBT.MODEL_ERROR]).toBeNull()
  })

  test("empty attributes object is a no-op", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-empty-attrs", { prompt: "test" })
    tracer.setSpanAttributes({}, "session")
    const filePath = await tracer.endTrace()

    const traceFile: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const sessionSpan = traceFile.spans.find((s) => s.kind === "session")!
    expect(Object.keys(sessionSpan.attributes ?? {}).length).toBe(0)
  })

  test("multiple setSpanAttributes calls merge correctly", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-merge", { prompt: "test" })
    tracer.setSpanAttributes({ [DE.WAREHOUSE.SYSTEM]: "snowflake" }, "session")
    tracer.setSpanAttributes({ [DE.WAREHOUSE.BYTES_SCANNED]: 5000 }, "session")
    tracer.setSpanAttributes({ [DE.COST.TOTAL_USD]: 0.05 }, "session")
    const filePath = await tracer.endTrace()

    const traceFile: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const attrs = traceFile.spans.find((s) => s.kind === "session")!.attributes!
    expect(attrs[DE.WAREHOUSE.SYSTEM]).toBe("snowflake")
    expect(attrs[DE.WAREHOUSE.BYTES_SCANNED]).toBe(5000)
    expect(attrs[DE.COST.TOTAL_USD]).toBe(0.05)
  })

  test("later setSpanAttributes overwrites earlier values for same key", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-overwrite", { prompt: "test" })
    tracer.setSpanAttributes({ [DE.WAREHOUSE.SYSTEM]: "snowflake" }, "session")
    tracer.setSpanAttributes({ [DE.WAREHOUSE.SYSTEM]: "bigquery" }, "session")
    const filePath = await tracer.endTrace()

    const traceFile: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const attrs = traceFile.spans.find((s) => s.kind === "session")!.attributes!
    expect(attrs[DE.WAREHOUSE.SYSTEM]).toBe("bigquery")
  })

  test("targeting non-existent span type is a no-op", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-no-gen", { prompt: "test" })
    // No generation span exists
    tracer.setSpanAttributes({ custom: "value" }, "generation")
    const filePath = await tracer.endTrace()
    // Should still produce a valid trace
    expect(filePath).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Real-world DE scenarios
// ---------------------------------------------------------------------------

describe("Real-world data engineering scenarios", () => {
  test("SQL execute tool with Snowflake warehouse metrics", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-snowflake", { prompt: "Show me top 10 customers by revenue" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "sql_execute",
      callID: "c1",
      state: {
        status: "completed",
        input: {
          warehouse: "snowflake",
          query: "SELECT customer_name, SUM(amount) AS revenue FROM orders GROUP BY 1 ORDER BY 2 DESC LIMIT 10",
        },
        output: "10 rows returned",
        time: { start: 1000, end: 3500 },
      },
    })
    tracer.setSpanAttributes({
      [DE.WAREHOUSE.SYSTEM]: "snowflake",
      [DE.WAREHOUSE.BYTES_SCANNED]: 45_000_000,
      [DE.WAREHOUSE.PARTITIONS_SCANNED]: 12,
      [DE.WAREHOUSE.PARTITIONS_TOTAL]: 365,
      [DE.WAREHOUSE.PRUNING_RATIO]: 12 / 365,
      [DE.WAREHOUSE.EXECUTION_TIME_MS]: 2300,
      [DE.WAREHOUSE.COMPILATION_TIME_MS]: 200,
      [DE.WAREHOUSE.ROWS_RETURNED]: 10,
      [DE.WAREHOUSE.WAREHOUSE_SIZE]: "X-Small",
      [DE.WAREHOUSE.ESTIMATED_COST_USD]: 0.0012,
      [DE.SQL.QUERY_TEXT]: "SELECT customer_name, SUM(amount) AS revenue FROM orders GROUP BY 1 ORDER BY 2 DESC LIMIT 10",
      [DE.SQL.DIALECT]: "snowflake_sql",
      [DE.SQL.VALIDATION_VALID]: true,
      [DE.SQL.LINEAGE_INPUT_TABLES]: ["db.analytics.orders"],
      [DE.SQL.LINEAGE_TRANSFORMATION]: "AGGREGATION",
    })
    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: 0.005,
      tokens: { input: 500, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const filePath = await tracer.endTrace()

    const traceFile: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const toolSpan = traceFile.spans.find((s) => s.kind === "tool")!
    expect(toolSpan.attributes![DE.WAREHOUSE.SYSTEM]).toBe("snowflake")
    expect(toolSpan.attributes![DE.WAREHOUSE.BYTES_SCANNED]).toBe(45_000_000)
    expect(toolSpan.attributes![DE.SQL.VALIDATION_VALID]).toBe(true)
    expect(toolSpan.attributes![DE.SQL.LINEAGE_INPUT_TABLES]).toEqual(["db.analytics.orders"])
  })

  test("dbt run with model results", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-dbt-run", { prompt: "Run the staging models" })
    tracer.logStepStart({ id: "1" })

    // Tool call for dbt run
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "completed",
        input: { command: "dbt run --select staging" },
        output: "Completed successfully\n2 of 2 OK",
        time: { start: 1000, end: 15000 },
      },
    })
    tracer.setSpanAttributes({
      [DE.DBT.COMMAND]: "run",
      [DE.DBT.DAG_NODES_SELECTED]: 2,
      [DE.DBT.DAG_NODES_EXECUTED]: 2,
      [DE.DBT.DAG_NODES_SKIPPED]: 0,
    })

    // Simulate per-model attributes on session level
    tracer.setSpanAttributes({
      [DE.DBT.MODEL_MATERIALIZATION]: "incremental",
      [DE.DBT.MODEL_STATUS]: "success",
      [DE.DBT.MODEL_ROWS_AFFECTED]: 15000,
      [DE.DBT.JINJA_RENDER_SUCCESS]: true,
      [DE.COST.WAREHOUSE_COMPUTE_USD]: 0.05,
      [DE.COST.LLM_TOTAL_USD]: 0.008,
      [DE.COST.TOTAL_USD]: 0.058,
    }, "session")

    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: 0.008,
      tokens: { input: 1000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const filePath = await tracer.endTrace()

    const traceFile: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))

    // Tool span has dbt-specific attributes
    const toolSpan = traceFile.spans.find((s) => s.kind === "tool")!
    expect(toolSpan.attributes![DE.DBT.COMMAND]).toBe("run")
    expect(toolSpan.attributes![DE.DBT.DAG_NODES_EXECUTED]).toBe(2)

    // Session has cost attribution
    const sessionSpan = traceFile.spans.find((s) => s.kind === "session")!
    expect(sessionSpan.attributes![DE.COST.TOTAL_USD]).toBe(0.058)
  })

  test("failed SQL with validation error", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-sql-fail", { prompt: "Query the data" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "sql_execute",
      callID: "c1",
      state: {
        status: "error",
        input: { query: "SELCT * FROM orders" },
        error: "SQL compilation error: syntax error at 'SELCT'",
        time: { start: 1000, end: 1200 },
      },
    })
    tracer.setSpanAttributes({
      [DE.SQL.QUERY_TEXT]: "SELCT * FROM orders",
      [DE.SQL.VALIDATION_VALID]: false,
      [DE.SQL.VALIDATION_ERROR]: "syntax error at 'SELCT' — did you mean 'SELECT'?",
      [DE.WAREHOUSE.SYSTEM]: "snowflake",
    })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()

    const traceFile: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const toolSpan = traceFile.spans.find((s) => s.kind === "tool")!
    expect(toolSpan.status).toBe("error")
    expect(toolSpan.attributes![DE.SQL.VALIDATION_VALID]).toBe(false)
    expect(toolSpan.attributes![DE.SQL.VALIDATION_ERROR]).toContain("SELCT")
  })

  test("trace without any DE attributes is still valid", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-no-de", { prompt: "Just a regular coding task" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "edit",
      callID: "c1",
      state: {
        status: "completed",
        input: { file: "main.py" },
        output: "File edited",
        time: { start: 1000, end: 2000 },
      },
    })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()

    const traceFile: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    // No DE attributes — trace is still perfectly valid
    const toolSpan = traceFile.spans.find((s) => s.kind === "tool")!
    const deKeys = Object.keys(toolSpan.attributes ?? {}).filter((k) => k.startsWith("de."))
    expect(deKeys).toHaveLength(0)
    expect(traceFile.version).toBe(2)
  })

  test("mixed DE and non-DE attributes coexist", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-mixed-attrs", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "sql_execute",
      callID: "c1",
      state: {
        status: "completed",
        input: {},
        output: "ok",
        time: { start: 1000, end: 2000 },
      },
    })
    tracer.setSpanAttributes({
      [DE.WAREHOUSE.SYSTEM]: "bigquery",
      [DE.WAREHOUSE.BYTES_BILLED]: 10_000_000,
      custom_metric: 42,
      team: "data-eng",
    })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()

    const traceFile: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const attrs = traceFile.spans.find((s) => s.kind === "tool")!.attributes!
    // DE attributes
    expect(attrs[DE.WAREHOUSE.SYSTEM]).toBe("bigquery")
    // Custom attributes
    expect(attrs.custom_metric).toBe(42)
    expect(attrs.team).toBe("data-eng")
  })
})
