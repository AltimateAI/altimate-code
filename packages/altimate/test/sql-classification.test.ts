import { expect, test } from "bun:test"
import { createFixture, createHost } from "./lib/host"

test("sql_execute applies the requested row limit and reports truncation", async () => {
  await using fixture = await createFixture()
  await using host = await createHost({ directory: fixture.path })
  const session = await host.createSession()
  const events = await host.run(session.id, [
    { tool: "warehouse_add", input: { name: "local", path: ":memory:" } },
    {
      tool: "sql_execute",
      id: "limited",
      input: { warehouse: "local", sql: "SELECT CAST(i AS INTEGER) AS value FROM range(5) AS t(i)", limit: 2 },
    },
  ])
  const result = events.find((event) => event.type === "session.tool.success" && event.data.id === "limited")
  if (!result || result.type !== "session.tool.success") throw new Error("Missing limited query success")
  expect(result.data).toMatchObject({
    metadata: { columns: ["value"], rows: [[0], [1]], row_count: 2, truncated: true },
  })
}, 30_000)

test("a read followed by a write is denied before executing the SQL batch", async () => {
  await using fixture = await createFixture()
  await using host = await createHost({
    directory: fixture.path,
    permissions: [{ action: "sql_execute_write", resource: "*", effect: "deny" }],
  })
  const session = await host.createSession()
  const events = await host.run(session.id, [
    { tool: "warehouse_add", input: { name: "local", path: ":memory:" } },
    {
      tool: "sql_execute",
      id: "mixed",
      input: { warehouse: "local", sql: "SELECT 1; CREATE TABLE forbidden (value INTEGER)" },
    },
    {
      tool: "sql_execute",
      id: "check",
      input: {
        warehouse: "local",
        sql: "SELECT table_name FROM information_schema.tables WHERE table_name = 'forbidden'",
      },
    },
  ])
  const failure = events.find((event) => event.type === "session.tool.failed" && event.data.id === "mixed")
  const result = events.find((event) => event.type === "session.tool.success" && event.data.id === "check")
  if (!failure || failure.type !== "session.tool.failed") throw new Error("Missing mixed SQL rejection")
  if (!result || result.type !== "session.tool.success") throw new Error("Missing table existence query success")
  expect(failure.data).toMatchObject({ error: { type: "permission.rejected" } })
  expect(result.data).toMatchObject({ metadata: { rows: [] } })
}, 30_000)

test.each([
  ["EXPLAIN ANALYZE", "EXPLAIN ANALYZE CREATE TABLE forbidden AS SELECT 1 AS value"],
  ["comment-looking string", "SELECT '--'; CREATE TABLE forbidden (value INTEGER)"],
])(
  "%s cannot bypass write permission",
  async (_label, sql) => {
    await using fixture = await createFixture()
    await using host = await createHost({
      directory: fixture.path,
      permissions: [{ action: "sql_execute_write", resource: "*", effect: "deny" }],
    })
    const session = await host.createSession()
    const events = await host.run(session.id, [
      { tool: "warehouse_add", input: { name: "local", path: ":memory:" } },
      { tool: "sql_execute", id: "write", input: { warehouse: "local", sql } },
      {
        tool: "sql_execute",
        id: "check",
        input: {
          warehouse: "local",
          sql: "SELECT table_name FROM information_schema.tables WHERE table_name = 'forbidden'",
        },
      },
    ])
    const failure = events.find((event) => event.type === "session.tool.failed" && event.data.id === "write")
    const result = events.find((event) => event.type === "session.tool.success" && event.data.id === "check")
    if (!failure || failure.type !== "session.tool.failed") throw new Error("Missing SQL write rejection")
    if (!result || result.type !== "session.tool.success") throw new Error("Missing table existence query success")
    expect(failure.data).toMatchObject({ error: { type: "permission.rejected" } })
    expect(result.data).toMatchObject({ metadata: { rows: [] } })
  },
  30_000,
)
