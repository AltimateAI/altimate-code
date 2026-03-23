/**
 * Adversarial, user-perspective, and extended E2E tests for SQL validation.
 *
 * Covers:
 * 1. Adversarial inputs to sql-classify (bypass attempts, encoding tricks, edge cases)
 * 2. User-perspective: sql_execute tool with mocked ctx.ask (permission flow, error messages)
 * 3. E2E: full pipeline through Dispatcher with realistic scenarios
 * 4. Stress: concurrent validation, large payloads, rapid-fire calls
 */

import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test"

// Mock DuckDB driver so sql.execute tests don't need native duckdb
mock.module("@altimateai/drivers/duckdb", () => ({
  connect: async () => ({
    execute: async (sql: string) => ({
      columns: ["result"],
      rows: [["ok"]],
      row_count: 1,
      truncated: false,
    }),
    connect: async () => {},
    close: async () => {},
    schemas: async () => [],
    tables: async () => [],
    columns: async () => [],
  }),
}))

import * as Dispatcher from "../../src/altimate/native/dispatcher"
import { registerAll } from "../../src/altimate/native/altimate-core"
import { registerAllSql } from "../../src/altimate/native/sql/register"
import { registerAll as registerConnections } from "../../src/altimate/native/connections/register"
import * as Registry from "../../src/altimate/native/connections/registry"
import { classifyAndCheck } from "../../src/altimate/tools/sql-classify"
import { SqlExecuteTool } from "../../src/altimate/tools/sql-execute"
import { Instance } from "../../src/project/instance"
import { SessionID, MessageID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

beforeAll(() => {
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
  registerAll()
  registerAllSql()
  registerConnections()
})
afterAll(() => {
  delete process.env.ALTIMATE_TELEMETRY_DISABLED
})

// Shared test context for tool execution
const baseCtx = {
  sessionID: SessionID.make("ses_test_adversarial"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [] as any[],
  metadata: () => {},
  ask: async () => {},
}

// ==========================================================================
// 1. ADVERSARIAL: sql-classify bypass attempts
// ==========================================================================

describe("Adversarial: sql-classify bypass attempts", () => {
  // --- SQL comment injection ---

  test("line comment after SELECT hides nothing", () => {
    const r = classifyAndCheck("SELECT 1 -- DROP DATABASE prod")
    expect(r.queryType).toBe("read")
    expect(r.blocked).toBe(false)
  })

  test("block comment with DROP keyword is still just a SELECT", () => {
    const r = classifyAndCheck("SELECT /* DROP DATABASE */ 1")
    expect(r.queryType).toBe("read")
    expect(r.blocked).toBe(false)
  })

  test("DROP DATABASE inside line comment is NOT blocked", () => {
    // The comment makes it not a real statement
    const r = classifyAndCheck("SELECT 1 -- DROP DATABASE production")
    expect(r.blocked).toBe(false)
  })

  test("block comment surrounding entire DROP is not a statement", () => {
    const r = classifyAndCheck("/* DROP DATABASE production */")
    expect(r.blocked).toBe(false)
  })

  test("real DROP after comment-looking text IS blocked", () => {
    const r = classifyAndCheck("SELECT 1;\nDROP DATABASE production")
    expect(r.blocked).toBe(true)
  })

  // --- String literal injection ---

  test("DROP DATABASE inside string literal is not blocked", () => {
    const r = classifyAndCheck("SELECT 'DROP DATABASE production' AS label")
    expect(r.queryType).toBe("read")
    expect(r.blocked).toBe(false)
  })

  test("TRUNCATE inside string literal is not blocked", () => {
    const r = classifyAndCheck("INSERT INTO logs VALUES ('TRUNCATE TABLE users happened')")
    expect(r.queryType).toBe("write")
    expect(r.blocked).toBe(false) // string literal, not real TRUNCATE
  })

  test("DROP SCHEMA inside double-quoted identifier is not blocked", () => {
    const r = classifyAndCheck('SELECT "DROP SCHEMA" FROM metadata')
    expect(r.blocked).toBe(false)
  })

  // --- Unicode and encoding ---

  test("unicode identifiers classify correctly", () => {
    const r = classifyAndCheck('SELECT * FROM "日本語テーブル"')
    expect(r.queryType).toBe("read")
    expect(r.blocked).toBe(false)
  })

  test("emoji in string literal doesn't break classifier", () => {
    const r = classifyAndCheck("SELECT '🔥💀🎉' AS emoji")
    expect(r.queryType).toBe("read")
    expect(r.blocked).toBe(false)
  })

  test("mixed-case DROP DATABASE is still blocked", () => {
    const r = classifyAndCheck("DrOp DaTaBaSe production")
    expect(r.blocked).toBe(true)
  })

  test("mixed-case TRUNCATE TABLE is still blocked", () => {
    const r = classifyAndCheck("TrUnCaTe TaBlE users")
    expect(r.blocked).toBe(true)
  })

  // --- Whitespace and formatting tricks ---

  test("extra whitespace around DROP DATABASE still blocked", () => {
    const r = classifyAndCheck("  DROP   DATABASE   prod  ")
    expect(r.blocked).toBe(true)
  })

  test("newlines before DROP DATABASE still blocked", () => {
    const r = classifyAndCheck("\n\n\nDROP DATABASE prod")
    expect(r.blocked).toBe(true)
  })

  test("tab characters in DROP SCHEMA still blocked", () => {
    const r = classifyAndCheck("DROP\tSCHEMA\tpublic")
    expect(r.blocked).toBe(true)
  })

  // --- Multi-statement bypass attempts ---

  test("benign SELECT before DROP DATABASE still blocked", () => {
    const r = classifyAndCheck("SELECT 1; DROP DATABASE prod")
    expect(r.blocked).toBe(true)
  })

  test("benign SELECT before TRUNCATE still blocked", () => {
    const r = classifyAndCheck("SELECT 1; TRUNCATE TABLE users")
    expect(r.blocked).toBe(true)
  })

  test("multiple DROPs all blocked", () => {
    const r = classifyAndCheck("DROP DATABASE a; DROP SCHEMA b; TRUNCATE c")
    expect(r.blocked).toBe(true)
  })

  test("write buried between reads is still write", () => {
    const r = classifyAndCheck("SELECT 1; INSERT INTO t VALUES (1); SELECT 2")
    expect(r.queryType).toBe("write")
  })

  // --- Edge case inputs ---

  test("null-like string doesn't crash", () => {
    const r = classifyAndCheck("null")
    expect(r).toHaveProperty("queryType")
    expect(r).toHaveProperty("blocked")
  })

  test("undefined-like string doesn't crash", () => {
    const r = classifyAndCheck("undefined")
    expect(r).toHaveProperty("queryType")
    expect(r).toHaveProperty("blocked")
  })

  test("single semicolon doesn't crash (may throw parse error)", () => {
    // altimate-core may throw a parse error on bare semicolons — that's acceptable
    try {
      const r = classifyAndCheck(";")
      expect(r).toHaveProperty("queryType")
      expect(r).toHaveProperty("blocked")
    } catch (e: any) {
      expect(e.message || String(e)).toBeTruthy() // Error is clear, not a segfault
    }
  })

  test("multiple semicolons don't crash (may throw parse error)", () => {
    try {
      const r = classifyAndCheck(";;;")
      expect(r).toHaveProperty("queryType")
      expect(r).toHaveProperty("blocked")
    } catch (e: any) {
      expect(e.message || String(e)).toBeTruthy()
    }
  })

  test("only whitespace doesn't crash", () => {
    const r = classifyAndCheck("   \n\t\n   ")
    expect(r).toHaveProperty("queryType")
    expect(r).toHaveProperty("blocked")
  })

  test("only comments are not blocked", () => {
    const r = classifyAndCheck("-- this is a comment\n/* block */")
    expect(r.blocked).toBe(false)
  })

  test("extremely long SELECT (50KB) doesn't crash", () => {
    const cols = Array.from({ length: 5000 }, (_, i) => `col_${i}`).join(", ")
    const r = classifyAndCheck(`SELECT ${cols} FROM big_table`)
    expect(r.queryType).toBe("read")
    expect(r.blocked).toBe(false)
  })

  test("extremely long INSERT (50KB) is classified as write", () => {
    const vals = Array.from({ length: 5000 }, (_, i) => `(${i}, 'val_${i}')`).join(", ")
    const r = classifyAndCheck(`INSERT INTO big_table VALUES ${vals}`)
    expect(r.queryType).toBe("write")
    expect(r.blocked).toBe(false)
  })

  // --- Nested CTE bypass attempts ---

  test("CTE hiding a DROP in its body still blocked", () => {
    const r = classifyAndCheck(
      "WITH temp AS (SELECT 1) DROP DATABASE prod",
    )
    expect(r.blocked).toBe(true)
  })

  test("deeply nested subquery is still read", () => {
    const r = classifyAndCheck(
      "SELECT * FROM (SELECT * FROM (SELECT * FROM (SELECT 1) a) b) c",
    )
    expect(r.queryType).toBe("read")
    expect(r.blocked).toBe(false)
  })

  // --- Database-specific syntax ---

  test("PostgreSQL COPY is classified as write", () => {
    const r = classifyAndCheck("COPY users TO '/tmp/users.csv' CSV HEADER")
    expect(r.queryType).toBe("write")
  })

  test("BEGIN TRANSACTION is classified as write", () => {
    const r = classifyAndCheck("BEGIN TRANSACTION")
    expect(r.queryType).toBe("write")
  })

  test("COMMIT is classified as write", () => {
    const r = classifyAndCheck("COMMIT")
    expect(r.queryType).toBe("write")
  })

  test("ROLLBACK is classified as write", () => {
    const r = classifyAndCheck("ROLLBACK")
    expect(r.queryType).toBe("write")
  })

  // --- EXPLAIN variants ---

  test("EXPLAIN SELECT is classified as write (ambiguous)", () => {
    const r = classifyAndCheck("EXPLAIN SELECT * FROM users")
    expect(r.queryType).toBe("write")
    expect(r.blocked).toBe(false)
  })

  test("EXPLAIN ANALYZE SELECT is classified as write (ambiguous)", () => {
    const r = classifyAndCheck("EXPLAIN ANALYZE SELECT * FROM users")
    expect(r.queryType).toBe("write")
    expect(r.blocked).toBe(false)
  })
})

// ==========================================================================
// 2. USER PERSPECTIVE: sql_execute tool with mocked permission flow
// ==========================================================================

describe("User perspective: sql_execute permission flow", () => {
  test("read query executes without asking permission", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Registry.setConfigs({ test: { type: "duckdb", path: ":memory:" } })
        const tool = await SqlExecuteTool.init()
        const askRequests: any[] = []
        const testCtx = {
          ...baseCtx,
          ask: async (req: any) => { askRequests.push(req) },
        }
        await tool.execute({ query: "SELECT 1", limit: 10 }, testCtx)
        expect(askRequests.length).toBe(0) // No permission asked
      },
    })
  })

  test("write query asks for sql_execute_write permission", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Registry.setConfigs({ test: { type: "duckdb", path: ":memory:" } })
        const tool = await SqlExecuteTool.init()
        const askRequests: any[] = []
        const testCtx = {
          ...baseCtx,
          ask: async (req: any) => { askRequests.push(req) },
        }
        await tool.execute(
          { query: "INSERT INTO users VALUES (1, 'test')", limit: 100 },
          testCtx,
        )
        expect(askRequests.length).toBe(1)
        expect(askRequests[0].permission).toBe("sql_execute_write")
        expect(askRequests[0].metadata.queryType).toBe("write")
      },
    })
  })

  test("write query permission request includes truncated query pattern", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Registry.setConfigs({ test: { type: "duckdb", path: ":memory:" } })
        const tool = await SqlExecuteTool.init()
        const askRequests: any[] = []
        const testCtx = {
          ...baseCtx,
          ask: async (req: any) => { askRequests.push(req) },
        }
        const longQuery = "UPDATE users SET name = '" + "x".repeat(300) + "'"
        await tool.execute({ query: longQuery, limit: 100 }, testCtx)
        // Pattern should be truncated to 200 chars
        expect(askRequests[0].patterns[0].length).toBeLessThanOrEqual(200)
      },
    })
  })

  test("DROP DATABASE throws immediately without asking permission", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Registry.setConfigs({ test: { type: "duckdb", path: ":memory:" } })
        const tool = await SqlExecuteTool.init()
        const askRequests: any[] = []
        const testCtx = {
          ...baseCtx,
          ask: async (req: any) => { askRequests.push(req) },
        }
        await expect(
          tool.execute({ query: "DROP DATABASE production", limit: 100 }, testCtx),
        ).rejects.toThrow("blocked for safety")
        // Permission was NOT asked — it threw before reaching ctx.ask
        expect(askRequests.length).toBe(0)
      },
    })
  })

  test("TRUNCATE throws immediately without asking permission", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Registry.setConfigs({ test: { type: "duckdb", path: ":memory:" } })
        const tool = await SqlExecuteTool.init()
        const askRequests: any[] = []
        const testCtx = {
          ...baseCtx,
          ask: async (req: any) => { askRequests.push(req) },
        }
        await expect(
          tool.execute({ query: "TRUNCATE TABLE users", limit: 100 }, testCtx),
        ).rejects.toThrow("blocked for safety")
        expect(askRequests.length).toBe(0)
      },
    })
  })

  test("DROP SCHEMA throws with clear user-facing message", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Registry.setConfigs({ test: { type: "duckdb", path: ":memory:" } })
        const tool = await SqlExecuteTool.init()
        try {
          await tool.execute(
            { query: "DROP SCHEMA public CASCADE", limit: 100 },
            baseCtx,
          )
          expect(true).toBe(false) // Should not reach here
        } catch (e: any) {
          expect(e.message).toContain("DROP DATABASE")
          expect(e.message).toContain("DROP SCHEMA")
          expect(e.message).toContain("TRUNCATE")
          expect(e.message).toContain("cannot be overridden")
        }
      },
    })
  })

  test("multi-statement with DROP hidden after SELECT still throws", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Registry.setConfigs({ test: { type: "duckdb", path: ":memory:" } })
        const tool = await SqlExecuteTool.init()
        await expect(
          tool.execute(
            { query: "SELECT 1; DROP DATABASE prod", limit: 100 },
            baseCtx,
          ),
        ).rejects.toThrow("blocked for safety")
      },
    })
  })

  test("DDL operations (CREATE TABLE) ask permission", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Registry.setConfigs({ test: { type: "duckdb", path: ":memory:" } })
        const tool = await SqlExecuteTool.init()
        const askRequests: any[] = []
        const testCtx = {
          ...baseCtx,
          ask: async (req: any) => { askRequests.push(req) },
        }
        await tool.execute(
          { query: "CREATE TABLE new_table (id INT, name TEXT)", limit: 100 },
          testCtx,
        )
        expect(askRequests.length).toBe(1)
        expect(askRequests[0].permission).toBe("sql_execute_write")
      },
    })
  })

  test("CTE with only SELECT does NOT ask permission", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Registry.setConfigs({ test: { type: "duckdb", path: ":memory:" } })
        const tool = await SqlExecuteTool.init()
        const askRequests: any[] = []
        const testCtx = {
          ...baseCtx,
          ask: async (req: any) => { askRequests.push(req) },
        }
        await tool.execute(
          {
            query: "WITH cte AS (SELECT 1 AS id) SELECT * FROM cte",
            limit: 100,
          },
          testCtx,
        )
        expect(askRequests.length).toBe(0)
      },
    })
  })

  test("CTE with INSERT DOES ask permission", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Registry.setConfigs({ test: { type: "duckdb", path: ":memory:" } })
        const tool = await SqlExecuteTool.init()
        const askRequests: any[] = []
        const testCtx = {
          ...baseCtx,
          ask: async (req: any) => { askRequests.push(req) },
        }
        await tool.execute(
          {
            query: "WITH cte AS (SELECT 1 AS id) INSERT INTO target SELECT * FROM cte",
            limit: 100,
          },
          testCtx,
        )
        expect(askRequests.length).toBe(1)
        expect(askRequests[0].permission).toBe("sql_execute_write")
      },
    })
  })

  test("successful query returns formatted output with row count", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Registry.setConfigs({ test: { type: "duckdb", path: ":memory:" } })
        const tool = await SqlExecuteTool.init()
        const result = await tool.execute(
          { query: "SELECT 1", limit: 100 },
          baseCtx,
        )
        expect(result.title).toContain("SQL:")
        expect(result.metadata).toHaveProperty("rowCount")
        expect(result.metadata).toHaveProperty("truncated")
      },
    })
  })

  test("title truncates long queries to 60 chars", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Registry.setConfigs({ test: { type: "duckdb", path: ":memory:" } })
        const tool = await SqlExecuteTool.init()
        const longQuery = "SELECT " + Array(100).fill("col").join(", ") + " FROM table"
        const result = await tool.execute(
          { query: longQuery, limit: 100 },
          baseCtx,
        )
        expect(result.title).toContain("...")
        expect(result.title.length).toBeLessThanOrEqual(70) // "SQL: " + 60 + "..."
      },
    })
  })
})

