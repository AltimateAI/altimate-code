import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import path from "node:path"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { ToolLookupTool } from "../../src/altimate/tools/tool-lookup"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session/session"
import { Session as LegacySession } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionSummary } from "../../src/session/summary"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionTools } from "../../src/session/tools"
import { ToolRegistry } from "../../src/tool/registry"
import { Truncate } from "../../src/tool/truncate"
import { initTool } from "../altimate/tool-fixture"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply } from "../lib/llm-server"
import { withLegacyInstance } from "../session/legacy-instance"

const model = { providerID: ProviderID.opencode, modelID: ModelID.make("test") }
const it = testEffect(Layer.mergeAll(Agent.defaultLayer, ToolRegistry.layer))
const promptTests = testEffect(
  LayerNode.buildLayer(LayerNode.group([SessionPrompt.node, Session.node, Agent.node, SessionProjector.node]), {
    replacements: [
      LayerNode.replace(
        MCP.node,
        Layer.mock(MCP.Service, {
          tools: () => Effect.succeed({}),
          snapshot: () => Effect.succeed({ tools: {}, meta: undefined }),
          listMeta: () => Effect.succeed(undefined),
          entry: () => Effect.succeed(undefined),
        }),
      ),
      LayerNode.replace(
        SessionSummary.node,
        Layer.mock(SessionSummary.Service, {
          summarize: () => Effect.void,
          diff: () => Effect.succeed([]),
          computeDiff: () => Effect.succeed([]),
        }),
      ),
      LayerNode.replace(RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })),
    ],
  }),
)
const promptModel = { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }
const echoInstruction = "Tools are disabled. Reply with exactly the text returned by answer_commit and nothing else."

let previousToggle: string | undefined

beforeEach(() => {
  previousToggle = process.env.ALTIMATE_ANSWER_COMMIT
  delete process.env.ALTIMATE_ANSWER_COMMIT
})

afterEach(() => {
  if (previousToggle === undefined) delete process.env.ALTIMATE_ANSWER_COMMIT
  else process.env.ALTIMATE_ANSWER_COMMIT = previousToggle
})

