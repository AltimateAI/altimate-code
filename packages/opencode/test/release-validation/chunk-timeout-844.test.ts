import { describe, test, expect } from "bun:test"
import { readFileSync } from "fs"
import path from "path"

import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"

// PR #844 — raise the provider SSE chunk-watchdog default from 2min (120_000) to 5min (300_000).
//
// The watchdog lives in `getSDK` (provider.ts): a per-request fetch wrapper builds a
// `chunkAbortCtl` AbortController, combines it with any per-request and per-provider
// timeout signals via `AbortSignal.any`, then routes the fetched Response through the
// module-private `wrapSSE(res, ms, ctl)`. `wrapSSE` arms a `setTimeout(ms)` that aborts
// the controller + cancels the reader and rejects with "SSE read timed out" if no chunk
// arrives within `ms`.
//
// `DEFAULT_CHUNK_TIMEOUT`, `wrapSSE`, and `getSDK` are all module-private. We do NOT edit
// source to export them. Instead we reach the EXACT source-built fetch wrapper through a
// supported public path: a provider configured with `npm: "file://<local module>"` makes
// `getSDK` import our local module and call its `create*` factory with the assembled
// `options`, including the `options.fetch` wrapper it just built. The factory captures that
// wrapper; we then drive it directly with a stubbed global `fetch` and crafted Responses.
// This exercises the real source code, not a re-implementation.

const PROVIDER_SOURCE = readFileSync(path.join(import.meta.dir, "../../src/provider/provider.ts"), "utf8")

const FETCH_KEY = "__chunkTimeout844_capturedFetch__"

type FetchWrapper = (input: any, init?: any) => Promise<Response>

/**
 * Writes a tmp opencode.json with a custom provider whose npm points at a local module via
 * `file://`. The module's `createFake` factory stashes the source-built `options.fetch`
 * wrapper on globalThis under FETCH_KEY. Returns nothing; the caller resolves the wrapper
 * after `Provider.getLanguage`.
 */
async function writeCapturingProvider(dir: string, options: Record<string, unknown>) {
  const modPath = path.join(dir, "fake-provider.mjs")
  await Bun.write(
    modPath,
    `export function createFake(opts) {\n` +
      `  globalThis[${JSON.stringify(FETCH_KEY)}] = opts.fetch;\n` +
      `  return { languageModel: () => ({ id: opts.name }) };\n` +
      `}\n`,
  )
  await Bun.write(
    path.join(dir, "opencode.json"),
    JSON.stringify({
      $schema: "https://altimate.ai/config.json",
      provider: {
        fakeprov: {
          name: "Fake Provider",
          npm: "file://" + modPath,
          env: [],
          models: {
            m1: { name: "M1", tool_call: true, limit: { context: 8000, output: 2000 } },
          },
          options,
        },
      },
    }),
  )
}

/** Resolves the SDK (running the real `getSDK`) and returns the captured fetch wrapper. */
async function captureWrapper(): Promise<FetchWrapper> {
  delete (globalThis as any)[FETCH_KEY]
  const parsed = Provider.parseModel("fakeprov/m1")
  const model = await Provider.getModel(parsed.providerID, parsed.modelID)
  await Provider.getLanguage(model)
  const wrapper = (globalThis as any)[FETCH_KEY]
  expect(typeof wrapper).toBe("function")
  return wrapper as FetchWrapper
}

function sseResponse(chunks: string[], close = false): Response {
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (i < chunks.length) {
        ctrl.enqueue(new TextEncoder().encode(chunks[i++]))
        return
      }
      if (close) ctrl.close()
      // else: stall forever — never enqueue, never close (simulates a stuck stream)
    },
  })
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

