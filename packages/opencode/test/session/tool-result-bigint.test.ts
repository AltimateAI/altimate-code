import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { expect, spyOn } from "bun:test"
import { Effect } from "effect"
import { Bus } from "@/bus"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { ToolRegistry } from "@/tool/registry"
import { registerAll as registerConnections } from "@/altimate/native/connections/register"
import { closeScratch } from "@/altimate/native/connections/scratch"
import { Trace, type TraceFile } from "@/altimate/observability/tracing"
import { SqlExecuteTool } from "@/altimate/tools/sql-execute"
import { toolInfo } from "../altimate/tool-fixture"
import { testEffect } from "../lib/effect"
import { provideTmpdirInstanceLegacy } from "./legacy-instance"

const it = testEffect(
  LayerNode.buildLayer(
    LayerNode.group([Session.node, SessionProjector.node, SessionPrompt.node, CrossSpawnSpawner.node]),
    { replacements: [LayerNode.replace(RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true }))] },
  ),
)

const config = {
  snapshot: false,
  learn: { enabled: false },
  provider: {
    test: {
      name: "Test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          name: "Test Model",
          tool_call: true,
          limit: { context: 100000, output: 10000 },
        },
      },
      options: { apiKey: "test-key", baseURL: "https://unused.invalid/v1" },
    },
  },
}

it.live(
  "four concurrent scratch tools persist BigInt metadata and complete the next model turn",
  () =>
    provideTmpdirInstanceLegacy(
      () =>
        Effect.gen(function* () {
          // Dispatcher unit tests clear the process-wide handlers and lazy hook.
          // Reinstall the real SQL handler even when native/index is already cached.
          registerConnections()
          const pluginList = spyOn(Plugin, "list").mockResolvedValue([])
          const pluginTrigger = spyOn(Plugin, "trigger").mockImplementation(async (_name, _input, output) => output)
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const chat = yield* sessions.create({
            title: "Scratch counts",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          const sql = yield* Effect.promise(async () => {
            const info = await toolInfo(SqlExecuteTool)
            return { id: info.id, ...(await Effect.runPromise(info.init())) }
          })
          const counts = { small: 3n, negative: -3n, large: 9223372036854775807n, lower: -9223372036854775808n }
          const normalized = { small: 3, negative: -3, large: "9223372036854775807", lower: "-9223372036854775808" }
          let started = 0
          let release!: () => void
          const allStarted = new Promise<void>((resolve) => {
            release = resolve
          })
          const query =
            "SELECT COUNT(*) AS small, -COUNT(*) AS negative, 9223372036854775807::BIGINT AS large, '-9223372036854775808'::BIGINT AS lower FROM range(3)"
          const registry = spyOn(ToolRegistry, "tools").mockResolvedValue([
            {
              ...sql,
              registrySource: undefined,
              execute: (args, ctx) =>
                Effect.gen(function* () {
                  started++
                  if (started === 4) release()
                  yield* Effect.promise(() => allStarted)
                  const result = yield* sql.execute(args, ctx)
                  expect(result.metadata.error).toBeUndefined()
                  expect(result.output).toContain("9223372036854775807")
                  // SQL formats its rows as text already. A tool or plugin can still add
                  // native integers to metadata, which must be safe at the storage boundary.
                  return { ...result, metadata: { ...result.metadata, counts: [counts] } }
                }),
            },
          ])
          const mcp = spyOn(MCP, "tools").mockResolvedValue({})
          const published = spyOn(Bus, "publish")
          const requests: Record<string, unknown>[] = []
          const language = createOpenAICompatible({
            name: "test",
            baseURL: "https://unused.invalid/v1",
            fetch: (async (_url, init) => {
              requests.push(JSON.parse(String(init?.body)))
              const first = requests.length === 1
              const chunks = [
                {
                  choices: [
                    {
                      delta: {
                        role: "assistant",
                        ...(first
                          ? {
                              tool_calls: ["alpha_count", "beta_count", "gamma_count", "delta_count"].map(
                                (column, index) => ({
                                  index,
                                  id: `call_count_${index}`,
                                  type: "function",
                                  function: {
                                    name: "sql_execute",
                                    arguments: JSON.stringify({
                                      query: query.replace("AS small", `AS ${column}`),
                                      warehouse: "scratch",
                                    }),
                                  },
                                }),
                              ),
                            }
                          : { content: "All four counts are 3." }),
                      },
                    },
                  ],
                },
                {
                  choices: [{ delta: {}, finish_reason: first ? "tool_calls" : "stop" }],
                  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
                },
              ]
              return new Response(
                chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
                {
                  headers: { "Content-Type": "text/event-stream" },
                },
              )
            }) as typeof fetch,
          }).chatModel("test-model")
          const getLanguage = spyOn(Provider, "getLanguage").mockResolvedValue(language)
          try {
            const answer = yield* prompt.prompt({
              sessionID: chat.id,
              agent: "build",
              model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
              parts: [{ type: "text", text: "Run four scratch counts in parallel and report the result." }],
            })
            expect(answer.info).not.toHaveProperty("error")
            expect(answer.parts).toContainEqual(
              expect.objectContaining({ type: "text", text: "All four counts are 3." }),
            )
            expect(started).toBe(4)
            expect(requests).toHaveLength(2)
            expect(() => JSON.stringify(requests)).not.toThrow()
            const messages = yield* sessions.messages({ sessionID: chat.id })
            const completed = messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")
            expect(completed).toHaveLength(4)
            expect(() => JSON.stringify(messages)).not.toThrow()
            for (const part of completed) {
              expect(part.state).toMatchObject({ status: "completed" })
              if (part.state.status === "completed") expect(part.state.metadata.counts).toEqual([normalized])
            }
            const events = published.mock.calls
              .filter(([event]) => event === MessageV2.Event.PartUpdated)
              .map(([, data]) => data as { part: MessageV2.Part })
              .filter(
                ({ part }) => part.sessionID === chat.id && part.type === "tool" && part.state.status === "completed",
              )
            expect(events).toHaveLength(4)
            expect(() => JSON.stringify(events)).not.toThrow()
            let file: TraceFile | undefined
            const trace = Trace.withExporters([
              {
                name: "memory",
                export: async (value) => {
                  file = value
                  return undefined
                },
              },
            ])
            trace.startTrace(chat.id, {})
            for (const { part } of events) trace.logToolCall(part as Parameters<Trace["logToolCall"]>[0])
            yield* Effect.promise(() => trace.endTrace())
            expect(file!.spans.filter((span) => span.kind === "tool")).toHaveLength(4)
            expect(() => JSON.stringify(file)).not.toThrow()
            expect(counts.small).toBe(3n)
            expect(counts.large).toBe(9223372036854775807n)
          } finally {
            getLanguage.mockRestore()
            registry.mockRestore()
            mcp.mockRestore()
            published.mockRestore()
            pluginList.mockRestore()
            pluginTrigger.mockRestore()
            yield* Effect.promise(() => closeScratch(chat.id))
          }
        }),
      { config },
    ),
  30_000,
)
