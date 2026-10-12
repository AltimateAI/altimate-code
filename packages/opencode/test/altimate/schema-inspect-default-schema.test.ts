import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test"
import type { Connector } from "@altimateai/drivers"
import { Dispatcher } from "../../src/altimate/native"
import * as Registry from "../../src/altimate/native/connections/registry"
import { registerAll } from "../../src/altimate/native/connections/register"
import { SchemaInspectTool } from "../../src/altimate/tools/schema-inspect"
import { initTool } from "./tool-fixture"

// `schema.inspect` defaulted the schema to "public", which is Postgres's default but not
// DuckDB's or SQLite's ("main"): every DuckDB inspection without an explicit schema came
// back empty (one benchmark run read that as "table not found" while the table was queryable).
let previousTelemetry: string | undefined
let connectorSpy: { mockRestore(): void } | undefined

function fakeConnector(schemas: string[], tables: string[]) {
  const connector = {
    listSchemas: mock(async () => schemas),
    describeTable: mock(async (schema: string, _table: string) =>
      tables.includes(schema) ? [{ name: "id", data_type: "VARCHAR", nullable: true }] : [],
    ),
  }
  connectorSpy = spyOn(Registry, "get").mockResolvedValue(connector as unknown as Connector)
  return connector
}

beforeAll(async () => {
  registerAll()
  previousTelemetry = process.env.ALTIMATE_TELEMETRY_DISABLED
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
  Registry.setConfigs({
    duck: { type: "duckdb", path: ":memory:" } as never,
    lite: { type: "sqlite", path: ":memory:" } as never,
  })
  for (const warehouse of ["duck", "lite"]) {
    const c = await Registry.get(warehouse)
    await c.execute("CREATE TABLE contents (id VARCHAR, content VARCHAR)")
  }
  const duck = await Registry.get("duck")
  await duck.execute("CREATE SCHEMA analytics")
  await duck.execute("CREATE TABLE analytics.profiled (label VARCHAR)")
  await duck.execute("INSERT INTO analytics.profiled VALUES ('resolved schema')")
})

afterEach(() => {
  connectorSpy?.mockRestore()
  connectorSpy = undefined
})

afterAll(async () => {
  await Registry.closeAll()
  Registry.reset()
  if (previousTelemetry === undefined) delete process.env.ALTIMATE_TELEMETRY_DISABLED
  else process.env.ALTIMATE_TELEMETRY_DISABLED = previousTelemetry
})

describe("schema.inspect without a schema name", () => {
  test("uses the default connection's engine when warehouse is omitted", async () => {
    const connector = fakeConnector(["public", "main"], ["public", "main"])
    const r: any = await Dispatcher.call("schema.inspect", { table: "contents" })
    expect(r.error).toBeUndefined()
    expect(r.schema_name).toBe("main")
    expect(connector.describeTable.mock.calls).toEqual([["main", "contents"]])
    expect(connector.listSchemas).not.toHaveBeenCalled()
  })

  test("finds a DuckDB table in its default schema", async () => {
    const r: any = await Dispatcher.call("schema.inspect", { table: "contents", warehouse: "duck" })
    expect(r.error).toBeUndefined()
    expect(r.schema_name).toBe("main")
    expect(r.columns.map((c: any) => c.name)).toEqual(["id", "content"])
  })

  test("finds a SQLite table", async () => {
    const r: any = await Dispatcher.call("schema.inspect", { table: "contents", warehouse: "lite" })
    expect(r.error).toBeUndefined()
    expect(r.columns.map((c: any) => c.name)).toEqual(["id", "content"])
  })

  test("an explicit schema is used as given", async () => {
    const r: any = await Dispatcher.call("schema.inspect", { table: "contents", warehouse: "duck", schema_name: "nope" })
    expect(r.schema_name).toBe("nope")
    expect(r.columns).toEqual([])
  })

  test("prefers main without listing schemas when another schema has the same table", async () => {
    const connector = fakeConnector(["analytics", "main"], ["analytics", "main"])
    const r: any = await Dispatcher.call("schema.inspect", { table: "contents", warehouse: "duck" })
    expect(r.schema_name).toBe("main")
    expect(connector.describeTable.mock.calls).toEqual([["main", "contents"]])
    expect(connector.listSchemas).not.toHaveBeenCalled()
  })

  test("caps all table probes at 20 when many fallback schemas exist", async () => {
    const schemas = Array.from({ length: 100 }, (_, i) => `schema_${i}`)
    const connector = fakeConnector(schemas, ["schema_19"])
    const r: any = await Dispatcher.call("schema.inspect", { table: "contents", warehouse: "duck" })
    expect(r.columns).toEqual([])
    expect(connector.listSchemas).toHaveBeenCalledTimes(1)
    expect(connector.describeTable.mock.calls).toEqual(
      ["main", ...schemas.slice(0, 19)].map((schema) => [schema, "contents"]),
    )
  })

  test("skips system schemas and stops probing at the first fallback hit", async () => {
    const system = ["information_schema", "pg_catalog", "pg_toast", "sys", "INFORMATION_SCHEMA"]
    const connector = fakeConnector(
      [...system, "main", "empty", "analytics", "later"],
      [...system, "analytics", "later"],
    )
    const r: any = await Dispatcher.call("schema.inspect", { table: "contents", warehouse: "duck" })
    expect(r.schema_name).toBe("analytics")
    expect(connector.describeTable.mock.calls).toEqual([
      ["main", "contents"],
      ["empty", "contents"],
      ["analytics", "contents"],
    ])
  })

  test("uses an explicit system schema without probing other schemas", async () => {
    const connector = fakeConnector(["main"], ["information_schema"])
    const r: any = await Dispatcher.call("schema.inspect", {
      table: "contents", warehouse: "duck", schema_name: "information_schema",
    })
    expect(r.schema_name).toBe("information_schema")
    expect(connector.describeTable.mock.calls).toEqual([["information_schema", "contents"]])
    expect(connector.listSchemas).not.toHaveBeenCalled()
  })

  test("profiles values from the schema resolved by the handler", async () => {
    const connector = await Registry.get("duck")
    const execute = spyOn(connector, "execute")
    try {
      const tool = await initTool(SchemaInspectTool)
      const result = await tool.execute({ table: "profiled", warehouse: "duck" }, {
        sessionID: "schema-default-test",
        messageID: "test-message",
        callID: "test-call",
        agent: "test",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => {},
      })
      expect(result.metadata.success).toBe(true)
      expect(result.output).toContain("analytics.profiled")
      expect(result.output).toContain("label: 1 distinct — resolved schema")
      expect(execute.mock.calls.some(([sql]) => sql.includes('FROM "analytics"."profiled"'))).toBe(true)
    } finally {
      execute.mockRestore()
    }
  })
})
