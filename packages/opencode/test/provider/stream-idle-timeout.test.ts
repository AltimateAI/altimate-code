// altimate_change start — stream watchdog deadlines, overrides, content types, and cancellation
import { afterEach, expect, spyOn } from "bun:test"
import { generateText, jsonSchema, streamText } from "ai"
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

it.live("the stream wrapper delegates class models with private fields", () =>
  provideTmpdirInstance(
    () =>
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        const model = yield* provider.getModel(ProviderID.make("test"), ModelID.make("test-model"))
        const language = yield* provider.getLanguage(model)
        const streamed = streamText({ model: language, maxRetries: 0, prompt: "hello" })

        expect(yield* Effect.promise(() => streamed.text)).toBe("private state")
        expect(language.provider).toBe("private-field")
        expect(language.modelId).toBe("test-model")
        const urls = yield* Effect.promise(() => Promise.resolve(language.supportedUrls))
        expect(urls["image/*"][0].test("https://private-field.test/image.png")).toBe(true)
        const generated = yield* Effect.promise(() => generateText({ model: language, prompt: "hello" }))
        expect(generated.text).toBe("private state")
        expect(yield* provider.getLanguage(model)).toBe(language)
      }),
    {
      config: () => {
        const config = testProviderConfig("https://private-field.test")
        config.provider.test.npm = new URL("./fixtures/private-field-provider.ts", import.meta.url).href
        return config
      },
    },
  ),
)

