/**
 * The pre-send context guard and the compaction trigger must agree.
 *
 * The guard (`clampOutputTokens`) refuses a request whose character-based size estimate leaves
 * no room for a response; compaction (`SessionCompaction.isOverflow`) fires on provider-reported
 * usage. The character estimate runs well above real token counts on SQL- and JSON-heavy context,
 * so a session below the compaction threshold used to be refused by the guard and end with
 * "Context budget exceeded before the request was sent" without compaction ever running.
 */
import { describe, expect, test } from "bun:test"
import path from "node:path"
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
import {
  InputTokenBudgetError,
  OutputTokenBudgetError,
  ReasoningTokenBudgetError,
  calibratedInputTokens,
  estimateInputTokens,
  isContextBudgetError,
  reportedContextTokens,
} from "../../src/provider/output-token-budget"

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

const model = { providerID: "altimate-backend", modelID: "test-model" } as any

/** A local OpenAI-compatible model with the given window. */
const providerCfg = (limit: { context: number; output: number }) => (url: string) => ({
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
          limit,
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
  model: "altimate-backend/test-model",
})

const LARGE_WINDOW = { context: 131_072, output: 16_384 }
const SMALL_WINDOW = { context: 16_384, output: 4_096 }
// isOverflow's trigger for LARGE_WINDOW: context minus max(20_000 reserved, 16_384 output).
const LARGE_WINDOW_COMPACTION_THRESHOLD = 131_072 - 20_000

const SQL = [
  "with paid as (",
  "  select o.order_id, o.customer_id, o.created_at::date as order_date,",
  "         sum(li.amount_cents) filter (where li.status = 'paid') as paid_cents",
  "  from analytics.orders o",
  "  join analytics.line_items li on li.order_id = o.order_id",
  "  where o.created_at >= '2026-01-01' and o.region in ('emea', 'apac')",
  "  group by 1, 2, 3",
  ")",
  "select customer_id, count(*) as orders, sum(paid_cents) / 100.0 as revenue",
  "from paid group by customer_id order by revenue desc limit 50;",
].join("\n")

/** One query and its JSON result rows, the shape a data agent's history accumulates. */
function sqlResultBlock(seed: number): string {
  const rows = Array.from({ length: 25 }, (_, row) => ({
    customer_id: `cus_${(seed * 131 + row * 17).toString(36).padStart(8, "0")}`,
    orders: (seed * 7 + row) % 97,
    revenue: Number((((seed + 3) * (row + 11) * 37.13) % 100_000).toFixed(2)),
    region: row % 2 === 0 ? "emea" : "apac",
    first_order_date: `2026-0${(row % 9) + 1}-${String((seed % 27) + 1).padStart(2, "0")}`,
  }))
  return `Query ${seed}:\n${SQL}\nResult:\n${JSON.stringify(rows, null, 2)}\n`
}

/** SQL/JSON history whose character estimate is at least `target` tokens. */
function sqlJsonHistory(target: number): string {
  const blocks: string[] = []
  let estimate = 0
  for (let seed = 0; estimate < target; seed++) {
    const block = sqlResultBlock(seed)
    blocks.push(block)
    estimate += estimateInputTokens({ system: [], messages: [{ role: "user", content: block }] })
  }
  return blocks.join("\n")
}

/**
 * Earlier turns (`user`, answered without usage), then the turn whose answer reported
 * `assistantUsage` (optionally from another model, as a mid-turn step, or with its own text).
 */
type Seeded = {
  user: string | string[]
  assistantUsage?: number
  next?: string
  last?: { modelID?: string; finish?: string; text?: string }
}

