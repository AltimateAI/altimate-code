// altimate_change start — PR 1441 routing and inspection regressions
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import type { ConnectionConfig, Connector } from "@altimateai/drivers"
import * as Registry from "../../../src/altimate/native/connections/registry"
import * as Dispatcher from "../../../src/altimate/native/dispatcher"
import { registerAll } from "../../../src/altimate/native/connections/register"
import * as Precedence from "../../../src/altimate/workspace/precedence"
import { SchemaInspectTool } from "../../../src/altimate/tools/schema-inspect"
import { SqlExecuteTool } from "../../../src/altimate/tools/sql-execute"
import { SqlCheckTool } from "../../../src/altimate/tools/sql-check"
import { bindTo, SNOWFLAKE_TOOLS } from "../workspace/precedence-fixture"
import { initTool } from "../tool-fixture"

const ctx = {
  sessionID: "ses_review_routing",
  messageID: "msg_review_routing",
  agent: "analyst",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => {},
  ask: async () => {},
}
const columns = [{ name: "id", data_type: "INTEGER", nullable: false }]
const originalDisabled = process.env.ALTIMATE_DISABLE_WORKSPACE
const originalIntegrations = process.env.ALTIMATE_INTEGRATIONS
const restores: Array<{ mockRestore(): void }> = []
function track<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(spy)
  return spy
}
beforeEach(() => {
  registerAll()
  Precedence.resetForTests()
  delete process.env.ALTIMATE_DISABLE_WORKSPACE
  delete process.env.ALTIMATE_INTEGRATIONS
})
afterEach(() => {
  restores
    .splice(0)
    .reverse()
    .forEach((spy) => spy.mockRestore())
  Registry.reset()
  Precedence.resetForTests()
  registerAll()
  if (originalDisabled === undefined) delete process.env.ALTIMATE_DISABLE_WORKSPACE
  else process.env.ALTIMATE_DISABLE_WORKSPACE = originalDisabled
  if (originalIntegrations === undefined) delete process.env.ALTIMATE_INTEGRATIONS
  else process.env.ALTIMATE_INTEGRATIONS = originalIntegrations
})

test.each([
  [{ type: "postgres", schema: "sales" }, "sales"],
  [{ type: "bigquery", dataset: "analytics" }, "analytics"],
  [{ type: "mysql", database: "inventory" }, "inventory"],
  [{ type: "mariadb", database: "inventory" }, "inventory"],
  [{ type: "snowflake", schema: "PUBLIC" }, "PUBLIC"],
] as [ConnectionConfig, string][])("unqualified inspection uses configured default: %j", async (config, schema) => {
  Registry.setConfigs({ remote: config })
  const describeTable = mock(async (_schema: string, _table: string) => columns)
  track(spyOn(Registry, "get").mockResolvedValue({ describeTable } as unknown as Connector))
  const response = await Dispatcher.call("schema.inspect", { table: "orders", warehouse: "remote" })
  expect(response.schema_name).toBe(schema)
  expect(describeTable.mock.calls).toEqual([[schema, "orders"]])
})

test("BigQuery not-found probes continue to the next dataset", async () => {
  Registry.setConfigs({ remote: { type: "bigquery", dataset: "analytics" } })
  const describeTable = mock(async (schema: string, _table: string) => {
    if (schema !== "sales") throw Object.assign(new Error(`Not found: Table project:${schema}.orders`), { code: 404 })
    return columns
  })
  track(
    spyOn(Registry, "get").mockResolvedValue({
      describeTable,
      listSchemas: async () => ["analytics", "empty", "sales"],
    } as unknown as Connector),
  )
  const response = await Dispatcher.call("schema.inspect", { table: "orders", warehouse: "remote" })
  expect(response.columns).toEqual(columns.map((c) => ({ ...c, primary_key: false })))
  expect(response.schema_name).toBe("sales")
  expect(describeTable.mock.calls).toEqual([
    ["analytics", "orders"],
    ["empty", "orders"],
    ["sales", "orders"],
  ])
})

test("inspection does not hide authorization errors while probing", async () => {
  Registry.setConfigs({ remote: { type: "bigquery", dataset: "analytics" } })
  const listSchemas = mock(async () => ["sales"])
  track(
    spyOn(Registry, "get").mockResolvedValue({
      describeTable: async () => {
        throw new Error("Access denied")
      },
      listSchemas,
    } as unknown as Connector),
  )
  const response = await Dispatcher.call("schema.inspect", { table: "orders", warehouse: "remote" })
  expect((response as any).error).toContain("Access denied")
  expect(listSchemas).not.toHaveBeenCalled()
})

