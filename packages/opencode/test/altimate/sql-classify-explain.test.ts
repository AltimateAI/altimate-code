import { describe, expect, test } from "bun:test"
import { classifyAndCheck } from "../../src/altimate/tools/sql-classify"

const type = (sql: string, dialect: string) => classifyAndCheck(sql, dialect).queryType

describe("EXPLAIN with options", () => {
  const readInner = ["SELECT 1", "SELECT * FROM t WHERE a = 'x;y'", "WITH a AS (SELECT 1) SELECT * FROM a"]
  const writeInner = [
    "INSERT INTO t VALUES (1)",
    "DELETE FROM t",
    "UPDATE t SET a = 1",
    "MERGE INTO t USING s ON t.a = s.a WHEN MATCHED THEN DELETE",
    "CREATE TABLE t2 AS SELECT 1",
    "SELECT 1 INTO t2",
    "WITH a AS (DELETE FROM t RETURNING *) SELECT * FROM a",
  ]

  for (const format of ["JSON", "TEXT", "TABULAR"]) {
    test(`Snowflake EXPLAIN USING ${format} is a read only for a read`, () => {
      for (const inner of readInner) expect(type(`EXPLAIN USING ${format} ${inner}`, "snowflake")).toBe("read")
      for (const inner of writeInner) expect(type(`EXPLAIN USING ${format} ${inner}`, "snowflake")).toBe("write")
    })
  }

  test("Snowflake EXPLAIN USING tolerates case, whitespace and comments", () => {
    for (const sql of [
      "explain using json select 1",
      "ExPlAiN   USING\n\tTeXt   select 1",
      "/* lead */ EXPLAIN /* a */ USING /* b */ JSON /* c */ SELECT 1 -- tail",
      "EXPLAIN USING JSON SELECT 1;",
    ]) {
      expect(classifyAndCheck(sql, "snowflake")).toEqual({ queryType: "read", blocked: false })
    }
    expect(type("explain using json /* c */ delete from t", "snowflake")).toBe("write")
  })

  test("Snowflake EXPLAIN USING with more than one statement is not a read", () => {
    expect(type("EXPLAIN USING JSON SELECT 1", "snowflake")).toBe("read")
    for (const sql of [
      "EXPLAIN USING JSON SELECT 1; SELECT 2",
      "EXPLAIN USING JSON SELECT 1; DELETE FROM t",
      "EXPLAIN USING JSON SELECT 1; DROP TABLE t",
      "SELECT 1; EXPLAIN USING JSON DELETE FROM t",
      "SELECT 1; EXPLAIN USING JSON SELECT 2",
    ]) {
      expect(type(sql, "snowflake")).toBe("write")
    }
  })

  test("Snowflake EXPLAIN USING with an unknown format or no statement is not a read", () => {
    expect(type("EXPLAIN USING TEXT SELECT 1", "snowflake")).toBe("read")
    for (const sql of ["EXPLAIN USING XML SELECT 1", "EXPLAIN USING JSON", "EXPLAIN USING JSON ;"]) {
      expect(type(sql, "snowflake")).toBe("write")
    }
  })

  test("USING is not an EXPLAIN option outside Snowflake", () => {
    expect(type("EXPLAIN USING JSON SELECT 1", "snowflake")).toBe("read")
    for (const dialect of ["postgres", "mysql", "bigquery", "databricks"]) {
      expect(type("EXPLAIN USING JSON SELECT 1", dialect)).toBe("write")
    }
  })

  test("Databricks EXPLAIN modes of a read are reads, of a write are writes", () => {
    for (const mode of ["EXTENDED", "CODEGEN", "COST", "FORMATTED"]) {
      expect(type(`EXPLAIN ${mode} SELECT 1`, "databricks")).toBe("read")
      expect(type(`explain ${mode.toLowerCase()} select 1`, "databricks")).toBe("read")
      expect(type(`EXPLAIN ${mode} DELETE FROM t`, "databricks")).toBe("write")
      expect(type(`EXPLAIN ${mode} INSERT INTO t SELECT 1`, "databricks")).toBe("write")
      expect(type(`EXPLAIN ${mode} SELECT 1; DELETE FROM t`, "databricks")).toBe("write")
    }
    expect(type("EXPLAIN EXTENDED SELECT 1", "snowflake")).toBe("write")
  })

  test("Postgres EXPLAIN option lists follow the explained statement", () => {
    for (const options of ["(FORMAT JSON)", "(ANALYZE, FORMAT JSON)", "(VERBOSE, COSTS OFF)"]) {
      expect(type(`EXPLAIN ${options} SELECT 1`, "postgres")).toBe("read")
      expect(type(`EXPLAIN ${options} DELETE FROM t`, "postgres")).toBe("write")
      expect(type(`EXPLAIN ${options} INSERT INTO t VALUES (1)`, "postgres")).toBe("write")
      expect(type(`EXPLAIN ${options} SELECT 1; DELETE FROM t`, "postgres")).toBe("write")
    }
  })

  test("plain EXPLAIN is unchanged", () => {
    for (const dialect of ["snowflake", "postgres", "bigquery", "redshift", "mysql"]) {
      expect(type("EXPLAIN SELECT 1", dialect)).toBe("read")
      expect(type("EXPLAIN DELETE FROM t", dialect)).toBe("write")
    }
    expect(type("EXPLAIN ANALYZE DELETE FROM t", "postgres")).toBe("write")
  })
})