/** Seed [user history, finished assistant with provider usage, new user turn] and run the loop. */
const runSession = (dir: string, llm: TestLLMServer["Service"], seeded: Seeded) =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "context guard",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const sessionID = session.id
    const user = Effect.fnUntraced(function* (text: string) {
      const msg = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID,
        agent: "build",
        model,
        time: { created: Date.now() },
      } as any)
      yield* sessions.updatePart({ id: PartID.ascending(), messageID: msg.id, sessionID, type: "text", text } as any)
      return msg
    })
    const answer = Effect.fnUntraced(function* (parentID: MessageID, usage: number, last: Seeded["last"] = {}) {
      const msg = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        sessionID,
        mode: "build",
        agent: "build",
        path: { cwd: dir, root: dir },
        cost: 0,
        tokens: { input: usage, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: last.modelID ?? model.modelID,
        providerID: model.providerID,
        parentID,
        finish: last.finish ?? "stop",
        time: { created: Date.now(), completed: Date.now() },
      } as any)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID,
        type: "text",
        text: last.text ?? "The top customers by paid revenue are listed above.",
      } as any)
    })
    const turns = Array.isArray(seeded.user) ? seeded.user : [seeded.user]
    for (const [index, text] of turns.entries()) {
      const msg = yield* user(text)
      const last = index === turns.length - 1
      if (!last) yield* answer(msg.id, 0)
      else if (seeded.assistantUsage !== undefined) yield* answer(msg.id, seeded.assistantUsage, seeded.last)
    }
    if (seeded.next !== undefined) yield* user(seeded.next)

    yield* prompt.loop({ sessionID })

    const messages = yield* sessions.messages({ sessionID })
    const assistants = messages.filter((m) => m.info.role === "assistant").map((m) => m.info as any)
    return {
      messages,
      hits: yield* llm.hits,
      summaries: assistants.filter((info) => info.summary === true),
      errors: assistants.filter((info) => info.error).map((info) => JSON.stringify(info.error)),
      compactions: messages.filter((m) => m.parts.some((part) => part.type === "compaction")),
    }
  })

it.live(
  "a SQL/JSON-heavy session below the compaction threshold is sent, not refused by the guard",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ dir, llm }) {
        // The provider counted this conversation as 108k tokens, below the 111k compaction trigger.
        // The character estimate of the SQL/JSON history plus the build agent's system prompt and
        // tool schemas comes to roughly 130k+, past the guard's limit (131,072 less the 1,024-token
        // response floor and a 2% margin): the ~20% overestimate seen on SQL/JSON context.
        const history = sqlJsonHistory(88_000)
        const reported = 108_000
        expect(reported).toBeLessThan(LARGE_WINDOW_COMPACTION_THRESHOLD)

        yield* llm.text("Revenue is concentrated in the top ten customers.")
        const result = yield* runSession(dir, llm, {
          user: history,
          assistantUsage: reported,
          next: "Summarize the revenue concentration.",
        })

        expect(result.errors).toEqual([])
        expect(result.hits.length).toBe(1)
        expect(result.compactions.length).toBe(0)
        // The output reservation was not squeezed by the inflated estimate either.
        expect(result.hits[0]!.body.max_tokens).toBe(LARGE_WINDOW.output)
      }),
      { git: true, config: providerCfg(LARGE_WINDOW) },
    ),
  { timeout: 120_000 },
)

it.live(
  "when the guard trips on a compactable session it compacts and then sends the request",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ dir, llm }) {
        // A local server that reports no usage gives compaction nothing to fire on; the guard's
        // estimate is then the only measure, and tripping it must compact rather than end the session.
        const history = sqlJsonHistory(100_000)

        yield* llm.text("summary of the revenue analysis so far")
        yield* llm.text("Revenue is concentrated in the top ten customers.")
        const result = yield* runSession(dir, llm, {
          user: history,
          assistantUsage: 0,
          next: "Summarize the revenue concentration.",
        })

        expect(result.errors).toEqual([])
        expect(result.summaries.length).toBe(1)
        expect(result.hits.length).toBe(2)
        expect(JSON.stringify(result.hits[1]!.body)).toContain("Summarize the revenue concentration.")
      }),
      { git: true, config: providerCfg(LARGE_WINDOW) },
    ),
  { timeout: 120_000 },
)

