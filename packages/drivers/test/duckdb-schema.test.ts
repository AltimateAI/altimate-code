import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { connect } from "../src/duckdb"
import type { Connector } from "../src/types"

// Run in a separate process because other suites mock the DuckDB module.
const duckdbTest = process.env.ALTIMATE_DUCKDB_E2E === "1" ? test : test.skip

let connector: Connector | undefined
let allSpy: ReturnType<typeof spyOn> | undefined
let duckdb: typeof import("duckdb")

afterEach(async () => {
  allSpy?.mockRestore()
  allSpy = undefined
  await connector?.close()
  connector = undefined
})

async function open() {
  duckdb = await import("duckdb").then((module) => module.default)
  connector = await connect({ type: "duckdb", path: ":memory:" })
  await connector.connect()
  return connector
}

describe("DuckDB schema introspection", () => {
  duckdbTest("lists each schema once and scopes tables and columns to the current catalog", async () => {
    const driver = await open()
    await driver.execute("CREATE TABLE shared (local_id INTEGER NOT NULL)")
    await driver.execute("ATTACH ':memory:' AS other")
    await driver.execute("CREATE TABLE other.main.shared (foreign_id VARCHAR)")
    await driver.execute("CREATE TABLE other.main.foreign_only (id INTEGER)")

    expect(await driver.listSchemas()).toEqual(["main"])
    expect(await driver.listTables("main")).toEqual([{ name: "shared", type: "table" }])
    expect(await driver.describeTable("main", "shared")).toEqual([
      { name: "local_id", data_type: "INTEGER", nullable: false },
    ])
  })

  duckdbTest("reads complete table and view metadata with a constant number of queries", async () => {
    const driver = await open()
    await driver.execute("CREATE SCHEMA empty_schema")
    await driver.execute("CREATE TABLE events (id INTEGER NOT NULL, label VARCHAR)")
    await driver.execute("CREATE VIEW event_ids AS SELECT id FROM events")
    await driver.execute("ATTACH ':memory:' AS other")
    await driver.execute("CREATE TABLE other.main.events (foreign_id BIGINT)")
    for (let i = 0; i < 24; i++) {
      await driver.execute(`CREATE TABLE item_${i} (id INTEGER)`)
    }
    allSpy = spyOn(duckdb.Connection.prototype, "all")

    const metadata = await driver.introspectSchema!()

    expect(allSpy).toHaveBeenCalledTimes(2)
    expect(metadata.schemas).toEqual(["empty_schema", "main"])
    expect(metadata.tables).toHaveLength(26)
    expect(metadata.tables.find((table) => table.name === "events")).toEqual({
      schema: "main",
      name: "events",
      type: "table",
      columns: [
        { name: "id", data_type: "INTEGER", nullable: false },
        { name: "label", data_type: "VARCHAR", nullable: true },
      ],
    })
    expect(metadata.tables.find((table) => table.name === "event_ids")).toMatchObject({
      schema: "main",
      type: "view",
      columns: [{ name: "id", data_type: "INTEGER", nullable: true }],
    })
  })

  duckdbTest("does not truncate a large metadata inventory", async () => {
    const driver = await open()
    await driver.execute(
      `CREATE TABLE wide_table (${Array.from({ length: 1100 }, (_, i) => `field_${i} INTEGER`).join(", ")})`,
    )

    const metadata = await driver.introspectSchema!()

    expect(metadata.tables).toHaveLength(1)
    expect(metadata.tables[0].columns).toHaveLength(1100)
    expect(metadata.tables[0].columns.at(-1)?.name).toBe("field_1099")
  })

  duckdbTest("rejects an already aborted introspection without querying", async () => {
    const driver = await open()
    allSpy = spyOn(duckdb.Connection.prototype, "all")
    const controller = new AbortController()
    controller.abort(new Error("Index cancelled"))

    await expect(driver.introspectSchema!(controller.signal)).rejects.toThrow("Index cancelled")
    expect(allSpy).not.toHaveBeenCalled()
  })

  duckdbTest("stops waiting on abort and starts no further metadata queries", async () => {
    const driver = await open()
    let complete: ((error: Error | null, rows: unknown[]) => void) | undefined
    allSpy = spyOn(duckdb.Connection.prototype, "all").mockImplementation(function (_sql, ...args) {
      complete = args.at(-1) as typeof complete
      return this
    })
    const controller = new AbortController()
    const pending = driver.introspectSchema!(controller.signal)
    controller.abort(new Error("Index cancelled"))

    await expect(pending).rejects.toThrow("Index cancelled")
    complete!(null, [{ schema_name: "main" }])
    await Promise.resolve()
    expect(allSpy).toHaveBeenCalledTimes(1)
  })
})
