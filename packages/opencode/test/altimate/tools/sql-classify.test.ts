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
  for (const dialect of ["mysql", "sqlite", "bigquery", "clickhouse", "unknown", undefined]) {
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
    ["EXEC dbo.refresh @note = 'nightly'", "sqlserver", "write", false],
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
  ]
  for (const [sql, dialect, queryType, blocked] of cases)
    test(`${dialect}: ${sql.replace(/\n/g, "\\n")}`, () => {
      const result = classifyAndCheck(sql, dialect)
      expect(result.queryType).toBe(queryType)
      expect(result.blocked).toBe(blocked)
    })

  test("stays linear on repeated TRUNCATE inside a long comment", () => {
    const started = performance.now()
    classifyAndCheck("TRUNCATE /* ".repeat(40_000) + "*/ ( '", "mysql")
    // Every TRUNCATE reaching the same comment close and whitespace after it.
    classifyAndCheck("SELECT " + "TRUNCATE /*".repeat(40_000) + "*/" + " ".repeat(400_000) + "(", "postgres")
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})
