import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, existsSync, writeFileSync } from "fs"
import os from "os"
import path from "path"
import { Telemetry } from "../../../src/altimate/telemetry"
import { Auth } from "../../../src/auth"
import { TelemetryIdentity } from "../../../src/altimate/telemetry/identity"

const UUID = "0f3c2a1e-6b7d-4c8e-9f10-1a2b3c4d5e6f"
const UUID_B = "7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d"
const API = "https://api.example.invalid"
const DEFAULT_API = "https://api.myaltimate.com"

type Call = { url: string; method: string; headers: Record<string, string>; body: string }

function headersOf(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {}
  const h = init?.headers
  if (!h) return out
  if (h instanceof Headers) h.forEach((v, k) => (out[k.toLowerCase()] = v))
  else if (Array.isArray(h)) for (const [k, v] of h) out[k.toLowerCase()] = String(v)
  else for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v)
  return out
}

describe("telemetry identity", () => {
  let home: string
  let calls: Call[]
  let fetchSpy: ReturnType<typeof spyOn>
  let homedirSpy: ReturnType<typeof spyOn>
  let savedTestHome: string | undefined
  let savedCs: string | undefined
  let meStatus = 200
  /** When set, /users/me answers 200 with this raw body instead of a user. */
  let meBody: string | undefined
  let authSpy: ReturnType<typeof spyOn>
  /** Per-api-key gates: a /users/me request for that key waits on the promise before answering. */
  let gates: Record<string, Promise<void> | undefined> = {}
  /** Resolved when a /users/me request for that key has reached its gate. */
  let entered: Record<string, () => void> = {}

  function writeCreds(apiKey = "key-1") {
    mkdirSync(path.join(home, ".altimate"), { recursive: true })
    writeFileSync(
      path.join(home, ".altimate", "altimate.json"),
      JSON.stringify({ altimateUrl: API, altimateInstanceName: "acme", altimateApiKey: apiKey }),
    )
  }
  function meCalls() {
    return calls.filter((c) => c.url === `${API}/users/me`)
  }
  function trackCalls() {
    return calls.filter((c) => c.url.includes("/v2/track"))
  }

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "telemetry-identity-"))
    savedTestHome = process.env.OPENCODE_TEST_HOME
    savedCs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
    process.env.OPENCODE_TEST_HOME = home
    homedirSpy = spyOn(os, "homedir").mockImplementation(() => home)
    calls = []
    meStatus = 200
    meBody = undefined
    gates = {}
    entered = {}
    // The auth store lives in the real data directory; never let a test read it.
    authSpy = spyOn(Auth, "get").mockResolvedValue(undefined)
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, method: init?.method ?? "GET", headers: headersOf(init), body: String(init?.body ?? "") })
      if (url === `${API}/users/me` || url === `${DEFAULT_API}/users/me`) {
        const key = headersOf(init)["authorization"]?.replace("Bearer ", "") ?? ""
        const gate = gates[key]
        entered[key]?.()
        if (gate) await gate
        if (meStatus !== 200) return new Response("nope", { status: meStatus })
        if (meBody !== undefined)
          return new Response(meBody, { status: 200, headers: { "content-type": "application/json" } })
        const uuid = key.startsWith("key-B") ? UUID_B : UUID.toUpperCase()
        return new Response(JSON.stringify({ id: 7, uuid, email: "someone@example.invalid" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response("", { status: 200 })
    }) as any)
  })

  afterEach(async () => {
    await Telemetry.shutdown()
    fetchSpy.mockRestore()
    homedirSpy.mockRestore()
    authSpy.mockRestore()
    if (savedTestHome === undefined) delete process.env.OPENCODE_TEST_HOME
    else process.env.OPENCODE_TEST_HOME = savedTestHome
    if (savedCs === undefined) delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
    else process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = savedCs
    rmSync(home, { recursive: true, force: true })
  })

  test("resolves the backend user once per credential and caches it with owner-only permissions", async () => {
    writeCreds()
    const first = await TelemetryIdentity.resolve()
    expect(first).toEqual({ user_id: UUID, tenant: "acme" })
    expect(meCalls()).toHaveLength(1)
    const me = meCalls()[0]
    expect(me.headers["x-tenant"]).toBe("acme")
    expect(me.headers["authorization"]).toBe("Bearer key-1")
    expect(me.headers["x-altimate-client"]).toMatch(/^altimate-code\//)

    const cachePath = TelemetryIdentity.cachePath()
    expect(cachePath).toBe(path.join(home, ".altimate", "telemetry-identity.json"))
    const cached = JSON.parse(readFileSync(cachePath, "utf8"))
    expect(cached.user_id).toBe(UUID)
    expect(cached.tenant).toBe("acme")
    expect(typeof cached.fingerprint).toBe("string")
    expect(cached.email).toBeUndefined()
    if (process.platform !== "win32") expect(statSync(cachePath).mode & 0o777).toBe(0o600)

    // Same credential: served from the cache, no request.
    expect(await TelemetryIdentity.resolve()).toEqual({ user_id: UUID, tenant: "acme" })
    expect(await TelemetryIdentity.cached()).toEqual({ user_id: UUID, tenant: "acme" })
    expect(meCalls()).toHaveLength(1)

    // Forced refresh asks again.
    await TelemetryIdentity.resolve({ refresh: true })
    expect(meCalls()).toHaveLength(2)

    // A different credential invalidates the cache.
    writeCreds("key-2")
    expect(await TelemetryIdentity.cached()).toBeUndefined()
    expect(await TelemetryIdentity.resolve()).toEqual({ user_id: UUID, tenant: "acme" })
    expect(meCalls()).toHaveLength(3)
    expect(meCalls()[2].headers["authorization"]).toBe("Bearer key-2")
  })

  test("resolves to nothing without a credential, on a failed request, or on a malformed answer", async () => {
    expect(await TelemetryIdentity.resolve()).toBeUndefined()
    expect(meCalls()).toHaveLength(0)

    writeCreds()
    meStatus = 401
    expect(await TelemetryIdentity.resolve()).toBeUndefined()
    expect(existsSync(TelemetryIdentity.cachePath())).toBe(false)

    meStatus = 200
    meBody = JSON.stringify({ id: 7, uuid: "not-a-uuid" })
    expect(await TelemetryIdentity.resolve()).toBeUndefined()
    meBody = "<html>proxy error</html>"
    expect(await TelemetryIdentity.resolve()).toBeUndefined()
    expect(existsSync(TelemetryIdentity.cachePath())).toBe(false)

    meBody = undefined
    await TelemetryIdentity.resolve()
    expect(existsSync(TelemetryIdentity.cachePath())).toBe(true)

    // A rejection drops the cache for that credential; a transient failure keeps it.
    meStatus = 503
    expect(await TelemetryIdentity.resolve({ refresh: true })).toBeUndefined()
    expect(await TelemetryIdentity.cached()).toEqual({ user_id: UUID, tenant: "acme" })
    meStatus = 401
    expect(await TelemetryIdentity.resolve({ refresh: true })).toBeUndefined()
    expect(await TelemetryIdentity.cached()).toBeUndefined()
    expect(existsSync(TelemetryIdentity.cachePath())).toBe(false)
    meStatus = 200
    // Signing out (credential gone) forgets the cached identity.
    rmSync(path.join(home, ".altimate", "altimate.json"))
    expect(await TelemetryIdentity.resolve()).toBeUndefined()
    expect(existsSync(TelemetryIdentity.cachePath())).toBe(false)
  })

  test("an answer for a credential that was removed mid-flight is neither cached nor returned", async () => {
    writeCreds("key-A")
    let releaseA: () => void = () => {}
    gates["key-A"] = new Promise<void>((r) => (releaseA = r))
    const reached = new Promise<void>((r) => (entered["key-A"] = r))
    const pending = TelemetryIdentity.resolve()
    await reached // the request is in flight at the gate
    rmSync(path.join(home, ".altimate", "altimate.json"))
    releaseA()
    expect(await pending).toBeUndefined()
    expect(existsSync(TelemetryIdentity.cachePath())).toBe(false)
  })

  test("a key entered in the TUI (auth store) resolves like the credential file", async () => {
    authSpy.mockResolvedValue({ type: "api", key: `${API}///::acme::key-S` })
    expect(await TelemetryIdentity.resolve()).toEqual({ user_id: UUID, tenant: "acme" })
    expect(calls.filter((c) => c.url.includes("/users/me")).at(-1)!.url).toBe(`${API}/users/me`)
    expect(meCalls()).toHaveLength(1)
    expect(await TelemetryIdentity.cached()).toEqual({ user_id: UUID, tenant: "acme" })
    // The credential file wins over the store when both exist.
    writeCreds("key-F")
    await TelemetryIdentity.resolve()
    const last = calls.filter((c) => c.url.endsWith("/users/me")).at(-1)!
    expect(last.headers["authorization"]).toBe("Bearer key-F")
  })

  test("a credential change on disk is noticed at the next flush, and a buffered batch keeps the identity it was tracked under", async () => {
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
      "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://ingest.example.invalid/"
    writeCreds("key-A")
    await Telemetry.shutdown()
    await Telemetry.init()
    await Telemetry.refreshIdentity()
    expect(Telemetry.identityForTest()).toEqual({ user_id: UUID, tenant: "acme" })

    Telemetry.track({
      type: "startup_ready",
      session_id: "",
      command: "a",
      surface: "a",
      duration_ms: 1,
      fresh_install: false,
      timestamp: Date.now(),
    })
    await new Promise((r) => setTimeout(r, 15)) // a distinct mtime for the rewritten file
    writeCreds("key-B-longer-so-the-size-differs-too")
    await Telemetry.flush()
    const first = (JSON.parse(trackCalls().at(-1)!.body) as any[]).find(
      (e) => e.data?.baseData?.name === "startup_ready",
    )
    expect(first.data.baseData.properties.user_id).toBe(UUID) // the batch tracked under A stays A
    const ok = await (async () => {
      const until = Date.now() + 2000
      while (Date.now() < until) {
        if (Telemetry.identityForTest()?.user_id === UUID_B) return true
        await new Promise((r) => setTimeout(r, 20))
      }
      return false
    })()
    expect(ok).toBe(true)

    Telemetry.track({
      type: "startup_ready",
      session_id: "",
      command: "b",
      surface: "b",
      duration_ms: 1,
      fresh_install: false,
      timestamp: Date.now(),
    })
    await Telemetry.flush()
    const second = (JSON.parse(trackCalls().at(-1)!.body) as any[]).find(
      (e) => e.data?.baseData?.properties?.command === "b",
    )
    expect(second.data.baseData.properties.user_id).toBe(UUID_B)

    // Sign-out on disk: noticed the same way, and the account is gone from the next batch.
    await new Promise((r) => setTimeout(r, 15))
    rmSync(path.join(home, ".altimate", "altimate.json"))
    await Telemetry.flush()
    await new Promise((r) => setTimeout(r, 50))
    expect(Telemetry.identityForTest()).toBeUndefined()
  })

  test("a transient failure at startup is retried at a later flush, not on every flush", async () => {
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
      "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://ingest.example.invalid/"
    writeCreds()
    meStatus = 503
    await Telemetry.shutdown()
    await Telemetry.init()
    await new Promise((r) => setTimeout(r, 60))
    expect(Telemetry.identityForTest()).toBeUndefined()
    const after = meCalls().length
    expect(after).toBeGreaterThanOrEqual(1)
    await Telemetry.flush()
    await Telemetry.flush()
    await new Promise((r) => setTimeout(r, 30))
    expect(meCalls().length).toBe(after) // backoff: no retry within the window

    // A different credential appearing during the backoff is picked up at once.
    meStatus = 200
    await new Promise((r) => setTimeout(r, 15))
    writeCreds("key-B-longer-so-the-size-differs-too")
    await Telemetry.flush()
    const gotB = await (async () => {
      const until = Date.now() + 2000
      while (Date.now() < until) {
        if (Telemetry.identityForTest()?.user_id === UUID_B) return true
        await new Promise((r) => setTimeout(r, 20))
      }
      return false
    })()
    expect(gotB).toBe(true)

    // And the unchanged credential is retried once the backoff has elapsed.
    await new Promise((r) => setTimeout(r, 15))
    writeCreds("key-A")
    meStatus = 503
    await Telemetry.flush()
    await new Promise((r) => setTimeout(r, 60))
    expect(Telemetry.identityForTest()).toBeUndefined()
    meStatus = 200
    Telemetry.retryIdentityNowForTest()
    await Telemetry.flush()
    const ok = await (async () => {
      const until = Date.now() + 2000
      while (Date.now() < until) {
        if (Telemetry.identityForTest()?.user_id === UUID) return true
        await new Promise((r) => setTimeout(r, 20))
      }
      return false
    })()
    expect(ok).toBe(true)
  })

  test("a resolution that started under the old credential never overwrites a newer sign-in", async () => {
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
      "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://ingest.example.invalid/"
    writeCreds("key-A")
    let releaseA: () => void = () => {}
    gates["key-A"] = new Promise<void>((r) => (releaseA = r))
    await Telemetry.shutdown()
    await Telemetry.init() // kicks off the resolution for key-A, which is now held
    writeCreds("key-B")
    await Telemetry.refreshIdentity()
    expect(Telemetry.identityForTest()).toEqual({ user_id: UUID_B, tenant: "acme" })
    releaseA()
    await new Promise((r) => setTimeout(r, 50))
    expect(Telemetry.identityForTest()).toEqual({ user_id: UUID_B, tenant: "acme" })

    // Likewise after shutdown: a resolution still in flight cannot repopulate the cleared state.
    let releaseB: () => void = () => {}
    gates["key-B"] = new Promise<void>((r) => (releaseB = r))
    void Telemetry.refreshIdentity()
    await Telemetry.shutdown()
    releaseB()
    await new Promise((r) => setTimeout(r, 50))
    expect(Telemetry.identityForTest()).toBeUndefined()
  })

  test("events carry user_id and tenant when signed in, and only the machine id otherwise", async () => {
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
      "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://ingest.example.invalid/"
    writeCreds()
    await Telemetry.shutdown()
    await Telemetry.init()
    await Telemetry.refreshIdentity()
    expect(Telemetry.identityForTest()).toEqual({ user_id: UUID, tenant: "acme" })

    Telemetry.track({
      type: "startup_ready",
      session_id: "",
      command: "test",
      surface: "test",
      duration_ms: 1,
      fresh_install: false,
      timestamp: Date.now(),
    })
    await Telemetry.flush()
    expect(trackCalls().length).toBeGreaterThan(0)
    const envelopes = JSON.parse(trackCalls().at(-1)!.body) as any[]
    const env = envelopes.find((e) => e.data?.baseData?.name === "startup_ready")
    expect(env).toBeDefined()
    expect(env.data.baseData.properties.user_id).toBe(UUID)
    expect(env.data.baseData.properties.tenant).toBe("acme")
    expect(env.tags["ai.user.id"]).toBe(UUID)
    const machineId = readFileSync(path.join(home, ".altimate", "machine-id"), "utf8").trim()
    expect(env.data.baseData.properties.machine_id).toBe(machineId)
    for (const value of Object.values(env.data.baseData.properties))
      expect(String(value)).not.toContain("example.invalid")

    // Sign out: the next events fall back to the machine id.
    rmSync(path.join(home, ".altimate", "altimate.json"))
    await Telemetry.refreshIdentity()
    expect(Telemetry.identityForTest()).toBeUndefined()
    calls = []
    Telemetry.track({
      type: "startup_ready",
      session_id: "",
      command: "test",
      surface: "test",
      duration_ms: 1,
      fresh_install: false,
      timestamp: Date.now(),
    })
    await Telemetry.flush()
    const after = (JSON.parse(trackCalls().at(-1)!.body) as any[]).find(
      (e) => e.data?.baseData?.name === "startup_ready",
    )
    expect(after.data.baseData.properties.user_id).toBeUndefined()
    expect(after.data.baseData.properties.tenant).toBeUndefined()
    expect(after.tags["ai.user.id"]).toBe(machineId)
  })
})