test.each([
  { find: "orders", filter: { status: "open" } },
  { count: "orders", query: { status: "open" } },
  { distinct: "orders", key: "status" },
])("omitted Mongo warehouse uses read classification: %j", async (query) => {
  Registry.setConfigs({ mongo: { type: "mongodb" } })
  track(spyOn(Precedence, "check").mockResolvedValue({}))
  const dispatch = track(
    spyOn(Dispatcher, "call").mockResolvedValue({
      columns: ["count"],
      rows: [[1]],
      row_count: 1,
      truncated: false,
    } as never),
  )
  const ask = mock(async () => {
    throw new Error("write denied")
  })
  const tool = await initTool(SqlExecuteTool)
  await tool.execute({ query: JSON.stringify(query) }, { ...ctx, ask })
  expect(ask).not.toHaveBeenCalled()
  expect(JSON.parse((dispatch.mock.calls[0][1] as any).sql).collection).toBe("orders")
})

test.each([{ table: "remote.orders" }, { table: "orders", schema_name: "remote" }])(
  "warehouse alias is routed before target inspection: %j",
  async (address) => {
    Registry.setConfigs({ local: { type: "duckdb" }, remote: { type: "snowflake", schema: "PUBLIC" } })
    const describeTable = mock(async () => columns)
    const get = track(
      spyOn(Registry, "get").mockResolvedValue({
        describeTable,
        listSchemas: async () => ["main"],
      } as unknown as Connector),
    )
    const redirect = { title: "workspace", output: "use workspace", metadata: { redirected: true } }
    track(
      spyOn(Precedence, "check").mockImplementation(async (_session, _capability, warehouse) =>
        warehouse === "remote" ? { redirect } : {},
      ),
    )
    const tool = await initTool(SchemaInspectTool)
    const response = await tool.execute({ ...address, values: false }, ctx)
    expect(response.metadata.redirected).toBe(true)
    expect(describeTable).not.toHaveBeenCalled()
    expect(get.mock.calls).not.toContainEqual(["remote"])
  },
)

function profiling() {
  track(spyOn(Precedence, "check").mockResolvedValue({}))
  const execute = mock(async () => ({ columns: [], rows: [["id", 1, 1, 1, ["1"]]], row_count: 1, truncated: false }))
  Dispatcher.register("schema.inspect", async () => ({
    table: "orders",
    schema_name: "public",
    warehouse: "remote",
    columns,
  }))
  Dispatcher.register("warehouse.list", async () => ({ warehouses: [{ name: "remote", type: "postgres" }] }) as any)
  Dispatcher.register("sql.execute", execute as any)
  return execute
}

test("value profiling honors sql_execute permission denial", async () => {
  const execute = profiling()
  const ask = mock(async ({ permission }: { permission: string }) => {
    if (permission === "sql_execute") throw new Error("execute denied")
  })
  const tool = await initTool(SchemaInspectTool)
  const response = await tool.execute({ table: "orders", warehouse: "remote" }, { ...ctx, ask })
  expect(execute).not.toHaveBeenCalled()
  expect(ask.mock.calls.some(([request]) => request.permission === "sql_execute")).toBe(true)
  expect(response.output).toContain("execute denied")
})

test("value profiling honors execute-only workspace routing", async () => {
  const execute = profiling()
  track(
    spyOn(Precedence, "check").mockImplementation(async (_session, capability) =>
      capability === "sql_execute"
        ? { redirect: { title: "workspace", output: "use workspace execute", metadata: { redirected: true } } }
        : {},
    ),
  )
  const tool = await initTool(SchemaInspectTool)
  const response = await tool.execute({ table: "orders", warehouse: "remote" }, ctx)
  expect(execute).not.toHaveBeenCalled()
  expect(response.output).toContain("use workspace execute")
})

test("sql_check redirects before opening a shadowed source", async () => {
  const get = track(spyOn(Registry, "get").mockRejectedValue(new Error("must not connect")))
  track(
    spyOn(Precedence, "check").mockResolvedValue({
      redirect: { title: "workspace", output: "use workspace", metadata: { redirected: true } },
    }),
  )
  const tool = await initTool(SqlCheckTool)
  const response = await tool.execute(
    { warehouse: "remote", check: "nulls", sql: "SELECT 1 AS id", columns: ["id"] },
    ctx,
  )
  expect(response.metadata.redirected).toBe(true)
  expect(get).not.toHaveBeenCalled()
})

