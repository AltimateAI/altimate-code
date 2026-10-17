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
  sessionID: "schema-list-test",
  messageID: "message",
  callID: "call",
  agent: "test",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => {},
  extra: { mcpClient: true, forceReadOnly: true },
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
    await connector.execute("CREATE TABLE empty (id INTEGER)")
    await connector.execute('CREATE VIEW sample AS SELECT * FROM "odd""name"')
    const overview = await inspect({ warehouse: "local" })
    expect(overview.output).toContain("main | 3")
    expect(overview.output).not.toContain('odd"name')
    const result = await inspect({ warehouse: "local", schema_name: "main" })
    expect(result.metadata.success).toBe(true)
    expect(result.output).toContain('main | odd"name | table | 2')
    expect(result.output).toContain("main | empty | table | 0")
    expect(result.output).toContain("main | sample | view | not counted\n")
    expect(result.output).toContain('schema_inspect(warehouse="local", schema_name="<schema>", table="<name>")')
    expect(await inspect({ warehouse: "local", table: "", schema_name: "" })).toEqual(overview)
    expect(await inspect({ warehouse: "local", table: "   " })).toEqual(overview)
    if (type === "duckdb") {
      await connector.execute("CREATE SCHEMA analytics")
      await connector.execute("CREATE TABLE analytics.other (id INTEGER)")
      expect((await inspect({ warehouse: "local" })).output).toContain("analytics | 1")
      const filtered = await inspect({ warehouse: "local", schema_name: "analytics" })
      expect(filtered.output).toContain("analytics | other | table | 0")
      expect(filtered.output).not.toContain("main |")
    }
    const single = await inspect({ warehouse: "local", table: "empty", values: false })
    expect(single).toEqual({
      title: "Schema: empty",
      metadata: { success: true, columnCount: 1, rowCount: undefined, truncated: false },
      output:
        "Table: main.empty\n\nColumn | Type | Nullable | PK\n-------|------|----------|---\nid | INTEGER | YES | ",
    })
  })
}

function fake(type: string, count = 1, store?: string) {
  registerAll()
  Registry.setConfigs({ remote: { type, ...(store ? { path: store } : {}) } })
  const connector = {
    listSchemas: mock(async () => ["one", "two"]),
    listTables: mock(async (_schema: string) =>
      Array.from({ length: count }, (_, i) => ({ name: `t${i}`, type: "table" })),
    ),
    execute: mock(async (sql: string, limit?: number, _binds?: unknown[], _options?: unknown) => {
      let rows: unknown[][]
      if (sql.includes("GROUP BY") || sql.includes("SELECT 'main'"))
        rows = [
          ["one", count],
          ["two", count],
        ]
      else if (sql.includes("dbStats")) rows = [[count]]
      else if (/^SELECT COUNT/.test(sql)) rows = [[3]]
      else
        rows = Array.from({ length: Math.min(count, limit ?? 501) }, (_, i) => [
          `t${String(i).padStart(7, "0")}`,
          type === "mongodb" ? "collection" : "BASE TABLE",
        ])
      return { rows, columns: [], row_count: rows.length, truncated: type === "mongodb" && count > (limit ?? 501) }
    }),
  }
  const get = spyOn(Registry, "get").mockResolvedValue(connector as unknown as Connector)
  restore = () => get.mockRestore()
  return connector
}

test.each(["postgres", "mysql", "snowflake", "duckdb", "redshift", "bigquery"])(
  "%s uses one bounded aggregate, then an ordered bounded table catalog",
  async (type) => {
    const connector = fake(type, 2_000_000, type === "duckdb" ? "md:remote" : undefined)
    const result = await inspect({ warehouse: "remote" })
    expect(result.metadata).toMatchObject({ success: true, schemaCount: 2 })
    expect(result.output).toContain("one | 2000000")
    expect(result.output).not.toContain("t0000000")
    expect(connector.execute).toHaveBeenCalledTimes(1)
    expect(connector.execute.mock.calls[0][0]).toMatch(/GROUP BY.*ORDER BY.*LIMIT 201/)
    expect(connector.execute.mock.calls[0][3]).toMatchObject({ readOnly: true, signal: expect.any(AbortSignal) })
    const start = performance.now()
    const filtered = await inspect({ warehouse: "remote", schema_name: "two" })
    expect(performance.now() - start).toBeLessThan(2000)
    expect(filtered.metadata).toMatchObject({ tableCount: 500, truncated: true })
    expect(filtered.output).toContain("Showing first 500 of ≥501")
    expect(connector.execute.mock.calls[1]).toMatchObject([
      expect.stringMatching(/ORDER BY t.table_name LIMIT 501$/),
      501,
      ["two"],
      { readOnly: true },
    ])
    // The fake models a two-million-table catalog but allocates only the requested 501 rows.
    expect(
      ((await connector.execute.mock.results[1].value) as Awaited<ReturnType<typeof connector.execute>>).rows,
    ).toHaveLength(501)
    expect(connector.listTables).not.toHaveBeenCalled()
    expect(connector.listSchemas).not.toHaveBeenCalled()
    expect(connector.execute.mock.calls.some(([sql]) => /^SELECT COUNT/.test(sql))).toBe(false)
  },
)

