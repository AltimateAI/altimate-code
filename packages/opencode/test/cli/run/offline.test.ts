import { afterAll, beforeAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { gitCommandUsesNetwork } from "@opencode-ai/core/git"

const CLI = path.resolve(import.meta.dir, "../../../src/index.ts")
const MODEL_ENDPOINT = "http://model.test:9000/v1"
const API = "https://workspace.test"
const TENANT = "offline-fixture"
const KEY = "fixture-key"
const SKILL = "This unique statement came from the cached offline skill."

// Egress that does not go through fetch: every proxy variable points at a proxy that records and refuses each
// request, and PATH shims record each run of a program that can reach the network.
const proxyHits: string[] = []
let denyProxy: net.Server
let PROXY = ""
const SHIMMED = ["git", "npm", "npx", "pnpm", "yarn", "dbt", "pip", "pip3", "uv", "curl", "wget", "ssh", "gh"]
const REAL = Object.fromEntries(SHIMMED.map((name) => [name, Bun.which(name)]))

beforeAll(async () => {
  denyProxy = net.createServer((socket) => {
    socket.on("error", () => {})
    socket.once("data", (chunk) => {
      proxyHits.push(chunk.toString("latin1").split("\r\n")[0])
      socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n")
    })
  })
  await new Promise<void>((resolve) => denyProxy.listen(0, "127.0.0.1", resolve))
  PROXY = `http://127.0.0.1:${(denyProxy.address() as net.AddressInfo).port}`
})
afterAll(() => denyProxy?.close())

async function writeShims(dir: string, log: string) {
  await fs.mkdir(dir, { recursive: true })
  for (const name of SHIMMED) {
    const real = REAL[name]
    await Bun.write(
      path.join(dir, name),
      `#!/bin/sh\nprintf "%s\\n" "${name} $*" >> "${log}"\n${real ? `exec "${real}" "$@"` : "exit 127"}\n`,
    )
    await fs.chmod(path.join(dir, name), 0o755)
  }
}

/** Programs that reached the network: any non-git network tool, or a git command that uses a remote. */
async function networkSpawns(log: string) {
  const lines = (await fs.readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean)
  return lines.filter((line) => {
    const [name, ...args] = line.split(" ")
    return name !== "git" || gitCommandUsesNetwork(args)
  })
}

async function fixture(
  snapshot: boolean,
  configMode: boolean,
  disableWorkspace: boolean,
  provider = "offline-test",
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "altimate-offline-"))
  const project = path.join(root, "project")
  const config = path.join(root, "config", "altimate-code")
  const data = path.join(root, "data", "altimate-code")
  const calls = path.join(root, "calls.jsonl")
  const preload = path.join(root, "preload.ts")
  const blocked = path.join(root, "blocked.jsonl")
  const shims = path.join(root, "shims")
  const spawns = path.join(root, "spawns.log")
  await writeShims(shims, spawns)
  await Promise.all([fs.mkdir(project), fs.mkdir(config, { recursive: true }), fs.mkdir(data, { recursive: true })])
  await Bun.write(
    path.join(config, "altimate-code.json"),
    JSON.stringify({
      model: `${provider}/fixture`,
      provider: {
        [provider]: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: MODEL_ENDPOINT, apiKey: "local-only" },
          models: { fixture: { name: "Offline fixture", limit: { context: 100000, output: 2000 } } },
        },
      },
      mcp: { remoteFixture: { type: "remote", url: "https://mcp.test" } },
    }),
  )
  if (configMode && !snapshot)
    await Bun.write(path.join(project, "opencode.jsonc"), '{ // local policy\n "offline": true }')
  await Bun.write(
    path.join(data, "auth.json"),
    JSON.stringify({
      "https://remote-config.test": { type: "wellknown", key: "FIXTURE_TOKEN", token: "fixture" },
    }),
  )
  await Bun.write(
    path.join(root, ".altimate", "altimate.json"),
    JSON.stringify({
      altimateUrl: API,
      altimateInstanceName: TENANT,
      altimateApiKey: KEY,
    }),
  )
  const snapshotRoot = path.join(project, ".altimate-code", "skill", "_workspace")
  const manifest = path.join(snapshotRoot, ".manifest.json")
  const skill = path.join(snapshotRoot, "sk_local", "SKILL.md")
  if (snapshot) {
    await Bun.write(
      manifest,
      JSON.stringify({
        version: 2,
        tenant: TENANT,
        apiUrl: API,
        datamateId: 1,
        account: createHash("sha256").update(`${API}|${TENANT}|${KEY}`).digest("hex"),
        skills: { sk_local: { updatedAt: "x", files: {} } },
      }),
    )
    await Bun.write(
      skill,
      `---\nname: cached-offline\ndescription: Offline fixture skill\nalwaysApply: true\n---\n${SKILL}\n`,
    )
  }

  await Bun.write(
    preload,
    `
    import { appendFileSync } from "node:fs"
    const log = ${JSON.stringify(calls)}
    let turn = 0
    globalThis.fetch = Object.assign(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      appendFileSync(log, JSON.stringify({ url, hasSkill: String(init?.body).includes(${JSON.stringify(SKILL)}) }) + "\\n")
      if (url !== ${JSON.stringify(MODEL_ENDPOINT + "/chat/completions")}) {
        return new Response("{}", { status: 503 })
      }
      const request = JSON.parse(String(init?.body ?? "{}"))
      const canRunShell = request.tools?.some((tool) => tool.function?.name === "bash")
      const chunks = process.env.OFFLINE_TEST_BASH && canRunShell && turn++ === 0
        ? [
            { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{
              index: 0, id: "call_shell", type: "function", function: {
                name: "bash",
                arguments: JSON.stringify({
                  command: 'printf "shell-ran:%s|%s|%s" "$NO_PROXY" "$HTTPS_PROXY" "$ALTIMATE_OFFLINE" > shell-marker',
                  description: "Write a local marker",
                  workdir: process.cwd(),
                  timeout: 5000,
                }),
              },
            }] }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          ]
        : [
        { choices: [{ index: 0, delta: { role: "assistant", content: "offline reply" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 2 } },
      ]
      return new Response(chunks.map((chunk) => "data: " + JSON.stringify(chunk) + "\\n\\n").join("") + "data: [DONE]\\n\\n",
        { headers: { "content-type": "text/event-stream" } })
    }, { preconnect() {} })
    let current = globalThis.fetch
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      get: () => current,
      set(next) {
        current = Object.assign(async (input, init) => {
          const url = input instanceof Request ? input.url : String(input)
          appendFileSync(${JSON.stringify(blocked)}, JSON.stringify(url) + "\\n")
          return next(input, init)
        }, { preconnect: next.preconnect })
      },
    })
  `,
  )
  const env = {
    PATH: `${shims}${path.delimiter}${process.env.PATH}`,
    ...Object.fromEntries(
      ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].map((key) => [key, PROXY]),
    ),
    HOME: root,
    OPENCODE_TEST_HOME: root,
    OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    ALTIMATE_OFFLINE: configMode ? "" : "1",
    ...(configMode && snapshot
      ? {
          OPENCODE_CONFIG_CONTENT: "{env:OFFLINE_CONFIG_VALUE}",
          OFFLINE_CONFIG_VALUE: JSON.stringify({ offline: true }),
        }
      : {}),
    // The environment switch must preserve the snapshot even when a deployment
    // still has the old workspace opt-out set.
    ALTIMATE_DISABLE_WORKSPACE: disableWorkspace ? "1" : "",
    ALTIMATE_CODE_DISABLE_OS_CREDENTIAL_STORE: "1",
    ALTIMATE_RUN_STDIN_WAIT_MS: "0",
    NO_COLOR: "1",
  }
  return { root, project, preload, env, calls, blocked, manifest, skill, shims, spawns }
}