describe("answer_commit agent scope", () => {
  test("single-instance answer_commit cases use scoped Effect fixtures", async () => {
    const source = await Bun.file(import.meta.path).text()
    expect(source).not.toMatch(/\bInstance\.provide\s*\(/)
    expect(source).not.toMatch(/\bawait\s+tmpdir\s*\(/)
  })

  it.instance("analyst permits and receives answer_commit", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const registry = yield* ToolRegistry.Service
      const analyst = yield* agents.get("analyst")
      expect(Permission.evaluate("answer_commit", "*", analyst.permission).action).toBe("allow")
      const tools = yield* registry.tools({ ...model, agent: analyst })
      expect(tools.filter((tool) => tool.id === "answer_commit")).toHaveLength(1)
    }),
  )

  it.instance(
    "a custom agent named analyst receives answer_commit by design",
    () =>
      Effect.gen(function* () {
        const agents = yield* Agent.Service
        const registry = yield* ToolRegistry.Service
        const analyst = yield* agents.get("analyst")
        expect(analyst.description).toBe("Configured analyst")
        expect(analyst.prompt).toBe("Use the configured analyst instructions.")
        // Configuration customizes the native analyst; access intentionally follows its name.
        expect(Permission.evaluate("answer_commit", "*", analyst.permission).action).toBe("allow")
        const tools = yield* registry.tools({ ...model, agent: analyst })
        expect(tools.filter((tool) => tool.id === "answer_commit")).toHaveLength(1)
      }),
    {
      config: {
        agent: {
          analyst: {
            description: "Configured analyst",
            prompt: "Use the configured analyst instructions.",
          },
        },
      },
    },
  )

  it.instance("session resolver selects native answer_commit over a plugin tool with the same id", () =>
    withLegacyInstance(
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const agents = yield* Agent.Service
        const analyst = yield* agents.get("analyst")
        let pluginCalls = 0
        const plugin = Layer.mock(Plugin.Service, {
          list: () =>
            Effect.succeed([
              {
                tool: {
                  answer_commit: {
                    description: "Plugin answer_commit collision",
                    args: {},
                    execute: async () => {
                      pluginCalls += 1
                      return "Plugin answer"
                    },
                  },
                },
              },
            ]),
          trigger: (_name, _input, output) => Effect.succeed(output),
        })
        const resolverModel: Provider.Model = {
          id: model.modelID,
          providerID: model.providerID,
          api: { id: model.modelID, url: "https://example.com", npm: "@ai-sdk/openai" },
          name: "Test model",
          capabilities: {
            temperature: true,
            reasoning: false,
            attachment: false,
            toolcall: true,
            interleaved: false,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
          },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 128000, output: 4096 },
          status: "active",
          options: {},
          headers: {},
          release_date: "2026-01-01",
        }
        const sessionID = SessionID.make("ses_answer_commit_collision")
        const messageID = MessageID.make("msg_answer_commit_collision")
        const tools = yield* SessionTools.resolve({
          agent: analyst,
          model: resolverModel,
          bypassAgentCheck: false,
          messages: [],
          session: {
            id: sessionID,
            slug: "answer-commit-collision",
            projectID: ProjectV2.ID.make("project"),
            directory: tmp.directory,
            title: "Answer commit collision",
            version: "1",
            time: { created: 0, updated: 0 },
          },
          processor: {
            message: {
              id: messageID,
              sessionID,
              role: "assistant",
              time: { created: 0 },
              parentID: MessageID.make("msg_user"),
              modelID: model.modelID,
              providerID: model.providerID,
              mode: "analyst",
              agent: "analyst",
              path: { cwd: tmp.directory, root: tmp.directory },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
            updateToolCall: () => Effect.succeed(undefined),
            completeToolCall: () => Effect.void,
          },
          promptOps: {
            resolvePromptParts: () => Effect.succeed([]),
            prompt: () => Effect.die("unexpected prompt"),
            cancel: () => Effect.void,
          },
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              plugin,
              ToolRegistry.layer.pipe(Layer.provide(plugin)),
              Layer.mock(Permission.Service, { ask: () => Effect.void }),
              Layer.mock(MCP.Service, { tools: () => Effect.succeed({}) }),
              Layer.mock(Truncate.Service, {}),
            ),
          ),
        )
        const result = yield* Effect.promise(() =>
          Promise.resolve(
            tools.answer_commit.execute!(
              {
                fields: [{ name: "Revenue", value: 42 }],
                basis: "Revenue sums orders.amount across all orders, with one row per order.",
              },
              { toolCallId: "call_answer_commit_collision", messages: [], abortSignal: AbortSignal.any([]) },
            ),
          ),
        )
        expect(result).toMatchObject({
          title: "Answer committed",
          output: "Revenue sums orders.amount across all orders, with one row per order.\n\n**Answer:** Revenue: 42",
        })
        expect(pluginCalls).toBe(0)
      }),
    ),
  )

  it.instance(
    "builder, plan, data-explorer and custom agents never receive answer_commit",
    () =>
      Effect.gen(function* () {
        const agents = yield* Agent.Service
        const registry = yield* ToolRegistry.Service
        for (const name of ["builder", "build", "plan", "data-explorer", "custom"]) {
          const agent = yield* agents.get(name)
          expect(agent).toBeDefined()
          const tools = yield* registry.tools({ ...model, agent })
          expect(tools.map((tool) => tool.id)).not.toContain("answer_commit")
        }
        expect((yield* registry.tools(model)).map((tool) => tool.id)).not.toContain("answer_commit")
      }),
    {
      config: {
        permission: { "*": "allow", answer_commit: "allow" },
        agent: {
          custom: {
            description: "A custom agent",
            mode: "primary",
            permission: { "*": "allow", answer_commit: "allow" },
          },
        },
      },
    },
  )

  it.instance("tool_lookup does not expose answer_commit to builder", () =>
    withLegacyInstance(
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const tool = yield* Effect.promise(() => initTool(ToolLookupTool))
        const ctx = {
          sessionID: SessionID.make("ses_answer_commit"),
          messageID: MessageID.make("msg_answer_commit"),
          callID: "call_answer_commit_lookup",
          agent: "builder",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        }
        const missing = yield* Effect.promise(() => tool.execute({ tool_name: "answer_commit" }, ctx))
        expect(missing.title).toBe("Tool not found")
        const listing = yield* Effect.promise(() => tool.execute({ tool_name: "__missing_tool" }, ctx))
        expect(listing.output).not.toContain("answer_commit")
        expect((yield* registry.allInfos()).map((info) => info.id)).not.toContain("answer_commit")
        expect(yield* registry.ids()).not.toContain("answer_commit")
      }),
    ),
  )

  it.instance("ALTIMATE_ANSWER_COMMIT=0 removes the analyst candidate and can be toggled back on", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const registry = yield* ToolRegistry.Service
      const analyst = yield* agents.get("analyst")
      process.env.ALTIMATE_ANSWER_COMMIT = "0"
      expect((yield* registry.tools({ ...model, agent: analyst })).map((tool) => tool.id)).not.toContain(
        "answer_commit",
      )
      process.env.ALTIMATE_ANSWER_COMMIT = "1"
      expect((yield* registry.tools({ ...model, agent: analyst })).map((tool) => tool.id)).toContain("answer_commit")
    }),
  )

  it.instance("answer_commit is reserved from plugin and file tools even when the native tool is disabled", () =>
    withLegacyInstance(
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const agents = yield* Agent.Service
        const analyst = yield* agents.get("analyst")
        const builder = yield* agents.get("builder")
        const filename = path.join(tmp.directory, "answer.ts")
        yield* Effect.promise(() =>
          Bun.write(
            filename,
            `export const commit = { description: "File collision", args: {}, execute: async () => "External answer" }`,
          ),
        )
        const plugins = [
          {
            tool: {
              answer_commit: { description: "Plugin collision", args: {}, execute: async () => "External answer" },
              ordinary_tool: { description: "Ordinary plugin tool", args: {}, execute: async () => "OK" },
            },
          },
        ]
        const config = { matches: [filename], config: {} }
        const infos = yield* Effect.promise(() => ToolRegistry.allInfos(plugins, config))
        expect(infos.map((tool) => tool.id)).not.toContain("answer_commit")
        expect(infos.map((tool) => tool.id)).toContain("ordinary_tool")
        for (const toggle of ["0", "1"]) {
          process.env.ALTIMATE_ANSWER_COMMIT = toggle
          for (const agent of [analyst, builder]) {
            const tools = yield* Effect.promise(() => ToolRegistry.tools(model, agent, plugins, undefined, config))
            expect(tools.filter((tool) => tool.id === "answer_commit")).toHaveLength(
              toggle === "1" && agent.name === "analyst" ? 1 : 0,
            )
            expect(tools.map((tool) => tool.id)).toContain("ordinary_tool")
          }
        }
        const platform = Object.getOwnPropertyDescriptor(process, "platform")!
        Object.defineProperty(process, "platform", { ...platform, value: "win32" })
        try {
          const variants = [{ tool: { Answer_Commit: plugins[0].tool.answer_commit } }]
          const infos = yield* Effect.promise(() => ToolRegistry.allInfos(variants, config))
          expect(Permission.evaluate("Answer_Commit", "*", analyst.permission).action).toBe("allow")
          expect(infos.map((tool) => tool.id)).not.toContain("Answer_Commit")
        } finally {
          Object.defineProperty(process, "platform", platform)
        }
      }),
    ),
  )
})

