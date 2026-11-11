// The marked system prefix (the first system message, which carries the cache breakpoint) must be
// byte-identical across the requests of a session. Text that appears on some steps only is hoisted
// out of the user turn on models that are not Anthropic-like, which includes the Altimate gateway's
// OpenAI-compatible model. It must ride after the breakpoint, or that request re-creates the whole
// prefix at full input rate. Driven through the real prompt loop against a mock OpenAI-compatible
// server, so a change to how `prompt.ts` assembles the request is what this test sees.
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session } from "@/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionSummary } from "../../src/session/summary"
import { MessageID } from "../../src/session/schema"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { provideTmpdirServerLegacy } from "./legacy-instance"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { RuntimeFlags } from "@/effect/runtime-flags"

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    remove: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    entry: () => Effect.succeed(undefined),
    listMeta: () => Effect.succeed(undefined),
    snapshot: () => Effect.succeed({ tools: {}, meta: undefined }),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  SessionSummary.node,
  Database.node,
  CrossSpawnSpawner.node,
  LayerNode.make(TestLLMServer.layer, []),
])
const it = testEffect(
  LayerNode.buildLayer(root, {
    replacements: [
      LayerNode.replace(MCP.node, mcp),
      LayerNode.replace(LSP.node, lsp),
      LayerNode.replace(RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })),
    ],
  }),
)

// Declared under an Altimate provider id: only those receive the trace.
const providerCfg = (url: string) => ({
  provider: {
    "altimate-backend": {
      name: "Altimate (test)",
      id: "altimate-backend",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
  model: "altimate-backend/test-model",
})

const SWITCH_MARK = "Your operational mode has changed from plan to build."

type ChatMessage = { role: string; content: unknown }
const chatMessages = (body: Record<string, unknown>) => (Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : [])
const text = (content: unknown) => (typeof content === "string" ? content : JSON.stringify(content))

it.live("a hoisted reminder rides after the breakpoint: the first system message is unchanged", () =>
  provideTmpdirServerLegacy(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "prefix stability",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const turn = Effect.fnUntraced(function* (agent: string, said: string) {
        yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes(said), "ok")
        yield* prompt.prompt({ sessionID: session.id, agent, parts: [{ type: "text", text: said }] })
      })
      // builder, then plan, then builder again: the third turn carries the hoisted
      // plan-to-build switch reminder; the first carries no reminder at all.
      yield* turn("builder", "first builder turn")
      yield* turn("plan", "plan turn")
      yield* turn("builder", "second builder turn")

      const hits = (yield* llm.hits).filter((hit) => !JSON.stringify(hit.body).includes("Generate a title"))
      const of = (said: string) => hits.find((hit) => JSON.stringify(hit.body).includes(said))!
      const before = chatMessages(of("first builder turn").body)
      const after = chatMessages(of("second builder turn").body)
      const systems = (messages: ChatMessage[]) => messages.filter((m) => m.role === "system").map((m) => text(m.content))
      // Precondition: the reminder was sent on the later turn, as system text.
      expect(systems(after).some((s) => s.includes(SWITCH_MARK))).toBe(true)
      expect(systems(before).some((s) => s.includes(SWITCH_MARK))).toBe(false)
      // The marked prefix is byte-identical; the reminder is not in it.
      expect(before[0].role).toBe("system")
      expect(after[0].role).toBe("system")
      expect(text(after[0].content)).toBe(text(before[0].content))
      expect(text(after[0].content)).not.toContain(SWITCH_MARK)
    }),
    { git: true, config: providerCfg },
  ),
  { timeout: 30_000 },
)

// After a compaction the original task is pinned and hoisted on this model. The environment
// message carries the last system cache breakpoint; on the gateway that breakpoint is the one a
// short prompt hits, so the pin must not be folded into it. It rides as its own trailing system
// message, after the marked environment message.
const PIN_MARK = "Original task — authoritative over any summary"
const marked = (message: ChatMessage) => JSON.stringify(message).includes("cache_control")

it.live("after a compaction the task pin is its own message after the marked environment message", () =>
  provideTmpdirServerLegacy(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "prefix stability across compaction",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      // Overflow -> compaction summary -> continuation, which carries the pinned task.
      yield* llm.error(413, { error: { message: "request entity too large" } })
      yield* llm.text("summary of the conversation so far")
      yield* llm.text("final answer after compaction")
      yield* prompt.prompt({
        sessionID: session.id,
        messageID: MessageID.ascending(),
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "count the rows in the orders table" }],
      })
      yield* prompt.loop({ sessionID: session.id })

      const messages = yield* sessions.messages({ sessionID: session.id })
      expect(messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(true)
      const systemsOf = (body: Record<string, unknown>) => chatMessages(body).filter((m) => m.role === "system")
      const hits = (yield* llm.hits).filter((hit) => !JSON.stringify(hit.body).includes("Generate a title"))
      const before = systemsOf(hits[0].body)
      const after = systemsOf(hits.findLast((hit) => JSON.stringify(hit.body).includes(PIN_MARK))!.body)

      // Precondition: no pin before the compaction; header + environment, both marked.
      expect(before.some((m) => text(m.content).includes(PIN_MARK))).toBe(false)
      expect(before.length).toBe(2)
      // Header and environment are byte-identical and keep their cache marks.
      expect(text(after[0].content)).toBe(text(before[0].content))
      expect(text(after[1].content)).toBe(text(before[1].content))
      expect(marked(before[1])).toBe(true)
      expect(marked(after[1])).toBe(true)
      // The pin is a separate, unmarked, trailing system message.
      expect(after.length).toBe(3)
      expect(text(after[2].content)).toContain(PIN_MARK)
      expect(marked(after[2])).toBe(false)
      expect(after.slice(0, 2).some((m) => text(m.content).includes(PIN_MARK))).toBe(false)
    }),
    { git: true, config: providerCfg },
  ),
  { timeout: 30_000 },
)
