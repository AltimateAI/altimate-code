import { afterEach, describe, expect, spyOn, test } from "bun:test"
import * as Registry from "../../../src/altimate/native/connections/registry"
import { checkSql, readSql } from "../../../src/altimate/tools/sql-check"
import { classifyAndCheck, isScratchSafeWrite } from "../../../src/altimate/tools/sql-classify"
import { materialize } from "../../../src/altimate/tools/sql-materialize"

afterEach(() => Registry.reset())

const quote = (sql: string) => `'${sql.replaceAll("'", "''")}'`
const query = (sql: string) => `SELECT * FROM query(${quote(sql)})`
const remote = (name: string, sql: string) => `SELECT * FROM ${name}('remote', ${quote(sql)})`

describe("quoted function names and quoted data", () => {
  for (const sql of [
    'SELECT 1 AS "postgres_execute(x)"',
    'SELECT 1 AS "pg_cancel_backend(123)"',
    'SELECT 1 AS "query(DELETE FROM orders)"',
    'SELECT "postgres_execute(x)" FROM orders',
    "SELECT 'postgres_execute(x)' AS value",
    'SELECT 1 AS "postgres_execute" /* (x) */',
    'SELECT 1 AS "pg_cancel_backend" /* (123) */',
    'SELECT 1 AS "prefix""postgres_execute(x)"',
  ]) {
    test(`keeps call-like data read-only: ${sql}`, () => {
      expect(classifyAndCheck(sql, "duckdb")).toEqual({ queryType: "read", blocked: false })
      expect(readSql(sql, "duckdb")).toBe(sql)
    })
  }

  for (const call of [
    "\"postgres_execute\"('remote', 'DELETE FROM orders')",
    "\"postgres_execute\" /* actual call */ ('remote', 'DELETE FROM orders')",
    "main.\"postgres_execute\"('remote', 'DELETE FROM orders')",
  ]) {
    test(`retains write classification for an actual quoted call: ${call}`, () => {
      const sql = `SELECT * FROM ${call}`
      expect(classifyAndCheck(sql, "duckdb").queryType).toBe("write")
      expect(() => readSql(sql, "duckdb")).toThrow(/single read-only SELECT/)
    })
  }

  test("quoted PostgreSQL side-effect calls still fail strict read validation", () => {
    expect(() => readSql('SELECT pg_catalog."pg_cancel_backend" /* call */ (123)', "postgres")).toThrow(
      /single read-only SELECT/,
    )
  })
})

