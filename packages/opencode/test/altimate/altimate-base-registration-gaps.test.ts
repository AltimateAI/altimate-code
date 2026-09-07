// Registration failure-mapping gaps for Altimate Base, using the shared FakeGateway harness.
//
// `altimate-base.test.ts` already covers happy-path registration, consent enforcement, and the
// credential lifecycle (rotation, rejection, expiry) with a hand-rolled fetch mock. This file
// targets a narrower slice that suite does not exercise: how `registerOnce` in
// `src/altimate/free/client.ts` maps HTTP 4xx/5xx register failures, network failures, and
// malformed JSON register bodies onto `RegistrationError`, plus the exact request payload sent
// (hashed install secret, cli_version) and one idempotency property (a live credential is reused
// without a second gateway call).
//
// See docs/internal/2026-09-04-altimate-base-e2e-harness-plan.md for the harness design.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { consented, isolateAltimateBaseHome, resetGatewayEnv } from "./_fixtures/altimate-base-harness"
import { FakeGateway, GATEWAY_URL } from "./_fixtures/fake-gateway"

isolateAltimateBaseHome("altimate-base-registration")

const { FreeTier } = await import("../../src/altimate/free/client")
const { FreeTierStore } = await import("../../src/altimate/free/store")

// Minting a consent token goes through the shared `consented()` helper in
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
})

afterEach(() => {
  gateway.restore()
})

describe("registration failure mapping: HTTP status codes", () => {
  test("429 maps to a rate-limit-specific message and carries the status", async () => {
    gateway.registerNext({ kind: "http", status: 429 })
    const error = await FreeTier.registerAfterConsent(consented()).catch((cause) => cause)

    expect(error).toBeInstanceOf(FreeTier.RegistrationError)
    expect(error.kind).toBe("http")
    expect(error.status).toBe(429)
    expect(error.message).toBe("Too many Altimate Base registrations from this network right now. Try again later.")
  })

  test("503 maps to an unavailability-specific message and carries the status", async () => {
    gateway.registerNext({ kind: "http", status: 503 })
    const error = await FreeTier.registerAfterConsent(consented()).catch((cause) => cause)

    expect(error).toBeInstanceOf(FreeTier.RegistrationError)
    expect(error.kind).toBe("http")
    expect(error.status).toBe(503)
    expect(error.message).toBe("Altimate Base is temporarily unavailable. Try again later.")
  })

  test("an unrecognized 5xx falls back to a generic status-carrying message", async () => {
    gateway.registerNext({ kind: "http", status: 500 })
    const error = await FreeTier.registerAfterConsent(consented()).catch((cause) => cause)

    expect(error).toBeInstanceOf(FreeTier.RegistrationError)
    expect(error.kind).toBe("http")
    expect(error.status).toBe(500)
    expect(error.message).toBe("Altimate Base registration failed (HTTP 500).")
  })

  test("a 4xx that is not specially handled (400) still maps generically, not as a network/response failure", async () => {
    gateway.registerNext({ kind: "http", status: 400 })
    const error = await FreeTier.registerAfterConsent(consented()).catch((cause) => cause)

    expect(error).toBeInstanceOf(FreeTier.RegistrationError)
    expect(error.kind).toBe("http")
    expect(error.status).toBe(400)
    expect(error.message).toBe("Altimate Base registration failed (HTTP 400).")
  })

  test("an HTTP register failure never persists credentials or flips the registered state", async () => {
    gateway.registerNext({ kind: "http", status: 500 })
    await expect(FreeTier.registerAfterConsent(consented())).rejects.toBeInstanceOf(FreeTier.RegistrationError)

    expect(await FreeTier.isRegistered()).toBe(false)
    expect(await FreeTier.credentials()).toBeUndefined()
    // The install secret is minted and persisted BEFORE the network call (so a lost response can't
    // mint a second budget principal on retry), so the store is expected to hold it even though
    // registration failed — but it must hold nothing else.
    const stored = await FreeTierStore.read()
    expect(stored?.installSecret).toMatch(/^[0-9a-f]{64}$/)
    expect(stored?.apiKey).toBeUndefined()
    expect(stored?.baseURL).toBeUndefined()
  })
})

