import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, existsSync, writeFileSync } from "fs"
import os from "os"
import path from "path"
import { Telemetry } from "../../../src/altimate/telemetry"
import { TelemetryIdentity } from "../../../src/altimate/telemetry/identity"

const UUID = "0f3c2a1e-6b7d-4c8e-9f10-1a2b3c4d5e6f"
const UUID_B = "7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d"
const API = "https://api.example.invalid"

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
  /** Per-api-key gates: a /users/me request for that key waits on the promise before answering. */
  let gates: Record<string, Promise<void> | undefined> = {}

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
    gates = {}
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, method: init?.method ?? "GET", headers: headersOf(init), body: String(init?.body ?? "") })
      if (url === `${API}/users/me`) {
        const key = headersOf(init)["authorization"]?.replace("Bearer ", "") ?? ""
        const gate = gates[key]
        if (gate) await gate
        if (meStatus !== 200) return new Response("nope", { status: meStatus })
        const uuid = key === "key-B" ? UUID_B : UUID.toUpperCase()
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
    await TelemetryIdentity.resolve()
    expect(existsSync(TelemetryIdentity.cachePath())).toBe(true)
    // Signing out (credential gone) forgets the cached identity.
    rmSync(path.join(home, ".altimate", "altimate.json"))
    expect(await TelemetryIdentity.resolve()).toBeUndefined()
    expect(existsSync(TelemetryIdentity.cachePath())).toBe(false)
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
