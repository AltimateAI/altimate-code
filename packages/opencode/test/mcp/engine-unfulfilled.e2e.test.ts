// altimate_change - new file
//
// End to end through the real MCP service: a real `@altimateai/datamate`
// engine (0.7.2+) is spawned over stdio the way the workspace overlay spawns
// it, against a fake Altimate API, and its `ai.altimate/unfulfilled` report
// arrives through the catalog as `MCP.listMeta(...)`, ready for the toast.
//
// Needs an engine checkout with a built `dist/cli.js`; skipped otherwise:
//   ALTIMATE_ENGINE_E2E_ROOT=/path/to/altimate-mcp-engine bun test test/mcp/engine-unfulfilled.e2e.test.ts
import http from "node:http"
import path from "node:path"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { MCP as MCPNS } from "../../src/mcp/index"
import { testEffect } from "../lib/effect"
import { MCP } from "../../src/mcp/index"
import {
  describeMissing,
  parseUnfulfilled,
  reportedMissing,
  UNFULFILLED_META_KEY,
} from "../../src/altimate/workspace/engine-types"

const root = process.env["ALTIMATE_ENGINE_E2E_ROOT"]
// The engine ships as a node shebang script; under `bun test` the test runner's own
// executable is bun, which the engine cannot run on.
const node = Bun.which("node") ?? "node"
const cli = root ? path.join(root, "dist/cli.js") : undefined
const runnable = !!cli && existsSync(cli)
const it = testEffect(MCP.defaultLayer)

const DATAMATE_ID = "77"

// The workspace declares five integrations; the engine can serve one of them.
const catalog = [
  {
    id: "jira",
    type: "tool",
    name: "Jira",
    description: "",
    url: "",
    supportsLocalConnectionTest: true,
    supportsSaasConnectionTest: false,
    config: [
      { key: "url", name: "URL", type: "string", required: true },
      { key: "email", name: "Email", type: "string", required: true },
      { key: "token", name: "Token", type: "string", required: true },
    ],
    tools: [{ key: "jira_search_issues", name: "Search issues" }],
  },
  {
    id: "vscode-power-user",
    type: "extension",
    name: "Power User for dbt",
    description: "",
    url: "",
    supportsLocalConnectionTest: false,
    supportsSaasConnectionTest: false,
    config: [],
    tools: [{ key: "pu_lineage", name: "Lineage" }],
  },
]
const custom = [
  {
    id: "mcp-ok",
    type: "mcp",
    name: "Echo MCP",
    description: "",
    url: "",
    config: [],
    toolConfig: [
      { key: "type", name: "type", type: "string", required: false, value: "stdio" },
      { key: "command", name: "command", type: "string", required: true, value: node },
      {
        key: "arguments",
        name: "arguments",
        type: "array",
        required: false,
        value: [path.join(import.meta.dir, "fixtures/echo-mcp-server.mjs")],
      },
    ],
    tools: [{ key: "echo" }, { key: "ghost" }],
  },
  {
    id: "mcp-missing-binary",
    type: "mcp",
    name: "Missing MCP",
    description: "",
    url: "",
    config: [],
    toolConfig: [
      { key: "type", name: "type", type: "string", required: false, value: "stdio" },
      { key: "command", name: "command", type: "string", required: true, value: "altimate-e2e-missing-binary" },
    ],
    tools: [{ key: "whatever" }],
  },
]
const datamate = {
  id: DATAMATE_ID,
  name: "e2e",
  description: "",
  privacy: "private",
  memory_enabled: false,
  knowledge_engine_enabled: false,
  knowledge_bases: [],
  integrations: [
    { id: "jira", type: "tool", name: "Jira", description: "", url: "", tools: [{ key: "jira_search_issues" }] },
    {
      id: "vscode-power-user",
      type: "extension",
      name: "PU",
      description: "",
      url: "",
      tools: [{ key: "pu_lineage" }],
    },
    {
      id: "mcp-ok",
      type: "mcp",
      name: "Echo MCP",
      description: "",
      url: "",
      tools: [{ key: "echo" }, { key: "ghost" }],
    },
    {
      id: "mcp-missing-binary",
      type: "mcp",
      name: "Missing MCP",
      description: "",
      url: "",
      tools: [{ key: "whatever" }],
    },
    {
      id: "retired-integration",
      type: "tool",
      name: "Retired",
      description: "",
      url: "",
      tools: [{ key: "retired_tool" }],
    },
  ],
}

