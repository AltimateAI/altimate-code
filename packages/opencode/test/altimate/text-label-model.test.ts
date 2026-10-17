// altimate_change start — exercise text_label through the production tool and session APIs
import { afterEach, expect, spyOn } from "bun:test"
import { APICallError } from "ai"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { LLM } from "../../src/session/llm"
import { Session } from "../../src/session/session"
import { MessageID } from "../../src/session/schema"
import { closeScratch, getScratch } from "../../src/altimate/native/connections/scratch"
import { TextLabelTool } from "../../src/altimate/tools/text-label"
import { testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { initTool } from "./tool-fixture"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, CrossSpawnSpawner.defaultLayer, testInstanceStoreLayer))
const spies: Array<{ mockRestore(): void }> = []
const originalConcurrency = process.env.ALTIMATE_TEXT_LABEL_CONCURRENCY
afterEach(async () => {
  for (const spy of spies.splice(0).reverse()) spy.mockRestore()
  if (originalConcurrency === undefined) delete process.env.ALTIMATE_TEXT_LABEL_CONCURRENCY
  else process.env.ALTIMATE_TEXT_LABEL_CONCURRENCY = originalConcurrency
  await closeScratch()
})

const model: Provider.Model = {
  id: ModelID.make("session-model"),
  providerID: ProviderID.make("session-provider"),
  api: { id: "session-model", npm: "@ai-sdk/openai", url: "https://provider.test" },
  name: "Session model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    interleaved: false,
    input: { text: true, image: false, audio: false, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, output: 4096 },
  status: "active",
  release_date: "2025-01-01",
  options: {},
  headers: {},
}

it.instance("uses the turn's session model with small calls and preserves stream HTTP 400 failures", () =>
  Effect.gen(function* () {
    process.env.ALTIMATE_TEXT_LABEL_CONCURRENCY = "1"
    const sessions = yield* Session.Service
    const session = yield* sessions.create({})
    const messageID = MessageID.ascending()
    yield* sessions.updateMessage({
      id: messageID,
      sessionID: session.id,
      role: "assistant",
      parentID: MessageID.ascending(),
      providerID: ProviderV2.ID.make(model.providerID),
      modelID: ModelV2.ID.make(model.id),
      agent: "analyst",
      mode: "analyst",
      path: { cwd: "/", root: "/" },
      time: { created: Date.now() },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })

    const error = new APICallError({
      message: "Provider rejected unsupported thinkingBudget",
      statusCode: 400,
      url: "https://provider.test/generate",
      requestBodyValues: {},
      isRetryable: false,
    })
    const getModel = spyOn(Provider, "getModel").mockResolvedValue(model)
    const getSmallModel = spyOn(Provider, "getSmallModel").mockRejectedValue(new Error("Must use the session model"))
    const defaultModel = spyOn(Provider, "defaultModel").mockRejectedValue(new Error("Must use the session model"))
    const stream = spyOn(LLM, "stream").mockImplementation(
      async () =>
        ({
          fullStream: (async function* () {
            yield { type: "error", error }
          })(),
          text: Promise.reject(new Error("NoOutputGeneratedError: No output generated")),
        }) as never,
    )
    spies.push(getModel, getSmallModel, defaultModel, stream)
    const asks: unknown[] = []
    const tool = yield* Effect.promise(() => initTool(TextLabelTool))
    const result = yield* Effect.promise(() =>
      tool.execute(
        {
          sql: "SELECT i AS row_id, 'row ' || i AS body FROM range(1, 6) t(i)",
          id_column: "row_id",
          text_column: "body",
          target_table: "model_error_labels",
          batch_size: 2,
          labels: [
            { label: "A", description: "First category" },
            { label: "B", description: "Second category" },
          ],
        },
        {
          sessionID: session.id,
          messageID,
          agent: "analyst",
          messages: [],
          abort: AbortSignal.any([]),
          ask: (request: unknown) => {
            asks.push(request)
          },
        },
      ),
    )

    expect(result.metadata).toMatchObject({
      rows_in: 5,
      labeled: 0,
      failed: 5,
      unparseable: 0,
      persisted: true,
      ok: false,
    })
    expect(result.output).toContain("HTTP 400: Provider rejected unsupported thinkingBudget")
    expect(result.output).not.toContain("No output generated")
    expect(stream).toHaveBeenCalledTimes(1)
    expect(getModel).toHaveBeenCalledWith(model.providerID, model.id)
    expect(defaultModel).not.toHaveBeenCalled()
    expect(getSmallModel).not.toHaveBeenCalled()
    expect(stream.mock.calls[0][0]).toMatchObject({
      model,
      small: true,
      retries: 0,
      sessionID: session.id,
      tools: {},
      user: { sessionID: session.id, model: { providerID: model.providerID, modelID: model.id } },
    })
    expect(asks).toMatchObject([{ permission: "text_label", patterns: ["model_error_labels"] }])
    const scratch = yield* Effect.promise(() => getScratch(session.id))
    const saved = yield* Effect.promise(() =>
      scratch.execute("SELECT row_id, label, confidence, label_status FROM model_error_labels ORDER BY row_id"),
    )
    expect(saved.rows).toEqual(Array.from({ length: 5 }, (_, index) => [BigInt(index + 1), null, null, "failed"]))
    const failedIds = yield* Effect.promise(() => scratch.execute(String(result.metadata.failed_ids_sql)))
    expect(failedIds.rows).toHaveLength(5)
  }),
)
// altimate_change end
