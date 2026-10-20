// altimate_change start — standalone MCP enforcement and lifecycle regressions
import { afterEach, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { chmod, mkdir, mkdtemp, rm, stat, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js"
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

async function fixture(
  allowWrite = false,
  capabilities: Record<string, object> = {},
  elicitTimeoutMs?: number,
  setup?: (db: Database) => void,
  allTools = true,
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcp-tools-test-"))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, "source.sqlite")
  const db = new Database(dbPath)
  db.run("CREATE TABLE items (id INTEGER, name TEXT)")
  db.run("INSERT INTO items VALUES (1, 'apple'), (2, 'pear')")
  setup?.(db)
  db.close()
  const config = path.join(dir, "connections.json")
  await Bun.write(config, JSON.stringify({ source: { type: "sqlite", path: "source.sqlite" } }))
  const server = await createServer({ allowWrite, connections: config, elicitTimeoutMs, allTools })
  const client = new Client({ name: "test", version: "1" }, { capabilities })
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
  for (const tool of ["warehouse_list", "warehouse_add", "sql_execute", "sql_materialize", "answer_commit"]) {
    expect(instructions).toContain(tool)
  }
  // Instructions name only advertised tools.
  expect(instructions).not.toMatch(/schema_inspect|sql_check/)
})

mcpTest("the default toolset is five tools; sql_execute `tables` describes tables and runs queries in one call", async () => {
  const { client, call } = await fixture(false, {}, undefined, undefined, false)
  const listed = await client.listTools()
  expect(listed.tools.map((t) => t.name).sort()).toEqual([
    "answer_commit",
    "sql_execute",
    "sql_materialize",
    "warehouse_add",
    "warehouse_list",
  ])
  const declared = listed.tools.reduce(
    (total, t) => total + JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema }).length,
    0,
  )
  expect(declared).toBeLessThan(5_200)
  expect(client.getInstructions()!.length).toBeLessThanOrEqual(600)
  const sqlExecute = listed.tools.find((t) => t.name === "sql_execute")!
  expect(Object.keys(sqlExecute.inputSchema.properties ?? {})).toContain("tables")
  const fused = await call("sql_execute", {
    warehouse: "source",
    tables: ["items"],
    queries: [{ label: "fruit", query: "SELECT name FROM items ORDER BY id" }],
  })
  expect(fused.isError).toBe(false)
  const body = text(fused)
  // Schema first (column list with its value profile), then the query result, in one response.
  expect(body).toContain("name")
  expect(body.indexOf("items")).toBeLessThan(body.indexOf("apple"))
  expect(body).toContain("pear")
  const schemaOnly = await call("sql_execute", { warehouse: "source", tables: ["items"] })
  expect(schemaOnly.isError).toBe(false)
  expect(text(schemaOnly)).toContain("items")
  expect(text(schemaOnly)).not.toContain("apple | ")
  const schemaMiss = await call("sql_execute", { warehouse: "source", tables: ["no_such_table"] })
  expect(schemaMiss.isError).toBe(true)
  const missing = await call("sql_execute", { warehouse: "source", tables: ["no_such_table"], query: "SELECT 1 AS one" })
  expect(text(missing)).toContain("no_such_table")
  expect(text(missing)).toContain("one")
  // Unadvertised tools are not callable.
  const hidden = await call("sql_check", { warehouse: "source", check: "nulls", sql: "SELECT * FROM items", columns: ["id"] })
  expect(hidden.isError).toBe(true)
})

