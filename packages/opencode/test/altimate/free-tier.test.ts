// altimate_change — free-tier gateway client.
//
// XDG + test-home overrides are set BEFORE the dynamic imports below: `src/global/index.ts`
// resolves its paths at module load, so a static import would bind the developer's real
// ~/.local/share/altimate-code/auth.json and these tests would write credentials into it.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "altimate-free-tier-"))
process.env["XDG_DATA_HOME"] = path.join(tmp, "data")
process.env["XDG_CONFIG_HOME"] = path.join(tmp, "config")
process.env["XDG_CACHE_HOME"] = path.join(tmp, "cache")
process.env["XDG_STATE_HOME"] = path.join(tmp, "state")
process.env["OPENCODE_TEST_HOME"] = tmp

const { FreeTier } = await import("../../src/altimate/free/client")
const { Auth } = await import("../../src/auth")
const { Global } = await import("../../src/global")

type FetchCall = { url: string; body: Record<string, unknown> }

function mockGateway(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = []
  const spy = spyOn(global, "fetch").mockImplementation((async (input: any, init: any) => {
    const call: FetchCall = {
      url: typeof input === "string" ? input : input.url,
      body: JSON.parse(init?.body ?? "{}"),
    }
    calls.push(call)
    return handler(call)
  }) as unknown as typeof fetch)
  return { calls, spy }
}

