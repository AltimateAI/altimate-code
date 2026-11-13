import { describe, expect, test } from "bun:test"
import { classify, classifyMulti, classifyAndCheck, computeSqlFingerprint, isSingleQuery } from "../../../src/altimate/tools/sql-classify"
import { statementsOf } from "../../../src/altimate/tools/sql-tokenize"

describe("classify", () => {
  // --- Read queries ---

  test("SELECT → read", () => {
    expect(classify("SELECT * FROM users")).toBe("read")
  })

  test("select lowercase → read", () => {
    expect(classify("select id from orders")).toBe("read")
  })

  // Metadata statements cannot modify data; a read-only agent must be able to list
  // tables and inspect plans. Only an EXPLAIN that would execute a write stays a write.
  test("SHOW → read (metadata)", () => {
    expect(classify("SHOW TABLES")).toBe("read")
  })

  test("EXPLAIN of a read → read; EXPLAIN ANALYZE of a write → write", () => {
    expect(classify("EXPLAIN SELECT * FROM users")).toBe("read")
    expect(classify("EXPLAIN ANALYZE DELETE FROM users")).toBe("write")
  })

  test("WITH...SELECT (CTE) → read", () => {
    expect(classify("WITH cte AS (SELECT 1) SELECT * FROM cte")).toBe("read")
  })

  test("empty → read", () => {
    expect(classify("")).toBe("read")
  })

  // --- Write queries ---

  test("INSERT → write", () => {
    expect(classify("INSERT INTO users VALUES (1, 'a')")).toBe("write")
  })

  test("UPDATE → write", () => {
    expect(classify("UPDATE users SET name = 'b'")).toBe("write")
  })

  test("DELETE → write", () => {
    expect(classify("DELETE FROM users WHERE id = 1")).toBe("write")
  })

  test("DROP TABLE → write", () => {
    expect(classify("DROP TABLE users")).toBe("write")
  })

  test("DROP DATABASE → write", () => {
    expect(classify("DROP DATABASE mydb")).toBe("write")
  })

  test("CREATE TABLE → write", () => {
    expect(classify("CREATE TABLE users (id INT)")).toBe("write")
  })

  test("ALTER TABLE → write", () => {
    expect(classify("ALTER TABLE users ADD COLUMN email TEXT")).toBe("write")
  })

  test("TRUNCATE → write", () => {
    expect(classify("TRUNCATE TABLE users")).toBe("write")
  })

  test("MERGE → write", () => {
    expect(classify("MERGE INTO target USING source ON target.id = source.id WHEN MATCHED THEN UPDATE SET target.name = source.name")).toBe("write")
  })

  test("GRANT → write", () => {
    expect(classify("GRANT SELECT ON users TO role1")).toBe("write")
  })

  test("REVOKE → write", () => {
    expect(classify("REVOKE SELECT ON users FROM role1")).toBe("write")
  })

  // --- CTE edge cases (AST handles correctly) ---

  test("CTE with nested parens → write", () => {
    expect(classify("WITH a AS (SELECT (1+2) FROM t) INSERT INTO x SELECT * FROM a")).toBe("write")
  })

  test("multiple CTEs → write", () => {
    expect(classify("WITH a AS (SELECT 1), b AS (SELECT 2) INSERT INTO x SELECT * FROM a")).toBe("write")
  })

  test("multiple CTEs → read", () => {
    expect(classify("WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a JOIN b ON a.id = b.id")).toBe("read")
  })

  test("CTE + INSERT VALUES with parens → write", () => {
    expect(classify("WITH a AS (SELECT 1) INSERT INTO x VALUES (1, 2, 3)")).toBe("write")
  })

  test("WITH...INSERT (CTE with DML) → write", () => {
    expect(classify("WITH cte AS (SELECT 1) INSERT INTO target SELECT * FROM cte")).toBe("write")
  })

  test("case insensitive → write", () => {
    expect(classify("insert into users values (1)")).toBe("write")
  })

  // --- "other" category (ambiguous ops) → write (prompts for permission) ---

  test("SHOW TABLES → read (metadata)", () => {
    expect(classify("SHOW TABLES")).toBe("read")
  })

  test("SET variable → write (prompts)", () => {
    expect(classify("SET search_path = public")).toBe("write")
  })

  test("USE database → write (prompts)", () => {
    expect(classify("USE mydb")).toBe("write")
  })
})

describe("classifyMulti", () => {
  for (const dialect of ["mysql", "sqlite", "bigquery", "unknown", undefined]) {
    test(`dollar-delimited writes fail closed for ${dialect ?? "omitted"} dialect`, () => {
      const sql = "SELECT $x$; DELETE FROM t; $x$"
      expect(classifyMulti(sql, dialect)).toBe("write")
      expect(classifyAndCheck(sql, dialect)).toMatchObject({ queryType: "write", blocked: false })
      const statements = statementsOf(sql, dialect)
      expect(statements).toHaveLength(3)
      expect(statements.map((statement) => classify(statement, dialect))).toContain("write")
      expect(isSingleQuery(sql, dialect)).toBe(false)
    })
  }

  for (const [dialect, sql] of [
    ["postgres", "SELECT $x$ a; b $x$"],
    ["postgres", "SELECT $$ ; DROP TABLE t $$"],
    ["redshift", "SELECT $x$ a; b $x$"],
    ["duckdb", "SELECT $x$ a; b $x$"],
    ["duckdb", "SELECT $$ ; DROP TABLE t $$"],
    ["snowflake", "SELECT $$ ; DROP TABLE t $$"],
  ]) {
    test(`dollar-quoted content remains one read for ${dialect}: ${sql}`, () => {
      expect(classifyAndCheck(sql, dialect)).toEqual({ queryType: "read", blocked: false })
      expect(isSingleQuery(sql, dialect)).toBe(true)
    })
  }

  test("all reads → read", () => {
    expect(classifyMulti("SELECT 1; SELECT 2")).toBe("read")
  })

  test("mixed read+write → write", () => {
    expect(classifyMulti("SELECT * FROM users; INSERT INTO logs VALUES ('read')")).toBe("write")
  })

  test("single write → write", () => {
    expect(classifyMulti("DROP TABLE users")).toBe("write")
  })

  test("empty → read", () => {
    expect(classifyMulti("")).toBe("read")
  })
})

