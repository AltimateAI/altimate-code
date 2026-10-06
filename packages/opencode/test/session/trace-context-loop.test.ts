/**
 * Client trace propagation through the real prompt loop: each turn's gateway calls carry that
 * turn's trace, an untraced turn carries none, and nothing outlives the turn that bound it.
 */
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session } from "@/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionSummary } from "../../src/session/summary"
import { MessageID } from "../../src/session/schema"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { TraceContext } from "../../src/altimate/observability/trace-context"
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
    listMeta: () => Effect.succeed(undefined),
    snapshot: () => Effect.succeed({ tools: {}, meta: undefined }),
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

const TRACE_A = "0af7651916cd43dd8448eb211c80319c"
const TRACE_B = "4bf92f3577b34da6a3ce929d0e0e4736"
const traceparent = (traceId: string) => `00-${traceId}-b7ad6b7169203331-01`

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

const traceOf = (headers: Record<string, string>) => /^00-([0-9a-f]{32})-/.exec(headers["traceparent"] ?? "")?.[1]

it.live("each turn's gateway calls carry that turn's trace, released when the turn ends", () =>
  provideTmpdirServerLegacy(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "trace turns",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const turn = Effect.fnUntraced(function* (text: string, trace?: string) {
        const messageID = MessageID.ascending()
        TraceContext.bind(messageID, trace && traceparent(trace))
        yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes(text), "ok")
        yield* prompt.prompt({ sessionID: session.id, messageID, agent: "build", parts: [{ type: "text", text }] })
        const hits = yield* llm.hits
        const chat = hits.filter((hit) => JSON.stringify(hit.body).includes(text))
        return { messageID, chat }
      })

      // Turn A, traced: its call carries A, and the binding is gone once the turn ends.
      const a = yield* turn("first traced turn", TRACE_A)
      expect(a.chat.length).toBeGreaterThan(0)
      for (const hit of a.chat) expect(traceOf(hit.headers)).toBe(TRACE_A)
      expect(hit(a.chat).headers["x-request-id"]?.startsWith(`${TRACE_A}-`)).toBe(true)
      expect(TraceContext.traceId(a.messageID)).toBeUndefined()
      expect(TraceContext.activeTraceId(session.id)).toBeUndefined()

      // Turn B, untraced, same session: no trace — A's must not linger.
      const b = yield* turn("second untraced turn")
      expect(b.chat.length).toBeGreaterThan(0)
      for (const hit of b.chat) expect(traceOf(hit.headers)).toBeUndefined()

      // Turn C, traced differently: its own trace, not A's.
      const c = yield* turn("third traced turn", TRACE_B)
      expect(c.chat.length).toBeGreaterThan(0)
      for (const hit of c.chat) expect(traceOf(hit.headers)).toBe(TRACE_B)
    }),
    { git: true, config: providerCfg },
  ),
  { timeout: 20_000 },
)

it.live("a turn that overflows and auto-compacts keeps its trace on every call, before and after", () =>
  provideTmpdirServerLegacy(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "trace compaction",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const messageID = MessageID.ascending()
      TraceContext.bind(messageID, traceparent(TRACE_A))
      // Overflow -> compaction summary -> continuation: the loop writes the compaction marker and
      // the continue message itself; both must carry the turn on.
      yield* llm.error(413, { error: { message: "request entity too large" } })
      yield* llm.text("summary of the conversation so far")
      yield* llm.text("final answer after compaction")
      yield* prompt.prompt({
        sessionID: session.id,
        messageID,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "long turn that overflows" }],
      })
      yield* prompt.loop({ sessionID: session.id })

      const messages = yield* sessions.messages({ sessionID: session.id })
      expect(messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(true)
      const hits = yield* llm.hits
      // The overflowing call, the summariser and the continuation (plus any title call).
      expect(hits.length).toBeGreaterThanOrEqual(3)
      for (const hit of hits) expect(traceOf(hit.headers)).toBe(TRACE_A)
      expect(TraceContext.activeTraceId(session.id)).toBeUndefined()
    }),
    { git: true, config: providerCfg },
  ),
  { timeout: 30_000 },
)

function hit<T>(hits: T[]): T {
  return hits[hits.length - 1]
}