async function wait(fn: () => boolean | Promise<boolean>, timeout = 2000) {
  const start = Date.now()
  while (!(await fn())) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function ok(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
}

const REGISTERED = {
  api_key: "sk-free-1",
  base_url: "https://free.onealtimate.com",
  model: "gemini-flash-free",
  expires_at: new Date(Date.now() + 86_400_000).toISOString(),
}

beforeEach(async () => {
  await Auth.remove(FreeTier.PROVIDER_ID)
  delete process.env["ALTIMATE_FREE_GATEWAY_URL"]
})

afterEach(() => {
  spyOn(global, "fetch").mockRestore()
})

describe("gateway url", () => {
  test("defaults to the hosted gateway and honours the env override", () => {
    expect(FreeTier.gatewayUrl()).toBe("https://free.onealtimate.com")
    process.env["ALTIMATE_FREE_GATEWAY_URL"] = "http://localhost:4000/"
    expect(FreeTier.gatewayUrl()).toBe("http://localhost:4000")
  })
})

describe("registration", () => {
  test("a fresh install is not registered and reads no credential", async () => {
    expect(await FreeTier.isRegistered()).toBe(false)
    expect(await FreeTier.credentials()).toBeUndefined()
  })

  test("registers with a hashed install secret and stores the returned credential", async () => {
    const gateway = mockGateway(() => ok(REGISTERED))

    const creds = await FreeTier.register()

    expect(gateway.calls).toHaveLength(1)
    expect(gateway.calls[0]!.url).toBe("https://free.onealtimate.com/register")
    // The raw secret never leaves the machine — only its digest.
    const hash = gateway.calls[0]!.body["install_secret_hash"] as string
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toBe(creds.installSecret)
    expect(hash).toBe(createHash("sha256").update(creds.installSecret).digest("hex"))
    expect(typeof gateway.calls[0]!.body["cli_version"]).toBe("string")

    expect(creds.apiKey).toBe(REGISTERED.api_key)
    expect(creds.baseURL).toBe(REGISTERED.base_url)
    expect(await FreeTier.isRegistered()).toBe(true)
  })

  test("the install secret is stored, not the machine-id, and survives re-registration", async () => {
    const gateway = mockGateway(() => ok(REGISTERED))
    const first = await FreeTier.register()

    gateway.spy.mockRestore()
    const second = mockGateway(() => ok({ ...REGISTERED, api_key: "sk-free-2" }))
    const rotated = await FreeTier.register()

    // Same principal (same hash), new key: the gateway's budget must not reset on rotation.
    expect(second.calls[0]!.body["install_secret_hash"]).toBe(
      createHash("sha256").update(first.installSecret).digest("hex"),
    )
    expect(rotated.installSecret).toBe(first.installSecret)
    expect(rotated.apiKey).toBe("sk-free-2")
  })

  test("velocity and kill-switch rejections surface their status", async () => {
    for (const status of [429, 503] as const) {
      mockGateway(() => new Response("", { status }))
      const err = await FreeTier.register().then(
        () => undefined,
        (e) => e,
      )
      expect(err).toBeInstanceOf(FreeTier.RegistrationError)
      expect((err as InstanceType<typeof FreeTier.RegistrationError>).status).toBe(status)
      expect(await FreeTier.isRegistered()).toBe(false)
      spyOn(global, "fetch").mockRestore()
    }
  })

  test("an unreachable gateway fails without a status and stores nothing", async () => {
    mockGateway(() => {
      throw new Error("connect ECONNREFUSED")
    })
    const err = await FreeTier.register().then(
      () => undefined,
      (e) => e,
    )
    expect(err).toBeInstanceOf(FreeTier.RegistrationError)
    expect((err as InstanceType<typeof FreeTier.RegistrationError>).status).toBeUndefined()
    expect(await FreeTier.isRegistered()).toBe(false)
  })

  test("a malformed gateway response is rejected rather than stored", async () => {
    // Type checks alone let an empty key or a plaintext/arbitrary base URL through — and the base
    // URL is where the key and every prompt would then be sent.
    const bad = [
      { api_key: 42, base_url: "https://free.onealtimate.com" },
      { api_key: "", base_url: "https://free.onealtimate.com" },
      { api_key: "  ", base_url: "https://free.onealtimate.com" },
      { api_key: "sk-x", base_url: "" },
      { api_key: "sk-x", base_url: "not a url" },
      { api_key: "sk-x", base_url: "http://evil.example.com" },
    ]
    for (const body of bad) {
      mockGateway(() => ok(body))
      await expect(FreeTier.register()).rejects.toBeInstanceOf(FreeTier.RegistrationError)
      expect(await FreeTier.isRegistered()).toBe(false)
      spyOn(global, "fetch").mockRestore()
    }
  })

  test("a local gateway over http is allowed, for development", async () => {
    mockGateway(() => ok({ ...REGISTERED, base_url: "http://localhost:4000" }))
    const creds = await FreeTier.register()
    expect(creds.baseURL).toBe("http://localhost:4000")
  })
})

describe("provider load", () => {
  // The invariant the consent design rests on: nothing reaches the gateway except from an
  // explicit user action. Provider load runs at startup and on every reload, so a network call
  // from here means the process contacts the gateway before the user has done anything.
  test("an unregistered install never calls the gateway", async () => {
    const gateway = mockGateway(() => ok(REGISTERED))
    expect(await FreeTier.credentialsForLoad()).toBeUndefined()
    expect(gateway.calls).toHaveLength(0)
  })

  test("a live credential is returned without a network call", async () => {
    mockGateway(() => ok(REGISTERED))
    await FreeTier.register()

    spyOn(global, "fetch").mockRestore()
    const gateway = mockGateway(() => ok(REGISTERED))
    const creds = await FreeTier.credentialsForLoad()

    expect(gateway.calls).toHaveLength(0)
    expect(creds?.apiKey).toBe(REGISTERED.api_key)
  })

  test("an EXPIRED credential is still returned without a network call", async () => {
    // Previously this kicked off a background registration. "Expired" is not a user action, and a
    // failing refresh repeated on every reload. Rotation belongs on the 401 path instead.
    mockGateway(() => ok({ ...REGISTERED, expires_at: new Date(Date.now() - 1000).toISOString() }))
    await FreeTier.register()

    spyOn(global, "fetch").mockRestore()
    const gateway = mockGateway(() => ok({ ...REGISTERED, api_key: "sk-free-rotated" }))
    const creds = await FreeTier.credentialsForLoad()

    expect(gateway.calls).toHaveLength(0)
    expect(creds?.apiKey).toBe(REGISTERED.api_key)
  })

  test("an unparseable expiry does not trigger a call either", async () => {
    mockGateway(() => ok({ ...REGISTERED, expires_at: "whenever" }))
    await FreeTier.register()

    spyOn(global, "fetch").mockRestore()
    const gateway = mockGateway(() => ok(REGISTERED))
    await FreeTier.credentialsForLoad()
    expect(gateway.calls).toHaveLength(0)
  })

  test("concurrent registrations share one call so keys are not orphaned", async () => {
    const gateway = mockGateway(() => ok(REGISTERED))
    const [a, b, c] = await Promise.all([FreeTier.register(), FreeTier.register(), FreeTier.register()])
    expect(gateway.calls).toHaveLength(1)
    expect(a.apiKey).toBe(b.apiKey)
    expect(b.apiKey).toBe(c.apiKey)
  })
})

describe("inference fetch", () => {
  const INFERENCE = "https://free.onealtimate.com/v1/chat/completions"

  function auth(init: RequestInit | undefined): string | null {
    return new Headers(init?.headers).get("Authorization")
  }

  test("sends the stored key, and passes through unchanged when unregistered", async () => {
    let seen: string | null = "unset"
    spyOn(global, "fetch").mockImplementation((async (_i: any, init: any) => {
      seen = auth(init)
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch)

    await FreeTier.authorizedFetch(INFERENCE, { method: "POST", body: "{}" })
    expect(seen).toBeNull()

    spyOn(global, "fetch").mockRestore()
    mockGateway(() => ok(REGISTERED))
    await FreeTier.register()

    spyOn(global, "fetch").mockRestore()
    spyOn(global, "fetch").mockImplementation((async (_i: any, init: any) => {
      seen = auth(init)
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch)
    await FreeTier.authorizedFetch(INFERENCE, { method: "POST", body: "{}" })
    expect(seen).toBe(`Bearer ${REGISTERED.api_key}`)
  })

  test("a revoked key is re-registered once and the request retried", async () => {
    // A key can be revoked before its stated expiry (kill switch, principal revocation), which
    // expiry-based rotation cannot see.
    mockGateway(() => ok(REGISTERED))
    await FreeTier.register()
    spyOn(global, "fetch").mockRestore()

    const sent: (string | null)[] = []
    spyOn(global, "fetch").mockImplementation((async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input.url
      if (url.endsWith("/register")) return ok({ ...REGISTERED, api_key: "sk-free-fresh" })
      sent.push(auth(init))
      return new Response("", { status: auth(init) === "Bearer sk-free-fresh" ? 200 : 401 })
    }) as unknown as typeof fetch)

    const response = await FreeTier.authorizedFetch(INFERENCE, { method: "POST", body: "{}" })

    expect(response.status).toBe(200)
    expect(sent).toEqual([`Bearer ${REGISTERED.api_key}`, "Bearer sk-free-fresh"])
    expect((await FreeTier.credentials())?.apiKey).toBe("sk-free-fresh")
  })

  test("a 401 racing another request's rotation reuses that key instead of minting one", async () => {
    mockGateway(() => ok(REGISTERED))
    await FreeTier.register()
    spyOn(global, "fetch").mockRestore()

    let registrations = 0
    const sent: (string | null)[] = []
    spyOn(global, "fetch").mockImplementation((async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input.url
      if (url.endsWith("/register")) {
        registrations++
        return ok({ ...REGISTERED, api_key: "sk-free-winner" })
      }
      const header = auth(init)
      sent.push(header)
      // The first request's key is stale; the winner's key works.
      return new Response("", { status: header === "Bearer sk-free-winner" ? 200 : 401 })
    }) as unknown as typeof fetch)

    // First request rotates. Second starts with the same stale key but finds the new one stored.
    const first = await FreeTier.authorizedFetch(INFERENCE, { method: "POST", body: "{}" })
    expect(first.status).toBe(200)
    expect(registrations).toBe(1)

    const second = await FreeTier.authorizedFetch(INFERENCE, { method: "POST", body: "{}" })
    expect(second.status).toBe(200)
    // Still one: the second request must not have minted a second key.
    expect(registrations).toBe(1)
  })

  test("a 401 that cannot be recovered is returned rather than throwing", async () => {
    mockGateway(() => ok(REGISTERED))
    await FreeTier.register()
    spyOn(global, "fetch").mockRestore()

    let attempts = 0
    spyOn(global, "fetch").mockImplementation((async (input: any) => {
      const url = typeof input === "string" ? input : input.url
      if (url.endsWith("/register")) return new Response("", { status: 503 })
      attempts++
      return new Response("", { status: 401 })
    }) as unknown as typeof fetch)

    const response = await FreeTier.authorizedFetch(INFERENCE, { method: "POST", body: "{}" })
    expect(response.status).toBe(401)
    expect(attempts).toBe(1)
  })

  test("a streamed body is not retried, since it cannot be replayed", async () => {
    mockGateway(() => ok(REGISTERED))
    await FreeTier.register()
    spyOn(global, "fetch").mockRestore()

    let registrations = 0
    spyOn(global, "fetch").mockImplementation((async (input: any) => {
      const url = typeof input === "string" ? input : input.url
      if (url.endsWith("/register")) {
        registrations++
        return ok({ ...REGISTERED, api_key: "sk-free-fresh" })
      }
      return new Response("", { status: 401 })
    }) as unknown as typeof fetch)

    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"))
        controller.close()
      },
    })
    const response = await FreeTier.authorizedFetch(INFERENCE, { method: "POST", body, duplex: "half" } as RequestInit)

    expect(response.status).toBe(401)
    expect(registrations).toBe(0)
  })
})

