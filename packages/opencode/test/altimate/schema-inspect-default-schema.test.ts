import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Dispatcher } from "../../src/altimate/native"
import * as Registry from "../../src/altimate/native/connections/registry"

// `schema.inspect` defaulted the schema to "public", which is Postgres's default but not
// DuckDB's or SQLite's ("main"): every DuckDB inspection without an explicit schema came
// back empty (one benchmark run read that as "table not found" while the table was queryable).
let previousTelemetry: string | undefined

beforeAll(async () => {
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
})

afterAll(() => {
  Registry.reset()
  if (previousTelemetry === undefined) delete process.env.ALTIMATE_TELEMETRY_DISABLED
  else process.env.ALTIMATE_TELEMETRY_DISABLED = previousTelemetry
})

describe("schema.inspect without a schema name", () => {
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
})