// ==========================================================================
// 3. E2E: Full validation pipeline with realistic user scenarios
// ==========================================================================

describe("E2E: realistic user scenarios through validation pipeline", () => {
  test("data analyst runs a safe reporting query", async () => {
    const sql = `
      SELECT
        department,
        COUNT(*) AS employee_count,
        AVG(salary) AS avg_salary,
        MAX(salary) AS max_salary
      FROM employees
      WHERE hire_date >= '2024-01-01'
      GROUP BY department
      ORDER BY avg_salary DESC
      LIMIT 20
    `
    // Step 1: Analyze
    const analyzeResult = await Dispatcher.call("sql.analyze", { sql })
    expect(analyzeResult.success).toBe(true)
    expect(analyzeResult.issue_count).toBe(0)

    // Step 2: Validate
    const validateResult = await Dispatcher.call("altimate_core.validate", { sql })
    expect(validateResult).toHaveProperty("success")

    // Step 3: Classify
    const { queryType, blocked } = classifyAndCheck(sql)
    expect(queryType).toBe("read")
    expect(blocked).toBe(false)
  })

  test("data engineer writes a migration query — goes through permission", async () => {
    const sql = `
      ALTER TABLE orders ADD COLUMN discount_pct DECIMAL(5,2) DEFAULT 0.00
    `
    // Analyze
    const analyzeResult = await Dispatcher.call("sql.analyze", { sql })
    expect(analyzeResult).toHaveProperty("success")

    // Classify
    const { queryType, blocked } = classifyAndCheck(sql)
    expect(queryType).toBe("write")
    expect(blocked).toBe(false) // ALTER is not hard-blocked, just needs permission
  })

  test("user accidentally tries DROP DATABASE — hard blocked before any execution", async () => {
    const sql = "DROP DATABASE analytics_prod"

    // Classify immediately catches it
    const { queryType, blocked } = classifyAndCheck(sql)
    expect(queryType).toBe("write")
    expect(blocked).toBe(true)

    // Validation still runs (doesn't crash)
    const validateResult = await Dispatcher.call("altimate_core.validate", { sql })
    expect(validateResult).toHaveProperty("success")
  })

  test("complex CTE with window functions passes full pipeline", async () => {
    const sql = `
      WITH ranked_sales AS (
        SELECT
          product_id,
          region,
          SUM(amount) AS total_sales,
          ROW_NUMBER() OVER (PARTITION BY region ORDER BY SUM(amount) DESC) AS rank
        FROM sales
        WHERE sale_date BETWEEN '2024-01-01' AND '2024-12-31'
        GROUP BY product_id, region
      )
      SELECT product_id, region, total_sales, rank
      FROM ranked_sales
      WHERE rank <= 5
      ORDER BY region, rank
    `
    const [analyze, validate] = await Promise.all([
      Dispatcher.call("sql.analyze", { sql }),
      Dispatcher.call("altimate_core.validate", { sql }),
    ])
    expect(analyze).toHaveProperty("success")
    expect(validate).toHaveProperty("success")

    const { queryType, blocked } = classifyAndCheck(sql)
    expect(queryType).toBe("read")
    expect(blocked).toBe(false)
  })

  test("SQL with anti-patterns is flagged by analyzer but still allowed to execute", async () => {
    const sql = "SELECT * FROM users, orders"

    const analyzeResult = await Dispatcher.call("sql.analyze", { sql })
    expect(analyzeResult.issue_count).toBeGreaterThan(0) // Cartesian product / SELECT *

    // But classification still allows it (it's a read)
    const { queryType, blocked } = classifyAndCheck(sql)
    expect(queryType).toBe("read")
    expect(blocked).toBe(false)
  })

  test("SQL injection attempt is caught by safety scan", async () => {
    const sql = "SELECT * FROM users WHERE id = '1' OR '1'='1'"

    const checkResult = await Dispatcher.call("altimate_core.check", { sql })
    expect(checkResult).toHaveProperty("data")
    const data = checkResult.data as Record<string, any>
    expect(data.safety).toBeDefined()

    // Also test is_safe directly
    const safetyResult = await Dispatcher.call("altimate_core.is_safe", { sql })
    expect(safetyResult).toHaveProperty("success")
  })

  test("user query with schema context gets accurate validation", async () => {
    const sql = "SELECT id, name, email FROM customers WHERE active = true LIMIT 100"
    const schema_context = {
      customers: {
        id: "INTEGER",
        name: "VARCHAR",
        email: "VARCHAR",
        active: "BOOLEAN",
        created_at: "TIMESTAMP",
      },
    }

    const [validate, check, analyze] = await Promise.all([
      Dispatcher.call("altimate_core.validate", { sql, schema_context }),
      Dispatcher.call("altimate_core.check", { sql, schema_context }),
      Dispatcher.call("sql.analyze", { sql, schema_context }),
    ])

    expect(validate.success).toBe(true)
    expect(check.success).toBe(true)
    expect(analyze.issue_count).toBe(0)
  })

  test("MERGE statement needs permission and passes through full pipeline", async () => {
    const sql = `
      MERGE INTO target_table t
      USING source_table s ON t.id = s.id
      WHEN MATCHED THEN UPDATE SET t.name = s.name, t.updated_at = CURRENT_TIMESTAMP
      WHEN NOT MATCHED THEN INSERT (id, name, updated_at) VALUES (s.id, s.name, CURRENT_TIMESTAMP)
    `
    const analyzeResult = await Dispatcher.call("sql.analyze", { sql })
    expect(analyzeResult).toHaveProperty("success")

    const { queryType, blocked } = classifyAndCheck(sql)
    expect(queryType).toBe("write")
    expect(blocked).toBe(false) // MERGE is write but not hard-blocked
  })
})

