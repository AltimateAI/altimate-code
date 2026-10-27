import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "fs"
import os from "os"
import path from "path"
import { Auth } from "../../../src/auth"
import { Config } from "../../../src/config/config"
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
    "OPENCODE_CONFIG_CONTENT",
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

  test("an opted-out machine sends one final event with its machine id only, then nothing", async () => {
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
    // Never the account, the project or the launch, even with a cached identity on disk.
    for (const key of ["user_id", "tenant", "project_id", "launch_id"])
      expect(event.data.baseData.properties[key]).toBeUndefined()
    expect(typeof event.data.baseData.properties.cli_version).toBe("string")
    expect(event.tags["ai.user.id"]).toBe(MACHINE)
    // No request to resolve an identity while opted out.
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

  test("an init that cannot read the config keeps the marker and resolves no account", async () => {
    writeMachineId()
    writeCreds()
    OptOutMarker.write()
    const configSpy = spyOn(Config, "get")
    try {
      // The main thread's init: no Instance, so Config.get() throws, and the files cannot be read.
      configSpy.mockRejectedValue(new Error("InstanceRef not provided"))
      process.env.OPENCODE_CONFIG_CONTENT = "{ not json"
      await Telemetry.shutdown()
      await Telemetry.init()
      expect(Telemetry.isEnabled()).toBe(true) // ordinary rows keep flowing, as before
      await Telemetry.flush()
      await Telemetry.refreshIdentity()
      await new Promise((r) => setTimeout(r, 50))
      expect(OptOutMarker.exists()).toBe(true)
      expect(calls.filter((c) => c.url.endsWith("/users/me"))).toHaveLength(0)
      expect(Telemetry.identityForTest()).toBeUndefined()
      expect(optOuts()).toHaveLength(0)

      // The worker's init, inside an Instance: the config says disabled, and the marker held.
      delete process.env.OPENCODE_CONFIG_CONTENT
      configSpy.mockResolvedValue({ telemetry: { disabled: true } } as never)
      await Telemetry.shutdown()
      await Telemetry.init()
      await new Promise((r) => setTimeout(r, 50))
      expect(Telemetry.isEnabled()).toBe(false)
      expect(optOuts()).toHaveLength(0)
      expect(OptOutMarker.exists()).toBe(true)
    } finally {
      configSpy.mockRestore()
    }
  })

  test("an init without an Instance honours a config opt-out read from the files", async () => {
    writeMachineId()
    const configSpy = spyOn(Config, "get").mockRejectedValue(new Error("InstanceRef not provided"))
    try {
      process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ telemetry: { disabled: true } })
      await Telemetry.shutdown()
      await Telemetry.init()
      expect(Telemetry.isEnabled()).toBe(false)
      expect(await waitFor(() => optOuts().length === 1)).toBe(true)
      expect(optOuts()[0].data.baseData.properties.opt_out_source).toBe("config")
      expect(await waitFor(() => OptOutMarker.exists())).toBe(true)
    } finally {
      configSpy.mockRestore()
    }
  })

  test("OPENCODE_DISABLE_TELEMETRY records the opt-out with source env", async () => {
    writeMachineId()
    process.env.OPENCODE_DISABLE_TELEMETRY = "true"
    await Telemetry.shutdown()
    await Telemetry.init()
    expect(await waitFor(() => optOuts().length === 1)).toBe(true)
    expect(optOuts()[0].data.baseData.properties.opt_out_source).toBe("env")
    expect(await waitFor(() => OptOutMarker.exists())).toBe(true)
  })

  test("the config opt-out records the event with source config", async () => {
    writeMachineId()
    const configSpy = spyOn(Config, "get").mockResolvedValue({ telemetry: { disabled: true } } as never)
    try {
      await Telemetry.shutdown()
      await Telemetry.init()
      expect(Telemetry.isEnabled()).toBe(false)
      expect(await waitFor(() => optOuts().length === 1)).toBe(true)
      expect(optOuts()[0].data.baseData.properties.opt_out_source).toBe("config")
    } finally {
      configSpy.mockRestore()
    }
  })

  test("ALTIMATE_TELEMETRY_FORCE never sends the opt-out event", async () => {
    writeMachineId()
    process.env.ALTIMATE_TELEMETRY_DISABLED = "1"
    process.env.ALTIMATE_TELEMETRY_FORCE = "true"
    await Telemetry.shutdown()
    await Telemetry.init()
    await new Promise((r) => setTimeout(r, 100)) // nothing to wait for: the force check returns first
    expect(trackPosts()).toHaveLength(0)
    expect(OptOutMarker.exists()).toBe(false)
    expect(existsSync(path.join(home, ".altimate", "telemetry-opted-out.sending"))).toBe(false)
  })

  test("two disabled inits while the first send is in flight send the event once", async () => {
    writeMachineId()
    let release: () => void = () => {}
    holdTrack = new Promise<void>((r) => (release = r))
    process.env.ALTIMATE_TELEMETRY_DISABLED = "1"
    await Telemetry.shutdown()
    await Telemetry.init()
    expect(await waitFor(() => trackPosts().length === 1)).toBe(true) // the first send holds the claim

    await Telemetry.shutdown()
    await Telemetry.init() // a second init, as the TUI's worker beside its main thread
    await new Promise((r) => setTimeout(r, 100))
    expect(trackPosts()).toHaveLength(1)

    release()
    expect(await waitFor(() => OptOutMarker.exists())).toBe(true)
    expect(existsSync(path.join(home, ".altimate", "telemetry-opted-out.sending"))).toBe(false)
    expect(optOuts()).toHaveLength(1)
  })

  test("another process's fresh claim holds the send; a stale one is taken over", async () => {
    writeMachineId()
    const claimFile = path.join(home, ".altimate", "telemetry-opted-out.sending")
    writeFileSync(claimFile, "123\n")
    process.env.ALTIMATE_TELEMETRY_DISABLED = "1"
    await Telemetry.shutdown()
    await Telemetry.init()
    await new Promise((r) => setTimeout(r, 100))
    expect(trackPosts()).toHaveLength(0)

    const old = (Date.now() - 60_000) / 1000
    utimesSync(claimFile, old, old) // the process that held it died mid-send
    await Telemetry.shutdown()
    await Telemetry.init()
    expect(await waitFor(() => optOuts().length === 1)).toBe(true)
    expect(await waitFor(() => OptOutMarker.exists())).toBe(true)
  })

  test("a failed send gives the claim back, so the next launch tries again", async () => {
    writeMachineId()
    trackStatus = 500
    process.env.ALTIMATE_TELEMETRY_DISABLED = "1"
    await Telemetry.shutdown()
    await Telemetry.init()
    expect(await waitFor(() => trackPosts().length === 1)).toBe(true)
    const claimFile = path.join(home, ".altimate", "telemetry-opted-out.sending")
    expect(await waitFor(() => !existsSync(claimFile))).toBe(true)
    expect(OptOutMarker.exists()).toBe(false)
  })

  test("telemetry turned back on in another process stops an in-flight send from writing the marker", async () => {
    writeMachineId()
    let release: () => void = () => {}
    holdTrack = new Promise<void>((r) => (release = r))
    process.env.ALTIMATE_TELEMETRY_DISABLED = "1"
    await Telemetry.shutdown()
    await Telemetry.init()
    expect(await waitFor(() => trackPosts().length === 1)).toBe(true)
    OptOutMarker.clear() // what an enabled init in another process does
    release()
    await new Promise((r) => setTimeout(r, 100))
    expect(OptOutMarker.exists()).toBe(false)
  })

  test("an init without an Instance reads the opt-out from the command's project directory", async () => {
    writeMachineId()
    const project = mkdtempSync(path.join(os.tmpdir(), "telemetry-opt-out-project-"))
    mkdirSync(path.join(project, ".altimate-code"))
    writeFileSync(path.join(project, ".altimate-code", "altimate-code.json"), '{ "telemetry": { "disabled": true } }')
    const configSpy = spyOn(Config, "get").mockRejectedValue(new Error("InstanceRef not provided"))
    try {
      Telemetry.setConfigDirectory(project)
      await Telemetry.shutdown()
      await Telemetry.init()
      expect(Telemetry.isEnabled()).toBe(false)
      expect(await waitFor(() => optOuts().length === 1)).toBe(true)
      expect(optOuts()[0].data.baseData.properties.opt_out_source).toBe("config")
    } finally {
      Telemetry.setConfigDirectory(undefined)
      configSpy.mockRestore()
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("the marker creates a missing ~/.altimate owner-only", () => {
    expect(existsSync(path.join(home, ".altimate"))).toBe(false)
    OptOutMarker.write()
    expect(statSync(path.join(home, ".altimate")).mode & 0o777).toBe(0o700)
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
