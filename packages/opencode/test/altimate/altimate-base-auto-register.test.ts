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
  // altimate_change — the auto-register backoff (see "FreeTier.autoRegister: backoff after a
  // failure" below) is persisted to a file next to the credential store with no other reset hook;
  // without this, a backoff set by one test would silently skip auto-register in every later test
  // in this file.
  await FreeTier.resetAutoRegisterBackoffForTests()
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

// altimate_change start — Codex review finding: autoRegister() and register() used to share ONE
// in-process dedupe map keyed only by gateway URL. An explicit register() call arriving while an
// auto-register attempt was in flight for the same gateway could just return THAT attempt's
// promise — including autoRegister()'s own "the user logged out" skip, which register() is
// documented to never treat as a reason to stop (an explicit register is the user asking to
// reconnect). Separate maps mean the two can never observe each other's in-flight promise; the
// shared LOCK_KEY flock still means only one of them actually talks to the gateway.
//
// Also, Codex review finding: every entrypoint calls autoRegisterWithin() at startup, so a
// persistent failure (network down, gateway 429/5xx) meant every launch repeated the same
// 15s-timeout attempt for nothing. A failure now sets a backoff window persisted next to the
// credential store (1h, or the gateway's own Retry-After for a 429 if longer); a launch within
// that window skips without touching the network. Explicit register() ignores the backoff
// entirely — it's the user asking to
// reconnect right now, not startup's own retry.
describe("FreeTier.autoRegister: backoff after a failure", () => {
  test("a network failure sets a backoff; the next auto-register call within it makes no network call", async () => {
    gateway.restore()
    const failing = spyOn(globalThis, "fetch").mockImplementation((async (_input: RequestInfo | URL, _init?: RequestInit) => {
      throw new TypeError("network unreachable")
    }) as unknown as typeof fetch)
    try {
      const first = await FreeTier.autoRegister()
      expect(first).toEqual({ status: "failed", kind: "network" })
    } finally {
      failing.mockRestore()
    }

    // Reinstall the (working) FakeGateway — if the backoff were NOT honored, this second call
    // would succeed and register, since nothing else is wrong now.
    gateway.install()
    gateway.registerNext({ kind: "ok" })
    const second = await FreeTier.autoRegister()
    expect(second).toEqual({ status: "skipped", reason: "backoff" })
    expect(gateway.registerCalls).toHaveLength(0)
    expect(await FreeTier.isRegistered()).toBe(false)
  })

  test("a 429 with a Retry-After longer than the default backoff honors the longer value", async () => {
    gateway.restore()
    const rateLimited = spyOn(globalThis, "fetch").mockImplementation((async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ error: "rate limited" }), {
        status: 429,
        headers: { "Content-Type": "application/json", "retry-after": String(2 * 60 * 60) }, // 2h
      })
    }) as typeof fetch)
    const before = Date.now()
    try {
      const first = await FreeTier.autoRegister()
      expect(first).toEqual({ status: "failed", kind: "http" })
    } finally {
      rateLimited.mockRestore()
    }

    // The stored backoff deadline reflects the gateway's 2h ask, not the 1h default — a launch
    // 1.5h later (past the default, short of the 2h ask) must still be skipped.
    const backoffUntil = await FreeTier.getAutoRegisterBackoffUntilForTests(GATEWAY_URL)
    expect(backoffUntil).toBeDefined()
    expect(backoffUntil!).toBeGreaterThanOrEqual(before + 1.9 * 60 * 60 * 1000)
  })

  test("a 429 with an enormous Retry-After is capped at 24 hours", async () => {
    gateway.restore()
    const rateLimited = spyOn(globalThis, "fetch").mockImplementation((async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ error: "rate limited" }), {
        status: 429,
        headers: { "Content-Type": "application/json", "retry-after": String(30 * 24 * 60 * 60) }, // 30 days
      })
    }) as typeof fetch)
    const before = Date.now()
    try {
      await FreeTier.autoRegister()
    } finally {
      rateLimited.mockRestore()
    }
    const backoffUntil = await FreeTier.getAutoRegisterBackoffUntilForTests(GATEWAY_URL)
    expect(backoffUntil).toBeDefined()
    expect(backoffUntil!).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000)
    expect(backoffUntil!).toBeGreaterThanOrEqual(before + 23.9 * 60 * 60 * 1000)
  })

  test("explicit register() ignores the auto-register backoff", async () => {
    gateway.restore()
    const failing = spyOn(globalThis, "fetch").mockImplementation((async (_input: RequestInfo | URL, _init?: RequestInit) => {
      throw new TypeError("network unreachable")
    }) as unknown as typeof fetch)
    try {
      const first = await FreeTier.autoRegister()
      expect(first).toEqual({ status: "failed", kind: "network" })
    } finally {
      failing.mockRestore()
    }

    gateway.install()
    gateway.registerNext({ kind: "ok" })
    const result = await FreeTier.register({ origin: "picker" })
    expect(result.apiKey).toBeDefined()
    expect(gateway.registerCalls).toHaveLength(1)
  })
})

describe("FreeTier.autoRegister / FreeTier.register: independent in-flight dedupe", () => {
  test("an explicit register() racing a logged-out auto-register still registers, never surfaces the auto skip", async () => {
    await FreeTier.logout()
    gateway.registerNext({ kind: "ok" })

    const [autoResult, explicit] = await Promise.all([FreeTier.autoRegister(), FreeTier.register({ origin: "picker" })])

    // Whichever attempt's locked body wins the race, the explicit call must always come back with
    // real credentials — never rejecting with autoRegister's own AutoRegisterSkippedLoggedOutError
    // (the exact failure mode this test guards against; before the fix it could join that
    // rejecting promise instead of registering).
    expect(explicit.apiKey).toBeDefined()
    expect(await FreeTier.isRegistered()).toBe(true)
    // autoRegister's own outcome depends on which locked body ran first — both are legitimate:
    // "logged-out" if it read the store before the explicit call registered, "registered" if the
    // explicit call already reconnected by the time it read. Never anything else.
    expect(["skipped", "registered"]).toContain(autoResult.status)
    if (autoResult.status === "skipped") expect(autoResult.reason).toBe("logged-out")
  })
})
// altimate_change end
