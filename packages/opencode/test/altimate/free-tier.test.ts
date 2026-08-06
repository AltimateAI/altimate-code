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

describe("silent rotation", () => {
  test("an unregistered install never calls the gateway", async () => {
    const gateway = mockGateway(() => ok(REGISTERED))
    expect(await FreeTier.refreshIfNeeded()).toBeUndefined()
    expect(gateway.calls).toHaveLength(0)
  })

  test("a live credential is returned without a network call", async () => {
    mockGateway(() => ok(REGISTERED))
    await FreeTier.register()

    spyOn(global, "fetch").mockRestore()
    const gateway = mockGateway(() => ok(REGISTERED))
    const creds = await FreeTier.refreshIfNeeded()

    expect(gateway.calls).toHaveLength(0)
    expect(creds?.apiKey).toBe(REGISTERED.api_key)
  })

  test("an expired credential rotates in the background without blocking the caller", async () => {
    // Provider load calls this on every startup and reload. It must never wait on the gateway.
    mockGateway(() => ok({ ...REGISTERED, expires_at: new Date(Date.now() - 1000).toISOString() }))
    await FreeTier.register()

    spyOn(global, "fetch").mockRestore()
    let release: (() => void) | undefined
    const gateway = mockGateway(async () => {
      await new Promise<void>((resolve) => (release = resolve))
      return ok({ ...REGISTERED, api_key: "sk-free-rotated" })
    })

    const creds = await FreeTier.refreshIfNeeded()
    // Returned while the gateway request is still hanging — that is the property under test.
    expect(creds?.apiKey).toBe(REGISTERED.api_key)

    await wait(() => gateway.calls.length === 1)
    release?.()
    await wait(async () => (await FreeTier.credentials())?.apiKey === "sk-free-rotated")
  })

  test("an unparseable expiry rotates rather than pinning the credential forever", async () => {
    mockGateway(() => ok({ ...REGISTERED, expires_at: "whenever" }))
    await FreeTier.register()

    spyOn(global, "fetch").mockRestore()
    const gateway = mockGateway(() => ok({ ...REGISTERED, api_key: "sk-free-fixed" }))
    await FreeTier.refreshIfNeeded()
    await wait(() => gateway.calls.length === 1)
    await wait(async () => (await FreeTier.credentials())?.apiKey === "sk-free-fixed")
  })

  test("concurrent registrations share one call so keys are not orphaned", async () => {
    const gateway = mockGateway(() => ok(REGISTERED))
    const [a, b, c] = await Promise.all([FreeTier.register(), FreeTier.register(), FreeTier.register()])
    expect(gateway.calls).toHaveLength(1)
    expect(a.apiKey).toBe(b.apiKey)
    expect(b.apiKey).toBe(c.apiKey)
  })

  test("a failed rotation keeps the existing credential instead of throwing", async () => {
    // Provider load calls this; a gateway outage must not make the provider fail to resolve.
    mockGateway(() => ok({ ...REGISTERED, expires_at: new Date(Date.now() - 1000).toISOString() }))
    await FreeTier.register()

    spyOn(global, "fetch").mockRestore()
    mockGateway(() => new Response("", { status: 503 }))
    const creds = await FreeTier.refreshIfNeeded()

    expect(creds?.apiKey).toBe(REGISTERED.api_key)
    // The background rejection must not escape as an unhandled rejection either.
    await Bun.sleep(20)
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