it.live(
  "a request that is still too big after compaction ends with the budget error, once",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ dir, llm }) {
        // Project instructions alone exceed the window: compacting the conversation cannot help.
        yield* Effect.promise(() => Bun.write(path.join(dir, "AGENTS.md"), sqlJsonHistory(140_000)))
        yield* llm.text("summary of the earlier turn")
        const result = yield* runSession(dir, llm, {
          user: "List the top customers by paid revenue.",
          assistantUsage: 0,
          next: "Summarize the revenue concentration.",
        })

        // One compaction (the summarizer request is the only one sent), then the budget error ends
        // the turn instead of compacting again.
        expect(result.compactions.length).toBe(1)
        expect(result.summaries.length).toBe(1)
        expect(result.hits.length).toBe(1)
        expect(result.errors.length).toBe(1)
        expect(result.errors[0]).toContain("Context budget exceeded before the request was sent")
      }),
      { git: true, config: providerCfg(LARGE_WINDOW) },
    ),
  { timeout: 120_000 },
)

it.live(
  "a first turn with no provider usage is sent when it fits",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ dir, llm }) {
        yield* llm.text("Revenue is concentrated in the top ten customers.")
        const result = yield* runSession(dir, llm, { user: sqlJsonHistory(20_000) })

        expect(result.errors).toEqual([])
        expect(result.hits.length).toBe(1)
        expect(result.compactions.length).toBe(0)
      }),
      { git: true, config: providerCfg(LARGE_WINDOW) },
    ),
  { timeout: 120_000 },
)

it.live(
  "a first turn too big for the window fails with the budget error without compacting",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const result = yield* runSession(dir, llm, { user: sqlJsonHistory(100_000) })

        expect(result.hits.length).toBe(0)
        expect(result.compactions.length).toBe(0)
        expect(result.errors.length).toBe(1)
        expect(result.errors[0]).toContain("Context budget exceeded before the request was sent")
      }),
      { git: true, config: providerCfg(LARGE_WINDOW) },
    ),
  { timeout: 120_000 },
)

it.live(
  "a small-window model whose session fills the window compacts instead of failing",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ dir, llm }) {
        // 16k context: the default 20k compaction reserve exceeds the window, so isOverflow never
        // fires and the guard is the first check to notice the session is full.
        yield* llm.text("summary of the revenue analysis so far")
        yield* llm.text("Revenue is concentrated in the top ten customers.")
        const result = yield* runSession(dir, llm, {
          user: Array.from({ length: 6 }, () => sqlJsonHistory(2_500)),
          assistantUsage: 15_800,
          next: "Summarize the revenue concentration.",
        })

        expect(result.errors).toEqual([])
        expect(result.summaries.length).toBe(1)
        expect(result.hits.length).toBe(2)
        expect(JSON.stringify(result.hits[1]!.body)).toContain("Summarize the revenue concentration.")
      }),
      {
        git: true,
        // A tool-less agent: the build agent's tool schemas alone estimate above a 16k window.
        config: (url: string) => ({
          ...providerCfg(SMALL_WINDOW)(url),
          agent: { build: { permission: { "*": "deny" } } },
        }),
      },
    ),
  { timeout: 120_000 },
)

it.live(
  "usage reported by another model is not trusted: the guard trips and the session compacts",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ dir, llm }) {
        // Same history and usage as the regression above, but counted by a different model's tokenizer.
        yield* llm.text("summary of the revenue analysis so far")
        yield* llm.text("Revenue is concentrated in the top ten customers.")
        const result = yield* runSession(dir, llm, {
          user: sqlJsonHistory(88_000),
          assistantUsage: 108_000,
          last: { modelID: "another-model" },
          next: "Summarize the revenue concentration.",
        })

        expect(result.errors).toEqual([])
        expect(result.summaries.length).toBe(1)
        expect(result.hits.length).toBe(2)
      }),
      { git: true, config: providerCfg(LARGE_WINDOW) },
    ),
  { timeout: 120_000 },
)

