// Suite E (Deliverable 3 of docs/internal/2026-09-04-altimate-base-e2e-harness-plan.md): the
// confirmed gap — `FreeTier.describeRateLimit` / `FreeTier.describeRequestTooLarge` had zero
// direct unit tests anywhere. `test/provider/error.test.ts` only exercised two paths (generic
// throttling with an empty detail, and one 413 shape) through `ProviderError.parseAPICallError`;
// none of the six `ChatMode` failure knobs below — the per-minute token limit, both budget
// surfaces plus the fallback, and the byte-limit KB math — were covered.
//
// Every scenario is driven two ways where the plan calls for it:
//   1. End to end through the fake gateway (`FakeGateway.chatNext` -> `authorizedFetch` -> the
//      real response body/headers -> `describeRateLimit`/`describeRequestTooLarge`), proving the
//      client's own parsing agrees with what the gateway actually sends on the wire.
//   2. Direct calls into the pure functions for branches `ChatMode` cannot express (unparseable
//      bodies, a missing/unrecognized `type`, a 413 that isn't `request_too_large`, a
//      `request_too_large` body whose message doesn't match the byte-count regex, the top-level
//      `type` fallback instead of `error.type`) — these are still real branches in `client.ts`,
//      just not shaped like anything a real gateway response would look like, so scripting them
//      through `FakeGateway` would mean inventing a knob nobody asked for.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { consented, isolateAltimateBaseHome, resetGatewayEnv } from "./_fixtures/altimate-base-harness"
import { FakeGateway, GATEWAY_URL } from "./_fixtures/fake-gateway"

isolateAltimateBaseHome("altimate-base-ratelimit")

const { FreeTier } = await import("../../src/altimate/free/client")
const { FreeTierStore } = await import("../../src/altimate/free/store")

// This file plays the TUI-host role exactly like `altimate-base.test.ts` and the harness smoke
// test do. Minting a consent token goes through the shared `consented()` helper in
// `_fixtures/altimate-base-harness.ts`, which claims the process's ONE arming capability lazily
// and caches it — see that file for why (running multiple suite files in one `bun test` worker
// process means only the first call to `issueArmer()` may succeed).

const gateway = new FakeGateway()

beforeEach(async () => {
  gateway.install()
  gateway.reset()
  await FreeTier.logout()
  await FreeTierStore.remove()
  resetGatewayEnv(GATEWAY_URL)
  gateway.registerNext({ kind: "ok" })
  await FreeTier.registerAfterConsent(consented())
})

afterEach(() => {
  gateway.restore()
})

/** Sends one authorized chat request against whatever `ChatMode` is currently queued. */
async function chat(): Promise<Response> {
  return FreeTier.authorizedFetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: FreeTier.MODEL_ID, messages: [{ role: "user", content: "hi" }] }),
  })
}

