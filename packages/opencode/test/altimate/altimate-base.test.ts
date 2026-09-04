import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { consented } from "./_fixtures/altimate-base-harness"

const isolatedEnvironment = [
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "OPENCODE_TEST_HOME",
] as const
const originalEnvironment = Object.fromEntries(isolatedEnvironment.map((key) => [key, process.env[key]]))
const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "altimate-base-"))
process.env.XDG_DATA_HOME = path.join(temporaryHome, "data")
process.env.XDG_CONFIG_HOME = path.join(temporaryHome, "config")
process.env.XDG_CACHE_HOME = path.join(temporaryHome, "cache")
process.env.XDG_STATE_HOME = path.join(temporaryHome, "state")
process.env.OPENCODE_TEST_HOME = temporaryHome

const { FreeTier } = await import("../../src/altimate/free/client")
const { FreeTierStore } = await import("../../src/altimate/free/store")
const { FreeTierConsent } = await import("../../src/altimate/free/consent")
const { FreeTierCapability } = await import("../../src/altimate/free/capability")
const { Flock } = await import("@opencode-ai/core/util/flock")

const GATEWAY_URL = "https://gateway.test"
const REGISTERED = {
  api_key: "sk-altimate-base-1",
  base_url: GATEWAY_URL,
  model: FreeTier.MODEL_ID,
  expires_at: new Date(Date.now() + 86_400_000).toISOString(),
}

let fetchSpy: ReturnType<typeof spyOn> | undefined

function mockFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>) {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(handler as typeof fetch)
  return fetchSpy
}

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

beforeEach(async () => {
  fetchSpy?.mockRestore()
  fetchSpy = undefined
  // Exercise the production disconnect path, then remove its retained fair-use identity so each
  // test starts as a genuinely fresh installation.
  await FreeTier.logout()
  await FreeTierStore.remove()
  delete process.env.ALTIMATE_BASE_GATEWAY_URL
  delete process.env.ALTIMATE_FREE_GATEWAY_URL
  process.env.ALTIMATE_BASE_GATEWAY_URL = GATEWAY_URL
})

afterEach(() => {
  fetchSpy?.mockRestore()
  fetchSpy = undefined
})

