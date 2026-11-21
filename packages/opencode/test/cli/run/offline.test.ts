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

async function fixture(snapshot: boolean, configMode: boolean) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "altimate-offline-"))
  const project = path.join(root, "project")
  const config = path.join(root, "config", "altimate-code")
  const data = path.join(root, "data", "altimate-code")
  const calls = path.join(root, "calls.jsonl")
  const preload = path.join(root, "preload.ts")
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
  if (configMode) await Bun.write(path.join(project, "opencode.jsonc"), '{ // local policy\n "offline": true }')
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
    // The environment switch must preserve the snapshot even when a deployment
    // still has the old workspace opt-out set.
    ALTIMATE_DISABLE_WORKSPACE: configMode ? "" : "1",
    ALTIMATE_CODE_DISABLE_OS_CREDENTIAL_STORE: "1",
    ALTIMATE_RUN_STDIN_WAIT_MS: "0",
    NO_COLOR: "1",
  }
  return { root, project, preload, env, calls, manifest, skill }
}

for (const configMode of [false, true]) {
  test(`offline ${configMode ? "config" : "environment"} keeps network traffic on the model endpoint`, async () => {
    const f = await fixture(!configMode, configMode)
    try {
      const before = configMode ? undefined : await fs.readFile(f.manifest, "utf8")
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
      expect({ code, stdout, stderr }).toMatchObject({ code: 0, stdout: expect.stringContaining("offline reply") })
      expect(calls.length).toBeGreaterThan(0)
      expect(calls.some((call) => call.hasSkill)).toBe(!configMode)
      expect(stderr.match(/Offline mode:/g)).toHaveLength(1)
      expect(stderr).not.toContain("Workspace skills not synced")
      if (configMode) expect(stderr).toContain("No usable workspace skill snapshot")
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
          import { startOfflineMode, offlineModelFetch } from ${JSON.stringify(source)}
          await startOfflineMode(process.cwd())
          const request = offlineModelFetch(process.env.OFFLINE_TEST_MODEL)
          console.log(await (await request(process.env.OFFLINE_TEST_MODEL)).text())
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
      stdout: "direct model response\nredirect refused\n",
      stderr: "",
    })
    expect(proxyCalls).toBe(0)
  } finally {
    model.stop(true)
    proxy.stop(true)
  }
})
