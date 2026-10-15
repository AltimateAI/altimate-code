import assert from "node:assert/strict"
import path from "node:path"
import type { LanguageModelV3, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { Model, Plugin, Provider } from "@opencode/plugin"
import { HostContributions } from "@opencode/plugin/host-contributions"
import { OpenCode } from "@opencode/sdk"
import { AltimateRpc } from "../src/rpc"

// Packaging acceptance only: use the production host, tools and RPC without opening a listener.
export async function runArtifactSmoke() {
  assert(HostContributions.server.some((plugin) => plugin.id === "altimate" && plugin.protected))
  assert(HostContributions.tui.some((plugin) => plugin.id === "altimate" && plugin.protected))
  const steps = [
    { tool: "warehouse_add", input: { name: "artifact", path: ":memory:" } },
    { tool: "sql_execute", input: { warehouse: "artifact", sql: "SELECT 42 AS answer" } },
  ]
  const calls: string[][] = []
  const language: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: "artifact-smoke",
    modelId: "artifact-smoke",
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error("Unexpected non-streaming smoke request")),
    async doStream(options) {
      calls.push((options.tools ?? []).map((tool) => tool.name))
      const step = steps.shift()
      const parts: LanguageModelV3StreamPart[] = [{ type: "stream-start", warnings: [] }]
      if (step) {
        const id = `artifact_${calls.length}`
        const input = JSON.stringify(step.input)
        parts.push(
          { type: "tool-input-start", id, toolName: step.tool },
          { type: "tool-input-delta", id, delta: input },
          { type: "tool-input-end", id },
          { type: "tool-call", toolCallId: id, toolName: step.tool, input },
        )
      }
      if (!step) {
        parts.push(
          { type: "text-start", id: "done" },
          { type: "text-delta", id: "done", delta: "Artifact smoke complete." },
          { type: "text-end", id: "done" },
        )
      }
      parts.push({
        type: "finish",
        finishReason: { unified: step ? "tool-calls" : "stop", raw: step ? "tool_calls" : "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
      })
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            parts.forEach((part) => controller.enqueue(part))
            controller.close()
          },
        }),
      }
    },
  }
  const providerID = Provider.ID.make("artifact-smoke")
  const started = performance.now()
  await using host = await OpenCode.create({
    log: { level: "error", emit: (entry) => console.error(JSON.stringify(entry)) },
    database: { path: path.join(process.cwd(), "artifact-smoke.sqlite") },
    events: { persist: true },
    models: { fetch: false },
    fs: { filewatcher: false, fff: false },
    plugins: [
      Plugin.define({
        id: "artifact-smoke-model",
        async setup(ctx) {
          await ctx.provider.transform((editor) => {
            editor.add({
              info: {
                ...Provider.Info.empty(providerID),
                activation: "enabled",
                package: "aisdk:artifact-smoke",
              },
              models: [Model.Info.default(providerID, Model.ID.make("artifact-smoke"))],
            })
          })
          await ctx.aisdk.hook(
            "sdk",
            (event) => {
              event.sdk = { languageModel: () => language }
            },
            { providerID },
          )
        },
      }),
    ],
    config: {
      directory: path.join(process.cwd(), "config"),
      project: false,
      content: JSON.stringify({
        model: "artifact-smoke/artifact-smoke",
        plugins: ["-opencode.provider.dynamic"],
        agents: { title: { disabled: true } },
        snapshots: false,
      }),
    },
  })
  const session = await host.sessions.create({ location: { directory: process.cwd() } })
  await host.sessions.prompt({ sessionID: session.id, text: "Run the offline artifact smoke." })
  await host.sessions.wait({ sessionID: session.id })
  assert(calls[0]?.includes("warehouse_add"), "warehouse_add missing from first model request")
  assert(calls[0]?.includes("sql_execute"), "sql_execute missing from first model request")
  const inventory = await host.plugin.list({ location: session.location })
  assert(
    inventory.data.some(
      (plugin) => plugin.id === "altimate" && plugin.source.type === "builtin" && plugin.state.status === "active",
    ),
  )
  const rpc = host.rpc(AltimateRpc)
  assert.deepEqual(await rpc.listWarehouses({}, { location: session.location }), [
    { name: "artifact", path: ":memory:", type: "duckdb" },
  ])
  const result = await rpc.lastResult({ sessionID: session.id }, { location: session.location })
  assert(result, "SQL result missing from the RPC read model")
  assert.deepEqual(result.rows, [[42]])
  const driverModules = Object.keys(require.cache).filter((file) => file.includes("/@duckdb/"))
  assert(driverModules.some((file) => file.endsWith("/@duckdb/node-api/lib/index.js")), "DuckDB API was not loaded")
  const nativeModules = driverModules.filter((file) => file.endsWith(".node"))
  assert(nativeModules.length, "DuckDB native module missing from require.cache")
  const driverRoot = path.resolve(path.dirname(process.execPath), "..", "lib", "altimate", "drivers")
  assert(
    driverModules.every((file) => file.startsWith(`${driverRoot}${path.sep}`)),
    driverModules.join("\n"),
  )
  console.log(
    JSON.stringify({
      builtin: "altimate",
      firstRequestTools: calls[0].filter((tool) => tool === "warehouse_add" || tool === "sql_execute"),
      rows: result.rows,
      rpc: true,
      listening: false,
      nativeModules,
      driverModules,
      elapsedMs: Math.round(performance.now() - started),
    }),
  )
}
