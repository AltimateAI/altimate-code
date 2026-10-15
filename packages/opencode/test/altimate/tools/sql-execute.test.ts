import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "node:path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import type { Tool } from "@/tool/tool"
import { TRUNCATION_DIR } from "@/tool/truncation-dir"
import { SessionID, MessageID } from "@/session/schema"
import * as Dispatcher from "@/altimate/native/dispatcher"
import * as Registry from "@/altimate/native/connections/registry"
import { registerAll } from "@/altimate/native/connections/register"
import type { Connector, ExecuteOptions } from "@altimateai/drivers/types"
import { SqlExecuteTool } from "@/altimate/tools/sql-execute"
import { PostConnectSuggestions } from "@/altimate/tools/post-connect-suggestions"
import * as Precedence from "@/altimate/workspace/precedence"
import { initTool } from "../tool-fixture"
import { testEffect } from "../../lib/effect"
import { TestConfig } from "../../fixture/config"

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_sql_contract"),
  messageID: MessageID.make("msg_sql_contract"),
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

let dispatch: ReturnType<typeof spyOn<typeof Dispatcher, "call">>
let suggestion: ReturnType<typeof spyOn<typeof PostConnectSuggestions, "getProgressiveSuggestion">>
let precedence: ReturnType<typeof spyOn<typeof Precedence, "check">>
beforeEach(() => {
  dispatch = spyOn(Dispatcher, "call").mockResolvedValue({
    columns: ["answer"],
    rows: [[42]],
    row_count: 1,
    truncated: false,
  } as never)
  suggestion = spyOn(PostConnectSuggestions, "getProgressiveSuggestion").mockReturnValue(null)
  precedence = spyOn(Precedence, "check").mockResolvedValue({})
})
afterEach(() => {
  dispatch.mockRestore()
  suggestion.mockRestore()
  precedence.mockRestore()
})