for (const contentType of ["text/event-stream", "application/vnd.amazon.eventstream"]) {
  it.live(`idle model body is aborted without retry after partial output with ${contentType}`, () =>
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
      expect(data.isRetryable).toBe(false)
      expect(data.message).toContain(ProviderError.MODEL_STOPPED_RESPONDING)
      expect(SessionRetry.retryable(classified)).toBeUndefined()
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

it.live("a stall before the first chunk retries the request", () =>
  Effect.gen(function* () {
    const result = yield* request({ contentType: "text/event-stream", delays: [180], idleTimeout: 50, retry: true })

    expect(result.requests).toBe(2)
    expect(result.text).toBe("chunk")
    expect(result.error).toBeUndefined()
  }),
)

it.live("SSE heartbeats and metadata before a stall remain safe to retry", () =>
  Effect.gen(function* () {
    const result = yield* request({
      contentType: "text/event-stream",
      delays: [0, 180],
      idleTimeout: 50,
      retry: true,
      chunks: [': heartbeat\n\ndata: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'],
    })
    expect(result.requests).toBe(2)
    expect(result.text).toBe("chunk")
    expect(result.error).toBeUndefined()
  }),
)

it.live("a stall after text does not replay the request", () =>
  Effect.gen(function* () {
    const result = yield* request({ contentType: "text/event-stream", delays: [0, 180], idleTimeout: 50, retry: true })

    expect(result.requests).toBe(1)
    expect(result.text).toBe("chunk")
    expect(result.error).toBeInstanceOf(ProviderError.StreamIdleTimeoutError)
  }),
)

it.live("a stall after a tool call does not execute the tool twice", () =>
  Effect.gen(function* () {
    const result = yield* request({
      contentType: "text/event-stream",
      delays: [0, 180],
      chunks: [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_mutate","type":"function","function":{"name":"mutate","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      ],
      idleTimeout: 50,
      retry: true,
    })

    expect(result.executions).toBe(1)
    expect(result.requests).toBe(1)
    expect(result.error).toBeInstanceOf(ProviderError.StreamIdleTimeoutError)
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

it.live("SSE keepalives every 10ms time out at the 50ms model-output deadline", () =>
  Effect.gen(function* () {
    const result = yield* request({
      contentType: "text/event-stream",
      delays: Array.from({ length: 15 }, (_, i) => i * 10),
      chunks: Array(15).fill(": keepalive\n\n"),
      idleTimeout: 50,
    })

    expect(result.error).toBeInstanceOf(ProviderError.StreamIdleTimeoutError)
    expect(result.text).toBe("")
    expect(result.aborts).toBe(1)
  }),
)

it.live("SSE data every 10ms resets the 50ms model-output deadline", () =>
  Effect.gen(function* () {
    const result = yield* request({
      contentType: "text/event-stream",
      delays: Array.from({ length: 15 }, (_, i) => i * 10),
      idleTimeout: 50,
    })

    expect(result.error).toBeUndefined()
    expect(result.text).toBe("chunk".repeat(15))
    expect(result.aborts).toBe(0)
  }),
)

for (const eventType of ["ping", "keepalive", "heartbeat"]) {
  it.live(`SSE event: ${eventType} with data every 10ms times out at the 50ms deadline`, () =>
    Effect.gen(function* () {
      const frame = new TextEncoder().encode(`event: ${eventType}\ndata: {"type":"ping"}\n\n`)
      const result = yield* requestBody("text/event-stream", Array(15).fill(frame))

      expect(result.error).toBeInstanceOf(ProviderError.StreamIdleTimeoutError)
      expect(result.chunks.length).toBeLessThan(15)
      expect(result.signal?.aborted).toBe(true)
      expect(result.cancelled).toBe(true)
    }),
  )
}

it.live("SSE ping data without an event field every 10ms times out at the 50ms deadline", () =>
  Effect.gen(function* () {
    const frame = new TextEncoder().encode('data: {"type":"ping"}\n\n')
    const result = yield* requestBody("text/event-stream", Array(15).fill(frame))

    expect(result.error).toBeInstanceOf(ProviderError.StreamIdleTimeoutError)
    expect(result.chunks.length).toBeLessThan(15)
    expect(result.signal?.aborted).toBe(true)
  }),
)

for (const padding of ["leading", "trailing"]) {
  it.live(`SSE ping data with long ${padding} whitespace does not reset the deadline`, () =>
    Effect.gen(function* () {
      const spaces = " ".repeat(100)
      const payload = padding === "leading" ? `${spaces}{"type":"ping"}` : `{"type":"ping"}${spaces}`
      const frame = new TextEncoder().encode(`data: ${payload}\n\n`)
      const result = yield* requestBody("text/event-stream", Array(15).fill(frame))

      expect(result.error).toBeInstanceOf(ProviderError.StreamIdleTimeoutError)
      expect(result.chunks.length).toBeLessThan(15)
    }),
  )
}

it.live("SSE data after a split UTF-8 BOM resets the deadline", () =>
  Effect.gen(function* () {
    const frame = new TextEncoder().encode('\uFEFFdata: {"text":"hello"}\n\n')
    const chunks = [frame.slice(0, 1), frame.slice(1), new TextEncoder().encode(": keepalive\n\n")]
    const result = yield* requestBody("text/event-stream", chunks, [0, 30, 65])

    expect(result.error).toBeUndefined()
    expect(result.chunks).toEqual(chunks)
  }),
)

it.live("SSE content_block_delta events reset the deadline", () =>
  Effect.gen(function* () {
    const frame = new TextEncoder().encode('event: content_block_delta\ndata: {"text":"hello"}\n\n')
    const chunks = Array(15).fill(frame)
    const result = yield* requestBody("text/event-stream", chunks)

    expect(result.error).toBeUndefined()
    expect(result.chunks).toEqual(chunks)
    expect(result.signal?.aborted).toBe(false)
  }),
)

it.live("SSE real data lines longer than 64 bytes reset the deadline", () =>
  Effect.gen(function* () {
    const frame = new TextEncoder().encode(`data: {"text":"${"x".repeat(256)}"}\n\n`)
    const chunks = Array(15).fill(frame)
    const result = yield* requestBody("text/event-stream", chunks)

    expect(result.error).toBeUndefined()
    expect(result.chunks).toEqual(chunks)
    expect(result.signal?.aborted).toBe(false)
  }),
)

it.live("SSE event fields after split data lines apply until the CRLF block boundary", () =>
  Effect.gen(function* () {
    const chunks = Array.from({ length: 8 }, () => ['data: {"text":"hello"}\r', "\nevent: ping\r\n\r\n"])
      .flat()
      .map((value) => new TextEncoder().encode(value))
    const result = yield* requestBody("text/event-stream", chunks)

    expect(result.error).toBeInstanceOf(ProviderError.StreamIdleTimeoutError)
    expect(result.chunks.length).toBeLessThan(chunks.length)
  }),
)

it.live("SSE event fields reset at blank lines before subsequent data blocks", () =>
  Effect.gen(function* () {
    const chunks = ['event: ping\ndata: {"type":"ping"}\n\n', ...Array(14).fill('data: {"text":"hello"}\n\n')].map(
      (value) => new TextEncoder().encode(value),
    )
    const result = yield* requestBody("text/event-stream", chunks)

    expect(result.error).toBeUndefined()
    expect(result.chunks).toEqual(chunks)
  }),
)

for (const chunk of [": keepalive\n\n", "\n\r\n", "event: ping\nid: 1\nretry: 10\n\n"]) {
  it.live(`SSE protocol-only bytes ${JSON.stringify(chunk)} are forwarded without resetting the deadline`, () =>
    Effect.gen(function* () {
      const bytes = new TextEncoder().encode(chunk)
      const result = yield* requestBody("text/event-stream", Array(15).fill(bytes))

      expect(result.error).toBeInstanceOf(ProviderError.StreamIdleTimeoutError)
      expect((result.error as ProviderError.StreamIdleTimeoutError).emitted).toBe(true)
      expect(result.chunks.length).toBeGreaterThan(0)
      expect(result.chunks.length).toBeLessThan(15)
      for (const value of result.chunks) expect(value).toEqual(bytes)
      expect(result.signal?.aborted).toBe(true)
      expect(result.cancelled).toBe(true)
    }),
  )
}

it.live("an SSE data line split across chunks resets the deadline once complete", () =>
  Effect.gen(function* () {
    const chunks = ["da", 'ta: {"text":"hello"}\r\n\r', '\ndata: {"text":"world"}\n\n'].map((value) =>
      new TextEncoder().encode(value),
    )
    const result = yield* requestBody("text/event-stream", chunks, [0, 30, 65])

    expect(result.error).toBeUndefined()
    expect(result.chunks).toEqual(chunks)
    expect(result.signal?.aborted).toBe(false)
  }),
)

it.live("an incomplete SSE data line does not reset the deadline", () =>
  Effect.gen(function* () {
    const chunks = ["data:", ...Array(14).fill(" ")].map((value) => new TextEncoder().encode(value))
    const result = yield* requestBody("text/event-stream", chunks)

    expect(result.error).toBeInstanceOf(ProviderError.StreamIdleTimeoutError)
    expect(result.chunks.length).toBeLessThan(chunks.length)
  }),
)

for (const eventType of ["heartbeat", "ping", "keepalive", "metadata"]) {
  it.live(`Amazon event-stream ${eventType} frames do not reset the deadline`, () =>
    Effect.gen(function* () {
      const frame = eventFrame(eventType)
      const result = yield* requestBody("application/vnd.amazon.eventstream", Array(15).fill(frame))

      expect(result.error).toBeInstanceOf(ProviderError.StreamIdleTimeoutError)
      expect((result.error as ProviderError.StreamIdleTimeoutError).emitted).toBe(true)
      expect(result.chunks.length).toBeGreaterThan(0)
      expect(result.chunks.length).toBeLessThan(15)
      for (const value of result.chunks) expect(value).toEqual(frame)
      expect(result.signal?.aborted).toBe(true)
    }),
  )
}

it.live("Amazon event-stream chunk frames reset the deadline", () =>
  Effect.gen(function* () {
    const chunks = Array(15).fill(eventFrame("chunk"))
    const result = yield* requestBody("application/vnd.amazon.eventstream", chunks)

    expect(result.error).toBeUndefined()
    expect(result.chunks).toEqual(chunks)
    expect(result.signal?.aborted).toBe(false)
  }),
)

it.live("Amazon event-stream chunk headers and slow payload pieces keep resetting the deadline", () =>
  Effect.gen(function* () {
    const headers = eventFrame("chunk").slice(0, -4)
    const pieces = Array.from({ length: 8 }, () => new Uint8Array(1024))
    new DataView(headers.buffer).setUint32(0, headers.length + 8 * 1024 + 4)
    const chunks = [headers.slice(0, 12), headers.slice(12), ...pieces, new Uint8Array(4)]
    const result = yield* requestBody(
      "application/vnd.amazon.eventstream",
      chunks,
      chunks.map((_, i) => i * 30),
    )

    expect(result.error).toBeUndefined()
    expect(result.chunks).toEqual(chunks)
    expect(result.signal?.aborted).toBe(false)
  }),
)

it.live("Amazon event-stream heartbeat frames with typed headers do not reset the deadline", () =>
  Effect.gen(function* () {
    const headers = Uint8Array.from(
      [0, 0, 1, 2, 4, 8, 2, 2, 8, 16].flatMap((length, type) => [1, 97 + type, type, ...Array(length).fill(0)]),
    )
    const frame = eventFrame("heartbeat", headers)
    const result = yield* requestBody("application/vnd.amazon.eventstream", Array(15).fill(frame))

    expect(result.error).toBeInstanceOf(ProviderError.StreamIdleTimeoutError)
    expect(result.chunks.length).toBeLessThan(15)
  }),
)

it.live("a malformed header after an Amazon event-stream heartbeat counts as output", () =>
  Effect.gen(function* () {
    const frame = eventFrame("heartbeat", new Uint8Array(), new Uint8Array([1, 120, 255]))
    const chunks = Array(15).fill(frame)
    const result = yield* requestBody("application/vnd.amazon.eventstream", chunks)

    expect(result.error).toBeUndefined()
    expect(result.chunks).toEqual(chunks)
  }),
)

it.live("split and coalesced Amazon event-stream frames reset only for model output", () =>
  Effect.gen(function* () {
    const heartbeat = eventFrame("heartbeat")
    const chunk = eventFrame("chunk")
    const combined = new Uint8Array(heartbeat.length + chunk.length)
    combined.set(heartbeat)
    combined.set(chunk, heartbeat.length)
    const chunks = [chunk.slice(0, 6), chunk.slice(6), combined]
    const result = yield* requestBody("application/vnd.amazon.eventstream", chunks, [0, 30, 65])

    expect(result.error).toBeUndefined()
    expect(result.chunks).toEqual(chunks)
  }),
)

it.live("split Amazon event-stream heartbeat frames do not reset the deadline", () =>
  Effect.gen(function* () {
    const frame = eventFrame("heartbeat")
    const chunks = Array.from({ length: 8 }, () => [frame.slice(0, 6), frame.slice(6)]).flat()
    const result = yield* requestBody("application/vnd.amazon.eventstream", chunks)

    expect(result.error).toBeInstanceOf(ProviderError.StreamIdleTimeoutError)
    expect(result.chunks.length).toBeLessThan(chunks.length)
  }),
)

for (const invalid of ["prelude", "header"] as const) {
  it.live(`an unparseable Amazon event-stream ${invalid} counts as output`, () =>
    Effect.gen(function* () {
      const frame = eventFrame("heartbeat")
      if (invalid === "prelude") new DataView(frame.buffer).setUint32(0, 1)
      else frame[12] = 255
      const chunks = Array(15).fill(frame)
      const result = yield* requestBody("application/vnd.amazon.eventstream", chunks)

      expect(result.error).toBeUndefined()
      expect(result.chunks).toEqual(chunks)
      expect(result.signal?.aborted).toBe(false)
    }),
  )
}

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

// Capture the real fetch wrapper through a temporary provider so binary frames reach
// the watchdog without an unrelated SDK decoder consuming or rejecting them first.
function requestBody(contentType: string, chunks: Uint8Array[], delays = chunks.map((_, i) => i * 10)) {
  return provideTmpdirInstance((directory) =>
    Effect.gen(function* () {
      const moduleURL = new URL(`file://${directory}/capture-provider.mjs`).href
      yield* Effect.promise(async () => {
        await Bun.write(
          new URL(moduleURL),
          "export let fetch; export function createProvider(options) { fetch = options.fetch; return { languageModel: () => ({}) } }",
        )
        const config = testProviderConfig("https://idle-timeout.test")
        config.provider.test.npm = moduleURL
        await Bun.write(`${directory}/opencode.json`, JSON.stringify(config))
      })
      const state = { signal: undefined as AbortSignal | undefined, cancelled: false }
      const timers = new Set<ReturnType<typeof setTimeout>>()
      const clearTimers = () => {
        for (const timer of timers) clearTimeout(timer)
      }
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const originalFetch = globalThis.fetch
          const originalTimeout = process.env.ALTIMATE_STREAM_IDLE_TIMEOUT_MS
          process.env.ALTIMATE_STREAM_IDLE_TIMEOUT_MS = "50"
          const fakeFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
            state.signal = init?.signal ?? undefined
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  for (const [index, delay] of delays.entries()) {
                    timers.add(
                      setTimeout(() => {
                        controller.enqueue(chunks[index])
                        if (index === chunks.length - 1) controller.close()
                      }, delay),
                    )
                  }
                },
                cancel() {
                  state.cancelled = true
                  clearTimers()
                },
              }),
              { headers: { "content-type": contentType } },
            )
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
      const provider = yield* Provider.Service
      const model = yield* provider.getModel(ProviderID.make("test"), ModelID.make("test-model"))
      yield* provider.getLanguage(model)
      return yield* Effect.promise(async () => {
        const sdk = await import(moduleURL)
        const response: Response = await sdk.fetch("https://idle-timeout.test/stream")
        const reader = response.body!.getReader()
        const received: Uint8Array[] = []
        let error: unknown
        try {
          while (true) {
            const part = await reader.read()
            if (part.done) break
            received.push(part.value)
          }
        } catch (cause) {
          error = cause
        } finally {
          reader.releaseLock()
        }
        return { ...state, chunks: received, error }
      })
    }),
  )
}

function eventFrame(eventType: string, before = new Uint8Array(), after = new Uint8Array()) {
  const name = new TextEncoder().encode(":event-type")
  const value = new TextEncoder().encode(eventType)
  const headersLength = before.length + 1 + name.length + 1 + 2 + value.length + after.length
  // CRCs and payload are opaque to the watchdog; only framing and headers matter.
  const frame = new Uint8Array(16 + headersLength)
  const view = new DataView(frame.buffer)
  view.setUint32(0, frame.length)
  view.setUint32(4, headersLength)
  frame.set(before, 12)
  const start = 12 + before.length
  frame[start] = name.length
  frame.set(name, start + 1)
  frame[start + 1 + name.length] = 7 // string header
  view.setUint16(start + 2 + name.length, value.length)
  frame.set(value, start + 4 + name.length)
  frame.set(after, start + 4 + name.length + value.length)
  return frame
}

function request(options: {
  contentType?: string
  delays: number[]
  chunks?: string[]
  retry?: boolean
  idleTimeout?: number
  chunkTimeout?: number
  headerTimeout?: number | false
  afterCompletion?: number
  cancelAfter?: number
}) {
  return Effect.gen(function* () {
    const caller = new AbortController()
    const state = { signal: undefined as AbortSignal | undefined, aborts: 0, requests: 0, executions: 0 }
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
              const delays = state.requests > 1 ? [0] : options.delays
              for (const [index, delay] of delays.entries()) {
                timers.add(
                  setTimeout(() => {
                    controller.enqueue(
                      new TextEncoder().encode(
                        (state.requests === 1 ? options.chunks?.[index] : undefined) ?? 'data: {"choices":[{"delta":{"content":"chunk"}}]}\n\n',
                      ),
                    )
                    if (index !== delays.length - 1) return
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
          const language = yield* provider.getLanguage(model)
          const output = yield* Effect.promise(async () => {
            let text = ""
            let error: unknown
            for (let attempt = 0; attempt < (options.retry ? 2 : 1); attempt++) {
              error = undefined
              const result = streamText({
                model: language,
                maxRetries: 0,
                abortSignal: caller.signal,
                onError() {},
                messages: [{ role: "user", content: "hello" }],
                tools: {
                  mutate: {
                    inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
                    execute: async () => {
                      state.executions++
                      return "done"
                    },
                  },
                },
              })
              try {
                for await (const part of result.fullStream) {
                  if (part.type === "text-delta") text += part.text
                  if (part.type === "error") error = part.error
                }
              } catch (cause) {
                error = cause
              }
              if (!error || !SessionRetry.retryable(MessageV2.fromError(error, { providerID: ProviderID.make("test") })))
                break
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
