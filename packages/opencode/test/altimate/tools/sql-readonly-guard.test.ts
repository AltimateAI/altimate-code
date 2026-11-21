import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { PermissionNext } from "../../../src/permission/next"
import { SessionID, MessageID } from "../../../src/session/schema"
import { SqlExecuteTool, deniedWriteMessage } from "../../../src/altimate/tools/sql-execute"
import { classifyAndCheck, isScratchSafeWrite } from "../../../src/altimate/tools/sql-classify"
import * as Registry from "../../../src/altimate/native/connections/registry"
import { closeScratch } from "../../../src/altimate/native/connections/scratch"
import { initTool } from "../tool-fixture"

// A read-only agent denies `sql_execute_write`. Reads must never reach that rule, and when a query does,
// the agent must learn why and what to change instead of a raw permission-rule dump it tends to retry.

const DIALECTS = ["postgres", "snowflake", "bigquery", "duckdb", "sqlite", "mysql", "databricks", "redshift", "sqlserver", "oracle", "clickhouse"]

// What a read-only agent's denial carries: its catch-all write deny.
const READ_ONLY_RULES = [{ permission: "sql_execute_write", pattern: "*", action: "deny" }]

const isRead = (sql: string, dialect: string) => {
  const result = classifyAndCheck(sql, dialect)
  return result.queryType === "read" && !result.blocked
}

const deniedCtx = (asked: unknown[]) => ({
  sessionID: SessionID.make("ses_readonly_guard"),
  messageID: MessageID.make("msg_readonly_guard"),
  callID: "",
  agent: "analyst",
  abort: AbortSignal.any([]),
  messages: [] as any[],
  metadata: () => {},
  ask: async (request: any) => {
    asked.push(request)
    if (request.permission === "sql_execute_write") throw new PermissionV1.DeniedError({ ruleset: READ_ONLY_RULES })
  },
})

let previousTelemetry: string | undefined

beforeAll(() => {
  previousTelemetry = process.env.ALTIMATE_TELEMETRY_DISABLED
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
  Registry.setConfigs({ guard_db: { type: "sqlite", path: ":memory:" } as never })
})

afterEach(async () => {
  await closeScratch()
})

afterAll(() => {
  Registry.reset()
  if (previousTelemetry === undefined) delete process.env.ALTIMATE_TELEMETRY_DISABLED
  else process.env.ALTIMATE_TELEMETRY_DISABLED = previousTelemetry
})

describe("reads are classified as reads in every dialect", () => {
  const reads: Record<string, string> = {
    "comment with write words": "SELECT id FROM orders -- update later\n/* delete stale rows */",
    "leading comment with write words": "-- insert into notes later\nSELECT 1",
    "string literal with write words": "SELECT * FROM orders WHERE status = 'DELETED' OR note = 'insert into x'",
    "identifiers containing write words": "SELECT update_ts, created_by, deleted_at FROM orders",
    "qualified columns named like write keywords": "SELECT o.update, o.delete, o.insert, o.merge FROM orders o",
    "three-part names ending in a write keyword": "SELECT s.o.update FROM s.o",
    "CTE": "WITH a AS (SELECT 1 AS x), b AS (SELECT x FROM a) SELECT * FROM b",
    "EXPLAIN of a read": "EXPLAIN SELECT * FROM orders",
    "leading whitespace": "\n\n   SELECT 1",
    "parenthesized query": "(SELECT 1) UNION ALL (SELECT 2)",
    "two reads": "SELECT 1; SELECT 2",
  }
  // The bundled ClickHouse parser accepts trailing text, so its keyword scan stays strict for dotted names.
  const STRICT_DOTTED = new Set(["qualified columns named like write keywords", "three-part names ending in a write keyword"])
  for (const [name, sql] of Object.entries(reads)) {
    test(name, () => {
      const dialects = STRICT_DOTTED.has(name) ? DIALECTS.filter((d) => d !== "clickhouse") : DIALECTS
      expect(dialects.filter((dialect) => !isRead(sql, dialect))).toEqual([])
    })
  }

  test("ClickHouse keeps dotted write keywords as writes, since its parser accepts trailing text", () => {
    for (const sql of ["SELECT * FROM a.INTO OUTFILE '/tmp/x'", "SELECT a FROM t x.UPDATE t SET a = 1"]) {
      expect(isRead(sql, "clickhouse")).toBe(false)
    }
  })

  test("DESCRIBE, SHOW and PRAGMA metadata reads", () => {
    for (const sql of ["DESCRIBE orders", "SHOW TABLES", "SHOW COLUMNS FROM orders"]) expect(isRead(sql, "duckdb")).toBe(true)
    expect(isRead("PRAGMA table_info('orders')", "sqlite")).toBe(true)
  })
})

