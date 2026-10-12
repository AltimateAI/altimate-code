// altimate_change start — stream watchdog deadlines, overrides, content types, and cancellation
import { afterEach, expect, spyOn } from "bun:test"
import { streamText } from "ai"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { ProviderError } from "@/provider/error"
import { ProviderID, ModelID } from "@/provider/schema"
import { MessageV2 } from "@/session/message-v2"
import { SessionRetry } from "@/session/retry"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"

afterEach(disposeAllInstances)

const it = testEffect(
  Layer.mergeAll(Provider.defaultLayer, Env.defaultLayer, Plugin.defaultLayer, CrossSpawnSpawner.defaultLayer),
)

for (const contentType of ["text/event-stream", "application/vnd.amazon.eventstream"]) {
  it.live(`idle model body is aborted and retryable with ${contentType}`, () =>
    Effect.gen(function* () {
      const result = yield* request({ contentType, delays: [0, 180], idleTimeout: 50 })

      expect(result.text).toBe("chunk")
      expect(result.signal?.aborted).toBe(true)
      expect(result.aborts).toBe(1)
      expect(result.requests).toBe(1)
      expect(result.error).toBeInstanceOf(ProviderError.ResponseStreamError)
      const classified = MessageV2.fromError(result.error, { providerID: ProviderID.make("test") })
      expect(classified.name).toBe("APIError")
      const data = classified.data as MessageV2.APIError["data"]
      expect(data.isRetryable).toBe(true)
      expect(data.message).toContain(ProviderError.MODEL_STOPPED_RESPONDING)
      expect(SessionRetry.retryable(classified)).toBe(data.message)
    }),
  )
}

for (const contentType of ["application/json", "application/octet-stream", undefined]) {
  it.live(`the watchdog leaves ${contentType ?? "missing content type"} bodies unwrapped`, () =>
    Effect.gen(function* () {
      const result = yield* request({ contentType, delays: [0, 180], idleTimeout: 50 })

      expect(result.error).toBeUndefined()
      expect(result.text).toBe("chunkchunk")
      expect(result.signal?.aborted ?? false).toBe(false)
      expect(result.aborts).toBe(0)
    }),
  )
}

it.live("a first chunk delayed past the idle timeout aborts the stream", () =>
  Effect.gen(function* () {
    const result = yield* request({ contentType: "text/event-stream", delays: [180], idleTimeout: 50 })

    expect(result.text).toBe("")
    expect(result.error).toBeInstanceOf(ProviderError.StreamIdleTimeoutError)
    expect(result.signal?.aborted).toBe(true)
    expect(result.aborts).toBe(1)
  }),
)

it.live("a first chunk arriving before the idle timeout by a margin completes", () =>
  Effect.gen(function* () {
    const result = yield* request({ contentType: "text/event-stream", delays: [70], idleTimeout: 100 })

    expect(result.error).toBeUndefined()
    expect(result.text).toBe("chunk")
    expect(result.signal?.aborted ?? false).toBe(false)
    expect(result.aborts).toBe(0)
  }),
)

it.live("steady model chunks reset the idle deadline", () =>
  Effect.gen(function* () {
    const result = yield* request({
      contentType: "text/event-stream",
      delays: [0, 20, 40, 60, 80, 100],
      idleTimeout: 60,
    })

    expect(result.error).toBeUndefined()
    expect(result.text).toBe("chunk".repeat(6))
    expect(result.signal?.aborted ?? false).toBe(false)
    expect(result.aborts).toBe(0)
  }),
)

it.live("zero idle timeout disables the watchdog including a configured chunk timeout", () =>
  Effect.gen(function* () {
    const result = yield* request({
      contentType: "application/vnd.amazon.eventstream",
      delays: [0, 180],
      idleTimeout: 0,
      chunkTimeout: 30,
    })

    expect(result.error).toBeUndefined()
    expect(result.text).toBe("chunkchunk")
    expect(result.signal?.aborted ?? false).toBe(false)
    expect(result.aborts).toBe(0)
  }),
)

it.live("the environment idle timeout takes precedence over the provider chunk timeout", () =>
  Effect.gen(function* () {
    const result = yield* request({
      contentType: "text/event-stream",
      delays: [0, 100],
      idleTimeout: 200,
      chunkTimeout: 30,
    })

    expect(result.error).toBeUndefined()
    expect(result.text).toBe("chunkchunk")
    expect(result.aborts).toBe(0)
  }),
)

it.live("the provider chunk timeout applies when the environment override is unset", () =>
  Effect.gen(function* () {
    const result = yield* request({
      contentType: "text/event-stream",
      delays: [0, 180],
      chunkTimeout: 50,
    })

    expect(result.text).toBe("chunk")
    expect(result.error).toBeInstanceOf(ProviderError.StreamIdleTimeoutError)
    expect(result.signal?.aborted).toBe(true)
    expect(result.aborts).toBe(1)
  }),
)

