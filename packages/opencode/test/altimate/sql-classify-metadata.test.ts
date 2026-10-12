import { describe, expect, test } from "bun:test"
import { classify, classifyAndCheck } from "../../src/altimate/tools/sql-classify"

// Metadata statements are filed under the parser's "other" category. A read-only
// agent (analyst, data-explorer) denies `sql_execute_write`, so classifying them
// as writes hard-blocked `SHOW TABLES` on DuckDB/SQLite — observed on the rig's
// driver probe. They cannot modify data and must classify as reads.
describe("sql-classify: metadata statements are reads", () => {
  const reads = [
    "SHOW TABLES",
    "SHOW TABLES;",
    "show tables",
    "SHOW ALL TABLES",
    "DESCRIBE orders",
    "DESC orders",
    "DESCRIBE SELECT * FROM orders",
    "EXPLAIN SELECT count(*) FROM orders",
    "EXPLAIN ANALYZE SELECT 1",
    "PRAGMA table_info(orders)",
    "PRAGMA table_list",
    "PRAGMA index_list('orders')",
    "PRAGMA database_list;",
    "SELECT 1; SHOW TABLES",
    "-- list them\nSHOW TABLES /* all */",
  ]
  for (const sql of reads) {
    test(`read: ${JSON.stringify(sql)}`, () => {
      expect(classify(sql)).toBe("read")
      expect(classifyAndCheck(sql)).toEqual({ queryType: "read", blocked: false })
    })
  }

  const writes = [
    "PRAGMA foreign_keys = ON",
    "PRAGMA journal_mode=WAL",
    "SET search_path TO public",
    "USE other_db",
    "SHOW TABLES; DELETE FROM orders",
    "CREATE TABLE t AS SELECT 1",
    "INSERT INTO orders VALUES (1)",
    "ATTACH 'x.db' AS x",
  ]
  for (const sql of writes) {
    test(`write: ${JSON.stringify(sql)}`, () => {
      expect(classify(sql)).toBe("write")
      expect(classifyAndCheck(sql).queryType).toBe("write")
    })
  }

  test("hard denies stay blocked", () => {
    expect(classifyAndCheck("SHOW TABLES; TRUNCATE orders").blocked).toBe(true)
    expect(classifyAndCheck("DROP SCHEMA x").blocked).toBe(true)
  })
})