mcpTest("allTools lists exactly seven tools and executes warehouse, schema, SQL and checks without routing notices", async () => {
  const { client, call } = await fixture()
  const listed = await client.listTools()
  expect(listed.tools.map((t) => t.name).sort()).toEqual([
    "answer_commit",
    "schema_inspect",
    "sql_check",
    "sql_execute",
    "sql_materialize",
    "warehouse_add",
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
  for (const [index, args] of [
    { warehouse: "source" },
    { warehouse: "source", table: "", schema_name: "", values: false },
  ].entries()) {
    const result = await call("schema_inspect", args)
    expect(result.isError).toBe(false)
    // altimate_change start — discovery starts with schema counts
    expect(body(result)).toContain("main | 1")
    expect(body(result)).not.toContain("main | items")
    const tables = await call("schema_inspect", { warehouse: "source", schema_name: "main" })
    expect(tables.isError).toBe(false)
    expect(body(tables)).toContain("main | items | table | 2")
    // altimate_change end
    // The usage hint is shown once per session; the table rule line is gone over MCP.
    if (index === 0) expect(body(result)).toContain("Inspect one table with schema_inspect")
    else expect(body(result)).not.toContain("Inspect one table with schema_inspect")
    expect(body(result)).not.toContain("-------|")
    expect(body(tables)).not.toContain("-------|")
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
  expect(text(result)).toContain("scratch table result_1")
  expect(text(result)).not.toContain("char_offset")
  expect(text(result)).not.toContain("Task tool")
  // When the scratch table cannot be stored, the file stays the documented fallback.
  const original = Registry.get
  const get = spyOn(Registry, "get").mockImplementation(async (name) => {
    if (name === "scratch") throw new Error("scratch unavailable")
    return original(name)
  })
  try {
    const fallback = await call("sql_execute", { warehouse: "source", query: "SELECT name FROM items", full_text_columns: ["name"] })
    expect(text(fallback)).toContain("any file reader")
    expect(text(fallback)).not.toContain("scratch table")
  } finally {
    get.mockRestore()
  }
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
    expect((await client.listTools()).tools).toHaveLength(7)
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
      // Discovery's counts and sample rows go through the same protection.
      ["warehouse_list", {}],
      ["sql_execute", { warehouse: "source", queries: [{ query: "SELECT * FROM items" }, { query: "SELECT 1 AS one" }] }],
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
  const saved = body(result).match(/(\/[^\s`()]+\/result-\d+\.csv)/)?.[1]
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

// altimate_change start — answer_commit over MCP: requested-item coverage, number provenance, basis trimming
const commit = (fields: { name: string; value: string | number }[], asked: string[], basis = "Counted items.") => ({
  fields,
  asked,
  basis,
})

mcpTest("answer_commit returns the canonical FINAL ANSWER text and trims a long basis", async () => {
  const { call } = await fixture()
  const result = await call("answer_commit", commit([{ name: "", value: "apple" }], ["item"], "x".repeat(900)))
  expect(result.isError).toBeFalsy()
  const out = (result.content as { text: string }[])[0]!.text
  // altimate_change start — the FINAL ANSWER line is answer-only; the trimmed basis sits above it
  expect(out).toMatch(/(^|\n\n)FINAL ANSWER: /)
  const answer = out.slice(out.indexOf("FINAL ANSWER: "))
  expect(answer).toContain("apple")
  expect(answer).not.toContain("xxx")
  // altimate_change end
})

mcpTest("answer_commit rejects a missing asked item at most twice, then accepts", async () => {
  const { call } = await fixture()
  const args = commit([{ name: "item", value: "apple" }], ["item", "count"])
  for (let i = 0; i < 2; i++) {
    const rejected = await call("answer_commit", args)
    expect(rejected.isError).toBe(true)
    expect(text(rejected)).toContain("requested-items check")
  }
  expect((await call("answer_commit", args)).isError).toBeFalsy()
})

// The server cannot see numbers the client computed in its own shell or code, so over MCP a number
// absent from this server's query output is accepted on the first commit (native sessions still check).
mcpTest("answer_commit accepts a client-computed number absent from query output on the first commit", async () => {
  const { call } = await fixture()
  await call("sql_execute", { warehouse: "source", query: "SELECT COUNT(*) AS n FROM items" })
  const accepted = await call("answer_commit", commit([{ name: "total", value: 98765 }], ["total"]))
  expect(accepted.isError).toBeFalsy()
  expect(text(accepted)).not.toContain("number check")
  expect(text(accepted)).toContain("98765")
})

mcpTest("answer_commit over MCP still runs the requested-items check before accepting a computed number", async () => {
  const { call } = await fixture()
  await call("sql_execute", { warehouse: "source", query: "SELECT COUNT(*) AS n FROM items" })
  const rejected = await call("answer_commit", commit([{ name: "total", value: 98765 }], ["total", "item"]))
  expect(rejected.isError).toBe(true)
  expect(text(rejected)).toContain("requested-items check")
})

mcpTest("answer_commit accepts a number that appeared in query output", async () => {
  const { call } = await fixture()
  await call("sql_execute", { warehouse: "source", query: "SELECT 4321 AS n" })
  expect((await call("answer_commit", commit([{ name: "n", value: 4321 }], ["n"]))).isError).toBeFalsy()
})
// altimate_change end

// altimate_change start — conjunction check over MCP: the request arrives as an MCP-only argument
mcpTest("answer_commit exposes a required request argument over MCP", async () => {
  const { client } = await fixture()
  const tool = (await client.listTools()).tools.find((item) => item.name === "answer_commit")
  expect(Object.keys(tool!.inputSchema.properties ?? {})).toContain("request")
  expect(tool!.inputSchema.required).toContain("request")
})

mcpTest("answer_commit rejects an under-asked commit on a compound request once, then accepts", async () => {
  const { call } = await fixture()
  const args = { ...commit([{ name: "item", value: "apple" }], ["item"]), request: "Which item and its id?" }
  const rejected = await call("answer_commit", args)
  expect(rejected.isError).toBe(true)
  expect(text(rejected)).toContain("answer_commit conjunction check:")
  const accepted = await call("answer_commit", args)
  expect(accepted.isError).toBeFalsy()
  // An under-asked commit keeps the basis on the FINAL ANSWER line.
  const out = (accepted.content as { text: string }[])[0]!.text
  expect(out.startsWith("FINAL ANSWER: Counted items.")).toBe(true)
  expect(out).toContain("**Answer:**")
  expect(out).toContain("apple")
})

mcpTest("answer_commit accepts a single-item request and a commit without request", async () => {
  const { call } = await fixture()
  const single = { ...commit([{ name: "item", value: "apple" }], ["item"]), request: "Which item sorts first?" }
  expect((await call("answer_commit", single)).isError).toBeFalsy()
  expect((await call("answer_commit", commit([{ name: "item", value: "apple" }], ["item"]))).isError).toBeFalsy()
})

mcpTest("answer_commit accepts a compound request committed with both items", async () => {
  const { call } = await fixture()
  const both = {
    ...commit(
      [
        { name: "item", value: "apple" },
        { name: "id", value: "one" },
      ],
      ["item", "id"],
    ),
    request: "Which item and its id?",
  }
  expect((await call("answer_commit", both)).isError).toBeFalsy()
})
// altimate_change end

// altimate_change start — spilled sql_execute results carry a resource_link beside the text fallback
mcpTest("sql_execute spill returns text with the path plus a resource_link to the saved rows", async () => {
  const { call } = await fixture()
  const result = await call("sql_execute", {
    warehouse: "source",
    query: "SELECT id, name FROM items",
    full_text_columns: ["name"],
  })
  const content = result.content as { type: string; text?: string; uri?: string }[]
  const link = content.find((item) => item.type === "resource_link")
  expect(link?.uri?.startsWith("file://")).toBe(true)
  expect(content[0]!.type).toBe("text")
  expect(content[0]!.text).toContain(`CSV copy: ${fileURLToPath(link!.uri!)}`)
})

mcpTest("sql_execute without a spill returns text only", async () => {
  const { call } = await fixture()
  const result = await call("sql_execute", { warehouse: "source", query: "SELECT id FROM items" })
  expect((result.content as { type: string }[]).map((item) => item.type)).toEqual(["text"])
})
// altimate_change end

// altimate_change start — answer_commit returns only the FINAL ANSWER text: Claude Code shows structuredContent in place of the text
mcpTest("answer_commit returns the FINAL ANSWER text without structured output", async () => {
  const { client, call } = await fixture()
  const tool = (await client.listTools()).tools.find((item) => item.name === "answer_commit")
  expect(tool?.outputSchema).toBeUndefined()
  const result = await call("answer_commit", commit([{ name: "", value: "apple" }], ["item"]))
  expect(result.structuredContent).toBeUndefined()
  expect((result.content as { text: string }[])[0]!.text).toMatch(/(^|\n\n)FINAL ANSWER: /)
})
// altimate_change end

// altimate_change start — the analyze prompt carries the analyst method for interactive clients
mcpTest("analyze prompt returns the analyst method and the question", async () => {
  const { client } = await fixture()
  expect((await client.listPrompts()).prompts.map((item) => item.name)).toEqual(["analyze"])
  const prompt = await client.getPrompt({ name: "analyze", arguments: { question: "How many items?" } })
  const body = (prompt.messages[0]!.content as { text: string }).text
  expect(body).toContain(SERVER_INSTRUCTIONS)
  expect(body).toContain("Question: How many items?")
  await expect(client.getPrompt({ name: "nope" })).rejects.toThrow()
})
// altimate_change end

// altimate_change start — answer_commit asks which reading was meant only when two exist and the client can ask
const twoReadings = {
  ...commit([{ name: "", value: "apple" }], ["item"]),
  readings: [
    { clause: "c", reading: "by name", result_summary: "apple", decided_by: "x" },
    { clause: "c", reading: "by id", result_summary: "pear", decided_by: "y" },
  ],
}

mcpTest("answer_commit elicits a reading and asks for a recompute when another is chosen", async () => {
  const { client, call } = await fixture(false, { elicitation: {} })
  let asked = 0
  client.setRequestHandler(ElicitRequestSchema, async () => {
    asked++
    return { action: "accept", content: { reading: "by id" } }
  })
  const first = await call("answer_commit", twoReadings)
  expect(first.isError).toBe(true)
  expect(text(first)).toContain("by id")
  // Asked once per session: the follow-up commit is accepted.
  expect((await call("answer_commit", twoReadings)).isError).toBeFalsy()
  expect(asked).toBe(1)
})

mcpTest("answer_commit degrades silently when the client cancels or lacks elicitation", async () => {
  const cancelled = await fixture(false, { elicitation: {} })
  cancelled.client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "cancel" }))
  expect((await cancelled.call("answer_commit", twoReadings)).isError).toBeFalsy()
})

mcpTest("answer_commit accepts the commit when the client never answers the reading question", async () => {
  const silent = await fixture(false, { elicitation: {} }, 200)
  silent.client.setRequestHandler(ElicitRequestSchema, () => new Promise(() => {}))
  const started = Date.now()
  const result = await silent.call("answer_commit", twoReadings)
  expect(result.isError).toBeFalsy()
  expect(Date.now() - started).toBeLessThan(5_000)
})

mcpTest("answer_commit without elicitation support or with one reading never asks", async () => {
  const plain = await fixture()
  expect((await plain.call("answer_commit", twoReadings)).isError).toBeFalsy()
})
// altimate_change end

// altimate_change start — batched sql_execute: one call, one labeled block per independent query
mcpTest("sql_execute queries runs every item and keeps going past a failing one", async () => {
  const { call } = await fixture()
  const result = await call("sql_execute", {
    warehouse: "source",
    queries: [
      { label: "count", query: "SELECT COUNT(*) AS n FROM items" },
      { label: "broken", query: "SELECT nope FROM missing_table" },
      { query: "SELECT name FROM items WHERE id = 2" },
    ],
  })
  expect(result.isError).toBe(false)
  const out = body(result)
  const count = out.indexOf("[count]\n")
  const broken = out.indexOf("[broken]\n")
  const third = out.indexOf("[q3]\n")
  expect(count).toBe(0)
  expect(broken).toBeGreaterThan(count)
  expect(third).toBeGreaterThan(broken)
  expect(out.slice(count, broken)).toContain("2")
  expect(out.slice(broken, third)).toContain("Failed to execute SQL")
  expect(out.slice(third)).toContain("pear")
})

mcpTest("sql_execute queries refuses writes per item, even with --allow-write", async () => {
  const { call } = await fixture(true)
  const result = await call("sql_execute", {
    warehouse: "source",
    queries: [{ query: "INSERT INTO items VALUES (3, 'plum')" }, { query: "SELECT COUNT(*) AS n FROM items" }],
  })
  expect(result.isError).toBe(false)
  expect(body(result)).toContain("Batched queries must be read-only")
  const rows = await call("sql_execute", { warehouse: "source", query: "SELECT COUNT(*) AS n FROM items" })
  expect(body(rows)).toMatch(/\b2\b/)
  expect(body(rows)).not.toContain("plum")
})

mcpTest("sql_execute queries is an error only when every item fails", async () => {
  const { call } = await fixture()
  const result = await call("sql_execute", {
    warehouse: "source",
    queries: [{ query: "SELECT a FROM nowhere" }, { query: "SELECT b FROM nowhere_else" }],
  })
  expect(result.isError).toBe(true)
  expect(body(result)).toContain("[q1]")
  expect(body(result)).toContain("[q2]")
})

mcpTest("sql_execute queries is exclusive with query and capped at eight items", async () => {
  const { call } = await fixture()
  const both = await call("sql_execute", {
    warehouse: "source",
    query: "SELECT 1",
    queries: [{ query: "SELECT 2" }],
  })
  expect(both.isError).toBe(true)
  expect(body(both)).toContain("not both")
  const many = await call("sql_execute", {
    warehouse: "source",
    queries: Array.from({ length: 9 }, (_, i) => ({ query: `SELECT ${i}` })),
  })
  expect(many.isError).toBe(true)
  expect(body(many)).toContain("at most 8")
})

mcpTest("sql_execute queries keeps the whole envelope inside one shared budget", async () => {
  const { call } = await fixture(false, {}, undefined, (db) => {
    db.run("CREATE TABLE wide (id INTEGER, payload TEXT)")
    const insert = db.prepare("INSERT INTO wide VALUES (?, ?)")
    for (let i = 0; i < 400; i++) insert.run(i, `${"é".repeat(60)}-${i}`)
  })
  const label = "L".repeat(500)
  const result = await call("sql_execute", {
    warehouse: "source",
    limit: 400,
    queries: [
      { label, query: "SELECT * FROM wide" },
      { query: "SELECT * FROM wide ORDER BY id DESC" },
      { query: `SELECT '${"x".repeat(30_000)}' AS huge FROM nowhere` },
    ],
  })
  const out = body(result)
  expect(Buffer.byteLength((result.content as { type: string; text?: string }[])[0]!.text!, "utf8")).toBeLessThanOrEqual(
    24 * 1024,
  )
  expect(out).toContain(`[${"L".repeat(60)}]`)
  expect(out).not.toContain("L".repeat(61))
  expect(out).toContain("[q2]")
  expect(out).toContain("[q3]")
  // Both large results were saved; each gets its own resource link.
  const links = (result.content as { type: string; uri?: string }[]).filter((item) => item.type === "resource_link")
  expect(links).toHaveLength(2)
  expect(new Set(links.map((link) => link.uri)).size).toBe(2)
})
// altimate_change end

// altimate_change start — spilled results become a scratch table to query, with a short preview
const spillRows = (db: Database) => {
  db.run("CREATE TABLE events (id INTEGER, code TEXT, note TEXT, ratio REAL)")
  const insert = db.prepare("INSERT INTO events VALUES (?, ?, ?, ?)")
  for (let i = 1; i <= 200; i++) {
    insert.run(i, `00${i}`, i % 3 === 0 ? null : i % 3 === 1 ? "" : `a,"b"\nc ${"x".repeat(300)}`, i / 8)
  }
}

mcpTest("a spilled result is queryable as a scratch table with exact values", async () => {
  const { call } = await fixture(false, {}, undefined, spillRows)
  const result = await call("sql_execute", { warehouse: "source", query: "SELECT * FROM events ORDER BY id", limit: 500 })
  expect(result.isError).toBe(false)
  const out = body(result)
  expect(out).toContain("Preview: 10 of 200 returned rows.")
  expect(out).toContain('scratch table result_1 (typed like sql_materialize): query it with sql_execute(warehouse: "scratch"')
  // Cells in the preview are clipped; the table keeps them whole.
  expect(out).toContain("[cell clipped")
  expect(out).not.toContain("x".repeat(300))
  const check = await call("sql_execute", {
    warehouse: "scratch",
    query:
      "SELECT COUNT(*) AS n, SUM(id) AS total, COUNT(note) AS non_null, SUM(CASE WHEN note = '' THEN 1 ELSE 0 END) AS empty, " +
      "MIN(code) AS first_code, MAX(length(note)) AS longest, SUM(ratio) AS ratios, typeof(ANY_VALUE(code)) AS code_type FROM result_1",
  })
  // Text codes keep their leading zeros, NULL stays distinct from '', and long cells are whole.
  expect(body(check)).toContain("200 | 20100 | 134 | 67 | 001 | 308 | 2512.5 | VARCHAR")
  const longest = await call("sql_execute", {
    warehouse: "scratch",
    query: "SELECT note FROM result_1 WHERE id = 2",
  })
  expect(body(longest)).toContain('a,\\"b\\"\\nc ')
})

mcpTest("spill tables are numbered per session and skip a name the client already used", async () => {
  const { call } = await fixture(false, {}, undefined, spillRows)
  const created = await call("sql_materialize", {
    source_warehouse: "source",
    sql: "SELECT 1 AS taken",
    target_table: "result_2",
  })
  expect(created.isError).toBe(false)
  const first = body(await call("sql_execute", { warehouse: "source", query: "SELECT * FROM events", limit: 500 }))
  const second = body(await call("sql_execute", { warehouse: "source", query: "SELECT id FROM events", limit: 500 }))
  expect(first).toContain("scratch table result_1")
  expect(second).toContain("scratch table result_3")
  expect(body(await call("sql_execute", { warehouse: "scratch", query: "SELECT taken FROM result_2" }))).toContain("1")
})
// altimate_change end

// altimate_change start — compact tool definitions: re-sent with every model request
mcpTest("tool definitions stay compact and keep their required properties", async () => {
  const { client } = await fixture()
  const { tools } = await client.listTools()
  const size = (tool: (typeof tools)[number]) =>
    JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }).length
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
  expect(size(byName.answer_commit!)).toBeLessThanOrEqual(2_250)
  expect(byName.answer_commit!.description).toContain("'the repository and the most copied file' needs two")
  expect(tools.reduce((total, tool) => total + size(tool), 0)).toBeLessThan(7_000)
  expect(client.getInstructions()!.length).toBeLessThanOrEqual(723)
  const declared = JSON.stringify(tools)
  expect(declared).not.toContain("$schema")
  expect(declared).not.toContain('"const":""')
  expect(byName.answer_commit!.inputSchema.required).toEqual(["basis", "request"])
  expect(byName.sql_check!.inputSchema.required).toEqual(["warehouse", "check"])
  expect(byName.sql_materialize!.inputSchema.required).toEqual(["source_warehouse", "sql", "target_table"])
  // A nullable table cell keeps its null member; only optional-property fillers collapse.
  expect(JSON.stringify(byName.answer_commit!.inputSchema.properties!.rows)).toContain('{"type":"null"}')
})

mcpTest("strict-schema filler values are still accepted after the schema is compacted", async () => {
  const { call } = await fixture()
  const executed = await call("sql_execute", {
    warehouse: "source",
    query: "SELECT name FROM items WHERE id = 1",
    queries: null,
    query_from: null,
    full_text_columns: [],
  })
  expect(executed.isError).toBe(false)
  expect(body(executed)).toContain("apple")
  const committed = await call("answer_commit", {
    fields: [{ name: "", value: "apple", units: "", precision: null }],
    rows: null,
    unresolved: {},
    asked: [],
    readings: [],
    answer_only: "",
    basis: "Read items.name for id 1.",
    request: "Which item has id 1?",
  })
  expect(committed.isError).toBeFalsy()
  expect(body(committed)).toContain("FINAL ANSWER: apple")
})
// altimate_change end

// altimate_change start — warehouse_list discovery: local tables with columns and a sample in one call
mcpTest("warehouse_list lists local tables with columns and one sample row", async () => {
  const { call } = await fixture(false, {}, undefined, (db) => {
    db.run("CREATE VIEW item_names AS SELECT name FROM items")
  })
  const out = body(await call("warehouse_list", {}))
  expect(out).toContain("source: main.items (2 rows): id INTEGER, name TEXT")
  expect(out).toMatch(/source: main\.items[^\n]*\n {2}e\.g\. 1 \| apple/)
  // Views are listed but never sampled: a view may run arbitrary work.
  expect(out).toMatch(/source: main\.item_names: name/)
  expect(out).not.toMatch(/item_names[^\n]*\n {2}e\.g\./)
})

mcpTest("warehouse_list runs no discovery queries on remote connections", async () => {
  const { call } = await fixture()
  Registry.setConfigs({ remote: { type: "postgres", host: "db.example.com", database: "app" } })
  const original = Dispatcher.call
  const methods: string[] = []
  const dispatch = spyOn(Dispatcher, "call").mockImplementation(async (method, args, context) => {
    methods.push(method)
    return original(method, args, context)
  })
  const get = spyOn(Registry, "get")
  try {
    const out = body(await call("warehouse_list", {}))
    expect(out).toContain("remote | postgres")
    expect(out).not.toContain("remote:")
    expect(methods.filter((method) => method !== "warehouse.list")).toEqual([])
    expect(get).not.toHaveBeenCalled()
  } finally {
    dispatch.mockRestore()
    get.mockRestore()
  }
})

mcpTest("warehouse_list skips table detail for a catalog over the table budget", async () => {
  const { call } = await fixture(false, {}, undefined, (db) => {
    for (let i = 0; i < 45; i++) db.run(`CREATE TABLE t${i} (id INTEGER)`)
  })
  const out = body(await call("warehouse_list", {}))
  expect(out).toContain("source: catalog too large to list here; use schema_inspect.")
  expect(out).not.toContain("main.t1")
})

mcpTest("warehouse_list discovery stops starting calls once its deadline passes", async () => {
  const { call } = await fixture(false, {}, undefined, (db) => {
    for (let i = 0; i < 6; i++) db.run(`CREATE TABLE slow${i} (id INTEGER)`)
  })
  const original = Dispatcher.call
  let inspections = 0
  const dispatch = spyOn(Dispatcher, "call").mockImplementation(async (method, args, context) => {
    if (method === "schema.inspect") {
      inspections++
      await Bun.sleep(1_500)
    }
    return original(method, args, context)
  })
  try {
    const started = Date.now()
    const out = body(await call("warehouse_list", {}))
    expect(Date.now() - started).toBeLessThan(7_000)
    expect(inspections).toBeLessThanOrEqual(3)
    expect(out).toContain("More tables or connections exist than shown")
  } finally {
    dispatch.mockRestore()
  }
}, 15_000)
// altimate_change end

// altimate_change start — compact MCP output: CSV spills, no rule lines, hints once, short receipts
mcpTest("an MCP spill file is CSV with the column names once and NULL distinct from an empty string", async () => {
  const { call } = await fixture(false, {}, undefined, spillRows)
  const result = await call("sql_execute", {
    warehouse: "source",
    query: "SELECT id, code, note FROM events WHERE id <= 3 ORDER BY id",
    full_text_columns: ["note"],
  })
  const file = body(result).match(/(\/[^\s`()]+\/result-1\.csv)/)?.[1]
  expect(file).toBeDefined()
  const csv = await readFile(file!, "utf8")
  const lines = csv.split("\n")
  expect(lines[0]).toBe("id,code,note")
  expect(lines[1]).toBe('1,001,""')
  expect(lines[2]).toBe(`2,002,"a,""b""`)
  expect(csv).toContain(`\n3,003,\n`)
  expect(csv.match(/id,code,note/g)).toHaveLength(1)
})

mcpTest("MCP inline results, listings and receipts drop the rule line and repeat no tutorial", async () => {
  const { call } = await fixture(false, {}, undefined, spillRows)
  const inline = body(await call("sql_execute", { warehouse: "source", query: "SELECT id, name FROM items ORDER BY id" }))
  expect(inline).toBe("id | name\n1 | apple\n2 | pear\n\n(2 rows)")
  expect(body(await call("warehouse_list", {}))).not.toMatch(/^-+\|/m)
  const first = body(await call("sql_execute", { warehouse: "source", query: "SELECT * FROM events", limit: 500 }))
  const second = body(await call("sql_execute", { warehouse: "source", query: "SELECT id FROM events", limit: 500 }))
  expect(first).toContain("instead of reading the file")
  expect(second).not.toContain("instead of reading the file")
  expect(second).toContain("All 200 returned rows are in scratch table result_2 (CSV copy:")
  const sql = "SELECT id, code FROM events WHERE id < 5"
  const made = body(await call("sql_materialize", { source_warehouse: "source", sql, target_table: "small" }))
  expect(made).toStartWith("scratch.small: 4 rows, 2 columns (create) from source.\nColumns: id BIGINT, code VARCHAR")
  expect(made).not.toContain(sql)
  expect(made).toContain("Join it in scratch")
  const again = body(
    await call("sql_materialize", { source_warehouse: "source", sql, target_table: "small", mode: "replace" }),
  )
  expect(again).not.toContain("Join it in scratch")
})
// altimate_change end

// altimate_change start — setup from zero: no connections file, then a file or warehouse_add
async function emptyProject(env: Record<string, string> = {}) {
  const project = await mkdtemp(path.join(os.tmpdir(), "mcp-empty-project-"))
  const previous = process.cwd()
  const saved: Record<string, string | undefined> = {}
  // Ambient connection variables would make the empty-registry assertions depend on the caller's shell.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(Registry.CONN_ENV_PREFIX) || key in env) saved[key] = process.env[key]
    if (key.startsWith(Registry.CONN_ENV_PREFIX)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(env)) {
    saved[key] ??= process.env[key]
    process.env[key] = value
  }
  process.chdir(project)
  Registry.reset()
  const db = new Database(path.join(project, "store.sqlite"))
  db.run("CREATE TABLE fruit (id INTEGER, name TEXT)")
  db.run("INSERT INTO fruit VALUES (1, 'fig')")
  db.close()
  const server = await createServer({})
  const client = new Client({ name: "test", version: "1" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  cleanups.push(async () => {
    await client.close()
    await server.close()
    await Registry.closeAll()
    process.chdir(previous)
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    // warehouse_add writes the (test-isolated) global file; later tests must not see it.
    await rm(Registry.globalConfigPath(), { force: true })
    await rm(project, { recursive: true, force: true })
  })
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args })
    return { result, body: (result.content as { text?: string }[]).map((part) => part.text ?? "").join("\n") }
  }
  return { project, call }
}

mcpTest("an empty registry names the real config paths and sees a connections file written afterwards", async () => {
  const { project, call } = await emptyProject()
  const first = await call("warehouse_list", {})
  expect(first.body).toContain("No warehouse connections configured.")
  expect(first.body).toContain(Registry.localConfigPath())
  expect(first.body).toContain(Registry.globalConfigPath())
  expect(first.body).toContain(Registry.CONN_ENV_PREFIX)
  expect(first.body).not.toContain(".opencode/connections.json")
  await Bun.write(
    path.join(project, ".altimate-code", "connections.json"),
    JSON.stringify({ local: { type: "sqlite", path: path.join(project, "store.sqlite") } }),
  )
  const second = await call("warehouse_list", {})
  expect(second.body).toContain("local | sqlite")
  const rows = await call("sql_execute", { warehouse: "local", query: "SELECT name FROM fruit" })
  expect(rows.result.isError).toBe(false)
  expect(rows.body).toContain("fig")
})

mcpTest("warehouse_add from an empty registry makes the connection queryable", async () => {
  const { project, call } = await emptyProject()
  const added = await call("warehouse_add", {
    name: "added",
    config: { type: "sqlite", path: path.join(project, "store.sqlite") },
  })
  expect(added.result.isError).toBe(false)
  expect(added.body).toContain("Call warehouse_list")
  expect(added.body).not.toMatch(/warehouse_test|sql_analyze|lineage_check/)
  expect((await call("warehouse_list", {})).body).toContain("added | sqlite")
  // A writable store keeps its configured mode.
  expect(Registry.getConfig("added")?.readonly).toBeUndefined()
  const rows = await call("sql_execute", { warehouse: "added", query: "SELECT name FROM fruit" })
  expect(rows.result.isError).toBe(false)
  expect(rows.body).toContain("fig")
})

mcpTest("an empty registry lists detected connection candidates by type and source, never their values", async () => {
  const { call } = await emptyProject({ SNOWFLAKE_ACCOUNT: "acct-value-xyz", SNOWFLAKE_PASSWORD: "secret-value-xyz" })
  const { body } = await call("warehouse_list", {})
  expect(body).toContain("snowflake from environment variable SNOWFLAKE_ACCOUNT")
  expect(body).not.toContain("acct-value-xyz")
  expect(body).not.toContain("secret-value-xyz")
})
// altimate_change end

// altimate_change start — read-only MCP sessions cannot create a store through warehouse_add
mcpTest("warehouse_add refuses create:true in a read-only session and creates no file", async () => {
  const { project, call } = await emptyProject()
  const target = path.join(project, "new.duckdb")
  const added = await call("warehouse_add", { name: "fresh", config: { type: "duckdb", path: target, create: true } })
  expect(added.body).toContain("read-only")
  expect((await call("warehouse_list", {})).body).not.toContain("fresh")
  expect(await Bun.file(target).exists()).toBe(false)
})
// altimate_change end

// altimate_change start — a read-only session opens added file stores read-only (read-only files and directories work)
mcpTest("warehouse_add of a SQLite file this process cannot write opens it read-only so it can be queried", async () => {
  const { project, call } = await emptyProject()
  const locked = path.join(project, "locked")
  await mkdir(locked)
  const store = path.join(locked, "ro.sqlite")
  const db = new Database(store)
  db.run("CREATE TABLE fruit (id INTEGER, name TEXT)")
  db.run("INSERT INTO fruit VALUES (1, 'quince')")
  db.close()
  await chmod(store, 0o444)
  await chmod(locked, 0o555)
  cleanups.push(() => chmod(locked, 0o755))
  const added = await call("warehouse_add", { name: "ro", config: { type: "sqlite", path: store } })
  expect(added.result.isError).toBe(false)
  const rows = await call("sql_execute", { warehouse: "ro", tables: ["fruit"], query: "SELECT name FROM fruit" })
  expect(rows.body).not.toContain("readonly database")
  expect(rows.result.isError).toBe(false)
  expect(rows.body).toContain("quince")
})
// altimate_change end