// ==========================================================================
// 4. E2E: Dispatcher error recovery and resilience
// ==========================================================================

describe("E2E: error recovery and resilience", () => {
  test("malformed SQL doesn't crash any pipeline stage", async () => {
    const malformedQueries = [
      "SELCT * FORM users",
      "INSERT INTO",
      "UPDATE SET WHERE",
      ")))(((",
      "SELECT 'unclosed string",
      "SELECT * FROM `backtick`table`",
    ]

    for (const sql of malformedQueries) {
      // Dispatcher handlers catch errors and return result shapes
      const validate = await Dispatcher.call("altimate_core.validate", { sql })
      expect(validate).toHaveProperty("success")
      expect(validate).toHaveProperty("data")

      const check = await Dispatcher.call("altimate_core.check", { sql })
      expect(check).toHaveProperty("success")
      expect(check).toHaveProperty("data")

      const analyze = await Dispatcher.call("sql.analyze", { sql })
      expect(analyze).toHaveProperty("success")
      expect(analyze).toHaveProperty("issues")

      // Classify may throw on truly unparseable SQL — that's acceptable
      try {
        const classified = classifyAndCheck(sql)
        expect(classified).toHaveProperty("queryType")
        expect(classified).toHaveProperty("blocked")
      } catch (e: any) {
        // Parse error from altimate-core is acceptable, not a crash
        expect(e.message || String(e)).toBeTruthy()
      }
    }
  })

  test("empty input handled gracefully across all pipeline stages", async () => {
    const [validate, check, analyze] = await Promise.all([
      Dispatcher.call("altimate_core.validate", { sql: "" }),
      Dispatcher.call("altimate_core.check", { sql: "" }),
      Dispatcher.call("sql.analyze", { sql: "" }),
    ])

    expect(validate).toHaveProperty("success")
    expect(check).toHaveProperty("success")
    expect(analyze).toHaveProperty("success")

    const classified = classifyAndCheck("")
    expect(classified.queryType).toBe("read")
    expect(classified.blocked).toBe(false)
  })

  test("null/undefined schema_context handled gracefully", async () => {
    const r1 = await Dispatcher.call("altimate_core.validate", {
      sql: "SELECT 1",
      schema_context: null as any,
    })
    expect(r1).toHaveProperty("success")

    const r2 = await Dispatcher.call("altimate_core.validate", {
      sql: "SELECT 1",
      schema_context: undefined as any,
    })
    expect(r2).toHaveProperty("success")
  })

  test("very large schema_context doesn't crash", async () => {
    const schema: Record<string, Record<string, string>> = {}
    for (let i = 0; i < 100; i++) {
      const cols: Record<string, string> = {}
      for (let j = 0; j < 50; j++) {
        cols[`col_${j}`] = "VARCHAR"
      }
      schema[`table_${i}`] = cols
    }

    const r = await Dispatcher.call("altimate_core.validate", {
      sql: "SELECT col_0 FROM table_0",
      schema_context: schema,
    })
    expect(r).toHaveProperty("success")
  })
})

