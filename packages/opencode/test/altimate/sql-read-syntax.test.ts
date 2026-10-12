import { describe, expect, test } from "bun:test"
import { classifyAndCheck, isSingleQuery } from "../../src/altimate/tools/sql-classify"
import { readSql } from "../../src/altimate/tools/sql-check"
import fixtures from "./fixtures/read-syntax-errors.json"

describe("read-only dialect syntax", () => {
  for (const fixture of fixtures) {
    test(fixture.name, () => {
      const sql = fixture.input.query ?? fixture.input.sql!
      expect(classifyAndCheck(sql, fixture.dialect)).toEqual({ queryType: "read", blocked: false })
      expect(isSingleQuery(sql, fixture.dialect)).toBe(true)
      if (fixture.input.sql) expect(readSql(sql, fixture.dialect)).toBe(sql)
    })
  }

  test("DuckDB unpivot accepts a table or a select source", () => {
    for (const source of ["monthly_sales", "(SELECT jan, feb FROM monthly_sales)"]) {
      const sql = `UNPIVOT ${source} ON jan, feb INTO NAME month VALUE sales`
      expect(classifyAndCheck(sql, "duckdb")).toEqual({ queryType: "read", blocked: false })
      expect(isSingleQuery(sql, "duckdb")).toBe(true)
    }
  })

  test("DuckDB pivots and unpivots remain reads inside CTEs and derived tables", () => {
    for (const sql of [
      "WITH t AS (SELECT 1 region, 2 cat) PIVOT t ON cat USING count(*)",
      "WITH t AS (SELECT 1 jan, 2 feb) UNPIVOT t ON jan, feb INTO NAME month VALUE sales",
      "SELECT * FROM (UNPIVOT monthly_sales ON jan, feb INTO NAME month VALUE sales)",
      "WITH t AS (UNPIVOT monthly_sales ON jan, feb INTO NAME month VALUE sales) SELECT * FROM t",
    ]) {
      expect(classifyAndCheck(sql, "duckdb")).toEqual({ queryType: "read", blocked: false })
      expect(isSingleQuery(sql, "duckdb")).toBe(true)
    }
  })

  test("negated glob is read-only on SQLite and DuckDB", () => {
    for (const dialect of ["sqlite", "duckdb"]) {
      expect(classifyAndCheck("SELECT 'abc' NOT GLOB 'a*'", dialect)).toEqual({ queryType: "read", blocked: false })
    }
  })

  test("dialect syntax cannot hide writes, extra statements, or broken quoting", () => {
    for (const sql of [
      "SELECT 10//3; DELETE FROM users",
      "SELECT 10//3 INTO copy FROM users",
      "SELECT * FROM users WHERE name NOT GLOB 'a*'; UPDATE users SET name = 'b'",
      "PIVOT (DELETE FROM users RETURNING *) ON name USING count(*)",
      "PIVOT users ON name USING count(*); COPY users TO '/tmp/export.csv'",
      "UNPIVOT (DELETE FROM users RETURNING *) ON jan, feb INTO NAME month VALUE sales",
      "UNPIVOT monthly_sales ON jan, feb INTO NAME month VALUE sales; SET threads = 1",
      "SELECT * INTO name FROM (UNPIVOT monthly_sales ON jan, feb INTO NAME month VALUE sales)",
      "SELECT unpivot INTO name FROM users",
      "WITH t AS (SELECT 1 unpivot) SELECT unpivot INTO name FROM t",
      "WITH t AS (UNPIVOT monthly_sales ON jan, feb INTO NAME month VALUE sales) SELECT * INTO name FROM t",
      "UNPIVOT (SELECT * INTO name FROM monthly_sales) ON jan, feb INTO NAME month VALUE sales",
      "SELECT 10//3, 'unterminated",
      "SELECT 10//3; /*! DELETE FROM users */",
      "SELECT 10//3; CHECKPOINT",
      "PIVOT users ON name USING count(*); CHECKPOINT",
    ]) {
      expect(classifyAndCheck(sql, "duckdb").queryType).toBe("write")
    }
    expect(classifyAndCheck("SELECT 10//3; TRUNCATE users", "duckdb")).toEqual({ queryType: "write", blocked: true })
  })

  test("unsupported dialects do not inherit DuckDB-only syntax", () => {
    expect(classifyAndCheck("SELECT 10//3", "sqlite").queryType).toBe("write")
    expect(classifyAndCheck("SELECT 10//3", "postgres").queryType).toBe("write")
    expect(classifyAndCheck("PIVOT users ON name USING count(*)", "sqlite").queryType).toBe("write")
  })
})
