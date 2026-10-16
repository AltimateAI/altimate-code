// altimate_change start — schema inspection warehouse alias boundaries
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { ConnectionConfig, Connector } from "@altimateai/drivers"
import * as Dispatcher from "../../../src/altimate/native/dispatcher"
import * as Registry from "../../../src/altimate/native/connections/registry"
import { registerAll } from "../../../src/altimate/native/connections/register"

let connectorSpy: { mockRestore(): void } | undefined

beforeEach(() => registerAll())
afterEach(() => {
  connectorSpy?.mockRestore()
  Registry.reset()
})

function configure(config: ConnectionConfig, schema?: string) {
  Registry.setConfigs({ primary: { type: "duckdb", path: ":memory:" }, remote: config })
  const source = { listSchemas: mock(async () => ["main"]) }
  const target = {
    describeTable: mock(async (name: string, _table: string) =>
      name === schema ? [{ name: "id", data_type: "INTEGER", nullable: false }] : [],
    ),
  }
  connectorSpy = spyOn(Registry, "get").mockImplementation(
    async (name) => (name === "primary" ? source : target) as unknown as Connector,
  )
  return target
}

describe("schema.inspect warehouse default schemas", () => {
  test.each([
    [{ type: "bigquery", dataset: "analytics" }, "analytics"],
    [{ type: "mysql", database: "inventory" }, "inventory"],
    [{ type: "mariadb", database: "inventory" }, "inventory"],
    [{ type: "snowflake", schema: "PUBLIC" }, "PUBLIC"],
    [{ type: "sqlserver", schema: "dbo" }, "dbo"],
    [{ type: "databricks", schema: "bronze" }, "bronze"],
  ] as [ConnectionConfig, string][])("uses the configured default for %j", async (config, schema) => {
    const target = configure(config, schema)
    const result = await Dispatcher.call("schema.inspect", { table: "t", schema_name: "remote" })
    expect(result.columns).toHaveLength(1)
    expect(result.schema_name).toBe(schema)
    expect(result.resolution).toBe(`Resolved "remote" as the remote warehouse (schema ${schema})`)
    expect(target.describeTable.mock.calls).toEqual([[schema, "t"]])
  })

  test.each(["bigquery", "mysql", "snowflake", "sqlserver", "trino"])(
    "requires an explicit schema when the %s default is unknown",
    async (type) => {
      const target = configure({ type })
      const result = await Dispatcher.call("schema.inspect", { table: "t", schema_name: "remote" })
      expect(result.columns).toEqual([])
      expect((result as any).error).toContain('Default schema for warehouse "remote" is not configured')
      expect((result as any).error).not.toContain("Available warehouses:")
      expect(target.describeTable).not.toHaveBeenCalled()
    },
  )

  test("missing-table hints use each warehouse's configured addressing", async () => {
    configure({ type: "bigquery", dataset: "analytics" }, "absent")
    const result = await Dispatcher.call("schema.inspect", { table: "missing", schema_name: "remote" })
    expect(result.columns).toEqual([])
    expect(result.addressing_hint).toContain("Available warehouses: primary, remote, scratch")
    expect(result.addressing_hint).toContain("warehouse=remote, schema_name=analytics")
  })

  test.each([
    ["analytics.t", undefined],
    ["analytics.t", "different"],
    ["remote.t", "different"],
  ])("preserves non-alias table %s with schema %s", async (table, schema) => {
    configure({ type: "duckdb" }, "main")
    const source = {
      listSchemas: mock(async () => ["main"]),
      describeTable: mock(async (_schema: string, _table: string) => [
        { name: "id", data_type: "INTEGER", nullable: false },
      ]),
    }
    connectorSpy?.mockRestore()
    connectorSpy = spyOn(Registry, "get").mockResolvedValue(source as unknown as Connector)
    const result = await Dispatcher.call("schema.inspect", { table: table!, schema_name: schema })
    expect((result as any).error).toBeUndefined()
    expect(result.resolution).toBeUndefined()
    expect(result.table).toBe(table)
    expect(source.describeTable.mock.calls).toEqual([[schema ?? "main", table]])
    expect(source.listSchemas).toHaveBeenCalledTimes(schema ? 0 : 1)
  })

  test("a real schema qualifier takes precedence over a warehouse alias", async () => {
    configure({ type: "duckdb" }, "main")
    const source = {
      listSchemas: mock(async () => ["main", "remote"]),
      describeTable: mock(async (_schema: string, _table: string) => [
        { name: "id", data_type: "INTEGER", nullable: false },
      ]),
    }
    connectorSpy?.mockRestore()
    connectorSpy = spyOn(Registry, "get").mockResolvedValue(source as unknown as Connector)
    const result = await Dispatcher.call("schema.inspect", { table: "remote.t" })
    expect(result.resolution).toBeUndefined()
    expect(result.warehouse).toBe("primary")
    expect(result.table).toBe("t")
    expect(source.describeTable.mock.calls).toEqual([["remote", "t"]])
  })

  test("preserves a dotted table name when schemas cannot be listed", async () => {
    const target = configure({ type: "duckdb" }, "main")
    const connector = {
      ...target,
      listSchemas: mock(async () => { throw new Error("Schema listing is unavailable") }),
    }
    connectorSpy?.mockRestore()
    connectorSpy = spyOn(Registry, "get").mockResolvedValue(connector as unknown as Connector)
    const result = await Dispatcher.call("schema.inspect", { warehouse: "remote", table: "literal.name" })
    expect(result.columns).toHaveLength(1)
    expect(target.describeTable.mock.calls).toEqual([["main", "literal.name"]])
  })

  test.each([
    'Table "missing" was not found',
    'schema "missing" does not exist',
    'relation "missing" does not exist',
    "no such table: missing",
  ])("adds addressing only for a missing database object: %s", async (message) => {
    const target = configure({ type: "duckdb" }, "main")
    target.describeTable.mockImplementation(async () => {
      throw new Error(message)
    })
    const result = await Dispatcher.call("schema.inspect", { table: "missing", warehouse: "remote" })
    expect((result as any).error).toContain(message)
    expect((result as any).error).toContain("Available warehouses:")
  })

  test.each([
    'Connection "remote" not found',
    "warehouse remote not found",
    "Host warehouse.example not found",
    "Schema inspection driver not found",
    "Driver connection timed out",
  ])("preserves connection and driver failures without an addressing hint: %s", async (message) => {
    const target = configure({ type: "duckdb" }, "main")
    target.describeTable.mockImplementation(async () => {
      throw new Error(message)
    })
    const result = await Dispatcher.call("schema.inspect", { table: "t", warehouse: "remote" })
    expect((result as any).error).toBe(`Error: ${message}`)
    expect(result.addressing_hint).toBeUndefined()
  })

  test("preserves a connection lookup failure without an addressing hint", async () => {
    configure({ type: "duckdb" }, "main")
    connectorSpy?.mockRestore()
    connectorSpy = spyOn(Registry, "get").mockRejectedValue(new Error('Connection "remote" not found'))
    const result = await Dispatcher.call("schema.inspect", { table: "t", warehouse: "remote" })
    expect((result as any).error).toBe('Error: Connection "remote" not found')
  })
})
// altimate_change end
