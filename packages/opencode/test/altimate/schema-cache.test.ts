/**
 * Adversarial and edge-case tests for the SchemaCache (bun:sqlite backend).
 *
 * Covers: upgrade from better-sqlite3, corrupted DBs, concurrent access,
 * SQL injection via search, unicode identifiers, large datasets, re-indexing,
 * and various runtime failure modes.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { SchemaCache, getCache, resetCache } from "../../src/altimate/native/schema/cache"
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { Connector } from "@altimateai/drivers"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock connector that returns predefined schema data. */
function mockConnector(schemas: Record<string, Record<string, string[]>>): Connector {
  return {
    async connect() {},
    async execute() { return { columns: [], rows: [], row_count: 0, truncated: false } },
    async listSchemas() { return Object.keys(schemas) },
    async listTables(schema: string) {
      const tables = schemas[schema] || {}
      return Object.keys(tables).map((name) => ({ name, type: "TABLE" }))
    },
    async describeTable(schema: string, table: string) {
      const columns = schemas[schema]?.[table] || []
      return columns.map((name) => ({ name, data_type: "TEXT", nullable: true }))
    },
    async close() {},
  }
}

/** Create a connector that fails on specific operations. */
function failingConnector(failOn: "listSchemas" | "listTables" | "describeTable"): Connector {
  return {
    async connect() {},
    async execute() { return { columns: [], rows: [], row_count: 0, truncated: false } },
    async listSchemas() {
      if (failOn === "listSchemas") throw new Error("listSchemas failed")
      return ["public"]
    },
    async listTables(_schema: string) {
      if (failOn === "listTables") throw new Error("listTables failed")
      return [{ name: "t", type: "TABLE" }]
    },
    async describeTable() {
      if (failOn === "describeTable") throw new Error("describeTable failed")
      return [{ name: "col", data_type: "TEXT", nullable: true }]
    },
    async close() {},
  }
}

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "schema-cache-test-"))
})

