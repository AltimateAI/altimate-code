import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import type { Tool } from "@/tool/tool"
import { SessionID, MessageID } from "@/session/schema"
import * as Dispatcher from "@/altimate/native/dispatcher"
import * as Registry from "@/altimate/native/connections/registry"
import * as Precedence from "@/altimate/workspace/precedence"
import { SqlExecuteTool } from "@/altimate/tools/sql-execute"
import { PostConnectSuggestions } from "@/altimate/tools/post-connect-suggestions"
import { initTool } from "../tool-fixture"

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_batch_refs"),
  messageID: MessageID.make("msg_batch_refs"),
  agent: "analyst",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const rows = (value: unknown, truncated = false) => ({
  columns: ["v"],
  rows: [[value]],
  row_count: 1,
  truncated,
})

let dispatch: ReturnType<typeof spyOn<typeof Dispatcher, "call">>
let config: ReturnType<typeof spyOn<typeof Registry, "getConfig">>
let list: ReturnType<typeof spyOn<typeof Registry, "list">>
let suggestion: ReturnType<typeof spyOn<typeof PostConnectSuggestions, "getProgressiveSuggestion">>
let precedence: ReturnType<typeof spyOn<typeof Precedence, "check">>

beforeEach(() => {
  dispatch = spyOn(Dispatcher, "call")
  config = spyOn(Registry, "getConfig").mockReturnValue({ type: "snowflake" })
  list = spyOn(Registry, "list").mockReturnValue({ warehouses: [{ name: "main", type: "snowflake" }] } as never)
  suggestion = spyOn(PostConnectSuggestions, "getProgressiveSuggestion").mockReturnValue(null)
  precedence = spyOn(Precedence, "check").mockResolvedValue({})
})

afterEach(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve))
  for (const spy of [dispatch, config, list, suggestion, precedence]) spy.mockRestore()
})

describe("sql_execute batch references", () => {
  test("a backslash in a bound value cannot end the literal on a backslash-escaping dialect", async () => {
    dispatch.mockResolvedValueOnce(rows("\\') OR 1=1 --") as never).mockResolvedValue(rows(1) as never)
    const tool = await initTool(SqlExecuteTool)
    await tool.execute(
      {
        queries: [
          { label: "src", query: "SELECT v FROM t" },
          { label: "use", query: "SELECT 1 WHERE x IN ({{src.v}})" },
        ],
      },
      ctx,
    )
    const sent = (dispatch.mock.calls[1]![1] as { sql: string }).sql
    expect(sent).toBe("SELECT 1 WHERE x IN ('\\\\'') OR 1=1 --')")
  })

  test("the registry default warehouse picks the literal syntax when none is named", async () => {
    config.mockImplementation(((name: string) => (name === "main" ? { type: "snowflake" } : undefined)) as never)
    dispatch.mockResolvedValueOnce(rows("a\\b") as never).mockResolvedValue(rows(1) as never)
    const tool = await initTool(SqlExecuteTool)
    await tool.execute(
      {
        queries: [
          { label: "src", query: "SELECT v FROM t" },
          { label: "use", query: "SELECT 1 WHERE x IN ({{src.v}})" },
        ],
      },
      ctx,
    )
    expect((dispatch.mock.calls[1]![1] as { sql: string }).sql).toBe("SELECT 1 WHERE x IN ('a\\\\b')")
  })

  test("duplicate labels are rejected", async () => {
    const tool = await initTool(SqlExecuteTool)
    await expect(
      tool.execute({ queries: [{ label: "a", query: "SELECT 1" }, { label: "a", query: "SELECT 2" }] }, ctx),
    ).rejects.toThrow("unique")
    expect(dispatch).not.toHaveBeenCalled()
  })

  test("the batch reports truncation when an item is row-limited", async () => {
    dispatch.mockResolvedValueOnce(rows(1, true) as never).mockResolvedValue(rows(2) as never)
    const tool = await initTool(SqlExecuteTool)
    const limited = await tool.execute({ queries: [{ query: "SELECT 1" }, { query: "SELECT 2" }] }, ctx)
    expect(limited.metadata.truncated).toBe(true)
    dispatch.mockReset().mockResolvedValue(rows(2) as never)
    const complete = await tool.execute({ queries: [{ query: "SELECT 1" }, { query: "SELECT 2" }] }, ctx)
    expect(complete.metadata.truncated).toBe(false)
  })
})