describe("cli_version", () => {
  // The gateway accepts ^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$ and 422s anything else. Release
  // builds conform; other builds do not, and the two that matter are real: CI's sanity build
  // (0.0.0-sanity-<40 char sha>, 53 chars) and a build stamped with a branch name, which in this
  // repo contains slashes.
  const GATEWAY_GRAMMAR = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/

  test("release and dev versions pass through untouched", () => {
    for (const version of ["1.4.2", "local", "0.0.0", "1.17.9-beta.3"]) {
      expect(FreeTier.sanitizeCliVersion(version)).toBe(version)
      expect(FreeTier.sanitizeCliVersion(version)).toMatch(GATEWAY_GRAMMAR)
    }
  })

  test("the CI sanity version is truncated to something the gateway accepts", () => {
    const sanity = "0.0.0-sanity-" + "a".repeat(40)
    expect(sanity.length).toBe(53)
    const sent = FreeTier.sanitizeCliVersion(sanity)
    expect(sent).toMatch(GATEWAY_GRAMMAR)
    expect(sent.length).toBe(32)
  })

  test("branch-stamped versions lose their slashes rather than being rejected", () => {
    const sent = FreeTier.sanitizeCliVersion("upstream/merge-v1.17.9")
    expect(sent).toMatch(GATEWAY_GRAMMAR)
    expect(sent).not.toContain("/")
  })

  test("versions that start with punctuation, or are empty, still conform", () => {
    expect(FreeTier.sanitizeCliVersion("-1.2.3")).toMatch(GATEWAY_GRAMMAR)
    expect(FreeTier.sanitizeCliVersion("")).toBe("unknown")
    expect(FreeTier.sanitizeCliVersion("---")).toBe("unknown")
    expect(FreeTier.sanitizeCliVersion("   ")).toBe("unknown")
  })

  test("whatever the build stamps, the value actually sent conforms", async () => {
    const gateway = mockGateway(() => ok(REGISTERED))
    await FreeTier.register()
    expect(String(gateway.calls[0]!.body["cli_version"])).toMatch(GATEWAY_GRAMMAR)
  })
})

