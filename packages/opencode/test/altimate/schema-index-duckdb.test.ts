import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { connect } from "../../../drivers/src/duckdb"
import { LocalEngine } from "../../../drivers/src/local-engine"
import { SchemaCache } from "../../src/altimate/native/schema/cache"
import { tmpdir } from "../fixture/fixture"

// Run in a separate process because other suites mock the DuckDB module.
const duckdbTest = process.env.ALTIMATE_DUCKDB_E2E === "1" ? test : test.skip

duckdbTest("indexes a large catalog once with bounded metadata queries", async () => {
  await using tmp = await tmpdir()
  const connector = await connect({ type: "duckdb", path: ":memory:" })
  const cache = SchemaCache.create(path.join(tmp.path, "schema-cache.db"))
  let metadataSpy: ReturnType<typeof spyOn> | undefined

  try {
    await connector.connect()
    const tableCount = 3000
    for (let i = 0; i < tableCount; i++) {
      await connector.execute(`CREATE TABLE item_${i} (id INTEGER NOT NULL, label VARCHAR)`)
    }
    await connector.execute("ATTACH ':memory:' AS secondary")
    await connector.execute("CREATE TABLE secondary.main.item_0 (foreign_field BOOLEAN)")
    await connector.execute("CREATE TABLE secondary.main.foreign_only (id INTEGER)")
    metadataSpy = spyOn(LocalEngine.prototype, "call")
    const started = performance.now()

    const result = await cache.indexWarehouse("warehouse", "duckdb", connector)

    expect(performance.now() - started).toBeLessThan(20_000)
    expect(metadataSpy.mock.calls.length).toBeGreaterThan(0)
    expect(metadataSpy.mock.calls.length).toBeLessThanOrEqual(3)
    expect(result.schemas_indexed).toBe(1)
    expect(result.tables_indexed).toBe(tableCount)
    expect(result.columns_indexed).toBe(tableCount * 2)
    expect(cache.cacheStatus()).toMatchObject({
      total_tables: tableCount,
      total_columns: tableCount * 2,
    })
    expect(cache.search("foreign_field", "warehouse").columns).toEqual([])
    expect(cache.search("foreign_only", "warehouse").tables).toEqual([])
    expect(cache.search("item_0", "warehouse").columns).toEqual([
      expect.objectContaining({ table: "item_0", name: "id", data_type: "INTEGER", nullable: false }),
      expect.objectContaining({ table: "item_0", name: "label", data_type: "VARCHAR", nullable: true }),
    ])
  } finally {
    metadataSpy?.mockRestore()
    cache.close()
    await connector.close()
  }
}, 60_000)
