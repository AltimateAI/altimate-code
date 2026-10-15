import { expect, test } from "bun:test"
import { connect } from "@altimateai/drivers/duckdb"
import { join } from "node:path"
import { createFixture, createHost } from "./lib/host"

type Host = Awaited<ReturnType<typeof createHost>>
type Log = Awaited<ReturnType<Host["run"]>>

const warehouse = { tool: "warehouse_add", id: "add", input: { name: "local", path: ":memory:" } }
const write = {
  tool: "sql_execute",
  id: "write",
  input: { warehouse: "local", sql: "CREATE TABLE approval_probe AS SELECT 7 AS value" },
}
const existence = {
  tool: "sql_execute",
  id: "exists",
  input: {
    warehouse: "local",
    sql: "SELECT table_name FROM information_schema.tables WHERE table_name = 'approval_probe'",
  },
}

test("a. sql_execute SELECT returns structured rows and a text table", async () => {
  await using fixture = await createFixture()
  await using host = await createHost({ directory: fixture.path })
  const session = await host.createSession()
  const events = await host.run(session.id, [
    warehouse,
    { tool: "sql_execute", id: "select", input: { warehouse: "local", sql: "SELECT 42 AS answer, 'duck' AS label" } },
  ])
  const result = success(events, "select")
  expect(result.metadata).toMatchObject({ warehouse: "local", columns: ["answer", "label"], rows: [[42, "duck"]] })
  expect(result.content).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining("42") })]),
  )
  expect(host.model.calls).toHaveLength(3)
  expect(host.model.remaining).toBe(0)
}, 30_000)

test("b1. configured deny prevents write execution", async () => {
  await using fixture = await createFixture()
  await using host = await createHost({
    directory: fixture.path,
    permissions: [{ action: "sql_execute_write", resource: "*", effect: "deny" }],
  })
  const session = await host.createSession()
  const events = await host.run(session.id, [warehouse, write, existence])
  expect(failure(events, "write").error).toMatchObject({ type: "permission.rejected" })
  expect(success(events, "exists").metadata).toMatchObject({ rows: [] })
  expect(await host.opencode.permission.list({ sessionID: session.id })).toEqual([])
}, 30_000)

test("b2. plain reject ends the step and prevents write execution", async () => {
  await using fixture = await createFixture()
  await using host = await createHost({
    directory: fixture.path,
    permissions: [{ action: "sql_execute_write", resource: "*", effect: "ask" }],
  })
  const session = await host.createSession()
  await host.run(session.id, [warehouse])
  const calls = host.model.calls.length
  await host.start(session.id, [write])
  const permission = await pending(host, session.id)
  expect(permission).toMatchObject({ action: "sql_execute_write", resources: [write.input.sql] })
  await host.opencode.permission.reply({ sessionID: session.id, requestID: permission.id, decision: "reject" })
  await host.opencode.sessions.wait({ sessionID: session.id })
  const events = await Array.fromAsync(host.opencode.sessions.log({ sessionID: session.id }))
  expect(failure(events, "write").error).toMatchObject({ type: "aborted" })
  expect(host.model.calls.length - calls).toBe(1)
  expect(host.model.remaining).toBe(1)
  expect(success(await host.run(session.id, [existence]), "exists").metadata).toMatchObject({ rows: [] })
}, 30_000)

test("b3. reject with feedback returns a tool failure and prevents write execution", async () => {
  await using fixture = await createFixture()
  await using host = await createHost({
    directory: fixture.path,
    permissions: [{ action: "sql_execute_write", resource: "*", effect: "ask" }],
  })
  const session = await host.createSession()
  await host.run(session.id, [warehouse])
  const calls = host.model.calls.length
  await host.start(session.id, [write, existence])
  const permission = await pending(host, session.id)
  await host.opencode.permission.reply({
    sessionID: session.id,
    requestID: permission.id,
    decision: "reject",
    message: "Use a read-only query instead.",
  })
  await host.opencode.sessions.wait({ sessionID: session.id })
  const events = await Array.fromAsync(host.opencode.sessions.log({ sessionID: session.id }))
  expect(failure(events, "write").error).toEqual({
    type: "permission.rejected",
    message: "Use a read-only query instead.",
  })
  expect(success(events, "exists").metadata).toMatchObject({ rows: [] })
  expect(host.model.calls.length - calls).toBe(3)
  expect(host.model.remaining).toBe(0)
}, 30_000)

test("b4. once approval executes the write and the table can be read", async () => {
  await using fixture = await createFixture()
  await using host = await createHost({
    directory: fixture.path,
    permissions: [{ action: "sql_execute_write", resource: "*", effect: "ask" }],
  })
  const session = await host.createSession()
  await host.start(session.id, [
    warehouse,
    write,
    { tool: "sql_execute", id: "read", input: { warehouse: "local", sql: "SELECT value FROM approval_probe" } },
  ])
  const permission = await pending(host, session.id)
  await host.opencode.permission.reply({ sessionID: session.id, requestID: permission.id, decision: "once" })
  await host.opencode.sessions.wait({ sessionID: session.id })
  const events = await Array.fromAsync(host.opencode.sessions.log({ sessionID: session.id }))
  success(events, "write")
  expect(success(events, "read").metadata).toMatchObject({ columns: ["value"], rows: [[7]] })
  expect(await host.opencode.permission.list({ sessionID: session.id })).toEqual([])
}, 30_000)

