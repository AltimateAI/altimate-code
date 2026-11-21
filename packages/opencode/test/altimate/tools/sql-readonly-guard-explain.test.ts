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

  test("an appended redirect is named as written, and several pipes by their last command", () => {
    expect(shellResidue("SELECT * FROM t 2>> /dev/null", "postgres")).toBe("2>>/dev/null")
    expect(shellResidue("SELECT * FROM t | grep -i private | head", "postgres")).toBeUndefined()
  })

  test("a long literal before a syntax error is explained in linear time", () => {
    const sql = `SELECT '${"x".repeat(200_000)}' FROM WHERE`
    const start = performance.now()
    explainWrite(sql, "postgres")
    shellResidue(sql, "postgres")
    // Quadratic trimming took about 4 s at 80k characters; linear work stays far below this.
    expect(performance.now() - start).toBeLessThan(3000)
  })

  test("a crafted tail is scanned in linear time", () => {
    const start = performance.now()
    shellResidue(`SELECT * FROM t ${"| head ".repeat(60)}x;y`, "postgres")
    shellResidue(`SELECT * FROM t ${"| head   ".repeat(44)};y`, "postgres")
    explainWrite(`SELECT * FROM t ${"| head ".repeat(60)}x;y`, "postgres")
    // A backtracking blowup takes many seconds; parser calls alone stay far below this on a busy runner.
    expect(performance.now() - start).toBeLessThan(5000)
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
  test("sql_check (readSql)", () => {
    expect(() => readSql("SELECT 1 2>/dev/null", "postgres")).toThrow("`2>/dev/null`")
    expect(() => readSql("SELECT 1; DELETE FROM t", "postgres")).toThrow("statement 2 of 2")
  })

  test("qualified columns named like keywords are reads here too", () => {
    expect(readSql("SELECT o.update, o.delete FROM orders o", "postgres")).toBe("SELECT o.update, o.delete FROM orders o")
    expect(readSql("SELECT o.replace FROM orders o", "postgres")).toBe("SELECT o.replace FROM orders o")
    expect(() => readSql("REPLACE INTO orders VALUES (1)", "mysql")).toThrow()
    expect(() => readSql("SELECT 1. INTO c FROM orders", "postgres")).toThrow()
  })

  test("a word only the stricter sql_check list refuses is named", () => {
    expect(() => readSql("SELECT x AS load FROM t", "postgres")).toThrow("statement word LOAD")
    // Not named when something else also refuses it (the leading parenthesis).
    expect(() => readSql("(SELECT x AS load FROM t)", "postgres")).not.toThrow("statement word")
    expect(writeReason("SELECT x AS load FROM t", "postgres")).toContain("statement word LOAD")
  })

  test("parser details end without stray punctuation", () => {
    expect(explainWrite("SELECT a FROM WHERE (((", "postgres").reason).not.toMatch(/,\)/)
  })

  test("the result lint path can skip the explanation", () => {
    expect(() => readSql("SELECT 1; DELETE FROM t", "postgres", { explain: false })).toThrow(
      /^This operation only accepts a single read-only SELECT \(or WITH \.\.\. SELECT\); it never writes or fixes data\.$/,
    )
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

  test("a plain write on SQL Server or an unmodeled dialect is named by its type", () => {
    for (const dialect of ["sqlserver", undefined]) {
      expect(explainWrite("DELETE FROM orders", dialect).reason).toBe("it is not a read (DELETE)")
      expect(explainWrite("INSERT INTO t VALUES (1)", dialect).reason).toBe("it is not a read (INSERT)")
    }
  })

  test("parser messages keep no token text", () => {
    const reason = explainWrite("SELECT set FROM t", "postgres").reason
    expect(reason).toContain("line 1, column")
    expect(reason).not.toContain("Set")
    expect(reason).not.toContain("a token")
    for (const sql of [
      "SELECT len(DISTINCT customer_secret_name(a)) FROM t",
      "SELECT customer_secret_name customer_x customer_y FROM t",
      "SELECT a FROM customer_secret_table WHERE (((",
      "SELECT CAST(a AS int 'customer_it''s secret') FROM t",
    ]) {
      const message = explainWrite(sql, "sqlite").reason
      expect(message).toContain("could not read")
      expect(message).not.toMatch(/customer_/)
    }
  })

  test("a SELECT INTO on SQL Server is named as a write clause, not a keyword to quote", () => {
    for (const dialect of ["sqlserver", undefined]) {
      expect(explainWrite("SELECT * INTO c FROM t", dialect).reason).toContain("write clause")
    }
  })

  test("a quoted qualifier gets a specific hint", () => {
    expect(explainWrite('SELECT "t".update FROM t', "postgres").reason).toContain('"t"."update"')
  })

  test("every write in the guard corpus is a write with a specific reason", () => {
    const everywhere = [
      "INSERT INTO t VALUES (1)", "UPDATE t SET a = 1", "DELETE FROM t", "MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE",
      "CREATE TABLE t (a INT)", "DROP TABLE t", "ALTER TABLE t ADD COLUMN c INT", "COPY INTO t FROM @s", "SELECT 1; DELETE FROM t",
      "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x", "SELECT * INTO c FROM t", "SELECT 1. INTO c FROM t",
    ]
    const cases: Array<[string, string | undefined]> = [
      ...["postgres", "snowflake", "duckdb", "sqlserver", "bigquery", undefined].flatMap((d) => everywhere.map((sql) => [sql, d] as [string, string | undefined])),
      ["SELECT exec FROM t", "sqlserver"],
      ["SELECT nextval('s')", "postgres"],
      ["SELECT NEXT VALUE FOR s", "sqlserver"],
    ]
    for (const [sql, dialect] of cases) {
      expect({ dialect, sql, type: classifyAndCheck(sql, dialect).queryType }).toEqual({ dialect, sql, type: "write" })
      const reason = explainWrite(sql, dialect).reason
      // Every corpus write parses, so a parser-failure reason would be generic too.
      const specific = reason.length > 10 && !reason.includes("could not be proven") && !reason.includes("could not read")
      expect({ dialect, sql, specific }).toEqual({ dialect, sql, specific: true })
    }
  })

  test("a SQL Server batch without a separator is named as such, not as a syntax error", () => {
    const reason = explainWrite("SELECT a FROM t\nUPDATE t SET a = 1", "sqlserver").reason
    expect(reason).toContain("statement keyword UPDATE")
    expect(reason).not.toContain("could not read")
  })

  test("an UNKNOWN statement type is named by its first keyword", () => {
    expect(explainWrite("ATTACH 'x.db' AS other", "duckdb").reason).not.toContain("UNKNOWN")
    // Only known keywords are named; any other first word is the user's text.
    expect(explainWrite("acme_secret SELECT 1", "clickhouse").reason).not.toMatch(/ACME_SECRET/i)
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
