import { describe, expect, test } from "bun:test"
import { classifyAndCheck, isSingleQuery } from "../../src/altimate/tools/sql-classify"
import { maskSql, statementsOf, tokenizeSql } from "../../src/altimate/tools/sql-tokenize"

describe("SQL line comment boundaries", () => {
  for (const dialect of [
    "sqlserver",
    "tsql",
    "postgres",
    "duckdb",
    "bigquery",
    "spark",
    "databricks",
    "trino",
    "unknown",
    undefined,
  ]) {
    for (const newline of ["\r", "\n", "\r\n"]) {
      test(`${dialect ?? "omitted"}: ${JSON.stringify(newline)} exposes hard-denied statements`, () => {
        const sql = `SELECT 1 -- x${newline}; DROP SCHEMA s`
        expect(statementsOf(sql, dialect)).toEqual(["SELECT 1", "DROP SCHEMA s"])
        expect(classifyAndCheck(sql, dialect)).toMatchObject({ queryType: "write", blocked: true })
        expect(isSingleQuery(sql, dialect)).toBe(false)
      })
    }
  }

  for (const dialect of ["sqlserver", "tsql", "postgres", "duckdb", "bigquery"]) {
    test(`${dialect}: CR does not turn quoted SQL or a comment into a statement`, () => {
      expect(classifyAndCheck("SELECT '-- x\r; DROP SCHEMA s' AS text", dialect)).toEqual({
        queryType: "read",
        blocked: false,
      })
      expect(classifyAndCheck("SELECT 1 -- ; DROP SCHEMA s\r", dialect)).toEqual({
        queryType: "read",
        blocked: false,
      })
      expect(classifyAndCheck("SELECT 1 -- comment\r\n; SELECT 2", dialect)).toEqual({
        queryType: "read",
        blocked: false,
      })
    })
  }

  for (const dialect of ["mysql", "sqlite", "clickhouse"]) {
    test(`${dialect}: CR remains inside an LF-terminated comment`, () => {
      const sql = "SELECT 1 -- x\r; DROP SCHEMA s"
      expect(statementsOf(sql, dialect)).toEqual(["SELECT 1"])
      expect(classifyAndCheck(sql, dialect)).toEqual({ queryType: "read", blocked: false })
      expect(classifyAndCheck(`${sql}\n; DROP SCHEMA actual`, dialect)).toMatchObject({
        queryType: "write",
        blocked: true,
      })
    })
  }
})

describe("dialect-specific line comment markers", () => {
  for (const [dialect, marker] of [
    ["mysql", "#"],
    ["mariadb", "#"],
    ["bigquery", "#"],
    ["clickhouse", "# "],
    ["clickhouse", "#!"],
    ["clickhouse", "//"],
  ]) {
    test(`${dialect}: ${marker} comments cannot quote away a following hard deny`, () => {
      const sql = `SELECT 1 ${marker} '\n; DROP SCHEMA s -- '`
      expect(statementsOf(sql, dialect)).toEqual(["SELECT 1", "DROP SCHEMA s"])
      expect(classifyAndCheck(sql, dialect)).toMatchObject({ queryType: "write", blocked: true })
    })

    test(`${dialect}: ${marker} comment text stays non-executable`, () => {
      const sql = `SELECT 1 ${marker} '; DROP SCHEMA s`
      expect(tokenizeSql(sql, dialect).complete).toBe(true)
      expect(statementsOf(sql, dialect)).toEqual(["SELECT 1"])
      expect(maskSql(tokenizeSql(sql, dialect).tokens)).not.toContain("DROP SCHEMA")
      expect(classifyAndCheck(sql, dialect).blocked).toBe(false)
    })
  }

  test("BigQuery hash comments end at CR", () => {
    const sql = "SELECT 1 # x\r; DROP SCHEMA s"
    expect(statementsOf(sql, "bigquery")).toEqual(["SELECT 1", "DROP SCHEMA s"])
    expect(classifyAndCheck(sql, "bigquery")).toMatchObject({ queryType: "write", blocked: true })
  })

  test("DuckDB // remains integer division and PostgreSQL # remains an operator", () => {
    expect(classifyAndCheck("SELECT 8 // 2; DROP SCHEMA s", "duckdb")).toMatchObject({
      queryType: "write",
      blocked: true,
    })
    expect(classifyAndCheck("SELECT 8 // 2", "duckdb")).toEqual({ queryType: "read", blocked: false })
    expect(classifyAndCheck("SELECT 8 # 2; DROP SCHEMA s", "postgres")).toMatchObject({
      queryType: "write",
      blocked: true,
    })
    expect(classifyAndCheck("SELECT 8 # 2", "postgres")).toEqual({ queryType: "read", blocked: false })
  })
})