test("c. native DuckDB cancellation prevents a running query from committing", async () => {
  await using fixture = await createFixture()
  const database = join(fixture.path, "cancellation.duckdb")
  const initial = await connect({ type: "duckdb", path: database, create: true })
  await initial.connect()
  try {
    await initial.execute("CREATE TABLE before_abort AS SELECT 7 AS value")
  } finally {
    await initial.close()
  }
  await using host = await createHost({
    directory: fixture.path,
    permissions: [{ action: "sql_execute_write", resource: "*", effect: "allow" }],
  })
  const session = await host.createSession()
  success(
    await host.run(session.id, [{ tool: "warehouse_add", id: "file", input: { name: "local", path: database } }]),
    "file",
  )
  const controller = new AbortController()
  const stream = host.opencode.events.subscribe({ signal: controller.signal })[Symbol.asyncIterator]()
  await stream.next()
  const executing = (async () => {
    for (;;) {
      const event = await stream.next()
      if (event.done) throw new Error("Event stream closed before query started")
      if (event.value.type === "session.tool.progress" && event.value.data.id === "long") return
    }
  })()
  try {
    await host.start(session.id, [
      {
        tool: "sql_execute",
        id: "long",
        input: {
          warehouse: "local",
          sql: "CREATE TABLE after_abort AS SELECT sum(sin((a.i + b.i)::DOUBLE)) AS value FROM range(10000) AS a(i) CROSS JOIN range(100000) AS b(i)",
        },
      },
    ])
    await executing
    await Bun.sleep(50)
    const interrupted = performance.now()
    await host.opencode.sessions.interrupt({ sessionID: session.id })
    await host.opencode.sessions.wait({ sessionID: session.id })
    expect(performance.now() - interrupted).toBeLessThan(2_000)
    const events = await Array.fromAsync(host.opencode.sessions.log({ sessionID: session.id }))
    expect(failure(events, "long").error).toMatchObject({ type: "aborted" })
    const checked = await host.run(session.id, [
      {
        tool: "sql_execute",
        id: "after",
        input: {
          warehouse: "local",
          sql: "SELECT table_name FROM information_schema.tables WHERE table_name = 'after_abort'",
        },
      },
    ])
    // The same connection remains usable, and the interrupted DDL rolled back.
    expect(success(checked, "after").metadata).toMatchObject({ rows: [] })
    // Replacing the warehouse awaits its connector's close before returning.
    success(await host.run(session.id, [warehouse]), "add")
    // A separate process cannot share DuckDB's in-process instance cache. A
    // successful write here proves native file-lock release without forced GC.
    const reopened = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "lib/reopen-duckdb.ts"), database],
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
    })
    const [status, stdout, stderr] = await Promise.all([
      reopened.exited,
      new Response(reopened.stdout).text(),
      new Response(reopened.stderr).text(),
    ])
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" })
    expect(JSON.parse(stdout)).toEqual({ absent: [], before: [[7]], written: [[42]] })
  } finally {
    controller.abort()
    await stream.return?.()
  }
}, 30_000)

test("d. schema_inspect lists the created table and its columns", async () => {
  await using fixture = await createFixture()
  await using host = await createHost({
    directory: fixture.path,
    permissions: [{ action: "sql_execute_write", resource: "*", effect: "allow" }],
  })
  const session = await host.createSession()
  const events = await host.run(session.id, [
    warehouse,
    {
      tool: "sql_execute",
      id: "create",
      input: { warehouse: "local", sql: "CREATE TABLE inventory (id INTEGER NOT NULL, name VARCHAR)" },
    },
    { tool: "schema_inspect", id: "schema", input: { warehouse: "local" } },
  ])
  expect(success(events, "schema").metadata).toMatchObject({
    warehouse: "local",
    tables: expect.arrayContaining([
      expect.objectContaining({
        name: "inventory",
        columns: [
          { name: "id", data_type: "INTEGER", nullable: false },
          { name: "name", data_type: "VARCHAR", nullable: true },
        ],
      }),
    ]),
  })
}, 30_000)

test("e. warehouse definitions persist across hosts sharing DB and storage", async () => {
  await using fixture = await createFixture()
  {
    await using host = await createHost({ directory: fixture.path })
    const session = await host.createSession()
    const events = await host.run(session.id, [
      { tool: "warehouse_add", id: "persist", input: { name: "saved", path: ":memory:" } },
    ])
    success(events, "persist")
  }
  await using host = await createHost({ directory: fixture.path })
  const session = await host.createSession()
  const events = await host.run(session.id, [
    { tool: "warehouse_add", id: "list", input: { name: "second", path: ":memory:" } },
    { tool: "sql_execute", id: "restored", input: { warehouse: "saved", sql: "SELECT 99 AS value" } },
  ])
  expect(success(events, "list").metadata).toMatchObject({
    warehouses: expect.arrayContaining([{ name: "saved", path: ":memory:", type: "duckdb" }]),
  })
  expect(success(events, "restored").metadata).toMatchObject({ rows: [[99]] })
}, 30_000)

function success(events: Log, id: string) {
  const event = events.find((event) => event.type === "session.tool.success" && event.data.id === id)
  if (!event || event.type !== "session.tool.success")
    throw new Error(`Missing success for ${id}: ${JSON.stringify(events)}`)
  return event.data
}

function failure(events: Log, id: string) {
  const event = events.find((event) => event.type === "session.tool.failed" && event.data.id === id)
  if (!event || event.type !== "session.tool.failed")
    throw new Error(`Missing failure for ${id}: ${JSON.stringify(events)}`)
  return event.data
}

async function pending(host: Host, sessionID: string) {
  const deadline = performance.now() + 10_000
  while (performance.now() < deadline) {
    const requests = await host.opencode.permission.list({ sessionID })
    if (requests[0]) return requests[0]
    await Bun.sleep(10)
  }
  throw new Error(
    `No permission request: ${JSON.stringify(await Array.fromAsync(host.opencode.sessions.log({ sessionID })))}`,
  )
}