for (const { scenario, snapshot, configMode, disableWorkspace } of [
  {
    scenario: "environment switch with the workspace opt-out",
    snapshot: true,
    configMode: false,
    disableWorkspace: true,
  },
  {
    scenario: "interpolated config switch with a cached snapshot",
    snapshot: true,
    configMode: true,
    disableWorkspace: false,
  },
  { scenario: "config switch without a snapshot", snapshot: false, configMode: true, disableWorkspace: false },
]) {
  test(`offline ${scenario} keeps network traffic on the model endpoint`, async () => {
    const f = await fixture(snapshot, configMode, disableWorkspace, snapshot ? "offline-test" : "openai")
    proxyHits.length = 0
    try {
      const before = snapshot ? await fs.readFile(f.manifest, "utf8") : undefined
      const proc = Bun.spawn([process.execPath, "--preload", f.preload, CLI, "run", "Hello"], {
        cwd: f.project,
        // The snapshot must work on a cold host where ripgrep is absent: PATH holds only the shims.
        env: snapshot ? { ...f.env, PATH: f.shims } : f.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.timeout(30_000),
      })
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      const payload = await fs.readFile(f.calls, "utf8").catch(() => "")
      const calls: { url: string; hasSkill: boolean }[] = payload
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      expect({ code, stderr, nonModelCalls: calls.filter((call) => call.url !== MODEL_ENDPOINT + "/chat/completions") }).toMatchObject({ code: 0, nonModelCalls: [] })
      expect(await fs.readFile(f.blocked, "utf8").catch(() => "")).toBe("")
      expect({ code, stdout, stderr }).toMatchObject({ code: 0, stdout: expect.stringContaining("offline reply") })
      expect(calls.length).toBeGreaterThan(0)
      expect(calls.some((call) => call.hasSkill)).toBe(snapshot)
      expect(stderr).not.toContain("Workspace skills not synced")
      // Nothing left through a proxy or a network program either.
      expect({ proxyHits, spawns: await networkSpawns(f.spawns) }).toEqual({ proxyHits: [], spawns: [] })
      if (snapshot) {
        expect(await fs.readFile(f.manifest, "utf8")).toBe(before!)
        expect(await fs.readFile(f.skill, "utf8")).toContain(SKILL)
      }
    } finally {
      await fs.rm(f.root, { recursive: true, force: true })
    }
  }, 40_000)
}