test("fallback lists schemas without tables and warns when listing tables", async () => {
  const connector = fake("trino")
  expect((await inspect({ warehouse: "remote" })).output).toContain("one | unavailable")
  expect(connector.listTables).not.toHaveBeenCalled()
  const result = await inspect({ warehouse: "remote", schema_name: "two" })
  expect(result.output).toContain("Driver fallback: table list may be truncated")
  expect(connector.execute).not.toHaveBeenCalled()
  expect(connector.listTables.mock.calls).toEqual([["two"]])
})

test("MongoDB database counts use scalar metadata and collections use a bounded command", async () => {
  const connector = fake("mongodb", 2_000_000)
  const overview = await inspect({ warehouse: "remote" })
  expect(overview.output).toContain("one | 2000000")
  expect(connector.listTables).not.toHaveBeenCalled()
  const result = await inspect({ warehouse: "remote", schema_name: "two" })
  expect(result.metadata).toMatchObject({ tableCount: 500, truncated: true })
  expect(connector.execute.mock.calls[2]).toMatchObject([
    JSON.stringify({ command: "listCollections", database: "two" }),
    500,
    undefined,
    { readOnly: true },
  ])
})

test("schema output caps at 200 using one aggregate", async () => {
  const connector = fake("postgres")
  connector.execute.mockResolvedValueOnce({
    rows: Array.from({ length: 201 }, (_, i) => [`s${i}`, 2_000_000]),
    columns: [],
    row_count: 201,
    truncated: false,
  })
  const result = await inspect({ warehouse: "remote" })
  expect(result.metadata).toMatchObject({ schemaCount: 200, truncated: true })
  expect(result.output).toContain("Showing first 200 schemas of ≥201")
  expect(connector.execute).toHaveBeenCalledTimes(1)
})

test("exactly 500 tables is not truncated", async () => {
  fake("postgres", 500)
  expect((await inspect({ warehouse: "remote", schema_name: "one" })).metadata.truncated).toBe(false)
})

test("denied schema permission stops inventory access", async () => {
  const connector = fake("postgres")
  const result = await inspect({ warehouse: "remote" }, async () => {
    throw new Error("permission denied")
  })
  expect(result.metadata.success).toBe(false)
  expect(connector.execute).not.toHaveBeenCalled()
  expect(connector.listSchemas).not.toHaveBeenCalled()
})

test("catalog failure never falls back to an unbounded list", async () => {
  const connector = fake("postgres")
  connector.execute.mockRejectedValue(new Error("catalog denied"))
  expect((await inspect({ warehouse: "remote", schema_name: "one" })).metadata.success).toBe(false)
  expect(connector.listTables).not.toHaveBeenCalled()
})

test("local counts stop at 50 and mark the rest", async () => {
  const connector = fake("sqlite", 100, ":memory:")
  const result = await inspect({ warehouse: "remote", schema_name: "one" })
  expect(result.metadata.success).toBe(true)
  expect(connector.execute.mock.calls.filter(([sql]) => /^SELECT COUNT/.test(sql))).toHaveLength(50)
  expect(result.output.match(/not counted/g)).toHaveLength(50)
  expect(connector.execute.mock.calls[1]).toMatchObject([
    'SELECT COUNT(*) FROM "one"."t0000000"',
    1,
    undefined,
    { readOnly: true, queryTimeoutMs: 1000 },
  ])
})

test("slow local counts share a three second budget, including non-cooperative probes", async () => {
  const connector = fake("sqlite", 500, ":memory:")
  const execute = connector.execute.getMockImplementation()!
  connector.execute.mockImplementation((sql, ...args) =>
    /^SELECT COUNT/.test(sql) ? new Promise(() => {}) : execute(sql, ...args),
  )
  const start = performance.now()
  const result = await inspect({ warehouse: "remote", schema_name: "one" })
  expect(performance.now() - start).toBeLessThan(4000)
  expect(result.metadata.success).toBe(true)
  expect(result.output.match(/not counted/g)).toHaveLength(500)
  expect(connector.execute.mock.calls.filter(([sql]) => /^SELECT COUNT/.test(sql)).length).toBeLessThanOrEqual(4)
})

test("remote catalog statistics are displayed as estimates without table scans", async () => {
  const connector = fake("postgres")
  connector.execute.mockResolvedValueOnce({
    rows: [["orders", "BASE TABLE", 2000000]],
    columns: [],
    row_count: 1,
    truncated: false,
  })
  const result = await inspect({ warehouse: "remote", schema_name: "one" })
  expect(result.output).toContain("orders | table | 2000000 (estimate)")
  expect(connector.execute).toHaveBeenCalledTimes(1)
})

test("empty inventory gives next-step instructions", async () => {
  const connector = fake("postgres", 0)
  connector.execute.mockResolvedValueOnce({ rows: [], columns: [], row_count: 0, truncated: false })
  const result = await inspect({})
  expect(result.metadata.success).toBe(true)
  expect(result.output).toContain("No schemas found.")
  expect(result.output).toContain("schema_name=")
})
// altimate_change end