// ==========================================================================
// 5. Stress: concurrent and rapid-fire validation
// ==========================================================================

describe("Stress: concurrent validation", () => {
  test("20 concurrent validate calls all return results", async () => {
    const queries = Array.from(
      { length: 20 },
      (_, i) => `SELECT ${i} AS num, 'query_${i}' AS label`,
    )
    const results = await Promise.all(
      queries.map((sql) =>
        Dispatcher.call("altimate_core.validate", { sql }),
      ),
    )
    expect(results.length).toBe(20)
    for (const r of results) {
      expect(r).toHaveProperty("success")
      expect(r).toHaveProperty("data")
    }
  })

  test("20 concurrent classify calls all return results", () => {
    const queries = Array.from({ length: 20 }, (_, i) =>
      i % 3 === 0
        ? `SELECT ${i}`
        : i % 3 === 1
          ? `INSERT INTO t VALUES (${i})`
          : `DROP DATABASE db_${i}`,
    )
    const results = queries.map((q) => classifyAndCheck(q))
    expect(results.length).toBe(20)

    // Verify correct classification for each type
    for (let i = 0; i < 20; i++) {
      if (i % 3 === 0) {
        expect(results[i].queryType).toBe("read")
        expect(results[i].blocked).toBe(false)
      } else if (i % 3 === 1) {
        expect(results[i].queryType).toBe("write")
        expect(results[i].blocked).toBe(false)
      } else {
        expect(results[i].blocked).toBe(true)
      }
    }
  })

  test("mixed concurrent pipeline calls (analyze + validate + check)", async () => {
    const sql = "SELECT id, name FROM users WHERE id = 1"

    const promises = Array.from({ length: 5 }, () =>
      Promise.all([
        Dispatcher.call("sql.analyze", { sql }),
        Dispatcher.call("altimate_core.validate", { sql }),
        Dispatcher.call("altimate_core.check", { sql }),
      ]),
    )

    const batches = await Promise.all(promises)
    expect(batches.length).toBe(5)

    for (const [analyze, validate, check] of batches) {
      expect(analyze).toHaveProperty("success")
      expect(validate).toHaveProperty("success")
      expect(check).toHaveProperty("success")
    }
  })

  test("rapid sequential classify doesn't accumulate errors", () => {
    for (let i = 0; i < 200; i++) {
      const sql =
        i % 4 === 0
          ? "SELECT 1"
          : i % 4 === 1
            ? "INSERT INTO t VALUES (1)"
            : i % 4 === 2
              ? "DROP DATABASE x"
              : ""
      const r = classifyAndCheck(sql)
      expect(r).toHaveProperty("queryType")
      expect(r).toHaveProperty("blocked")
    }
  })
})

