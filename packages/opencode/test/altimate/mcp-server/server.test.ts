// altimate_change start — standalone MCP enforcement and lifecycle regressions
import { afterEach, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm, stat, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createServer, SERVER_INSTRUCTIONS } from "../../../src/altimate/mcp-server/server"
import * as Registry from "../../../src/altimate/native/connections/registry"
import { Dispatcher } from "../../../src/altimate/native"
import type { Connector } from "@altimateai/drivers/types"
import { closeScratch } from "../../../src/altimate/native/connections/scratch"

// These tests need real SQLite/DuckDB drivers in their own `bun test` process: files elsewhere in
// test/altimate install top-level mock.module("@altimateai/drivers/duckdb", …), which a whole-package
// run evaluates first. CI runs them in a dedicated step with ALTIMATE_MCP_E2E=1.
const mcpTest = process.env["ALTIMATE_MCP_E2E"] === "1" ? test : test.skip

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
  return { client, call, server }
}

function text(result: Awaited<ReturnType<Client["callTool"]>>) {
  return JSON.stringify(result.content)
}

mcpTest("initialize result carries short analyst-method instructions", async () => {
  const { client } = await fixture()
  const instructions = client.getInstructions()
  expect(instructions).toBe(SERVER_INSTRUCTIONS)
  expect(instructions!.split(/\s+/).length).toBeLessThanOrEqual(120)
  for (const tool of ["warehouse_list", "schema_inspect", "sql_materialize", "sql_check"]) {
    expect(instructions).toContain(tool)
  }
})

mcpTest("lists exactly five tools and executes warehouse, schema, SQL and checks without routing notices", async () => {
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
  expect(JSON.stringify(listed.tools)).not.toMatch(/char_offset|lineage_check|tool_lookup|Task tool/)
  for (const [name, args, expected] of [
    ["warehouse_list", {}, "source"],
    ["schema_inspect", { warehouse: "source", table: "items", values: false }, "name"],
    ["sql_execute", { warehouse: "source", query: "SELECT * FROM items" }, "apple"],
    ["sql_check", { warehouse: "source", check: "nulls", sql: "SELECT * FROM items", columns: ["id"] }, "null"],
  ] as const) {
    const result = await call(name, args)
    expect(result.isError).toBe(false)
    expect(text(result)).toContain(expected)
    expect(text(result)).not.toMatch(/lineage_check|tool_lookup|char_offset|Task tool/)
    expect(text(result)).not.toContain("Not routed through the bound workspace")
  }
})

// altimate_change start — warehouse discovery accepts strict-schema empty table fillers
mcpTest("schema_inspect lists schemas, then SQLite tables with protected counts", async () => {
  const { call } = await fixture()
  for (const args of [{ warehouse: "source" }, { warehouse: "source", table: "", schema_name: "", values: false }]) {
    const result = await call("schema_inspect", args)
    expect(result.isError).toBe(false)
    // altimate_change start — discovery starts with schema counts
    expect(body(result)).toContain("main | 1")
    expect(body(result)).not.toContain("main | items")
    const tables = await call("schema_inspect", { warehouse: "source", schema_name: "main" })
    expect(tables.isError).toBe(false)
    expect(body(tables)).toContain("main | items | table | 2")
    // altimate_change end
    expect(body(result)).toContain("Inspect one table with schema_inspect")
  }
})
// altimate_change end

mcpTest("source writes are denied by default and cannot modify the source", async () => {
  const { call } = await fixture()
  const denied = await call("sql_execute", { warehouse: "source", query: "INSERT INTO items VALUES (3, 'plum')" })
  expect(denied.isError).toBe(true)
  expect(text(denied)).toContain("--allow-write")
  const rows = await call("sql_execute", { warehouse: "source", query: "SELECT COUNT(*) AS total FROM items" })
  expect(rows.isError).toBe(false)
  expect(text(rows)).toContain("2")
})

mcpTest("allow-write permits SQL mutations", async () => {
  const { call } = await fixture(true)
  expect(
    (await call("sql_execute", { warehouse: "source", query: "INSERT INTO items VALUES (3, 'plum')" })).isError,
  ).toBe(false)
  expect(
    text(await call("sql_execute", { warehouse: "source", query: "SELECT name FROM items WHERE id=3" })),
  ).toContain("plum")
})

