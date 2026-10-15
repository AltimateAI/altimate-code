import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import type { Tool } from "@/tool/tool"
import { SessionID, MessageID } from "@/session/schema"
import * as Dispatcher from "@/altimate/native/dispatcher"
import * as Registry from "@/altimate/native/connections/registry"
import { registerAll } from "@/altimate/native/connections/register"
import { closeScratch, getScratch } from "@/altimate/native/connections/scratch"
import * as Precedence from "@/altimate/workspace/precedence"
import * as ResultFormat from "@/altimate/tools/sql-result-format"
import { SqlExecuteTool } from "@/altimate/tools/sql-execute"
import { PostConnectSuggestions } from "@/altimate/tools/post-connect-suggestions"
import { initTool } from "../tool-fixture"

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_generated_reads"),
  messageID: MessageID.make("msg_generated_reads"),
  agent: "analyst",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}
const source = { warehouse: "catalog", sql: "SELECT generated_sql FROM saved_reads WHERE name = 'total'" }
const generated = "SELECT sum(amount) AS total FROM orders"
const result = { columns: ["total"], rows: [[42]], row_count: 1, truncated: false }
const generatedResult = (sql: unknown = generated) => ({
  columns: ["generated_sql"],
  rows: [[sql]],
  row_count: 1,
  truncated: false,
})

let dispatch: ReturnType<typeof spyOn<typeof Dispatcher, "call">>
let config: ReturnType<typeof spyOn<typeof Registry, "getConfig">>
let suggestion: ReturnType<typeof spyOn<typeof PostConnectSuggestions, "getProgressiveSuggestion">>
let precedence: ReturnType<typeof spyOn<typeof Precedence, "check">>
let ask: ReturnType<typeof spyOn<typeof ctx, "ask">>

beforeEach(() => {
  dispatch = spyOn(Dispatcher, "call").mockResolvedValueOnce(generatedResult() as never).mockResolvedValue(result as never)
  config = spyOn(Registry, "getConfig").mockReturnValue({ type: "duckdb" })
  suggestion = spyOn(PostConnectSuggestions, "getProgressiveSuggestion").mockReturnValue(null)
  precedence = spyOn(Precedence, "check").mockResolvedValue({})
  ask = spyOn(ctx, "ask")
})

afterEach(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve))
  dispatch.mockRestore()
  config.mockRestore()
  suggestion.mockRestore()
  precedence.mockRestore()
  ask.mockRestore()
})