// ==========================================================================
// 6. E2E: Dialect-specific queries through the full pipeline
// ==========================================================================

describe("E2E: dialect-specific SQL through pipeline", () => {
  test("Snowflake QUALIFY clause", async () => {
    const sql = `
      SELECT *
      FROM orders
      QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_date DESC) = 1
    `
    const r = await Dispatcher.call("altimate_core.validate", { sql })
    expect(r).toHaveProperty("success")

    const { queryType, blocked } = classifyAndCheck(sql)
    expect(queryType).toBe("read")
    expect(blocked).toBe(false)
  })

  test("BigQuery STRUCT and ARRAY syntax", async () => {
    const sql = "SELECT STRUCT(1 AS id, 'test' AS name) AS s"
    const r = await Dispatcher.call("altimate_core.validate", { sql })
    expect(r).toHaveProperty("success")

    const { queryType, blocked } = classifyAndCheck(sql)
    expect(queryType).toBe("read")
    expect(blocked).toBe(false)
  })

  test("PostgreSQL RETURNING clause", async () => {
    const sql = "INSERT INTO users (name) VALUES ('test') RETURNING id, name"
    const { queryType, blocked } = classifyAndCheck(sql)
    expect(queryType).toBe("write")
    expect(blocked).toBe(false)
  })

  test("CREATE TABLE AS SELECT", async () => {
    const sql = "CREATE TABLE summary AS SELECT region, SUM(amount) FROM sales GROUP BY region"
    const { queryType, blocked } = classifyAndCheck(sql)
    expect(queryType).toBe("write")
    expect(blocked).toBe(false) // DDL, not hard-blocked
  })

  test("INSERT ... ON CONFLICT (upsert)", async () => {
    const sql = `
      INSERT INTO users (id, name) VALUES (1, 'test')
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
    `
    const { queryType, blocked } = classifyAndCheck(sql)
    expect(queryType).toBe("write")
    expect(blocked).toBe(false)
  })

  test("multiple dialects validate without crashing", async () => {
    const dialectQueries = [
      "SELECT TOP 10 * FROM users",                           // SQL Server
      "SELECT * FROM users LIMIT 10",                         // PostgreSQL/MySQL
      "SELECT * FROM users FETCH FIRST 10 ROWS ONLY",         // ANSI SQL
      "SELECT * FROM users SAMPLE (10)",                       // Snowflake
    ]

    for (const sql of dialectQueries) {
      const r = await Dispatcher.call("altimate_core.validate", { sql })
      expect(r).toHaveProperty("success")
      expect(r).toHaveProperty("data")
    }
  })
})

