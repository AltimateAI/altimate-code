import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const entry = path.join(import.meta.dir, "../../../src/index.ts")

async function cli(args: string[], stdin?: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "tool-cli-"))
  const input = stdin === undefined ? "ignore" : Bun.file(path.join(dir, "stdin.json"))
  if (stdin !== undefined) await writeFile(path.join(dir, "stdin.json"), stdin)
  const proc = Bun.spawn([process.execPath, "--conditions=browser", entry, ...args], {
    cwd: dir,
    stdin: input,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ALTIMATE_TELEMETRY_DISABLED: "1", ALTIMATE_TOOL_DAEMON: "0" },
  })
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { stdout, code }
}

describe("tool CLI", () => {
  // A here-doc gives the process a file on stdin rather than a pipe.
  test("reads --args - from a file on stdin", async () => {
    const { stdout, code } = await cli(["tool", "run", "sql_format", "--args", "-", "--json"], '{"sql":"select a from t"}')
    expect(code).toBe(0)
    expect(JSON.parse(stdout).output).toBe("SELECT a FROM t")
  }, 60000)

  test("rejects --args - with empty stdin", async () => {
    const { stdout, code } = await cli(["tool", "run", "sql_format", "--args", "-", "--json"], "")
    expect(code).toBe(1)
    expect(JSON.parse(stdout).output).toStartWith("--args - was given but stdin is empty.")
  }, 60000)

  test("schema prints one tool", async () => {
    const { stdout, code } = await cli(["tool", "schema", "sql_execute"])
    expect(code).toBe(0)
    const tool = JSON.parse(stdout)
    expect(tool.id).toBe("sql_execute")
    expect(Object.keys(tool.inputSchema.properties)).toContain("query")
  }, 60000)

  // A daemon that kept a DuckDB file open would block `dbt build` and every other client.
  test("the daemon releases a DuckDB file between calls", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tool-cli-lock-"))
    const file = path.join(dir, "warehouse.duckdb")
    await mkdir(path.join(dir, ".altimate-code"))
    await writeFile(path.join(dir, ".altimate-code", "connections.json"), JSON.stringify({ wh: { type: "duckdb", path: file, create: true } }))
    const env = { ...process.env, ALTIMATE_TELEMETRY_DISABLED: "1", ALTIMATE_TOOL_DAEMON_IDLE_MS: "30000" }
    const run = (...args: string[]) =>
      Bun.spawn([process.execPath, "--conditions=browser", entry, "tool", ...args], { cwd: dir, env, stdout: "pipe", stderr: "pipe" })
    try {
      // The first call may fall back in-process while the daemon starts; the second goes through it.
      for (const query of ["select 1 as one", "select 2 as two"]) {
        const proc = run("run", "sql_execute", "--args", JSON.stringify({ warehouse: "wh", query }), "--json")
        expect(JSON.parse(await new Response(proc.stdout).text()).status).toBe("ok")
      }
      const status = run("daemon", "status")
      expect(await status.exited).toBe(0)
      const script = `const duckdb = require("duckdb"); new duckdb.Database(process.argv[1], (err) => process.exit(err ? 1 : 0))`
      const other = Bun.spawn([process.execPath, "-e", script, file], { cwd: import.meta.dir, stdout: "ignore", stderr: "ignore" })
      expect(await other.exited).toBe(0)
    } finally {
      await run("daemon", "stop").exited
    }
  }, 90000)

  test("--connections uses only the given file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tool-cli-conns-"))
    await mkdir(path.join(dir, ".altimate-code"))
    await writeFile(path.join(dir, ".altimate-code", "connections.json"), JSON.stringify({ project_wh: { type: "duckdb", path: "p.duckdb", create: true } }))
    await writeFile(path.join(dir, "only.json"), JSON.stringify({ only_wh: { type: "duckdb", path: "o.duckdb", create: true } }))
    const proc = Bun.spawn(
      [process.execPath, "--conditions=browser", entry, "tool", "run", "warehouse_list", "--connections", "only.json", "--no-daemon"],
      { cwd: dir, env: { ...process.env, ALTIMATE_TELEMETRY_DISABLED: "1" }, stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(code).toBe(0)
    expect(stdout).toContain("only_wh")
    expect(stdout).not.toContain("project_wh")
  }, 60000)

  test("ALTIMATE_TOOL_CONNECTIONS supplies --connections", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tool-cli-conns-env-"))
    await writeFile(path.join(dir, "only.json"), JSON.stringify({ env_wh: { type: "duckdb", path: "e.duckdb", create: true } }))
    const proc = Bun.spawn([process.execPath, "--conditions=browser", entry, "tool", "run", "warehouse_list", "--no-daemon"], {
      cwd: dir,
      env: { ...process.env, ALTIMATE_TELEMETRY_DISABLED: "1", ALTIMATE_TOOL_CONNECTIONS: path.join(dir, "only.json") },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(code).toBe(0)
    expect(stdout).toContain("env_wh")
  }, 60000)
})