describe("block comment nesting follows the dialect", () => {
  for (const dialect of [
    "mysql",
    "mariadb",
    "sqlite",
    "bigquery",
    "redshift",
    "snowflake",
    "trino",
    "unknown",
    undefined,
  ]) {
    test(`${dialect ?? "omitted"}: an inner opener cannot hide code after the first closer`, () => {
      const sql = "SELECT 1 /* outer /* */; DROP SCHEMA s -- */"
      expect(statementsOf(sql, dialect)).toEqual(["SELECT 1", "DROP SCHEMA s"])
      expect(classifyAndCheck(sql, dialect)).toMatchObject({ queryType: "write", blocked: true })
    })
  }

  for (const dialect of ["postgres", "duckdb", "sqlserver", "tsql", "clickhouse", "spark", "databricks"]) {
    test(`${dialect}: properly nested comment contents stay non-executable`, () => {
      const sql = "SELECT 1 /* outer /* inner */; DROP SCHEMA s */"
      expect(statementsOf(sql, dialect)).toEqual(["SELECT 1"])
      expect(classifyAndCheck(sql, dialect)).toEqual({ queryType: "read", blocked: false })
      expect(classifyAndCheck(`${sql}; DROP SCHEMA actual`, dialect)).toMatchObject({
        queryType: "write",
        blocked: true,
      })
    })
  }

  for (const dialect of ["mysql", "sqlite", "bigquery", "redshift", "snowflake"]) {
    test(`${dialect}: an ordinary block comment is still safe`, () => {
      expect(classifyAndCheck("SELECT 1 /* ; DROP SCHEMA s */", dialect)).toEqual({
        queryType: "read",
        blocked: false,
      })
    })
  }
})

describe("dialect-specific quoted identifier and array boundaries", () => {
  for (const dialect of ["mysql", "mariadb", "clickhouse", "snowflake"]) {
    test(`${dialect}: ambiguous backslash strings cannot hide a call`, () => {
      const sql = String.raw`SELECT 'a\'x', sleep(1), 'a\'x'`
      expect(tokenizeSql(sql, dialect).complete).toBe(false)
      expect(classifyAndCheck(sql, dialect)).toMatchObject({ queryType: "write", blocked: false })
    })
  }

  for (const dialect of ["mysql", "clickhouse", "snowflake"]) {
    test(`${dialect}: ordinary quoted strings with function-like text remain reads`, () => {
      expect(classifyAndCheck("SELECT 'it''s sleep(1)' AS text", dialect)).toEqual({
        queryType: "read",
        blocked: false,
      })
    })
  }

  test("MySQL double-quoted strings cannot hide a call through backslash escaping", () => {
    const sql = String.raw`SELECT "a\"x", sleep(1), "a\"x"`
    expect(tokenizeSql(sql, "mysql").complete).toBe(false)
    expect(classifyAndCheck(sql, "mysql")).toMatchObject({ queryType: "write", blocked: false })
    expect(classifyAndCheck('SELECT "sleep(1)" AS text', "mysql")).toEqual({ queryType: "read", blocked: false })
  })

  for (const dialect of ["clickhouse", "bigquery", "snowflake", "duckdb", undefined]) {
    test(`${dialect ?? "omitted"}: array elements expose calls but preserve ordinary reads`, () => {
      expect(classifyAndCheck("SELECT [sleep(1)]", dialect)).toMatchObject({ queryType: "write", blocked: false })
      expect(classifyAndCheck("SELECT [abs(1), 'sleep(1)']", dialect)).toEqual({ queryType: "read", blocked: false })
    })
  }

  for (const dialect of ["spark", "databricks"]) {
    test(`${dialect}: array indexes expose calls but preserve ordinary reads`, () => {
      expect(classifyAndCheck("SELECT array(1)[sleep(1)]", dialect)).toMatchObject({
        queryType: "write",
        blocked: false,
      })
      expect(classifyAndCheck("SELECT array(1)[0]", dialect)).toEqual({ queryType: "read", blocked: false })
    })
  }

  for (const dialect of ["sqlserver", "tsql", "sqlite"]) {
    test(`${dialect}: bracket identifiers stay quoted until an actual call parenthesis`, () => {
      expect(classifyAndCheck("SELECT 1 AS [sleep(1)]", dialect)).toEqual({ queryType: "read", blocked: false })
      expect(classifyAndCheck("SELECT [sleep](1)", dialect)).toMatchObject({ queryType: "write", blocked: false })
    })
  }

  for (const dialect of ["mysql", "sqlite", "bigquery", "clickhouse", "spark", "databricks"]) {
    test(`${dialect}: backtick identifiers stay quoted until an actual call parenthesis`, () => {
      expect(classifyAndCheck("SELECT 1 AS `sleep(1)`", dialect)).toEqual({ queryType: "read", blocked: false })
      expect(classifyAndCheck("SELECT `sleep`(1)", dialect)).toMatchObject({ queryType: "write", blocked: false })
    })
  }

  for (const dialect of ["postgres", "redshift", "snowflake", "unknown", undefined]) {
    test(`${dialect ?? "omitted"}: unsupported backticks cannot hide a hard deny`, () => {
      expect(classifyAndCheck("SELECT `1; DROP SCHEMA s;`", dialect)).toMatchObject({
        queryType: "write",
        blocked: true,
      })
      expect(maskSql(tokenizeSql("SELECT `sleep(1)`", dialect).tokens)).toContain("sleep(1)")
    })
  }
})