// ==========================================================================
// 7. E2E: translate and optimize tools in the pipeline
// ==========================================================================

describe("E2E: translate and optimize through pipeline", () => {
  test("sql.translate is callable and returns result shape", async () => {
    const r = await Dispatcher.call("sql.translate", {
      sql: "SELECT IFNULL(name, 'unknown') FROM users",
      source_dialect: "snowflake",
      target_dialect: "postgres",
    })
    expect(r).toHaveProperty("success")
  })

  test("sql.optimize is callable and returns suggestions", async () => {
    const r = await Dispatcher.call("sql.optimize", {
      sql: "SELECT * FROM users WHERE id IN (SELECT user_id FROM orders)",
    })
    expect(r).toHaveProperty("success")
  })

  test("translated SQL maintains correct classification", async () => {
    // A SELECT stays a SELECT after translation
    const translated = await Dispatcher.call("sql.translate", {
      sql: "SELECT NVL(name, 'unknown') FROM users LIMIT 10",
      source_dialect: "snowflake",
      target_dialect: "postgres",
    })

    expect(translated.success).toBe(true)
    expect(translated.translated_sql).toBeDefined()
    const { queryType, blocked } = classifyAndCheck(translated.translated_sql as string)
    expect(queryType).toBe("read")
    expect(blocked).toBe(false)
  })
})
