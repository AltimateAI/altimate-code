// altimate_change - new file
/**
 * The workspace engine's turn boundary through the real prompt loop. A message sent while the
 * assistant is busy joins the running loop instead of starting one; it still gets its own boundary,
 * so an engine installed meanwhile attaches on it. The messages the loop writes itself (here the
 * compaction marker and continue message after an overflow) do not get one.
 */
import { expect, spyOn } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session } from "@/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionSummary } from "../../src/session/summary"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import * as WorkspaceEngine from "../../src/altimate/workspace/engine-overlay"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { provideTmpdirServerLegacy, withLegacyInstance } from "./legacy-instance"
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
    test: {
      name: "Test",
      id: "test",
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
  model: "test/test-model",
})

/** Counts the loop's turn boundaries, calling through to the real one. */
const countBoundaries = Effect.acquireRelease(
  Effect.sync(() => spyOn(WorkspaceEngine, "atTurnStart")),
  (spy) => Effect.sync(() => spy.mockRestore()),
)

it.live("a message sent while the assistant is busy gets its own turn boundary in the same loop", () =>
  provideTmpdirServerLegacy(
    Effect.fnUntraced(function* ({ llm }) {
      const boundaries = yield* countBoundaries
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "queued message",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const gate = Promise.withResolvers<void>()
      yield* llm.hold("first answer", gate.promise)
      yield* llm.text("second answer")

      const first = yield* prompt
        .prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "first message" }] })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)
      expect(boundaries).toHaveBeenCalledTimes(1)

      // Resumed by the LLM server's request, this fiber has lost the instance context; restore it.
      const second = yield* withLegacyInstance(
        prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "sent while busy" }] }),
      ).pipe(Effect.forkChild)
      // The second message is saved while the first answer is still on hold. Asserted, not just
      // awaited: released early, it could start a loop of its own and get a boundary that way.
      let saved = false
      for (let i = 0; i < 100 && !saved; i++) {
        const messages = yield* sessions.messages({ sessionID: session.id })
        saved = messages.some(
          (msg) => msg.info.role === "user" && msg.parts.some((p) => p.type === "text" && p.text === "sent while busy"),
        )
        if (!saved) yield* Effect.sleep("20 millis")
      }
      expect(saved).toBe(true)
      gate.resolve()
      yield* Fiber.join(first)
      yield* Fiber.join(second)

      // One loop served both messages: the second reached the model in the same run.
      const hits = (yield* llm.hits).filter((hit) => !JSON.stringify(hit.body).includes("Generate a title"))
      expect(hits).toHaveLength(2)
      expect(JSON.stringify(hits[1].body)).toContain("sent while busy")
      // And it got a boundary of its own, so the engine is reconciled and the tools re-pinned for it.
      expect(boundaries).toHaveBeenCalledTimes(2)
    }),
    { git: true, config: providerCfg },
  ),
  { timeout: 30_000 },
)

it.live("an overflow that compacts and continues stays one turn: one boundary", () =>
  provideTmpdirServerLegacy(
    Effect.fnUntraced(function* ({ llm }) {
      const boundaries = yield* countBoundaries
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "compaction",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      // Overflow -> compaction summary -> continuation: the loop writes the compaction marker and
      // the continue message itself.
      yield* llm.error(413, { error: { message: "request entity too large" } })
      yield* llm.text("summary of the conversation so far")
      yield* llm.text("final answer after compaction")
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "long turn that overflows" }],
      })
      yield* prompt.loop({ sessionID: session.id })

      const messages = yield* sessions.messages({ sessionID: session.id })
      expect(messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(true)
      expect((yield* llm.hits).length).toBeGreaterThanOrEqual(3)
      expect(boundaries).toHaveBeenCalledTimes(1)
    }),
    { git: true, config: providerCfg },
  ),
  { timeout: 30_000 },
)