describe("sql_execute parser read boundary", () => {
  test("explains a refused write approval for parser failures", async () => {
    const tool = await initTool(SqlExecuteTool)
    const ask = spyOn(ctx, "ask").mockImplementation(() => Effect.die(new Error("write denied by test")))
    try {
      await expect(tool.execute({ query: "SELECT (" }, ctx)).rejects.toThrowErrorMatchingInlineSnapshot(
        `"Could not prove this SQL is read-only: Parse error at line 1, column 9: Unexpected token: LParen. Rewrite or split the statement."`,
      )
      expect(ask).toHaveBeenCalledTimes(1)
      expect(dispatch).not.toHaveBeenCalled()
      expect(precedence).not.toHaveBeenCalled()
    } finally {
      ask.mockRestore()
    }
  })

  test.each([
    ["duckdb", "SELECT 9 // 2"],
    ["sqlite", "SELECT 'article' NOT GLOB 'a*'"],
    ["duckdb", "SELECT TIMESTAMPTZ '2024-02-03 00:00:00+00'"],
    ["duckdb", "SELECT * FROM items match"],
  ])("explains unsupported %s read syntax: %s", async (type, query) => {
    const config = spyOn(Registry, "getConfig").mockReturnValue({ type })
    const tool = await initTool(SqlExecuteTool)
    const ask = spyOn(ctx, "ask").mockImplementation(() => Effect.die(new Error("write denied by test")))
    try {
      await expect(tool.execute({ query, warehouse: "source" }, ctx)).rejects.toThrow(/read-only: Parse error.*Rewrite or split/)
      expect(ask).toHaveBeenCalledTimes(1)
      expect(dispatch).not.toHaveBeenCalled()
    } finally {
      ask.mockRestore()
      config.mockRestore()
    }
  })

  test("executes parser-rejected SQL only after write approval", async () => {
    const tool = await initTool(SqlExecuteTool)
    const ask = spyOn(ctx, "ask").mockImplementation(() => Effect.void)
    try {
      await tool.execute({ query: "SELECT (" }, ctx)
      expect(ask).toHaveBeenCalledTimes(1)
      expect(dispatch).toHaveBeenCalledTimes(1)
    } finally {
      ask.mockRestore()
    }
  })

  test.each([
    "SELECT 'unclosed",
    "/* unclosed",
    "EXPLAIN ANALYZE DELETE FROM victim",
    "SELECT $tag$'--$tag$ AS a; DELETE FROM victim",
    String.raw`SELECT E'\'--' AS a) x) y; DELETE FROM victim; SELECT * FROM (SELECT * FROM (SELECT ''`,
  ])("requires write approval and explains the refusal for parser-rejected statements: %s", async (query) => {
    const tool = await initTool(SqlExecuteTool)
    const ask = spyOn(ctx, "ask").mockImplementation(() => Effect.die(new Error("write denied by test")))
    try {
      await expect(tool.execute({ query }, ctx)).rejects.toThrow(/Could not prove this SQL is read-only/)
      expect(ask).toHaveBeenCalledTimes(1)
      expect(dispatch).not.toHaveBeenCalled()
      expect(precedence).not.toHaveBeenCalled()
    } finally {
      ask.mockRestore()
    }
  })

  for (const type of ["postgres", "postgresql", "sqlite"]) {
    test(`enforces read-only execution for ${type} reads without restricting approved writes`, async () => {
      dispatch.mockRestore()
      registerAll()
      const calls: { sql: string; options?: ExecuteOptions }[] = []
      const connector: Connector = {
        connect: async () => {},
        execute: async (sql, _limit, _binds, options) => {
          calls.push({ sql, options })
          return { columns: ["answer"], rows: [[42]], row_count: 1, truncated: false }
        },
        listSchemas: async () => [],
        listTables: async () => [],
        describeTable: async () => [],
        close: async () => {},
      }
      const config = spyOn(Registry, "getConfig").mockReturnValue({ type })
      const get = spyOn(Registry, "get").mockResolvedValue(connector)
      const ask = spyOn(ctx, "ask")
      try {
        const tool = await initTool(SqlExecuteTool)
        const result = await tool.execute({ query: "SELECT * FROM writing_view", warehouse: "source" }, ctx)
        expect(result.metadata.error).toBeUndefined()
        expect(calls).toHaveLength(1)
        expect(calls[0].options?.readOnly).toBe(type === "sqlite" ? undefined : true)
        expect(ask).not.toHaveBeenCalled()

        await tool.execute({ query: "INSERT INTO target VALUES (42)", warehouse: "source" }, ctx)
        expect(calls).toHaveLength(2)
        expect(calls[1].options?.readOnly).toBeUndefined()
        expect(ask).toHaveBeenCalledTimes(1)
      } finally {
        await new Promise<void>((resolve) => setImmediate(resolve))
        ask.mockRestore()
        get.mockRestore()
        config.mockRestore()
      }
    })
  }

  for (const dialect of ["mysql", undefined]) {
    test(`refuses dollar-delimited writes under read-only permission for ${dialect ?? "unknown"} dialect`, async () => {
      const config = spyOn(Registry, "getConfig").mockReturnValue(dialect ? { type: dialect } : undefined)
      const tool = await initTool(SqlExecuteTool)
      const ask = spyOn(ctx, "ask").mockImplementation(() => Effect.die(new Error("write denied by read-only analyst")))
      try {
        for (const query of ["SELECT 1; DELETE FROM t", "SELECT $x$; DELETE FROM t; $x$"]) {
          ask.mockClear()
          await expect(tool.execute({ query, warehouse: "source" }, { ...ctx, agent: "analyst" })).rejects.toThrow(
            /write denied by read-only analyst/,
          )
          expect(ask).toHaveBeenCalledTimes(1)
          expect(ask).toHaveBeenCalledWith({
            permission: "sql_execute_write",
            patterns: [query],
            always: ["*"],
            metadata: { queryType: "write" },
          })
          expect(dispatch).not.toHaveBeenCalled()
          expect(precedence).not.toHaveBeenCalled()
        }
      } finally {
        ask.mockRestore()
        config.mockRestore()
      }
    })
  }

  for (const [dialect, query] of [
    ["postgres", "SELECT $x$ a; b $x$"],
    ["postgres", "SELECT $$ ; DROP TABLE t $$"],
    ["postgresql", "SELECT $$ ; DROP TABLE t $$"],
    ["duckdb", "SELECT $x$ a; b $x$"],
    ["duckdb", "SELECT $$ ; DROP TABLE t $$"],
    ["snowflake", "SELECT $$ ; DROP TABLE t $$"],
  ]) {
    test(`accepts ${dialect} dollar-quoted single reads: ${query}`, async () => {
      const config = spyOn(Registry, "getConfig").mockReturnValue({ type: dialect })
      const tool = await initTool(SqlExecuteTool)
      const ask = spyOn(ctx, "ask")
      try {
        const result = await tool.execute({ query, warehouse: "source" }, ctx)
        expect(result.metadata.error).toBeUndefined()
        expect(ask).not.toHaveBeenCalled()
        expect(dispatch).toHaveBeenCalledTimes(1)
      } finally {
        ask.mockRestore()
        config.mockRestore()
      }
    })
  }

  test("VALUES and quoted write keywords remain ordinary reads", async () => {
    const tool = await initTool(SqlExecuteTool)
    const ask = spyOn(ctx, "ask")
    try {
      await tool.execute({ query: "VALUES (1)" }, ctx)
      await tool.execute({ query: 'SELECT \'DELETE INTO\' AS "UPDATE"' }, ctx)
      expect(ask).not.toHaveBeenCalled()
      expect(dispatch).toHaveBeenCalledTimes(2)
    } finally {
      ask.mockRestore()
    }
  })

  for (const query of [
    "WITH removed AS (DELETE FROM victim RETURNING *) SELECT * FROM removed",
    "SELECT 1 INTO victim",
    String.raw`SELECT E'\'--' AS a; DELETE FROM victim`,
    "SELECT $$--$$ AS a; DELETE FROM victim",
    "SELECT 1; CHECKPOINT",
  ]) {
    test(`requires write permission for query-shaped writes: ${query}`, async () => {
      const tool = await initTool(SqlExecuteTool)
      const ask = spyOn(ctx, "ask").mockImplementation(() => Effect.die(new Error("write denied by test")))
      try {
        await expect(tool.execute({ query }, ctx)).rejects.toThrow(/write denied by test/)
        expect(ask).toHaveBeenCalledTimes(1)
        expect(dispatch).not.toHaveBeenCalled()
        expect(precedence).not.toHaveBeenCalled()
      } finally {
        ask.mockRestore()
      }
    })
  }

  for (const query of [
    "SHOW TABLES",
    "DESCRIBE orders",
    "EXPLAIN SELECT 1",
    "EXPLAIN ANALYZE SELECT 1",
    "PRAGMA table_info(orders)",
    "PRAGMA storage_info('orders')",
    "PRAGMA integrity_check(orders)",
    "SELECT ';--/*' AS a",
  ]) {
    test(`accepts parser-verified reads without write permission: ${query}`, async () => {
      const tool = await initTool(SqlExecuteTool)
      const ask = spyOn(ctx, "ask")
      try {
        const result = await tool.execute({ query }, ctx)
        expect(result.metadata.error).toBeUndefined()
        expect(ask).not.toHaveBeenCalled()
        expect(dispatch).toHaveBeenCalledTimes(1)
      } finally {
        ask.mockRestore()
      }
    })
  }

  test("refuses multiple reads with a clear driver support message", async () => {
    const tool = await initTool(SqlExecuteTool)
    await expect(tool.execute({ query: "SELECT 1; SELECT 2" }, ctx)).rejects.toThrow(/multi-statement reads.*not supported/i)
    expect(dispatch).not.toHaveBeenCalled()
    expect(precedence).not.toHaveBeenCalled()
  })
})