afterEach(() => {
  resetCache()
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 1. Upgrade / migration from better-sqlite3
// ---------------------------------------------------------------------------

describe("upgrade from existing better-sqlite3 cache", () => {
  test("opens a cache DB previously created by better-sqlite3", () => {
    // Simulate a DB created by better-sqlite3 (same schema, just a normal SQLite file)
    const dbPath = join(tmpDir, "legacy-cache.db")
    const legacyDb = new Database(dbPath, { create: true })
    legacyDb.exec(`
      CREATE TABLE warehouses (
        name TEXT PRIMARY KEY, type TEXT NOT NULL, last_indexed TEXT,
        databases_count INTEGER DEFAULT 0, schemas_count INTEGER DEFAULT 0,
        tables_count INTEGER DEFAULT 0, columns_count INTEGER DEFAULT 0
      );
      CREATE TABLE tables_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        warehouse TEXT NOT NULL, database_name TEXT, schema_name TEXT NOT NULL,
        table_name TEXT NOT NULL, table_type TEXT DEFAULT 'TABLE',
        row_count INTEGER, comment TEXT, search_text TEXT NOT NULL,
        UNIQUE(warehouse, database_name, schema_name, table_name)
      );
      CREATE TABLE columns_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        warehouse TEXT NOT NULL, database_name TEXT, schema_name TEXT NOT NULL,
        table_name TEXT NOT NULL, column_name TEXT NOT NULL,
        data_type TEXT, nullable INTEGER DEFAULT 1, comment TEXT,
        search_text TEXT NOT NULL,
        UNIQUE(warehouse, database_name, schema_name, table_name, column_name)
      );
      INSERT INTO warehouses (name, type, last_indexed, schemas_count, tables_count, columns_count)
        VALUES ('my-bq', 'bigquery', '2026-01-01T00:00:00Z', 2, 10, 50);
      INSERT INTO tables_cache (warehouse, schema_name, table_name, search_text)
        VALUES ('my-bq', 'analytics', 'orders', 'analytics orders');
      INSERT INTO columns_cache (warehouse, schema_name, table_name, column_name, data_type, search_text)
        VALUES ('my-bq', 'analytics', 'orders', 'order_id', 'INT64', 'analytics orders order_id int64');
    `)
    legacyDb.close()

    // Open with new bun:sqlite-based SchemaCache
    const cache = SchemaCache.create(dbPath)

    // Existing data should be readable
    const status = cache.cacheStatus()
    expect(status.warehouses).toHaveLength(1)
    expect(status.warehouses[0].name).toBe("my-bq")
    expect(status.warehouses[0].tables_count).toBe(10)

    const results = cache.search("orders")
    expect(results.tables).toHaveLength(1)
    expect(results.columns).toHaveLength(1)
    expect(results.columns[0].name).toBe("order_id")

    cache.close()
  })

  test("re-indexes over legacy data without errors", async () => {
    const dbPath = join(tmpDir, "legacy-reindex.db")
    const legacyDb = new Database(dbPath, { create: true })
    legacyDb.exec(`
      CREATE TABLE warehouses (name TEXT PRIMARY KEY, type TEXT NOT NULL, last_indexed TEXT,
        databases_count INTEGER DEFAULT 0, schemas_count INTEGER DEFAULT 0,
        tables_count INTEGER DEFAULT 0, columns_count INTEGER DEFAULT 0);
      CREATE TABLE tables_cache (id INTEGER PRIMARY KEY AUTOINCREMENT,
        warehouse TEXT NOT NULL, database_name TEXT, schema_name TEXT NOT NULL,
        table_name TEXT NOT NULL, table_type TEXT DEFAULT 'TABLE',
        row_count INTEGER, comment TEXT, search_text TEXT NOT NULL,
        UNIQUE(warehouse, database_name, schema_name, table_name));
      CREATE TABLE columns_cache (id INTEGER PRIMARY KEY AUTOINCREMENT,
        warehouse TEXT NOT NULL, database_name TEXT, schema_name TEXT NOT NULL,
        table_name TEXT NOT NULL, column_name TEXT NOT NULL, data_type TEXT,
        nullable INTEGER DEFAULT 1, comment TEXT, search_text TEXT NOT NULL,
        UNIQUE(warehouse, database_name, schema_name, table_name, column_name));
      INSERT INTO warehouses (name, type) VALUES ('old-wh', 'postgres');
      INSERT INTO tables_cache (warehouse, schema_name, table_name, search_text)
        VALUES ('old-wh', 'public', 'stale_table', 'stale');
    `)
    legacyDb.close()

    const cache = SchemaCache.create(dbPath)
    const connector = mockConnector({ public: { fresh_table: ["id", "name"] } })
    const result = await cache.indexWarehouse("old-wh", "postgres", connector)

    expect(result.tables_indexed).toBe(1)
    expect(result.columns_indexed).toBe(2)

    // Stale data should be gone
    const staleSearch = cache.search("stale_table")
    expect(staleSearch.match_count).toBe(0)

    // Fresh data should be present
    const freshSearch = cache.search("fresh_table")
    expect(freshSearch.tables).toHaveLength(1)

    cache.close()
  })
})

// ---------------------------------------------------------------------------
// 2. Corrupted / malformed database files
// ---------------------------------------------------------------------------

describe("corrupted database files", () => {
  test("handles non-SQLite file gracefully", () => {
    const badPath = join(tmpDir, "not-a-database.db")
    writeFileSync(badPath, "this is not a sqlite database at all, just garbage data")
    expect(() => SchemaCache.create(badPath)).toThrow()
  })

  test("handles zero-byte file (creates fresh DB)", () => {
    const emptyPath = join(tmpDir, "empty.db")
    writeFileSync(emptyPath, "")
    // bun:sqlite should treat empty file as a new database
    const cache = SchemaCache.create(emptyPath)
    const status = cache.cacheStatus()
    expect(status.warehouses).toEqual([])
    cache.close()
  })

  test("handles truncated SQLite file", () => {
    // Create a valid DB, then truncate it
    const dbPath = join(tmpDir, "truncated.db")
    const db = new Database(dbPath, { create: true })
    db.exec("CREATE TABLE t (id INTEGER)")
    db.close()

    // Truncate to just the first 50 bytes (corrupt the file)
    const { readFileSync } = require("fs")
    const buf = readFileSync(dbPath)
    writeFileSync(dbPath, buf.slice(0, 50))

    expect(() => SchemaCache.create(dbPath)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// 3. SQL injection via search queries
// ---------------------------------------------------------------------------

describe("SQL injection resistance", () => {
  test("search with SQL injection in query string", async () => {
    const cache = SchemaCache.createInMemory()
    const connector = mockConnector({ public: { users: ["id", "email"] } })
    await cache.indexWarehouse("wh", "postgres", connector)

    // These should not cause SQL errors or return unintended data
    const injections = [
      "'; DROP TABLE tables_cache; --",
      "\" OR 1=1 --",
      "users UNION SELECT * FROM warehouses --",
      "' OR ''='",
      "Robert'); DROP TABLE columns_cache;--",
      "%' AND 1=1 AND '%'='",
      "LIKE '%'; DELETE FROM warehouses WHERE '1'='1",
    ]

    for (const injection of injections) {
      // Should not throw
      const result = cache.search(injection)
      expect(result).toBeDefined()
      expect(Array.isArray(result.tables)).toBe(true)
      expect(Array.isArray(result.columns)).toBe(true)
    }

    // Data should still be intact after all injection attempts
    const status = cache.cacheStatus()
    expect(status.warehouses).toHaveLength(1)
    expect(status.total_tables).toBe(1)

    cache.close()
  })

  test("search with null bytes and control characters", async () => {
    const cache = SchemaCache.createInMemory()
    const connector = mockConnector({ public: { t: ["c"] } })
    await cache.indexWarehouse("wh", "pg", connector)

    const weirdQueries = [
      "\0",
      "\x00\x01\x02",
      "\n\r\t",
      "\u0000",
      "test\0injection",
    ]

    for (const q of weirdQueries) {
      const result = cache.search(q)
      expect(result).toBeDefined()
    }

    cache.close()
  })
})

// ---------------------------------------------------------------------------
// 4. Unicode and special characters in identifiers
// ---------------------------------------------------------------------------

describe("unicode and special character identifiers", () => {
  test("indexes tables with unicode names without crashing", async () => {
    const cache = SchemaCache.createInMemory()
    const connector = mockConnector({
      "public": {
        "日本語テーブル": ["列名", "データ型"],
        "表_中文": ["编号", "名称"],
        "таблица": ["столбец"],
        "tëst_àccénts": ["çolumn"],
      },
    })

    const result = await cache.indexWarehouse("unicode-wh", "postgres", connector)
    expect(result.tables_indexed).toBe(4)
    expect(result.columns_indexed).toBe(6)

    // Note: tokenizeQuery uses [a-zA-Z0-9_]+ so pure unicode names won't match
    // via search tokens, but mixed names with ASCII parts should work
    const status = cache.cacheStatus()
    expect(status.total_tables).toBe(4)

    cache.close()
  })

  test("handles identifiers with SQL-significant characters", async () => {
    const cache = SchemaCache.createInMemory()
    const connector = mockConnector({
      "my-schema": {
        "table with spaces": ["column-with-dashes"],
        "table.with.dots": ["col"],
        'table"quotes': ["col"],
        "table%percent": ["col"],
      },
    })

    const result = await cache.indexWarehouse("wh", "pg", connector)
    expect(result.tables_indexed).toBe(4)

    const search = cache.search("spaces")
    expect(search.tables).toHaveLength(1)
    expect(search.tables[0].name).toBe("table with spaces")

    cache.close()
  })
})

// ---------------------------------------------------------------------------
// 5. Large dataset stress
// ---------------------------------------------------------------------------

describe("large dataset handling", () => {
  test("indexes 1000 tables with 10 columns each", async () => {
    const schemas: Record<string, Record<string, string[]>> = {}
    const tables: Record<string, string[]> = {}
    for (let i = 0; i < 1000; i++) {
      const cols: string[] = []
      for (let j = 0; j < 10; j++) {
        cols.push(`col_${j}`)
      }
      tables[`table_${i}`] = cols
    }
    schemas["big_schema"] = tables

    const cache = SchemaCache.createInMemory()
    const connector = mockConnector(schemas)

    const result = await cache.indexWarehouse("big-wh", "snowflake", connector)
    expect(result.tables_indexed).toBe(1000)
    expect(result.columns_indexed).toBe(10000)

    // Search should still work and respect limits
    const search = cache.search("col", undefined, 5)
    expect(search.columns.length).toBeLessThanOrEqual(5)

    const status = cache.cacheStatus()
    expect(status.total_tables).toBe(1000)
    expect(status.total_columns).toBe(10000)

    cache.close()
  })
})

// ---------------------------------------------------------------------------
// 6. Re-indexing and multiple warehouses
// ---------------------------------------------------------------------------

describe("re-indexing and multi-warehouse", () => {
  test("re-indexing replaces old data completely", async () => {
    const cache = SchemaCache.createInMemory()

    // First index
    const v1 = mockConnector({ public: { old_table: ["old_col"] } })
    await cache.indexWarehouse("wh", "pg", v1)
    expect(cache.search("old_table").tables).toHaveLength(1)

    // Re-index with different data
    const v2 = mockConnector({ public: { new_table: ["new_col"] } })
    await cache.indexWarehouse("wh", "pg", v2)

    // Old data gone
    expect(cache.search("old_table").match_count).toBe(0)
    // New data present
    expect(cache.search("new_table").tables).toHaveLength(1)

    cache.close()
  })

  test("multiple warehouses are isolated", async () => {
    const cache = SchemaCache.createInMemory()

    const pg = mockConnector({ public: { pg_orders: ["id"] } })
    const sf = mockConnector({ analytics: { sf_events: ["event_id"] } })

    await cache.indexWarehouse("postgres-prod", "postgres", pg)
    await cache.indexWarehouse("snowflake-prod", "snowflake", sf)

    // Warehouse filter isolates results
    const pgOnly = cache.search("id", "postgres-prod")
    expect(pgOnly.columns.every((c) => c.warehouse === "postgres-prod")).toBe(true)

    const sfOnly = cache.search("id", "snowflake-prod")
    expect(sfOnly.columns.every((c) => c.warehouse === "snowflake-prod")).toBe(true)

    // Status shows both
    const status = cache.cacheStatus()
    expect(status.warehouses).toHaveLength(2)

    // Re-indexing one doesn't affect the other
    const pgV2 = mockConnector({ public: { pg_customers: ["cust_id"] } })
    await cache.indexWarehouse("postgres-prod", "postgres", pgV2)

    expect(cache.search("sf_events").tables).toHaveLength(1) // still there
    expect(cache.search("pg_orders").match_count).toBe(0)     // replaced

    cache.close()
  })

  test("re-index updates warehouse metadata timestamp", async () => {
    const cache = SchemaCache.createInMemory()
    const connector = mockConnector({ s: { t: ["c"] } })

    const r1 = await cache.indexWarehouse("wh", "pg", connector)
    const t1 = r1.timestamp

    // Small delay to ensure different timestamp
    await new Promise((r) => setTimeout(r, 10))

    const r2 = await cache.indexWarehouse("wh", "pg", connector)
    expect(r2.timestamp).not.toBe(t1)

    cache.close()
  })
})

// ---------------------------------------------------------------------------
// 7. Connector failure modes
// ---------------------------------------------------------------------------

describe("connector failures during indexing", () => {
  test("listSchemas failure results in zero indexed", async () => {
    const cache = SchemaCache.createInMemory()
    const connector = failingConnector("listSchemas")
    const result = await cache.indexWarehouse("wh", "pg", connector)
    expect(result.schemas_indexed).toBe(0)
    expect(result.tables_indexed).toBe(0)
    expect(result.columns_indexed).toBe(0)
    cache.close()
  })

  test("listTables failure skips schema but continues", async () => {
    const cache = SchemaCache.createInMemory()
    const connector = failingConnector("listTables")
    const result = await cache.indexWarehouse("wh", "pg", connector)
    expect(result.schemas_indexed).toBe(1) // schema counted
    expect(result.tables_indexed).toBe(0)  // but no tables
    cache.close()
  })

  test("describeTable failure skips table columns but continues", async () => {
    const cache = SchemaCache.createInMemory()
    const connector = failingConnector("describeTable")
    const result = await cache.indexWarehouse("wh", "pg", connector)
    expect(result.tables_indexed).toBe(1)
    expect(result.columns_indexed).toBe(0) // columns failed
    cache.close()
  })

  test("INFORMATION_SCHEMA is skipped", async () => {
    const cache = SchemaCache.createInMemory()
    const connector = mockConnector({
      "INFORMATION_SCHEMA": { schemata: ["catalog_name"] },
      "public": { users: ["id"] },
    })
    const result = await cache.indexWarehouse("wh", "pg", connector)
    expect(result.schemas_indexed).toBe(1) // only public
    expect(cache.search("schemata").match_count).toBe(0)
    cache.close()
  })
})

// ---------------------------------------------------------------------------
// 8. Search edge cases
// ---------------------------------------------------------------------------

describe("search edge cases", () => {
  let cache: SchemaCache

  beforeEach(async () => {
    cache = SchemaCache.createInMemory()
    const connector = mockConnector({
      public: {
        user_accounts: ["user_id", "email_address", "created_at"],
        order_items: ["order_id", "item_name", "quantity"],
      },
    })
    await cache.indexWarehouse("wh", "pg", connector)
  })

  afterEach(() => cache.close())

  test("empty query returns empty results", () => {
    const result = cache.search("")
    expect(result.match_count).toBe(0)
  })

  test("query with only stop words falls back to first token", () => {
    // "the" is a stop word, but should still return results via fallback
    const result = cache.search("the")
    expect(result).toBeDefined()
  })

  test("very long query doesn't crash", () => {
    const longQuery = "a".repeat(10000)
    const result = cache.search(longQuery)
    expect(result).toBeDefined()
    expect(result.match_count).toBe(0)
  })

  test("underscore splitting enables partial matching", () => {
    // "user_accounts" should be searchable by "user" or "accounts"
    const byUser = cache.search("user")
    expect(byUser.tables.length).toBeGreaterThan(0)

    const byAccounts = cache.search("accounts")
    expect(byAccounts.tables.length).toBeGreaterThan(0)
  })

  test("search is case-insensitive", () => {
    const lower = cache.search("user")
    const upper = cache.search("USER")
    const mixed = cache.search("User")
    expect(lower.match_count).toBe(upper.match_count)
    expect(lower.match_count).toBe(mixed.match_count)
  })

  test("limit=0 returns empty results", () => {
    const result = cache.search("user", undefined, 0)
    expect(result.tables).toHaveLength(0)
    expect(result.columns).toHaveLength(0)
  })

  test("search with non-existent warehouse returns empty", () => {
    const result = cache.search("user", "nonexistent-warehouse")
    expect(result.match_count).toBe(0)
  })

  test("FQN is correctly formed", () => {
    const result = cache.search("email")
    expect(result.columns).toHaveLength(1)
    expect(result.columns[0].fqn).toBe("public.user_accounts.email_address")
  })
})

// ---------------------------------------------------------------------------
// 9. listColumns
// ---------------------------------------------------------------------------

describe("listColumns", () => {
  test("returns all columns for a warehouse", async () => {
    const cache = SchemaCache.createInMemory()
    const connector = mockConnector({
      s1: { t1: ["a", "b"], t2: ["c"] },
    })
    await cache.indexWarehouse("wh", "pg", connector)

    const cols = cache.listColumns("wh")
    expect(cols).toHaveLength(3)
    expect(cols.map((c) => c.name).sort()).toEqual(["a", "b", "c"])
    cache.close()
  })

  test("respects limit parameter", async () => {
    const cache = SchemaCache.createInMemory()
    const tables: Record<string, string[]> = {}
    for (let i = 0; i < 20; i++) tables[`t${i}`] = [`col${i}`]
    const connector = mockConnector({ s: tables })
    await cache.indexWarehouse("wh", "pg", connector)

    const limited = cache.listColumns("wh", 5)
    expect(limited).toHaveLength(5)
    cache.close()
  })

  test("returns empty for unknown warehouse", async () => {
    const cache = SchemaCache.createInMemory()
    const cols = cache.listColumns("ghost-warehouse")
    expect(cols).toHaveLength(0)
    cache.close()
  })
})

// ---------------------------------------------------------------------------
// 10. File-based cache persistence
// ---------------------------------------------------------------------------

describe("file-based cache persistence", () => {
  test("data persists across close and reopen", async () => {
    const dbPath = join(tmpDir, "persistent.db")

    // Create and populate
    const cache1 = SchemaCache.create(dbPath)
    const connector = mockConnector({ public: { users: ["id", "name"] } })
    await cache1.indexWarehouse("prod", "postgres", connector)
    cache1.close()

    // Reopen and verify
    const cache2 = SchemaCache.create(dbPath)
    const status = cache2.cacheStatus()
    expect(status.warehouses).toHaveLength(1)
    expect(status.warehouses[0].name).toBe("prod")
    expect(status.total_columns).toBe(2)

    const search = cache2.search("name")
    expect(search.columns).toHaveLength(1)
    cache2.close()
  })

  test("opens existing DB file at a custom path", () => {
    const nestedPath = join(tmpDir, "deep", "nested", "dir", "cache.db")
    mkdirSync(join(tmpDir, "deep", "nested", "dir"), { recursive: true })
    const cache = SchemaCache.create(nestedPath)
    expect(existsSync(nestedPath)).toBe(true)
    cache.close()
  })
})

// ---------------------------------------------------------------------------
// 11. Singleton (getCache / resetCache)
// ---------------------------------------------------------------------------

describe("singleton lifecycle", () => {
  test("getCache returns same instance on repeated calls", async () => {
    const c1 = await getCache()
    const c2 = await getCache()
    // Should be the same object (singleton)
    expect(c1).toBe(c2)
    resetCache()
  })

  test("resetCache allows fresh instance", async () => {
    const c1 = await getCache()
    resetCache()
    const c2 = await getCache()
    expect(c1).not.toBe(c2)
    resetCache()
  })
})

// ---------------------------------------------------------------------------
// 12. SQLite driver E2E — PRAGMA edge cases
// ---------------------------------------------------------------------------

describe("SQLite driver PRAGMA handling", () => {
  test("PRAGMA statements work without LIMIT clause error", async () => {
    const { connect } = await import("@altimateai/drivers/sqlite")
    const dbPath = join(tmpDir, "pragma-test.db")
    const connector = await connect({ type: "sqlite", path: dbPath })
    await connector.connect()

    // These should all work without "near LIMIT: syntax error"
    const journalMode = await connector.execute("PRAGMA journal_mode")
    expect(journalMode.row_count).toBeGreaterThan(0)

    const tableList = await connector.execute("PRAGMA table_list")
    expect(tableList.row_count).toBeGreaterThan(0)

    await connector.execute("CREATE TABLE test (id INTEGER, name TEXT)")
    const tableInfo = await connector.execute("PRAGMA table_info('test')")
    expect(tableInfo.row_count).toBe(2)

    await connector.close()
  })

  test("SELECT statements still get LIMIT applied", async () => {
    const { connect } = await import("@altimateai/drivers/sqlite")
    const dbPath = join(tmpDir, "limit-test.db")
    const connector = await connect({ type: "sqlite", path: dbPath })
    await connector.connect()

    await connector.execute("CREATE TABLE nums (n INTEGER)")
    for (let i = 0; i < 20; i++) {
      await connector.execute(`INSERT INTO nums VALUES (${i})`)
    }

    // Default limit should cap results
    const result = await connector.execute("SELECT * FROM nums", 5)
    expect(result.row_count).toBe(5)
    expect(result.truncated).toBe(true)

    await connector.close()
  })
})

// ---------------------------------------------------------------------------
// 13. SQLite driver — readonly connection handling
// ---------------------------------------------------------------------------

describe("SQLite driver readonly connections", () => {
  test("readonly connection can read existing database", async () => {
    const { connect } = await import("@altimateai/drivers/sqlite")
    const dbPath = join(tmpDir, "readonly-test.db")

    // Create a database with data first
    const writer = await connect({ type: "sqlite", path: dbPath })
    await writer.connect()
    await writer.execute("CREATE TABLE items (id INTEGER, name TEXT)")
    await writer.execute("INSERT INTO items VALUES (1, 'test')")
    await writer.close()

    // Open readonly and verify reads work
    const reader = await connect({ type: "sqlite", path: dbPath, readonly: true })
    await reader.connect()
    const result = await reader.execute("SELECT * FROM items")
    expect(result.rows).toEqual([[1, "test"]])
    await reader.close()
  })

  test("readonly connection rejects writes", async () => {
    const { connect } = await import("@altimateai/drivers/sqlite")
    const dbPath = join(tmpDir, "readonly-write-test.db")

    // Create a database first
    const writer = await connect({ type: "sqlite", path: dbPath })
    await writer.connect()
    await writer.execute("CREATE TABLE items (id INTEGER)")
    await writer.close()

    // Open readonly and verify writes fail
    const reader = await connect({ type: "sqlite", path: dbPath, readonly: true })
    await reader.connect()
    expect(() => reader.execute("INSERT INTO items VALUES (1)")).toThrow()
    await reader.close()
  })

  test("readonly connection does not create nonexistent file", async () => {
    const { connect } = await import("@altimateai/drivers/sqlite")
    const dbPath = join(tmpDir, "ghost-file.db")

    const reader = await connect({ type: "sqlite", path: dbPath, readonly: true })
    // Should throw because the file doesn't exist and create=false
    expect(() => reader.connect()).toThrow()
    expect(existsSync(dbPath)).toBe(false)
  })
})
