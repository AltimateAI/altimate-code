import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import path from "node:path"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { renderAnswer } from "../../src/altimate/tools/answer-commit"
import { ToolLookupTool } from "../../src/altimate/tools/tool-lookup"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { OutputCollector } from "../../src/cli/cmd/run-output"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session/session"
import { Session as LegacySession } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionSummary } from "../../src/session/summary"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionTools } from "../../src/session/tools"
import { ToolRegistry } from "../../src/tool/registry"
import { Truncate } from "../../src/tool/truncate"
import { Token } from "../../src/util/token"
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

for (const scenario of [
  "text",
  "echo-length",
  "echo-mismatch",
  "echo-no-text",
  "echo-other",
  "echo-exact-length",
  "echo-capped",
  "echo-under-cap",
  "json_schema",
  "json_schema-history",
  "new-user",
  "queued-user",
  "user-during-echo",
  "failed",
  "failed-after-success",
  "sibling-tool",
] as const) {
  const structured = scenario.startsWith("json_schema")
  const priorCommit = scenario === "json_schema-history"
  const tinyCap = scenario === "echo-capped" || scenario === "echo-under-cap"
  const name = {
    text: "text requests offer answer_commit and immediately echo a successful commit without a step limit",
    "echo-length": "a length-limited echo is replaced with the stored committed output verbatim",
    "echo-mismatch": "a mismatched echo delivers the committed output exactly once to run output and ACP",
    "echo-no-text": "a stop echo without text publishes the committed output as a completed timed text part",
    "echo-other": "an echo with an other finish keeps its finish and original text",
    "echo-exact-length": "an exact echo with a length finish ends normally with stop",
    "echo-capped": "a dispatch-capped commit preserves the full rendered answer in the final assistant text",
    "echo-under-cap": "a commit below the dispatch cap preserves the rendered answer in the final assistant text",
    json_schema: "json_schema requests omit answer_commit and never enter echo mode",
    "json_schema-history": "json_schema requests preserve masked commit history without re-advertising answer_commit",
    "new-user": "a new user message resets a successful commit before the next step",
    "queued-user": "a user message persisted after the snapshot keeps tools enabled and prevents stale echo",
    "user-during-echo": "a user message persisted during echo generation is answered on the next step",
    failed: "a failed commit leaves tools available for repair",
    "failed-after-success": "a successful commit followed by validation failure leaves tools available for repair",
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
            ...(scenario === "echo-capped"
              ? {
                  rows: {
                    columns: ["Region", "Revenue"],
                    values: Array.from({ length: 30 }, (_, i) => [`Region ${i + 1}`, (i + 1) * 100]),
                  },
                }
              : { fields: [{ name: "", value: 42 }] }),
            answer_only: true,
            basis: "Counted all records at record grain using records.id.",
          }
          const renderedAnswer = renderAnswer(args)
          let queuedUserID: MessageID | undefined
          const insertUser = async () => {
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
            queuedUserID = userID
          }
          const language = createOpenAICompatible({
            name: "test",
            baseURL: "https://unused.invalid/v1",
            fetch: Object.assign(
              async (_url: string | URL | Request, init?: RequestInit) => {
                if (typeof init?.body !== "string") throw new Error("expected a JSON request body")
                requests.push(JSON.parse(init.body))
                if (requests.length > (priorCommit ? 4 : scenario === "user-during-echo" ? 3 : 2))
                  throw new Error("unexpected extra generation")
                const step = priorCommit && requests.length > 2 ? requests.length - 2 : requests.length
                if (
                  (scenario === "new-user" && requests.length === 1) ||
                  (scenario === "user-during-echo" && requests.length === 2)
                ) {
                  await insertUser()
                }
                const response =
                  step === 1
                    ? // The structured case deliberately attempts a stale commit call to verify it cannot activate echo mode.
                      scenario === "sibling-tool"
                      ? reply().tool("answer_commit", args).tool("tool_lookup", { tool_name: "__missing_tool" }).item()
                      : scenario === "failed-after-success"
                        ? reply().tool("answer_commit", args).tool("answer_commit", {}).item()
                        : reply()
                            .tool("answer_commit", scenario === "failed" ? {} : args)
                            .item()
                    : scenario === "echo-no-text"
                      ? reply().stop().item()
                      : structured && (!priorCommit || requests.length > 2)
                        ? reply().tool("StructuredOutput", { count: 42 }).item()
                        : reply()
                            .text(
                              scenario === "new-user" || scenario === "queued-user" || step === 3
                                ? "3"
                                : scenario === "echo-length"
                                  ? "4"
                                  : scenario === "echo-mismatch" || scenario === "echo-other"
                                    ? "The answer is 42."
                                    : "42",
                            )
                            .stop()
                            .item()
                if (response.type !== "sse") throw new Error("expected SSE response")
                const chunks = [...response.head, ...response.tail]
                if (step === 1 && scenario === "failed-after-success") {
                  // OpenAI-compatible streams identify distinct calls by index, including calls to the same tool.
                  let index = -1
                  for (const chunk of chunks) {
                    const event = chunk as {
                      choices?: { delta?: { tool_calls?: { id?: string; index: number }[] } }[]
                    }
                    for (const choice of event.choices ?? []) {
                      for (const call of choice.delta?.tool_calls ?? []) {
                        if (call.id) index++
                        call.index = index
                      }
                    }
                  }
                }
                if (
                  step === 2 &&
                  (scenario === "echo-length" || scenario === "echo-exact-length" || scenario === "echo-other")
                ) {
                  for (const chunk of chunks) {
                    const event = chunk as { choices?: { finish_reason?: string }[] }
                    for (const choice of event.choices ?? []) {
                      if (choice.finish_reason === "stop")
                        choice.finish_reason = scenario === "echo-other" ? "other" : "length"
                    }
                  }
                }
                return new Response(
                  chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
                  { headers: { "Content-Type": "text/event-stream" } },
                )
              },
              { preconnect: () => undefined },
            ),
          }).chatModel("test-model")
          const languageSpy = spyOn(Provider, "getLanguage").mockResolvedValue(language)
          const toModelMessages = MessageV2.toModelMessages
          const historySpy = spyOn(MessageV2, "toModelMessages").mockImplementation(async (...input) => {
            const messages = await toModelMessages(...input)
            if (scenario === "queued-user" && requests.length === 1 && !queuedUserID) await insertUser()
            return messages
          })
          const output = new OutputCollector()
          const textUpdates: MessageV2.TextPart[] = []
          const textPartIDs = new Set<PartID>()
          const textDeltas: { messageID: MessageID; text: string }[] = []
          const collect = ({ payload: event }: GlobalEvent) => {
            if (event.type === MessageV2.Event.PartUpdated.type) {
              const part = event.properties.part as MessageV2.Part
              if (part.sessionID !== chat.id) return
              if (part.type === "step-start") output.stepStart()
              if (part.type !== "text") return
              // Snapshot the published value: later mutations must not rewrite what a client observed.
              textUpdates.push(structuredClone(part))
              textPartIDs.add(part.id)
              // Match run.ts: only completed text parts are printed and collected for --output.
              if (part.time?.end) output.text(part.text.trim(), { synthetic: part.synthetic === true })
            }
            if (
              event.type === MessageV2.Event.PartDelta.type &&
              event.properties.sessionID === chat.id &&
              event.properties.field === "text" &&
              textPartIDs.has(event.properties.partID)
            ) {
              // ACP forwards deltas for known text parts and ignores later text updates.
              textDeltas.push({ messageID: event.properties.messageID, text: event.properties.delta })
            }
          }
          GlobalBus.on("event", collect)
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
            expect(requests).toHaveLength(priorCommit ? 4 : scenario === "user-during-echo" ? 3 : 2)
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
              if (scenario === "failed-after-success") {
                expect(
                  messages
                    .flatMap((message) => message.parts)
                    .filter((part) => part.type === "tool" && part.tool === "answer_commit")
                    .map((part) => part.type === "tool" && part.state.status),
                ).toEqual(["completed", "error"])
              }
              if (scenario === "text" || scenario === "sibling-tool" || scenario.startsWith("echo-")) {
                if (commit?.type !== "tool" || commit.state.status !== "completed") throw new Error("missing commit")
                expect(tools(1)).toEqual([])
                expect(JSON.stringify(requests[1].messages)).toContain(echoInstruction)
                // The echo instruction must be the final user turn: Bedrock's Converse API rejects
                // a conversation that ends with an assistant message.
                const last = requests[1].messages.at(-1) as { role?: string; content?: unknown }
                expect(last.role).toBe("user")
                expect(JSON.stringify(last.content)).toContain(echoInstruction)
                if (tinyCap) {
                  expect(Token.estimate(commit.state.output)).toBeLessThanOrEqual(100)
                  if (scenario === "echo-capped") {
                    expect(Token.estimate(renderedAnswer)).toBeGreaterThan(100)
                    expect(commit.state.output).not.toBe(renderedAnswer)
                    expect(commit.state.output).toContain("truncated before dispatch")
                  } else {
                    expect(commit.state.output).toBe(renderedAnswer)
                  }
                  expect(requests[1].messages).toContainEqual(
                    expect.objectContaining({ content: expect.stringContaining(commit.state.output) }),
                  )
                  expect(last.content).toBe(echoInstruction)
                }
                const expectedText = scenario === "echo-other" ? "The answer is 42." : renderedAnswer
                expect(result.info).toHaveProperty("finish", scenario === "echo-other" ? "other" : "stop")
                expect(result.parts).toContainEqual(expect.objectContaining({ type: "text", text: expectedText }))
                if (scenario === "echo-no-text") {
                  const part = result.parts.find((part) => part.type === "text")
                  if (part?.type !== "text" || !part.time) throw new Error("missing completed echo text")
                  expect(typeof part.time.start).toBe("number")
                  expect(typeof part.time.end).toBe("number")
                  expect(part.time.end).toBeGreaterThanOrEqual(part.time.start)
                }
                expect(
                  result.parts
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join(""),
                ).toBe(expectedText)
                const finalUpdates = textUpdates.filter((part) => part.messageID === result.info.id)
                expect(finalUpdates.filter((part) => part.time?.end).map((part) => part.text)).toEqual([expectedText])
                expect(output.content()).toBe(expectedText)
                expect(
                  textDeltas
                    .filter((part) => part.messageID === result.info.id)
                    .map((part) => part.text)
                    .join(""),
                ).toBe(expectedText)
                if (scenario === "echo-capped") expect(commit.state.metadata.committed_text).toBe(renderedAnswer)
                if (scenario === "text") {
                  // A correct echo publishes only its initial and completed text parts.
                  expect(finalUpdates).toHaveLength(2)
                }
              } else if (scenario === "user-during-echo") {
                expect(tools(1)).toEqual([])
                expect(JSON.stringify(requests[1].messages)).toContain(echoInstruction)
                expect(tools(2)).toContain("answer_commit")
                expect(JSON.stringify(requests[2].messages)).not.toContain(echoInstruction)
                expect(JSON.stringify(requests[2].messages)).toContain("A new question: how many sources?")
                expect(result.info).toHaveProperty("parentID", queuedUserID)
                expect(result.parts).toContainEqual(expect.objectContaining({ type: "text", text: "3" }))
              } else {
                expect(tools(1)).toContain("answer_commit")
                expect(JSON.stringify(requests[1].messages)).not.toContain(echoInstruction)
                if (scenario === "queued-user") {
                  expect(queuedUserID).toBeDefined()
                  expect(JSON.stringify(requests[1].messages)).toContain("A new question: how many sources?")
                  expect(result.info).toHaveProperty("parentID", queuedUserID)
                  expect(result.parts).toContainEqual(expect.objectContaining({ type: "text", text: "3" }))
                }
              }
            }
          } finally {
            GlobalBus.off("event", collect)
            historySpy.mockRestore()
            languageSpy.mockRestore()
          }
        }),
      ),
    {
      config: {
        snapshot: false,
        learn: { enabled: false },
        ...(tinyCap ? { tool_output: { dispatch_max_tokens: 100 } } : {}),
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

test("analyst prompt gives StructuredOutput precedence only when an output JSON schema is supplied", async () => {
  const prompt = await Bun.file(new URL("../../src/altimate/prompts/analyst.txt", import.meta.url)).text()
  expect(prompt).toContain(
    "When the request supplies an output JSON schema (the `StructuredOutput` tool is available), finish with `StructuredOutput` instead of `answer_commit` or a plain-text reply; follow that schema. The text finalization rules below apply when no output schema is supplied.",
  )
  expect(prompt).not.toContain("When a JSON schema is requested")
})