describe("sql_execute MongoDB commands", () => {
  test.each([
    "SELECT 1",
    "{not json",
    "[]",
    "{}",
    '{"collection":"articles","find":3}',
    '{"command":"fin","collection":"articles"}',
  ])(
    "reports a MongoDB shape error before permissions: %s",
    async (query) => {
      const config = spyOn(Registry, "getConfig").mockReturnValue({ type: "mongodb" })
      const ask = spyOn(ctx, "ask").mockImplementation(() => Effect.die(new Error("write denied by test")))
      try {
        const tool = await initTool(SqlExecuteTool)
        await expect(tool.execute({ query, warehouse: "source" }, ctx)).rejects.toThrow(/MongoDB.*JSON command/)
        expect(ask).not.toHaveBeenCalled()
        expect(dispatch).not.toHaveBeenCalled()
        expect(precedence).not.toHaveBeenCalled()
      } finally {
        ask.mockRestore()
        config.mockRestore()
      }
    },
  )

  test.each([
    [
      { collection: "articles", find: { published: true } },
      { command: "find", collection: "articles", filter: { published: true } },
    ],
    [
      { collection: "articles", aggregate: [{ $match: { published: true } }] },
      { command: "aggregate", collection: "articles", pipeline: [{ $match: { published: true } }] },
    ],
    [{ listCollections: 1 }, { command: "listCollections" }],
    [{ estimatedDocumentCount: "articles" }, { command: "estimatedDocumentCount", collection: "articles" }],
  ])("dispatches MongoDB reads in normalized form: %j", async (query, normalized) => {
    const config = spyOn(Registry, "getConfig").mockReturnValue({ type: "mongodb" })
    const ask = spyOn(ctx, "ask").mockImplementation(() => Effect.die(new Error("write denied by test")))
    try {
      const tool = await initTool(SqlExecuteTool)
      await tool.execute({ query: JSON.stringify(query), warehouse: "source" }, ctx)
      expect(ask).not.toHaveBeenCalled()
      expect(dispatch).toHaveBeenCalledTimes(1)
      expect(dispatch.mock.calls[0][0]).toBe("sql.execute")
      expect(JSON.parse((dispatch.mock.calls[0][1] as { sql: string }).sql)).toEqual(normalized)
    } finally {
      ask.mockRestore()
      config.mockRestore()
    }
  })
})

