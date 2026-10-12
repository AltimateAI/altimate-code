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
    "PRAGMA storage_info('orders')",
    "PRAGMA integrity_check(orders)",
    "PRAGMA main.integrity_check('orders')",
    "PRAGMA table_list",
    "PRAGMA index_list('orders')",
    "PRAGMA foreign_key_list(orders)",
    "PRAGMA main.table_info('orders')",
    "PRAGMA user_version",
    "PRAGMA journal_mode",
    "PRAGMA show_tables",
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
    "PRAGMA user_version(5)",
    "PRAGMA journal_mode(DELETE)",
    "PRAGMA wal_checkpoint(TRUNCATE)",
    "PRAGMA incremental_vacuum(100)",
    "PRAGMA optimize",
    "PRAGMA optimize(3)",
    "PRAGMA create_fts_index('orders', 'id', 'note')",
    "PRAGMA main.user_version(5)",
    "PRAGMA user_version = 5",
    "PRAGMA foreign_keys(OFF)",
    "PRAGMA unknown_setting('value')",
    "PRAGMA table_info = orders",
    "PRAGMA storage_info = orders",
    "PRAGMA integrity_check = orders",
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

describe("sql-classify: quoted comment markers cannot hide other statements", () => {
  for (const marker of ["--", "/*", "/* ; */"]) {
    for (const statement of [
      "CALL purge_all()",
      "SET ROLE admin",
      "ATTACH 'other.db' AS other",
      "EXECUTE IMMEDIATE 'DELETE FROM victim'",
      "INSTALL httpfs",
      "LOAD httpfs",
      "DETACH other",
      "VACUUM",
      "CHECKPOINT",
    ]) {
      const sql = `SELECT '${marker}' AS a; ${statement}`
      test(`write: ${sql}`, () => {
        expect(classify(sql)).toBe("write")
        expect(classifyAndCheck(sql).queryType).toBe("write")
      })
    }
  }

  test("quoted delimiters and real comments preserve safe metadata statements", () => {
    expect(classifyAndCheck("SELECT ';--/*' AS a; /* real comment */ SHOW TABLES").queryType).toBe("read")
    expect(classifyAndCheck("SELECT $$--;$$ AS a; SHOW TABLES").queryType).toBe("read")
  })
})
