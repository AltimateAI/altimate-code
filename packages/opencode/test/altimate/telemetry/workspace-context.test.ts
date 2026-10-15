import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import os from "os"
import path from "path"
import { Telemetry } from "../../../src/altimate/telemetry"

describe("workspace id on the telemetry context", () => {
  let home: string
  let posts: string[]
  let fetchSpy: ReturnType<typeof spyOn>
  let homedirSpy: ReturnType<typeof spyOn>
  let savedCs: string | undefined
  let savedHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "telemetry-ws-"))
    savedCs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
    savedHome = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = home
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
    if (savedHome === undefined) delete process.env.OPENCODE_TEST_HOME
    else process.env.OPENCODE_TEST_HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  })

  const envelopes = () => posts.flatMap((b) => JSON.parse(b) as any[])
  const startup = (command: string) =>
    ({
      type: "startup_ready",
      session_id: "",
      command,
      surface: command,
      duration_ms: 1,
      fresh_install: false,
      timestamp: Date.now(),
    }) as const

  test("every event of a bound session carries the workspace id; an event's own id wins; unbound sessions carry none", async () => {
    await Telemetry.shutdown()
    await Telemetry.init()
    Telemetry.setContext({ sessionId: "s1", projectId: "p1", workspaceId: 42 })
    expect(Telemetry.getContext().workspaceId).toBe(42)

    Telemetry.track(startup("bound"))
    Telemetry.track({
      type: "workspace_linked",
      timestamp: Date.now(),
      session_id: "s1",
      workspace_id: 7,
      how: "bind_existing",
    })
    await Telemetry.flush()
    const bound = envelopes().find((e) => e.data.baseData.properties.command === "bound")
    expect(bound.data.baseData.properties.workspace_id).toBe("42")
    expect(bound.data.baseData.properties.client).toBe("altimate-code")
    const linked = envelopes().find((e) => e.data.baseData.name === "workspace_linked")
    expect(linked.data.baseData.properties.workspace_id).toBe("7") // the row's own id, not the context's

    Telemetry.setContext({ sessionId: "s2", projectId: "p1" })
    Telemetry.track(startup("unbound"))
    await Telemetry.flush()
    const unbound = envelopes().find((e) => e.data.baseData.properties.command === "unbound")
    expect("workspace_id" in unbound.data.baseData.properties).toBe(false)
  })
})
