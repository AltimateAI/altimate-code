/**
 * The pre-send context guard and the compaction trigger must agree.
 *
 * The guard (`clampOutputTokens`) refuses a request whose character-based size estimate leaves
 * no room for a response; compaction (`SessionCompaction.isOverflow`) fires on provider-reported
 * usage. The character estimate runs well above real token counts on SQL- and JSON-heavy context,
 * so a session below the compaction threshold used to be refused by the guard and end with
 * "Context budget exceeded before the request was sent" without compaction ever running.
 */
import { describe, expect, spyOn, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import path from "node:path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session } from "@/session/session"
import { Telemetry } from "@/altimate/telemetry"
import { NudgeArbiter } from "../../src/session/nudge"
import { SessionPrompt } from "../../src/session/prompt"
import { Token } from "../../src/util/token"
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
import { Provider } from "../../src/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import {
  InputTokenBudgetError,
  OutputTokenBudgetError,
  ReasoningTokenBudgetError,
  REQUEST_ESTIMATE_METADATA_KEY,
  calibratedInputTokens,
  clampReasoningBudget,
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

/**
 * A local OpenAI-compatible model with the given window, driven by a tool-less build agent unless
 * `tools` is set. The build agent's system prompt and tool schemas vary by environment (tens of
 * thousands of estimated tokens); without them each fixture's history alone decides the guard.
 */
const providerCfg =
  (
    limit: { context: number; output: number },
    opts: { tools?: boolean; attachment?: boolean; modelOptions?: Record<string, unknown> } = {},
  ) =>
  (url: string) => ({
    ...(opts.tools ? {} : { agent: { build: { permission: { "*": "deny" as const } } } }),
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
            attachment: opts.attachment === true,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit,
            cost: { input: 0, output: 0 },
            options: opts.modelOptions ?? {},
          },
        },
        options: { apiKey: "test-key", baseURL: url },
      },
    },
    model: "altimate-backend/test-model",
  })

const LARGE_WINDOW = { context: 131_072, output: 16_384 }
/** A 1x1 PNG. */
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const SMALL_WINDOW = { context: 16_384, output: 4_096 }

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

