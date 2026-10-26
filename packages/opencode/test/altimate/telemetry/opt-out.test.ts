import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import os from "os"
import path from "path"
import { Auth } from "../../../src/auth"
import { Telemetry } from "../../../src/altimate/telemetry"
import { TelemetryIdentity } from "../../../src/altimate/telemetry/identity"
import { OptOutMarker } from "../../../src/altimate/telemetry/opt-out"

const MACHINE = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"
const UUID = "0f3c2a1e-6b7d-4c8e-9f10-1a2b3c4d5e6f"
const API = "https://api.example.invalid"
const CS = "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://ingest.example.invalid/"

type Call = { url: string; body: string }

async function waitFor(pred: () => boolean, ms = 2_000) {
  const until = Date.now() + ms
  while (!pred() && Date.now() < until) await new Promise((r) => setTimeout(r, 20))
  return pred()
}

describe("telemetry opt-out marker", () => {
  let home: string
  let calls: Call[]
  let trackStatus = 200
  /** When set, the next /v2/track POST waits on it before answering. */
  let holdTrack: Promise<void> | undefined
  let fetchSpy: ReturnType<typeof spyOn>
  let homedirSpy: ReturnType<typeof spyOn>
  let authSpy: ReturnType<typeof spyOn>
  const saved: Record<string, string | undefined> = {}
  const ENV = [
    "OPENCODE_TEST_HOME",
    "APPLICATIONINSIGHTS_CONNECTION_STRING",
    "ALTIMATE_TELEMETRY_DISABLED",
    "OPENCODE_DISABLE_TELEMETRY",
    "ALTIMATE_TELEMETRY_FORCE",
  ]

  const optOuts = () =>
    calls
      .filter((c) => c.url.includes("/v2/track"))
      .flatMap((c) => JSON.parse(c.body) as any[])
      .filter((e) => e.data?.baseData?.name === "telemetry_opted_out")
  const trackPosts = () => calls.filter((c) => c.url.includes("/v2/track"))

  function writeMachineId() {
    mkdirSync(path.join(home, ".altimate"), { recursive: true })
    writeFileSync(path.join(home, ".altimate", "machine-id"), MACHINE)
  }
  function writeCreds() {
    mkdirSync(path.join(home, ".altimate"), { recursive: true })
    writeFileSync(
      path.join(home, ".altimate", "altimate.json"),
      JSON.stringify({ altimateUrl: API, altimateInstanceName: "acme", altimateApiKey: "key-1" }),
    )
  }

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "telemetry-opt-out-"))
    for (const k of ENV) saved[k] = process.env[k]
    process.env.OPENCODE_TEST_HOME = home
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = CS
    delete process.env.ALTIMATE_TELEMETRY_DISABLED
    delete process.env.OPENCODE_DISABLE_TELEMETRY
    delete process.env.ALTIMATE_TELEMETRY_FORCE
    homedirSpy = spyOn(os, "homedir").mockImplementation(() => home)
    // The auth store lives in the real data directory; never let a test read it.
    authSpy = spyOn(Auth, "get").mockResolvedValue(undefined)
    Telemetry.allowOptOutUnderTestRunner(true)
    calls = []
    trackStatus = 200
    holdTrack = undefined
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, body: String(init?.body ?? "") })
      if (url === `${API}/users/me`) {
        return new Response(JSON.stringify({ id: 7, uuid: UUID }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.includes("/v2/track")) {
        if (holdTrack) await holdTrack
        return new Response("", { status: trackStatus })
      }
      return new Response("", { status: 200 })
    }) as any)
  })

  afterEach(async () => {
    await Telemetry.shutdown()
    Telemetry.allowOptOutUnderTestRunner(false)
    fetchSpy.mockRestore()
    homedirSpy.mockRestore()
    authSpy.mockRestore()
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    rmSync(home, { recursive: true, force: true })
  })

  test("an opted-out machine sends one final event with its identity, then nothing", async () => {
    writeMachineId()
    writeCreds()
    expect(await TelemetryIdentity.resolve()).toEqual({ user_id: UUID, tenant: "acme" })
    const meCallsBefore = calls.filter((c) => c.url.endsWith("/users/me")).length

    process.env.ALTIMATE_TELEMETRY_DISABLED = "1"
    await Telemetry.shutdown()
    await Telemetry.init()
    expect(await waitFor(() => optOuts().length > 0)).toBe(true)
    const [event] = optOuts()
    expect(event.data.baseData.properties.machine_id).toBe(MACHINE)
    expect(event.data.baseData.properties.opt_out_source).toBe("env")
    expect(event.data.baseData.properties.user_id).toBe(UUID)
    expect(event.data.baseData.properties.tenant).toBe("acme")
    expect(typeof event.data.baseData.properties.cli_version).toBe("string")
    expect(event.tags["ai.user.id"]).toBe(UUID)
    // Identity came from the cache: no request to resolve it while opted out.
    expect(calls.filter((c) => c.url.endsWith("/users/me")).length).toBe(meCallsBefore)
    expect(await waitFor(() => OptOutMarker.exists())).toBe(true)

    // Nothing after it: tracked events are dropped, and a new init does not send again.
    const posts = trackPosts().length
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
    await Telemetry.shutdown()
    await Telemetry.init()
    await new Promise((r) => setTimeout(r, 150))
    expect(trackPosts().length).toBe(posts)
    expect(optOuts()).toHaveLength(1)
  })

  test("a machine that never sent telemetry sends nothing and gets no marker", async () => {
    process.env.ALTIMATE_TELEMETRY_DISABLED = "1"
    await Telemetry.shutdown()
    await Telemetry.init()
    await new Promise((r) => setTimeout(r, 150))
    expect(trackPosts()).toHaveLength(0)
    expect(OptOutMarker.exists()).toBe(false)
    expect(existsSync(path.join(home, ".altimate", "machine-id"))).toBe(false)
  })

  test("a corrupt or oversized machine-id file sends nothing", async () => {
    mkdirSync(path.join(home, ".altimate"), { recursive: true })
    writeFileSync(path.join(home, ".altimate", "machine-id"), "not-a-uuid\n" + "x".repeat(4096))
    process.env.ALTIMATE_TELEMETRY_DISABLED = "1"
    await Telemetry.shutdown()
    await Telemetry.init()
    await new Promise((r) => setTimeout(r, 150))
    expect(trackPosts()).toHaveLength(0)
    expect(OptOutMarker.exists()).toBe(false)
  })

  test("the marker is written only once the sink accepted the event", async () => {
    writeMachineId()
    process.env.OPENCODE_DISABLE_TELEMETRY = "true"
    trackStatus = 500
    await Telemetry.shutdown()
    await Telemetry.init()
    expect(await waitFor(() => trackPosts().length === 1)).toBe(true)
    await new Promise((r) => setTimeout(r, 50))
    expect(OptOutMarker.exists()).toBe(false)

    trackStatus = 200
    await Telemetry.shutdown()
    await Telemetry.init()
    expect(await waitFor(() => trackPosts().length === 2)).toBe(true)
    expect(await waitFor(() => OptOutMarker.exists())).toBe(true)
    expect(optOuts()).toHaveLength(2)
    expect(optOuts()[1].data.baseData.properties.user_id).toBeUndefined()
    expect(optOuts()[1].tags["ai.user.id"]).toBe(MACHINE)
  })

  test("a send still pending when telemetry is re-enabled never recreates the marker", async () => {
    writeMachineId()
    let release: () => void = () => {}
    holdTrack = new Promise<void>((r) => (release = r))
    process.env.ALTIMATE_TELEMETRY_DISABLED = "1"
    await Telemetry.shutdown()
    await Telemetry.init()
    expect(await waitFor(() => trackPosts().length === 1)).toBe(true) // the POST is in flight

    delete process.env.ALTIMATE_TELEMETRY_DISABLED
    await Telemetry.shutdown()
    await Telemetry.init() // telemetry on again; this lifecycle owns the marker now
    expect(Telemetry.isEnabled()).toBe(true)
    release()
    await new Promise((r) => setTimeout(r, 100))
    expect(OptOutMarker.exists()).toBe(false)

    // Opting out again is recorded afresh.
    holdTrack = undefined
    process.env.ALTIMATE_TELEMETRY_DISABLED = "1"
    await Telemetry.shutdown()
    await Telemetry.init()
    expect(await waitFor(() => optOuts().length === 2)).toBe(true)
    expect(await waitFor(() => OptOutMarker.exists())).toBe(true)
  })

  test("a send accepted after a shutdown still writes the marker, so the next opted-out init sends nothing", async () => {
    writeMachineId()
    let release: () => void = () => {}
    holdTrack = new Promise<void>((r) => (release = r))
    process.env.ALTIMATE_TELEMETRY_DISABLED = "1"
    await Telemetry.shutdown()
    await Telemetry.init()
    expect(await waitFor(() => trackPosts().length === 1)).toBe(true) // the POST is in flight

    await Telemetry.shutdown() // still opted out: nothing has cleared the marker
    release()
    expect(await waitFor(() => OptOutMarker.exists())).toBe(true)

    holdTrack = undefined
    await Telemetry.init()
    await new Promise((r) => setTimeout(r, 100))
    expect(optOuts()).toHaveLength(1)
  })

  test("turning telemetry back on clears the marker", async () => {
    writeMachineId()
    OptOutMarker.write()
    expect(OptOutMarker.exists()).toBe(true)
    await Telemetry.shutdown()
    await Telemetry.init()
    expect(Telemetry.isEnabled()).toBe(true)
    expect(OptOutMarker.exists()).toBe(false)
    expect(optOuts()).toHaveLength(0)
  })
})