it.live("the idle watchdog defaults to 300000ms when environment and provider overrides are absent", () =>
  Effect.gen(function* () {
    const timeout = yield* Effect.acquireRelease(
      Effect.sync(() => spyOn(globalThis, "setTimeout")),
      (timeout) => Effect.sync(() => timeout.mockRestore()),
    )
    const result = yield* request({ contentType: "text/event-stream", delays: [0], headerTimeout: false })

    expect(result.error).toBeUndefined()
    expect(result.text).toBe("chunk")
    // Disable the header watchdog above so only the stream watchdog can schedule this deadline.
    expect(timeout.mock.calls.map(([, ms]) => ms)).toContain(300_000)
  }),
)

it.live("a completed model stream has no idle watchdog during subsequent tool work", () =>
  Effect.gen(function* () {
    const result = yield* request({
      contentType: "text/event-stream",
      delays: [0],
      idleTimeout: 50,
      afterCompletion: 150,
    })

    expect(result.error).toBeUndefined()
    expect(result.text).toBe("chunk")
    expect(result.signal?.aborted ?? false).toBe(false)
    expect(result.aborts).toBe(0)
  }),
)

it.live("caller cancellation clears the pending idle watchdog", () =>
  Effect.gen(function* () {
    const result = yield* request({
      contentType: "text/event-stream",
      delays: [0, 300],
      idleTimeout: 50,
      afterCompletion: 150,
      cancelAfter: 20,
    })

    expect(result.signal?.aborted).toBe(true)
    expect(result.signal?.reason.message).toBe("Cancelled by user")
    expect(result.aborts).toBe(1)
    expect(result.error).toBeUndefined()
  }),
)

function request(options: {
  contentType?: string
  delays: number[]
  idleTimeout?: number
  chunkTimeout?: number
  headerTimeout?: number | false
  afterCompletion?: number
  cancelAfter?: number
}) {
  return Effect.gen(function* () {
    const caller = new AbortController()
    const state = { signal: undefined as AbortSignal | undefined, aborts: 0, requests: 0 }
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const clearTimers = () => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const originalFetch = globalThis.fetch
        const originalTimeout = process.env.ALTIMATE_STREAM_IDLE_TIMEOUT_MS
        if (options.idleTimeout === undefined) delete process.env.ALTIMATE_STREAM_IDLE_TIMEOUT_MS
        else process.env.ALTIMATE_STREAM_IDLE_TIMEOUT_MS = String(options.idleTimeout)
        const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input instanceof Request ? input.url : String(input)
          if (!url.startsWith("https://idle-timeout.test/")) return originalFetch(input, init)
          state.requests++
          state.signal = init?.signal ?? undefined
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              const abort = () => {
                state.aborts++
                clearTimers()
                if (caller.signal.aborted) controller.error(caller.signal.reason)
              }
              state.signal?.addEventListener("abort", abort, { once: true })
              if (options.cancelAfter !== undefined) {
                timers.add(
                  setTimeout(
                    () => caller.abort(new DOMException("Cancelled by user", "AbortError")),
                    options.cancelAfter,
                  ),
                )
              }
              for (const [index, delay] of options.delays.entries()) {
                timers.add(
                  setTimeout(() => {
                    controller.enqueue(
                      new TextEncoder().encode('data: {"choices":[{"delta":{"content":"chunk"}}]}\n\n'),
                    )
                    if (index !== options.delays.length - 1) return
                    controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
                    controller.close()
                    // Count late aborts too: the request must stay un-aborted during tool work.
                    state.signal?.removeEventListener("abort", abort)
                    state.signal?.addEventListener("abort", () => state.aborts++, { once: true })
                  }, delay),
                )
              }
            },
            cancel: clearTimers,
          })
          return new Response(body, {
            headers: options.contentType ? { "content-type": options.contentType } : undefined,
          })
        }
        globalThis.fetch = Object.assign(fakeFetch, { preconnect: originalFetch.preconnect.bind(originalFetch) })
        return { originalFetch, originalTimeout }
      }),
      ({ originalFetch, originalTimeout }) =>
        Effect.sync(() => {
          clearTimers()
          globalThis.fetch = originalFetch
          if (originalTimeout === undefined) delete process.env.ALTIMATE_STREAM_IDLE_TIMEOUT_MS
          else process.env.ALTIMATE_STREAM_IDLE_TIMEOUT_MS = originalTimeout
        }),
    )

    return yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderID.make("test"), ModelID.make("test-model"))
          const result = streamText({
            model: yield* provider.getLanguage(model),
            maxRetries: 0,
            abortSignal: caller.signal,
            onError() {},
            messages: [{ role: "user", content: "hello" }],
          })
          const output = yield* Effect.promise(async () => {
            let text = ""
            let error: unknown
            try {
              for await (const part of result.fullStream) {
                if (part.type === "text-delta") text += part.text
                if (part.type === "error") error = part.error
              }
            } catch (cause) {
              error = cause
            }
            if (options.afterCompletion) await new Promise((resolve) => setTimeout(resolve, options.afterCompletion))
            return { text, error }
          })
          return { ...state, ...output }
        }),
      {
        config: () => {
          const config = testProviderConfig("https://idle-timeout.test")
          return {
            ...config,
            provider: {
              test: {
                ...config.provider.test,
                options: {
                  ...config.provider.test.options,
                  chunkTimeout: options.chunkTimeout,
                  headerTimeout: options.headerTimeout,
                },
              },
            },
          }
        },
      },
    )
  })
}
// altimate_change end
