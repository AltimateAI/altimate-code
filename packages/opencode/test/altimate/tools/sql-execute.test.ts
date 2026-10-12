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
