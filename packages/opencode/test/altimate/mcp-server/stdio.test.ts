// altimate_change start — standalone MCP policy and middleware regressions
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Database } from "bun:sqlite"

const CLI_ENTRY = path.resolve(import.meta.dir, "../../../src/index.ts")

// Minimal newline-delimited JSON-RPC client over the child's stdio. The full suite shares one Bun process and
// test/mcp/* mock the MCP SDK client modules (never restored), so using the SDK here would talk to those mocks.
function rpcClient(child: ReturnType<typeof Bun.spawn>) {
  const pending = new Map<number, (message: any) => void>()
  let id = 0
  void (async () => {
    let buffer = ""
    for await (const chunk of child.stdout as unknown as AsyncIterable<Uint8Array>) {
      buffer += Buffer.from(chunk).toString()
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        const message = JSON.parse(line)
        pending.get(message.id)?.(message)
      }
    }
  })()
  const write = (message: object) => (child.stdin as import("bun").FileSink).write(JSON.stringify(message) + "\n")
  const request = (method: string, params: object = {}) =>
    new Promise<any>((resolve, reject) => {
      const n = ++id
      pending.set(n, (message) => (message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)))
      write({ jsonrpc: "2.0", id: n, method, params })
    })
  return {
    async connect() {
      await request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "stdio-test", version: "1" } })
      write({ jsonrpc: "2.0", method: "notifications/initialized" })
    },
    listTools: () => request("tools/list"),
    callTool: (params: { name: string; arguments: object }) => request("tools/call", params),
    async close() {
      ;(child.stdin as import("bun").FileSink).end()
      await child.exited
    },
  }
}