describe("inference rate limits", () => {
  // One 429 status, two opposite meanings. Keyed on the body discriminator because the gateway
  // measured budget statuses moving between LiteLLM releases.
  const body = (type: string, message = "") => JSON.stringify({ error: { type, message } })

  test("throttling tells the user to wait, and uses Retry-After when present", () => {
    const plain = FreeTier.describeRateLimit({ body: body("throttling_error") })
    expect(plain).toContain("Too many requests")
    expect(plain).toContain("shortly")

    const timed = FreeTier.describeRateLimit({ body: body("throttling_error"), retryAfter: "30" })
    expect(timed).toContain("30s")
  })

  test("a spent budget says it resets, and never says to retry", () => {
    const personal = FreeTier.describeRateLimit({
      body: body("budget_exceeded", "ExceededBudget: User=free-abc123"),
    })
    expect(personal).toContain("today's free allowance")
    expect(personal).toContain("resets tomorrow")
    expect(personal).not.toMatch(/try again/i)
  })

  test("the shared ceiling is not reported as the user's own limit", () => {
    // Telling someone they used up their allowance when the whole tier is out is simply wrong.
    const shared = FreeTier.describeRateLimit({
      body: body("budget_exceeded", "Budget has been exceeded! Current cost: 9.99"),
    })
    expect(shared).toContain("shared daily limit")
    expect(shared).not.toContain("You've used")
  })

  test("an unknown budget message still reads correctly for both cases", () => {
    const neutral = FreeTier.describeRateLimit({ body: body("budget_exceeded", "something new") })
    expect(neutral).toContain("resets tomorrow")
    expect(neutral).not.toContain("You've used")
    expect(neutral).not.toContain("shared daily")
  })

  test("an unrecognised discriminator is left to the provider's own message", () => {
    // The failure mode to avoid: our wording swallowing an error we do not understand.
    expect(FreeTier.describeRateLimit({ body: body("something_else") })).toBeUndefined()
    expect(FreeTier.describeRateLimit({ body: '{"error":{}}' })).toBeUndefined()
    expect(FreeTier.describeRateLimit({ body: "not json at all" })).toBeUndefined()
    expect(FreeTier.describeRateLimit({})).toBeUndefined()
  })

  test("the discriminator is read from a top-level type too", () => {
    expect(FreeTier.describeRateLimit({ body: JSON.stringify({ type: "throttling_error" }) })).toContain(
      "Too many requests",
    )
  })
})