describe("describeRateLimit — via the fake gateway (every ChatMode failure knob)", () => {
  test("throttle-tokens: per-minute token limit is non-retryable with the exact client.ts message", async () => {
    gateway.chatNext({ kind: "throttle-tokens" })
    const response = await chat()
    expect(response.status).toBe(429)

    const described = FreeTier.describeRateLimit({
      body: await response.text(),
      retryAfter: response.headers.get("retry-after") ?? undefined,
    })
    expect(described).toEqual({
      message:
        "This request is too large for Altimate Base's per-minute token limit. Start a new session or shorten the context, then try again.",
      retryable: false,
    })
  })

  test("throttle-burst: generic burst limit with a retry-after header is retryable, rounds up with Math.ceil", async () => {
    gateway.chatNext({ kind: "throttle-burst", retryAfterSeconds: 45.7 })
    const response = await chat()
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("45.7")

    const described = FreeTier.describeRateLimit({
      body: await response.text(),
      retryAfter: response.headers.get("retry-after") ?? undefined,
    })
    expect(described).toEqual({
      message: "Too many requests to Altimate Base right now. Try again in 46s.",
      retryable: true,
    })
  })

  test("throttle-burst: retry-after of 0 seconds is treated as absent (not > 0), falls back to 'shortly'", async () => {
    gateway.chatNext({ kind: "throttle-burst", retryAfterSeconds: 0 })
    const response = await chat()
    expect(response.headers.get("retry-after")).toBe("0")

    const described = FreeTier.describeRateLimit({
      body: await response.text(),
      retryAfter: response.headers.get("retry-after") ?? undefined,
    })
    expect(described).toEqual({
      message: "Too many requests to Altimate Base right now. Try again shortly.",
      retryable: true,
    })
  })

  test("throttle-burst: no retry-after header at all falls back to 'shortly' (retryable)", async () => {
    gateway.chatNext({ kind: "throttle-burst" })
    const response = await chat()
    expect(response.headers.get("retry-after")).toBeNull()

    const described = FreeTier.describeRateLimit({
      body: await response.text(),
      retryAfter: response.headers.get("retry-after") ?? undefined,
    })
    expect(described).toEqual({
      message: "Too many requests to Altimate Base right now. Try again shortly.",
      retryable: true,
    })
  })

  test("budget-wallet: per-principal wallet exhaustion maps to the allowance message, non-retryable", async () => {
    gateway.chatNext({ kind: "budget-wallet" })
    const response = await chat()
    expect(response.status).toBe(429)

    const described = FreeTier.describeRateLimit({ body: await response.text() })
    // Confirmed against altimate-gateway (issuer/config.py `grant_budget_duration` defaults to
    // "" and `validate()` refuses to boot if it's ever set; issuer/accounting_db.py grants a
    // one-time registration credit with "without later top-ups" in the docstring; issuer/
    // budget_sync.py mirrors the lifetime allowance into LiteLLM's max_budget with no
    // budget_duration). The per-user wallet is a one-time lifetime grant that never renews —
    // unlike the separate global $50/day ceiling (litellm/config.yaml `budget_duration: 1d`),
    // which genuinely does reset daily and is covered by the budget-global case below. The
    // message nudges toward the paid Altimate LLM Gateway (app.myaltimate.com) since switching
    // models is the only other option when a lifetime grant is gone for good.
    expect(described).toEqual({
      message:
        "You've used your free Altimate Base allowance — it's a one-time grant and won't renew. Sign up at app.myaltimate.com to keep going, or switch models.",
      retryable: false,
    })
  })

  test("budget-global: shared $50/day ceiling maps to the shared-daily-limit message, non-retryable", async () => {
    gateway.chatNext({ kind: "budget-global" })
    const response = await chat()
    expect(response.status).toBe(429)

    const described = FreeTier.describeRateLimit({ body: await response.text() })
    expect(described).toEqual({
      message: "Altimate Base has reached its shared daily limit. It resets tomorrow—switch models to keep going.",
      retryable: false,
    })
  })

  test("budget-unknown: neither known substring falls back to the generic daily-limit message, non-retryable", async () => {
    gateway.chatNext({ kind: "budget-unknown" })
    const response = await chat()
    expect(response.status).toBe(429)

    const described = FreeTier.describeRateLimit({ body: await response.text() })
    expect(described).toEqual({
      message: "The daily Altimate Base limit has been reached. It resets tomorrow—switch models to keep going.",
      retryable: false,
    })
  })
})

describe("describeRateLimit — pure-function edge cases FakeGateway's ChatMode cannot express", () => {
  test("unparseable JSON body returns undefined (falls through to the generic API-error path)", () => {
    expect(FreeTier.describeRateLimit({ body: "{not json" })).toBeUndefined()
  })

  test("absent body returns undefined", () => {
    expect(FreeTier.describeRateLimit({})).toBeUndefined()
  })

  test("well-formed JSON with an unrecognized error.type returns undefined", () => {
    const body = JSON.stringify({ error: { type: "some_other_error", message: "whatever" } })
    expect(FreeTier.describeRateLimit({ body })).toBeUndefined()
  })

  test("top-level `type` is used when `error.type` is not a string (kind-resolution fallback)", () => {
    // No nested `error` object at all — `kind` must fall back to the top-level `type` field
    // (client.ts:497's `typeof parsed?.error?.type === "string" ? parsed.error.type : parsed?.type`).
    // Detail extraction then finds no `error.message`, so `detail` is empty and this lands on the
    // generic burst-limit branch, not the per-minute-token branch.
    const body = JSON.stringify({ type: "throttling_error", message: "ignored, not error.message" })
    expect(FreeTier.describeRateLimit({ body })).toEqual({
      message: "Too many requests to Altimate Base right now. Try again shortly.",
      retryable: true,
    })
  })
})

