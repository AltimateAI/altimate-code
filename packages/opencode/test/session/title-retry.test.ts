// altimate_change - new file
/**
 * Session titles through the real prompt loop. A failed title request no longer leaves the
 * `New session - <time>` placeholder for the life of the session: the next turns retry with the
 * first message as context, a bounded number of times, and each failure is reported with the
 * provider's error rather than the SDK's generic "No output generated".
 */
import { expect, spyOn } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session } from "@/session/session"
import { Session as LegacySession } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionSummary } from "../../src/session/summary"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Telemetry } from "@/telemetry"
import { testEffect } from "../lib/effect"
import { TestLLMServer, httpError } from "../lib/llm-server"
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

const TITLE_MARKER = "Generate a title for this conversation"
const PROVIDER_REJECTION = { error: { message: "Thinking budget is not supported for this model." } }

type Failed = Extract<Telemetry.Event, { type: "title_generation_failed" }>

/** Records title failure events for the duration of the test. */
const recordTitleFailures = Effect.acquireRelease(
  Effect.sync(() => {
    const events: Failed[] = []
    const spy = spyOn(Telemetry, "track").mockImplementation((event) => {
      if (event.type === "title_generation_failed") events.push(event)
    })
    return { events, spy }
  }),
  ({ spy }) => Effect.sync(() => spy.mockRestore()),
)

/** The title request is fire-and-forget, so the session row is polled until it changes or the wait runs out. */
const titleAfter = Effect.fnUntraced(function* (sessionID: Session.Info["id"], settled: (title: string) => boolean) {
  const sessions = yield* Session.Service
  let title = ""
  for (let i = 0; i < 150; i++) {
    title = (yield* sessions.get(sessionID)).title
    if (settled(title)) return title
    yield* Effect.sleep("20 millis")
  }
  return title
})

it.live(
  "a failed title request is retried on the next turn with the first message as context",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ llm }) {
        const { events } = yield* recordTitleFailures
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        expect(LegacySession.isDefaultTitle(session.title)).toBe(true)

        // The provider rejects the first title request; the automatic "E2E Title" answers the next one.
        yield* llm.title(httpError(400, PROVIDER_REJECTION))
        yield* llm.text("first answer")
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "first message" }],
        })
        yield* llm.wait(2)

        // The placeholder stands after the failure, and the failure names the provider's error.
        let failed = events
        for (let i = 0; i < 150 && failed.length === 0; i++) {
          yield* Effect.sleep("20 millis")
          failed = events
        }
        expect(failed).toHaveLength(1)
        expect(failed[0]).toMatchObject({
          provider_id: "test",
          model_id: "test-model",
          attempt: 1,
          http_status: 400,
        })
        expect(typeof failed[0].error_type).toBe("string")
        expect(LegacySession.isDefaultTitle((yield* sessions.get(session.id)).title)).toBe(true)

        yield* llm.text("second answer")
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "second message" }],
        })

        // The second turn retried and the retry's answer became the title.
        const title = yield* titleAfter(session.id, (t) => !LegacySession.isDefaultTitle(t))
        expect(title).toBe("E2E Title")

        const titleHits = (yield* llm.hits).filter((hit) => JSON.stringify(hit.body).includes(TITLE_MARKER))
        expect(titleHits).toHaveLength(2)
        // Both requests describe the conversation's start, not the turn that triggered the retry.
        for (const hit of titleHits) {
          const body = JSON.stringify(hit.body)
          expect(body).toContain("first message")
          expect(body).not.toContain("second message")
        }
        expect(events).toHaveLength(1)
      }),
      { git: true, config: providerCfg },
    ),
  { timeout: 60_000 },
)

it.live(
  "a title that keeps failing is given up after five turns",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ llm }) {
        const { events } = yield* recordTitleFailures
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        // Enough rejections for every turn: the sixth turn must not ask at all.
        for (let i = 0; i < 6; i++) yield* llm.title(httpError(400, PROVIDER_REJECTION))
        for (let i = 1; i <= 6; i++) {
          yield* llm.text(`answer ${i}`)
          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            parts: [{ type: "text", text: `message ${i}` }],
          })
        }
        // Two requests per turn for the first five turns, one for the sixth.
        yield* llm.wait(11)

        const titleHits = (yield* llm.hits).filter((hit) => JSON.stringify(hit.body).includes(TITLE_MARKER))
        expect(titleHits).toHaveLength(5)
        expect(LegacySession.isDefaultTitle((yield* sessions.get(session.id)).title)).toBe(true)
        expect(events.map((event) => event.attempt)).toEqual([1, 2, 3, 4, 5])
      }),
      { git: true, config: providerCfg },
    ),
  { timeout: 90_000 },
)