describe("oversized requests", () => {
  // Verbatim from the gateway (LiteLLM nests our hook's error under provider_specific_fields).
  const REAL_413 = JSON.stringify({
    error: {
      message: "Request is 179608 bytes; the free tier limit is 128000 bytes.",
      type: "None",
      param: "None",
      code: "413",
      provider_specific_fields: {
        error: { code: "request_too_large", message: "Request is 179608 bytes; the free tier limit is 128000 bytes." },
      },
    },
  })

  test("the real gateway body is recognised and both sizes are surfaced", () => {
    const described = FreeTier.describeRequestTooLarge(REAL_413)
    expect(described).toContain("too large for Gemini Flash (Free)")
    expect(described).toContain("175KB")
    expect(described).toContain("125KB")
    // It must tell the user what to do, since nothing will retry for them any more.
    expect(described).toContain("new session")
  })

  test("the flat shape is recognised too", () => {
    const described = FreeTier.describeRequestTooLarge(
      JSON.stringify({ error: { code: "request_too_large", message: "Request is 1 bytes; the free tier limit is 2 bytes" } }),
    )
    expect(described).toContain("too large")
  })

  test("a body without the sizes still produces usable text", () => {
    const described = FreeTier.describeRequestTooLarge(JSON.stringify({ error: { code: "request_too_large" } }))
    expect(described).toContain("too large")
    expect(described).not.toContain("undefined")
    expect(described).not.toContain("NaN")
  })

  test("unrelated 413 bodies are left alone", () => {
    expect(FreeTier.describeRequestTooLarge(JSON.stringify({ error: { code: "context_length_exceeded" } }))).toBeUndefined()
    expect(FreeTier.describeRequestTooLarge("not json")).toBeUndefined()
    expect(FreeTier.describeRequestTooLarge()).toBeUndefined()
  })
})

describe("registration idempotency", () => {
  test("a lost response reuses the same secret instead of minting a second principal", async () => {
    // The gateway may have committed the registration before the response was lost. Retrying with
    // a fresh secret would create a second budget principal — a duplicate identity, and a way to
    // farm grants by interrupting registrations.
    const first = mockGateway(() => {
      throw new Error("connection reset after the gateway committed")
    })
    await expect(FreeTier.register()).rejects.toBeInstanceOf(FreeTier.RegistrationError)
    const attemptedHash = first.calls[0]?.body["install_secret_hash"]

    spyOn(global, "fetch").mockRestore()
    const second = mockGateway(() => ok(REGISTERED))
    const creds = await FreeTier.register()

    expect(second.calls[0]!.body["install_secret_hash"]).toBe(attemptedHash)
    expect(FreeTier.hashInstallSecret(creds.installSecret)).toBe(String(attemptedHash))
  })

  test("a pending secret does not make the install look registered", async () => {
    mockGateway(() => new Response("", { status: 503 }))
    await expect(FreeTier.register()).rejects.toBeInstanceOf(FreeTier.RegistrationError)
    // A secret with no key is not a credential: the provider must stay unavailable, and the
    // loader must not treat it as usable.
    expect(await FreeTier.isRegistered()).toBe(false)
    expect(await FreeTier.credentialsForLoad()).toBeUndefined()
  })
})