mcpTest("materializes read-only sources into scratch, refuses source mutations", async () => {
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

mcpTest("MCP cancellation reaches the active tool abort signal", async () => {
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

mcpTest("spill output gives MCP-compatible file-reader instructions", async () => {
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

mcpTest("generic truncation saves output with client-neutral hints", async () => {
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

mcpTest("server startup and tool listing make no network calls", async () => {
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

mcpTest("malformed arguments and unknown tools return MCP errors", async () => {
  const { call } = await fixture()
  expect((await call("unknown", {})).isError).toBe(true)
  expect((await call("sql_execute", { warehouse: "source", query: 42 })).isError).toBe(true)
})

// altimate_change end

// altimate_change start — database protection, disclosures, spill lifecycle
function body(result: Awaited<ReturnType<Client["callTool"]>>) {
  return (result.content as { text: string }[]).map((part) => part.text).join("\n")
}

mcpTest("SQLite MCP SELECT runs with database query_only enabled", async () => {
  const { call } = await fixture()
  const result = await call("sql_execute", {
    warehouse: "source",
    query:
      "SELECT CASE WHEN query_only = 1 THEN 'database protected' ELSE 'unprotected' END AS protection FROM pragma_query_only()",
  })
  expect(result.isError).toBe(false)
  expect(text(result)).toContain("database protected")
})

mcpTest("MCP forces database protection for every SQLite source query path", async () => {
  const { call } = await fixture()
  const original = Registry.get
  const options: unknown[] = []
  const get = spyOn(Registry, "get").mockImplementation(async (name) => {
    const connector = await original(name)
    if (name !== "source") return connector
    return {
      ...connector,
      execute: (sql, limit, binds, opts) => {
        options.push(opts)
        return connector.execute(sql, limit, binds, opts)
      },
    } as Connector
  })
  try {
    for (const [tool, args] of [
      ["sql_execute", { warehouse: "source", query: "SELECT * FROM items" }],
      [
        "sql_execute",
        { warehouse: "source", query_from: { warehouse: "source", sql: "SELECT 'SELECT * FROM items' AS sql" } },
      ],
      ["schema_inspect", { warehouse: "source", table: "items", values: true }],
      // altimate_change start — inventory counts also enforce database read-only
      ["schema_inspect", { warehouse: "source" }],
      // altimate_change end
      ["sql_check", { warehouse: "source", check: "nulls", sql: "SELECT * FROM items", columns: ["id"] }],
      ["sql_materialize", { source_warehouse: "source", sql: "SELECT * FROM items", target_table: "protected_copy" }],
    ] as const) {
      options.length = 0
      const result = await call(tool, args)
      expect(result.isError).toBe(false)
      expect(options.length).toBeGreaterThan(0)
      for (const option of options) expect(option).toMatchObject({ readOnly: true })
    }
  } finally {
    get.mockRestore()
  }
})

mcpTest("Postgres MCP sql_execute requests dispatcher read_only", async () => {
  const { call } = await fixture()
  Registry.setConfigs({ source: { type: "postgres" } })
  const original = Dispatcher.call
  const dispatch = spyOn(Dispatcher, "call").mockImplementation(async (method, args, context) => {
    if (method === "sql.execute") {
      expect(args).toMatchObject({ read_only: true })
      expect(context).toMatchObject({ forceReadOnly: true })
      return { columns: ["value"], rows: [[42]], row_count: 1, truncated: false } as never
    }
    return original(method, args, context)
  })
  try {
    const result = await call("sql_execute", { warehouse: "source", query: "SELECT app.mutate_source()" })
    expect(result.isError).toBe(false)
    expect(dispatch.mock.calls.some(([method]) => method === "sql.execute")).toBe(true)
  } finally {
    dispatch.mockRestore()
  }
})

mcpTest("classification-only connections warn at startup and in warehouse_list", async () => {
  const notice = spyOn(console, "error").mockImplementation(() => {})
  Registry.setConfigs({ mysql_source: { type: "mysql" }, pg_source: { type: "postgres" } })
  const server = await createServer()
  const client = new Client({ name: "test", version: "1" })
  const [left, right] = InMemoryTransport.createLinkedPair()
  try {
    expect(notice.mock.calls).toEqual([
      [
        "mysql_source (mysql): read-only is enforced by SQL classification only; stored functions with side effects are not blocked — use a read-only database user",
      ],
    ])
    await server.connect(right)
    await client.connect(left)
    const result = await client.callTool({ name: "warehouse_list", arguments: {} })
    expect(text(result)).toContain("mysql_source (mysql): read-only is enforced by SQL classification only")
    expect(text(result)).toContain("use a read-only database user")
    expect(text(result)).not.toContain("pg_source (postgres):")
  } finally {
    notice.mockRestore()
    await client.close()
    await server.close()
  }
})

mcpTest("private spill directory and its files are removed on server close", async () => {
  const { call, server } = await fixture()
  const result = await call("sql_execute", {
    warehouse: "source",
    query: "SELECT name FROM items",
    full_text_columns: ["name"],
  })
  const saved = body(result).match(/(\/[^\s`]+\/tool_[A-Za-z0-9]+)/)?.[1]
  expect(saved).toBeDefined()
  expect((await stat(path.dirname(saved!))).mode & 0o777).toBe(0o700)
  expect(await readFile(saved!, "utf8")).toContain("apple")
  await server.close()
  expect(await Bun.file(saved!).exists()).toBe(false)
  await expect(stat(path.dirname(saved!))).rejects.toThrow()
})

mcpTest("shared truncation honors configured limits and preserves failure wording", async () => {
  const previous = process.env.OPENCODE_CONFIG_CONTENT
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ tool_output: { max_lines: 2, max_bytes: 40 } })
  try {
    const { call } = await fixture()
    const result = await call("warehouse_list", {})
    expect(text(result)).toContain("Full output saved to:")
    expect(text(result)).toContain("succeeded but the output was truncated")
    const listing = spyOn(Registry, "list").mockImplementation(() => {
      throw new Error("A long warehouse listing failure that exceeds the configured output byte limit")
    })
    try {
      const failure = await call("warehouse_list", {})
      expect(failure.isError).toBe(true)
      expect(text(failure)).toContain("failed but the output was truncated")
    } finally {
      listing.mockRestore()
    }
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
    else process.env.OPENCODE_CONFIG_CONTENT = previous
  }
})
// altimate_change end

// altimate_change start — SELECT over a macro hides a write from SQL classification
for (const allowWrite of [false, true]) {
  mcpTest(`DuckDB hidden function writes reach the database read-only guard (allow-write=${allowWrite})`, async () => {
    const { call } = await fixture(allowWrite)
    Registry.setConfigs({ source: { type: "duckdb", path: ":memory:" } })
    const connector = await Registry.get("source")
    await connector.execute("CREATE SEQUENCE source_sequence")
    await connector.execute("CREATE MACRO mutate_source() AS nextval('source_sequence')")
    const result = await call("sql_execute", { warehouse: "source", query: "SELECT mutate_source() AS id" })
    expect(result.isError).toBe(!allowWrite)
    if (!allowWrite) expect(text(result)).toMatch(/read.only/i)
    const state = await connector.execute(
      "SELECT last_value FROM duckdb_sequences() WHERE sequence_name = 'source_sequence'",
    )
    expect(state.rows).toEqual([[allowWrite ? 1n : null]])
  })
}
// altimate_change end

// altimate_change start — the explicit production loader owns validation and path resolution
for (const configs of [[], null, { bad: {} }, { bad: { type: 1 } }]) {
  mcpTest(`explicit connections loader rejects invalid input ${JSON.stringify(configs)}`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mcp-invalid-config-"))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const file = path.join(dir, "connections.json")
    await Bun.write(file, JSON.stringify(configs))
    await expect(createServer({ connections: file })).rejects.toThrow(/connection/i)
  })
}

mcpTest("explicit connections loader preserves reserved scratch conflict", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcp-scratch-conflict-"))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, "connections.json")
  await Bun.write(file, JSON.stringify({ scratch: { type: "sqlite", path: "scratch.sqlite" } }))
  await Registry.loadFile(file)
  expect(Registry.getConfig("scratch")?.path).toBe(path.join(dir, "scratch.sqlite"))
  expect(Registry.list().warehouses[0]?.conflict).toContain("reserved built-in scratch")
})
// altimate_change end

// altimate_change start — closing aborts in-flight work before deleting private output
mcpTest("server close aborts active source queries before cleanup", async () => {
  const { client, server } = await fixture()
  const started = Promise.withResolvers<AbortSignal>()
  const execute: Connector["execute"] = (_sql, _limit, _binds, options) => {
    const signal = options!.signal!
    started.resolve(signal)
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
  }
  const original = Registry.get
  const get = spyOn(Registry, "get").mockImplementation(async (name) =>
    name === "source" ? ({ execute, supportsResultByteLimit: true } as Connector) : original(name),
  )
  try {
    const pending = client.callTool({ name: "sql_execute", arguments: { warehouse: "source", query: "SELECT * FROM items" } })
      .catch((error) => error)
    const signal = await started.promise
    await server.close()
    expect(signal.aborted).toBe(true)
    await pending
  } finally { get.mockRestore() }
})
// altimate_change end
