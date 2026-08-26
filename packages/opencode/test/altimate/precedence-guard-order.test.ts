// altimate_change - new file
//
// Where the precedence guard sits inside a tool body is a correctness property, not a
// style choice: a redirect returns early, so anything it jumps over stops running.
// Two checks must survive it.
//
//  - `sql_execute`'s hard deny on DROP DATABASE / DROP SCHEMA / TRUNCATE says it
//    "cannot be overridden", and the engine's execution tools apply no such list. If a
//    redirect were returned first, a blocked statement would come back as an
//    instruction to call the engine tool — a way around the block.
//  - `sql_explain`'s pre-flight validators exist so malformed input gets an actionable
//    message. A redirect reads as success, so returning one first would send the model
//    to the engine tool carrying the same bad arguments.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { MessageID, SessionID } from "../../src/session/schema"
import { SqlExecuteTool } from "../../src/altimate/tools/sql-execute"
import { SqlExplainTool } from "../../src/altimate/tools/sql-explain"
import { initTool } from "./tool-fixture"
import * as Registry from "../../src/altimate/native/connections/registry"
import { precedenceInternals, refresh, resetForTests } from "../../src/altimate/workspace/precedence"

const SESSION = SessionID.make("ses_guard_order")
const ORIGINAL_PILOT = process.env.ALTIMATE_WORKSPACE

const ctx = {
  sessionID: SESSION,
  messageID: MessageID.make("msg_guard_order"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [] as any[],
  metadata: () => {},
  ask: async () => {},
}

/** A workspace serving snowflake for all three capabilities. */
const SNOWFLAKE_TOOLS = {
  datamate_snowflake_execute_database_query: {},
  datamate_snowflake_get_query_explain_plan: {},
  datamate_snowflake_get_table_stats: {},
}

beforeEach(async () => {
  resetForTests()
  process.env.ALTIMATE_WORKSPACE = "1"
  delete process.env.ALTIMATE_INTEGRATIONS
  precedenceInternals.binding = async () => ({ datamateId: 5, datamateName: "demo" })
  precedenceInternals.attributedTo = async () => "5"
  precedenceInternals.announce = async () => {}
  Registry.setConfigs({
    shadowed_snow: { type: "snowflake", account: "a", user: "u" } as never,
  })
  await refresh(SESSION, SNOWFLAKE_TOOLS)
})

afterEach(() => {
  resetForTests()
  Registry.reset()
  if (ORIGINAL_PILOT === undefined) delete process.env.ALTIMATE_WORKSPACE
  else process.env.ALTIMATE_WORKSPACE = ORIGINAL_PILOT
})

describe("sql_execute — the hard deny outranks the redirect", () => {
  test("a blocked statement on a shadowed connection still throws", async () => {
    const tool = await initTool(SqlExecuteTool)
    await expect(
      tool.execute({ query: "DROP DATABASE analytics", warehouse: "shadowed_snow", limit: 10 }, ctx),
    ).rejects.toThrow(/cannot be overridden/i)
  })

  test("every hard-denied form is still blocked, not redirected", async () => {
    const tool = await initTool(SqlExecuteTool)
    for (const query of ["DROP DATABASE x", "DROP SCHEMA public", "TRUNCATE TABLE orders"]) {
      await expect(tool.execute({ query, warehouse: "shadowed_snow", limit: 10 }, ctx)).rejects.toThrow(
        /blocked for safety/i,
      )
    }
  })

  test("an ordinary read on the same connection is still redirected", async () => {
    // Guards the fix from over-correcting: only the hard deny outranks precedence.
    const tool = await initTool(SqlExecuteTool)
    const result: any = await tool.execute({ query: "select 1", warehouse: "shadowed_snow", limit: 10 }, ctx)
    expect(result.metadata.redirected).toBe(true)
  })

  test("a write is redirected rather than prompted for approval", async () => {
    // Approving a write and then redirecting it asks the user to authorise something
    // that never runs, so precedence still comes before the permission ask.
    const tool = await initTool(SqlExecuteTool)
    const asked: any[] = []
    const result: any = await tool.execute(
      { query: "insert into t values (1)", warehouse: "shadowed_snow", limit: 10 },
      { ...ctx, ask: async (req: any) => void asked.push(req) },
    )
    expect(result.metadata.redirected).toBe(true)
    expect(asked).toHaveLength(0)
  })
})

describe("sql_explain — input validation outranks the redirect", () => {
  test("an empty statement reports invalid input rather than redirecting", async () => {
    const tool = await initTool(SqlExplainTool)
    const result: any = await tool.execute({ sql: "   ", warehouse: "shadowed_snow" }, ctx)
    expect(result.metadata.error_class).toBe("input_validation")
    expect(result.metadata.redirected).toBeUndefined()
  })

  test("a malformed warehouse name reports invalid input rather than redirecting", async () => {
    const tool = await initTool(SqlExplainTool)
    const result: any = await tool.execute({ sql: "select 1", warehouse: "   " }, ctx)
    expect(result.metadata.error_class).toBe("input_validation")
    expect(result.metadata.redirected).toBeUndefined()
  })

  test("valid input on a shadowed connection is still redirected", async () => {
    const tool = await initTool(SqlExplainTool)
    const result: any = await tool.execute({ sql: "select 1", warehouse: "shadowed_snow" }, ctx)
    expect(result.metadata.redirected).toBe(true)
  })
})
