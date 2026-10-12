// altimate_change start — schema inspection warehouse aliases
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { initTool } from "../tool-fixture"
import * as Registry from "../../../src/altimate/native/connections/registry"
import { registerAll } from "../../../src/altimate/native/connections/register"
import { closeScratch } from "../../../src/altimate/native/connections/scratch"
import { SchemaInspectTool } from "../../../src/altimate/tools/schema-inspect"
import { materialize } from "../../../src/altimate/tools/sql-materialize"

const ctx = {
  sessionID: "schema-warehouse-test",
  messageID: "test-message",
  callID: "test-call",
  agent: "test",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => {},
}
let previousTelemetry: string | undefined

beforeAll(() => {
  previousTelemetry = process.env.ALTIMATE_TELEMETRY_DISABLED
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
})

beforeEach(async () => {
  registerAll()
  Registry.setConfigs({
    primary: { type: "duckdb", path: ":memory:" },
    reporting: { type: "duckdb", path: ":memory:" },
  })
  const primary = await Registry.get("primary")
  await primary.execute("CREATE TABLE t (local_id INTEGER)")
  await primary.execute("INSERT INTO t VALUES (99)")
  await materialize({
    source_warehouse: "primary",
    sql: "SELECT 7 AS id, 'scratch value' AS label",
    target_table: "t",
  })
})

afterEach(async () => {
  await Registry.closeAll()
  await closeScratch()
  Registry.reset()
})

afterAll(() => {
  if (previousTelemetry === undefined) delete process.env.ALTIMATE_TELEMETRY_DISABLED
  else process.env.ALTIMATE_TELEMETRY_DISABLED = previousTelemetry
})

async function inspect(args: Record<string, unknown>) {
  const tool = await initTool(SchemaInspectTool)
  return tool.execute({ values: false, ...args }, ctx)
}

describe("schema_inspect warehouse qualifiers", () => {
  test("resolves a warehouse supplied as schema_name after materialization", async () => {
    const result = await inspect({ schema_name: "scratch", table: "t" })
    expect(result.metadata.success).toBe(true)
    expect(result.output).toContain('Resolved "scratch" as the scratch warehouse (schema main)')
    expect(result.output).toContain("Table: main.t")
    expect(result.output).toContain("id | BIGINT")
    expect(result.output).not.toContain("local_id")
  })

  test("resolves a leading warehouse qualifier and profiles the resolved table", async () => {
    const result = await inspect({ table: "scratch.t", values: true })
    expect(result.metadata.success).toBe(true)
    expect(result.output).toContain('Resolved "scratch" as the scratch warehouse (schema main)')
    expect(result.output).toContain("label: 1 distinct — scratch value")
  })

  test("preserves the table parameter and explicit scratch warehouse", async () => {
    const result = await inspect({ warehouse: "scratch", schema_name: "main", table: "t" })
    expect(result.metadata.success).toBe(true)
    expect(result.output).toContain("id | BIGINT")
    expect(result.output).not.toContain("Resolved")
  })

  test("an explicit warehouse wins over a warehouse-shaped schema name", async () => {
    const result = await inspect({ warehouse: "primary", schema_name: "scratch", table: "t" })
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain('in schema "scratch" on warehouse "primary"')
    expect(result.output).not.toContain("Resolved")
  })

  test("an explicit warehouse wins over a leading warehouse qualifier", async () => {
    const result = await inspect({ warehouse: "primary", table: "scratch.t" })
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain('Table "scratch.t" was not found')
    expect(result.output).toContain('warehouse "primary"')
    expect(result.output).not.toContain("Resolved")
  })

  test("uses the same exact rule for another configured warehouse", async () => {
    const reporting = await Registry.get("reporting")
    await reporting.execute("CREATE TABLE t (report_id VARCHAR)")
    const result = await inspect({ table: "reporting.t" })
    expect(result.metadata.success).toBe(true)
    expect(result.output).toContain('Resolved "reporting" as the reporting warehouse (schema main)')
    expect(result.output).toContain("report_id")
  })

  test("keeps an existing schema ahead of an equally named warehouse", async () => {
    const primary = await Registry.get("primary")
    await primary.execute("CREATE SCHEMA scratch")
    await primary.execute("CREATE TABLE scratch.t (schema_id VARCHAR)")
    const result = await inspect({ schema_name: "scratch", table: "t" })
    expect(result.metadata.success).toBe(true)
    expect(result.output).toContain("schema_id")
    expect(result.output).not.toContain("Resolved")
  })

  test("does not fall back when an existing schema lacks the requested table", async () => {
    const primary = await Registry.get("primary")
    await primary.execute("CREATE SCHEMA scratch")
    const result = await inspect({ schema_name: "scratch", table: "t" })
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain("warehouse=scratch, schema_name=main")
  })

  test("a genuinely missing table lists warehouses and explicit addressing", async () => {
    const result = await inspect({ schema_name: "scratch", table: "missing" })
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain('Table "missing" was not found')
    expect(result.output).toContain("Available warehouses: primary, reporting, scratch")
    expect(result.output).toContain("warehouse=scratch, schema_name=main")
  })

  test("does not guess an unknown qualifier from a table in the default schema", async () => {
    const result = await inspect({ schema_name: "not_a_warehouse", table: "t" })
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain("warehouse=primary, schema_name=main")
  })

  test("does not probe other schemas after resolving a warehouse qualifier", async () => {
    const reporting = await Registry.get("reporting")
    await reporting.execute("CREATE SCHEMA analytics")
    await reporting.execute("CREATE TABLE analytics.t (id INTEGER)")
    const result = await inspect({ schema_name: "reporting", table: "t" })
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain("warehouse=reporting, schema_name=main")
  })

  test("requires table and does not expose a table_name alias", async () => {
    const tool = await initTool(SchemaInspectTool)
    expect(tool.jsonSchema?.required).toContain("table")
    expect(tool.jsonSchema?.properties).not.toHaveProperty("table_name")
    await expect(inspect({ table_name: "t" })).rejects.toThrow("table")
  })
})
// altimate_change end
