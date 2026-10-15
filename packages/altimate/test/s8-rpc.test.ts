import { expect, test } from "bun:test"
import { AltimateRpc } from "../src/rpc"
import { createFixture, createHost } from "./lib/host"

const warehouse = { tool: "warehouse_add", id: "warehouse", input: { name: "local", path: ":memory:" } }
const query = {
  tool: "sql_execute",
  id: "query",
  input: { warehouse: "local", sql: "SELECT 42 AS answer, 'duck' AS label, NULL AS missing" },
}
const result = {
  warehouse: "local",
  columns: ["answer", "label", "missing"],
  rows: [[42, "duck", null]],
  row_count: 1,
  truncated: false,
}

test("S8. RPC returns location warehouses and the session's last successful query through the SDK HTTP client", async () => {
  await using fixture = await createFixture()
  await using other = await createFixture()
  await using host = await createHost({ directory: fixture.path })
  const session = await host.createSession()
  const rpc = host.opencode.rpc(AltimateRpc)
  const options = { location: session.location }

  expect(await rpc.listWarehouses({}, options)).toEqual([])
  expect(await rpc.lastResult({ sessionID: session.id }, options)).toBeNull()
  await host.run(session.id, [warehouse, query])
  expect(await rpc.listWarehouses({}, options)).toEqual([{ name: "local", path: ":memory:", type: "duckdb" }])
  expect(await rpc.lastResult({ sessionID: session.id }, options)).toEqual(result)

  const second = await host.createSession()
  expect(await rpc.lastResult({ sessionID: second.id }, options)).toBeNull()
  expect(await rpc.listWarehouses({}, { location: { directory: other.path } })).toEqual([])
  expect(await rpc.lastResult({ sessionID: session.id }, { location: { directory: other.path } })).toBeNull()

  await host.run(session.id, [
    { ...query, id: "failed-query", input: { warehouse: "local", sql: "SELECT missing_column" } },
  ])
  expect(await rpc.lastResult({ sessionID: session.id }, options)).toEqual(result)
}, 30_000)

test("S8. RPC reads persisted warehouses and last result after host restart", async () => {
  await using fixture = await createFixture()
  const session = await (async () => {
    await using host = await createHost({ directory: fixture.path })
    const session = await host.createSession()
    await host.run(session.id, [warehouse, query])
    return session
  })()

  await using host = await createHost({ directory: fixture.path })
  const rpc = host.opencode.rpc(AltimateRpc)
  expect(await rpc.listWarehouses({}, { location: session.location })).toHaveLength(1)
  expect(await rpc.lastResult({ sessionID: session.id }, { location: session.location })).toEqual(result)
}, 30_000)