/** Six user turns of SQL/JSON history totalling at least `target` estimated tokens (compaction trims whole turns). */
const sqlJsonTurns = (target: number) => Array.from({ length: 6 }, () => sqlJsonHistory(Math.ceil(target / 6)))

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
  nextSystem?: string
  last?: {
    modelID?: string
    providerID?: string
    agent?: string
    finish?: string
    text?: string
    file?: boolean
    toolOutput?: string
    tool?: "answer_commit"
    /** Attach an image to the step's tool result. */
    toolImage?: boolean
    /** Override the seeded request estimate. Null represents a message without one. */
    requestEstimateTokens?: number | null
  }
  /** An image attached to the `next` user turn. */
  nextFile?: boolean
  /** An image attached to the last `user` turn (sent before the measured step). */
  userFile?: boolean
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
    const user = Effect.fnUntraced(function* (text: string, system?: string) {
      const msg = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID,
        agent: seeded.last?.tool === "answer_commit" ? "analyst" : "build",
        model,
        system,
        time: { created: Date.now() },
      } as any)
      yield* sessions.updatePart({ id: PartID.ascending(), messageID: msg.id, sessionID, type: "text", text } as any)
      return msg
    })
    const attachImage = (messageID: MessageID) =>
      sessions.updatePart({
        id: PartID.ascending(),
        messageID,
        sessionID,
        type: "file",
        mime: "image/png",
        filename: "revenue-chart.png",
        url: `data:image/png;base64,${PNG_BASE64}`,
      } as any)
    const answerText = "The top customers by paid revenue are listed above."
    const answer = Effect.fnUntraced(function* (
      parentID: MessageID,
      usage: number,
      requestEstimateTokens: number | null,
      last: Seeded["last"] = {},
    ) {
      const msg = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        sessionID,
        mode: last.agent ?? "build",
        agent: last.agent ?? "build",
        path: { cwd: dir, root: dir },
        cost: 0,
        tokens: { input: usage, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: last.modelID ?? model.modelID,
        providerID: last.providerID ?? model.providerID,
        parentID,
        finish: last.finish ?? "stop",
        time: { created: Date.now(), completed: Date.now() },
        metadata:
          requestEstimateTokens === null ? undefined : { [REQUEST_ESTIMATE_METADATA_KEY]: requestEstimateTokens },
      } as any)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID,
        type: "text",
        text: last.text ?? answerText,
      } as any)
      if (last.file) yield* attachImage(msg.id)
      if (last.toolOutput !== undefined) {
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: msg.id,
          sessionID,
          type: "tool",
          callID: "call_revenue_query",
          tool: last.tool ?? "bash",
          state: {
            status: "completed",
            input: { command: "run the revenue query" },
            output: last.toolOutput,
            title: "revenue query",
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
            ...(last.toolImage
              ? {
                  attachments: [
                    {
                      id: PartID.ascending(),
                      sessionID,
                      messageID: msg.id,
                      type: "file",
                      mime: "image/png",
                      filename: "revenue-chart.png",
                      url: `data:image/png;base64,${PNG_BASE64}`,
                    },
                  ],
                }
              : {}),
          },
        } as any)
      }
    })
    const turns = Array.isArray(seeded.user) ? seeded.user : [seeded.user]
    // Estimate the seeded history as it was before the measured assistant answered.
    const history: { role: "user" | "assistant"; content: { type: "text"; text: string }[] }[] = []
    for (const [index, text] of turns.entries()) {
      const msg = yield* user(text)
      history.push({ role: "user", content: [{ type: "text", text }] })
      const last = index === turns.length - 1
      if (last && seeded.userFile) yield* attachImage(msg.id)
      if (!last) {
        yield* answer(msg.id, 0, null)
        history.push({ role: "assistant", content: [{ type: "text", text: answerText }] })
      } else if (seeded.assistantUsage !== undefined) {
        const override = seeded.last?.requestEstimateTokens
        const estimate = override === undefined ? estimateInputTokens({ system: [], messages: history }) : override
        yield* answer(msg.id, seeded.assistantUsage, estimate, seeded.last)
      }
    }
    if (seeded.next !== undefined) {
      const next = yield* user(seeded.next, seeded.nextSystem)
      if (seeded.nextFile) yield* attachImage(next.id)
    }

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
        // The provider counted this conversation as 108k tokens, below the ~111k compaction trigger.
        // The character estimate of the SQL/JSON history alone is ~130k (the ~20% overestimate on
        // SQL/JSON), past the guard's limit (131,072 less the 1,024-token response floor and a 2%
        // margin). Without calibration this request is refused.
        const history = sqlJsonHistory(130_000)
        const reported = 108_000

        yield* llm.text("Revenue is concentrated in the top ten customers.")
        const result = yield* runSession(dir, llm, {
          user: history,
          assistantUsage: reported,
          last: {
            // Include the stable instructions from the hypothetical preceding request.
            requestEstimateTokens:
              estimateInputTokens({
                system: [],
                messages: [{ role: "user", content: [{ type: "text", text: history }] }],
              }) + 7_000,
          },
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
  "a new system prompt that exceeds the context budget forces compaction",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ dir, llm }) {
        yield* llm.text("Summary of the revenue analysis.")
        yield* llm.text("Revenue is concentrated in the top ten customers.")
        const result = yield* runSession(dir, llm, {
          user: sqlJsonTurns(130_000),
          assistantUsage: 108_000,
          next: "Summarize the revenue concentration.",
          nextSystem: sqlJsonHistory(40_000),
        })

        expect(result.summaries.length).toBe(1)
        expect(result.errors).toEqual([])
        expect(result.hits.length).toBe(2)
      }),
      { git: true, config: providerCfg(LARGE_WINDOW) },
    ),
  { timeout: 120_000 },
)

it.live(
  "a rewrite of already-measured history grows the estimate and forces compaction",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ dir, llm }) {
        yield* llm.text("Summary of the earlier turns.")
        yield* llm.text("Here is the answer.")
        const result = yield* runSession(dir, llm, {
          user: sqlJsonTurns(130_000),
          assistantUsage: 108_000,
          // Simulate a history transform expanding content present in the measured request.
          last: { requestEstimateTokens: 100_000 },
          next: "Answer the follow-up question.",
        })

        expect(result.summaries.length).toBe(1)
        expect(result.errors).toEqual([])
        expect(result.hits.length).toBe(2)
        expect(JSON.stringify(result.hits[0]!.body)).not.toContain("Answer the follow-up question.")
        expect(JSON.stringify(result.hits[1]!.body)).toContain("Answer the follow-up question.")
      }),
      { git: true, config: providerCfg(LARGE_WINDOW) },
    ),
  { timeout: 120_000 },
)