describe("registration capability", () => {
  // Registration mints an identity and spends our budget, so reaching the HTTP server must not be
  // enough to call it. The capability exists in the launching process's environment, which the
  // TUI inherits and a network caller does not.
  const ORIGINAL = process.env["ALTIMATE_FREE_CONSENT_TOKEN"]
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env["ALTIMATE_FREE_CONSENT_TOKEN"]
    else process.env["ALTIMATE_FREE_CONSENT_TOKEN"] = ORIGINAL
  })

  test("with no capability in the environment nothing is accepted", () => {
    // This is the `serve` case: the route is simply unavailable rather than guessable.
    delete process.env["ALTIMATE_FREE_CONSENT_TOKEN"]
    expect(FreeTier.consentTokenValid("anything")).toBe(false)
    expect(FreeTier.consentTokenValid("")).toBe(false)
    expect(FreeTier.consentTokenValid(undefined)).toBe(false)
  })

  test("only the exact capability is accepted", () => {
    const token = FreeTier.mintConsentToken()
    process.env["ALTIMATE_FREE_CONSENT_TOKEN"] = token
    expect(FreeTier.consentTokenValid(token)).toBe(true)
    // altimate_change — the mutated last character has to be guaranteed different. The token is
    // 64 hex chars, so `slice(0, -1) + "0"` reconstructs the ORIGINAL token whenever it already
    // ends in "0" — a 1-in-16 flake that fails roughly every fifteenth run.
    expect(FreeTier.consentTokenValid(token.slice(0, -1) + (token.endsWith("0") ? "1" : "0"))).toBe(false)
    expect(FreeTier.consentTokenValid(token.slice(0, -1))).toBe(false)
    expect(FreeTier.consentTokenValid(token + "x")).toBe(false)
    expect(FreeTier.consentTokenValid("")).toBe(false)
    expect(FreeTier.consentTokenValid(null)).toBe(false)
  })

  test("the capability is unguessable and per-launch", () => {
    const a = FreeTier.mintConsentToken()
    const b = FreeTier.mintConsentToken()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })
})

describe("real gateway 429 bodies", () => {
  // Captured verbatim from the running gateway, not constructed. The first version of this
  // handling assumed a Retry-After header and a single flavour of throttle; neither is what
  // LiteLLM actually sends.
  const TOKENS_429 = JSON.stringify({
    error: {
      message:
        "Rate limit exceeded for api_key: e4ab7e652480c088469613d7f09fce37d978c5635c2c94fc8fe402c16c1342ac. Limit type: tokens. Current limit: 150000, Remaining: 39505. Limit resets at: 2126-08-06 13:57:48 UTC",
      type: "throttling_error",
      param: null,
      code: "429",
    },
  })
  const REQUESTS_429 = JSON.stringify({
    error: {
      message:
        "Rate limit exceeded for api_key: e4ab7e65. Limit type: requests. Current limit: 10, Remaining: 0. Limit resets at: 2126-08-06 13:57:52 UTC",
      type: "throttling_error",
      param: null,
      code: "429",
    },
  })

  test("a token-ceiling throttle advises shortening, not retrying", () => {
    // Retrying the same oversized request fails identically — the size is the problem.
    const described = FreeTier.describeRateLimit({ body: TOKENS_429 })
    expect(described).toContain("per-minute token limit")
    expect(described).toContain("new session")
    expect(described).not.toMatch(/Try again in \d+s/)
  })

  test("a request-rate throttle surfaces the reset time from the BODY, with no Retry-After", () => {
    // The reset only exists in the message text; the header the first version relied on is absent.
    const described = FreeTier.describeRateLimit({ body: REQUESTS_429 })
    expect(described).toContain("Too many requests")
    expect(described).toMatch(/Try again in \d+s/)
  })

  test("neither message leaks the key identifier from the gateway's text", () => {
    // The gateway names the key hash in its message; our wording must not carry it to the user.
    for (const body of [TOKENS_429, REQUESTS_429]) {
      expect(FreeTier.describeRateLimit({ body })).not.toContain("e4ab7e65")
    }
  })
})

