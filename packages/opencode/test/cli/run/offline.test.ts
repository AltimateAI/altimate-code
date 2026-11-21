import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const CLI = path.resolve(import.meta.dir, "../../../src/index.ts")
const MODEL_ENDPOINT = "http://model.test:9000/v1"
const API = "https://workspace.test"
const TENANT = "offline-fixture"
const KEY = "fixture-key"
const SKILL = "This unique statement came from the cached offline skill."

async function fixture(snapshot: boolean, configMode: boolean, disableWorkspace: boolean) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "altimate-offline-"))
  const project = path.join(root, "project")
  const config = path.join(root, "config", "altimate-code")
  const data = path.join(root, "data", "altimate-code")
  const calls = path.join(root, "calls.jsonl")
  const preload = path.join(root, "preload.ts")
  const blocked = path.join(root, "blocked.jsonl")
  await Promise.all([fs.mkdir(project), fs.mkdir(config, { recursive: true }), fs.mkdir(data, { recursive: true })])
  await Bun.write(
    path.join(config, "altimate-code.json"),
    JSON.stringify({
      model: "offline-test/fixture",
      provider: {
        "offline-test": {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: MODEL_ENDPOINT, apiKey: "local-only" },
          models: { fixture: { name: "Offline fixture", limit: { context: 20000, output: 2000 } } },
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
    globalThis.fetch = Object.assign(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      appendFileSync(log, JSON.stringify({ url, hasSkill: String(init?.body).includes(${JSON.stringify(SKILL)}) }) + "\\n")
      if (url !== ${JSON.stringify(MODEL_ENDPOINT + "/chat/completions")}) {
        return new Response("{}", { status: 503 })
      }
      const chunks = [
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
    PATH: process.env.PATH,
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
  return { root, project, preload, env, calls, blocked, manifest, skill }
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
    const f = await fixture(snapshot, configMode, disableWorkspace)
    try {
      const before = snapshot ? await fs.readFile(f.manifest, "utf8") : undefined
      const proc = Bun.spawn([process.execPath, "--preload", f.preload, CLI, "run", "Hello"], {
        cwd: f.project,
        env: f.env,
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
      expect(calls.filter((call) => call.url !== MODEL_ENDPOINT + "/chat/completions")).toEqual([])
      expect(await fs.readFile(f.blocked, "utf8").catch(() => "")).toBe("")
      expect({ code, stdout, stderr }).toMatchObject({ code: 0, stdout: expect.stringContaining("offline reply") })
      expect(calls.length).toBeGreaterThan(0)
      expect(calls.some((call) => call.hasSkill)).toBe(snapshot)
      expect(stderr.match(/Offline mode:/g)).toHaveLength(1)
      expect(stderr).not.toContain("Workspace skills not synced")
      if (!snapshot) expect(stderr).toContain("No usable workspace skill snapshot")
      else {
        expect(await fs.readFile(f.manifest, "utf8")).toBe(before!)
        expect(await fs.readFile(f.skill, "utf8")).toContain(SKILL)
      }
    } finally {
      await fs.rm(f.root, { recursive: true, force: true })
    }
  }, 40_000)
}

test("offline model transport bypasses proxy settings and refuses redirects", async () => {
  let proxyCalls = 0
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      proxyCalls++
      return new Response("unexpected proxy")
    },
  })
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/redirect") return Response.redirect(proxy.url, 302)
      return new Response("direct model response")
    },
  })
  try {
    const source = path.resolve(import.meta.dir, "../../../src/config/offline.ts")
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
          import { Offline } from ${JSON.stringify(source)}
          await Offline.start(process.cwd())
          const request = Offline.modelFetch(process.env.OFFLINE_TEST_MODEL)
          console.log(await (await request(process.env.OFFLINE_TEST_MODEL)).text())
          try {
            await request(process.env.HTTP_PROXY)
            throw new Error("cross-origin request was accepted")
          } catch (error) {
            if (!error.message.includes("outside the configured model endpoint")) throw error
            console.log("cross-origin request refused")
          }
          try {
            await request(new URL("/redirect", process.env.OFFLINE_TEST_MODEL))
            throw new Error("redirect was accepted")
          } catch (error) {
            if (error.message === "redirect was accepted") throw error
            console.log("redirect refused")
          }
        `,
      ],
      {
        cwd: path.resolve(import.meta.dir, "../../.."),
        env: {
          ...process.env,
          ALTIMATE_OFFLINE: "1",
          OFFLINE_TEST_MODEL: model.url.href,
          HTTP_PROXY: proxy.url.href,
          http_proxy: proxy.url.href,
          NO_PROXY: "",
          no_proxy: "",
        },
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.timeout(15_000),
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect({ code, stdout, stderr }).toEqual({
      code: 0,
      stdout: "direct model response\ncross-origin request refused\nredirect refused\n",
      stderr: "",
    })
    expect(proxyCalls).toBe(0)
  } finally {
    model.stop(true)
    proxy.stop(true)
  }
})

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

test("offline mode does not launch a configured language server", async () => {
  const f = await fixture(false, false, false)
  const marker = path.join(f.root, "unexpected-lsp")
  const stub = path.join(f.root, "language-server.ts")
  const file = path.join(f.project, "test.offline-fixture")
  try {
    await fs.rm(path.join(f.root, "data", "altimate-code", "auth.json"))
    await Bun.write(file, "test")
    await Bun.write(stub, `await Bun.write(${JSON.stringify(marker)}, "server started")`)
    await Bun.write(
      path.join(f.project, "opencode.json"),
      JSON.stringify({ lsp: { fixture: { command: [process.execPath, stub], extensions: [".offline-fixture"] } } }),
    )
    const proc = Bun.spawn([process.execPath, "--preload", f.preload, CLI, "debug", "lsp", "diagnostics", file], {
      cwd: f.project,
      env: f.env,
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(20_000),
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect(await Bun.file(marker).exists()).toBe(false)
    expect({ code, stdout, stderr }).toMatchObject({ code: 0, stdout: expect.stringContaining("{}") })
  } finally {
    await fs.rm(f.root, { recursive: true, force: true })
  }
}, 25_000)

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
  "offline skill validation skips running paired tools",
  async () => {
    const f = await fixture(true, false, false)
    const bin = path.join(f.root, "bin")
    const marker = path.join(f.root, "unexpected-tool")
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
      expect(await Bun.file(marker).exists()).toBe(false)
      expect({ code, stdout, stderr }).toMatchObject({
        code: 0,
        stdout: expect.stringContaining("Paired tool checks require online mode."),
      })
    } finally {
      await fs.rm(f.root, { recursive: true, force: true })
    }
  },
  25_000,
)