for (const allowWrite of [false, true]) {
  test(`CLI stdio handshake, read and write policy (allow-write=${allowWrite})`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mcp-stdio-test-"))
    const db = new Database(path.join(dir, "db.sqlite"))
    db.run("CREATE TABLE items (id INTEGER)")
    db.close()
    const connections = path.join(dir, "connections.json")
    await Bun.write(connections, JSON.stringify({ source: { type: "sqlite", path: "db.sqlite" } }))
    // Any network attempt, including module initialization, fails this test. stdout must contain only MCP frames.
    // The guard is an entry wrapper, not `--preload`: the package bunfig.toml `preload` replaces a CLI one.
    const guard = path.join(dir, "no-network.ts")
    await Bun.write(
      guard,
      'globalThis.fetch = (() => { process.stderr.write("UNEXPECTED_NETWORK_CALL\\n"); throw new Error("No network allowed") }) as typeof fetch\n' +
        `process.stderr.write("NETWORK_GUARD_ACTIVE\\n")\nawait import(${JSON.stringify(CLI_ENTRY)})\n`,
    )
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        "--conditions=browser",
        guard,
        "mcp",
        "serve",
        "--connections",
        connections,
        ...(allowWrite ? ["--allow-write"] : []),
      ],
      {
        cwd: path.resolve(import.meta.dir, "../../.."),
        env: { ...process.env, ALTIMATE_TELEMETRY_DISABLED: "1" },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    let stderr = ""
    void (async () => {
      for await (const chunk of child.stderr as unknown as AsyncIterable<Uint8Array>) stderr += Buffer.from(chunk).toString()
    })()
    const client = rpcClient(child)
    let spill: string | undefined
    try {
      await client.connect()
      expect((await client.listTools()).tools).toHaveLength(12)
      const write = await client.callTool({
        name: "sql_execute",
        arguments: { warehouse: "source", query: "INSERT INTO items VALUES (7)" },
      })
      expect(write.isError).toBe(!allowWrite)
      const read = await client.callTool({
        name: "sql_execute",
        arguments: {
          warehouse: "source",
          query: "SELECT CASE WHEN COUNT(*) = 1 THEN 'one inserted item' ELSE 'empty source' END AS value FROM items",
        },
      })
      expect(read.isError).toBe(false)
      expect(JSON.stringify(read.content)).toContain(allowWrite ? "one inserted item" : "empty source")
      const output = await client.callTool({
        name: "sql_execute",
        arguments: { warehouse: "source", query: "SELECT 'private server output' AS value", full_text_columns: ["value"] },
      })
      spill = JSON.stringify(output.content).match(/(\/[^\s`"\\()]+\/result-\d+\.csv)/)?.[1]
      expect(spill).toBeDefined()
      expect(await Bun.file(spill!).exists()).toBe(true)
    } finally {
      await client.close()
      if (spill) expect(await Bun.file(spill).exists()).toBe(false)
      await rm(dir, { recursive: true, force: true })
    }
    expect(stderr).toContain("NETWORK_GUARD_ACTIVE")
    expect(stderr).not.toContain("UNEXPECTED_NETWORK_CALL")
  }, 15_000)
}

test("CLI exits cleanly when the client closes stdin", async () => {
  const process = Bun.spawn([Bun.which("bun")!, "run", "--conditions=browser", "src/index.ts", "mcp", "serve"], {
    cwd: path.resolve(import.meta.dir, "../../.."),
    env: { ...Bun.env, ALTIMATE_TELEMETRY_DISABLED: "1" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  process.stdin.end()
  try {
    expect(await process.exited).toBe(0)
    expect(await new Response(process.stdout).text()).toBe("")
    expect(await new Response(process.stderr).text()).toBe("")
  } finally {
    process.kill()
  }
}, 15_000)

test("global --log-level and --integrations apply to mcp serve", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcp-stdio-flags-"))
  // Runs at exit, after the CLI middleware: logs through the same shim instance and reports the integrations mode.
  const probe = path.join(dir, "probe.ts")
  const shim = path.resolve(import.meta.dir, "../../../src/altimate/util/log.ts")
  await Bun.write(
    probe,
    `import { Log } from ${JSON.stringify(shim)}\n` +
      `process.on("exit", () => { Log.Default.info("probe-info-line"); Log.Default.error("probe-error-line"); ` +
      `require("node:fs").writeSync(2, "integrations=" + process.env.ALTIMATE_INTEGRATIONS + "\\n") })\n` +
      `await import(${JSON.stringify(CLI_ENTRY)})\n`,
  )
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "--conditions=browser",
      probe,
      "mcp",
      "serve",
      "--print-logs",
      "--log-level",
      "ERROR",
      "--integrations",
      "local",
    ],
    {
      cwd: path.resolve(import.meta.dir, "../../.."),
      env: { ...process.env, ALTIMATE_TELEMETRY_DISABLED: "1", ALTIMATE_LOG_LEVEL: "", OPENCODE_LOG_LEVEL: "" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  child.stdin.end()
  try {
    expect(await child.exited).toBe(0)
    const stderr = await new Response(child.stderr).text()
    expect(stderr).toContain("integrations=local")
    expect(stderr).toContain("probe-error-line")
    expect(stderr).not.toContain("probe-info-line")
  } finally {
    child.kill()
    await rm(dir, { recursive: true, force: true })
  }
}, 15_000)

// altimate_change end

// altimate_change start — execute the entrypoint's actual middleware without launching agent services
// Exercise the guard directly too, so deleting it fails deterministically even
// when the stdio child exits while the CLI is still unwinding.
test("mcp serve skips CLI middleware before starting the agent heap service", async () => {
  const source = await Bun.file(path.resolve(import.meta.dir, "../../../src/index.ts")).text()
  const opening = ".middleware(async (opts) => {"
  const start = source.indexOf(opening)
  const end = source.indexOf("\n  })\n  .usage", start)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  const body = source.slice(start + opening.length, end)
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(`async function middleware(opts: any) {${body}\n}`)
  let starts = 0
  const middleware = new Function("Heap", `${code}; return middleware`)({
    start() {
      starts++
      throw new Error("Agent heap initialization reached by MCP server")
    },
  })
  await middleware({ _: ["mcp", "serve"] })
  expect(starts).toBe(0)
})
// altimate_change end