describe("sql_execute limit validation", () => {
  for (const limit of [0, -1, 1.5, 1e9, NaN, Infinity, -Infinity]) {
    test(`rejects ${limit} before querying`, async () => {
      const tool = await initTool(SqlExecuteTool)
      await expect(tool.execute({ query: "SELECT 42", limit }, ctx)).rejects.toThrow(
        "limit must be a finite positive integer between 1 and 10000",
      )
      expect(dispatch).not.toHaveBeenCalled()
    })
  }

  test("keeps default 100 and accepts both bounds without extra queries", async () => {
    const tool = await initTool(SqlExecuteTool)
    for (const limit of [undefined, 1, 10_000]) {
      const output = await tool.execute({ query: "SELECT 42", limit }, ctx)
      expect(output.output).toBe("answer\n------\n42\n\n(1 rows)")
    }
    expect(dispatch.mock.calls).toEqual([
      ["sql.execute", { sql: "SELECT 42", warehouse: undefined, limit: 100 }],
      ["sql.execute", { sql: "SELECT 42", warehouse: undefined, limit: 1 }],
      ["sql.execute", { sql: "SELECT 42", warehouse: undefined, limit: 10_000 }],
    ])
  })
})

describe("sql_execute query timeout", () => {
  for (const query_timeout_ms of [-1, 0.5, 3_600_001, NaN, Infinity, -Infinity]) {
    test(`rejects ${query_timeout_ms} before querying`, async () => {
      const tool = await initTool(SqlExecuteTool)
      await expect(tool.execute({ query: "SELECT 42", query_timeout_ms }, ctx)).rejects.toThrow()
      expect(dispatch).not.toHaveBeenCalled()
    })
  }

  test("passes explicit deadlines and disabled deadline to the native dispatcher", async () => {
    const tool = await initTool(SqlExecuteTool)
    for (const query_timeout_ms of [0, 1, 600_000, 3_600_000]) {
      await tool.execute({ query: "SELECT 42", warehouse: "analytics", query_timeout_ms }, ctx)
      expect(dispatch).toHaveBeenLastCalledWith("sql.execute", {
        sql: "SELECT 42",
        warehouse: "analytics",
        limit: 100,
        query_timeout_ms,
      })
    }
    expect(dispatch).toHaveBeenCalledTimes(4)
  })

  test("leaves an omitted deadline undefined so native defaults still apply", async () => {
    const tool = await initTool(SqlExecuteTool)
    await tool.execute({ query: "SELECT 42" }, ctx)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith("sql.execute", {
      sql: "SELECT 42",
      warehouse: undefined,
      limit: 100,
      query_timeout_ms: undefined,
    })
  })
})