async function fakeAltimateApi() {
  const unhandled: string[] = []
  const server = http.createServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://x").pathname
    const json = (code: number, body?: unknown) => {
      res.writeHead(code, { "content-type": "application/json" })
      res.end(body === undefined ? "" : JSON.stringify(body))
    }
    if (p === "/dbt/v3/validate-credentials") return json(200, { ok: true })
    if (p === "/datamates") return json(200, { datamates: [datamate] })
    if (p === "/datamate_integrations") return json(200, catalog)
    if (p === "/datamate_integrations/custom") return json(200, { items: custom })
    if (p === "/mask") return json(200, { mask_data: [] })
    if (p === "/connections") return json(200, { connections: [] })
    if (p === `/datamates/${DATAMATE_ID}/knowledge_bases`) return json(200, { knowledge_bases: [] })
    if (p === `/datamates/${DATAMATE_ID}/knowledge_engine_description`) return json(200, {})
    if (p === "/datamates/audit/create_batch") return json(204)
    unhandled.push(p)
    return json(404, { detail: `unhandled ${p}` })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const address = server.address() as { port: number }
  return { url: `http://127.0.0.1:${address.port}`, unhandled, close: () => server.close() }
}

function isolatedHome(apiUrl: string) {
  const home = mkdtempSync(path.join(tmpdir(), "engine-unfulfilled-e2e-"))
  mkdirSync(path.join(home, ".altimate"), { recursive: true })
  writeFileSync(
    path.join(home, ".altimate/altimate.json"),
    JSON.stringify({ altimateUrl: apiUrl, altimateInstanceName: "e2e", altimateApiKey: "e2e-key" }),
  )
  writeFileSync(path.join(home, ".altimate/settings.json"), "{}")
  writeFileSync(path.join(home, ".altimate/connections.json"), "[]")
  return home
}

describe.skipIf(!runnable)("engine unfulfilled report through the MCP service", () => {
  it.instance(
    "the engine's report reaches MCP.listMeta and reads as the attach toast",
    () =>
      MCP.Service.use((mcp: MCPNS.Interface) =>
        Effect.gen(function* () {
          const api = yield* Effect.promise(fakeAltimateApi)
          try {
            const home = isolatedHome(api.url)
            yield* mcp.add("datamate", {
              type: "local",
              command: [node, cli!, "start-stdio", "--datamate", DATAMATE_ID],
              environment: { HOME: home },
              cwd: root!,
            })
            const status = yield* mcp.status()
            if (status["datamate"]?.status !== "connected") {
              const logDir = path.join(home, ".altimate/logs")
              const logs = existsSync(logDir) ? readdirSync(logDir) : []
              const tail = logs.map((f) => readFileSync(path.join(logDir, f), "utf8").slice(-1500)).join("\n")
              throw new Error(
                `engine not connected: ${JSON.stringify(status["datamate"])}\n--- engine log tail ---\n${tail}`,
              )
            }

            const tools = yield* mcp.tools()
            expect(Object.keys(tools).filter((k) => k.startsWith("datamate_"))).toEqual(["datamate_echo"])

            const meta = yield* mcp.listMeta("datamate")
            const report = parseUnfulfilled(meta)
            expect(report).toBeDefined()
            const byKey = Object.fromEntries(report!.map((u) => [u.key, u]))
            expect(byKey["jira_search_issues"]).toMatchObject({ integrationId: "jira", reason: "invalid-connection" })
            expect(byKey["pu_lineage"]).toMatchObject({ integrationId: "vscode-power-user", reason: "no-bridge" })
            expect(byKey["ghost"]).toMatchObject({ integrationId: "mcp-ok", reason: "unknown-key" })
            expect(byKey["whatever"]).toMatchObject({ integrationId: "mcp-missing-binary", reason: "spawn-failed" })
            expect(byKey["whatever"]?.detail).toMatch(/ENOENT/)
            expect(byKey["retired_tool"]).toMatchObject({
              integrationId: "retired-integration",
              reason: "catalog-missing",
            })
            expect(report!.some((u) => `datamate_${u.key}` in tools)).toBe(false)

            // What the user would read on attach: every gap but the IDE one, with reasons.
            expect(describeMissing(reportedMissing(report!))).toBe(
              " Declared but not available — no usable connection: jira_search_issues; " +
                "not offered by the integration: ghost; " +
                "server failed to start (spawn altimate-e2e-missing-binary ENOENT): whatever; " +
                "no longer in the catalog: retired_tool.",
            )
            expect(api.unhandled).toEqual([])
            yield* mcp.remove("datamate")
            expect(yield* mcp.listMeta("datamate")).toBeUndefined()
          } finally {
            api.close()
          }
        }),
      ),
    60_000,
  )
})

// Referenced so the key is visibly the contract this test exercises.
void UNFULFILLED_META_KEY