for (const scenario of ["text", "json_schema", "json_schema-history", "new-user", "failed", "sibling-tool"] as const) {
  const structured = scenario.startsWith("json_schema")
  const priorCommit = scenario === "json_schema-history"
  const name = {
    text: "text requests offer answer_commit and immediately echo a successful commit without a step limit",
    json_schema: "json_schema requests omit answer_commit and never enter echo mode",
    "json_schema-history": "json_schema requests preserve masked commit history without re-advertising answer_commit",
    "new-user": "a new user message resets a successful commit before the next step",
    failed: "a failed commit leaves tools available for repair",
    "sibling-tool": "a successful commit enters echo mode even when a sibling tool follows it",
  }[scenario]
  promptTests.instance(
    name,
    () =>
      withLegacyInstance(
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const agents = yield* Agent.Service
          expect((yield* agents.get("analyst")).steps).toBeUndefined()
          const chat = yield* sessions.create({ title: "Answer commit finalization" })
          const requests: { tools?: { function: { name: string } }[]; messages: unknown[]; tool_choice?: string }[] = []
          const args = {
            fields: [{ name: "", value: 42 }],
            answer_only: true,
            basis: "Counted all records at record grain using records.id.",
          }
          const language = createOpenAICompatible({
            name: "test",
            baseURL: "https://unused.invalid/v1",
            fetch: Object.assign(
              async (_url: string | URL | Request, init?: RequestInit) => {
                if (typeof init?.body !== "string") throw new Error("expected a JSON request body")
                requests.push(JSON.parse(init.body))
                if (requests.length > (priorCommit ? 4 : 2)) throw new Error("unexpected extra generation")
                const step = priorCommit && requests.length > 2 ? requests.length - 2 : requests.length
                if (scenario === "new-user" && requests.length === 1) {
                  const userID = MessageID.ascending()
                  await LegacySession.updateMessage({
                    id: userID,
                    sessionID: chat.id,
                    role: "user",
                    agent: "analyst",
                    model: promptModel,
                    time: { created: Date.now() },
                  })
                  await LegacySession.updatePart({
                    id: PartID.ascending(),
                    messageID: userID,
                    sessionID: chat.id,
                    type: "text",
                    text: "A new question: how many sources?",
                  })
                }
                const response =
                  step === 1
                    ? // The structured case deliberately attempts a stale commit call to verify it cannot activate echo mode.
                      scenario === "sibling-tool"
                      ? reply().tool("answer_commit", args).tool("tool_lookup", { tool_name: "__missing_tool" }).item()
                      : reply()
                          .tool("answer_commit", scenario === "failed" ? {} : args)
                          .item()
                    : structured && (!priorCommit || requests.length > 2)
                      ? reply().tool("StructuredOutput", { count: 42 }).item()
                      : reply()
                          .text(scenario === "new-user" ? "3" : "42")
                          .stop()
                          .item()
                if (response.type !== "sse") throw new Error("expected SSE response")
                return new Response(
                  [...response.head, ...response.tail].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
                    "data: [DONE]\n\n",
                  { headers: { "Content-Type": "text/event-stream" } },
                )
              },
              { preconnect: () => undefined },
            ),
          }).chatModel("test-model")
          const languageSpy = spyOn(Provider, "getLanguage").mockResolvedValue(language)
          try {
            if (priorCommit) {
              yield* prompt.prompt({
                sessionID: chat.id,
                agent: "analyst",
                model: promptModel,
                parts: [{ type: "text", text: "How many records? Reply with only the count." }],
              })
              const history = yield* sessions.messages({ sessionID: chat.id })
              const commit = history
                .flatMap((message) => message.parts)
                .find((part) => part.type === "tool" && part.tool === "answer_commit")
              if (commit?.type !== "tool" || commit.state.status !== "completed")
                throw new Error("missing prior commit")
              const state = commit.state
              yield* Effect.promise(() =>
                LegacySession.updatePart({
                  ...commit,
                  state: {
                    ...state,
                    output: "UNMASKED_COMMIT_OUTPUT",
                    metadata: { ...state.metadata, observation_mask: "Previous committed answer was masked." },
                    time: { ...state.time, compacted: Date.now() },
                  },
                }),
              )
            }
            const result = yield* prompt.prompt({
              sessionID: chat.id,
              agent: "analyst",
              model: promptModel,
              parts: [{ type: "text", text: "How many records? Reply with only the count." }],
              ...(structured
                ? {
                    format: {
                      type: "json_schema" as const,
                      retryCount: 0,
                      schema: {
                        type: "object",
                        properties: { count: { type: "number" } },
                        required: ["count"],
                        additionalProperties: false,
                      },
                    },
                  }
                : {}),
            })
            expect(result.info).not.toHaveProperty("error")
            expect(requests).toHaveLength(priorCommit ? 4 : 2)
            const tools = (index: number) => (requests[index].tools ?? []).map((tool) => tool.function.name)
            if (structured) {
              for (const request of priorCommit ? requests.slice(2) : requests) {
                expect((request.tools ?? []).map((tool) => tool.function.name)).not.toContain("answer_commit")
                expect((request.tools ?? []).map((tool) => tool.function.name)).toContain("StructuredOutput")
                expect(request.tool_choice).toBe("required")
                expect(JSON.stringify(request.messages)).not.toContain(echoInstruction)
                if (priorCommit) {
                  expect(JSON.stringify(request.messages)).toContain("Previous committed answer was masked.")
                  expect(JSON.stringify(request.messages)).not.toContain("UNMASKED_COMMIT_OUTPUT")
                }
              }
              expect(result.info).toHaveProperty("structured", { count: 42 })
            } else {
              expect(tools(0)).toContain("answer_commit")
              const messages = yield* sessions.messages({ sessionID: chat.id })
              const commit = messages
                .flatMap((message) => message.parts)
                .find((part) => part.type === "tool" && part.tool === "answer_commit")
              expect(commit?.type === "tool" && commit.state.status).toBe(scenario === "failed" ? "error" : "completed")
              if (scenario === "text" || scenario === "sibling-tool") {
                expect(tools(1)).toEqual([])
                expect(JSON.stringify(requests[1].messages)).toContain(echoInstruction)
                expect(result.parts).toContainEqual(expect.objectContaining({ type: "text", text: "42" }))
              } else {
                expect(tools(1)).toContain("answer_commit")
                expect(JSON.stringify(requests[1].messages)).not.toContain(echoInstruction)
              }
            }
          } finally {
            languageSpy.mockRestore()
          }
        }),
      ),
    {
      config: {
        snapshot: false,
        learn: { enabled: false },
        agent: { analyst: { permission: { StructuredOutput: "allow" } } },
        provider: {
          test: {
            name: "Test",
            npm: "@ai-sdk/openai-compatible",
            env: [],
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
      },
    },
    30_000,
  )
}

test("analyst prompt gives StructuredOutput precedence over answer_commit", async () => {
  const prompt = await Bun.file(new URL("../../src/altimate/prompts/analyst.txt", import.meta.url)).text()
  expect(prompt).toContain("When a JSON schema is requested, finish with `StructuredOutput` instead")
})
