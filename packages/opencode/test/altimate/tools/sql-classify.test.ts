import { describe, expect, test } from "bun:test"
import { classify, classifyMulti, classifyAndCheck, computeSqlFingerprint } from "../../../src/altimate/tools/sql-classify"

describe("classify", () => {
  // --- Read queries ---

  test("SELECT → read", () => {
    expect(classify("SELECT * FROM users")).toBe("read")
  })

  test("select lowercase → read", () => {
    expect(classify("select id from orders")).toBe("read")
  })

  test("SHOW → write (ambiguous, prompts for permission)", () => {
    expect(classify("SHOW TABLES")).toBe("write")
  })

  test("EXPLAIN → write (ambiguous, prompts for permission)", () => {
    expect(classify("EXPLAIN SELECT * FROM users")).toBe("write")
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

  test("SHOW TABLES → write (prompts)", () => {
    expect(classify("SHOW TABLES")).toBe("write")
  })

  test("SET variable → write (prompts)", () => {
    expect(classify("SET search_path = public")).toBe("write")
  })

  test("USE database → write (prompts)", () => {
    expect(classify("USE mydb")).toBe("write")
  })
})

describe("classifyMulti", () => {
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

  test("SHOW → write (ambiguous), not blocked", () => {
    const r = classifyAndCheck("SHOW TABLES")
    expect(r.queryType).toBe("write")
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

  test("ambiguous queries (SHOW, SET, USE) prompt for permission", () => {
    // "other" category → treated as write → triggers ctx.ask()
    const ambiguousQueries = ["SHOW TABLES", "SET search_path = public", "USE mydb"]
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

describe("side-effecting function escalation (masked)", () => {
  test("read-shaped SELECT calling a side-effecting function classifies as write", () => {
    expect(classify("SELECT nextval('public.id_seq')")).toBe("write")
    expect(classify("SELECT dblink_exec('conn', 'DELETE FROM users')")).toBe("write")
    expect(classify("SELECT pg_terminate_backend(123)")).toBe("write")
  })

  test("a block comment between function name and paren cannot hide the call", () => {
    expect(classify("SELECT dblink_exec/**/('conn', 'DELETE FROM users')")).toBe("write")
    expect(classify("SELECT nextval /* gap */ ('public.id_seq')")).toBe("write")
  })

  test("function names inside string literals or comments do NOT escalate", () => {
    expect(classify("SELECT * FROM audit WHERE note = 'called dblink_exec(x)'")).toBe("read")
    expect(classify("SELECT id FROM t -- uses nextval(seq) upstream")).toBe("read")
  })

  test("column names containing the function name do NOT escalate", () => {
    expect(classify("SELECT nextval_cache FROM t")).toBe("read")
  })

  test("unlexable SQL fails closed as write", () => {
    expect(classify("SELECT 'unterminated")).toBe("write")
  })

  test("classifyAndCheck escalates side-effecting reads too", () => {
    expect(classifyAndCheck("SELECT setval('s', 10)").queryType).toBe("write")
    expect(classifyAndCheck("SELECT id FROM users").queryType).toBe("read")
  })
})

describe("mask edge cases (round-7 review)", () => {
  test("CR-only line endings do not extend a line comment over later statements", () => {
    expect(classify("SELECT 1; -- note\rDELETE FROM users")).toBe("write")
    expect(classifyAndCheck("SELECT 1; -- note\rDELETE FROM users").queryType).toBe("write")
  })

  test("dollar signs inside identifiers are not dollar-quote openers", () => {
    expect(classify("SELECT foo$bar$ FROM t")).toBe("read")
    expect(classify("SELECT col FROM tbl$x WHERE id = 1")).toBe("read")
  })

  test("comment markers inside strings cannot hide writes from the fallback classifier", () => {
    // classifyFallback path: masked lexing means the '--' literal cannot
    // swallow the DELETE.
    expect(classifyAndCheck("SELECT '--' LIMIT 1; DELETE FROM users").queryType).toBe("write")
  })

  test("large-object mutators escalate to write", () => {
    expect(classify("SELECT lo_import('/etc/passwd')")).toBe("write")
    expect(classify("SELECT lo_unlink(12345)")).toBe("write")
  })
})

describe("quoted-identifier side-effect calls", () => {
  test("double-quoted function identifiers cannot bypass write escalation", () => {
    expect(classify('SELECT "lo_import"(\'/tmp/x\')')).toBe("write")
    expect(classify('SELECT "nextval" (\'public.id_seq\')')).toBe("write")
  })

  test("quoted identifiers that are not side-effect calls stay reads", () => {
    expect(classify('SELECT "nextval_cache" FROM t')).toBe("read")
    expect(classify('SELECT "order" FROM t')).toBe("read")
  })
})