afterAll(() => {
  for (const key of isolatedEnvironment) {
    const value = originalEnvironment[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(temporaryHome, { recursive: true, force: true })
})

// This test file plays the role of the TUI host: minting a consent token goes through the shared
// `consented()` helper in `_fixtures/altimate-base-harness.ts`, which claims `issueArmer()` — the
// process's ONE arming capability, exactly as `cli/tui/worker.ts` does at boot — lazily and caches
// it, so every suite file sharing this process gets the SAME armer instead of each one claiming it
// independently (which would throw on the second file). Every `FreeTier.registerAfterConsent` call
// in this file therefore goes through the SAME path production does; nothing here constructs a
// private, independent store that `registerAfterConsent` would actually trust (see "unforgeable
// consent" below for a direct test of that property).

describe("gateway configuration", () => {
  test("requires source-mode configuration and prefers the new override", () => {
    delete process.env.ALTIMATE_BASE_GATEWAY_URL
    expect(() => FreeTier.gatewayUrl()).toThrow(FreeTier.ConfigurationError)
    process.env.ALTIMATE_FREE_GATEWAY_URL = "https://legacy-gateway.example/"
    expect(FreeTier.gatewayUrl()).toBe("https://legacy-gateway.example")
    process.env.ALTIMATE_BASE_GATEWAY_URL = "https://future-gateway.example/root/"
    expect(FreeTier.gatewayUrl()).toBe("https://future-gateway.example/root")
  })

  test("rejects unsafe configured URLs", () => {
    for (const value of [
      "http://gateway.example.com",
      "http://localhost:4000",
      "https://user:pass@gateway.example.com",
      "https://gateway.example.com/?target=elsewhere",
      "https://gateway.example.com/#fragment",
      "https://gateway.example.com?",
      "https://gateway.example.com#",
      "not-a-url",
    ]) {
      process.env.ALTIMATE_BASE_GATEWAY_URL = value
      expect(() => FreeTier.gatewayUrl()).toThrow(FreeTier.ConfigurationError)
    }
  })
})

describe("registration", () => {
  test("stores only a hash remotely and keeps credentials in the dedicated file", async () => {
    let requestBody: Record<string, unknown> | undefined
    const sharedAuthPath = path.join(path.dirname(FreeTierStore.credentialPath()), "auth.json")
    const sharedAuthBefore = fs.existsSync(sharedAuthPath) ? fs.readFileSync(sharedAuthPath) : undefined
    mockFetch(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body))
      return json(REGISTERED)
    })

    const result = await FreeTier.registerAfterConsent(consented())
    const sentHash = String(requestBody?.install_secret_hash)
    expect(sentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(sentHash).toBe(createHash("sha256").update(result.installSecret).digest("hex"))
    expect(sentHash).not.toBe(result.installSecret)
    expect(await FreeTier.credentials()).toEqual(result)
    expect(path.basename(FreeTierStore.credentialPath())).toBe("altimate-base.json")
    expect(fs.statSync(FreeTierStore.credentialPath()).mode & 0o777).toBe(0o600)
    // The full suite may already have auth.json from unrelated auth tests. Pin the actual isolation
    // property by proving registration leaves that shared store byte-for-byte unchanged.
    const sharedAuthAfter = fs.existsSync(sharedAuthPath) ? fs.readFileSync(sharedAuthPath) : undefined
    expect(sharedAuthAfter).toEqual(sharedAuthBefore)
  })

  test("registration is impossible without an armed consent capability", async () => {
    let gatewayCalls = 0
    mockFetch(() => {
      gatewayCalls++
      return json(REGISTERED)
    })
    const forged = randomBytes(32).toString("hex")

    // A token that was never armed through the legitimate path cannot register, and nothing
    // reaches the network or the credential file. This is the property the whole consent design
    // rests on.
    await expect(FreeTier.registerAfterConsent(forged)).rejects.toBeInstanceOf(FreeTier.RegistrationError)
    expect(gatewayCalls).toBe(0)
    expect(await FreeTierStore.read()).toBeUndefined()

    const token = consented()
    const result = await FreeTier.registerAfterConsent(token)
    expect(result.apiKey).toBe(REGISTERED.api_key)
    expect(gatewayCalls).toBe(1)

    // One-shot: the same token cannot register a second time.
    await expect(FreeTier.registerAfterConsent(token)).rejects.toBeInstanceOf(FreeTier.RegistrationError)
    expect(gatewayCalls).toBe(1)
  })

  test("unforgeable consent: no in-process caller can mint an independent authority", async () => {
    // `consented()`'s module-scope setup above already claimed the process's ONE armer, exactly
    // as the TUI worker does at boot; `client.ts` claims the matching ONE redeemer at import
    // time. This test plays the attacker: it tries to obtain either capability a second time,
    // and separately proves that a self-constructed, self-armed store is inert against the real
    // registration function. Both are the properties `registerAfterConsent`'s unforgeability
    // rests on.
    expect(() => FreeTierCapability.issueArmer()).toThrow()
    expect(() => FreeTierCapability.issueRedeemer()).toThrow()

    // Constructing your own store and arming it — exactly the exploit a caller-supplied capability
    // used to allow — produces a token that only ever validates against ITSELF. The store happily
    // reports it as consumed, but `registerAfterConsent` no longer accepts a capability argument at
    // all, only a bare token checked against the private, one-shot-issued authority above, so this
    // "successfully consumed" forged token still cannot register.
    let gatewayCalls = 0
    mockFetch(() => {
      gatewayCalls++
      return json(REGISTERED)
    })
    const forgedStore = new FreeTierCapability.ConsentCapabilityStore()
    const forgedToken = randomBytes(32).toString("hex")
    forgedStore.arm(forgedToken)
    expect(forgedStore.consume(forgedToken)).toBe(true)
    await expect(FreeTier.registerAfterConsent(forgedToken)).rejects.toBeInstanceOf(FreeTier.RegistrationError)
    expect(gatewayCalls).toBe(0)
  })

  test("rejects a registration response that redirects credentials to another origin", async () => {
    mockFetch(() => json({ ...REGISTERED, base_url: "https://attacker.example.com" }))
    await expect(FreeTier.registerAfterConsent(consented())).rejects.toBeInstanceOf(FreeTier.RegistrationError)
    expect(await FreeTier.isRegistered()).toBe(false)
  })

  test("rejects a registration response that changes the configured gateway path", async () => {
    mockFetch(() => json({ ...REGISTERED, base_url: `${GATEWAY_URL}/unexpected-proxy` }))
    await expect(FreeTier.registerAfterConsent(consented())).rejects.toBeInstanceOf(FreeTier.RegistrationError)
    expect(await FreeTier.isRegistered()).toBe(false)
  })

  test("rejects a response for a different model", async () => {
    mockFetch(() => json({ ...REGISTERED, model: "another-model" }))
    await expect(FreeTier.registerAfterConsent(consented())).rejects.toBeInstanceOf(FreeTier.RegistrationError)
    expect(await FreeTier.isRegistered()).toBe(false)
  })

  test("rejects an already-expired credential response", async () => {
    mockFetch(() => json({ ...REGISTERED, expires_at: new Date(Date.now() - 1_000).toISOString() }))
    await expect(FreeTier.registerAfterConsent(consented())).rejects.toBeInstanceOf(FreeTier.RegistrationError)
    expect(await FreeTier.isRegistered()).toBe(false)
  })

  test("reuses a live credential without another registration request", async () => {
    await FreeTierStore.write({
      version: 1,
      installSecret: "existing-install-secret",
      apiKey: REGISTERED.api_key,
      baseURL: REGISTERED.base_url,
      expiresAt: REGISTERED.expires_at,
    })
    let calls = 0
    mockFetch(() => {
      calls++
      return json(REGISTERED)
    })

    const result = await FreeTier.registerAfterConsent(consented())
    expect(result.apiKey).toBe(REGISTERED.api_key)
    expect(calls).toBe(0)
  })

  test("repairs a malformed dedicated credential record only after explicit registration", async () => {
    fs.mkdirSync(path.dirname(FreeTierStore.credentialPath()), { recursive: true })
    fs.writeFileSync(FreeTierStore.credentialPath(), "{truncated", { mode: 0o600 })
    mockFetch(() => json(REGISTERED))

    await expect(FreeTier.credentialsForLoad()).rejects.toBeInstanceOf(FreeTierStore.InvalidCredentialStoreError)
    const result = await FreeTier.registerAfterConsent(consented())
    expect(result.apiKey).toBe(REGISTERED.api_key)
    expect(await FreeTier.credentials()).toEqual(result)
  })

  test("reuses the install secret after a lost response", async () => {
    let firstHash = ""
    mockFetch((_input, init) => {
      firstHash = String(JSON.parse(String(init?.body)).install_secret_hash)
      throw new Error("connection reset")
    })
    await expect(FreeTier.registerAfterConsent(consented())).rejects.toBeInstanceOf(FreeTier.RegistrationError)
    fetchSpy?.mockRestore()

    let secondHash = ""
    mockFetch((_input, init) => {
      secondHash = String(JSON.parse(String(init?.body)).install_secret_hash)
      return json(REGISTERED)
    })
    await FreeTier.registerAfterConsent(consented())
    expect(secondHash).toBe(firstHash)
  })

  test("distinguishes network failures from invalid gateway responses", async () => {
    mockFetch(() => {
      throw new Error("connection reset")
    })
    const network = await FreeTier.registerAfterConsent(consented()).catch((error) => error)
    expect(network).toBeInstanceOf(FreeTier.RegistrationError)
    expect(network.kind).toBe("network")
    fetchSpy?.mockRestore()

    mockFetch(() => json({ ...REGISTERED, api_key: "" }))
    const response = await FreeTier.registerAfterConsent(consented()).catch((error) => error)
    expect(response).toBeInstanceOf(FreeTier.RegistrationError)
    expect(response.kind).toBe("response")
    expect(response.status).toBeUndefined()
  })

  test("cancels an in-flight gateway registration when its caller is dismissed", async () => {
    const controller = new AbortController()
    let started!: () => void
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let requestAborted = false
    mockFetch((_input, init) => {
      started()
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            requestAborted = true
            reject(init.signal?.reason)
          },
          { once: true },
        )
      })
    })

    const pending = FreeTier.registerAfterConsent(consented(), { signal: controller.signal })
    await requestStarted
    controller.abort()

    await expect(pending).rejects.toBeInstanceOf(FreeTier.RegistrationError)
    expect(requestAborted).toBe(true)
  })

  test("does not reconnect when logout wins the lock before a pending registration", async () => {
    const registered = {
      version: 1 as const,
      installSecret: "stable-install-secret",
      logoutNonce: "before-logout",
      apiKey: "rejected-key",
      baseURL: GATEWAY_URL,
      rejected: true,
    }
    await FreeTierStore.write(registered)

    let gatewayCalls = 0
    mockFetch(() => {
      gatewayCalls++
      return json(REGISTERED)
    })

    let releaseLock!: () => void
    let lockAcquired!: () => void
    const acquired = new Promise<void>((resolve) => {
      lockAcquired = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve
    })
    const holder = Flock.withLock("altimate-base-registration", async () => {
      lockAcquired()
      await release
    })
    await acquired

    const originalRead = FreeTierStore.read
    let baselineRead!: () => void
    const baselineObserved = new Promise<void>((resolve) => {
      baselineRead = resolve
    })
    const readSpy = spyOn(FreeTierStore, "read").mockImplementation(async () => {
      const value = await originalRead()
      baselineRead()
      return value
    })
    const pending = FreeTier.registerAfterConsent(consented())
    await baselineObserved
    readSpy.mockRestore()

    // Model another process winning the same file lock with logout after registration captured the
    // old generation. The pending operation must recheck before making a gateway request.
    await FreeTierStore.write({
      version: 1,
      installSecret: registered.installSecret,
      logoutNonce: "after-logout",
    })
    releaseLock()
    await holder

    const error = await pending.catch((cause) => cause)
    expect(error).toBeInstanceOf(FreeTier.RegistrationError)
    expect(error.kind).toBe("cancelled")
    expect(gatewayCalls).toBe(0)
    expect(await FreeTier.credentials()).toBeUndefined()
    expect(await FreeTierStore.read()).toMatchObject({
      installSecret: registered.installSecret,
      logoutNonce: "after-logout",
    })
  })
})