describe("registration failure mapping: network failure", () => {
  test('a thrown fetch (connection failure) maps to kind "network" with a connectivity message', async () => {
    gateway.registerNext({ kind: "network" })
    const error = await FreeTier.registerAfterConsent(consented()).catch((cause) => cause)

    expect(error).toBeInstanceOf(FreeTier.RegistrationError)
    expect(error.kind).toBe("network")
    expect(error.status).toBeUndefined()
    expect(error.message).toBe("Could not reach the Altimate Base gateway. Check your connection.")
    expect(await FreeTier.isRegistered()).toBe(false)
  })
})

describe("registration failure mapping: malformed register response", () => {
  test('a 200 with invalid JSON body maps to kind "response" instead of crashing', async () => {
    gateway.registerNext({ kind: "malformed-json" })
    const error = await FreeTier.registerAfterConsent(consented()).catch((cause) => cause)

    expect(error).toBeInstanceOf(FreeTier.RegistrationError)
    expect(error.kind).toBe("response")
    expect(error.status).toBeUndefined()
    expect(error.message).toBe("The Altimate Base gateway returned an unexpected response.")
    expect(await FreeTier.isRegistered()).toBe(false)
    expect(await FreeTier.credentials()).toBeUndefined()
  })
})

describe("registration request payload", () => {
  test("sends only the SHA-256 hash of the minted install secret, never the secret itself", async () => {
    gateway.registerNext({ kind: "ok" })
    const result = await FreeTier.registerAfterConsent(consented())

    expect(gateway.registerCalls).toHaveLength(1)
    const call = gateway.registerCalls[0]!
    expect(call.installSecretHash).toMatch(/^[0-9a-f]{64}$/)
    expect(call.installSecretHash).toBe(createHash("sha256").update(result.installSecret).digest("hex"))
    expect(call.installSecretHash).not.toBe(result.installSecret)
  })

  test("sends a sanitized cli_version derived from the running Installation.VERSION", async () => {
    const { Installation } = await import("../../src/installation")
    gateway.registerNext({ kind: "ok" })
    await FreeTier.registerAfterConsent(consented())

    expect(gateway.registerCalls).toHaveLength(1)
    const sentVersion = gateway.registerCalls[0]!.cliVersion
    expect(sentVersion).toBe(FreeTier.sanitizeCliVersion(Installation.VERSION))
    // sanitizeCliVersion's contract: only these characters survive, capped at 32 chars, never empty.
    expect(sentVersion).toMatch(/^[A-Za-z0-9._+-]{1,32}$/)
  })
})

describe("registration retry / idempotency", () => {
  test("a failed HTTP registration reuses the same minted install secret on the next consented attempt", async () => {
    gateway.registerNext({ kind: "http", status: 500 })
    await expect(FreeTier.registerAfterConsent(consented())).rejects.toBeInstanceOf(FreeTier.RegistrationError)
    const firstHash = gateway.registerCalls[0]?.installSecretHash
    expect(firstHash).toMatch(/^[0-9a-f]{64}$/)

    gateway.registerNext({ kind: "ok" })
    const result = await FreeTier.registerAfterConsent(consented())

    expect(gateway.registerCalls).toHaveLength(2)
    expect(gateway.registerCalls[1]?.installSecretHash).toBe(firstHash)
    expect(createHash("sha256").update(result.installSecret).digest("hex")).toBe(firstHash)
  })

  test("re-registering with a live credential is a no-op: the gateway is not called again", async () => {
    gateway.registerNext({ kind: "ok" })
    const first = await FreeTier.registerAfterConsent(consented())
    expect(gateway.registerCalls).toHaveLength(1)

    // A second, independently-armed consent token still must not trigger another /register call,
    // because registerAfterConsent finds the existing credential is live, unexpired, and not
    // rejected before ever reaching registerOnce.
    const second = await FreeTier.registerAfterConsent(consented())
    expect(gateway.registerCalls).toHaveLength(1)
    expect(second).toEqual(first)
  })
})