describe("nested SQL execution", () => {
  test("SQL Server XML query methods do not execute SQL strings", () => {
    expect(classifyAndCheck("SELECT doc.query('/root') FROM items", "sqlserver")).toEqual({
      queryType: "read",
      blocked: false,
    })
    expect(classifyAndCheck("SELECT * FROM query('DELETE FROM items')", "duckdb").queryType).toBe("write")
  })

  for (const sql of [
    query("SELECT 1 AS id"),
    "SELECT * FROM query($$SELECT 1 AS id$$)",
    "SELECT * FROM query(E'SELECT 1 AS id')",
    "SELECT * FROM query($inner$SELECT 'DELETE FROM orders' AS value$inner$)",
    query(query("SELECT 1 AS id")),
    query('SELECT 1 AS "postgres_execute(x)"'),
  ]) {
    test(`proves a constant nested SELECT is a classifier read: ${sql}`, () => {
      expect(classifyAndCheck(sql, "duckdb")).toEqual({ queryType: "read", blocked: false })
      // sql_check intentionally retains its existing stricter ban on query().
      expect(() => readSql(sql, "duckdb")).toThrow(/single read-only SELECT/)
    })
  }

  for (const sql of [
    `SELECT * FROM query($$SELECT * FROM "postgres_execute"('remote', 'DELETE FROM orders')$$)`,
    query(remote("mysql_execute", "DELETE FROM orders")),
    query(query(remote("postgres_execute", "DELETE FROM orders"))),
    query("DELETE FROM orders RETURNING *"),
    query("SELECT (1"),
    query(""),
    "SELECT * FROM query(getvariable('sql'))",
    "SELECT * FROM query('SELECT ' || '1')",
    "SELECT * FROM query($1)",
    String.raw`SELECT * FROM query(E'SELECT \u0070g_cancel_backend(123)')`,
  ]) {
    test(`fails closed for unsafe or unprovable nested SQL: ${sql}`, () => {
      expect(classifyAndCheck(sql, "duckdb").queryType).toBe("write")
      expect(() => readSql(sql, "duckdb")).toThrow(/single read-only SELECT/)
    })
  }

  test("nested hard denies survive both recursive layers", () => {
    const sql = query(query("SELECT 1; DROP SCHEMA production"))
    expect(classifyAndCheck(sql, "duckdb")).toMatchObject({ queryType: "write", blocked: true })
  })

  test("deep dynamic SQL fails closed without unbounded recursion", () => {
    let sql = "SELECT 1 AS id"
    for (let i = 0; i < 20; i++) sql = `SELECT * FROM query($nested${i}$${sql}$nested${i}$)`
    expect(classifyAndCheck(sql, "duckdb").queryType).toBe("write")
  })

  test("SQLite eval recursively distinguishes reads, writes and hard denies", () => {
    const read = "SELECT eval('SELECT 1', ',')"
    expect(classifyAndCheck(read, "sqlite")).toEqual({ queryType: "read", blocked: false })
    expect(readSql(read, "sqlite")).toBe(read)
    expect(classifyAndCheck("SELECT eval('DELETE FROM orders')", "sqlite").queryType).toBe("write")
    expect(() => readSql("SELECT eval('DELETE FROM orders')", "sqlite")).toThrow(/single read-only SELECT/)
    expect(classifyAndCheck("SELECT eval('DROP SCHEMA production')", "sqlite")).toMatchObject({
      queryType: "write",
      blocked: true,
    })
    expect(classifyAndCheck("SELECT eval(sql) FROM saved_queries", "sqlite").queryType).toBe("write")
  })

  test("Snowflake TO_QUERY preserves literal read-only SELECTs", () => {
    const sql = "SELECT * FROM TABLE(TO_QUERY('SELECT 1 AS id'))"
    expect(classifyAndCheck(sql, "snowflake")).toEqual({ queryType: "read", blocked: false })
    expect(readSql(sql, "snowflake")).toBe(sql)
  })

  test("Snowflake TO_QUERY rejects side effects within its SQL literal", () => {
    const sql = "SELECT * FROM TABLE(TO_QUERY($$SELECT SYSTEM$CANCEL_QUERY('query-id')$$))"
    expect(classifyAndCheck(sql, "snowflake").queryType).toBe("write")
    expect(() => readSql(sql, "snowflake")).toThrow(/single read-only SELECT/)
  })

  test("Snowflake TO_QUERY fails closed when its SQL argument is dynamic", () => {
    const sql = "SELECT * FROM TABLE(TO_QUERY($sql))"
    expect(classifyAndCheck(sql, "snowflake").queryType).toBe("write")
    expect(() => readSql(sql, "snowflake")).toThrow(/single read-only SELECT/)
  })

  test("scratch CTAS cannot bypass nested execution safety", () => {
    expect(isScratchSafeWrite("CREATE TABLE local_copy AS SELECT 1 AS id")).toBe(true)
    expect(isScratchSafeWrite("CREATE TABLE local_copy AS " + remote("postgres_query", "SELECT 1 AS id"))).toBe(true)
    expect(
      isScratchSafeWrite("CREATE TABLE local_copy AS " + query(remote("postgres_execute", "DELETE FROM orders"))),
    ).toBe(false)
    expect(
      isScratchSafeWrite("CREATE TABLE local_copy AS " + remote("postgres_query", "SELECT pg_cancel_backend(123)")),
    ).toBe(false)
  })

  for (const sql of [
    "SELECT * FROM query_table('orders')",
    "SELECT * FROM query_table(['orders', 'archived_orders'], true)",
    "SELECT * FROM postgres_scan('remote', 'public', 'orders')",
    "SELECT * FROM sqlite_scan('example.sqlite', 'orders')",
  ]) {
    test(`preserves table-name functions that do not execute SQL arguments: ${sql}`, () => {
      expect(classifyAndCheck(sql, "duckdb")).toEqual({ queryType: "read", blocked: false })
      expect(readSql(sql, "duckdb")).toBe(sql)
    })
  }
})

