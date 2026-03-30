/**
 * Unit tests for ClickHouse driver logic:
 * - DDL vs SELECT routing (command vs query)
 * - LIMIT injection and bypass prevention
 * - Truncation detection
 * - Nullable detection from type string
 * - Connection guard (execute before connect)
 * - Binds parameter is silently ignored
 */
import { describe, test, expect, mock, beforeEach } from "bun:test"

// --- Mock @clickhouse/client ---

let mockCommandCalls: any[] = []
let mockQueryCalls: any[] = []
let mockQueryResult: any[] = []
let mockCloseCalls = 0

function resetMocks() {
  mockCommandCalls = []
  mockQueryCalls = []
  mockQueryResult = []
  mockCloseCalls = 0
}

mock.module("@clickhouse/client", () => ({
  createClient: (_config: any) => ({
    command: async (opts: any) => {
      mockCommandCalls.push(opts)
    },
    query: async (opts: any) => {
      mockQueryCalls.push(opts)
      return { json: async () => mockQueryResult }
    },
    close: async () => {
      mockCloseCalls++
    },
  }),
}))

// Import after mocking
const { connect } = await import("../src/clickhouse")

describe("ClickHouse driver unit tests", () => {
  let connector: Awaited<ReturnType<typeof connect>>

  beforeEach(async () => {
    resetMocks()
    connector = await connect({ host: "localhost", port: 8123 })
    await connector.connect()
  })

  // --- DDL vs SELECT routing ---

  describe("DDL routing via client.command()", () => {
    const ddlStatements = [
      "INSERT INTO t VALUES (1, 'a')",
      "CREATE TABLE t (id UInt32) ENGINE = MergeTree()",
      "DROP TABLE t",
      "ALTER TABLE t ADD COLUMN x String",
      "TRUNCATE TABLE t",
      "OPTIMIZE TABLE t FINAL",
      "SYSTEM RELOAD DICTIONARY",
      "SET max_memory_usage = 1000000",
    ]

    for (const sql of ddlStatements) {
      test(`routes "${sql.slice(0, 40)}..." to client.command()`, async () => {
        const result = await connector.execute(sql)
        expect(mockCommandCalls.length).toBe(1)
        expect(mockQueryCalls.length).toBe(0)
        expect(result.row_count).toBe(0)
      })
    }

    test("strips trailing semicolons from DDL", async () => {
      await connector.execute("DROP TABLE t;  ")
      expect(mockCommandCalls[0].query).toBe("DROP TABLE t")
    })
  })

  describe("SELECT routing via client.query()", () => {
    test("routes SELECT to client.query()", async () => {
      mockQueryResult = [{ id: 1, name: "test" }]
      await connector.execute("SELECT id, name FROM t")
      expect(mockQueryCalls.length).toBe(1)
      expect(mockCommandCalls.length).toBe(0)
    })

    test("routes SHOW to client.query()", async () => {
      mockQueryResult = [{ name: "db1" }]
      await connector.execute("SHOW DATABASES")
      expect(mockQueryCalls.length).toBe(1)
    })

    test("routes DESCRIBE to client.query()", async () => {
      mockQueryResult = [{ name: "col1", type: "String" }]
      await connector.execute("DESCRIBE TABLE t")
      expect(mockQueryCalls.length).toBe(1)
    })

    test("routes EXPLAIN to client.query()", async () => {
      mockQueryResult = [{ explain: "ReadFromMergeTree" }]
      await connector.execute("EXPLAIN SELECT 1")
      expect(mockQueryCalls.length).toBe(1)
    })
  })

  // --- LIMIT injection ---

  describe("LIMIT injection", () => {
    test("appends LIMIT to WITH...SELECT without one", async () => {
      mockQueryResult = [{ id: 1 }]
      await connector.execute("WITH cte AS (SELECT * FROM t) SELECT * FROM cte", 10)
      expect(mockQueryCalls[0].query).toContain("LIMIT 11")
    })

    test("does NOT double-LIMIT WITH...SELECT that already has one", async () => {
      mockQueryResult = [{ id: 1 }]
      await connector.execute("WITH cte AS (SELECT * FROM t) SELECT * FROM cte LIMIT 5", 10)
      expect(mockQueryCalls[0].query).not.toContain("LIMIT 11")
    })

    test("appends LIMIT to SELECT without one", async () => {
      mockQueryResult = [{ id: 1 }]
      await connector.execute("SELECT * FROM t", 10)
      expect(mockQueryCalls[0].query).toContain("LIMIT 11")
    })

    test("does NOT append LIMIT to SELECT that already has one", async () => {
      mockQueryResult = [{ id: 1 }]
      await connector.execute("SELECT * FROM t LIMIT 5", 10)
      expect(mockQueryCalls[0].query).not.toContain("LIMIT 11")
    })

    test("does NOT append LIMIT to SHOW/DESCRIBE/EXPLAIN/EXISTS", async () => {
      mockQueryResult = [{ name: "t" }]

      await connector.execute("SHOW TABLES", 10)
      expect(mockQueryCalls[0].query).not.toContain("LIMIT")

      mockQueryCalls = []
      await connector.execute("DESCRIBE TABLE t", 10)
      expect(mockQueryCalls[0].query).not.toContain("LIMIT")

      mockQueryCalls = []
      await connector.execute("EXISTS TABLE t", 10)
      expect(mockQueryCalls[0].query).not.toContain("LIMIT")
    })

    test("does NOT append LIMIT when limit=0 (unlimited)", async () => {
      mockQueryResult = [{ id: 1 }, { id: 2 }]
      await connector.execute("SELECT * FROM t", 0)
      expect(mockQueryCalls[0].query).not.toContain("LIMIT")
    })

    test("uses default limit=1000 when limit is undefined", async () => {
      mockQueryResult = [{ id: 1 }]
      await connector.execute("SELECT * FROM t")
      expect(mockQueryCalls[0].query).toContain("LIMIT 1001")
    })

    test("LIMIT in SQL comment does NOT prevent LIMIT injection", async () => {
      mockQueryResult = [{ id: 1 }]
      await connector.execute("SELECT * FROM t -- LIMIT 100", 10)
      // Injected LIMIT must be on its own line, NOT inside the trailing comment
      expect(mockQueryCalls[0].query).toBe("SELECT * FROM t -- LIMIT 100\nLIMIT 11")
    })

    test("LIMIT in block comment does NOT prevent LIMIT injection", async () => {
      mockQueryResult = [{ id: 1 }]
      await connector.execute("SELECT * FROM t /* LIMIT 50 */", 10)
      expect(mockQueryCalls[0].query).toBe("SELECT * FROM t /* LIMIT 50 */\nLIMIT 11")
    })

    test("real LIMIT in SQL still prevents double LIMIT", async () => {
      mockQueryResult = [{ id: 1 }]
      await connector.execute("SELECT * FROM t LIMIT 5 -- max rows", 10)
      expect(mockQueryCalls[0].query).not.toContain("LIMIT 11")
    })

    test("trailing comment does NOT hide injected LIMIT", async () => {
      mockQueryResult = [{ id: 1 }]
      await connector.execute("SELECT * FROM t -- my note", 10)
      // LIMIT must be on a new line so trailing comments don't swallow it
      expect(mockQueryCalls[0].query).toContain("\nLIMIT 11")
    })

    test("leading comment does NOT bypass LIMIT injection", async () => {
      mockQueryResult = [{ id: 1 }]
      await connector.execute("-- my query\nSELECT * FROM t", 10)
      expect(mockQueryCalls[0].query).toContain("LIMIT 11")
    })

    test("string literal with comment-like content does NOT break LIMIT check", async () => {
      mockQueryResult = [{ id: 1 }]
      await connector.execute("SELECT '-- LIMIT 100' FROM t", 10)
      expect(mockQueryCalls[0].query).toContain("LIMIT 11")
    })

    test("doubled-quote escaped string does NOT break LIMIT check", async () => {
      mockQueryResult = [{ id: 1 }]
      await connector.execute("SELECT 'it''s -- LIMIT 5' FROM t", 10)
      expect(mockQueryCalls[0].query).toContain("LIMIT 11")
    })

    test("leading block comment does NOT bypass LIMIT injection", async () => {
      mockQueryResult = [{ id: 1 }]
      await connector.execute("/* analytics query */ SELECT * FROM t", 10)
      expect(mockQueryCalls[0].query).toContain("LIMIT 11")
    })

    test("multi-line block comment before SELECT does NOT bypass LIMIT", async () => {
      mockQueryResult = [{ id: 1 }]
      await connector.execute("/*\n * Report query\n * Author: test\n */\nSELECT * FROM t", 10)
      expect(mockQueryCalls[0].query).toContain("LIMIT 11")
    })

    test("backslash-escaped string does NOT break LIMIT check", async () => {
      mockQueryResult = [{ id: 1 }]
      await connector.execute("SELECT 'path\\\\to\\'s -- LIMIT 5' FROM t", 10)
      expect(mockQueryCalls[0].query).toContain("LIMIT 11")
    })

    test("leading comment does NOT misroute SELECT as DDL", async () => {
      mockQueryResult = [{ id: 1 }]
      await connector.execute("-- INSERT note\nSELECT * FROM t", 10)
      expect(mockQueryCalls.length).toBe(1)
      expect(mockCommandCalls.length).toBe(0)
    })

    test("block comment containing DDL keyword does NOT misroute SELECT", async () => {
      mockQueryResult = [{ id: 1 }]
      await connector.execute("/* DROP TABLE note */ SELECT * FROM t", 10)
      expect(mockQueryCalls.length).toBe(1)
      expect(mockCommandCalls.length).toBe(0)
    })
  })

  // --- Truncation detection ---

  describe("truncation detection", () => {
    test("detects truncation when rows exceed limit", async () => {
      mockQueryResult = Array.from({ length: 6 }, (_, i) => ({ id: i }))
      const result = await connector.execute("SELECT * FROM t", 5)
      expect(result.truncated).toBe(true)
      expect(result.row_count).toBe(5)
      expect(result.rows.length).toBe(5)
    })

    test("no truncation when rows equal limit", async () => {
      mockQueryResult = Array.from({ length: 5 }, (_, i) => ({ id: i }))
      const result = await connector.execute("SELECT * FROM t", 5)
      expect(result.truncated).toBe(false)
      expect(result.row_count).toBe(5)
    })

    test("no truncation when rows below limit", async () => {
      mockQueryResult = [{ id: 1 }]
      const result = await connector.execute("SELECT * FROM t", 10)
      expect(result.truncated).toBe(false)
      expect(result.row_count).toBe(1)
    })

    test("limit=0 returns all rows without truncation", async () => {
      mockQueryResult = Array.from({ length: 100 }, (_, i) => ({ id: i }))
      const result = await connector.execute("SELECT * FROM t", 0)
      expect(result.truncated).toBe(false)
      expect(result.row_count).toBe(100)
    })

    test("empty result returns correctly", async () => {
      mockQueryResult = []
      const result = await connector.execute("SELECT * FROM t", 10)
      expect(result.row_count).toBe(0)
      expect(result.columns).toEqual([])
      expect(result.truncated).toBe(false)
    })
  })

  // --- Nullable detection ---

  describe("describeTable nullable detection", () => {
    test("detects Nullable(String) as nullable", async () => {
      mockQueryResult = [{ name: "col1", type: "Nullable(String)" }]
      const cols = await connector.describeTable("default", "t")
      expect(cols[0].nullable).toBe(true)
    })

    test("detects String as non-nullable", async () => {
      mockQueryResult = [{ name: "col1", type: "String" }]
      const cols = await connector.describeTable("default", "t")
      expect(cols[0].nullable).toBe(false)
    })

    test("detects Nullable(UInt32) as nullable", async () => {
      mockQueryResult = [{ name: "col1", type: "Nullable(UInt32)" }]
      const cols = await connector.describeTable("default", "t")
      expect(cols[0].nullable).toBe(true)
    })

    test("Array(Nullable(String)) is NOT nullable at column level", async () => {
      // The column itself isn't Nullable — the array elements are
      mockQueryResult = [{ name: "col1", type: "Array(Nullable(String))" }]
      const cols = await connector.describeTable("default", "t")
      expect(cols[0].nullable).toBe(false)
    })

    test("LowCardinality(Nullable(String)) IS nullable — LowCardinality is storage optimization", async () => {
      mockQueryResult = [{ name: "col1", type: "LowCardinality(Nullable(String))" }]
      const cols = await connector.describeTable("default", "t")
      expect(cols[0].nullable).toBe(true)
    })

    test("LowCardinality(String) is NOT nullable", async () => {
      mockQueryResult = [{ name: "col1", type: "LowCardinality(String)" }]
      const cols = await connector.describeTable("default", "t")
      expect(cols[0].nullable).toBe(false)
    })

    test("LowCardinality(Nullable(FixedString(32))) IS nullable — nested inner type", async () => {
      mockQueryResult = [{ name: "col1", type: "LowCardinality(Nullable(FixedString(32)))" }]
      const cols = await connector.describeTable("default", "t")
      expect(cols[0].nullable).toBe(true)
    })

    test("Map(String, Nullable(UInt32)) is NOT nullable at column level", async () => {
      // The map values are nullable, but the column itself is not
      mockQueryResult = [{ name: "col1", type: "Map(String, Nullable(UInt32))" }]
      const cols = await connector.describeTable("default", "t")
      expect(cols[0].nullable).toBe(false)
    })

    test("Tuple(Nullable(String), UInt32) is NOT nullable at column level", async () => {
      mockQueryResult = [{ name: "col1", type: "Tuple(Nullable(String), UInt32)" }]
      const cols = await connector.describeTable("default", "t")
      expect(cols[0].nullable).toBe(false)
    })

    test("handles empty/missing type gracefully", async () => {
      mockQueryResult = [{ name: "col1", type: undefined }]
      const cols = await connector.describeTable("default", "t")
      expect(cols[0].nullable).toBe(false)
    })
  })

  // --- Connection guard ---

  describe("connection lifecycle", () => {
    test("execute before connect throws clear error", async () => {
      const freshConnector = await connect({ host: "localhost" })
      // Don't call connect()
      await expect(freshConnector.execute("SELECT 1")).rejects.toThrow("not connected")
    })

    test("close is idempotent", async () => {
      await connector.close()
      await connector.close() // should not throw
      expect(mockCloseCalls).toBe(1) // only called once
    })
  })

  // --- Binds parameter ---

  describe("binds parameter", () => {
    test("binds parameter is silently ignored", async () => {
      mockQueryResult = [{ id: 1 }]
      // Should not throw — binds are ignored
      const result = await connector.execute("SELECT 1", 10, ["unused", "binds"])
      expect(result.row_count).toBe(1)
    })

    test("empty binds array works fine", async () => {
      mockQueryResult = [{ id: 1 }]
      const result = await connector.execute("SELECT 1", 10, [])
      expect(result.row_count).toBe(1)
    })
  })

  // --- Column mapping ---

  describe("result format", () => {
    test("maps rows to column-ordered arrays", async () => {
      mockQueryResult = [
        { id: 1, name: "alice", age: 30 },
        { id: 2, name: "bob", age: 25 },
      ]
      const result = await connector.execute("SELECT * FROM t", 10)
      expect(result.columns).toEqual(["id", "name", "age"])
      expect(result.rows).toEqual([
        [1, "alice", 30],
        [2, "bob", 25],
      ])
    })
  })

  // --- listTables type detection ---

  describe("listTables engine-to-type mapping", () => {
    test("MergeTree engines map to table", async () => {
      mockQueryResult = [{ name: "t1", engine: "MergeTree" }]
      const tables = await connector.listTables("default")
      expect(tables[0].type).toBe("table")
    })

    test("MaterializedView maps to view", async () => {
      mockQueryResult = [{ name: "v1", engine: "MaterializedView" }]
      const tables = await connector.listTables("default")
      expect(tables[0].type).toBe("view")
    })

    test("View maps to view", async () => {
      mockQueryResult = [{ name: "v2", engine: "View" }]
      const tables = await connector.listTables("default")
      expect(tables[0].type).toBe("view")
    })
  })
})