describe("describeRequestTooLarge — via the fake gateway (413 request_too_large)", () => {
  test("default byte sizes: KB math rounds correctly in the '(NKB against a MKB limit)' rendering", async () => {
    // FakeGateway's too-large default: requestBytes=179_608, limitBytes=128_000.
    // 179608/1024 = 175.398... -> round 175. 128000/1024 = 125 exactly -> round 125.
    gateway.chatNext({ kind: "too-large" })
    const response = await chat()
    expect(response.status).toBe(413)

    const described = FreeTier.describeRequestTooLarge(await response.text())
    expect(described).toBe(
      "This request is too large for Altimate Base (175KB against a 125KB limit). Start a new session, or switch to another model for this task.",
    )
  })

  test("custom byte sizes: KB math rounds correctly for a different pair of values", async () => {
    // 1_000_000/1024 = 976.5625 -> round 977. 500_000/1024 = 488.28125 -> round 488.
    gateway.chatNext({ kind: "too-large", requestBytes: 1_000_000, limitBytes: 500_000 })
    const response = await chat()
    expect(response.status).toBe(413)

    const described = FreeTier.describeRequestTooLarge(await response.text())
    expect(described).toBe(
      "This request is too large for Altimate Base (977KB against a 488KB limit). Start a new session, or switch to another model for this task.",
    )
  })

  test("the request_too_large code lives only in provider_specific_fields.error (FakeGateway's exact shape) — still matched", async () => {
    // FakeGateway sets the outer `error.code` to the literal string "413" and only the nested
    // `provider_specific_fields.error.code` to "request_too_large" — this is the real shape the
    // gateway emits (matches client.ts:540's `inner?.code` check), so this scenario is really
    // just re-confirming the default-sizes test above takes the inner-code path, not the
    // outer-code path. Kept as its own test because it pins the exact fixture shape by name.
    gateway.chatNext({ kind: "too-large", requestBytes: 50_000, limitBytes: 40_000 })
    const response = await chat()
    const body = JSON.parse(await response.text())
    expect(body.error.code).toBe("413")
    expect(body.error.provider_specific_fields.error.code).toBe("request_too_large")

    // 50000/1024 = 48.828125 -> round 49. 40000/1024 = 39.0625 -> round 39.
    const described = FreeTier.describeRequestTooLarge(JSON.stringify(body))
    expect(described).toBe(
      "This request is too large for Altimate Base (49KB against a 39KB limit). Start a new session, or switch to another model for this task.",
    )
  })
})

describe("describeRequestTooLarge — pure-function edge cases FakeGateway's ChatMode cannot express", () => {
  test("absent body returns undefined", () => {
    expect(FreeTier.describeRequestTooLarge(undefined)).toBeUndefined()
  })

  test("unparseable JSON body returns undefined", () => {
    expect(FreeTier.describeRequestTooLarge("{not json")).toBeUndefined()
  })

  test("a 413 without the request_too_large code (an unrelated provider 413) returns undefined", () => {
    // Falls through to error.ts's generic context_overflow handling instead of the
    // Altimate-Base-specific rewrite — request_too_large and context overflow are distinct
    // gateway error codes.
    const body = JSON.stringify({ error: { code: "some_other_413", message: "payload too large" } })
    expect(FreeTier.describeRequestTooLarge(body)).toBeUndefined()
  })

  test("the outer error.code (not the nested provider_specific_fields shape) also matches", () => {
    const body = JSON.stringify({
      error: { code: "request_too_large", message: "Request is 300000 bytes; the free tier limit is 100000 bytes." },
    })
    // 300000/1024 = 292.96875 -> round 293. 100000/1024 = 97.65625 -> round 98.
    expect(FreeTier.describeRequestTooLarge(body)).toBe(
      "This request is too large for Altimate Base (293KB against a 98KB limit). Start a new session, or switch to another model for this task.",
    )
  })

  test("request_too_large with a message that doesn't match the byte-count pattern omits the KB parenthetical", () => {
    const body = JSON.stringify({
      error: { code: "request_too_large", message: "Payload rejected: too large for this tier." },
    })
    expect(FreeTier.describeRequestTooLarge(body)).toBe(
      "This request is too large for Altimate Base. Start a new session, or switch to another model for this task.",
    )
  })

  test("request_too_large with no message at all on either the outer or inner error omits the KB parenthetical", () => {
    const body = JSON.stringify({ error: { code: "request_too_large" } })
    expect(FreeTier.describeRequestTooLarge(body)).toBe(
      "This request is too large for Altimate Base. Start a new session, or switch to another model for this task.",
    )
  })

  test("outer error.message missing falls back to the nested provider_specific_fields.error.message", () => {
    // Exercises client.ts:542-547's ternary's else branch: `parsed.error.message` is not a
    // string (absent), so `detail` comes from `inner?.message` instead.
    const body = JSON.stringify({
      error: {
        code: "request_too_large",
        provider_specific_fields: {
          error: {
            code: "request_too_large",
            message: "Request is 250000 bytes; the free tier limit is 128000 bytes.",
          },
        },
      },
    })
    // 250000/1024 = 244.140625 -> round 244. 128000/1024 = 125 exactly.
    expect(FreeTier.describeRequestTooLarge(body)).toBe(
      "This request is too large for Altimate Base (244KB against a 125KB limit). Start a new session, or switch to another model for this task.",
    )
  })
})