test.each(["sql", "left_sql", "right_sql"] as const)(
  "sql_check rejects writes in %s before workspace routing",
  async (field) => {
    const get = track(spyOn(Registry, "get").mockRejectedValue(new Error("must not connect")))
    const route = track(
      spyOn(Precedence, "check").mockResolvedValue({
        redirect: { title: "workspace", output: "use workspace", metadata: { redirected: true } },
      }),
    )
    const ask = mock(async () => {})
    const tool = await initTool(SqlCheckTool)
    const response = await tool.execute(
      { warehouse: "remote", check: "nulls", sql: "SELECT 1 AS id", columns: ["id"], [field]: "DELETE FROM orders" },
      { ...ctx, ask },
    )
    expect(response.metadata.redirected).toBeUndefined()
    expect(response.output).toContain("single read-only SELECT")
    expect(route).not.toHaveBeenCalled()
    expect(ask).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
  },
)

test.each(["fanout", "keys", "grain", "nulls", "coverage"] as const)(
  "sql_check %s honors sql_execute permission denial before routing or connecting",
  async (check) => {
    const route = track(spyOn(Precedence, "check").mockResolvedValue({}))
    const get = track(spyOn(Registry, "get").mockRejectedValue(new Error("must not connect")))
    const ask = mock(async ({ permission }: { permission: string }) => {
      if (permission === "sql_execute") throw new Error("execute denied")
    })
    const tool = await initTool(SqlCheckTool)
    const response = await tool.execute(
      {
        warehouse: "remote",
        check,
        sql: "SELECT id FROM orders",
        left_sql: "SELECT id FROM orders",
        right_sql: "SELECT id FROM customers",
        columns: ["id"],
        column: "id",
        pattern: "%",
        on: [["id", "id"]],
        left_col: "id",
        right_col: "id",
      },
      { ...ctx, ask },
    )
    expect(ask).toHaveBeenCalledTimes(1)
    expect(response.output).toContain("execute denied")
    expect(route).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
  },
)

test("sql_check authorizes all supplied SQL before routing and executing", async () => {
  Registry.setConfigs({ remote: { type: "postgres" } })
  const events: string[] = []
  track(
    spyOn(Precedence, "check").mockImplementation(async () => {
      events.push("route")
      return {}
    }),
  )
  track(
    spyOn(Registry, "get").mockImplementation(async () => {
      events.push("connect")
      return {
        connect: async () => {},
        close: async () => {},
        listSchemas: async () => [],
        listTables: async () => [],
        describeTable: async () => columns,
        execute: async () => {
          events.push("execute")
          return { columns: ["n", "null_0", "distinct_0"], rows: [[1, 0, 1]], row_count: 1, truncated: false }
        },
      }
    }),
  )
  const ask = mock(async (_request: unknown) => {
    events.push("authorize")
  })
  const tool = await initTool(SqlCheckTool)
  const response = await tool.execute(
    {
      warehouse: "remote",
      check: "nulls",
      sql: "SELECT id FROM orders",
      left_sql: "SELECT id FROM customers",
      right_sql: "",
      columns: ["id"],
    },
    { ...ctx, ask },
  )
  expect(response.metadata.error).toBeUndefined()
  expect(events).toEqual(["authorize", "route", "connect", "execute"])
  expect(ask.mock.calls).toEqual([
    [
      {
        permission: "sql_execute",
        patterns: ["SELECT id FROM orders", "SELECT id FROM customers"],
        always: ["*"],
        metadata: { warehouse: "remote" },
      },
    ],
  ])
})

test("built-in scratch stays local in a bound workspace", async () => {
  Registry.setConfigs({ local: { type: "duckdb" } })
  bindTo()
  Precedence.precedenceInternals.announce = async () => {}
  const state = await Precedence.refresh(ctx.sessionID, {
    ...SNOWFLAKE_TOOLS,
    datamate_duckdb_execute_database_query: {},
  })
  expect(state.enabled).toBe(true)
  expect(state.shadowed.has("duckdb")).toBe(false)
  expect(await Precedence.check(ctx.sessionID, "sql_execute", "scratch")).toEqual({})
})
// altimate_change end

// altimate_change start — route the resolved alias even when the default is shadowed
test("scratch alias remains local when the default warehouse is shadowed", async () => {
  Registry.setConfigs({ remote: { type: "snowflake", schema: "PUBLIC" } })
  const describeTable = mock(async () => columns)
  track(
    spyOn(Registry, "get").mockResolvedValue({
      describeTable,
      listSchemas: async () => ["PUBLIC"],
    } as unknown as Connector),
  )
  track(
    spyOn(Precedence, "check").mockImplementation(async (_session, _capability, warehouse) =>
      warehouse === "scratch"
        ? {}
        : { redirect: { title: "workspace", output: "use workspace", metadata: { redirected: true } } },
    ),
  )
  const tool = await initTool(SchemaInspectTool)
  const response = await tool.execute({ table: "scratch.orders", values: false }, ctx)
  expect(response.metadata.redirected).toBeUndefined()
  expect(response.metadata.success).toBe(true)
  expect(response.output).toContain('Resolved "scratch"')
})
// altimate_change end
