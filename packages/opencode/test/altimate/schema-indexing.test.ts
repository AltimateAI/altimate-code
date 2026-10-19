import { afterEach, expect, mock, test } from "bun:test"
import type { Connector } from "@altimateai/drivers"
import { SchemaCache } from "../../src/altimate/native/schema/cache"

const caches: SchemaCache[] = []
afterEach(() => {
  for (const cache of caches.splice(0)) cache.close()
})

function createCache() {
  const cache = SchemaCache.createInMemory()
  caches.push(cache)
  return cache
}

function connector(): Connector {
  return {
    connect: async () => {},
    close: async () => {},
    execute: async () => ({ columns: [], rows: [], row_count: 0, truncated: false }),
    listSchemas: mock(async () => ["main"]),
    listTables: mock(async () => [{ name: "orders", type: "table" }]),
    describeTable: mock(async () => [{ name: "id", data_type: "INTEGER", nullable: false }]),
  }
}

test("uses bulk metadata for a large schema without per-table requests", async () => {
  const cache = createCache()
  const source = connector()
  source.introspectSchema = mock(async () => ({
    schemas: ["main", "empty"],
    tables: Array.from({ length: 3000 }, (_, i) => ({
      schema: "main",
      name: `item_${i}`,
      type: i === 0 ? "view" : "table",
      columns: [{ name: "id", data_type: "INTEGER", nullable: false }],
    })),
  }))

  const result = await cache.indexWarehouse("warehouse", "duckdb", source)
  expect(result.tables_indexed).toBe(3000)
  expect(result.columns_indexed).toBe(3000)
  expect(result.schemas_indexed).toBe(2)
  expect(source.introspectSchema).toHaveBeenCalledTimes(1)
  expect(source.listSchemas).not.toHaveBeenCalled()
  expect(source.listTables).not.toHaveBeenCalled()
  expect(source.describeTable).not.toHaveBeenCalled()
  expect(cache.search("item_0").tables[0].type).toBe("view")
  expect(cache.listColumns("warehouse")[0].nullable).toBe(false)
  expect(cache.cacheStatus().total_tables).toBe(3000)
})

test("deduplicates fallback schema and table names before describing them", async () => {
  const cache = createCache()
  const source = connector()
  source.listSchemas = mock(async () => ["main", "main", "main"])
  source.listTables = mock(async () => [
    { name: "orders", type: "table" },
    { name: "orders", type: "table" },
  ])

  const result = await cache.indexWarehouse("warehouse", "other", source)
  expect(result.schemas_indexed).toBe(1)
  expect(result.tables_indexed).toBe(1)
  expect(result.columns_indexed).toBe(1)
  expect(source.listTables).toHaveBeenCalledTimes(1)
  expect(source.describeTable).toHaveBeenCalledTimes(1)
  expect(cache.cacheStatus().total_tables).toBe(1)
})

test("aborting a pending description saves completed tables and stops the crawl", async () => {
  const cache = createCache()
  const source = connector()
  const controller = new AbortController()
  const started = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<Awaited<ReturnType<Connector["describeTable"]>>>()
  source.listTables = async () => ["first", "second", "third"].map((name) => ({ name, type: "table" }))
  source.describeTable = mock(async (_schema: string, table: string) => {
    if (table === "second") {
      started.resolve()
      return pending.promise
    }
    return [{ name: "id", data_type: "INTEGER", nullable: false }]
  })
  const indexing = cache.indexWarehouse("warehouse", "other", source, { signal: controller.signal })
  await started.promise
  controller.abort()
  try {
    const result = await Promise.race([
      indexing,
      Bun.sleep(100).then(() => { throw new Error("indexing did not stop on abort") }),
    ])
    expect(result.partial).toBe(true)
    expect(result.note).toMatch(/abort/i)
    expect(result.tables_indexed).toBe(1)
    expect(source.describeTable).toHaveBeenCalledTimes(2)
  } finally {
    pending.resolve([{ name: "late_column", data_type: "TEXT", nullable: true }])
    await indexing
  }
  expect(cache.search("late_column").match_count).toBe(0)
  expect(cache.cacheStatus().total_tables).toBe(1)
})