const agents = Layer.mock(Agent.Service, {})
const it = testEffect(
  Layer.mergeAll(
    Truncate.defaultLayer,
    FSUtil.defaultLayer,
    agents,
    TestConfig.layer({ get: () => Effect.succeed({ tool_output: { max_bytes: 1024, max_lines: 2000 } }) }),
  ),
)

it.live("sql_execute uses configured limits and the real retained tool-output spill service", () =>
  Effect.gen(function* () {
    suggestion.mockReturnValue("Tip: Inspect the saved result as needed.")
    precedence.mockResolvedValue({ notice: "Routing was unavailable; ran locally.", precedence: "undetermined" })
    const cell = "😀\n".repeat(20_000)
    const rows = [[cell], ["last fetched row"]]
    dispatch.mockResolvedValue({ columns: ["value"], rows, row_count: 2, truncated: false } as never)
    const tool = yield* SqlExecuteTool
    const initialized = yield* tool.init()
    const output = yield* initialized.execute({ query: "SELECT value FROM entries", limit: 100 }, ctx)

    expect(output.output).toStartWith("Preview: 1 of 2 returned rows shown.")
    expect(output.output).toContain("…[cell clipped,")
    expect(output.output).toContain("Routing was unavailable; ran locally.")
    expect(output.output).toContain("Tip: Inspect the saved result as needed.")
    expect(Buffer.byteLength(output.output, "utf8")).toBeLessThanOrEqual(1024)
    expect(output.metadata).toMatchObject({
      rowCount: 2,
      rows_returned: 2,
      preview_rows: 1,
      row_limited: false,
      output_truncated: true,
      truncated: true,
    })
    const resultPath = output.metadata.result_path as string
    expect(path.isAbsolute(resultPath)).toBe(true)
    expect(path.dirname(resultPath)).toBe(TRUNCATION_DIR)
    expect(path.basename(resultPath)).toStartWith("tool_")
    expect(output.output).toContain(`All 2 returned rows saved to ${resultPath}`)
    const fs = yield* FSUtil.Service
    const saved = yield* fs.readFileString(resultPath)
    expect(
      saved
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(rows.map((values) => ({ columns: ["value"], values })))
    expect(dispatch).toHaveBeenCalledTimes(1)
    yield* fs.remove(resultPath)
  }),
)

const failedSpill = testEffect(
  Layer.mergeAll(
    agents,
    Layer.mock(Truncate.Service, {
      limits: () => Effect.succeed({ maxBytes: 1024, maxLines: 2000 }),
      write: () => Effect.die(new Error("disk full")),
    }),
  ),
)

failedSpill.live("a spill service defect keeps SQL success, preview and clipping metadata", () =>
  Effect.gen(function* () {
    dispatch.mockResolvedValue({
      columns: ["value"],
      rows: [["x".repeat(20_000)]],
      row_count: 1,
      truncated: false,
    } as never)
    const tool = yield* SqlExecuteTool
    const initialized = yield* tool.init()
    const output = yield* initialized.execute({ query: "SELECT value FROM entries" }, ctx)

    expect(output.output).toStartWith("Preview: 1 of 1 returned rows shown.")
    expect(output.output).toContain("Spill failed")
    expect(output.output).toContain("…[cell clipped,")
    expect(output.metadata.error).toBeUndefined()
    expect(output.metadata.result_path).toBeUndefined()
    expect(output.metadata.output_truncated).toBe(true)
  }),
)