describe("writes stay writes", () => {
  const writes: Record<string, string> = {
    INSERT: "INSERT INTO orders VALUES (1)",
    UPDATE: "UPDATE orders SET status = 'x'",
    DELETE: "DELETE FROM orders",
    MERGE: "MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET v = s.v",
    "CREATE TABLE": "CREATE TABLE t (a INT)",
    "DROP TABLE": "DROP TABLE orders",
    "ALTER TABLE": "ALTER TABLE orders ADD COLUMN c INT",
    "COPY INTO": "COPY INTO orders FROM @stage",
    "write after a read": "SELECT 1; DELETE FROM orders",
    "write hidden after a semicolon on one line": "SELECT * FROM orders;DELETE FROM orders",
    "write CTE": "WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x",
    "SELECT INTO": "SELECT * INTO copy_of_orders FROM orders",
    "qualified column beside a real write": "SELECT o.update FROM orders o; UPDATE orders SET a = 1",
    "SELECT INTO after a number ending in a dot": "SELECT 1. INTO copy_of_orders FROM orders",
    "SELECT INTO after a column and a number ending in a dot": "SELECT o.a, 2. INTO copy_of_orders FROM orders o",
    "SELECT INTO after a hex number ending in a dot": "SELECT 0x1.INTO copy_of_orders FROM orders",
    "SELECT INTO after a spaced qualifier": "SELECT o. INTO copy_of_orders FROM orders o",
    "SELECT INTO after a float with an exponent letter": "SELECT 1.e.INTO copy_of_orders FROM orders",
    "write followed by shell residue": "DELETE FROM orders 2>/dev/null",
    "unparseable text": "SELECT FROM WHERE (((",
  }
  for (const [name, sql] of Object.entries(writes)) {
    test(name, () => {
      expect(DIALECTS.filter((dialect) => isRead(sql, dialect))).toEqual([])
    })
  }
})

describe("scratch writes", () => {
  test("the scratch catalog prefix is local", () => {
    expect(isScratchSafeWrite("CREATE OR REPLACE TABLE scratch.pubs AS SELECT 1 AS x")).toBe(true)
    expect(isScratchSafeWrite("CREATE TABLE scratch.main.pubs AS SELECT 1 AS x")).toBe(true)
  })

  test("other catalogs and schemas are not", () => {
    expect(isScratchSafeWrite("CREATE TABLE other.pubs AS SELECT 1 AS x")).toBe(false)
    expect(isScratchSafeWrite("CREATE TABLE other.main.pubs AS SELECT 1 AS x")).toBe(false)
    expect(isScratchSafeWrite("CREATE TABLE scratch.other.pubs AS SELECT 1 AS x")).toBe(false)
  })
})

