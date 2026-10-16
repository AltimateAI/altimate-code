import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { connect, type DuckDBEngine } from "../src/duckdb"
import { LocalEngine } from "../src/local-engine"
import type { ConnectionConfig, Connector } from "../src/types"

// Run in a separate process because other suites mock the DuckDB module.
const duckdbTest = process.env.ALTIMATE_DUCKDB_E2E === "1" ? test : test.skip

let connector: Connector | undefined
let callSpy: ReturnType<typeof spyOn> | undefined

afterEach(async () => {
  callSpy?.mockRestore()
  callSpy = undefined
  await connector?.close()
  connector = undefined
})

async function open(engine?: DuckDBEngine, config: Partial<ConnectionConfig> = {}) {
  connector = await connect(
    { type: "duckdb", path: ":memory:", ...config },
    engine ? { createEngine: () => engine } : undefined,
  )
  await connector.connect()
  return connector
}

function scriptedEngine(query: (sql: string, timeoutMs?: number, signal?: AbortSignal) => Promise<unknown[]>): DuckDBEngine {
  return {
    async open() {},
    async call<T>(_method, payload, timeoutMs, _onDispatch, signal) {
      return await query(payload.sql as string, timeoutMs, signal) as T
    },
    async close() {},
  }
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
    callSpy = spyOn(LocalEngine.prototype, "call")

    const metadata = await driver.introspectSchema!()

    expect(callSpy).toHaveBeenCalledTimes(2)
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

  test("forwards query deadlines and abort signals to both bulk metadata queries", async () => {
    const calls: Array<{ sql: string; timeoutMs?: number; signal?: AbortSignal }> = []
    const driver = await open(scriptedEngine(async (sql, timeoutMs, signal) => {
      calls.push({ sql, timeoutMs, signal })
      return calls.length === 1
        ? [{ schema_name: "main" }]
        : [{ table_schema: "main", table_name: "events", table_type: "BASE TABLE", column_name: "id", data_type: "INTEGER", is_nullable: "NO" }]
    }), { query_timeout_ms: 37 })
    const controller = new AbortController()

    expect(await driver.introspectSchema!(controller.signal)).toEqual({
      schemas: ["main"],
      tables: [{ schema: "main", name: "events", type: "table", columns: [{ name: "id", data_type: "INTEGER", nullable: false }] }],
    })
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.timeoutMs).toBe(37)
      expect(call.signal).toBe(controller.signal)
      expect(call.sql).not.toMatch(/\bLIMIT\b/i)
    }
  })

  test("rejects an already aborted introspection without querying", async () => {
    const engine = scriptedEngine(async () => [])
    const driver = await open(engine)
    callSpy = spyOn(engine, "call")
    const controller = new AbortController()
    controller.abort(new Error("Index cancelled"))

    await expect(driver.introspectSchema!(controller.signal)).rejects.toThrow("Index cancelled")
    expect(callSpy).not.toHaveBeenCalled()
  })

  test("stops waiting on abort and starts no further metadata queries", async () => {
    const entered = Promise.withResolvers<void>()
    let complete!: (rows: unknown[]) => void
    const engine = scriptedEngine((_sql, _timeoutMs, signal) => new Promise((resolve, reject) => {
      complete = resolve
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })
      entered.resolve()
    }))
    const driver = await open(engine)
    callSpy = spyOn(engine, "call")
    const controller = new AbortController()
    const pending = driver.introspectSchema!(controller.signal)
    await entered.promise
    controller.abort(new Error("Index cancelled"))

    await expect(pending).rejects.toThrow("Index cancelled")
    complete([{ schema_name: "main" }])
    await Promise.resolve()
    expect(callSpy).toHaveBeenCalledTimes(1)
  })
})