it.live(
  "a measured step without a recorded request estimate cannot calibrate the guard",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ dir, llm }) {
        yield* llm.text("Summary of the revenue analysis.")
        yield* llm.text("Revenue is concentrated in the top ten customers.")
        const result = yield* runSession(dir, llm, {
          user: sqlJsonTurns(130_000),
          assistantUsage: 108_000,
          last: { requestEstimateTokens: null },
          next: "Summarize the revenue concentration.",
        })

        expect(result.summaries.length).toBe(1)
        expect(result.errors).toEqual([])
        expect(result.hits.length).toBe(2)
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
        const history = sqlJsonTurns(135_000)

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
        // Refused on the turn's first request: the prompt is replayed verbatim after the summary,
        // not paraphrased into it.
        expect(JSON.stringify(result.hits[0]!.body)).not.toContain("Summarize the revenue concentration.")
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
  "the processor records the full request estimate on the sent assistant message",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ dir, llm }) {
        yield* llm.text("Here is the answer.")
        const result = yield* runSession(dir, llm, { user: sqlJsonHistory(20_000) })

        expect(result.errors).toEqual([])
        expect(result.hits.length).toBe(1)
        const answer = result.messages.at(-1)?.info
        expect(
          answer?.role === "assistant" ? answer.metadata?.[REQUEST_ESTIMATE_METADATA_KEY] : undefined,
        ).toBeGreaterThan(20_000)
      }),
      { git: true, config: providerCfg(LARGE_WINDOW) },
    ),
  { timeout: 120_000 },
)

it.live(
  "history added since the measured request reduces the output reservation",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ dir, llm }) {
        yield* llm.text("Here is the answer.")
        const result = yield* runSession(dir, llm, {
          user: sqlJsonTurns(130_000),
          assistantUsage: 108_000,
          last: { text: sqlJsonHistory(12_000) },
          next: "Answer the follow-up question.",
        })

        expect(result.errors).toEqual([])
        expect(result.compactions).toHaveLength(0)
        expect(result.hits).toHaveLength(1)
        // The assistant's last output was absent from the measured request and now
        // consumes enough context to squeeze the reservation without forcing compaction.
        expect(result.hits[0]!.body.max_tokens).toBeGreaterThan(1_024)
        expect(result.hits[0]!.body.max_tokens).toBeLessThan(LARGE_WINDOW.output)
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
        const result = yield* runSession(dir, llm, { user: sqlJsonHistory(135_000) })

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
  "a context clamp that leaves too little room for reasoning compacts and retries",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ dir, llm }) {
        // The reported input leaves about 1,500 output tokens, above the visible floor but
        // below what the enabled reasoning budget needs. The original 4,096-token reservation fits.
        yield* llm.text("Summary of the earlier turns.")
        yield* llm.text("Here is the answer.")
        const result = yield* runSession(dir, llm, {
          user: sqlJsonTurns(13_000),
          assistantUsage: 14_500,
          next: "Answer the follow-up question.",
        })

        expect(result.errors).toEqual([])
        expect(result.summaries.length).toBe(1)
        expect(result.hits.length).toBe(2)
        expect(JSON.stringify(result.hits[0]!.body)).not.toContain("Answer the follow-up question.")
        expect(JSON.stringify(result.hits[1]!.body)).toContain("Answer the follow-up question.")
      }),
      {
        git: true,
        config: providerCfg(SMALL_WINDOW, { modelOptions: { thinking: { budgetTokens: 2_048 } } }),
      },
    ),
  { timeout: 120_000 },
)