describe("sql_execute on a read-only agent", () => {
  const run = async (query: string, warehouse = "guard_db") => {
    const tool = await initTool(SqlExecuteTool)
    const asked: any[] = []
    const outcome = await tool.execute({ query, warehouse, limit: 10 }, deniedCtx(asked) as any).then(
      (result: any) => ({ result, error: undefined as string | undefined }),
      (error: Error) => ({ result: undefined, error: error.message }),
    )
    return { ...outcome, asked: asked.filter((request) => request.permission === "sql_execute_write") }
  }

  test("a qualified column named like a keyword runs without asking", async () => {
    const { result, error, asked } = await run("SELECT t.update FROM (SELECT 1 AS \"update\") t", "scratch")
    expect(error).toBeUndefined()
    expect(asked).toHaveLength(0)
    expect(result.output).toMatch(/\b1\b/)
  })

  test("shell residue is named and must be removed; nothing runs", async () => {
    const { error } = await run("SELECT 1 AS x 2>/dev/null")
    expect(error).toContain("`2>/dev/null`")
    expect(error).toContain("Remove it")
    expect(error).not.toContain("relevant rules")
  })

  test("unparseable SQL reports the parser's position", async () => {
    const { error } = await run("SELECT Order Date FROM orders WHERE Order Date > '2020-01-01'")
    expect(error).toMatch(/sqlite SQL parser could not read it \(.*line 1, column \d+/)
    expect(error).toContain("Fix the query")
  })

  test("a write names the statement and suggests a read", async () => {
    const { error } = await run("SELECT 1; DELETE FROM orders")
    expect(error).toContain("statement 2 of 2 is not a read (DELETE)")
    expect(error).not.toContain("FROM orders")
    expect(error).toContain("single read")
  })

  test("a scratch batch mixing a write and a read says to split it", async () => {
    const { error } = await run("CREATE TABLE items AS SELECT 1 AS v; SELECT * FROM items", "scratch")
    expect(error).toContain("statement 1 of 2")
    expect(error).toContain("each call without reads")
  })

  test("a scratch write through the scratch catalog runs without asking", async () => {
    const { error, asked } = await run("CREATE OR REPLACE TABLE scratch.pubs AS SELECT 1 AS x", "scratch")
    expect(error).toBeUndefined()
    expect(asked).toHaveLength(0)
  })

  test("a denial that fails an Effect, as the tool bridge runs it, is explained", async () => {
    const tool = await initTool(SqlExecuteTool)
    // Production runs permission.ask(...).pipe(Effect.orDie) through Effect.runPromise (EffectBridge.promise).
    const ctx = {
      ...deniedCtx([]),
      ask: () => Effect.runPromise(Effect.fail(new PermissionV1.DeniedError({ ruleset: READ_ONLY_RULES })).pipe(Effect.orDie)),
    }
    await expect(
      tool.execute({ query: "DELETE FROM orders", warehouse: "guard_db", limit: 10 }, ctx as any),
    ).rejects.toThrow("it is not a read (DELETE)")
  })

  test("a denial from the subagent permission path is explained too", async () => {
    const tool = await initTool(SqlExecuteTool)
    const ctx = { ...deniedCtx([]), ask: async () => Promise.reject(new PermissionNext.DeniedError(READ_ONLY_RULES as any)) }
    await expect(
      tool.execute({ query: "DELETE FROM orders", warehouse: "guard_db", limit: 10 }, ctx as any),
    ).rejects.toThrow("it is not a read (DELETE)")
  })

  test("errors other than a rule denial pass through unchanged", async () => {
    const tool = await initTool(SqlExecuteTool)
    const ctx = { ...deniedCtx([]), ask: async () => Promise.reject(new Error("rejected by test")) }
    await expect(tool.execute({ query: "DELETE FROM orders", warehouse: "guard_db", limit: 10 }, ctx as any)).rejects.toThrow(
      "rejected by test",
    )
  })
})

describe("denied write message branches", () => {
  const base = { sql: "SELECT 1", dialects: ["postgres"], jinja: false, mongo: false, scratch: false, warehouseGiven: true }

  test("Jinja asks for plain SQL", () => {
    expect(deniedWriteMessage({ ...base, sql: "SELECT * FROM {{ ref('x') }}", jinja: true })).toContain("Send plain SQL without Jinja")
  })

  test("a MongoDB write asks for a read command", () => {
    expect(deniedWriteMessage({ ...base, sql: '{"command":"insertOne"}', mongo: true })).toContain("Use a read command")
  })

  test("a pattern-scoped deny does not claim the agent may only read", () => {
    const message = deniedWriteMessage({ ...base, sql: "DROP TABLE stg_tmp", readOnly: false })
    expect(message).toContain("A sql_execute_write rule denies it")
    expect(message).not.toContain("may only read")
    expect(message).toContain("rules allow")
  })

  test("an agent deny after a user's ask is still read-only", async () => {
    const tool = await initTool(SqlExecuteTool)
    const ruleset = [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "sql_execute_write", pattern: "*", action: "deny" },
      { permission: "sql_execute_write", pattern: "*", action: "ask" },
      { permission: "sql_execute_write", pattern: "*", action: "deny" },
    ]
    const ctx = { ...deniedCtx([]), ask: async () => Promise.reject(new PermissionV1.DeniedError({ ruleset })) }
    await expect(
      tool.execute({ query: "DELETE FROM orders", warehouse: "guard_db", limit: 10 }, ctx as any),
    ).rejects.toThrow("may only read")
  })

  test("a catch-all deny followed by an allow is a rule, not read-only", async () => {
    const tool = await initTool(SqlExecuteTool)
    const ruleset = [
      { permission: "sql_execute_write", pattern: "*", action: "deny" },
      { permission: "sql_execute_write", pattern: "INSERT INTO audit*", action: "allow" },
    ]
    const ctx = { ...deniedCtx([]), ask: async () => Promise.reject(new PermissionV1.DeniedError({ ruleset })) }
    await expect(
      tool.execute({ query: "DELETE FROM orders", warehouse: "guard_db", limit: 10 }, ctx as any),
    ).rejects.toThrow("A sql_execute_write rule denies it")
  })

  test("a pattern-only deny leaves other writes to the default ask, so it is not read-only", async () => {
    const tool = await initTool(SqlExecuteTool)
    const ruleset = [{ permission: "sql_execute_write", pattern: "DROP*", action: "deny" }]
    const ctx = { ...deniedCtx([]), ask: async () => Promise.reject(new PermissionV1.DeniedError({ ruleset })) }
    await expect(
      tool.execute({ query: "DROP TABLE stg_tmp", warehouse: "guard_db", limit: 10 }, ctx as any),
    ).rejects.toThrow("A sql_execute_write rule denies it")
  })

  test("sql_execute reads the denial's rules to choose the wording", async () => {
    const tool = await initTool(SqlExecuteTool)
    const ruleset = [
      { permission: "sql_execute_write", pattern: "*", action: "allow" },
      { permission: "sql_execute_write", pattern: "DROP*", action: "deny" },
    ]
    const ctx = { ...deniedCtx([]), ask: async () => Promise.reject(new PermissionV1.DeniedError({ ruleset })) }
    await expect(
      tool.execute({ query: "DROP TABLE stg_tmp", warehouse: "guard_db", limit: 10 }, ctx as any),
    ).rejects.toThrow("A sql_execute_write rule denies it")
  })

  test("an unreadable query without a warehouse suggests passing one", () => {
    const message = deniedWriteMessage({ ...base, sql: "SELECT FROM WHERE (((", dialects: ["postgres", "snowflake"], warehouseGiven: false })
    expect(message).toContain("pass warehouse")
    expect(deniedWriteMessage({ ...base, sql: "SELECT FROM WHERE (((" })).not.toContain("pass warehouse")
    expect(deniedWriteMessage({ ...base, sql: "DELETE FROM t WHERE ((", readOnly: false })).toContain("may still deny it")
  })
})