describe("inference boundary", () => {
  async function seed(overrides: Partial<Parameters<typeof FreeTierStore.write>[0]> = {}) {
    await FreeTierStore.write({
      version: 1,
      installSecret: "install-secret",
      apiKey: REGISTERED.api_key,
      baseURL: REGISTERED.base_url,
      ...overrides,
    })
  }

  test("fails closed without credentials", async () => {
    let calls = 0
    mockFetch(() => {
      calls++
      return new Response("", { status: 200 })
    })
    await expect(
      FreeTier.authorizedFetch(`${REGISTERED.base_url}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: "Bearer stale" },
        body: '{"prompt":"secret"}',
      }),
    ).rejects.toThrow("credentials are unavailable")
    expect(calls).toBe(0)
  })

  test("does not load credentials issued for a previously configured gateway", async () => {
    await seed({ baseURL: `${GATEWAY_URL}/old-path` })

    expect(await FreeTier.credentialsForLoad()).toBeUndefined()
    expect(await FreeTier.isRegistered()).toBe(false)
  })

  test("fails closed on expired credentials without registering during provider discovery", async () => {
    await seed({ expiresAt: new Date(Date.now() - 1_000).toISOString() })
    let registrations = 0
    mockFetch((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith("/register")) registrations++
      return json({ ...REGISTERED, api_key: "sk-altimate-base-refreshed" })
    })

    expect(await FreeTier.credentialsForLoad()).toBeUndefined()
    expect(registrations).toBe(0)
  })

  test("blocks a mismatched origin before sending the stale header or prompt", async () => {
    await seed()
    let calls = 0
    mockFetch(() => {
      calls++
      return new Response("", { status: 200 })
    })
    await expect(
      FreeTier.authorizedFetch("https://attacker.example.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer stale" },
        body: '{"prompt":"secret"}',
      }),
    ).rejects.toThrow("unregistered gateway origin")
    expect(calls).toBe(0)
  })

  test("overwrites stale authorization and disables redirects", async () => {
    await seed()
    let authorization: string | null = null
    let redirect: RequestRedirect | undefined
    mockFetch((_input, init) => {
      authorization = new Headers(init?.headers).get("Authorization")
      redirect = init?.redirect
      return new Response("{}", { status: 200 })
    })
    const response = await FreeTier.authorizedFetch(`${REGISTERED.base_url}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer stale" },
      body: "{}",
    })
    expect(response.status).toBe(200)
    expect<string | null>(authorization).toBe(`Bearer ${REGISTERED.api_key}`)
    expect(redirect).toBe("manual")
  })

  test("a successful request reads the credential store exactly once", async () => {
    await seed()
    const reads = spyOn(FreeTierStore, "read")
    mockFetch(() => new Response("{}", { status: 200 }))
    try {
      const response = await FreeTier.authorizedFetch(`${REGISTERED.base_url}/v1/chat/completions`, {
        method: "POST",
        body: "{}",
      })
      expect(response.status).toBe(200)
      expect(reads).toHaveBeenCalledTimes(1)
    } finally {
      reads.mockRestore()
    }
  })

  test("never sends a rotated credential issued for another origin", async () => {
    await seed()
    const authorizations: (string | null)[] = []
    mockFetch(async (_input, init) => {
      authorizations.push(new Headers(init?.headers).get("Authorization"))
      await seed({ apiKey: "sk-evil", baseURL: "https://attacker.example.com" })
      return new Response("", { status: 401 })
    })
    const response = await FreeTier.authorizedFetch(`${REGISTERED.base_url}/v1/chat/completions`, {
      method: "POST",
      body: "{}",
    })
    expect(response.status).toBe(401)
    expect(authorizations).toEqual([`Bearer ${REGISTERED.api_key}`])
  })

  test("retries once with a credential already rotated by another consented process", async () => {
    await seed()
    const authorizations: (string | null)[] = []
    mockFetch(async (_input, init) => {
      const authorization = new Headers(init?.headers).get("Authorization")
      authorizations.push(authorization)
      if (authorization === `Bearer ${REGISTERED.api_key}`) {
        await seed({ apiKey: "sk-altimate-base-rotated" })
        return new Response("", { status: 401 })
      }
      return new Response("{}", { status: 200 })
    })

    const response = await FreeTier.authorizedFetch(`${REGISTERED.base_url}/v1/chat/completions`, {
      method: "POST",
      body: "{}",
    })
    expect(response.status).toBe(200)
    expect(authorizations).toEqual([`Bearer ${REGISTERED.api_key}`, "Bearer sk-altimate-base-rotated"])
  })

  test("a single 401 does not disown the credential on disk", async () => {
    // Distinct key per test: the consecutive-401 counter is keyed by credential fingerprint and
    // is module state, so reusing REGISTERED.api_key would inherit counts from earlier tests.
    await seed({ apiKey: "sk-401-single" })
    mockFetch(() => new Response("", { status: 401 }))
    const response = await FreeTier.authorizedFetch(`${REGISTERED.base_url}/v1/chat/completions`, {
      method: "POST",
      body: "{}",
    })
    expect(response.status).toBe(401)
    // Blocked for this process, but a relaunch must retry: one 401 can be a gateway deploy or
    // key-propagation skew, and persisting it would force every user back through the disclosure.
    expect((await FreeTierStore.read())?.rejected).toBeUndefined()
  })

  test("consecutive 401s do disown the credential on disk", async () => {
    await seed({ apiKey: "sk-401-consecutive" })
    mockFetch(() => new Response("", { status: 401 }))
    for (let attempt = 0; attempt < 2; attempt++) {
      await FreeTier.authorizedFetch(`${REGISTERED.base_url}/v1/chat/completions`, { method: "POST", body: "{}" })
    }
    expect((await FreeTierStore.read())?.rejected).toBe(true)
  })

  test("a success between 401s resets the consecutive count", async () => {
    await seed({ apiKey: "sk-401-reset" })
    let status = 401
    mockFetch(() => new Response("{}", { status }))
    const call = () =>
      FreeTier.authorizedFetch(`${REGISTERED.base_url}/v1/chat/completions`, { method: "POST", body: "{}" })

    await call()
    status = 200
    await call()
    status = 401
    await call()
    expect((await FreeTierStore.read())?.rejected).toBeUndefined()
  })

  test("a non-401, non-2xx response between 401s also resets the consecutive count", async () => {
    // A 429/503 (or any other non-401 status) is not an auth rejection either — the gateway would
    // return 401 specifically for a rejected key. Gating the reset on `response.ok` alone let a
    // 401 that happened to straddle an unrelated rate-limit or outage response still reach the
    // persistence threshold and disown a credential the gateway never actually rejected.
    await seed({ apiKey: "sk-401-mixed-reset" })
    let status = 401
    mockFetch(() => new Response("", { status }))
    const call = () =>
      FreeTier.authorizedFetch(`${REGISTERED.base_url}/v1/chat/completions`, { method: "POST", body: "{}" })

    await call()
    status = 429
    await call()
    status = 401
    await call()
    expect((await FreeTierStore.read())?.rejected).toBeUndefined()
  })

  test("a 401 never triggers background registration", async () => {
    await seed()
    const urls: string[] = []
    mockFetch((input) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      return new Response("", { status: 401 })
    })

    const response = await FreeTier.authorizedFetch(`${REGISTERED.base_url}/v1/chat/completions`, {
      method: "POST",
      body: "{}",
    })
    expect(response.status).toBe(401)
    expect(urls).toEqual([`${REGISTERED.base_url}/v1/chat/completions`])
    expect(await FreeTierStore.read()).toMatchObject({ rejected: true })
    expect(await FreeTier.credentialsForLoad()).toBeUndefined()
  })

  test("a non-success response does not clear a concurrently persisted rejection", async () => {
    await seed()
    mockFetch(async () => {
      await seed({ rejected: true })
      return new Response("unavailable", { status: 500 })
    })

    const response = await FreeTier.authorizedFetch(`${REGISTERED.base_url}/v1/chat/completions`, {
      method: "POST",
      body: "{}",
    })

    expect(response.status).toBe(500)
    expect(await FreeTierStore.read()).toMatchObject({ rejected: true })
  })

  test("a late success does not clear a rejection recorded by a concurrent 401", async () => {
    await seed()
    mockFetch(async () => {
      await seed({ rejected: true })
      return new Response("{}", { status: 200 })
    })

    const response = await FreeTier.authorizedFetch(`${REGISTERED.base_url}/v1/chat/completions`, {
      method: "POST",
      body: "{}",
    })

    expect(response.status).toBe(200)
    expect(await FreeTierStore.read()).toMatchObject({ rejected: true })
    expect(await FreeTier.credentialsForLoad()).toBeUndefined()
  })

  test("explicit consent rotates an unexpired credential rejected by inference", async () => {
    await seed({ expiresAt: REGISTERED.expires_at })
    const urls: string[] = []
    mockFetch((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      urls.push(url)
      if (url.endsWith("/register")) return json({ ...REGISTERED, api_key: "sk-altimate-base-rotated" })
      return new Response("", { status: 401 })
    })

    const rejected = await FreeTier.authorizedFetch(`${REGISTERED.base_url}/v1/chat/completions`, {
      method: "POST",
      body: "{}",
    })
    expect(rejected.status).toBe(401)

    const rotated = await FreeTier.registerAfterConsent(consented())
    expect(rotated.apiKey).toBe("sk-altimate-base-rotated")
    expect(urls).toEqual([`${REGISTERED.base_url}/v1/chat/completions`, `${REGISTERED.base_url}/register`])
  })
})