it.live(
  "a separate input limit makes the guard compact and retry",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ dir, llm }) {
        // The input limit is below the proactive reserve. The history fits the context
        // window, so only the pre-send input limit can trigger this compaction.
        // The config-to-provider conversion does not carry a declared input limit.
        const getModel = Provider.getModel
        const modelSpy = spyOn(Provider, "getModel").mockImplementation(async (...args) => {
          const resolved = await getModel(...args)
          return { ...resolved, limit: { ...resolved.limit, input: 16_384 } }
        })
        try {
          yield* llm.text("Summary of the earlier turns.")
          yield* llm.text("Here is the answer.")
          const result = yield* runSession(dir, llm, {
            user: sqlJsonTurns(24_000),
            assistantUsage: 0,
            next: "Answer the follow-up question.",
          })

          expect(result.errors).toEqual([])
          expect(result.summaries).toHaveLength(1)
          expect(result.hits).toHaveLength(2)
          expect(JSON.stringify(result.hits[0]!.body)).not.toContain("Answer the follow-up question.")
          expect(JSON.stringify(result.hits[1]!.body)).toContain("Answer the follow-up question.")
        } finally {
          modelSpy.mockRestore()
        }
      }),
      { git: true, config: providerCfg(LARGE_WINDOW) },
    ),
  { timeout: 120_000 },
)

it.live(
  "a refused echo delivers the committed answer through overflow recovery",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const committed = "This is the committed answer."
        const result = yield* runSession(dir, llm, {
          user: sqlJsonHistory(135_000),
          assistantUsage: 0,
          last: { agent: "analyst", finish: "tool-calls", tool: "answer_commit", toolOutput: committed },
        })

        expect(result.hits).toHaveLength(0)
        expect(result.summaries).toHaveLength(0)
        expect(result.errors).toEqual([])
        const echo = result.messages.at(-1)
        expect(echo?.info).toHaveProperty("metadata.answer_commit_echo_error.name", "ContextOverflowError")
        expect(echo?.parts).toContainEqual(expect.objectContaining({ type: "text", text: committed }))
      }),
      { git: true, config: providerCfg(LARGE_WINDOW) },
    ),
  { timeout: 120_000 },
)

it.live(
  "a refused request hands its directive back to the retry and tracks it once",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const directive = "Keep this directive for the next working request."
        const begin = NudgeArbiter.begin
        const beginSpy = spyOn(NudgeArbiter, "begin").mockImplementation((sessionID) => {
          const generation = begin(sessionID)
          NudgeArbiter.register(sessionID, { source: "budget_reminder", kind: "budget", text: directive }, generation)
          return generation
        })
        const runMode = process.env.ALTIMATE_RUN_MODE
        const track = spyOn(Telemetry, "track")
        process.env.ALTIMATE_RUN_MODE = "1"
        try {
          yield* llm.text("Summary of the earlier turns.")
          yield* llm.text("Here is the answer.")
          const result = yield* runSession(dir, llm, {
            user: sqlJsonTurns(135_000),
            assistantUsage: 0,
            next: "Answer the follow-up question.",
          })

          expect(result.errors).toEqual([])
          expect(result.summaries).toHaveLength(1)
          expect(result.hits).toHaveLength(2)
          expect(JSON.stringify(result.hits[0]!.body)).not.toContain(directive)
          expect(JSON.stringify(result.hits[1]!.body)).toContain(directive)
          expect(
            track.mock.calls.filter(([event]) => event.type === "starvation_breaker" && event.action === "injected"),
          ).toHaveLength(1)
        } finally {
          beginSpy.mockRestore()
          track.mockRestore()
          if (runMode === undefined) delete process.env.ALTIMATE_RUN_MODE
          else process.env.ALTIMATE_RUN_MODE = runMode
        }
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
        config: providerCfg(SMALL_WINDOW),
      },
    ),
  { timeout: 120_000 },
)

