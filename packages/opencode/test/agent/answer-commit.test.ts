import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { ToolLookupTool } from "../../src/altimate/tools/tool-lookup"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import type { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageID, SessionID } from "../../src/session/schema"
import { SessionTools } from "../../src/session/tools"
import { ToolRegistry } from "../../src/tool/registry"
import { Truncate } from "../../src/tool/truncate"
import { initTool } from "../altimate/tool-fixture"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { withLegacyInstance } from "../session/legacy-instance"

const model = { providerID: ProviderID.opencode, modelID: ModelID.make("test") }
const it = testEffect(Layer.mergeAll(Agent.defaultLayer, ToolRegistry.layer))
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