describe("credential file permissions", () => {
  test("auth.json is never briefly world-readable while holding a secret", async () => {
    // writeJson used to write the content and chmod afterwards, so the file existed with the
    // umask's permissions — containing the install secret and the key — until the chmod landed.
    // Every provider's credentials go through the same path, not just ours.
    // Asked of the code rather than reconstructed: the XDG resolution happens at module load and
    // guessing the path made this assert a directory that never existed.
    const authPath = path.join(Global.Path.data, "auth.json")
    fs.rmSync(authPath, { force: true })

    mockGateway(() => ok(REGISTERED))
    await FreeTier.register()

    const mode = fs.statSync(authPath).mode & 0o777
    expect(mode).toBe(0o600)
    // No temp file left behind by the atomic rename.
    const strays = fs.readdirSync(path.dirname(authPath)).filter((f) => f.endsWith(".tmp"))
    expect(strays).toEqual([])
  })
})

describe("registration dedupe is keyed on the rejected key", () => {
  // The in-process share exists so a burst of parallel 401s on ONE key triggers one rotation
  // rather than one per request. Sharing across DIFFERENT rejected keys is a different thing and
  // was a bug: the lock body's adopt-vs-rotate decision is computed for whichever caller created
  // the promise, so a caller rejected on B could join a rotation started for A and be handed
  // back B — the key it had just proven dead — returning the original 401 without rotating.
  //
  // The pre-existing rotation test cannot catch this: it awaits the first request before
  // starting the second, so the two never overlap, and both carry the same stale key. Restoring
  // the old process-wide `inflight` promise leaves it green.
  test("two callers rejected on DIFFERENT keys never get their own rejected key back", async () => {
    mockGateway(() => ok(REGISTERED))
    await FreeTier.register()
    spyOn(global, "fetch").mockRestore()

    // Stored key is sk-free-1 (REGISTERED). Caller B is the one whose rejected key matches what
    // is stored, so under the old shared promise it would be told to keep using it.
    const storedKey = REGISTERED.api_key

    let minted = 0
    spyOn(global, "fetch").mockImplementation((async (input: any) => {
      const url = typeof input === "string" ? input : input.url
      if (url.endsWith("/register")) {
        minted++
        return ok({ ...REGISTERED, api_key: `sk-free-rotated-${minted}` })
      }
      return new Response("", { status: 200 })
    }) as unknown as typeof fetch)

    // Overlapping, not sequential. Argument evaluation is left-to-right, so the "sk-other"
    // caller creates the shared promise under the old code — which then resolves to the stored
    // key and hands the second caller exactly the key it rejected.
    const [other, stored] = await Promise.all([
      FreeTier.register({ supersede: "sk-other-dead" }),
      FreeTier.register({ supersede: storedKey }),
    ])

    expect(other.apiKey).not.toBe("sk-other-dead")
    expect(stored.apiKey).not.toBe(storedKey)
    // Exactly one of the two had to mint: the caller whose rejected key was the stored one.
    // The other adopts a live key rather than registering again.
    expect(minted).toBe(1)
  })

  test("a burst on the SAME rejected key still shares one registration", async () => {
    mockGateway(() => ok(REGISTERED))
    await FreeTier.register()
    spyOn(global, "fetch").mockRestore()

    let minted = 0
    spyOn(global, "fetch").mockImplementation((async (input: any) => {
      const url = typeof input === "string" ? input : input.url
      if (url.endsWith("/register")) {
        minted++
        return ok({ ...REGISTERED, api_key: "sk-free-shared" })
      }
      return new Response("", { status: 200 })
    }) as unknown as typeof fetch)

    // The property the dedupe exists for, kept intact by keying on `supersede` rather than
    // removing the share: five simultaneous 401s on one key must not mint five identities.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => FreeTier.register({ supersede: REGISTERED.api_key })),
    )

    expect(minted).toBe(1)
    for (const r of results) expect(r.apiKey).toBe("sk-free-shared")
  })
})