describe("consent boundary", () => {
  test("overlapping one-shot capabilities survive mismatches and remain independent", async () => {
    const first = "a".repeat(64)
    const second = "b".repeat(64)
    let registrations = 0
    // Exercises the gate's arm/register plumbing in isolation, via its own independent store —
    // deliberately NOT the production authority `consented()` above uses, since this test is
    // about the gate's wiring, not about the real unforgeability property (covered separately).
    const store = new FreeTierCapability.ConsentCapabilityStore()
    const gate = FreeTierConsent.createRegistrationConsentGate({
      arm: (token) => store.arm(token),
      register: async (token) => {
        if (!store.consume(token)) throw new FreeTier.RegistrationError("consent expired", "cancelled")
        registrations++
      },
    })

    gate.setToken({ token: first })
    gate.setToken({ token: second })
    expect((await gate.register({ token: "c".repeat(64) })).ok).toBe(false)
    expect((await gate.register({ token: first })).ok).toBe(true)
    expect((await gate.register({ token: first })).ok).toBe(false)
    expect((await gate.register({ token: second })).ok).toBe(true)
    expect(registrations).toBe(2)
  })

  test("pending capabilities are bounded and expire", () => {
    let now = 1_000
    const capabilities = new FreeTierCapability.ConsentCapabilityStore({ maxPending: 2, ttlMs: 50, now: () => now })
    const first = "a".repeat(64)
    const second = "b".repeat(64)
    const third = "c".repeat(64)
    capabilities.arm(first)
    capabilities.arm(second)
    capabilities.arm(third)
    expect(capabilities.consume(first)).toBe(false)
    expect(capabilities.consume(second)).toBe(true)
    now += 51
    expect(capabilities.consume(third)).toBe(false)
  })

  test("only transport failures are surfaced as network failures", async () => {
    const token = "d".repeat(64)
    const network = FreeTierConsent.createRegistrationConsentGate({
      arm: () => {},
      register: async () => {
        throw new FreeTier.RegistrationError("offline", "network")
      },
    })
    network.setToken({ token })
    expect(await network.register({ token })).toMatchObject({ ok: false, result: "network" })

    const invalidResponse = FreeTierConsent.createRegistrationConsentGate({
      arm: () => {},
      register: async () => {
        throw new FreeTier.RegistrationError("invalid", "response")
      },
    })
    invalidResponse.setToken({ token })
    expect(await invalidResponse.register({ token })).toMatchObject({ ok: false, result: "error" })
  })
})
