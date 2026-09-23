// Coverage for `FreeTier.autoRegister()` / `autoRegisterWithin()` — the no-consent registration
// path every entrypoint now calls at startup (2026-09-17: OpenCode Zen started rejecting keyless
// traffic outright, so installs without a model of their own need Altimate Base registered before
// the first provider list/default-model resolution, with no disclosure dialog in the way).
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { isolateAltimateBaseHome, resetGatewayEnv } from "./_fixtures/altimate-base-harness"
import { FakeGateway, GATEWAY_URL } from "./_fixtures/fake-gateway"

/**
 * Poll until `predicate` holds, instead of a fixed sleep — the background registration this
 * covers writes credentials to disk asynchronously, so a fixed delay is flaky under CI load (see
 * the "returns at the budget" test below).
 */
async function waitFor<T>(read: () => Promise<T>, predicate: (v: T) => boolean, timeoutMs = 5000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await read()
    if (predicate(v)) return v
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition not met within timeout")
    await new Promise((r) => setTimeout(r, 10))
  }
}

// Harness contract: isolate the Altimate Base home BEFORE importing src/altimate/free/*.
isolateAltimateBaseHome("altimate-base-auto-register")

const { FreeTier } = await import("../../src/altimate/free/client")
const { FreeTierStore } = await import("../../src/altimate/free/store")

const gateway = new FakeGateway()
const GATEWAY_ENV = ["ALTIMATE_BASE_GATEWAY_URL", "ALTIMATE_FREE_GATEWAY_URL"] as const
const AUTO_REGISTER_ENV = "ALTIMATE_BASE_AUTO_REGISTER"
let savedGatewayEnv: Record<string, string | undefined> = {}
let savedAutoRegisterEnv: string | undefined

beforeEach(async () => {
  savedGatewayEnv = Object.fromEntries(GATEWAY_ENV.map((key) => [key, process.env[key]]))
  savedAutoRegisterEnv = process.env[AUTO_REGISTER_ENV]
  delete process.env[AUTO_REGISTER_ENV]
  gateway.install()
  gateway.reset()
  await FreeTier.logout()
  await FreeTierStore.remove()
  resetGatewayEnv(GATEWAY_URL)
})