describe("remote SQL execution", () => {
  for (const name of ["postgres_query", "mysql_query", "sqlite_query"]) {
    for (const inner of ["SELECT 1 AS id", "SELECT 'DELETE FROM orders' AS value"]) {
      test(`preserves a read-only ${name} SELECT: ${inner}`, () => {
        const sql = remote(name, inner)
        expect(classifyAndCheck(sql, "duckdb")).toEqual({ queryType: "read", blocked: false })
        expect(readSql(sql, "duckdb")).toBe(sql)
      })
    }

    for (const inner of ["DELETE FROM orders", "SELECT 1; DELETE FROM orders", "SELECT (1"]) {
      test(`rejects unsafe ${name} SQL: ${inner}`, () => {
        const sql = remote(name, inner)
        expect(classifyAndCheck(sql, "duckdb").queryType).toBe("write")
        expect(() => readSql(sql, "duckdb")).toThrow(/single read-only SELECT/)
      })
    }

    test(`fails closed for a dynamic ${name} SQL argument`, () => {
      const sql = `SELECT * FROM ${name}('remote', getvariable('sql'))`
      expect(classifyAndCheck(sql, "duckdb").queryType).toBe("write")
      expect(() => readSql(sql, "duckdb")).toThrow(/single read-only SELECT/)
    })

    test(`propagates hard denies from ${name}`, () => {
      expect(classifyAndCheck(remote(name, "DROP SCHEMA production"), "duckdb")).toMatchObject({
        queryType: "write",
        blocked: true,
      })
    })
  }

  test("uses the remote PostgreSQL dialect for dollar strings", () => {
    const sql = remote("postgres_query", "SELECT $$DELETE FROM orders$$ AS value")
    expect(classifyAndCheck(sql, "duckdb")).toEqual({ queryType: "read", blocked: false })
    expect(readSql(sql, "duckdb")).toBe(sql)
  })

  test("argument separators inside strings and comments cannot replace the SQL argument", () => {
    const read = `SELECT * FROM postgres_query('remote,)', /* , ) */ $$SELECT '(' AS value, 'comma,paren)' AS other$$)`
    expect(classifyAndCheck(read, "duckdb")).toEqual({ queryType: "read", blocked: false })
    expect(readSql(read, "duckdb")).toBe(read)
    const write = `SELECT * FROM postgres_query('remote,)', /* , ) */ $$SELECT pg_cancel_backend(123)$$)`
    expect(classifyAndCheck(write, "duckdb").queryType).toBe("write")
    expect(() => readSql(write, "duckdb")).toThrow(/single read-only SELECT/)
  })

  test("ordinary quoted functions do not inherit SQL argument behavior from object properties", () => {
    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      const sql = `SELECT "${name}"('DROP SCHEMA production') AS value`
      expect(classifyAndCheck(sql, "duckdb")).toEqual({ queryType: "read", blocked: false })
      expect(readSql(sql, "duckdb")).toBe(sql)
    }
  })

  test("remote MySQL arithmetic does not conceal a hard deny", () => {
    const sql = remote("mysql_query", "SELECT 1--2; DROP SCHEMA production")
    expect(classifyAndCheck(sql, "duckdb")).toMatchObject({ queryType: "write", blocked: true })
  })

  test("MySQL ordinary string escapes cannot hide a side-effect call", async () => {
    const inner = String.raw`SELECT 'a\'x', sleep(1), 'a\'x'`
    const sql = remote("mysql_query", inner)
    Registry.setConfigs({ source: { type: "duckdb" } })
    const get = spyOn(Registry, "get").mockRejectedValue(new Error("connector must not be reached"))
    try {
      expect(classifyAndCheck(inner, "mysql").queryType).toBe("write")
      expect(() => readSql(inner, "mysql")).toThrow(/single read-only SELECT/)
      expect(classifyAndCheck(sql, "duckdb").queryType).toBe("write")
      expect(() => readSql(sql, "duckdb")).toThrow(/single read-only SELECT/)
      await expect(checkSql({ warehouse: "source", check: "grain", sql, columns: ["id"] })).rejects.toThrow(
        /single read-only SELECT/,
      )
      expect(get).not.toHaveBeenCalled()
    } finally {
      get.mockRestore()
    }
  })

  test("MySQL function-like string data without ambiguous escapes remains a read", () => {
    const inner = "SELECT 'sleep(1), DELETE FROM orders' AS value"
    const sql = remote("mysql_query", inner)
    expect(classifyAndCheck(inner, "mysql")).toEqual({ queryType: "read", blocked: false })
    expect(readSql(inner, "mysql")).toBe(inner)
    expect(classifyAndCheck(sql, "duckdb")).toEqual({ queryType: "read", blocked: false })
    expect(readSql(sql, "duckdb")).toBe(sql)
  })

  for (const [name, inner] of [
    ["postgres_query", "SELECT pg_cancel_backend(123)"],
    ["postgres_query", 'SELECT pg_catalog."pg_cancel_backend" /* call */ (123)'],
    ["postgres_query", "SELECT pg_some_future_control_function()"],
    ["mysql_query", "SELECT GET_LOCK('resource', 1)"],
    ["sqlite_query", "SELECT load_extension('dangerous')"],
    ["sqlite_query", "SELECT writefile('/tmp/unsafe', 'data')"],
  ]) {
    test(`blocks side effects before ${name} obtains a connector: ${inner}`, async () => {
      const sql = remote(name, inner)
      Registry.setConfigs({ source: { type: "duckdb" } })
      const get = spyOn(Registry, "get").mockRejectedValue(new Error("connector must not be reached"))
      try {
        expect(classifyAndCheck(sql, "duckdb").queryType).toBe("write")
        expect(() => readSql(sql, "duckdb")).toThrow(/single read-only SELECT/)
        await expect(checkSql({ warehouse: "source", check: "grain", sql, columns: ["id"] })).rejects.toThrow(
          /single read-only SELECT/,
        )
        await expect(materialize({ source_warehouse: "source", sql, target_table: "refused" })).rejects.toThrow(
          /only reads/,
        )
        expect(get).not.toHaveBeenCalled()
      } finally {
        get.mockRestore()
      }
    })
  }

  test("detects a quoted remote query call with dollar-quoted SQL", () => {
    const sql = `SELECT * FROM main."postgres_query" /* call */ ('remote', $$SELECT pg_cancel_backend(123)$$)`
    expect(classifyAndCheck(sql, "duckdb").queryType).toBe("write")
    expect(() => readSql(sql, "duckdb")).toThrow(/single read-only SELECT/)
  })

  test("remote side-effect SQL stays unsafe when hidden in query()", () => {
    const sql = query(remote("postgres_query", "SELECT pg_cancel_backend(123)"))
    expect(classifyAndCheck(sql, "duckdb").queryType).toBe("write")
    expect(() => readSql(sql, "duckdb")).toThrow(/single read-only SELECT/)
  })

  for (const call of [
    "odbc_query('remote', 'SELECT pg_cancel_backend(123)')",
    "odbc_copy('remote', 'SELECT 1', 'destination', 'orders')",
    "odbc_commit(123)",
    "odbc_rollback(123)",
    "openquery(remote, 'SELECT pg_cancel_backend(123)')",
    "external_query('remote', 'SELECT pg_cancel_backend(123)')",
  ]) {
    test(`fails closed for an opaque remote execution function: ${call}`, () => {
      const sql = `SELECT * FROM ${call}`
      expect(classifyAndCheck(sql, "duckdb").queryType).toBe("write")
      expect(() => readSql(sql, "duckdb")).toThrow(/single read-only SELECT/)
    })
  }
})

