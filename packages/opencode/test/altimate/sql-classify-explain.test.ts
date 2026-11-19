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

  test("Postgres option lists accept only documented options", () => {
    for (const options of ["(BOGUS TRUE)", "(ANALYZE, (FORMAT JSON)", "(FORMAT XML2)", "(ANALYZE,)", "()", "(ANALYZE) (VERBOSE)"]) {
      expect(type(`EXPLAIN ${options} SELECT 1`, "postgres")).toBe("write")
    }
    for (const options of ["(ANALYZE TRUE, BUFFERS off, SERIALIZE BINARY, FORMAT YAML)", "( analyze , format json )"]) {
      expect(type(`EXPLAIN ${options} SELECT 1`, "postgres")).toBe("read")
    }
    expect(type("EXPLAIN(FORMAT JSON)SELECT 1", "postgres")).toBe("read")
    expect(type("EXPLAIN(FORMAT JSON)DELETE FROM t", "postgres")).toBe("write")
  })

  test("EXPLAIN (ANALYZE) of a write stays a write", () => {
    for (const sql of [
      "EXPLAIN (ANALYZE) DELETE FROM t",
      "EXPLAIN (ANALYZE TRUE, FORMAT JSON) UPDATE t SET a = 1",
      "EXPLAIN (ANALYZE) INSERT INTO t SELECT 1",
      "EXPLAIN (ANALYZE) SELECT 1 INTO t2",
      "EXPLAIN (ANALYZE) WITH a AS (DELETE FROM t RETURNING *) SELECT * FROM a",
      "EXPLAIN(ANALYZE)DELETE FROM t",
    ]) {
      expect(type(sql, "postgres")).toBe("write")
    }
  })

  test("a parenthesized option list is not an option outside Postgres", () => {
    for (const dialect of ["snowflake", "mysql", "bigquery", "sqlserver", "databricks", "redshift", "duckdb"]) {
      for (const options of ["(FORMAT JSON)", "(BOGUS TRUE)", "(ANALYZE)"]) {
        expect(type(`EXPLAIN ${options} SELECT 1`, dialect)).toBe("write")
      }
    }
    expect(type("EXPLAIN (FORMAT JSON) SELECT 1", undefined as unknown as string)).toBe("write")
  })

  test("the postgresql alias takes no option list, so hidden statements cannot slip through", () => {
    for (const sql of [
      "EXPLAIN (ANALYZE) SELECT $$--$$ AS a; CLUSTER t",
      "EXPLAIN (ANALYZE) SELECT $$--$$ AS a; CHECKPOINT",
      "EXPLAIN (ANALYZE) SELECT $$--$$ AS a; NOTIFY channel",
      "EXPLAIN VERBOSE SELECT $$--$$ AS a; CLUSTER t",
      "EXPLAIN ANALYZE SELECT $$--$$ AS a; CHECKPOINT",
      "EXPLAIN VERBOSE SELECT $t$--$t$ AS a; NOTIFY channel",
      "EXPLAIN SELECT $$--$$ AS a; CHECKPOINT",
    ]) {
      expect(type(sql, "postgresql")).toBe("write")
      expect(type(sql, "postgres")).toBe("write")
    }
    expect(type("EXPLAIN (FORMAT JSON) SELECT 1", "postgresql")).toBe("write")
  })

  test("nested optioned EXPLAIN is a write", () => {
    expect(type("EXPLAIN USING JSON EXPLAIN USING JSON SELECT 1", "snowflake")).toBe("write")
    expect(type("EXPLAIN COST EXPLAIN COST SELECT 1", "databricks")).toBe("write")
    expect(type("EXPLAIN (FORMAT JSON) EXPLAIN (FORMAT JSON) SELECT 1", "postgres")).toBe("write")
  })

  test("statements after text the lexer reads as a comment are not hidden from the parser", () => {
    for (const dialect of ["databricks", "spark", "hive"]) {
      for (const quote of ["$$", "$t$"]) {
        const literal = `${quote}--${quote}`
        expect(type(`EXPLAIN COST SELECT ${literal} AS a; DELETE FROM t`, dialect)).toBe("write")
        expect(type(`EXPLAIN SELECT ${literal} AS a; DELETE FROM t`, dialect)).toBe("write")
      }
    }
    expect(type("EXPLAIN COST SELECT 1 -- note; not a statement", "databricks")).toBe("read")
  })

  test("a long option list is classified in linear time", () => {
    for (const filler of [" ", "\n", "((("]) {
      const sql = "EXPLAIN (" + filler.repeat(64_000) + "FORMAT JSON) SELECT 1"
      const start = performance.now()
      type(sql, "postgres")
      expect(performance.now() - start).toBeLessThan(200)
    }
    for (const [sql, dialect] of [
      ["EXPLAIN USING JSON SELECT 1;".repeat(64_000), "snowflake"],
      ["EXPLAIN (FORMAT JSON) SELECT 1;".repeat(64_000), "postgres"],
    ]) {
      const begin = performance.now()
      expect(type(sql, dialect)).toBe("write")
      expect(performance.now() - begin).toBeLessThan(1_000)
    }
    const items = "EXPLAIN (" + "ANALYZE, ".repeat(8_000) + "FORMAT JSON) SELECT 1"
    const start = performance.now()
    expect(type(items, "postgres")).toBe("read")
    expect(performance.now() - start).toBeLessThan(200)
  })

  test("plain EXPLAIN is unchanged", () => {
    for (const dialect of ["snowflake", "postgres", "bigquery", "redshift", "mysql"]) {
      expect(type("EXPLAIN SELECT 1", dialect)).toBe("read")
      expect(type("EXPLAIN DELETE FROM t", dialect)).toBe("write")
    }
    expect(type("EXPLAIN ANALYZE DELETE FROM t", "postgres")).toBe("write")
  })
})