describe("PR #844 — DEFAULT_CHUNK_TIMEOUT 2min→5min", () => {
  // Gap 1: default falls back to 300_000 (NOT the old 120_000) when no chunkTimeout is configured.
  test("default_chunk_timeout_value_is_5min: wrapSSE arms setTimeout(300000) when chunkTimeout omitted", async () => {
    await using tmp = await tmpdir({ init: (dir) => writeCapturingProvider(dir, { apiKey: "x" }) })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const wrapper = await captureWrapper()
        const origFetch = globalThis.fetch
        const origSetTimeout = globalThis.setTimeout
        const delays: number[] = []
        // Stub global fetch (no custom fetch configured → wrapper calls global fetch) to return SSE.
        globalThis.fetch = (async () => sseResponse(["data: hi\n\n"])) as any
        // Stub setTimeout to record the delay wrapSSE arms, then delegate so timers still work.
        globalThis.setTimeout = ((fn: any, ms?: any, ...rest: any[]) => {
          if (typeof ms === "number") delays.push(ms)
          return origSetTimeout(fn, ms, ...rest)
        }) as any
        try {
          const res = await wrapper("http://x/v1/chat", { method: "POST" })
          const reader = res.body!.getReader()
          await reader.read() // first pull arms the wrapSSE watchdog timer
          await reader.cancel() // stop the stream so the test exits cleanly
          // The watchdog delay must be the new 5-minute default, not the old 2-minute value.
          expect(delays).toContain(300_000)
          expect(delays).not.toContain(120_000)
        } finally {
          globalThis.fetch = origFetch
          globalThis.setTimeout = origSetTimeout
        }
      },
    })
  })

  // Gap 2: wrapSSE aborts after a chunk gap — one chunk then stall → second read rejects + ctl aborts.
  test("wrapSSE_aborts_after_chunk_gap: rejects with 'SSE read timed out' and aborts the request signal", async () => {
    await using tmp = await tmpdir({ init: (dir) => writeCapturingProvider(dir, { apiKey: "x", chunkTimeout: 50 }) })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const wrapper = await captureWrapper()
        const origFetch = globalThis.fetch
        let seenSignal: AbortSignal | undefined
        globalThis.fetch = (async (_input: any, init?: any) => {
          seenSignal = init?.signal // combined signal includes chunkAbortCtl.signal
          return sseResponse(["data: first\n\n"]) // one chunk, then stalls forever
        }) as any
        try {
          const res = await wrapper("http://x/v1/chat", { method: "POST" })
          const reader = res.body!.getReader()
          const first = await reader.read()
          expect(new TextDecoder().decode(first.value)).toContain("first")
          // The combined request signal is not yet aborted before the gap fires.
          expect(seenSignal?.aborted).toBe(false)
          let err: any
          try {
            await reader.read() // no further chunk within 50ms → watchdog fires
          } catch (e) {
            err = e
          }
          expect(err).toBeInstanceOf(Error)
          expect(err.message).toBe("SSE read timed out")
          // ctl.abort(err) propagated into the combined request signal.
          expect(seenSignal?.aborted).toBe(true)
        } finally {
          globalThis.fetch = origFetch
        }
      },
    })
  })

  // Gap 3: wrapSSE passthrough — non-SSE content-type and null body are returned unwrapped (by reference).
  describe("wrapSSE_passthrough_for_non_sse", () => {
    test("non-SSE content-type (application/json) is returned unchanged", async () => {
      await using tmp = await tmpdir({ init: (dir) => writeCapturingProvider(dir, { apiKey: "x" }) })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const wrapper = await captureWrapper()
          const origFetch = globalThis.fetch
          const jsonRes = new Response(JSON.stringify({ ok: true }), {
            headers: { "content-type": "application/json" },
          })
          globalThis.fetch = (async () => jsonRes) as any
          try {
            const out = await wrapper("http://x/v1/chat", { method: "POST" })
            expect(out).toBe(jsonRes) // same reference — never wrapped
          } finally {
            globalThis.fetch = origFetch
          }
        },
      })
    })

    test("SSE response with null body is returned unchanged", async () => {
      await using tmp = await tmpdir({ init: (dir) => writeCapturingProvider(dir, { apiKey: "x" }) })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const wrapper = await captureWrapper()
          const origFetch = globalThis.fetch
          const nullBodyRes = new Response(null, { headers: { "content-type": "text/event-stream" } })
          globalThis.fetch = (async () => nullBodyRes) as any
          try {
            const out = await wrapper("http://x/v1/chat", { method: "POST" })
            expect(out).toBe(nullBodyRes) // same reference — null body short-circuits wrapSSE
          } finally {
            globalThis.fetch = origFetch
          }
        },
      })
    })

    // `ms <= 0` passthrough (provider.ts:71) is the disable guard inside wrapSSE. The config
    // schema (.positive()) and the `chunkTimeout > 0` guard in getSDK prevent ms<=0 from ever
    // reaching wrapSSE through the public wrapper, so this case is asserted at the source level.
    test("source: wrapSSE returns res unchanged when ms <= 0 (disable guard present)", () => {
      const normalized = PROVIDER_SOURCE.replace(/\s+/g, " ")
      expect(normalized).toContain("function wrapSSE(res: Response, ms: number, ctl: AbortController)")
      expect(normalized).toContain('if (typeof ms !== "number" || ms <= 0) return res')
      expect(normalized).toContain("if (!res.body) return res")
      expect(normalized).toContain('if (!res.headers.get("content-type")?.includes("text/event-stream")) return res')
    })
  })

  // Gap 4: the watchdog can be fully disabled — chunkAbortCtl is undefined for non-positive
  // chunkTimeout, and the fetch wrapper returns the raw res without wrapSSE in that case.
  // The config schema blocks chunkTimeout<=0, so the disable path is asserted at the source level.
  test("chunk_abort_controller_disabled_when_timeout_non_positive: source guards present", () => {
    const normalized = PROVIDER_SOURCE.replace(/\s+/g, " ")
    // chunkAbortCtl only constructed for a positive numeric chunkTimeout.
    expect(normalized).toContain(
      'const chunkAbortCtl = typeof chunkTimeout === "number" && chunkTimeout > 0 ? new AbortController() : undefined',
    )
    // When no chunkAbortCtl, the raw response is returned without wrapSSE.
    expect(normalized).toContain("if (!chunkAbortCtl) return res")
    expect(normalized).toContain("return wrapSSE(res, chunkTimeout, chunkAbortCtl)")
    // The default itself is the new 5-minute value.
    expect(normalized).toContain("const DEFAULT_CHUNK_TIMEOUT = 300_000")
    expect(normalized).not.toContain("const DEFAULT_CHUNK_TIMEOUT = 120_000")
  })

  // Gap 5: a short per-request timeout still wins even with the new 5-minute chunk default —
  // both are combined via AbortSignal.any, and the request timeout aborts first.
  test("chunk_and_request_timeout_combine_via_AbortSignal_any: request timeout (100ms) aborts before 5min chunk window", async () => {
    await using tmp = await tmpdir({ init: (dir) => writeCapturingProvider(dir, { apiKey: "x", timeout: 100 }) })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const wrapper = await captureWrapper()
        const origFetch = globalThis.fetch
        let seenSignal: AbortSignal | undefined
        // Non-SSE response so wrapSSE passes it through; we only care about the combined signal.
        globalThis.fetch = (async (_input: any, init?: any) => {
          seenSignal = init?.signal
          return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } })
        }) as any
        try {
          await wrapper("http://x/v1/chat", { method: "POST" })
          expect(seenSignal).toBeInstanceOf(AbortSignal)
          // Not yet aborted right after the call.
          expect(seenSignal?.aborted).toBe(false)
          // Wait past the 100ms request timeout but FAR below the 300_000ms chunk default.
          await new Promise((r) => origFetchTimeout(r, 160))
          // The request-level timeout fired — proving the 5min bump did not extend it.
          expect(seenSignal?.aborted).toBe(true)
        } finally {
          globalThis.fetch = origFetch
        }
      },
    })
  })
})

// Capture the real setTimeout up front so gap-5's wait is unaffected by any per-test stubbing.
const origFetchTimeout = globalThis.setTimeout