describe("SQL Server carriage-return comment boundary", () => {
  for (const dialect of ["sqlserver", "tsql"]) {
    test(`keeps text within a comment harmless for ${dialect}`, () => {
      const sql = "SELECT 1 -- DROP SCHEMA production\r\n"
      expect(classifyAndCheck(sql, dialect)).toEqual({ queryType: "read", blocked: false })
      expect(readSql(sql, dialect)).toBe(sql)
    })

    test(`refuses a hard-denied statement after CR for ${dialect}`, () => {
      const sql = "SELECT 1 -- x\r; DROP SCHEMA production"
      expect(classifyAndCheck(sql, dialect)).toMatchObject({ queryType: "write", blocked: true })
      expect(() => readSql(sql, dialect)).toThrow(/single read-only SELECT/)
    })
  }
})

describe("nested and remote SQL function allowlist", () => {
  const safe = [
    "SELECT count(*), sum(x), coalesce(max(y), 0) FROM t WHERE id IN (1, 2) GROUP BY z",
    "SELECT lower(name), date_trunc('day', created_at), round(avg(v), 2) FROM t",
    "WITH a AS (SELECT 1 AS id) SELECT * FROM a WHERE EXISTS (SELECT 1)",
    "SELECT row_number() OVER (PARTITION BY a ORDER BY b), CAST(x AS varchar(10)) FROM t",
    "SELECT pg_catalog.current_database(), current_setting('server_version'), pg_size_pretty(pg_database_size('x'))",
    "SELECT * FROM pg_stat_activity WHERE pg_stat_get_backend_pid(1) > 0",
  ]
  for (const name of ["postgres_query", "mysql_query", "sqlite_query"]) {
    for (const inner of safe) {
      test(`keeps standard-function ${name} reads: ${inner}`, () => {
        const sql = remote(name, inner)
        expect(classifyAndCheck(sql, "duckdb")).toEqual({ queryType: "read", blocked: false })
      })
    }
  }

  test("keeps standard-function query() and TO_QUERY reads", () => {
    expect(classifyAndCheck(query("SELECT upper(a), count(*) FROM t GROUP BY 1"), "duckdb").queryType).toBe("read")
    expect(classifyAndCheck("SELECT * FROM TABLE(TO_QUERY($$SELECT upper(a) FROM t$$))", "snowflake").queryType).toBe("read")
    expect(classifyAndCheck("SELECT eval('SELECT length(a) FROM t')", "sqlite").queryType).toBe("read")
  })

  const unsafe = [
    "SELECT public.mutate()",
    "SELECT mutate()",
    "SELECT myschema.upper(a) FROM t",
    "SELECT pg_stat_statements_reset()",
    "SELECT pg_stat_reset()",
    "SELECT pg_stat_reset_shared('bgwriter')",
    "SELECT pg_catalog.pg_stat_statements_reset()",
    "SELECT * FROM t AS x(a, b)",
  ]
  for (const name of ["postgres_query", "mysql_query", "sqlite_query"]) {
    for (const inner of unsafe) {
      test(`requires write for ${name}: ${inner}`, () => {
        const sql = remote(name, inner)
        expect(classifyAndCheck(sql, "duckdb").queryType).toBe("write")
        expect(() => readSql(sql, "duckdb")).toThrow(/single read-only SELECT/)
      })
    }
  }

  test("requires write for unknown functions in query(), TO_QUERY and eval", () => {
    expect(classifyAndCheck(query("SELECT public.mutate()"), "duckdb").queryType).toBe("write")
    expect(classifyAndCheck("SELECT * FROM TABLE(TO_QUERY($$SELECT mutate()$$))", "snowflake").queryType).toBe("write")
    expect(classifyAndCheck("SELECT eval('SELECT mutate()')", "sqlite").queryType).toBe("write")
  })

  test("statistics reset functions are not read-only at the top level", () => {
    for (const fn of ["pg_stat_statements_reset()", "pg_stat_reset()", "pg_stat_reset_slru('x')"]) {
      expect(classifyAndCheck(`SELECT ${fn}`, "postgres").queryType).toBe("write")
      expect(() => readSql(`SELECT ${fn}`, "postgres")).toThrow(/single read-only SELECT/)
    }
    expect(classifyAndCheck("SELECT pg_stat_get_numscans(1)", "postgres").queryType).toBe("read")
  })
})
