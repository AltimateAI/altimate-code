import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { classifyAndCheck, explainWrite, shellResidue } from "../../../src/altimate/tools/sql-classify"
import { hardBlockRefusal, readSql, requireReadOnlyQuery, writeReason } from "../../../src/altimate/tools/read-only-sql"

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

  test("on ClickHouse, whose parser accepts trailing text, a redirect is still named and not run", () => {
    for (const [sql, residue] of [
      ["SELECT 1 2>/dev/null", "2>/dev/null"],
      ["SELECT * FROM t LIMIT 5 2>&1", "2>&1"],
      ["SHOW TABLES 2>/dev/null", "2>/dev/null"],
      ["DESCRIBE TABLE t 2>&1", "2>&1"],
    ]) {
      expect(classifyAndCheck(sql, "clickhouse").queryType).toBe("write")
      expect(shellResidue(sql, "clickhouse")).toBe(residue)
    }
    for (const sql of ["SELECT a > 2 FROM t", "SELECT '2>/dev/null'", "SELECT 1 -- 2>/dev/null", "SELECT a || tail FROM t"]) {
      expect(classifyAndCheck(sql, "clickhouse").queryType).toBe("read")
    }
    // A write keeps its own reason rather than a parser failure.
    expect(explainWrite("DELETE FROM t 2>/dev/null", "clickhouse").reason).toBe("it is not a read (DELETE)")
  })

  test("a comparison is not a redirect", () => {
    expect(shellResidue("SELECT a FROM t WHERE x > 2", "postgres")).toBeUndefined()
    expect(shellResidue("SELECT a FROM t WHERE x >= 2.5", "postgres")).toBeUndefined()
  })

  test("an appended redirect is named as written, and several pipes by their last command", () => {
    expect(shellResidue("SELECT * FROM t 2>> /dev/null", "postgres")).toBe("2>>/dev/null")
    expect(shellResidue("SELECT * FROM t | grep -i private | head", "postgres")).toBeUndefined()
  })

  // Timing compares two sizes on the same host instead of a wall-clock bound: linear work grows about 8x
  // from 1x to 8x input, quadratic about 64x. Each size takes its fastest of three runs, so one scheduler
  // stall on a loaded host does not read as growth.
  const growth = (build: (n: number) => string, n: number) => {
    const time = (sql: string) => {
      let best = Infinity
      for (let run = 0; run < 3; run++) {
        const start = performance.now()
        explainWrite(sql, "postgres")
        shellResidue(sql, "postgres")
        best = Math.min(best, performance.now() - start)
      }
      return best
    }
    time(build(n)) // warm up
    return time(build(n * 8)) / Math.max(time(build(n)), 1)
  }

  test("a long literal before a syntax error is explained in linear time", () => {
    expect(growth((n) => `SELECT '${"x".repeat(n)}' FROM WHERE`, 25_000)).toBeLessThan(30)
  })

  test("a crafted tail is scanned in linear time", () => {
    // The tail patterns see at most 400 characters, so a longer crafted tail costs no more.
    expect(growth((n) => `SELECT * FROM t ${"| head ".repeat(n)}x;y`, 2_000)).toBeLessThan(30)
    expect(growth((n) => `SELECT * FROM t ${"| head   ".repeat(n)};y`, 1_500)).toBeLessThan(30)
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

  test("a closed executable comment is named, not treated as an open quote", () => {
    const reason = explainWrite("SELECT 1 /*! + 1 */", "mysql").reason
    expect(reason).toContain("executable comment")
    expect(reason).not.toContain("unterminated")
    const refusal = writeReason("SELECT 1 /*! + 1 */", "mysql")
    expect(refusal).toContain("hard-blocked statement")
    expect(refusal).toContain("executable comment")
    expect(refusal).not.toContain("Until it can be read")
    // The marker inside a literal is not a comment.
    expect(explainWrite("SELECT '/*! x' AS a, 'unclosed", "mysql").reason).not.toContain("executable comment")
  })

  test("a hard-blocked statement is named as such", () => {
    expect(writeReason("SELECT 1; DROP DATABASE prod", "postgres")).toContain(
      "statement 2 of 2 is a hard-blocked statement (DROP DATABASE)",
    )
    // The matched rule is named by a fixed label, never with SQL text.
    expect(writeReason("SELECT 1; TRUNCATE TABLE secret_t", "postgres")).toContain("(TRUNCATE)")
    expect(writeReason("DROP SCHEMA s", "postgres")).toContain("it holds a hard-blocked statement (DROP SCHEMA)")
    expect(writeReason("SELECT 1 /*! + 1 */", "mysql")).toContain("(an executable comment)")
    const nested = writeReason("SELECT * FROM query('DROP SCHEMA secret_s')", "duckdb")
    expect(nested).toContain("(SQL run from a string literal)")
    expect(nested).not.toContain("secret_s")
    // The label is the rule the classifier blocked on: a qualified column named truncate is not TRUNCATE,
    // a Unicode-escaped literal holds no hard-deny word, and dynamic SQL is named as such.
    expect(writeReason("SELECT q.truncate FROM query('DROP SCHEMA s') q", "duckdb")).toContain("(SQL run from a string literal)")
    expect(writeReason("INSERT INTO t VALUES (U&'d!0061t' UESCAPE '!')", "postgres")).toContain("Unicode escape")
    expect(writeReason("EXEC sp_x /* drop schema s */", "sqlserver")).toContain("(dynamic SQL")
    // Only fixed words reach the label: a name after DROP inside a TRUNCATE target is not echoed.
    const target = writeReason("SELECT 1 THEN TRUNCATE IDENTIFIER(drop secret_tbl);", "postgres")
    expect(target).toContain("(TRUNCATE)")
    expect(target).not.toMatch(/secret_tbl/i)
    // SQL Server's query() is XQuery, so a qualified column named truncate beside it is a read.
    expect(classifyAndCheck("SELECT q.truncate FROM query('DROP SCHEMA s') q", "sqlserver")).toMatchObject({ queryType: "read", blocked: false })
    // An unclosed quote holding a blocked word names the quote first.
    const reason = writeReason("SELECT a FROM t WHERE n = 'do not truncate", "postgres")
    expect(reason.indexOf("unterminated")).toBeGreaterThan(-1)
    expect(reason.indexOf("unterminated")).toBeLessThan(reason.indexOf("Until it can be read"))
    expect(reason).not.toContain("cannot be allowed")
    // A real hard block outside the open quote is not described as sitting inside it.
    expect(writeReason("DROP DATABASE x; SELECT 'abc", "postgres")).toContain("inside that quoted text or outside it")
  })

  test("a SELECT ... INTO the parser cannot read is a write, not a syntax error", () => {
    for (const sql of ["SELECT a FROM t INTO OUTFILE '/tmp/x'", "SELECT a FROM t LIMIT 1 INTO @v", "SELECT 0x1.INTO t FROM"]) {
      const reason = explainWrite(sql, "mysql").reason
      expect(reason).toContain("write clause")
      expect(reason).not.toContain("could not read")
    }
    // INTO inside a literal or after a dot is not an INTO clause.
    expect(explainWrite("SELECT 'into' FROM WHERE", "postgres").reason).toContain("could not read")
    expect(explainWrite("SELECT t.into FROM WHERE", "postgres").reason).toContain("could not read")
  })

  test("a hard-block refusal claims it cannot be overridden only for a real hard block", () => {
    const head = "DROP DATABASE, DROP SCHEMA and TRUNCATE are blocked for safety."
    expect(hardBlockRefusal(head, "SELECT 1; DROP DATABASE p", "postgres")).toContain("cannot be overridden")
    const open = hardBlockRefusal(head, "SELECT * FROM t WHERE note = 'don't truncate'", "postgres")
    expect(open).not.toContain("cannot be overridden")
    expect(open).toContain("write a single quote as ''")
  })

  test("a missing parser is reported as unavailable, not as a syntax error", async () => {
    // The parser binding is read once at import, so stub it in a fresh process run outside the package
    // (its test preload loads the classifier first; mock.module also leaks across files in one process).
    const dir = mkdtempSync(join(tmpdir(), "guard-unavailable-"))
    const src = join(import.meta.dir, "../../../src/altimate/tools")
    writeFileSync(
      join(dir, "unavailable.test.ts"),
      `import { expect, mock, test } from "bun:test"
mock.module("@altimateai/altimate-core", () => ({}))
test("unavailable", async () => {
  const { explainWrite, UNAVAILABLE_NEXT_STEP } = await import(${JSON.stringify(join(src, "sql-classify"))})
  const { writeReason } = await import(${JSON.stringify(join(src, "read-only-sql"))})
  const explained = explainWrite("SELECT 1", "postgres")
  expect(explained.unavailable).toBe(true)
  expect(explained.reason).not.toContain("could not read")
  expect(writeReason("SELECT 1", "postgres")).toContain(UNAVAILABLE_NEXT_STEP)
  // An installation failure is not a permission decision, in words or in its telemetry class.
  expect(writeReason("SELECT 1", "postgres")).not.toContain("permission")
})
`,
    )
    try {
      const run = Bun.spawnSync([process.execPath, "test", "./unavailable.test.ts"], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      })
      const output = run.stdout.toString() + run.stderr.toString()
      // Bun can crash during cleanup after printing a complete test summary.
      expect(output).toMatch(/^\s*[1-9]\d* pass\s*$/m)
      expect(output).toMatch(/^\s*0 fail\s*$/m)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test.each([
    ["SELECT 1; SELECT 2", "more than one statement"],
    ["SHOW TABLES", "not a SELECT or WITH query"],
    ["SELECT pg_sleep(1)", "not known to be read-only"],
  ])("explains the unsupported read shape %s", (sql, cause) => {
    const reason = writeReason(sql, "postgres")
    expect(reason).toContain(cause)
    expect(reason).toContain("send a single SELECT or WITH query")
  })

  test("data_diff's embedded-query check names its reason too", () => {
    expect(() => requireReadOnlyQuery("SELECT 1; DELETE FROM t", "postgres")).toThrow("statement 2 of 2 is not a read (DELETE)")
    expect(() => requireReadOnlyQuery("SELECT 1; SELECT 2", "postgres")).toThrow("more than one statement")
  })

  test("SQL Server's XML .query() takes XQuery, so the read is accepted, as in the classifier", () => {
    const sql = "SELECT x.query('/a/b') AS v FROM t"
    expect(readSql(sql, "sqlserver")).toBe(sql)
    expect(writeReason(sql, "sqlserver")).toBe("")
  })

  test("a single read calling query() is refused for the function", () => {
    const sql = "SELECT * FROM query('SELECT 1 AS private_alias')"
    const reason = writeReason(sql, "duckdb")
    expect(reason).toContain("calls query()")
    expect(reason).not.toContain("Invalid query shape")
    expect(reason).not.toContain("private_alias")
    expect(() => readSql(sql, "duckdb")).toThrow("calls query()")
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
      "SELECT customer_secret_name(a FROM t",
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
    expect(explainWrite('SELECT "t".update FROM t', "postgres").reason).not.toContain("uppercase")
    const upper = explainWrite('SELECT "T".update FROM t', "snowflake").reason
    expect(upper).toContain('"T"."UPDATE"')
    expect(upper).not.toContain('"t"."update"')
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