test("offline model can execute a local bash command", async () => {
  const f = await fixture(false, false, false)
  try {
    const proc = Bun.spawn([process.execPath, "--preload", f.preload, CLI, "run", "--yolo", "Run the local shell command"], {
      cwd: f.project,
      // The user's proxy settings reach their own commands; offline mode only adds the loopback hosts.
      env: { ...f.env, OFFLINE_TEST_BASH: "1", ALTIMATE_CLI_YOLO: "true", NO_PROXY: "corp.example" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(25_000),
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect({ code, stdout, stderr }).toMatchObject({ code: 0, stdout: expect.stringContaining("offline reply") })
    const marker = await Bun.file(path.join(f.project, "shell-marker")).text().catch(() => "")
    expect({ marker, stdout, stderr }).toMatchObject({ marker: `shell-ran:corp.example,localhost,127.0.0.1,[::1],0.0.0.0|${PROXY}|1` })
    expect(await fs.readFile(f.blocked, "utf8").catch(() => "")).toBe("")
  } finally {
    await fs.rm(f.root, { recursive: true, force: true })
  }
}, 30_000)

test("offline SQL tool queries a local DuckDB file", async () => {
  const f = await fixture(false, false, false)
  try {
    const database = path.join(f.project, "warehouse.duckdb")
    const connections = path.join(f.project, ".altimate-code", "connections.json")
    const writeConnection = (create = false) =>
      Bun.write(connections, JSON.stringify({ local: { type: "duckdb", path: database, create } }))
    const runSQL = async (query: string, allowWrite = false) => {
      const proc = Bun.spawn([
        process.execPath, "--preload", f.preload, CLI, "tool", "run", "sql_execute",
        ...(allowWrite ? ["--allow-write"] : []),
        "--args", JSON.stringify({ warehouse: "local", query }), "--json",
      ], {
        cwd: f.project,
        env: f.env,
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.timeout(25_000),
      })
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      return { code, stdout, stderr }
    }

    await writeConnection(true)
    const seed = await runSQL("create table fixture as select 42 as offline_answer", true)
    expect(seed).toMatchObject({ code: 0, stdout: expect.stringContaining('"status":"ok"') })
    expect(await Bun.file(database).exists()).toBe(true)
    await writeConnection()
    const { code, stdout, stderr } = await runSQL("select offline_answer from fixture")
    expect({ code, stdout, stderr }).toMatchObject({ code: 0, stdout: expect.stringContaining("offline_answer") })
    expect(JSON.parse(stdout).status).toBe("ok")
    expect(stdout).toContain("42")
    expect(await fs.readFile(f.calls, "utf8").catch(() => "")).toBe("")
    expect(await fs.readFile(f.blocked, "utf8").catch(() => "")).toBe("")
  } finally {
    await fs.rm(f.root, { recursive: true, force: true })
  }
}, 55_000)

test("offline SQL tool refuses a warehouse whose host is not loopback", async () => {
  const f = await fixture(false, false, false)
  try {
    await Bun.write(
      path.join(f.project, ".altimate-code", "connections.json"),
      JSON.stringify({ remote: { type: "postgres", host: "db.example.com", database: "analytics", user: "analyst" } }),
    )
    const proc = Bun.spawn([
      process.execPath, "--preload", f.preload, CLI, "tool", "run", "sql_execute",
      "--args", JSON.stringify({ warehouse: "remote", query: "select 1" }), "--json",
    ], { cwd: f.project, env: f.env, stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(25_000) })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited
    expect(stdout + stderr).toContain("Offline mode allows only local file databases and warehouses at a loopback host.")
    expect(await fs.readFile(f.calls, "utf8").catch(() => "")).toBe("")
    expect(await fs.readFile(f.blocked, "utf8").catch(() => "")).toBe("")
  } finally {
    await fs.rm(f.root, { recursive: true, force: true })
  }
}, 30_000)

test("offline attach accepts a server on this machine and refuses a remote one", async () => {
  const f = await fixture(false, false, false)
  try {
    const attach = async (url: string) => {
      const proc = Bun.spawn([process.execPath, "--preload", f.preload, CLI, "run", "--attach", url, "Hello"], {
        cwd: f.project,
        env: f.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.timeout(20_000),
      })
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      await proc.exited
      return stdout + stderr
    }
    expect(await attach("https://remote-server.test")).toContain("This command requires network access")
    // Nothing listens on port 9; the attempt fails on connection, not on the offline policy.
    expect(await attach("http://127.0.0.1:9")).not.toContain("This command requires network access")
    // The only requests made went to the local server.
    const requests = (await fs.readFile(f.blocked, "utf8").catch(() => "")).trim().split("\n").filter(Boolean)
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.filter((line) => !line.includes("http://127.0.0.1:9/"))).toEqual([])
  } finally {
    await fs.rm(f.root, { recursive: true, force: true })
  }
}, 45_000)

test("offline skill install refuses a remote repository before running git clone", async () => {
  const f = await fixture(false, false, false)
  const clone = path.join(f.root, "unexpected-clone")
  try {
    await fs.appendFile(
      f.preload,
      `
      const spawnSync = Bun.spawnSync
      Bun.spawnSync = (args, options) => {
        if (Array.isArray(args) && args[0] === "git" && args[1] === "clone") {
          appendFileSync(${JSON.stringify(clone)}, "git clone ran")
          return { exitCode: 1, stderr: Buffer.from("unexpected git clone") }
        }
        return spawnSync(args, options)
      }
    `,
    )
    await fs.rm(path.join(f.root, "data", "altimate-code", "auth.json"))
    const proc = Bun.spawn([process.execPath, "--preload", f.preload, CLI, "skill", "install", "example/skill"], {
      cwd: f.project,
      env: f.env,
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(20_000),
    })
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    expect(await Bun.file(clone).exists()).toBe(false)
    expect(code).toBe(1)
    expect(stderr).toContain("Install remote skills while online")
  } finally {
    await fs.rm(f.root, { recursive: true, force: true })
  }
}, 25_000)

test("offline mode launches a configured local language server", async () => {
  const f = await fixture(false, false, false)
  const marker = path.join(f.root, "unexpected-lsp")
  const stub = path.join(f.root, "language-server.ts")
  const server = path.resolve(import.meta.dir, "../../fixture/lsp/fake-lsp-server.js")
  const file = path.join(f.project, "test.offline-fixture")
  try {
    await fs.rm(path.join(f.root, "data", "altimate-code", "auth.json"))
    await Bun.write(file, "test")
    await Bun.write(stub, `await Bun.write(${JSON.stringify(marker)}, "server started"); await import(${JSON.stringify(server)})`)
    await Bun.write(
      path.join(f.project, "opencode.json"),
      JSON.stringify({ lsp: { fixture: { command: [process.execPath, stub], extensions: [".offline-fixture"] } } }),
    )
    const proc = Bun.spawn([process.execPath, "--preload", f.preload, CLI, "debug", "lsp", "diagnostics", file], {
      cwd: f.project,
      env: f.env,
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(45_000),
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect(await Bun.file(marker).exists()).toBe(true)
    expect({ code, stdout, stderr }).toMatchObject({ code: 0, stdout: expect.stringContaining("{}") })
  } finally {
    await fs.rm(f.root, { recursive: true, force: true })
  }
}, 50_000)

test("offline mode never falls back from a blank endpoint to the provider catalog URL", async () => {
  const f = await fixture(false, false, false)
  try {
    const configFile = path.join(f.root, "config", "altimate-code", "altimate-code.json")
    const config = await Bun.file(configFile).json()
    config.provider["offline-test"].options.baseURL = ""
    config.provider["offline-test"].api = "https://fallback-model.test/v1"
    await Bun.write(configFile, JSON.stringify(config))
    await fs.rm(path.join(f.root, "data", "altimate-code", "auth.json"))

    const proc = Bun.spawn([process.execPath, "--preload", f.preload, CLI, "run", "Hello"], {
      cwd: f.project,
      env: f.env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      signal: AbortSignal.timeout(20_000),
    })
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    expect(await fs.readFile(f.calls, "utf8").catch(() => "")).toBe("")
    expect(code).toBe(1)
    expect(stderr).toContain("offline-test")
  } finally {
    await fs.rm(f.root, { recursive: true, force: true })
  }
}, 25_000)

test.skipIf(process.platform === "win32")(
  "offline integration detection and review import never launch gh",
  async () => {
    const f = await fixture(false, false, false)
    const bin = path.join(f.root, "bin")
    const ghCalls = path.join(f.root, "gh-calls")
    try {
      await fs.mkdir(bin)
      const gh = path.join(bin, "gh")
      await Bun.write(gh, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$OFFLINE_TEST_GH_CALLS"\nprintf "fixture\\n"\n')
      await fs.chmod(gh, 0o755)
      await fs.rm(path.join(f.root, "data", "altimate-code", "auth.json"))
      for (const args of [
        ["integrations", "detect"],
        ["learn", "import-reviews", "--repo", "example/project", "--dry-run"],
      ]) {
        const proc = Bun.spawn([process.execPath, "--preload", f.preload, CLI, ...args], {
          cwd: f.project,
          env: { ...f.env, PATH: bin, OFFLINE_TEST_GH_CALLS: ghCalls },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
          signal: AbortSignal.timeout(20_000),
        })
        const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
        expect(await Bun.file(ghCalls).exists()).toBe(false)
        expect(code).toBe(1)
        expect(stderr).toContain("This command requires network access")
      }
    } finally {
      await fs.rm(f.root, { recursive: true, force: true })
    }
  },
  45_000,
)

test.skipIf(process.platform === "win32")(
  "offline skill validation runs local paired tools",
  async () => {
    const f = await fixture(true, false, false)
    const bin = path.join(f.root, "bin")
    const marker = path.join(f.root, "paired-tool-ran")
    try {
      await fs.rm(path.join(f.root, "data", "altimate-code", "auth.json"))
      await fs.mkdir(bin)
      const tool = path.join(bin, "fixture-tool")
      await Bun.write(tool, '#!/bin/sh\nprintf "paired executable ran\\n" > "$OFFLINE_TEST_TOOL_MARKER"\n')
      await fs.chmod(tool, 0o755)
      await fs.appendFile(f.skill, "\nTools used: `fixture-tool`\n")
      const proc = Bun.spawn([process.execPath, "--preload", f.preload, CLI, "skill", "test", "cached-offline"], {
        cwd: f.project,
        env: { ...f.env, PATH: bin, OFFLINE_TEST_TOOL_MARKER: marker },
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.timeout(20_000),
      })
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      // A local executable is the user's own program: offline mode runs it like any other.
      expect(await Bun.file(marker).exists()).toBe(true)
      expect({ code, stdout, stderr }).toMatchObject({ code: 0, stdout: expect.stringContaining("fixture-tool") })
      expect(stdout).not.toContain("online mode")
    } finally {
      await fs.rm(f.root, { recursive: true, force: true })
    }
  },
  25_000,
)

test("standalone MCP initializes offline over stdio without network requests", async () => {
  const f = await fixture(false, true, false)
  try {
    const proc = Bun.spawn([process.execPath, "--preload", f.preload, CLI, "mcp", "serve"], {
      cwd: f.project,
      env: f.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(30_000),
    })
    const stderr = new Response(proc.stderr).text()
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "offline-test", version: "1" },
    } }) + "\n")
    proc.stdin.flush()
    const reader = proc.stdout.getReader()
    let output = ""
    while (!output.includes("\n")) {
      const chunk = await reader.read()
      if (chunk.done) break
      output += new TextDecoder().decode(chunk.value)
    }
    proc.stdin.end()
    const code = await proc.exited
    expect({ code, stderr: await stderr }).toMatchObject({ code: 0 })
    expect(JSON.parse(output.trim())).toMatchObject({ id: 1, result: { serverInfo: { name: expect.any(String) } } })
    expect(await fs.readFile(f.calls, "utf8").catch(() => "")).toBe("")
  } finally {
    await fs.rm(f.root, { recursive: true, force: true })
  }
}, 35_000)

