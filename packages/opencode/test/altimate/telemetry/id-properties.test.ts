import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import os from "os"
import path from "path"
import { Telemetry } from "../../../src/altimate/telemetry"

describe("numeric ids are envelope properties, not measurements", () => {
  let home: string
  let posts: string[]
  let fetchSpy: ReturnType<typeof spyOn>
  let homedirSpy: ReturnType<typeof spyOn>
  let savedCs: string | undefined
  // Either disable flag wins over the connection string, so a developer or CI environment that
  // sets one would fail the envelope assertions; cleared here and restored after.
  const DISABLE_FLAGS = ["ALTIMATE_TELEMETRY_DISABLED", "OPENCODE_DISABLE_TELEMETRY"] as const
  let savedFlags: Record<string, string | undefined>

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "telemetry-ids-"))
    savedCs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
    savedFlags = {}
    for (const flag of DISABLE_FLAGS) {
      savedFlags[flag] = process.env[flag]
      delete process.env[flag]
    }
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
      "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://ingest.example.invalid/"
    homedirSpy = spyOn(os, "homedir").mockImplementation(() => home)
    posts = []
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("/v2/track")) posts.push(String(init?.body ?? ""))
      return new Response("", { status: 200 })
    }) as any)
  })

  afterEach(async () => {
    await Telemetry.shutdown()
    fetchSpy.mockRestore()
    homedirSpy.mockRestore()
    if (savedCs === undefined) delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
    else process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = savedCs
    for (const flag of DISABLE_FLAGS) {
      if (savedFlags[flag] === undefined) delete process.env[flag]
      else process.env[flag] = savedFlags[flag]
    }
    rmSync(home, { recursive: true, force: true })
  })

  test("workspace ids ride in properties as strings; quantities stay measurements", async () => {
    await Telemetry.shutdown()
    await Telemetry.init()
    Telemetry.track({
      type: "workspace_switched",
      timestamp: Date.now(),
      session_id: "s",
      to_workspace_id: 9,
      from_workspace_id: 4,
      how: "rebind_remote",
    })
    Telemetry.track({
      type: "workspace_api_error",
      timestamp: Date.now(),
      session_id: "s",
      endpoint: "POST /datamate-project-bindings/bind",
      status_class: "4xx",
      status: 404,
      workspace_id: 42,
    })
    await Telemetry.flush()
    const envelopes = posts.flatMap((b) => JSON.parse(b) as any[])
    const switched = envelopes.find((e) => e.data.baseData.name === "workspace_switched").data.baseData
    expect(switched.properties.to_workspace_id).toBe("9")
    expect(switched.properties.from_workspace_id).toBe("4")
    expect(switched.properties.client).toBe("altimate-code")
    expect("to_workspace_id" in switched.measurements).toBe(false)
    const apiError = envelopes.find((e) => e.data.baseData.name === "workspace_api_error").data.baseData
    expect(apiError.properties.workspace_id).toBe("42")
    expect(apiError.measurements.status).toBe(404) // a quantity, still a measurement
    expect("workspace_id" in apiError.measurements).toBe(false)
  })
})
