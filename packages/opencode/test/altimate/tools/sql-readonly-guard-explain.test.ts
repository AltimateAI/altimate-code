import { describe, expect, test } from "bun:test"
import { classifyAndCheck, explainWrite, shellResidue } from "../../../src/altimate/tools/sql-classify"
import { readSql, writeReason } from "../../../src/altimate/tools/read-only-sql"

describe("shellResidue", () => {
  const cases: Record<string, string> = {
    "SELECT 1 2>/dev/null": "2>/dev/null",
    "SELECT * FROM t LIMIT 5 2>&1": "2>&1",
    "SELECT * FROM t >/dev/null": ">/dev/null",
    "SELECT * FROM t > /home/someone/private/out.csv": "> <file>",
    "SELECT * FROM t | grep private-name": "| grep ...",
    "SELECT * FROM t > out.csv": "> <file>",
    "SELECT * FROM t | head -20": "| head ...",
    "SELECT * FROM t LIMIT 5 2>&1 | head -n 20": "2>&1`, `| head ...",
    "SELECT * FROM t;  2>/dev/null": "2>/dev/null",
    "SELECT a FROM t ORDER BY a 2>/dev/null LIMIT 5": "2>/dev/null",
    "SELECT a FROM t 2>/dev/null | head -5": "2>/dev/null`, `| head ...",
  }
  for (const [sql, residue] of Object.entries(cases)) {
    test(`finds ${residue}`, () => {
      expect(shellResidue(sql, "postgres")).toBe(residue)
      // The residue makes the text unreadable, so it is never classified as a read.
      expect(classifyAndCheck(sql, "postgres").queryType).toBe("write")
    })
  }

  test("a comparison is not a redirect", () => {
    expect(shellResidue("SELECT a FROM t WHERE x > 2", "postgres")).toBeUndefined()
    expect(shellResidue("SELECT a FROM t WHERE x >= 2.5", "postgres")).toBeUndefined()
  })

  test("a comparison before the residue is kept", () => {
    expect(shellResidue("SELECT a FROM t WHERE flag OR x > 1.5 2>/dev/null", "postgres")).toBe("2>/dev/null")
    expect(shellResidue("SELECT a FROM t WHERE x > t.total 2>/dev/null", "postgres")).toBe("2>/dev/null")
  })

  test("SQL that parses is never offered for removal", () => {
    expect(shellResidue("SELECT a FROM t WHERE a > out.csv", "postgres")).toBeUndefined()
    expect(shellResidue("SELECT a FROM t WHERE a > b / 2", "postgres")).toBeUndefined()
  })

  test("text inside a comment or literal is not residue", () => {
    expect(shellResidue("SELECT 1 -- 2>/dev/null", "postgres")).toBeUndefined()
    expect(shellResidue("SELECT '2>/dev/null'", "postgres")).toBeUndefined()
  })

  test("a write after residue is named, not hidden in the residue", () => {
    const sql = "SELECT 1 FROM t | head -5; DROP TABLE t"
    expect(shellResidue(sql, "postgres")).toBeUndefined()
    expect(explainWrite(sql, "postgres").reason).not.toContain("shell syntax")
  })

  test("a write followed by residue is not offered as a read", () => {
    expect(shellResidue("DELETE FROM t 2>/dev/null", "postgres")).toBeUndefined()
    expect(explainWrite("DELETE FROM t 2>/dev/null", "postgres").reason).not.toContain("shell syntax")
  })
})

describe("other read-only refusals carry the reason", () => {
  test("sql_check and query_from (readSql)", () => {
    expect(() => readSql("SELECT 1 2>/dev/null", "postgres")).toThrow("`2>/dev/null`")
    expect(() => readSql("SELECT 1; DELETE FROM t", "postgres")).toThrow("statement 2 of 2")
  })

  test("qualified columns named like keywords are reads here too", () => {
    expect(readSql("SELECT o.update, o.delete FROM orders o", "postgres")).toBe("SELECT o.update, o.delete FROM orders o")
    expect(readSql("SELECT o.replace FROM orders o", "postgres")).toBe("SELECT o.replace FROM orders o")
    expect(() => readSql("REPLACE INTO orders VALUES (1)", "mysql")).toThrow()
    expect(() => readSql("SELECT 1. INTO c FROM orders", "postgres")).toThrow()
  })

  test("a refusal that is not about writing stays as it was", () => {
    expect(writeReason("SELECT 1", "postgres")).toBe("")
  })
})

describe("explainWrite", () => {
  test("names shell residue", () => {
    const result = explainWrite("SELECT 1 2>/dev/null", "postgres")
    expect(result).toEqual({ unreadable: true, reason: expect.stringContaining("`2>/dev/null`") })
  })

  test("carries the parser's position", () => {
    const result = explainWrite("SELECT Order Date FROM orders", "postgres")
    expect(result.unreadable).toBe(true)
    expect(result.reason).toMatch(/line 1, column \d+/)
  })

  test("explains an unterminated quote", () => {
    const result = explainWrite("SELECT 'it\\'s' FROM t", "postgres")
    expect(result.unreadable).toBe(true)
    expect(result.reason).toContain("unterminated")
  })

  test("names the first write statement", () => {
    expect(explainWrite("SELECT 1; SELECT 2; DROP TABLE t", "postgres")).toEqual({
      unreadable: false,
      reason: "statement 3 of 3 is not a read (DROP TABLE)",
    })
    expect(explainWrite("COPY INTO orders FROM @stage", "snowflake").reason).toBe("it is not a read (COPY)")
  })

  test("a TRANSFORM call outside Spark and Hive does not hide the statement type", () => {
    expect(explainWrite("DELETE FROM t USING u WHERE transform(t.x) = 1", "postgres").reason).toBe("it is not a read (DELETE)")
  })

  test("names a SQL Server batch keyword", () => {
    expect(explainWrite("SELECT exec FROM t", "sqlserver").reason).toContain("statement keyword EXEC")
  })

  test("names a write clause inside a query", () => {
    for (const sql of ["WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x", "SELECT * INTO c FROM t"]) {
      expect(explainWrite(sql, "postgres")).toEqual({ unreadable: false, reason: expect.stringContaining("write clause") })
    }
  })
})