test("with offline mode off, fetch, proxy settings and the shell environment stay as they were", async () => {
  // configMode leaves ALTIMATE_OFFLINE empty; removing the project file leaves no offline setting anywhere.
  const f = await fixture(false, true, false)
  try {
    await fs.rm(path.join(f.project, "opencode.jsonc"))
    await fs.rm(path.join(f.root, "data", "altimate-code", "auth.json"))
    const proc = Bun.spawn([process.execPath, "--preload", f.preload, CLI, "run", "--yolo", "Run the local shell command"], {
      cwd: f.project,
      // Online startup work the fixture cannot answer is switched off with the existing switches.
      env: {
        ...f.env,
        OFFLINE_TEST_BASH: "1",
        ALTIMATE_CLI_YOLO: "true",
        NO_PROXY: "corp.example",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        ALTIMATE_TELEMETRY_DISABLED: "1",
        ALTIMATE_DISABLE_WORKSPACE: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(25_000),
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect({ code, stdout, stderr }).toMatchObject({ code: 0, stdout: expect.stringContaining("offline reply") })
    const marker = await Bun.file(path.join(f.project, "shell-marker")).text().catch(() => "")
    expect({ marker, stderr }).toMatchObject({ marker: `shell-ran:corp.example|${PROXY}|` })
    // The preload records every replacement of globalThis.fetch: none happened.
    expect(await fs.readFile(f.blocked, "utf8").catch(() => "")).toBe("")
  } finally {
    await fs.rm(f.root, { recursive: true, force: true })
  }
}, 30_000)

test.skipIf(process.platform === "win32" || !Bun.which("openssl"))(
  "offline model requests reach an HTTPS endpoint through HTTPS_PROXY, and nothing else does",
  async () => {
    const f = await fixture(false, false, false)
    const tunnels: string[] = []
    let proxy: net.Server | undefined
    let model: ReturnType<typeof Bun.serve> | undefined
    try {
      const key = path.join(f.root, "key.pem")
      const cert = path.join(f.root, "cert.pem")
      const made = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
        "-days", "1", "-subj", "/CN=model.test", "-addext", "subjectAltName=DNS:model.test"], { stderr: "pipe" })
      expect(made.exitCode).toBe(0)
      model = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        tls: { key: Bun.file(key), cert: Bun.file(cert) },
        fetch: () =>
          new Response(
            [
              { choices: [{ index: 0, delta: { role: "assistant", content: "proxied reply" }, finish_reason: null }] },
              { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 2 } },
            ].map((chunk) => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          ),
      })
      // A CONNECT proxy that tunnels model.test to the local TLS server and refuses everything else.
      proxy = net.createServer((client) => {
        client.once("data", (chunk) => {
          const line = chunk.toString("latin1").split("\r\n")[0]
          tunnels.push(line)
          if (!line.startsWith("CONNECT model.test:443 ")) return client.end("HTTP/1.1 403 Forbidden\r\n\r\n")
          const upstream = net.connect(Number(model!.port), "127.0.0.1", () => {
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
            client.pipe(upstream).pipe(client)
          })
          upstream.on("error", () => client.destroy())
        })
      })
      await new Promise<void>((resolve) => proxy!.listen(0, "127.0.0.1", resolve))
      const proxyURL = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`
      const configFile = path.join(f.root, "config", "altimate-code", "altimate-code.json")
      const config = await Bun.file(configFile).json()
      config.provider["offline-test"].options.baseURL = "https://model.test/v1"
      await Bun.write(configFile, JSON.stringify(config))
      // No fetch-replacing preload: the CLI uses the real fetch.
      const proc = Bun.spawn([process.execPath, CLI, "run", "Hello"], {
        cwd: f.project,
        env: {
          ...f.env,
          ...Object.fromEntries(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].map((k) => [k, proxyURL])),
          NODE_EXTRA_CA_CERTS: cert,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.timeout(30_000),
      })
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      expect({ code, stdout, stderr }).toMatchObject({ code: 0, stdout: expect.stringContaining("proxied reply") })
      expect(tunnels.length).toBeGreaterThan(0)
      expect(tunnels.filter((line) => !line.startsWith("CONNECT model.test:443 "))).toEqual([])
    } finally {
      proxy?.close()
      model?.stop(true)
      await fs.rm(f.root, { recursive: true, force: true })
    }
  },
  40_000,
)