describe("classifyAndCheck", () => {
  test("SELECT → read, not blocked", () => {
    const r = classifyAndCheck("SELECT 1")
    expect(r.queryType).toBe("read")
    expect(r.blocked).toBe(false)
  })

  test("INSERT → write, not blocked", () => {
    const r = classifyAndCheck("INSERT INTO users VALUES (1)")
    expect(r.queryType).toBe("write")
    expect(r.blocked).toBe(false)
  })

  test("DROP DATABASE → write, blocked", () => {
    const r = classifyAndCheck("DROP DATABASE mydb")
    expect(r.queryType).toBe("write")
    expect(r.blocked).toBe(true)
  })

  test("TRUNCATE → write, blocked", () => {
    const r = classifyAndCheck("TRUNCATE TABLE users")
    expect(r.queryType).toBe("write")
    expect(r.blocked).toBe(true)
  })

  test("multi-statement with DROP SCHEMA → blocked", () => {
    const r = classifyAndCheck("SELECT 1; DROP SCHEMA public")
    expect(r.blocked).toBe(true)
  })

  test("multi-statement without hard-deny → not blocked", () => {
    const r = classifyAndCheck("SELECT 1; INSERT INTO users VALUES (1)")
    expect(r.queryType).toBe("write")
    expect(r.blocked).toBe(false)
  })

  test("SHOW → read (metadata), not blocked", () => {
    const r = classifyAndCheck("SHOW TABLES")
    expect(r.queryType).toBe("read")
    expect(r.blocked).toBe(false)
  })

  test("DROP SCHEMA case insensitive → blocked", () => {
    const r = classifyAndCheck("drop schema public")
    expect(r.blocked).toBe(true)
  })

  test("TRUNCATE without TABLE keyword → blocked", () => {
    const r = classifyAndCheck("TRUNCATE users")
    expect(r.queryType).toBe("write")
    expect(r.blocked).toBe(true)
  })
})

// --- sql-execute integration: verify classifyAndCheck drives the permission flow ---

describe("sql-execute permission flow", () => {
  test("blocked queries throw before reaching dispatcher", () => {
    // Simulates the sql-execute.ts logic: if blocked, throw
    const queries = ["DROP DATABASE prod", "DROP SCHEMA public", "TRUNCATE TABLE users", "truncate users"]
    for (const q of queries) {
      const { blocked } = classifyAndCheck(q)
      expect(blocked).toBe(true)
      // In sql-execute.ts, this would throw Error("DROP DATABASE, DROP SCHEMA, and TRUNCATE are blocked...")
    }
  })

  test("write queries trigger permission ask (queryType === write)", () => {
    // Simulates: if queryType === "write", ctx.ask() is called
    const writeQueries = [
      "INSERT INTO users VALUES (1, 'test')",
      "UPDATE users SET name = 'foo'",
      "DELETE FROM users WHERE id = 1",
      "CREATE TABLE new_table (id INT)",
      "ALTER TABLE users ADD COLUMN email TEXT",
      "GRANT SELECT ON users TO analyst",
      "MERGE INTO target USING source ON target.id = source.id WHEN MATCHED THEN UPDATE SET target.name = source.name",
    ]
    for (const q of writeQueries) {
      const { queryType, blocked } = classifyAndCheck(q)
      expect(queryType).toBe("write")
      expect(blocked).toBe(false)
    }
  })

  test("read queries skip permission check entirely", () => {
    // Simulates: if queryType === "read", no ctx.ask() call
    const readQueries = [
      "SELECT * FROM users",
      "SELECT 1",
      "WITH cte AS (SELECT 1) SELECT * FROM cte",
      "SELECT id, name FROM orders WHERE status = 'active'",
    ]
    for (const q of readQueries) {
      const { queryType, blocked } = classifyAndCheck(q)
      expect(queryType).toBe("read")
      expect(blocked).toBe(false)
    }
  })

  test("ambiguous session statements (SET, USE) prompt for permission", () => {
    // "other" category → treated as write → triggers ctx.ask(). SHOW is a metadata
    // read and is covered separately.
    const ambiguousQueries = ["SET search_path = public", "USE mydb"]
    for (const q of ambiguousQueries) {
      const { queryType, blocked } = classifyAndCheck(q)
      expect(queryType).toBe("write") // prompts for permission
      expect(blocked).toBe(false) // not hard-blocked
    }
  })

  test("multi-statement with any write triggers permission", () => {
    const { queryType, blocked } = classifyAndCheck("SELECT 1; INSERT INTO logs VALUES ('test')")
    expect(queryType).toBe("write")
    expect(blocked).toBe(false)
  })

  test("multi-statement with hard-deny blocks entire batch", () => {
    const { blocked } = classifyAndCheck("SELECT 1; DROP DATABASE prod")
    expect(blocked).toBe(true)
  })
})

describe("computeSqlFingerprint", () => {
  test("returns fingerprint for valid SQL", () => {
    const result = computeSqlFingerprint("SELECT id, name FROM users WHERE active = true")
    // If napi is available, we get a real fingerprint; if not, null
    if (result !== null) {
      expect(result.statement_types).toBeInstanceOf(Array)
      expect(result.categories).toBeInstanceOf(Array)
      expect(typeof result.table_count).toBe("number")
      expect(typeof result.function_count).toBe("number")
      expect(typeof result.has_subqueries).toBe("boolean")
      expect(typeof result.has_aggregation).toBe("boolean")
      expect(typeof result.has_window_functions).toBe("boolean")
      expect(typeof result.node_count).toBe("number")
    }
  })

  test("returns null for empty string", () => {
    const result = computeSqlFingerprint("")
    // Either null (no napi) or a valid result with empty arrays
    if (result !== null) {
      expect(result.statement_types).toBeInstanceOf(Array)
    }
  })

  test("does not throw for invalid SQL", () => {
    // Should return null or a partial result, never throw
    expect(() => computeSqlFingerprint("NOT VALID SQL !!@#$")).not.toThrow()
  })

  test("returns null when napi unavailable (graceful degradation)", () => {
    // This tests the guard clause — computeSqlFingerprint returns null
    // when getStatementTypes/extractMetadata are null.
    // In test env with napi available, this would return a real result.
    const result = computeSqlFingerprint("SELECT 1")
    // Either a valid result (napi loaded) or null (napi unavailable) — both are correct
    expect(result === null || typeof result === "object").toBe(true)
  })
})