// With matching identities the reported input would fit. Each mismatch forces the full estimate.
for (const [field, identity] of [
  ["providerID", "other-provider"],
  ["modelID", "other-model"],
  ["agent", "other-agent"],
] as const) {
  it.live(
    `reported usage with a different ${field} cannot calibrate the guard`,
    () =>
      provideTmpdirServerLegacy(
        Effect.fnUntraced(function* ({ dir, llm }) {
          yield* llm.text("summary of the revenue analysis so far")
          yield* llm.text("Revenue is concentrated in the top ten customers.")
          const result = yield* runSession(dir, llm, {
            user: sqlJsonTurns(130_000),
            assistantUsage: 108_000,
            last: { [field]: identity, requestEstimateTokens: 137_000 },
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
}

it.live(
  "with auto-compaction off a refusal stays the budget error",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const result = yield* runSession(dir, llm, {
          user: sqlJsonHistory(135_000),
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
        // The step's completed tool result must survive compaction.
        yield* llm.text("summary of the revenue analysis so far")
        yield* llm.text("Revenue is concentrated in the top ten customers.")
        const result = yield* runSession(dir, llm, {
          user: [...sqlJsonTurns(135_000), "Break the revenue down by region."],
          assistantUsage: 0,
          last: {
            finish: "tool-calls",
            text: "Running the revenue query.",
            toolOutput: "Step result of the current turn: 42 customers above threshold.",
          },
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

it.live(
  "a new image in a near-full session is sent: calibration adds its allowance instead of dropping",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ dir, llm }) {
        // Same as the regression above, plus an image on the new turn. The estimate alone would refuse
        // (and the unseen image makes the refusal fatal); reported usage plus the image's allowance fits.
        yield* llm.text("Revenue is concentrated in the top ten customers.")
        const result = yield* runSession(dir, llm, {
          user: sqlJsonTurns(130_000),
          assistantUsage: 108_000,
          next: "Summarize the revenue concentration.",
          nextFile: true,
        })

        expect(result.errors).toEqual([])
        expect(result.compactions.length).toBe(0)
        expect(result.hits.length).toBe(1)
      }),
      { git: true, config: providerCfg(LARGE_WINDOW, { attachment: true }) },
    ),
  { timeout: 120_000 },
)

const MEDIA_GUIDANCE =
  "The conversation plus a new image or PDF (attached or returned by a tool) does not fit the model's context window. Run /compact, then retry; re-attach the file if you attached it."

it.live(
  "a refused request with an unseen user image gives manual compaction guidance",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const result = yield* runSession(dir, llm, {
          user: sqlJsonTurns(135_000),
          assistantUsage: 0,
          next: "Describe this image.",
          nextFile: true,
        })

        expect(result.hits).toHaveLength(0)
        expect(result.compactions).toHaveLength(0)
        expect(result.errors.map((error) => JSON.parse(error))).toEqual([
          { name: "UnknownError", data: { message: MEDIA_GUIDANCE } },
        ])
      }),
      { git: true, config: providerCfg(LARGE_WINDOW, { attachment: true }) },
    ),
  { timeout: 120_000 },
)

it.live(
  "an image from a tool result the model has not seen yet is not compacted away",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ dir, llm }) {
        // A mid-turn step returned a chart image; the next request is refused. Compaction would strip
        // the image before the model ever saw it, so the refusal stays the budget error.
        const result = yield* runSession(dir, llm, {
          user: [...sqlJsonTurns(135_000), "Chart the revenue by region."],
          assistantUsage: 0,
          last: { finish: "tool-calls", text: "Rendering the chart.", toolOutput: "Chart rendered.", toolImage: true },
        })

        expect(result.hits.length).toBe(0)
        expect(result.compactions.length).toBe(0)
        expect(result.errors.length).toBe(1)
        expect(result.errors[0]).toContain(MEDIA_GUIDANCE)
      }),
      { git: true, config: providerCfg(LARGE_WINDOW, { attachment: true }) },
    ),
  { timeout: 120_000 },
)

it.live(
  "an image generated by the measured assistant does not block compaction",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ dir, llm }) {
        yield* llm.text("Summary of the earlier turns.")
        yield* llm.text("Here is the answer.")
        const result = yield* runSession(dir, llm, {
          user: sqlJsonTurns(135_000),
          assistantUsage: 0,
          last: { file: true },
          next: "Answer the follow-up question.",
        })

        expect(result.errors).toEqual([])
        expect(result.summaries).toHaveLength(1)
        expect(result.hits).toHaveLength(2)
      }),
      { git: true, config: providerCfg(LARGE_WINDOW, { attachment: true }) },
    ),
  { timeout: 120_000 },
)

