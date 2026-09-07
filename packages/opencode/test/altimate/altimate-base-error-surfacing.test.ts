// Suite F (renamed here to match the shipped filename) from
// docs/internal/2026-09-04-altimate-base-e2e-harness-plan.md: inference-time failure surfacing
// that is NOT rate-limit/budget (that's `altimate-base-rate-limit-messages.test.ts`, née Suite D
// / the flagged gap in the plan's Deliverable 1 "E" table) and NOT the 401 consecutive-count state
// machine itself (that's covered exhaustively in `altimate-base.test.ts`). This file only proves
// each raw inference-time failure mode reaches `FreeTier.authorizedFetch`'s caller cleanly:
//
//   - 5xx: `authorizedFetch` has no special handling for a non-401 response (client.ts:461-464) —
//     it just clears the unauthorized counter and returns the `Response` as-is. Assert it passes
//     through untouched and is never mis-mapped onto the rate-limit/budget message path.
//   - timeout/abort: `authorizedFetch` calls `fetch()` with no try/catch around `send(active)`
//     (client.ts:429-450) — a promise that only ever rejects (never resolves) once the caller's
//     `AbortSignal` fires must propagate as a rejection, not hang forever.
//   - connection failure: the identical no-try/catch code path handles a raw network error exactly
//     like an abort — `FakeGateway`'s `ChatMode` deliberately has no `"network"` knob (only
//     `RegisterMode` does; see fake-gateway.ts), so this file scripts one directly against
//     `globalThis.fetch` for a single call instead of adding an unused variant to the shared
//     fixture (see "Cross-file consent isolation" / ownership notes in the harness plan — the
//     shared fixture is owned by whichever suite needed it first).
//   - malformed JSON body: `authorizedFetch` does no JSON parsing of its own in the inference path
//     (docs/internal/2026-09-04-altimate-base-e2e-harness-plan.md, Deliverable 1 "H" table, last
//     row: "Not the client's problem — passed through to the AI SDK's own JSON parsing, which is
//     shared machinery, out of scope"). Assert the raw 200 response reaches the caller intact and
//     that parsing the bad body — and feeding it to the Altimate-Base-specific error mappers —
//     produces a sensible, catchable failure rather than a crash or corrupted state.
//   - 401: the counter/rotation state machine is `altimate-base.test.ts`'s job. This file only
//     confirms a chat-time 401 flows into `authorizedFetch`'s existing 401 branch instead of being
//     thrown, silently discarded, or retried in a loop.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { consented, isolateAltimateBaseHome, resetGatewayEnv } from "./_fixtures/altimate-base-harness"
import { FakeGateway, GATEWAY_URL } from "./_fixtures/fake-gateway"

isolateAltimateBaseHome("altimate-base-errors")

const { FreeTier } = await import("../../src/altimate/free/client")
const { FreeTierStore } = await import("../../src/altimate/free/store")

// Plays the role of the TUI host, exactly like `altimate-base.test.ts` and
// `altimate-base-harness-smoke.test.ts`. Minting a consent token goes through the shared
// `consented()` helper in `_fixtures/altimate-base-harness.ts`, which claims the process's ONE
// arming capability lazily and caches it — see that file for why (running multiple suite files in
// one `bun test` worker process means only the first call to `issueArmer()` may succeed).

const gateway = new FakeGateway()