test("a deadline stops waiting for bulk metadata and signals the connector", async () => {
  const cache = createCache()
  const source = connector()
  const pending = Promise.withResolvers<{ schemas: string[]; tables: [] }>()
  let signal: AbortSignal | undefined
  source.introspectSchema = async (input) => {
    signal = input
    return pending.promise
  }
  const result = await cache.indexWarehouse("warehouse", "duckdb", source, { timeoutMs: 5 })
  pending.resolve({ schemas: [], tables: [] })
  expect(result.partial).toBe(true)
  expect(result.note).toMatch(/deadline|timed out/i)
  expect(result.tables_indexed).toBe(0)
  expect(signal?.aborted).toBe(true)
})

test("a pre-aborted index leaves the existing cache available without calling the connector", async () => {
  const cache = createCache()
  await cache.indexWarehouse("warehouse", "other", connector())
  const source = connector()
  const result = await cache.indexWarehouse("warehouse", "other", source, { signal: AbortSignal.abort() })
  expect(result.partial).toBe(true)
  expect(result.tables_indexed).toBe(0)
  expect(source.listSchemas).not.toHaveBeenCalled()
  expect(cache.search("orders").tables).toHaveLength(1)
})

test("keeps the previous snapshot readable until replacement metadata is collected", async () => {
  const cache = createCache()
  await cache.indexWarehouse("warehouse", "other", connector())
  const source = connector()
  const started = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<Awaited<ReturnType<Connector["describeTable"]>>>()
  source.listTables = async () => [{ name: "customers", type: "table" }]
  source.describeTable = async () => {
    started.resolve()
    return pending.promise
  }
  const indexing = cache.indexWarehouse("warehouse", "other", source)
  await started.promise
  try {
    expect(cache.search("orders").tables).toHaveLength(1)
  } finally {
    pending.resolve([{ name: "id", data_type: "INTEGER", nullable: false }])
    await indexing
  }
  expect(cache.search("orders").tables).toHaveLength(0)
  expect(cache.search("customers").tables).toHaveLength(1)
})

function abortedAfterFirstTable() {
  const source = connector()
  const controller = new AbortController()
  source.listTables = async () => ["first", "second"].map((name) => ({ name, type: "table" }))
  source.describeTable = mock(async (_schema: string, table: string) => {
    if (table === "second") {
      controller.abort()
      return new Promise<never>(() => {})
    }
    return [{ name: "id", data_type: "INTEGER", nullable: false }]
  })
  return { source, signal: controller.signal }
}

test("a partial run never replaces an existing complete cache", async () => {
  const cache = createCache()
  const full = connector()
  full.listTables = async () => ["first", "second", "third"].map((name) => ({ name, type: "table" }))
  const complete = await cache.indexWarehouse("warehouse", "other", full)
  expect(complete.partial).toBeUndefined()
  const before = cache.cacheStatus().warehouses[0].last_indexed

  const { source, signal } = abortedAfterFirstTable()
  const result = await cache.indexWarehouse("warehouse", "other", source, { signal })
  expect(result.partial).toBe(true)
  expect(cache.cacheStatus().total_tables).toBe(3)
  expect(cache.cacheStatus().warehouses[0].last_indexed).toBe(before)
})

test("a partial first index is saved but recorded as stale", async () => {
  const cache = createCache()
  const { source, signal } = abortedAfterFirstTable()
  const result = await cache.indexWarehouse("warehouse", "other", source, { signal })
  expect(result.partial).toBe(true)
  expect(cache.cacheStatus().total_tables).toBe(1)
  const indexed = cache.cacheStatus().warehouses[0].last_indexed!
  expect(Date.now() - new Date(indexed).getTime()).toBeGreaterThan(365 * 24 * 3600 * 1000)
})
