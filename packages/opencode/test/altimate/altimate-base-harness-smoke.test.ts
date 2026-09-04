// Smoke test proving the shared Altimate Base e2e harness (`_fixtures/altimate-base-harness.ts` +
// `_fixtures/fake-gateway.ts`) works in both directions: a happy-path register -> inference
// round trip, and one scripted failure knob (a per-minute token rate-limit). This file is NOT one
// of the six planned implementer suites — see
// docs/internal/2026-09-04-altimate-base-e2e-harness-plan.md, Deliverable 3, for that partition.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { isolateAltimateBaseHome, resetGatewayEnv } from "./_fixtures/altimate-base-harness"
import { FakeGateway, GATEWAY_URL } from "./_fixtures/fake-gateway"

isolateAltimateBaseHome("altimate-base-harness-smoke")

const { FreeTier } = await import("../../src/altimate/free/client")
const { FreeTierStore } = await import("../../src/altimate/free/store")
const { FreeTierCapability } = await import("../../src/altimate/free/capability")

// This file plays the role of the TUI host, exactly like `altimate-base.test.ts` does: it claims
// the process's ONE arming capability once, at module scope, and uses it to mint a fresh one-shot
// consent token before every registration below.
const armProductionConsent = FreeTierCapability.issueArmer()
function consented(): string {
  const token = randomBytes(32).toString("hex")
  armProductionConsent(token)
  return token
}

const gateway = new FakeGateway()

beforeEach(async () => {
  gateway.install()
  gateway.reset()
  await FreeTier.logout()
  await FreeTierStore.remove()
  resetGatewayEnv(GATEWAY_URL)
})

afterEach(() => {
  gateway.restore()
})

describe("Altimate Base harness smoke test", () => {
  test("happy path: register then authorizedFetch round-trips a chat completion", async () => {
    gateway.registerNext({ kind: "ok" })
    await FreeTier.registerAfterConsent(consented())
    expect(gateway.registerCalls).toHaveLength(1)
    expect(gateway.registerCalls[0]?.installSecretHash).toMatch(/^[0-9a-f]{64}$/)

    gateway.chatNext({ kind: "ok", content: "hello from the fake gateway" })
    const response = await FreeTier.authorizedFetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: FreeTier.MODEL_ID, messages: [{ role: "user", content: "hi" }] }),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { choices: [{ message: { content: string } }] }
    expect(body.choices[0]?.message.content).toBe("hello from the fake gateway")

    expect(gateway.chatCalls).toHaveLength(1)
    expect(gateway.chatCalls[0]?.authorization).toBe("Bearer sk-altimate-base-fake")
  })

  test("failure knob: per-minute token rate-limit maps to a non-retryable message", async () => {
    gateway.registerNext({ kind: "ok" })
    await FreeTier.registerAfterConsent(consented())

    gateway.chatNext({ kind: "throttle-tokens" })
    const response = await FreeTier.authorizedFetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: FreeTier.MODEL_ID, messages: [{ role: "user", content: "hi" }] }),
    })

    expect(response.status).toBe(429)
    const described = FreeTier.describeRateLimit({ body: await response.text() })
    expect(described).toEqual({
      message:
        "This request is too large for Altimate Base's per-minute token limit. Start a new session or shorten the context, then try again.",
      retryable: false,
    })
  })
})