function chatRequest(): [string, RequestInit] {
  return [
    `${GATEWAY_URL}/v1/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: FreeTier.MODEL_ID, messages: [{ role: "user", content: "hi" }] }),
    },
  ]
}

beforeEach(async () => {
  gateway.install()
  gateway.reset()
  await FreeTier.logout()
  await FreeTierStore.remove()
  resetGatewayEnv(GATEWAY_URL)
  // Every scenario below needs a live, registered credential before it can reach the inference
  // path at all — seed one the same way the harness smoke test does.
  gateway.registerNext({ kind: "ok" })
  await FreeTier.registerAfterConsent(consented())
})

afterEach(() => {
  gateway.restore()
})

describe("5xx pass-through during inference", () => {
  test.each([500, 502, 503])("status %d surfaces as-is, without crashing or being retried", async (status) => {
    gateway.chatNext({ kind: "server-error", status })
    const [url, init] = chatRequest()
    const response = await FreeTier.authorizedFetch(url, init)

    expect(response.status).toBe(status)
    const body = await response.text()
    expect(body).toBe("upstream error")
    expect(gateway.chatCalls).toHaveLength(1)

    // A 5xx must never be mis-mapped onto the rate-limit/budget message path.
    // `describeRateLimit` only recognizes a JSON `{error:{type,message}}` shape; the gateway's
    // plain-text 5xx body isn't that shape, so it must come back `undefined`, not a fabricated
    // rate-limit or budget message.
    expect(FreeTier.describeRateLimit({ body })).toBeUndefined()
  })
})

describe("chat-time timeout / abort", () => {
  test("a request that only rejects when its AbortSignal fires propagates as a rejection, never hangs", async () => {
    gateway.chatNext({ kind: "timeout" })
    const [url, init] = chatRequest()
    // A real (short) timer, not a synchronous abort — `authorizedFetch` awaits `credentialsForLoad()`
    // (a real file read) before it ever calls `fetch()`, so aborting synchronously right after
    // kicking off the call could fire before the fake gateway's `timeout` branch has attached its
    // `abort` listener. `AbortSignal.timeout` schedules the abort on a real timer instead, so it
    // always fires after the listener is attached.
    const promise = FreeTier.authorizedFetch(url, { ...init, signal: AbortSignal.timeout(50) })

    await expect(promise).rejects.toMatchObject({ name: "TimeoutError" })
    // The gateway saw exactly one attempt — no swallowed retry, no hang.
    expect(gateway.chatCalls).toHaveLength(1)
  })
})

describe("chat-time connection failure", () => {
  test("a raw network error (fetch rejection) propagates cleanly instead of hanging or being swallowed", async () => {
    // `FakeGateway`'s `ChatMode` has no `"network"` knob (only `RegisterMode` does) — the reason is
    // that a raw network failure and an aborted/timed-out request take the identical code path in
    // `authorizedFetch` (client.ts:429-450 has no try/catch around `send(active)`), so this test
    // scripts the failure directly against `globalThis.fetch` for one call instead of adding an
    // unused variant to the shared fixture. `gatewayFetch` captures the exact mock object
    // `FakeGateway.install()` put on `globalThis.fetch` (the same object `spyOn` returned), so
    // restoring it afterward leaves `gateway.restore()` in `afterEach` fully consistent.
    const gatewayFetch = globalThis.fetch
    const connectionReset = new Error("connection reset")
    globalThis.fetch = (async () => {
      throw connectionReset
    }) as unknown as typeof fetch

    try {
      const [url, init] = chatRequest()
      const promise = FreeTier.authorizedFetch(url, init)
      await expect(promise).rejects.toBe(connectionReset)
    } finally {
      globalThis.fetch = gatewayFetch
    }
  })
})

describe("malformed JSON response body during inference", () => {
  test("a 200 with an unparseable body reaches the caller intact instead of crashing", async () => {
    gateway.chatNext({ kind: "malformed-json" })
    const [url, init] = chatRequest()
    const response = await FreeTier.authorizedFetch(url, init)

    // `authorizedFetch` does no JSON parsing of its own in the inference path — it must resolve
    // with the raw 200 response, not throw and not silently substitute a different status.
    expect(response.status).toBe(200)
    const raw = await response.text()
    expect(raw).toBe("{not json")

    // Parsing the bad body is the caller's job (the AI SDK's own JSON parsing); prove that job
    // produces a sensible, catchable error rather than a hang or a silently wrong value.
    expect(() => JSON.parse(raw)).toThrow(SyntaxError)

    // The Altimate-Base-specific error mappers must also degrade gracefully on this same malformed
    // body — both already catch a `JSON.parse` failure and return `undefined` rather than crashing.
    expect(FreeTier.describeRateLimit({ body: raw })).toBeUndefined()
    expect(FreeTier.describeRequestTooLarge(raw)).toBeUndefined()
  })
})

describe("chat-time 401", () => {
  test("a 401 during inference is surfaced through authorizedFetch, not thrown or retried in a loop", async () => {
    gateway.chatNext({ kind: "unauthorized" })
    const [url, init] = chatRequest()
    const response = await FreeTier.authorizedFetch(url, init)

    // The consecutive-401 counter / disk-persistence state machine itself is `altimate-base.test.ts`'s
    // job; this only confirms the response flows into that existing branch cleanly.
    expect(response.status).toBe(401)
    // Exactly one credential is registered and it hasn't crossed the disk-persistence threshold
    // (client.ts:230, `REJECTED_PERSIST_THRESHOLD = 2`), so `authorizedFetch`'s retry-on-rotation
    // branch (client.ts:470-474) finds `credentialsForLoad()` still returning the same `apiKey` and
    // returns the original 401 without a second request.
    expect(gateway.chatCalls).toHaveLength(1)
  })
})
