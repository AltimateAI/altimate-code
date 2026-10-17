import { afterEach, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createServer } from "../../../src/altimate/mcp-server/server"
import * as Registry from "../../../src/altimate/native/connections/registry"
import type { Connector } from "@altimateai/drivers/types"
import { closeScratch } from "../../../src/altimate/native/connections/scratch"

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await closeScratch()
  await Registry.closeAll()
  Registry.reset()
})

async function fixture(allowWrite = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcp-tools-test-"))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, "source.sqlite")
  const db = new Database(dbPath)
  db.run("CREATE TABLE items (id INTEGER, name TEXT)")
  db.run("INSERT INTO items VALUES (1, 'apple'), (2, 'pear')")
  db.close()
  const config = path.join(dir, "connections.json")
  await Bun.write(config, JSON.stringify({ source: { type: "sqlite", path: "source.sqlite" } }))
  const server = await createServer({ allowWrite, connections: config })
  const client = new Client({ name: "test", version: "1" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  cleanups.push(async () => {
    await client.close()
    await server.close()
    await Registry.closeAll()
  })
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args })
  return { client, call }
}

function text(result: Awaited<ReturnType<Client["callTool"]>>) {
  return JSON.stringify(result.content)
}

test("lists exactly five tools and executes warehouse, schema, SQL and checks without routing notices", async () => {
  const { client, call } = await fixture()
  const listed = await client.listTools()
  expect(listed.tools.map((t) => t.name).sort()).toEqual([
    "schema_inspect",
    "sql_check",
    "sql_execute",
    "sql_materialize",
    "warehouse_list",
  ])
  expect(listed.tools.every((t) => t.inputSchema.type === "object")).toBe(true)
  for (const [name, args, expected] of [
    ["warehouse_list", {}, "source"],
    ["schema_inspect", { warehouse: "source", table: "items", include_samples: false }, "name"],
    ["sql_execute", { warehouse: "source", query: "SELECT * FROM items" }, "apple"],
    ["sql_check", { warehouse: "source", check: "nulls", sql: "SELECT * FROM items", columns: ["id"] }, "null"],
  ] as const) {
    const result = await call(name, args)
    expect(result.isError).toBe(false)
    expect(text(result)).toContain(expected)
    expect(text(result)).not.toContain("Not routed through the bound workspace")
  }
})

test("source writes are denied by default and cannot modify the source", async () => {
  const { call } = await fixture()
  const denied = await call("sql_execute", { warehouse: "source", query: "INSERT INTO items VALUES (3, 'plum')" })
  expect(denied.isError).toBe(true)
  expect(text(denied)).toContain("--allow-write")
  const rows = await call("sql_execute", { warehouse: "source", query: "SELECT COUNT(*) AS total FROM items" })
  expect(rows.isError).toBe(false)
  expect(text(rows)).toContain("2")
})

test("allow-write permits SQL mutations", async () => {
  const { call } = await fixture(true)
  expect(
    (await call("sql_execute", { warehouse: "source", query: "INSERT INTO items VALUES (3, 'plum')" })).isError,
  ).toBe(false)
  expect(
    text(await call("sql_execute", { warehouse: "source", query: "SELECT name FROM items WHERE id=3" })),
  ).toContain("plum")
})

test("materializes read-only sources into scratch, refuses source mutations", async () => {
  const { call } = await fixture()
  const result = await call("sql_materialize", {
    source_warehouse: "source",
    sql: "SELECT * FROM items",
    target_table: "copied",
  })
  expect(result.isError).toBe(false)
  expect(text(result)).not.toContain("Not routed through the bound workspace")
  const rows = await call("sql_execute", { warehouse: "scratch", query: "SELECT * FROM copied" })
  expect(rows.isError).toBe(false)
  expect(text(rows)).toContain("apple")
  const denied = await call("sql_materialize", {
    source_warehouse: "source",
    sql: "DELETE FROM items",
    target_table: "bad",
  })
  expect(denied.isError).toBe(true)
})

test("MCP cancellation reaches the active tool abort signal", async () => {
  const { client } = await fixture()
  const started = Promise.withResolvers<AbortSignal>()
  const stopped = Promise.withResolvers<void>()
  const original = Registry.get
  const execute: Connector["execute"] = (_sql, _limit, _binds, options) => {
    started.resolve(options!.signal!)
    return new Promise((_resolve, reject) =>
      options!.signal!.addEventListener(
        "abort",
        () => {
          stopped.resolve()
          reject(new Error("Cancelled"))
        },
        { once: true },
      ),
    )
  }
  const dispatch = spyOn(Registry, "get").mockImplementation(async (name) =>
    name === "source" ? ({ execute, supportsResultByteLimit: true } as Connector) : original(name),
  )
  try {
    const abort = new AbortController()
    const request = client.callTool(
      { name: "sql_execute", arguments: { warehouse: "source", query: "SELECT * FROM items" } },
      undefined,
      { signal: abort.signal },
    )
    const rejected = request.then(
      () => {
        throw new Error("Expected cancellation rejection")
      },
      (error) => error,
    )
    const signal = await started.promise
    abort.abort(new Error("Client cancelled"))
    expect(await rejected).toBeInstanceOf(Error)
    await stopped.promise
    expect(signal.aborted).toBe(true)
  } finally {
    dispatch.mockRestore()
  }
})

test("spill output gives MCP-compatible file-reader instructions", async () => {
  const { call } = await fixture()
  const result = await call("sql_execute", {
    warehouse: "source",
    query: "SELECT name FROM items",
    full_text_columns: ["name"],
  })
  expect(result.isError).toBe(false)
  expect(text(result)).toContain("any file reader")
  expect(text(result)).not.toContain("char_offset")
  expect(text(result)).not.toContain("Task tool")
})

test("generic truncation saves output with client-neutral hints", async () => {
  const { call } = await fixture()
  const listing = spyOn(Registry, "list").mockReturnValue({
    warehouses: Array.from({ length: 2500 }, (_, i) => ({ name: `warehouse_${i}`, type: "sqlite" })),
  })
  try {
    const result = await call("warehouse_list", {})
    expect(result.isError).toBe(false)
    expect(text(result)).toContain("Full output saved to:")
    expect(text(result)).toContain("any file reader")
    expect(text(result)).not.toContain("Task tool")
    expect(text(result)).not.toContain("offset/limit")
  } finally {
    listing.mockRestore()
  }
})

test("server startup and tool listing make no network calls", async () => {
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      () => {
        throw new Error("Unexpected network call")
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  )
  try {
    const { client } = await fixture()
    expect((await client.listTools()).tools).toHaveLength(5)
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    fetch.mockRestore()
  }
})

test("malformed arguments and unknown tools return MCP errors", async () => {
  const { call } = await fixture()
  expect((await call("unknown", {})).isError).toBe(true)
  expect((await call("sql_execute", { warehouse: "source", query: 42 })).isError).toBe(true)
})