it.live(
  "with auto-compaction off a refusal stays the budget error",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const result = yield* runSession(dir, llm, {
          user: sqlJsonHistory(100_000),
          assistantUsage: 0,
          next: "Summarize the revenue concentration.",
        })

        expect(result.hits.length).toBe(0)
        expect(result.compactions.length).toBe(0)
        expect(result.errors.length).toBe(1)
        expect(result.errors[0]).toContain("UnknownError")
        expect(result.errors[0]).toContain("Context budget exceeded before the request was sent")
      }),
      { git: true, config: (url: string) => ({ ...providerCfg(LARGE_WINDOW)(url), compaction: { auto: false } }) },
    ),
  { timeout: 120_000 },
)

it.live(
  "a refusal in the middle of a turn summarizes that turn's steps instead of dropping them",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ dir, llm }) {
        // [earlier turn] [current user turn] [a finished tool step of the current turn] -> refusal.
        yield* llm.text("summary of the revenue analysis so far")
        yield* llm.text("Revenue is concentrated in the top ten customers.")
        const result = yield* runSession(dir, llm, {
          user: ["List the top customers by paid revenue.", sqlJsonHistory(100_000)],
          assistantUsage: 0,
          last: { finish: "tool-calls", text: "Step result of the current turn: 42 customers above threshold." },
        })

        expect(result.errors).toEqual([])
        expect(result.summaries.length).toBe(1)
        // The current turn's step survives compaction (summarized, or kept in the verbatim tail) and
        // reaches the retried request: compaction did not cut at the last user message and replay it.
        expect(result.hits.length).toBe(2)
        expect(JSON.stringify(result.hits[1]!.body)).toContain("Step result of the current turn")
      }),
      { git: true, config: providerCfg(LARGE_WINDOW) },
    ),
  { timeout: 120_000 },
)

describe("guard calibration", () => {
  test("uses the smaller provider-reported size, and the estimate when usage is missing or unusable", () => {
    expect(calibratedInputTokens(128_000, 108_400)).toBe(108_400)
    // Reported usage never raises the estimate: the guard stays at least as permissive as before.
    expect(calibratedInputTokens(90_000, 108_400)).toBe(90_000)
    // Nor lowers it below half the estimate (partial usage, a request that changed since).
    expect(calibratedInputTokens(128_000, 2_000)).toBe(64_000)
    for (const reported of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(calibratedInputTokens(128_000, reported)).toBe(128_000)
    }
  })

  test("the shared measure is reported usage plus the tail inflated by the safety fraction", () => {
    const tokens = { input: 100_000, output: 2_000, reasoning: 0, cache: { read: 6_000, write: 0 } }
    expect(reportedContextTokens({ tokens, fraction: 0.65 })).toBe(108_000)
    expect(reportedContextTokens({ tokens, estimatedTokens: 650, fraction: 0.65 })).toBe(109_000)
    expect(reportedContextTokens({ tokens: { ...tokens, total: 50_000 }, fraction: 0.65 })).toBe(50_000)
  })

  test("only context-size refusals are compaction signals", () => {
    const info = { modelID: "m", providerID: "p", inputTokens: 1, requested: 1, context: 1, floor: 1 }
    expect(isContextBudgetError(new OutputTokenBudgetError(info))).toBe(true)
    expect(
      isContextBudgetError(
        new InputTokenBudgetError({ modelID: "m", providerID: "p", inputTokens: 1, inputLimit: 1, margin: 1 }),
      ),
    ).toBe(true)
    // A reasoning budget the model cannot honor is a configuration conflict: compacting cannot fix it.
    expect(
      isContextBudgetError(
        new ReasoningTokenBudgetError({ path: "thinking.budgetTokens", configured: 1, maxOutputTokens: 1 }),
      ),
    ).toBe(false)
    expect(isContextBudgetError(new Error("Context budget exceeded before the request was sent."))).toBe(false)
  })
})
