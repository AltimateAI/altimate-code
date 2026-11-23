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
    for (const dialect of ["snowflake", "mysql", "bigquery", "sqlserver", "databricks", "redshift"]) {
      for (const options of ["(FORMAT JSON)", "(BOGUS TRUE)", "(ANALYZE)"]) {
        expect(type(`EXPLAIN ${options} SELECT 1`, dialect)).toBe("write")
      }
    }
    expect(type("EXPLAIN (FORMAT JSON) SELECT 1", undefined as unknown as string)).toBe("write")
  })

  test("DuckDB and the postgresql alias accept their own option lists", () => {
    for (const dialect of ["duckdb", "postgresql", "postgres"]) {
      expect(type("EXPLAIN (ANALYZE, FORMAT JSON) SELECT 1", dialect)).toBe("read")
      expect(type("EXPLAIN (FORMAT YAML) SELECT 1", dialect)).toBe("read")
      expect(type("EXPLAIN (ANALYZE, FORMAT JSON) DELETE FROM t", dialect)).toBe("write")
      expect(type("EXPLAIN (BOGUS TRUE) SELECT 1", dialect)).toBe("write")
    }
  })

  test("EXPLAIN formats and options follow the dialect", () => {
    for (const format of ["HTML", "GRAPHVIZ"]) {
      expect(type(`EXPLAIN (FORMAT ${format}) SELECT 1`, "duckdb")).toBe("read")
      expect(type(`EXPLAIN (FORMAT ${format}) DELETE FROM t`, "duckdb")).toBe("write")
      expect(type(`EXPLAIN (FORMAT ${format}) SELECT 1`, "postgres")).toBe("write")
      expect(type(`EXPLAIN (FORMAT ${format}) SELECT 1`, "postgresql")).toBe("write")
    }
    expect(type("EXPLAIN (FORMAT XML) SELECT 1", "postgres")).toBe("read")
    expect(type("EXPLAIN (VERBOSE, BUFFERS) SELECT 1", "postgres")).toBe("read")
    for (const options of ["(FORMAT XML)", "(VERBOSE)", "(BUFFERS)", "(PROFILING)"]) {
      expect(type(`EXPLAIN ${options} SELECT 1`, "duckdb")).toBe("write")
    }
  })

  test("Postgres boolean spellings and the IO option are accepted", () => {
    for (const options of ["(IO TRUE)", "(ANALYZE yes)", "(BUFFERS t, COSTS n)", "(ANALYZE 1, TIMING off)"]) {
      expect(type(`EXPLAIN ${options} SELECT 1`, "postgres")).toBe("read")
      expect(type(`EXPLAIN ${options} DELETE FROM t`, "postgres")).toBe("write")
    }
  })

  test("EXPLAIN of a query with a COPY in a CTE is a write", () => {
    const copy = "WITH copied AS (COPY (SELECT 1 AS x) TO '/tmp/out.csv') SELECT * FROM copied"
    for (const sql of [`EXPLAIN (ANALYZE) ${copy}`, `EXPLAIN (FORMAT JSON) ${copy}`, `EXPLAIN ANALYZE ${copy}`, `EXPLAIN ${copy}`]) {
      expect(type(sql, "duckdb")).toBe("write")
      expect(type(sql, "postgres")).toBe("write")
    }
    expect(type("EXPLAIN (ANALYZE) SELECT 'copy' AS \"copy\"", "duckdb")).toBe("read")
    expect(type("EXPLAIN WITH c AS MATERIALIZED (COPY (SELECT 1) TO '/tmp/out.csv') SELECT * FROM c", "duckdb")).toBe("write")
  })

  test("EXPLAIN of a read over a column or table named copy is a read", () => {
    for (const dialect of ["postgres", "duckdb"]) {
      for (const sql of [
        "EXPLAIN SELECT copy FROM docs",
        "EXPLAIN (FORMAT JSON) SELECT t.copy FROM t",
        "EXPLAIN SELECT * FROM copy",
        "EXPLAIN (ANALYZE) WITH c AS (SELECT copy FROM t) SELECT * FROM c",
      ]) {
        expect(type(sql, dialect)).toBe("read")
      }
    }
  })

  test("an optioned EXPLAIN batch of reads is still a write", () => {
    for (const sql of ["EXPLAIN ANALYZE SELECT 1; SELECT 2", "EXPLAIN (FORMAT JSON) SELECT 1; SELECT 2", "SELECT 1; EXPLAIN (ANALYZE) SELECT 2"]) {
      expect(type(sql, "postgres")).toBe("write")
    }
    expect(type("EXPLAIN COST SELECT 1; SELECT 2", "databricks")).toBe("write")
  })

  test("the postgresql alias reads dollar quotes, so hidden statements cannot slip through", () => {
    for (const sql of [
      "EXPLAIN (ANALYZE) SELECT $$--$$ AS a; CLUSTER t",
      "EXPLAIN (ANALYZE) SELECT $$--$$ AS a; CHECKPOINT",
      "EXPLAIN (ANALYZE) SELECT $$--$$ AS a; NOTIFY channel",
      "EXPLAIN VERBOSE SELECT $$--$$ AS a; CLUSTER t",
      "EXPLAIN ANALYZE SELECT $$--$$ AS a; CHECKPOINT",
      "EXPLAIN VERBOSE SELECT $t$--$t$ AS a; NOTIFY channel",
      "EXPLAIN SELECT $$--$$ AS a; CHECKPOINT",
      "EXPLAIN (ANALYZE) SELECT $t1$--$t1$ AS a; CLUSTER t",
    ]) {
      expect(type(sql, "postgresql")).toBe("write")
      expect(type(sql, "postgres")).toBe("write")
    }
    expect(type("EXPLAIN (FORMAT JSON) SELECT 1", "postgresql")).toBe("read")
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
      expect(type(`EXPLAIN COST SELECT $t1$--$t1$ AS a; CHECKPOINT`, dialect)).toBe("write")
    }
    expect(type("EXPLAIN COST SELECT 1 -- note; not a statement", "databricks")).toBe("read")
  })

  test("dollar text inside a literal or comment does not stop option blanking", () => {
    for (const sql of ["EXPLAIN EXTENDED SELECT '$$' AS marker", "EXPLAIN COST SELECT 1 /* $t$ */", "EXPLAIN COST SELECT 1 -- $$"]) {
      expect(type(sql, "databricks")).toBe("read")
    }
    expect(type("EXPLAIN EXTENDED SELECT '$$' AS marker; DELETE FROM t", "databricks")).toBe("write")
  })

  test("a long option list is classified in linear time", () => {
    // Quadratic matching took seconds here; the budget leaves room for a loaded runner.
    const budget = 500
    const timed = (sql: string, dialect: string, expected: "read" | "write") => {
      const start = performance.now()
      expect(type(sql, dialect)).toBe(expected)
      expect(performance.now() - start).toBeLessThan(budget)
    }
    timed("EXPLAIN (" + " ".repeat(64_000) + "FORMAT JSON) SELECT 1", "postgres", "read")
    timed("EXPLAIN (" + "\n".repeat(64_000) + "FORMAT JSON) SELECT 1", "postgres", "read")
    timed("EXPLAIN (" + "(((".repeat(64_000) + "FORMAT JSON) SELECT 1", "postgres", "write")
    timed("EXPLAIN (" + "ANALYZE, ".repeat(8_000) + "FORMAT JSON) SELECT 1", "postgres", "read")
  })

  test("a long batch of optioned statements scales linearly", () => {
    // Four times the statements costs about four times as much; rebuilding the text per statement costs sixteen.
    const best = (statement: string, dialect: string, count: number) => {
      const sql = statement.repeat(count)
      return Math.min(
        ...[0, 1, 2].map(() => {
          const start = performance.now()
          expect(type(sql, dialect)).toBe("write")
          return performance.now() - start
        }),
      )
    }
    for (const [statement, dialect] of [
      ["EXPLAIN USING JSON SELECT 1;", "snowflake"],
      ["EXPLAIN (FORMAT JSON) SELECT 1;", "postgres"],
    ]) {
      expect(best(statement, dialect, 64_000) / best(statement, dialect, 16_000)).toBeLessThan(9)
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