describe("tool CLI parity with mcp serve", () => {
  const env = { ...process.env, ALTIMATE_TELEMETRY_DISABLED: "1", ALTIMATE_TOOL_DAEMON: "0" }
  async function fixtureDir() {
    const dir = await mkdtemp(path.join(tmpdir(), "tool-cli-parity-"))
    await writeFile(path.join(dir, "c.json"), JSON.stringify({ wh: { type: "duckdb", path: "w.duckdb", create: true } }))
    return dir
  }
  async function out(dir: string, args: string[]) {
    const proc = Bun.spawn([process.execPath, "--conditions=browser", entry, ...args], { cwd: dir, env, stdout: "pipe", stderr: "pipe" })
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    return { stdout, code }
  }

  test("tool run sql_execute accepts tables and fuses schema with the query", async () => {
    const dir = await fixtureDir()
    await out(dir, ["tool", "run", "sql_execute", "--connections", "c.json", "--no-daemon", "--allow-write", "--args", JSON.stringify({ warehouse: "wh", query: "create table pets (id integer, name varchar)" })])
    await out(dir, ["tool", "run", "sql_execute", "--connections", "c.json", "--no-daemon", "--allow-write", "--args", JSON.stringify({ warehouse: "wh", query: "insert into pets values (1, 'rex')" })])
    const { stdout, code } = await out(dir, [
      "tool", "run", "sql_execute", "--connections", "c.json", "--no-daemon", "--json",
      "--args", JSON.stringify({ warehouse: "wh", tables: ["pets"], query: "select name from pets" }),
    ])
    expect(code).toBe(0)
    const result = JSON.parse(stdout)
    expect(result.status).toBe("ok")
    expect(result.output).toContain("pets")
    expect(result.output).toContain("rex")
  }, 90000)

  test("tool context prints the analyst method and the connection names", async () => {
    const dir = await fixtureDir()
    const text = await out(dir, ["tool", "context", "--connections", "c.json"])
    expect(text.code).toBe(0)
    expect(text.stdout).toContain("Analyst method for data questions")
    expect(text.stdout).toContain("wh (duckdb)")
    const json = JSON.parse((await out(dir, ["tool", "context", "--connections", "c.json", "--json"])).stdout)
    expect(json.connections.map((c: { name: string }) => c.name)).toContain("wh")
    expect(json.instructions).toContain("Connections:")
  }, 90000)

  test("tool list and mcp serve advertise the same ids for the same flags", async () => {
    const dir = await fixtureDir()
    const { createServer } = await import("../../../src/altimate/mcp-server/server")
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js")
    const mcpIds = async (allTools: boolean) => {
      const server = await createServer({ connections: path.join(dir, "c.json"), allTools })
      const client = new Client({ name: "t", version: "1" })
      const [a, b] = InMemoryTransport.createLinkedPair()
      await server.connect(b)
      await client.connect(a)
      const ids = (await client.listTools()).tools.map((tool) => tool.name).sort()
      await client.close()
      await server.close()
      return ids
    }
    const cliIds = JSON.parse((await out(dir, ["tool", "list", "--json", "--connections", "c.json"])).stdout)
      .map((tool: { id: string }) => tool.id)
      .sort()
    // The CLI exposes the whole allow-list, which is what `mcp serve --all-tools` advertises.
    expect(await mcpIds(true)).toEqual(cliIds)
    const defaults = await mcpIds(false)
    expect(defaults).toContain("impact_analysis")
    expect(defaults).toContain("sql_execute")
    expect(defaults).not.toContain("sql_check")
    for (const id of defaults) expect(cliIds).toContain(id)
  }, 120000)
})
