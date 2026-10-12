import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { PermissionNext } from "../../src/permission/next"
import * as Registry from "../../src/altimate/native/connections/registry"
import * as Precedence from "../../src/altimate/workspace/precedence"
import { closeScratch } from "../../src/altimate/native/connections/scratch"
import { SqlMaterializeTool } from "../../src/altimate/tools/sql-materialize"
import { initTool } from "./tool-fixture"

afterEach(async () => {
  await Registry.closeAll()
  await closeScratch()
  Registry.reset()
})

test.each([
  ["pg_source", "SELECT id FROM private_orders WHERE amount > 100"],
  ["scratch", "SELECT id FROM private_orders WHERE amount > 100"],
  ["mongo_source", '{"command":"find","collection":"private_orders","filter":{"amount":{"$gt":100}}}'],
])("materialize enforces denied SQL-read permission before opening %s", async (source_warehouse, sql) => {
  Registry.setConfigs({ pg_source: { type: "postgres" }, mongo_source: { type: "mongodb" } })
  const ruleset = PermissionNext.fromConfig({ sql_materialize: "allow", sql_execute: "deny" })
  const ask = mock(async (request: { permission: string; patterns: string[] }) => {
    for (const pattern of request.patterns) {
      if (PermissionNext.evaluate(request.permission, pattern, ruleset).action === "deny") {
        throw new PermissionNext.DeniedError(ruleset)
      }
    }
  })
  const get = spyOn(Registry, "get").mockRejectedValue(new Error("source must not be opened"))
  try {
    const tool = await initTool(SqlMaterializeTool)
    await expect(
      tool.execute(
        { source_warehouse, sql, target_table: "forbidden" },
        {
          sessionID: "ses_permission",
          messageID: "msg_permission",
          agent: "analyst",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask,
        },
      ),
    ).rejects.toThrow(/rule which prevents/)
    expect(ask).toHaveBeenCalledWith({
      permission: "sql_execute",
      patterns: [sql],
      always: ["*"],
      metadata: { warehouse: source_warehouse },
    })
    expect(get).not.toHaveBeenCalled()
  } finally {
    get.mockRestore()
  }
})

test("authorized Postgres materialization requests database read-only execution for every source probe", async () => {
  Registry.setConfigs({ pg_source: { type: "postgres" } })
  const options: unknown[] = []
  const ask = mock(async () => {})
  const real = Registry.get.bind(Registry)
  const get = spyOn(Registry, "get").mockImplementation(async (name) =>
    name === "pg_source"
      ? ({
          supportsResultByteLimit: true,
          execute: async (_sql: string, _limit: unknown, _binds: unknown, opts: unknown) => {
            expect(ask).toHaveBeenCalledWith({
              permission: "sql_execute",
              patterns: ["SELECT 1 AS n"],
              always: ["*"],
              metadata: { warehouse: "pg_source" },
            })
            options.push(opts)
            return { rows: [[1]], columns: ["n"], row_count: 1, truncated: false }
          },
        } as any)
      : real(name),
  )
  try {
    const tool = await initTool(SqlMaterializeTool)
    const result = await tool.execute(
      { source_warehouse: "pg_source", sql: "SELECT 1 AS n", target_table: "guarded" },
      {
        sessionID: "ses_permission",
        messageID: "msg_permission",
        agent: "analyst",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => {},
        ask,
      },
    )
    expect(result.metadata.materialized).toBe(true)
    expect(result.metadata.rowCount).toBe(1)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(options).toHaveLength(3)
    for (const opts of options) expect(opts).toMatchObject({ readOnly: true })
  } finally {
    get.mockRestore()
  }
})

test("materialize redirects a workspace-shadowed source before opening a local connector", async () => {
  const redirect = {
    title: "workspace redirect",
    metadata: { precedence: "redirect" },
    output: "Use workspace_execute",
  }
  const check = spyOn(Precedence, "check").mockResolvedValue({ redirect } as any)
  const get = spyOn(Registry, "get")
  try {
    const tool = await initTool(SqlMaterializeTool)
    const result = await tool.execute({ source_warehouse: "pg_source", sql: "SELECT 1", target_table: "ignored" }, {
      sessionID: "ses_routing",
      messageID: "msg_routing",
      agent: "analyst",
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => {},
      ask: async () => {},
    } as any)
    expect(result).toMatchObject(redirect)
    expect(check).toHaveBeenCalledWith("ses_routing", "sql_execute", "pg_source")
    expect(get).not.toHaveBeenCalled()
  } finally {
    check.mockRestore()
    get.mockRestore()
  }
})
