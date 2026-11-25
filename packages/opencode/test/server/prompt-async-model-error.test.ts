/**
 * `prompt_async` skips its own error event only for model errors the prompt already reported with guidance.
 */
import { describe, expect, spyOn } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Bus } from "../../src/bus"
import { Project } from "@/project/project"
import { Provider } from "../../src/provider/provider"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { Session as SessionNs } from "@/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { ModelMetadata } from "../../src/altimate/session/model-metadata"
import { ModelReport } from "../../src/altimate/session/model-report"
import { TraceContext } from "../../src/altimate/observability/trace-context"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { TestInstance } from "../fixture/fixture"
import { NotFoundError as StorageNotFoundError } from "../../src/storage/db"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(SessionNs.defaultLayer, Project.defaultLayer, CrossSpawnSpawner.defaultLayer))

// Spies on the route's own calls: its catch releases the trace first, then decides and publishes
// synchronously, so the release signal marks the end of error handling.
// `error` may be a function that produces the failure from the prompt's input, as the real prompt does.
const errorsFor = Effect.fn("PromptAsyncModelErrorTest.errorsFor")(function* (error: unknown) {
  const test = yield* TestInstance
  const created = yield* SessionNs.use.create({ title: "async model error" })
  const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (input: SessionPrompt.PromptInput) => {
    if (typeof error === "function") return await error(input)
    throw error
  }) as unknown as typeof SessionPrompt.prompt)
  let handled!: () => void
  const done = new Promise<void>((resolve) => {
    handled = resolve
  })
  const release = TraceContext.release
  const releaseSpy = spyOn(TraceContext, "release").mockImplementation(((...args: Parameters<typeof release>) => {
    const result = release(...args)
    queueMicrotask(handled)
    return result
  }) as typeof release)
  const publish = spyOn(Bus, "publish")
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      prompt.mockRestore()
      releaseSpy.mockRestore()
      publish.mockRestore()
    }),
  )
  const response = yield* Effect.promise(async () =>
    Server.Default().request(`/session/${created.id}/prompt_async`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencode-directory": test.directory },
      body: JSON.stringify({ parts: [{ type: "text", text: "hello" }] }),
    }),
  )
  yield* Effect.promise(() => response.text())
  yield* Effect.promise(() => done)
  return publish.mock.calls.filter(([definition]) => definition === Session.Event.Error)
})

const notFound = () =>
  new Provider.ModelNotFoundError({ providerID: ProviderID.make("missing"), modelID: ModelID.make("model") })

describe("prompt_async model errors", () => {
  it.instance(
    "an unreported model error is still published",
    () =>
      Effect.gen(function* () {
        expect(yield* errorsFor(notFound())).toHaveLength(1)
      }),
    { git: true },
    30_000,
  )

  it.instance(
    "a model error the prompt already reported is not published twice",
    () =>
      Effect.gen(function* () {
        const error = notFound()
        ModelMetadata.markReported(error)
        expect(yield* errorsFor(error)).toHaveLength(0)
      }),
    { git: true },
    30_000,
  )

  it.instance(
    "the real reporter publishes an unavailable model exactly once through the async route",
    () =>
      Effect.gen(function* () {
        const errors = yield* errorsFor((input: SessionPrompt.PromptInput) =>
          ModelReport.validateOrReport(
            input.sessionID,
            { providerID: ProviderID.make("missing-provider"), modelID: ModelID.make("missing-model") },
            "config (model)",
          ),
        )
        expect(errors).toHaveLength(1)
        expect(JSON.stringify(errors[0])).toContain("missing-provider/missing-model (from config (model))")
      }),
    { git: true },
    30_000,
  )

  const syncStatus = Effect.fn("PromptAsyncModelErrorTest.syncStatus")(function* (error: unknown) {
    const test = yield* TestInstance
    const created = yield* SessionNs.use.create({ title: "sync prompt error" })
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async () => {
      throw error
    }) as unknown as typeof SessionPrompt.prompt)
    yield* Effect.addFinalizer(() => Effect.sync(() => prompt.mockRestore()))
    const response = yield* Effect.promise(async () =>
      Server.Default().request(`/session/${created.id}/message`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencode-directory": test.directory },
        body: JSON.stringify({ parts: [{ type: "text", text: "hello" }] }),
      }),
    )
    yield* Effect.promise(() => response.text())
    return response.status
  })

  it.instance(
    "the synchronous route rejects an unavailable model with 400",
    () =>
      Effect.gen(function* () {
        expect(yield* syncStatus(notFound())).toBe(400)
      }),
    { git: true },
    30_000,
  )

  it.instance(
    "the synchronous route keeps the empty 200 reply for other prompt failures",
    () =>
      Effect.gen(function* () {
        expect(yield* syncStatus(new Error("compaction failed"))).toBe(200)
      }),
    { git: true },
    30_000,
  )

  it.instance(
    "the synchronous route keeps 404 for a missing session",
    () =>
      Effect.gen(function* () {
        expect(yield* syncStatus(new StorageNotFoundError({ message: "Session not found" }))).toBe(404)
      }),
    { git: true },
    30_000,
  )
})