describe("sql_execute generated reads", () => {
  test("executes the scalar generated read with independent source and target routing", async () => {
    const tool = await initTool(SqlExecuteTool)
    const output = await tool.execute({ query_from: source, warehouse: "analytics", limit: 7, query_timeout_ms: 2000 }, ctx)

    expect(output.metadata.error).toBeUndefined()
    expect(output.output).toBe("total\n-----\n42\n\n(1 rows)")
    expect(output.output).not.toContain(generated)
    expect(dispatch.mock.calls).toEqual([
      ["sql.execute", { sql: source.sql, warehouse: "catalog", limit: 2, query_timeout_ms: 2000 }],
      ["sql.execute", { sql: generated, warehouse: "analytics", limit: 7, query_timeout_ms: 2000 }],
    ])
    expect(precedence.mock.calls).toEqual([
      [ctx.sessionID, "sql_execute", "catalog"],
      [ctx.sessionID, "sql_execute", "analytics"],
    ])
    expect(ask.mock.calls.map(([request]) => request.permission)).toEqual(["sql_execute", "sql_execute"])
    expect(ask.mock.calls[0][0].patterns).toContain(source.sql)
    expect(ask.mock.calls[1][0].patterns).toContain(generated)
  })

  test("allows an empty query placeholder alongside query_from", async () => {
    const tool = await initTool(SqlExecuteTool)
    const output = await tool.execute({ query: "", query_from: source, warehouse: "analytics" }, ctx)
    expect(output.metadata.error).toBeUndefined()
    expect(dispatch).toHaveBeenLastCalledWith("sql.execute", {
      sql: generated,
      warehouse: "analytics",
      limit: 100,
      query_timeout_ms: undefined,
    })
  })

  for (const placeholder of [null, { warehouse: "", sql: "" }]) {
    test(`accepts a plain query with a ${JSON.stringify(placeholder)} query_from placeholder`, async () => {
      dispatch.mockReset().mockResolvedValue(result as never)
      const tool = await initTool(SqlExecuteTool)
      const output = await tool.execute({ query: generated, query_from: placeholder, warehouse: "analytics" }, ctx)
      expect(output.metadata.error).toBeUndefined()
      expect(dispatch.mock.calls).toEqual([
        ["sql.execute", { sql: generated, warehouse: "analytics", limit: 100, query_timeout_ms: undefined }],
      ])
    })
  }

  test("accepts a null query placeholder and titles the result without the generated SQL", async () => {
    const tool = await initTool(SqlExecuteTool)
    const output = await tool.execute({ query: null, query_from: source, warehouse: "analytics" }, ctx)
    expect(output.title).toBe("SQL: generated read")
    expect(output.title).not.toContain("sum(amount)")
  })

  test("carries the generated SQL in a target redirect", async () => {
    precedence.mockResolvedValueOnce({}).mockResolvedValueOnce({
      redirect: { title: "Routed", metadata: { redirected: true }, output: "Call `ws_sql` instead." },
    } as never)
    const tool = await initTool(SqlExecuteTool)
    const output = await tool.execute({ query_from: source, warehouse: "analytics" }, ctx)
    expect(output.output).toContain("Call `ws_sql` instead.")
    expect(output.output).toContain(generated)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  for (const fn of ["pg_try_advisory_lock(1)", "pg_advisory_unlock_all()", "pg_terminate_backend(1)", "pg_reload_conf()", "dblink('h', 'DELETE FROM t')", "pg_notify('c', 'x')", "pg_log_backend_memory_contexts(1)", "pg_stat_reset()", "pg_wal_replay_pause()", "pg_logical_slot_get_changes('s', NULL, NULL)", "get_lock('x', 1)", "SYSTEM$CANCEL_ALL_QUERIES(1)", 'U&"pg_notif\\0079"(\'c\', \'x\')', "lo_from_bytea(0, 'x')"]) {
    test(`rejects generated SQL calling ${fn}`, async () => {
      dispatch.mockReset().mockResolvedValueOnce(generatedResult(`SELECT ${fn}`) as never)
      const tool = await initTool(SqlExecuteTool)
      await expect(tool.execute({ query_from: source, warehouse: "analytics" }, ctx)).rejects.toThrow("read-only")
      expect(dispatch).toHaveBeenCalledTimes(1)
    })
  }

  test("refuses a target redirect whose generated SQL would be truncated", async () => {
    const big = `SELECT '${"x".repeat(41 * 1024)}' AS value`
    dispatch.mockReset().mockResolvedValueOnce(generatedResult(big) as never)
    precedence.mockResolvedValueOnce({}).mockResolvedValueOnce({
      redirect: { title: "Routed", metadata: {}, output: "Call `ws_sql` instead." },
    } as never)
    const tool = await initTool(SqlExecuteTool)
    await expect(tool.execute({ query_from: source, warehouse: "analytics" }, ctx)).rejects.toThrow("too large")
  })

  test("rejects a half-filled query_from", async () => {
    const tool = await initTool(SqlExecuteTool)
    await expect(
      tool.execute({ query_from: { warehouse: "catalog", sql: "" }, warehouse: "analytics" }, ctx),
    ).rejects.toThrow("non-empty warehouse and sql")
  })

  test("passes a complete large generated read directly without exposing its text", async () => {
    const sql = `SELECT '${"entry".repeat(6000)}' AS value`
    dispatch.mockReset().mockResolvedValueOnce(generatedResult(sql) as never).mockResolvedValue(result as never)
    const format = spyOn(ResultFormat, "formatSqlResult")
    try {
      const tool = await initTool(SqlExecuteTool)
      const output = await tool.execute({ query_from: source, warehouse: "analytics" }, ctx)
      expect(dispatch.mock.calls[1][1]).toMatchObject({ sql })
      expect(format).toHaveBeenCalledTimes(1)
      expect(format.mock.calls[0][0]).toBe(result)
      expect(output.output).toBe("total\n-----\n42\n\n(1 rows)")
      expect(output.metadata.result_path).toBeUndefined()
      expect(output.metadata.truncated).toBe(false)
    } finally {
      format.mockRestore()
    }
  })

  for (const type of ["postgres", "postgresql", "sqlite"]) {
    test(`preserves read-only execution on both ${type} reads`, async () => {
      config.mockReturnValue({ type })
      const tool = await initTool(SqlExecuteTool)
      await tool.execute({ query_from: source, warehouse: "analytics", query_timeout_ms: 0 }, ctx)
      expect(dispatch).toHaveBeenCalledTimes(2)
      for (const [, input] of dispatch.mock.calls) {
        expect(input).toMatchObject({ query_timeout_ms: 0 })
        expect((input as { read_only?: boolean }).read_only).toBe(type === "sqlite" ? undefined : true)
      }
    })
  }

  for (const postgres of ["catalog", "analytics"]) {
    test(`selects the read-only connection option independently for ${postgres}`, async () => {
      config.mockImplementation((warehouse) => ({ type: warehouse === postgres ? "postgres" : "duckdb" }))
      const tool = await initTool(SqlExecuteTool)
      await tool.execute({ query_from: source, warehouse: "analytics" }, ctx)
      expect(dispatch).toHaveBeenCalledTimes(2)
      for (const [, input] of dispatch.mock.calls) {
        const params = input as { warehouse: string; read_only?: boolean }
        expect(params.read_only).toBe(params.warehouse === postgres ? true : undefined)
      }
    })
  }

  const invalidArguments = [
    { warehouse: "analytics" },
    { query: "", warehouse: "analytics" },
    { query: "SELECT 1", query_from: source, warehouse: "analytics" },
    { query_from: source },
    { query_from: source, warehouse: "" },
    { query_from: { ...source, warehouse: "" }, warehouse: "analytics" },
    { query_from: { ...source, sql: "" }, warehouse: "analytics" },
  ]
  for (const [index, args] of invalidArguments.entries()) {
    test(`rejects incomplete or ambiguous generated read arguments ${index + 1}`, async () => {
      const tool = await initTool(SqlExecuteTool)
      await expect(tool.execute(args, ctx)).rejects.toThrow()
      expect(dispatch).not.toHaveBeenCalled()
      expect(precedence).not.toHaveBeenCalled()
    })
  }

  for (const sql of [
    "DELETE FROM orders",
    "CREATE TEMP TABLE generated AS SELECT 1",
    "SELECT 1; SELECT 2",
    "SHOW TABLES",
    "EXPLAIN SELECT 1",
    "WITH changed AS (DELETE FROM orders RETURNING *) SELECT * FROM changed",
  ]) {
    test(`rejects a non-query source before dispatch: ${sql}`, async () => {
      const tool = await initTool(SqlExecuteTool)
      await expect(tool.execute({ query_from: { ...source, sql }, warehouse: "analytics" }, ctx)).rejects.toThrow()
      expect(dispatch).not.toHaveBeenCalled()
      expect(ask).not.toHaveBeenCalled()
      expect(precedence).not.toHaveBeenCalled()
    })

    test(`rejects a non-query generated statement even in scratch: ${sql}`, async () => {
      dispatch.mockReset().mockResolvedValue(generatedResult(sql) as never)
      const tool = await initTool(SqlExecuteTool)
      await expect(tool.execute({ query_from: source, warehouse: "scratch" }, ctx)).rejects.toThrow()
      expect(dispatch).toHaveBeenCalledTimes(1)
      expect(ask.mock.calls.map(([request]) => request.permission)).toEqual(["sql_execute"])
      expect(precedence).toHaveBeenCalledTimes(1)
    })
  }

  const invalidResults = [
    { ...generatedResult(), rows: [], row_count: 0 },
    { ...generatedResult(), rows: [[generated], ["SELECT 2"]], row_count: 2 },
    { ...generatedResult(), columns: ["first", "second"], rows: [[generated, generated]] },
    { ...generatedResult(), rows: [[generated, generated]] },
    { ...generatedResult(), truncated: true },
    generatedResult(null),
    generatedResult(42),
    generatedResult(""),
    generatedResult("   "),
  ]
  for (const [index, value] of invalidResults.entries()) {
    test(`rejects a source that is not one complete SQL string ${index + 1}`, async () => {
      dispatch.mockReset().mockResolvedValue(value as never)
      const tool = await initTool(SqlExecuteTool)
      await expect(tool.execute({ query_from: source, warehouse: "analytics" }, ctx)).rejects.toThrow()
      expect(dispatch).toHaveBeenCalledTimes(1)
      expect(ask).toHaveBeenCalledTimes(1)
    })
  }

  test("rejects generated SQL over the UTF-8 byte limit before target execution", async () => {
    const sql = `SELECT '${"😀".repeat(262_144)}' AS value`
    expect(sql.length).toBeLessThan(1024 * 1024)
    dispatch.mockReset().mockResolvedValue(generatedResult(sql) as never)
    const tool = await initTool(SqlExecuteTool)
    await expect(tool.execute({ query_from: source, warehouse: "analytics" }, ctx)).rejects.toThrow(/limit|MiB|byte/i)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  test("surfaces a source connection error without executing a target", async () => {
    dispatch.mockReset().mockResolvedValue({ ...generatedResult(), error: "source unavailable" } as never)
    const tool = await initTool(SqlExecuteTool)
    await expect(tool.execute({ query_from: source, warehouse: "analytics" }, ctx)).rejects.toThrow("source unavailable")
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  for (const [failure, value, message] of [
    ["source result error", { ...generatedResult(), error: "source unavailable" }, "source unavailable"],
    ["source exception", new Error("connection closed"), "connection closed"],
    ["malformed scalar", generatedResult(null), "exactly one row"],
    ["generated write", generatedResult("DELETE FROM orders"), "read-only SELECT"],
  ] as const) {
    test(`retains the source routing notice after ${failure}`, async () => {
      const notice = "Source routing was unavailable; the read ran locally."
      precedence.mockResolvedValue({ notice, precedence: "undetermined" })
      dispatch.mockReset()
      if (value instanceof Error) dispatch.mockRejectedValue(value)
      else dispatch.mockResolvedValue(value as never)
      const tool = await initTool(SqlExecuteTool)
      const execution = tool.execute({ query_from: source, warehouse: "analytics" }, ctx)
      await expect(execution).rejects.toThrow(notice)
      await expect(execution).rejects.toThrow(message)
      expect(dispatch).toHaveBeenCalledTimes(1)
      expect(ask).toHaveBeenCalledTimes(1)
    })
  }

  test("source permission denial prevents source routing and execution", async () => {
    ask.mockImplementation(() => Effect.die(new Error("source denied")))
    const tool = await initTool(SqlExecuteTool)
    await expect(tool.execute({ query_from: source, warehouse: "analytics" }, ctx)).rejects.toThrow("source denied")
    expect(dispatch).not.toHaveBeenCalled()
    expect(precedence).not.toHaveBeenCalled()
  })

  test("generated query permission denial prevents target routing and execution", async () => {
    precedence.mockResolvedValue({ notice: "Source routing was unavailable.", precedence: "undetermined" })
    ask.mockImplementationOnce(() => Effect.void).mockImplementation(() => Effect.die(new Error("target denied")))
    const tool = await initTool(SqlExecuteTool)
    await expect(tool.execute({ query_from: source, warehouse: "analytics" }, ctx)).rejects.toMatchObject({ message: "target denied" })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(precedence).toHaveBeenCalledTimes(1)
  })

  for (const stage of ["source", "target"]) {
    test(`honors ${stage} workspace redirection before local execution`, async () => {
      const redirect = { title: "Use workspace", metadata: {}, output: "Route this read through the workspace." }
      precedence.mockReset()
      if (stage === "target") precedence.mockResolvedValueOnce({})
      precedence.mockResolvedValue({ redirect })
      const tool = await initTool(SqlExecuteTool)
      const out = await tool.execute({ query_from: source, warehouse: "analytics" }, ctx)
      if (stage === "source") expect(out).toMatchObject(redirect)
      else expect(out.output).toBe(`${redirect.output}\n\nSQL to run:\n${generated}`)
      expect(dispatch).toHaveBeenCalledTimes(stage === "source" ? 0 : 1)
    })
  }

  test("retains both routing notices without mutating a shared target verdict", async () => {
    const sourceVerdict = { notice: "Source routing was unavailable.", precedence: "undetermined" as const }
    const targetVerdict = { notice: "Target routing was unavailable.", precedence: "undetermined" as const }
    precedence.mockReset().mockResolvedValueOnce(sourceVerdict).mockResolvedValue(targetVerdict)
    const tool = await initTool(SqlExecuteTool)
    const output = await tool.execute({ query_from: source, warehouse: "analytics" }, ctx)
    expect(output.output).toContain(sourceVerdict.notice)
    expect(output.output).toContain(targetVerdict.notice)
    expect(output.metadata.precedence).toBe("undetermined")
    expect(targetVerdict).toEqual({ notice: "Target routing was unavailable.", precedence: "undetermined" })
  })

  test("aggregates over a thousand tables using one compact generated read request", async () => {
    dispatch.mockRestore()
    dispatch = spyOn(Dispatcher, "call")
    registerAll()
    try {
      const connection = await getScratch(ctx.sessionID)
      await connection.execute(
        Array.from({ length: 1024 }, (_, index) => `CREATE TABLE sample_${index} AS SELECT ${index}::INTEGER AS n`).join(";"),
        undefined,
        undefined,
        { noLimit: true },
      )
      const sql = `WITH numbered AS (
 SELECT '"' || replace(table_schema, '"', '""') || '"."' || replace(table_name, '"', '""') || '"' AS name,
        floor((row_number() OVER (ORDER BY table_schema, table_name) - 1) / 128) AS batch
 FROM information_schema.tables WHERE table_schema = 'main' AND table_name LIKE 'sample_%'
), batches AS (
 SELECT batch, 'SELECT * FROM query_table([' || string_agg(chr(39) || replace(name, chr(39), chr(39) || chr(39)) || chr(39), ',' ORDER BY name) || '], true)' AS part
 FROM numbered GROUP BY batch
)
SELECT 'SELECT count(*) AS tables_read, sum(n) AS total FROM (' || string_agg(part, ' UNION ALL BY NAME ' ORDER BY batch) || ')' AS sql FROM batches`
      const args = { query_from: { warehouse: "scratch", sql }, warehouse: "scratch" }
      expect(Buffer.byteLength(JSON.stringify(args), "utf8")).toBeLessThan(1000)
      const tool = await initTool(SqlExecuteTool)
      const output = await tool.execute(args, ctx)

      expect(output.metadata.error).toBeUndefined()
      expect(output.output).toContain("1024")
      expect(output.output).toContain("523776")
      expect(output.metadata.rowCount).toBe(1)
      expect(output.metadata.truncated).toBe(false)
      expect(output.metadata.result_path).toBeUndefined()
      const reads = dispatch.mock.calls.filter(([method]) => method === "sql.execute")
      expect(reads).toHaveLength(2)
      expect((reads[1][1] as { sql: string }).sql.length).toBeGreaterThan(20_000)
      expect(Buffer.byteLength(output.output, "utf8")).toBeLessThan(1000)
      expect(ask.mock.calls.map(([request]) => request.permission)).toEqual(["sql_execute", "sql_execute"])
    } finally {
      await closeScratch(ctx.sessionID)
    }
  }, 30_000)
})
