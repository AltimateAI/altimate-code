/**
 * After a compaction that keeps a tail, the next loop iteration must go straight to the
 * agent: the retained pre-compaction assistant still carries its overflowing usage, and
 * reading it as the latest finished turn compacted a second time from the tail alone.
 */
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session } from "@/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionSummary } from "../../src/session/summary"
import { MessageID, PartID } from "../../src/session/schema"
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

const model = { providerID: "altimate-backend", modelID: "test-model" } as any
const usage = (input: number) => ({ input, output: 100, reasoning: 0, cache: { read: 0, write: 0 } })

it.live(
  "a completed tail-keeping compaction is followed by the agent request, not a second summary",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({
          title: "compacted once",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const sessionID = session.id
        const user = Effect.fnUntraced(function* (part: Record<string, any>) {
          const msg = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID,
            agent: "build",
            model,
            time: { created: Date.now() },
          } as any)
          yield* sessions.updatePart({ id: PartID.ascending(), messageID: msg.id, sessionID, ...part } as any)
          return msg
        })
        const assistant = Effect.fnUntraced(function* (parentID: MessageID, input: number, extra: Record<string, any>) {
          const msg = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "assistant",
            sessionID,
            mode: "build",
            agent: "build",
            path: { cwd: dir, root: dir },
            cost: 0,
            tokens: usage(input),
            modelID: model.modelID,
            providerID: model.providerID,
            parentID,
            time: { created: Date.now(), completed: Date.now() },
            ...extra,
          } as any)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID,
            type: "text",
            text: extra.summary ? "summary of the work so far" : "working",
          } as any)
          return msg
        })

        // [tail user, overflowing assistant] -> compaction keeping that tail -> summary -> continue.
        const tail = yield* user({ type: "text", text: "continue the task" })
        yield* assistant(tail.id, 95_000, { finish: "stop" })
        const compaction = yield* user({ type: "compaction", auto: true, tail_start_id: tail.id })
        yield* assistant(compaction.id, 2_000, {
          summary: true,
          finish: "stop",
          mode: "compaction",
          agent: "compaction",
        })
        yield* user({ type: "text", text: "Continue if you have next steps.", synthetic: true })

        yield* llm.text("agent reply after compaction")
        yield* llm.text("agent reply after compaction")
        yield* prompt.loop({ sessionID })

        const messages = yield* sessions.messages({ sessionID })
        const compactionUsers = messages.filter((m) => m.parts.some((part) => part.type === "compaction"))
        const summaries = messages.filter((m) => m.info.role === "assistant" && (m.info as any).summary === true)
        expect(compactionUsers.length).toBe(1)
        expect(summaries.length).toBe(1)
        const hits = yield* llm.hits
        expect(hits.length).toBeGreaterThan(0)
        expect(JSON.stringify(hits[0]!.body)).not.toContain("summary of the conversation")
      }),
      { git: true, config: providerCfg },
    ),
  { timeout: 30_000 },
)
