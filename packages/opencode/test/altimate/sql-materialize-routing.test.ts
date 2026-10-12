import { afterEach, expect, spyOn, test } from "bun:test"
import * as Registry from "../../src/altimate/native/connections/registry"
import * as Precedence from "../../src/altimate/workspace/precedence"
import { closeScratch } from "../../src/altimate/native/connections/scratch"
import { SqlMaterializeTool, materialize } from "../../src/altimate/tools/sql-materialize"
import { initTool } from "./tool-fixture"

afterEach(async () => {
  await Registry.closeAll()
  await closeScratch()
  Registry.reset()
})

test("Postgres materialization requests database read-only execution for every source probe", async () => {
  Registry.setConfigs({ pg_source: { type: "postgres" } })
  const options: unknown[] = []
  const real = Registry.get.bind(Registry)
  const get = spyOn(Registry, "get").mockImplementation(async (name) =>
    name === "pg_source"
      ? ({
          supportsResultByteLimit: true,
          execute: async (_sql: string, _limit: unknown, _binds: unknown, opts: unknown) => {
            options.push(opts)
            return { rows: [[1]], columns: ["n"], row_count: 1, truncated: false }
          },
        } as any)
      : real(name),
  )
  try {
    await materialize({ source_warehouse: "pg_source", sql: "SELECT 1 AS n", target_table: "guarded" })
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