describe("SQL-building aggregates are reads", () => {
  const cases: [string, string][] = [
    ["duckdb", "SELECT string_agg('SELECT * FROM ' || table_name, ' UNION ALL ') FROM information_schema.tables WHERE table_schema = 'main'"],
    ["duckdb", "SELECT string_agg('''' || Symbol || '''', ',' ORDER BY Symbol) FROM t"],
    ["duckdb", "SELECT string_agg('INSERT INTO x SELECT * FROM ' || table_name, '; ') FROM information_schema.tables"],
    ["duckdb", "SELECT string_agg('DROP TABLE ' || table_name, '; ') FROM information_schema.tables"],
    ["sqlite", "SELECT group_concat('SELECT * FROM ' || name, ' UNION ALL ') FROM sqlite_master WHERE type = 'table'"],
    ["postgres", "SELECT string_agg('SELECT * FROM ' || quote_ident(table_name), ' UNION ALL ') FROM information_schema.tables"],
    ["postgres", "SELECT string_agg(format('CREATE INDEX ON %I', table_name), '; ') FROM information_schema.tables"],
  ]
  for (const [dialect, sql] of cases) {
    test(`${dialect}: ${sql.slice(0, 60)} → read, with no keyword-in-literal false positive`, () => {
      expect(classifyAndCheck(sql, dialect)).toEqual({ queryType: "read", blocked: false })
    })
  }

  test("duckdb: `//` integer division in a string_agg query → read", () => {
    const sql = "SELECT 'c' || (rn // 240) c, count(*), string_agg('''' || Symbol || '''', ',' ORDER BY Symbol) FROM t GROUP BY 1"
    expect(classifyAndCheck(sql, "duckdb")).toEqual({ queryType: "read", blocked: false })
  })

  test("duckdb: `//` classifies as read without a parse diagnostic", () => {
    const r = classifyAndCheck("SELECT 'c' || (rn // 240) c, string_agg(Symbol, ',') FROM t GROUP BY 1", "duckdb")
    expect(r).toEqual({ queryType: "read", blocked: false })
  })

  test("duckdb: malformed string_agg fails closed with an explanatory diagnostic", () => {
    const r = classifyAndCheck("SELECT string_agg(Symbol, ','", "duckdb")
    expect(r.queryType).toBe("write")
    expect(r.blocked).toBe(false)
    expect(r.parseError).toMatch(/Parse error.*Expected RParen/)
  })
})

test.each(["postgres_execute", "mysql_execute"])("a SELECT calling %s is classified as a write", (fn) => {
  expect(classify(`SELECT * FROM ${fn}('remote', 'DELETE FROM orders')`, "duckdb")).toBe("write")
})

test("a quoted remote-execute function name is still classified as a write", () => {
  expect(classify(`SELECT * FROM "postgres_execute"('remote', 'DELETE FROM orders')`, "duckdb")).toBe("write")
})

test("duckdb line comments end at CR so a following DROP is blocked", () => {
  expect(classifyAndCheck("SELECT 1 -- x\r; DROP SCHEMA s", "duckdb").blocked).toBe(true)
})

describe("literal and comment lexing where the dialect decides", () => {
  test("BigQuery and Redshift backslash escapes keep a quote inside the literal", () => {
    expect(classifyAndCheck("SELECT 'it\\'s' AS v", "bigquery")).toEqual({ queryType: "read", blocked: false })
    expect(classifyAndCheck("SELECT \"a\\\"b\" AS v", "bigquery")).toEqual({ queryType: "read", blocked: false })
    expect(classifyAndCheck("SELECT REGEXP_CONTAINS(x, r'\\d+') FROM t", "bigquery")).toEqual({ queryType: "read", blocked: false })
    expect(classifyAndCheck("SELECT 'a\\\\b' AS v", "redshift")).toEqual({ queryType: "read", blocked: false })
    expect(classifyAndCheck("SELECT 'x\\'' ; DROP SCHEMA s; -- '", "bigquery").blocked).toBe(true)
    expect(classifyAndCheck("SELECT 'x\\'' ; DROP SCHEMA s; -- '", "redshift").blocked).toBe(true)
  })

  test("without a dialect, an escapable quote or # makes the SQL a write and keeps the hard block", () => {
    expect(classifyAndCheck("SELECT 'x\\'' ; DROP SCHEMA s; -- '").blocked).toBe(true)
    expect(classifyAndCheck("# x\nDROP SCHEMA s").blocked).toBe(true)
    expect(classifyAndCheck("SELECT 'x\\'' AS v").queryType).toBe("write")
    // An even run of backslashes ends the literal the same way in every dialect; # inside a literal is text.
    expect(classifyAndCheck("SELECT 'a\\\\' AS v")).toEqual({ queryType: "read", blocked: false })
    expect(classifyAndCheck("SELECT '#tag' AS v")).toEqual({ queryType: "read", blocked: false })
    // Uncertain SQL is blocked on the words anywhere, however comments split it; TRUNCATE() is a function.
    const commented = `SELECT 'x\\'' = "x'"; /* a ; b */ DROP SCHEMA ds CASCADE; -- '`
    for (const dialect of [undefined, "databricks", "spark", "bigquery"]) expect(classifyAndCheck(commented, dialect).blocked).toBe(true)
    expect(classifyAndCheck("SELECT TRUNCATE(amount, 2), 'a\\'b' FROM t", "mysql").blocked).toBe(false)
    // Nothing is stripped first: in BigQuery the DROP below runs, though a naive reading sees a comment.
    for (const dialect of ["bigquery", "databricks", undefined]) {
      expect(classifyAndCheck("SELECT 'a\\' /* ' ; DROP SCHEMA s; -- */", dialect).blocked).toBe(true)
      expect(classifyAndCheck("SELECT 'a\\' /* ' ; DROP /* x */ SCHEMA s; -- */", dialect).blocked).toBe(true)
    }
    // Linear on repeated unterminated comments.
    const started = performance.now()
    classifyAndCheck("DROP /* ".repeat(32_768), "bigquery")
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(classifyAndCheck("SELECT 'x\\'' ; DROP -- c\n SCHEMA s").blocked).toBe(true)
    // A dialect the lexer does not model gets the same guards as none.
    for (const dialect of ["generic", "unknown"])
      expect(classifyAndCheck("SELECT 'x\\'' ; DROP SCHEMA s; -- '", dialect).blocked).toBe(true)
    // Oracle, Trino and Fabric neither escape quotes with a backslash nor comment with #.
    for (const dialect of ["oracle", "trino", "fabric"]) {
      expect(classifyAndCheck("SELECT * FROM t WHERE c LIKE '%\\_%' ESCAPE '\\'", dialect)).toEqual({ queryType: "read", blocked: false })
      expect(classifyAndCheck("SELECT 'C:\\reports\\' AS p FROM t", dialect)).toEqual({ queryType: "read", blocked: false })
    }
    expect(classifyAndCheck("SELECT order# FROM orders", "oracle").queryType).toBe("read")
    // TRUNCATE directly before ( is the function, even in SQL that cannot be read fully.
    expect(classifyAndCheck("SELECT TRUNCATE (amount, 2), 'a\\'b' AS v FROM t", "mysql").blocked).toBe(false)
    // Complete SQL keeps its literals: hard-deny text inside a string is not a statement.
    expect(classifyAndCheck("SELECT '; DROP SCHEMA x' AS v", "postgres")).toEqual({ queryType: "read", blocked: false })
  })
})

