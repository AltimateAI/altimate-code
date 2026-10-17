// altimate_change start — warehouse inventory discovery regressions
import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Connector } from "@altimateai/drivers"
import { initTool } from "../tool-fixture"
import { SchemaInspectTool } from "../../../src/altimate/tools/schema-inspect"
import * as Registry from "../../../src/altimate/native/connections/registry"
import { registerAll } from "../../../src/altimate/native/connections/register"
import * as Precedence from "../../../src/altimate/workspace/precedence"

const ctx = {
  sessionID: "schema-list-test", messageID: "message", callID: "call", agent: "test",
  abort: new AbortController().signal, messages: [], metadata: () => {}, extra: { mcpClient: true, forceReadOnly: true },
}
let restore: (() => void) | undefined
let directory: string | undefined

afterEach(async () => {
  restore?.()
  restore = undefined
  await Registry.closeAll()
  Registry.reset()
  Precedence.releaseLocalSession(ctx.sessionID)
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

async function inspect(args: Record<string, unknown> = {}, ask = async (_input: unknown) => {}) {
  Precedence.bindLocalSession(ctx.sessionID)
  const tool = await initTool(SchemaInspectTool)
  return tool.execute(args, { ...ctx, ask })
}

for (const type of ["sqlite", "duckdb"] as const) {
  test(`${type}: real local tables list with counts; blank table and schema mean absent`, async () => {
    registerAll()
    directory = await mkdtemp(path.join(os.tmpdir(), "schema-list-"))
    Registry.setConfigs({ local: { type, path: path.join(directory, `source.${type}`), create: true } })
    const connector = await Registry.get("local")
    await connector.execute('CREATE TABLE "odd""name" (id INTEGER)')
    await connector.execute('INSERT INTO "odd""name" VALUES (1), (2)')
    await connector.execute('CREATE TABLE empty (id INTEGER)')
    await connector.execute('CREATE VIEW sample AS SELECT * FROM "odd""name"')
    const result = await inspect({ warehouse: "local" })
    expect(result.metadata.success).toBe(true)
    expect(result.output).toContain('main | odd"name | table | 2')
    expect(result.output).toContain("main | empty | table | 0")
    expect(result.output).toContain("main | sample | view | \n")
    expect(result.output).toContain('schema_inspect(warehouse="local", schema_name="<schema>", table="<name>")')
    expect(await inspect({ warehouse: "local", table: "", schema_name: "" })).toEqual(result)
    expect(await inspect({ warehouse: "local", table: "   " })).toEqual(result)
    if (type === "duckdb") {
      await connector.execute("CREATE SCHEMA analytics")
      await connector.execute("CREATE TABLE analytics.other (id INTEGER)")
      expect((await inspect({ warehouse: "local" })).output).toContain("analytics | other | table | 0")
      const filtered = await inspect({ warehouse: "local", schema_name: "analytics" })
      expect(filtered.output).toContain("analytics | other | table | 0")
      expect(filtered.output).not.toContain("main |")
    }
    const single = await inspect({ warehouse: "local", table: "empty", values: false })
    expect(single).toEqual({
      title: "Schema: empty", metadata: { success: true, columnCount: 1, rowCount: undefined, truncated: false },
      output: "Table: main.empty\n\nColumn | Type | Nullable | PK\n-------|------|----------|---\nid | INTEGER | YES | ",
    })
  })
}

function fake(type: string, count = 1, store?: string) {
  registerAll()
  Registry.setConfigs({ remote: { type, ...(store ? { path: store } : {}) } })
  const connector = {
    listSchemas: mock(async () => ["one", "two"]),
    listTables: mock(async (_schema: string) => Array.from({ length: count }, (_, i) => ({ name: `t${i}`, type: type === "mongodb" ? "collection" : "table" }))),
    execute: mock(async () => ({ rows: [[3]], columns: ["count"], row_count: 1, truncated: false })),
  }
  const get = spyOn(Registry, "get").mockResolvedValue(connector as unknown as Connector)
  restore = () => get.mockRestore()
  return connector
}

test.each(["postgres", "snowflake", "mongodb", "trino"])("%s inventory never scans tables for counts", async (type) => {
  const connector = fake(type)
  const result = await inspect({ warehouse: "remote" })
  expect(result.metadata.success).toBe(true)
  expect(result.metadata.tableCount).toBe(2)
  expect(result.output).toContain(`one | t0 | ${type === "mongodb" ? "collection" : "table"} | \n`)
  expect(connector.execute).not.toHaveBeenCalled()
  expect(connector.listTables.mock.calls).toEqual([["one"], ["two"]])
  const filtered = await inspect({ warehouse: "remote", schema_name: "two" })
  expect(filtered.metadata.tableCount).toBe(1)
  expect(filtered.output).not.toContain("one |")
})

test("remote DuckDB stores do not receive COUNT queries", async () => {
  const connector = fake("duckdb", 1, "md:remote")
  expect((await inspect({ warehouse: "remote" })).metadata.success).toBe(true)
  expect(connector.execute).not.toHaveBeenCalled()
})

test("listing caps output at 500 and notes truncation only when more tables exist", async () => {
  const connector = fake("postgres", 501)
  const result = await inspect({ warehouse: "remote", schema_name: "one" })
  expect(result.metadata).toMatchObject({ tableCount: 500, truncated: true })
  expect(result.output).toContain("List truncated at 500 entries")
  expect(result.output).not.toContain(" | t500 |")
  connector.listTables.mockResolvedValueOnce(Array.from({ length: 500 }, (_, i) => ({ name: `t${i}`, type: "table" })))
  expect((await inspect({ warehouse: "remote", schema_name: "one" })).metadata.truncated).toBe(false)
})

test("denied schema permission stops inventory access", async () => {
  const connector = fake("postgres")
  const result = await inspect({ warehouse: "remote" }, async () => { throw new Error("permission denied") })
  expect(result.metadata.success).toBe(false)
  expect(result.output).toContain("permission denied")
  expect(connector.listSchemas).not.toHaveBeenCalled()
})

test("local count probes are protected and failures omit only the count", async () => {
  const connector = fake("sqlite", 1, ":memory:")
  connector.execute.mockRejectedValue(new Error("count unavailable"))
  const result = await inspect({ warehouse: "remote", schema_name: "one" })
  expect(result.metadata.success).toBe(true)
  expect(result.output).toContain("one | t0 | table | ")
  expect(connector.execute.mock.calls[0]).toMatchObject([
    'SELECT COUNT(*) FROM "one"."t0"', 1, undefined, { readOnly: true, queryTimeoutMs: 1000 },
  ])
})

test("empty inventory gives next-step instructions", async () => {
  fake("postgres", 0)
  const result = await inspect({})
  expect(result.metadata.success).toBe(true)
  expect(result.output).toContain("No tables or collections found.")
})
// altimate_change end
