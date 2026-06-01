import { beforeEach, describe, expect, test } from "bun:test"
import * as Dispatcher from "../../src/altimate/native/dispatcher"
import { SqlAnalyzeTool } from "../../src/altimate/tools/sql-analyze"
import { SchemaInspectTool } from "../../src/altimate/tools/schema-inspect"
import { LineageCheckTool } from "../../src/altimate/tools/lineage-check"
import { AltimateCoreColumnLineageTool } from "../../src/altimate/tools/altimate-core-column-lineage"

const ctx = {
  sessionID: "test-session",
  messageID: "test-message",
  callID: "test-call",
  agent: "test",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => {},
}

beforeEach(() => {
  Dispatcher.reset()
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
})

describe("tool response normalization", () => {
  test("sql_analyze unwraps dispatcher data envelopes", async () => {
    Dispatcher.register("sql.analyze" as any, async () => ({
      success: true,
      data: {
        success: true,
        issues: [{ type: "lint", rule: "L001", severity: "warning", message: "Trailing whitespace", recommendation: "Trim it", confidence: "high" }],
        issue_count: 1,
        confidence: "high",
        confidence_factors: [],
      },
    }))

    const tool = await SqlAnalyzeTool.init()
    const result = await tool.execute({ sql: "SELECT 1", dialect: "snowflake" }, ctx as any)

    expect(result.metadata.success).toBe(true)
    expect(result.metadata.issueCount).toBe(1)
    expect(result.output).toContain("Trailing whitespace")
  })

  test("sql_analyze renders success=false without an error string as failure", async () => {
    Dispatcher.register("sql.analyze" as any, async () => ({
      success: false,
      data: {
        success: false,
        issues: [],
        issue_count: 0,
        confidence: "unknown",
        confidence_factors: [],
      },
    }))

    const tool = await SqlAnalyzeTool.init()
    const result = await tool.execute({ sql: "SELECT 1", dialect: "snowflake" }, ctx as any)

    expect(result.title).toContain("ERROR")
    expect(result.metadata.success).toBe(false)
    expect(result.metadata.error).toBe("Analysis failed.")
    expect(result.output).toContain("Analysis failed.")
  })

  test("sql_analyze ignores blank error strings on successful analysis", async () => {
    Dispatcher.register("sql.analyze" as any, async () => ({
      success: true,
      data: {
        success: true,
        error: "   ",
        issues: [],
        issue_count: 0,
        confidence: "high",
        confidence_factors: [],
      },
    }))

    const tool = await SqlAnalyzeTool.init()
    const result = await tool.execute({ sql: "SELECT 1", dialect: "snowflake" }, ctx as any)

    expect(result.metadata.success).toBe(true)
    expect(result.metadata.error).toBeUndefined()
    expect(result.output).toContain("No anti-patterns or issues detected.")
  })

  test("sql_analyze extracts object error messages", async () => {
    Dispatcher.register("sql.analyze" as any, async () => ({
      success: false,
      data: {
        success: false,
        error: { message: "parser exploded" },
        issues: [],
        issue_count: 0,
        confidence: "unknown",
        confidence_factors: [],
      },
    }))

    const tool = await SqlAnalyzeTool.init()
    const result = await tool.execute({ sql: "SELECT 1", dialect: "snowflake" }, ctx as any)

    expect(result.metadata.success).toBe(false)
    expect(result.metadata.error).toBe("parser exploded")
    expect(result.output).toContain("parser exploded")
  })

  test("sql_analyze does not stringify object errors without messages", async () => {
    Dispatcher.register("sql.analyze" as any, async () => ({
      success: false,
      data: {
        success: false,
        error: { token: "secret-token", connection: { password: "secret-password" } },
        issues: [],
        issue_count: 0,
        confidence: "unknown",
        confidence_factors: [],
      },
    }))

    const tool = await SqlAnalyzeTool.init()
    const result = await tool.execute({ sql: "SELECT 1", dialect: "snowflake" }, ctx as any)

    expect(result.metadata.success).toBe(false)
    expect(result.metadata.error).toBe("Error details unavailable.")
    expect(result.output).not.toContain("secret-token")
    expect(result.output).not.toContain("secret-password")
  })

  test("schema_inspect unwraps dispatcher data envelopes", async () => {
    Dispatcher.register("schema.inspect" as any, async () => ({
      success: true,
      data: {
        table: "orders",
        schema_name: "analytics",
        columns: [{ name: "id", data_type: "INT", nullable: false, primary_key: true }],
        row_count: 7,
      },
    }))

    const tool = await SchemaInspectTool.init()
    const result = await tool.execute({ table: "orders" }, ctx as any)

    expect(result.metadata.success).toBe(true)
    expect(result.metadata.columnCount).toBe(1)
    expect(result.output).toContain("analytics.orders")
  })

  test("lineage_check keeps dispatcher error responses in metadata.error", async () => {
    Dispatcher.register("lineage.check" as any, async () => ({
      success: false,
      error: "ECONNREFUSED 127.0.0.1:5432",
      data: {},
    }))

    const tool = await LineageCheckTool.init()
    const result = await tool.execute({ sql: "SELECT 1", dialect: "snowflake" }, ctx as any)

    expect(result.metadata.success).toBe(false)
    expect(result.metadata.error).toContain("ECONNREFUSED")
  })

  test("altimate_core_column_lineage unwraps data envelopes and errors cleanly", async () => {
    Dispatcher.register("altimate_core.column_lineage" as any, async () => ({
      success: true,
      data: {
        column_dict: { id: ["orders.id"] },
        column_lineage: [{ source: "orders.id", target: "id", lens_type: "passthrough" }],
      },
    }))

    const tool = await AltimateCoreColumnLineageTool.init()
    const result = await tool.execute({ sql: "SELECT id FROM orders", dialect: "snowflake" }, ctx as any)

    expect(result.metadata.success).toBe(true)
    expect(result.metadata.edge_count).toBe(1)
    expect(result.output).toContain("orders.id")
  })

  test("altimate_core_column_lineage treats inner data.success=false as failure", async () => {
    Dispatcher.register("altimate_core.column_lineage" as any, async () => ({
      success: true,
      data: { success: false, column_lineage: [] },
    }))

    const tool = await AltimateCoreColumnLineageTool.init()
    const result = await tool.execute({ sql: "SELECT 1", dialect: "snowflake" }, ctx as any)

    expect(result.title).toContain("ERROR")
    expect(result.metadata.success).toBe(false)
  })

  test("altimate_core_column_lineage does not leak object data.error in output", async () => {
    Dispatcher.register("altimate_core.column_lineage" as any, async () => ({
      success: true,
      data: { error: { token: "secret-token" }, column_lineage: [{ source: "a", target: "b" }] },
    }))

    const tool = await AltimateCoreColumnLineageTool.init()
    const result = await tool.execute({ sql: "SELECT 1", dialect: "snowflake" }, ctx as any)

    expect(result.metadata.success).toBe(false)
    expect(result.output).not.toContain("secret-token")
    expect(result.output).not.toContain("[object Object]")
  })

  test("lineage_check treats inner data.success=false as PARTIAL", async () => {
    Dispatcher.register("lineage.check" as any, async () => ({
      success: true,
      data: { success: false },
    }))

    const tool = await LineageCheckTool.init()
    const result = await tool.execute({ sql: "SELECT 1", dialect: "snowflake" }, ctx as any)

    expect(result.title).toContain("PARTIAL")
    expect(result.metadata.success).toBe(false)
  })
})