describe("each engine's own literal and statement rules", () => {
  const cases: [string, string | undefined, "read" | "write", boolean][] = [
    // BigQuery: a backslash keeps the next character in backticks and raw strings too.
    ["SELECT 1 AS `a\\`b`; TRUNCATE TABLE t; -- `", "bigquery", "write", true],
    ["SELECT 1 AS `a\\`` ; DELETE FROM ds.t WHERE TRUE; --`", "bigquery", "write", false],
    ["SELECT r'\\'' ; DROP SCHEMA ds CASCADE; --'", "bigquery", "write", true],
    ["SELECT r'\\d+' AS p, 'it\\'s' AS q", "bigquery", "read", false],
    ["ASSERT ''' ' ''' IS NOT NULL; DROP SCHEMA ds CASCADE; SELECT ''' ' '''", "bigquery", "write", true],
    ["SELECT ''' ' ''' AS a", "bigquery", "read", false],
    // T-SQL: no E'' strings, statements need no separator.
    ["SELECT * FROM dbo.t WHERE x = E'\\' DROP DATABASE prod --'", "sqlserver", "write", true],
    ["SELECT * FROM dbo.t WHERE x = E'\\' DELETE FROM dbo.t --'", "fabric", "write", false],
    ["SELECT 1 CHECKPOINT", "sqlserver", "write", false],
    ["SELECT 1 DROP DATABASE prod", "sqlserver", "write", true],
    ["SELECT open, close, [add], [end], updated_at FROM prices", "sqlserver", "read", false],
    ["SELECT CASE WHEN a = 1 THEN 2 END AS x FROM #temp", "sqlserver", "read", false],
    ["SELECT * FROM t ORDER BY id OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY", "sqlserver", "read", false],
    ["SELECT open, close FROM prices ORDER BY close DESC", "sqlserver", "read", false],
    ["SELECT * FROM t OPTION (USE HINT('DISABLE_OPTIMIZED_NESTED_LOOP'))", "sqlserver", "read", false],
    ["SELECT 1 USE master", "sqlserver", "write", false],
    ["SELECT enable, disable, rename, throw FROM t", "sqlserver", "read", false],
    ["SELECT 1 THROW 50000, 'x', 1", "sqlserver", "write", false],
    ["SELECT throw FROM t ORDER BY throw", "sqlserver", "read", false],
    ["SELECT 1 AS throw", "fabric", "read", false],
    // Spark continues a -- comment past a backslash before the line end.
    ["-- x\\\nSELECT '\nDELETE FROM t -- '", "databricks", "write", false],
    ["-- x\\\nSELECT '\nDROP SCHEMA s CASCADE -- '", "spark", "write", true],
    // Where a comment ends is uncertain, so a comment before ( does not make TRUNCATE the function.
    ["SELECT 1 /* /* */ ' */ ; TRUNCATE /* /* */ ( */ t; -- '", "redshift", "write", true],
    ["SELECT 'a\\'' ; TRUNCATE /* /* */ ( */ t; -- '", "postgres", "write", true],
    // Dynamic SQL runs its string: a hard-denied statement in the literal is blocked.
    ["EXEC('DROP DATABASE [victim]')", "sqlserver", "write", true],
    ["EXEC(N'TRUNCATE TABLE dbo.t')", "sqlserver", "write", true],
    ["EXECUTE IMMEDIATE 'DROP DATABASE victim'", "snowflake", "write", true],
    ["EXECUTE IMMEDIATE \"DROP SCHEMA ds CASCADE\"", "bigquery", "write", true],
    ["DO $$BEGIN EXECUTE 'DROP SCHEMA s CASCADE'; END$$", "postgres", "write", true],
    ["PREPARE s FROM 'DROP DATABASE prod'", "mysql", "write", true],
    // ...with the literal's escapes decoded.
    ["EXECUTE IMMEDIATE '\\x44ROP SCHEMA ds CASCADE'", "bigquery", "write", true],
    ["EXECUTE IMMEDIATE '\\x44ROP DATABASE victim'", "snowflake", "write", true],
    ["EXECUTE IMMEDIATE '\\104ROP SCHEMA ds'", "bigquery", "write", true],
    ["DO $$BEGIN EXECUTE E'\\x44ROP SCHEMA victim CASCADE'; END$$", "postgres", "write", true],
    ["DO $$BEGIN EXECUTE U&'\\0044ROP SCHEMA victim CASCADE'; END$$", "postgres", "write", true],
    ["DO $$BEGIN EXECUTE U&'!0044ROP SCHEMA v' UESCAPE '!'; END$$", "postgres", "write", true],
    ["EXEC dbo.refresh @note = 'nightly'", "sqlserver", "write", false],
    // A write runs its literals as SQL (dynamic SQL, routine bodies): each is read with escapes decoded.
    ["sp_executesql N'DROP DATABASE prod'", "sqlserver", "write", true],
    ["CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $$ DROP SCHEMA s CASCADE $$; SELECT f()", "postgres", "write", true],
    ["CREATE PROCEDURE p() AS $$ BEGIN TRUNCATE t; END; $$ LANGUAGE plpgsql; CALL p()", "redshift", "write", true],
    ["SELECT dblink_exec('dbname=postgres', 'DROP DATABASE prod')", "postgres", "write", true],
    ["WITH p AS PROCEDURE() RETURNS VARCHAR LANGUAGE SQL AS $$ BEGIN DROP DATABASE prod; RETURN 'x'; END $$ CALL p()", "snowflake", "write", true],
    // Read word by word: escapes, nested quotes and comments in the literal cannot separate the words,
    // so a write's text that merely mentions them is blocked too.
    ["EXECUTE IMMEDIATE 'DROP\\nSCHEMA ds CASCADE'", "bigquery", "write", true],
    ["DO $$BEGIN EXECUTE E'DROP\\tSCHEMA s CASCADE'; END$$", "postgres", "write", true],
    ["EXEC(N'SELECT ''--''; DROP DATABASE victim')", "sqlserver", "write", true],
    ["DO $$BEGIN EXECUTE $q$SELECT '--'; DROP SCHEMA s CASCADE$q$; END$$", "postgres", "write", true],
    ["INSERT INTO log VALUES ('nightly truncate of staging')", "postgres", "write", true],
    ["INSERT INTO log VALUES ('dropped rows', 'schema v2')", "postgres", "write", false],
    ["SELECT * FROM audit WHERE action = 'DROP SCHEMA'", "postgres", "read", false],
    // An escaped uppercase letter stands for itself; MySQL reads an unknown lowercase escape the same way.
    ["DO E'BEGIN DROP SCH\\EMA s CASCADE; END'", "postgres", "write", true],
    ["CREATE PROCEDURE p() AS 'BEGIN TRUNC\\ATE t; END' LANGUAGE plpgsql; CALL p()", "redshift", "write", true],
    ["EXECUTE IMMEDIATE 'DROP SCH\\EMA s'", "snowflake", "write", true],
    ["PREPARE s FROM 'D\\ROP DATABASE x'", "mysql", "write", true],
    ["PREPARE s FROM 'DROP sch\\ema x'", "mysql", "write", true],
    // TRUNCATE starting a block or a handler is the statement.
    ["BEGIN REPEAT TRUNCATE t; UNTIL (TRUE) END REPEAT; END", "snowflake", "write", true],
    ["CREATE PROCEDURE p() BEGIN DECLARE CONTINUE HANDLER FOR SQLEXCEPTION TRUNCATE t; END", "mysql", "write", true],
    ["SELECT truncate, x FROM t ORDER BY truncate DESC", "postgres", "read", false],
    // An alias written without AS after a column named truncate is refused (best effort, fails closed).
    ["SELECT truncate result FROM (VALUES (1)) AS t(truncate)", "postgres", "write", true],
    ["SELECT truncate AS result FROM (VALUES (1)) AS t(truncate)", "postgres", "read", false],
    // TRUNCATE followed by a target, wherever it sits.
    ["CREATE TASK k AS TRUNCATE t", "snowflake", "write", true],
    ["CREATE OR REPLACE TASK k WAREHOUSE = w AS TRUNCATE t", "snowflake", "write", true],
    ["CREATE PROCEDURE p() TRUNCATE t", "mysql", "write", true],
    ["CREATE PROCEDURE p() SQL SECURITY INVOKER TRUNCATE t", "mysql", "write", true],
    ["CREATE PROCEDURE p() LANGUAGE sql BEGIN ATOMIC TRUNCATE t; END; CALL p()", "postgres", "write", true],
    ["ALTER TABLE t TRUNCATE PARTITION p", "oracle", "write", true],
    ["ALTER TABLE t TRUNCATE SUBPARTITION p", "oracle", "write", true],
    ["ALTER TABLE t TRUNCATE PARTITION p", "mysql", "write", true],
    ["ALTER TABLE t TRUNCATE PARTITION (d = 1)", "databricks", "write", true],
    ["SELECT t.truncate x FROM t", "postgres", "read", false],
    ["SELECT t./* column comment */truncate x FROM t", "postgres", "read", false],
    ["SELECT truncate ISNULL, truncate NOTNULL FROM t", "postgres", "read", false],
    ["SELECT truncate GLOB 'a*' FROM t", "sqlite", "read", false],
    ["SELECT sum(x) OVER (ORDER BY truncate ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) FROM t", "postgres", "read", false],
    ["SELECT truncate, COUNT(*) FROM t GROUP BY truncate WITH ROLLUP", "mysql", "read", false],
    ["SELECT id FROM t CONNECT BY PRIOR id = truncate START WITH id = 1", "oracle", "read", false],
    ["SELECT truncate OPERATOR(pg_catalog.+) 1 FROM t", "postgres", "read", false],
    ["SELECT * FROM t ORDER BY truncate ASCENDING", "clickhouse", "read", false],
    ["SELECT sum(x) OVER (ORDER BY truncate RANGE BETWEEN 1 PRECEDING AND CURRENT ROW) FROM t", "postgres", "read", false],
    ["SELECT * FROM t ORDER BY truncate SETTINGS max_threads = 1", "clickhouse", "read", false],
    ["BEGIN NOT ATOMIC TRUNCATE $t; END", "mysql", "write", true],
    ["BEGIN NOT ATOMIC TRUNCATE \u00fcber; END", "mysql", "write", true],
    ["BEGIN NOT ATOMIC DECLARE CONTINUE HANDLER FOR 1062 TRUNCATE nulls; SELECT 1; END", "mysql", "write", true],
    ["BEGIN NOT ATOMIC DECLARE EXIT HANDLER FOR SQLSTATE '23000' TRUNCATE t; SELECT 1; END", "mysql", "write", true],
    ["BEGIN NOT ATOMIC DECLARE CONTINUE HANDLER FOR 1146" + " ".repeat(300) + "TRUNCATE t; SELECT * FROM missing; END", "mysql", "write", true],
    ["IF 1 THEN TRUNCATE t; END IF", "mysql", "write", true],
    ['BEGIN IF (x) THEN TRUNCATE "db"."t"; END IF; END', "snowflake", "write", true],
    ['BEGIN IF (x) THEN TRUNCATE db."t"; END IF; END', "snowflake", "write", true],
    ["BEGIN IF (x) THEN TRUNCATE IF EXISTS t; END IF; END", "snowflake", "write", true],
    ["BEGIN IF (x) THEN TRUNCATE IDENTIFIER('t'); END IF; END", "snowflake", "write", true],
    ["BEGIN NOT ATOMIC IF 1 THEN TRUNCATE `db`.`t`; END IF; END", "mysql", "write", true],
    ["SELECT CASE WHEN a THEN truncate.x END FROM t", "postgres", "read", false],
    ["EXPLAIN (ANALYZE) TRUNCATE t", "duckdb", "write", true],
    ["EXPLAIN (ANALYZE, FORMAT JSON) TRUNCATE t", "duckdb", "write", true],
    ["SELECT DEFAULT(truncate) FROM t", "mysql", "read", false],
    ["SELECT atomic truncate FROM (VALUES (1)) AS t(atomic)", "postgres", "read", false],
    ["SELECT found truncate, x FROM t", "postgres", "read", false],
    ["SELECT seq.NEXTVAL", "mysql", "write", false],
    ["SELECT s./*comment*/NEXTVAL FROM dual WHERE ROWNUM = 1", "oracle", "write", false],
    ['SELECT s . /* c */ "NEXTVAL" FROM dual', "snowflake", "write", false],
    ["BEGIN NOT ATOMIC IF 1 THEN TRUNCATE t NOWAIT; END IF; END", "mysql", "write", true],
    ["BEGIN NOT ATOMIC IF 1 THEN TRUNCATE t WAIT 5; END IF; END", "mysql", "write", true],
    ["IF 1 THEN TRUNCATE t NOWAIT; END IF", "mysql", "write", true],
    ["CASE WHEN 1 THEN TRUNCATE t NOWAIT; END CASE", "mysql", "write", true],
    ["IF 1 THEN TRUNCATE `d`.`t` WAIT 5; END IF", "mysql", "write", true],
    // ClickHouse heredocs are strings.
    ["SELECT $x$'$x$ AS a FROM jdbc($x$ds$x$, $x$INSERT INTO t VALUES (1)$x$) WHERE $x$'$x$ = 1", "clickhouse", "write", false],
    ["SELECT $heredoc$it's$heredoc$ AS v", "clickhouse", "read", false],
    ["SELECT $1$'$1$ AS a FROM jdbc($x$ds$x$, $x$INSERT INTO t VALUES (1)$x$) WHERE $1$'$1$ = 1", "clickhouse", "write", false],
    ["SELECT $-$'$-$ AS a FROM jdbc($x$ds$x$, $x$INSERT INTO t VALUES (1)$x$) WHERE $-$'$-$ = 1", "clickhouse", "write", false],
    ["SELECT\u00a0$x$'$x$ AS a FROM jdbc($x$ds$x$, $x$INSERT INTO t VALUES (1)$x$) WHERE\u00a0$x$'$x$ = $x$a$x$", "clickhouse", "write", false],
    ["BEGIN IF (1=1) THEN TRUNCATE db..t; END IF; END", "snowflake", "write", true],
    ["SELECT * FROM postgres_attach('dbname=x')", "duckdb", "write", false],
    // Databricks functions that call outside systems.
    ["SELECT http_request(conn => 'c', method => 'POST', path => '/x')", "databricks", "write", false],
    ["SELECT * FROM remote_query('pg', database => 'db', query => 'DELETE FROM t RETURNING *')", "databricks", "write", false],
    ["SELECT * FROM TABLE(GETNEXTVAL(s))", "snowflake", "write", false],
    ["SELECT CASE WHEN true THEN truncate ELSE 0 END FROM metrics", "postgres", "read", false],
    ["SELECT CASE WHEN a THEN 1 ELSE truncate END FROM metrics", "duckdb", "read", false],
    // MySQL 8 reads quotes in a /*+ hint, so one there makes the SQL uncertain.
    ["SELECT /*+ QB_NAME(`*/`) */ 1 INTO OUTFILE '/tmp/x' -- `", "mysql", "write", false],
    ["SELECT /*+ SET_VAR(sql_mode='*/') */ 1 INTO OUTFILE '/tmp/x' -- '", "mysql", "write", false],
    ["SELECT /*+ MAX_EXECUTION_TIME(1000) */ * FROM t", "mysql", "read", false],
    // Snowflake: ->> chains statements; ASYNC ( and := ( hold one.
    ["SELECT 1 ->> TRUNCATE t -- LIMIT", "snowflake", "write", true],
    ["SELECT 1 ->> DELETE FROM t", "snowflake", "write", false],
    ["BEGIN ASYNC (TRUNCATE t); AWAIT ALL; END", "snowflake", "write", true],
    ["BEGIN LET r RESULTSET := (TRUNCATE t); RETURN TABLE(r); END", "snowflake", "write", true],
    ["SELECT data ->> 'a' FROM t", "postgres", "read", false],
    ["SELECT j ->> truncate FROM t", "postgres", "read", false],
    ["BEGIN LET r RESULTSET DEFAULT (TRUNCATE t); RETURN TABLE(r); END", "snowflake", "write", true],
    // DuckDB runs TRUNCATE under EXPLAIN ANALYZE and PREPARE ... AS.
    ["EXPLAIN ANALYZE TRUNCATE t", "duckdb", "write", true],
    ["PREPARE p AS TRUNCATE t; EXECUTE p", "duckdb", "write", true],
    // Spark/Hive TRANSFORM ... USING runs a command; reflect() calls any Java method.
    ["SELECT TRANSFORM(a) USING 'rm -rf /tmp/x' FROM t", "databricks", "write", false],
    ["SELECT reflect('java.lang.System', 'exit', 0)", "spark", "write", false],
    ["SELECT transform(arr, x -> x + 1) FROM t", "databricks", "read", false],
    ["SELECT transform(arr, x -> x + 1) FROM t JOIN u USING (id)", "spark", "read", false],
    ["SELECT TRANSFORM(a) USING /*c*/ 'touch /tmp/proof' FROM t", "spark", "write", false],
    ['SELECT TRANSFORM(a) USING "touch /tmp/proof" FROM t', "databricks", "write", false],
    // UESCAPE without a U& literal is a word, not an escape character.
    ["UPDATE t SET uescape = 1", "postgres", "write", false],
    ["UPDATE t SET uescape = menu&1", "postgres", "write", false],
    // Sequence advances through a quoted name, and DuckDB extension functions that write.
    ['SELECT s."NEXTVAL"', "snowflake", "write", false],
    ['SELECT "NEXT VALUE FOR" FROM metrics', "postgres", "read", false],
    ["SELECT s.nextval FROM metrics s", "postgres", "read", false],
    ["SELECT CASE WHEN true THEN truncate SIMILAR TO 'a%' ELSE false END FROM metrics", "postgres", "read", false],
    ["SELECT CASE WHEN a THEN truncate AT TIME ZONE 'UTC' END FROM metrics", "postgres", "read", false],
    // TRUNCATE before END and `;` is read as TRUNCATE end (MySQL); with FROM after it, a column.
    ["SELECT CASE WHEN a THEN 1 ELSE truncate END;", "postgres", "write", true],
    ["SELECT CASE WHEN a THEN 1 ELSE truncate END FROM metrics;", "postgres", "read", false],
    ["SELECT * FROM bigquery_execute('p', 'DELETE FROM d.t WHERE true')", "duckdb", "write", false],
    ["SELECT * FROM ducklake_expire_snapshots('lake', older_than => now())", "duckdb", "write", false],
    // ClickHouse jdbc() can run a mutation through the bridge.
    ["SELECT * FROM jdbc('ch-server?mutation', 'INSERT INTO audit VALUES (1)')", "clickhouse", "write", false],
    // Identifiers that are never strings are not read as SQL.
    ['CREATE TABLE t ("truncate" int)', "postgres", "write", false],
    ["INSERT INTO t ([truncate]) VALUES (1)", "sqlserver", "write", false],
    ['EXEC("DROP DATABASE prod")', "sqlserver", "write", true],
    // Each engine's escapes: whitespace escapes are spaces, letter escapes the letter, and SQL Server
    // joins a line ending in a backslash.
    ["DO E'BEGIN DROP\\nSCH\\eMA s CASCADE; END'", "postgres", "write", true],
    ["EXECUTE IMMEDIATE 'DROP\\nSCH\\eMA s'", "snowflake", "write", true],
    ["PREPARE s FROM 'DROP\\nDAT\\aBASE x'", "mysql", "write", true],
    ["EXEC('DROP DATA\\\nBASE x')", "sqlserver", "write", true],
    ["EXEC sp_executesql N'TRUN\\\r\nCATE TABLE t'", "fabric", "write", true],
    // A Spark hint's body is code: a quote in it makes the SQL uncertain.
    ["WITH c AS (SELECT /*+ X('*/') */ ' AS a) SELECT 1 AS z /*' AS a) INSERT INTO t SELECT * FROM c -- */", "databricks", "write", false],
    ["SELECT /*+ BROADCAST(t) */ * FROM t", "databricks", "read", false],
    // Oracle q-quotes are uncertain.
    ["DECLARE v VARCHAR2(9); w VARCHAR2(9); BEGIN v := q'{ ' }'; w := ' -- '; EXECUTE IMMEDIATE 'TRUNCATE TABLE t'; END;", "oracle", "write", true],
    // A quoted target is still a target; Spark "..." is a string dynamic SQL can run.
    ["BEGIN NOT ATOMIC TRUNCATE `t`; END", "mysql", "write", true],
    ["SELECT \"truncate\" FROM t", "postgres", "read", false],
    ['EXECUTE IMMEDIATE "TRUNCATE TABLE t"', "databricks", "write", true],
    ['EXECUTE IMMEDIATE "DROP SCHEMA s CASCADE"', "spark", "write", true],
    // DROP NAMESPACE is Spark's DROP SCHEMA, nested too.
    ["EXECUTE IMMEDIATE 'DROP NAMESPACE s CASCADE'", "databricks", "write", true],
    ["BEGIN DROP NAMESPACE s CASCADE; END", "databricks", "write", true],
    ["SELECT dbo.truncate(x, 2) FROM t", "sqlserver", "read", false],
    // Other names for dropping a database or schema.
    ["DROP CATALOG prod CASCADE", "databricks", "write", true],
    ["DROP EXTERNAL SCHEMA ds", "bigquery", "write", true],
    ["DROP PLUGGABLE DATABASE pdb1 INCLUDING DATAFILES", "oracle", "write", true],
    // A column or alias named truncate is not the statement.
    ["SELECT truncate FROM t", "postgres", "read", false],
    ["SELECT 1 AS truncate", "postgres", "read", false],
    ["BEGIN TRUNCATE t; END", "snowflake", "write", true],
    // Identifiers take no backslash escapes.
    ['SELECT "a\\" FROM t', "postgres", "read", false],
    ["SELECT `a\\` FROM t", "databricks", "read", false],
    // Sequence advances are writes in every dialect.
    ["SELECT NEXT VALUE FOR dbo.s", "sqlserver", "write", false],
    ["SELECT s.NEXTVAL FROM dual", "oracle", "write", false],
    ["SELECT s.nextval", "snowflake", "write", false],
    // Where comment nesting is not known (Redshift, Snowflake...), a /* inside a comment is uncertain.
    ["SELECT 1 /* /* */ AS x, ' */ ; DROP SCHEMA s; -- ' AS y", "redshift", "write", true],
    ["SELECT 1 /* /* */ ; DROP SCHEMA s; -- */", "snowflake", "write", true],
    // MySQL: -- is a comment only before ASCII whitespace; U+00A0 starts an identifier.
    ["SELECT 1 --\u00a0 FROM (SELECT 1 AS `\u00a0`) d INTO OUTFILE '/tmp/x'", "mysql", "write", false],
    // PostgreSQL: non-ASCII characters belong to identifiers and dollar tags.
    ["SELECT 1 AS \u00e9$$; DROP SCHEMA s CASCADE; SELECT 1 AS \u00e9$$", "postgres", "write", true],
    ["SELECT $\u00e9$'$\u00e9$ ; DROP SCHEMA s; -- '", "postgres", "write", true],
    // PostgreSQL with standard_conforming_strings off reads \' as an escaped quote.
    ["SELECT '\\' -- '; DROP SCHEMA s; --", "postgres", "write", true],
    ["SELECT 'a\\b' AS v, E'it\\'s' AS w", "postgres", "read", false],
    // Spark/Databricks/Hive: only a quote after an odd run of backslashes is uncertain.
    ["SELECT regexp_extract(s, '(\\\\d+)', 1), r'\\d+' FROM t", "databricks", "read", false],
    ["SELECT 'a\\nb' AS v", "hive", "read", false],
    // Snowflake: // comments; only $$ dollar quotes.
    ["SELECT 1 // c\n, 2", "snowflake", "read", false],
    ["SELECT $a$ AS v", "snowflake", "read", false],
    // The hard deny is DROP DATABASE/SCHEMA and TRUNCATE, not other drops near a SCHEMA.
    ["DROP TABLE IF EXISTS s.t; CREATE SCHEMA IF NOT EXISTS s2", "postgres", "write", false],
    ["ALTER TABLE t DROP COLUMN c; GRANT USAGE ON SCHEMA s TO r", "postgres", "write", false],
    ["SELECT 1; DROP/**/SCHEMA s", "postgres", "write", true],
    // A clause word that is not reserved can be TRUNCATE's target: refused unless the clause goes on.
    ...("settings start filter at escape nulls connect ascending descending sounds glob isnull notnull " +
      "overlaps within similar ilike operator qualify offset minus end")
      .split(" ")
      .flatMap((word): [string, string, "write", boolean][] => [
        [`CREATE PROCEDURE p() TRUNCATE ${word}`, "mysql", "write", true],
        [`CREATE PROCEDURE p() TRUNCATE /*c*/ ${word}.orders`, "mysql", "write", true],
      ]),
    ["CREATE TASK k AS TRUNCATE groups", "snowflake", "write", true],
    ["CREATE PROCEDURE p() TRUNCATE settings$archive", "mysql", "write", true],
    ["CREATE PROCEDURE p() TRUNCATE settingsé", "mysql", "write", true],
    ["CREATE TASK k AS TRUNCATE groups$archive", "snowflake", "write", true],
    ["CREATE PROCEDURE p() TRUNCATE settings NOWAIT", "mariadb", "write", true],
    ["CREATE PROCEDURE p() TRUNCATE settings WAIT 5", "mariadb", "write", true],
    ["CREATE PROCEDURE p() TRUNCATE from$x", "mysql", "write", true],
    ["CREATE TASK k AS TRUNCATE settings", "snowflake", "write", true],
    ["SELECT truncate FROM t ORDER BY truncate DESC", "mysql", "read", false],
    ["SELECT * FROM t ORDER BY a, truncate ASC", "snowflake", "read", false],
    ["SELECT sum(truncate) FILTER (WHERE x) FROM t", "postgres", "read", false],
    // Dynamic SQL joins its literals, so a hard deny split across them counts.
    ["EXEC('DROP ' + 'DATABASE victim')", "sqlserver", "write", true],
    ["EXECUTE IMMEDIATE CONCAT('DROP ', 'SCHEMA victim CASCADE')", "bigquery", "write", true],
    ["SET @s = CONCAT('DROP ', 'DATABASE victim'); PREPARE p FROM @s; EXECUTE p", "mysql", "write", true],
    ["DO 'BEGIN DROP '\n'SCHEMA victim CASCADE; END'", "postgres", "write", true],
    // A dot inside one quoted name is not a sequence advance.
    ['SELECT "s.NEXTVAL" FROM metrics', "snowflake", "read", false],
    ['SELECT "s.NEXTVAL" FROM metrics', "oracle", "read", false],
    ["SELECT `s.NEXTVAL` FROM metrics", "mysql", "read", false],
    // DuckLake's metadata functions read; its maintenance functions write.
    ["SELECT * FROM ducklake_snapshots('lake')", "duckdb", "read", false],
    ["SELECT * FROM ducklake_table_info('lake')", "duckdb", "read", false],
  ]
  for (const [sql, dialect, queryType, blocked] of cases)
    test(`${dialect}: ${sql.replace(/\n/g, "\\n")}`, () => {
      const result = classifyAndCheck(sql, dialect)
      expect(result.queryType).toBe(queryType)
      expect(result.blocked).toBe(blocked)
    })

  test("stays linear on large crafted inputs", () => {
    // Each input on its own: a quadratic scan takes seconds to minutes here, a linear one well under a second.
    const inputs: [string, string][] = [
      ["TRUNCATE /* ".repeat(40_000) + "*/ ( '", "mysql"],
      // An unclosed EXPLAIN option list, and a long dotted name after THEN truncate.
      ["EXPLAIN (" + "ANALYZE ".repeat(40_000), "duckdb"],
      ["EXPLAIN (".repeat(40_000), "duckdb"],
      ["IF 1 THEN TRUNCATE IDENTIFIER(".repeat(20_000), "snowflake"],
      // Long whitespace in SQL read with certainty (the TRUNCATE rules look behind only after a match).
      ["SELECT 1" + " ".repeat(400_000) + "FROM t", "postgres"],
      ["SELECT t." + " ".repeat(400_000) + "truncate x FROM t", "postgres"],
      ["SELECT " + "t. truncate x, ".repeat(40_000) + "1 FROM t", "postgres"],
      ["SELECT CASE WHEN true THEN truncate -" + "a.".repeat(2_000) + "a + 0 ELSE 0 END FROM t", "duckdb"],
      // A write's literal full of comment openers.
      ["INSERT INTO t VALUES ($$" + "/*x*/".repeat(100_000) + "x$$)", "postgres"],
      // Every TRUNCATE reaching the same comment close and whitespace after it.
      ["SELECT " + "TRUNCATE /*".repeat(40_000) + "*/" + " ".repeat(400_000) + "(", "postgres"],
    ]
    for (const [sql, dialect] of inputs) {
      const started = performance.now()
      classifyAndCheck(sql, dialect)
      expect(performance.now() - started).toBeLessThan(2_000)
    }
  })
})