afterEach(() => {
  gateway.restore()
  for (const key of GATEWAY_ENV) {
    if (savedGatewayEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedGatewayEnv[key]
  }
  if (savedAutoRegisterEnv === undefined) delete process.env[AUTO_REGISTER_ENV]
  else process.env[AUTO_REGISTER_ENV] = savedAutoRegisterEnv
})

describe("FreeTier.autoRegister", () => {
  test("registers without a consent token and persists credentials", async () => {
    gateway.registerNext({ kind: "ok" })
    const result = await FreeTier.autoRegister()
    expect(result).toEqual({ status: "registered" })
    expect(gateway.registerCalls).toHaveLength(1)
    const stored = await FreeTierStore.read()
    expect(stored?.apiKey).toBeDefined()
    expect(await FreeTier.isRegistered()).toBe(true)
  })

  test("is deduped across concurrent calls: only one network request for N concurrent autoRegister()s", async () => {
    gateway.registerNext({ kind: "ok" })
    const results = await Promise.all([
      FreeTier.autoRegister(),
      FreeTier.autoRegister(),
      FreeTier.autoRegister(),
    ])
    for (const result of results) expect(result).toEqual({ status: "registered" })
    expect(gateway.registerCalls).toHaveLength(1)
  })

  test.each(["0", "false"])("is skipped when ALTIMATE_BASE_AUTO_REGISTER=%s, with no network call", async (value) => {
    process.env[AUTO_REGISTER_ENV] = value
    const result = await FreeTier.autoRegister()
    expect(result).toEqual({ status: "skipped", reason: "env" })
    expect(gateway.registerCalls).toHaveLength(0)
  })

  test("is skipped when the user explicitly logged out, with no network call", async () => {
    // logout() persists a logoutNonce with no apiKey — the exact state autoRegister must never
    // register through, whether it's already there (this test) or lands mid-flight (see the next
    // test): both are the same fresh, inside-the-lock read, so there's no separate stale check to
    // race in the first place.
    await FreeTier.logout()
    const result = await FreeTier.autoRegister()
    expect(result).toEqual({ status: "skipped", reason: "logged-out" })
    expect(gateway.registerCalls).toHaveLength(0)
  })

  test("a logout that lands before the registration lock is acquired is not missed", async () => {
    // Simulates the race the spec calls out: nothing has registered yet (no pre-existing
    // credential), and a logout call — which takes the SAME lock — completes before autoRegister's
    // own lock body runs. Because that body reads the store fresh from inside the lock (no
    // pre-lock "expected" value carried in), it sees the logout unconditionally.
    await FreeTierStore.remove()
    await FreeTier.logout()
    const result = await FreeTier.autoRegister()
    expect(result).toEqual({ status: "skipped", reason: "logged-out" })
    expect(gateway.registerCalls).toHaveLength(0)
  })

  test("is skipped when no gateway URL is configured, with no network call", async () => {
    delete process.env.ALTIMATE_BASE_GATEWAY_URL
    delete process.env.ALTIMATE_FREE_GATEWAY_URL
    const result = await FreeTier.autoRegister()
    expect(result).toEqual({ status: "skipped", reason: "no-gateway" })
    expect(gateway.registerCalls).toHaveLength(0)
  })

  test("is skipped when valid credentials already exist for this gateway, with no network call", async () => {
    gateway.registerNext({ kind: "ok" })
    const first = await FreeTier.autoRegister()
    expect(first).toEqual({ status: "registered" })
    expect(gateway.registerCalls).toHaveLength(1)

    const second = await FreeTier.autoRegister()
    expect(second).toEqual({ status: "skipped", reason: "already-registered" })
    // Still exactly one call: the second autoRegister() never touched the network.
    expect(gateway.registerCalls).toHaveLength(1)
  })

  test("never throws on a network failure — resolves to a failed result instead", async () => {
    gateway.registerNext({ kind: "network" })
    const result = await FreeTier.autoRegister()
    expect(result).toEqual({ status: "failed", kind: "network" })
    expect(await FreeTier.isRegistered()).toBe(false)
  })

  test("never throws on an HTTP rejection — resolves to a failed result instead", async () => {
    gateway.registerNext({ kind: "http", status: 503 })
    const result = await FreeTier.autoRegister()
    expect(result).toEqual({ status: "failed", kind: "http" })
    expect(await FreeTier.isRegistered()).toBe(false)
  })

  test("never throws on a malformed gateway response — resolves to a failed result instead", async () => {
    gateway.registerNext({ kind: "malformed-json" })
    const result = await FreeTier.autoRegister()
    expect(result).toEqual({ status: "failed", kind: "response" })
    expect(await FreeTier.isRegistered()).toBe(false)
  })
})

describe("FreeTier.autoRegisterWithin", () => {
  test("returns once registered, well within a generous budget", async () => {
    gateway.registerNext({ kind: "ok" })
    const result = await FreeTier.autoRegisterWithin(3000)
    expect(result).toEqual({ status: "registered" })
  })

  test("returns at the budget while a slow registration keeps going in the background", async () => {
    // Bypass FakeGateway here: it has no "hang" mode for /register. This fetch resolves the
    // request successfully, but only after a delay well past the tiny budget below.
    gateway.restore()
    let resolveRequest!: () => void
    const gate = new Promise<void>((resolve) => {
      resolveRequest = resolve
    })
    const slow = spyOn(globalThis, "fetch").mockImplementation((async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => {
      await gate
      return new Response(
        JSON.stringify({
          api_key: "sk-altimate-base-slow",
          base_url: GATEWAY_URL,
          model: FreeTier.MODEL_ID,
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as typeof fetch)

    try {
      const startedAt = Date.now()
      const result = await FreeTier.autoRegisterWithin(30)
      expect(result).toEqual({ status: "pending" })
      // Returned at the budget, not after waiting for the request to resolve.
      expect(Date.now() - startedAt).toBeLessThan(1000)
      expect(await FreeTier.isRegistered()).toBe(false)

      // Let the still-running attempt finish; its credentials land on disk even though this
      // launch already moved on. Poll for it rather than a fixed sleep — how long the write
      // takes to land is not deterministic under load.
      resolveRequest()
      const registered = await waitFor(() => FreeTier.isRegistered(), (v) => v === true)
      expect(registered).toBe(true)
    } finally {
      slow.mockRestore()
    }
  })
})