it.live(
  "an image the model already saw does not block compaction",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ dir, llm }) {
        // The turn opened with a chart image, a measured tool step followed (the model saw it), and
        // a later request is refused: that is compactable like any other mid-turn refusal.
        yield* llm.text("summary of the revenue analysis so far")
        yield* llm.text("Revenue is concentrated in the top ten customers.")
        const result = yield* runSession(dir, llm, {
          user: [...sqlJsonTurns(135_000), "Explain this revenue chart."],
          userFile: true,
          assistantUsage: 0,
          last: { finish: "tool-calls", text: "Querying the data behind the chart.", toolOutput: "42 rows." },
        })

        expect(result.errors).toEqual([])
        expect(result.summaries.length).toBe(1)
        expect(result.hits.length).toBe(2)
      }),
      { git: true, config: providerCfg(LARGE_WINDOW, { attachment: true }) },
    ),
  { timeout: 120_000 },
)

it.live(
  "a refused attempt does not consume the agent's step cap",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ dir, llm }) {
        // steps: 2. Counting the refused attempt would make the retry the last step: tools removed
        // and a final answer forced before any work.
        yield* llm.text("summary of the revenue analysis so far")
        yield* llm.text("Revenue is concentrated in the top ten customers.")
        const result = yield* runSession(dir, llm, {
          user: sqlJsonTurns(135_000),
          assistantUsage: 0,
          next: "Summarize the revenue concentration.",
        })

        expect(result.errors).toEqual([])
        expect(result.summaries.length).toBe(1)
        expect(result.hits.length).toBe(2)
        const retry = result.hits[1]!.body as { tools?: unknown[] }
        expect(retry.tools?.length ?? 0).toBeGreaterThan(0)
        expect(JSON.stringify(retry)).not.toContain("maximum number of steps")
      }),
      {
        git: true,
        config: (url: string) => ({
          ...providerCfg(LARGE_WINDOW, { tools: true })(url),
          agent: { build: { steps: 2 } },
        }),
      },
    ),
  { timeout: 120_000 },
)

describe("guard calibration", () => {
  test("uses the smaller provider-reported size, and the estimate when usage is missing or unusable", () => {
    expect(calibratedInputTokens(128_000, 108_400)).toBe(108_400)
    // Reported usage never raises the estimate: the guard stays at least as permissive as before.
    expect(calibratedInputTokens(90_000, 108_400)).toBe(90_000)
    // Usage below 60% of the estimate is distrusted (partial usage, a request that changed since).
    expect(calibratedInputTokens(128_000, 2_000)).toBe(128_000)
    expect(calibratedInputTokens(128_000, 76_000)).toBe(128_000)
    expect(calibratedInputTokens(128_000, 77_000)).toBe(77_000)
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

  test("reasoning budget refusals signal compaction only when the original reservation could fit", () => {
    const smallBudget = { thinking: { budgetTokens: 512 } }
    const largeBudget = { thinking: { budgetTokens: 2_048 } }
    for (const [options, clamped, requested, compactable] of [
      [largeBudget, 1_200, 4_096, true],
      [smallBudget, 1_400, 1_700, true],
      [largeBudget, 1_200, 1_500, false],
      [largeBudget, 1_200, 1_200, false],
    ] as const) {
      let refusal: unknown
      try {
        clampReasoningBudget(options, clamped, requested)
      } catch (error) {
        refusal = error
      }
      expect(refusal).toBeInstanceOf(ReasoningTokenBudgetError)
      expect(isContextBudgetError(refusal)).toBe(compactable)
    }
  })
})

describe("proactive compaction tail", () => {
  const text = (id: string, role: "user" | "assistant", body: string) =>
    ({
      info: { id, sessionID: "s", role, time: { created: 1 } },
      parts: [{ id: `${id}-p`, sessionID: "s", messageID: id, type: "text", text: body }],
    }) as unknown as MessageV2.WithParts

  test("follows the caller's stored order, not lexical IDs", () => {
    // A later message with a lexically smaller caller-supplied ID.
    const msgs = [text("m5", "user", "task"), text("m6", "assistant", "done"), text("a1", "user", "y".repeat(9_000))]
    expect(SessionPrompt.estimateUncountedTail(msgs, "m6" as any)).toBe(0)
    expect(SessionPrompt.estimateUncountedTail(msgs, "m6" as any, (id) => id === "a1")).toBe(
      Token.estimate("y".repeat(9_000)),
    )
  })
})
