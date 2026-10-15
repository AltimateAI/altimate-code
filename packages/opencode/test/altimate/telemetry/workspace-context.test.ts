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
  // Either disable flag wins over the connection string; cleared for the real init below and restored.
  const DISABLE_FLAGS = ["ALTIMATE_TELEMETRY_DISABLED", "OPENCODE_DISABLE_TELEMETRY"] as const
  let savedFlags: Record<string, string | undefined>

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "telemetry-ws-"))
    savedCs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
    savedFlags = {}
    for (const flag of DISABLE_FLAGS) {
      savedFlags[flag] = process.env[flag]
      delete process.env[flag]
    }
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
    for (const flag of DISABLE_FLAGS) {
      if (savedFlags[flag] === undefined) delete process.env[flag]
      else process.env[flag] = savedFlags[flag]
    }
    rmSync(home, { recursive: true, force: true })
  })

  const envelopes = () => posts.flatMap((b) => JSON.parse(b) as any[])
  const startup = (command: string) =>
    ({
      type: "startup_ready",
      session_id: "",
      command,
      duration_ms: 1,
      fresh_install: false,
      timestamp: Date.now(),
    }) as const

  test("workspace use is counted per session and cleared explicitly", () => {
    Telemetry.clearWorkspaceUse("s9")
    expect(Telemetry.workspaceUseOf("s9")).toEqual({ skills: 0, memory: 0, integrations: 0 })
    Telemetry.noteWorkspaceUse("s9", "skills")
    Telemetry.noteWorkspaceUse("s9", "memory", 3)
    Telemetry.noteWorkspaceUse("s9", "integrations")
    Telemetry.noteWorkspaceUse("s9", "integrations")
    Telemetry.noteWorkspaceUse("", "skills") // no session: ignored
    Telemetry.noteWorkspaceUse("s9", "skills", 0) // nothing to count
    expect(Telemetry.workspaceUseOf("s9")).toEqual({ skills: 1, memory: 3, integrations: 2 })
    // Memory is injected on every step of a turn: "max" keeps the largest injection, not a sum.
    Telemetry.noteWorkspaceUse("s9", "memory", 2, "max")
    Telemetry.noteWorkspaceUse("s9", "memory", 5, "max")
    Telemetry.noteWorkspaceUse("s9", "memory", 4, "max")
    expect(Telemetry.workspaceUseOf("s9").memory).toBe(5)
    expect(Telemetry.workspaceUseOf("other")).toEqual({ skills: 0, memory: 0, integrations: 0 })
    Telemetry.clearWorkspaceUse("s9")
    expect(Telemetry.workspaceUseOf("s9")).toEqual({ skills: 0, memory: 0, integrations: 0 })
  })

  test("a turn ends only its own counters; a stale turn's use does not count", () => {
    const first = Telemetry.setContext({ sessionId: "s7", projectId: "p1", workspaceId: 42 })
    Telemetry.noteWorkspaceUse("s7", "skills")
    const second = Telemetry.setContext({ sessionId: "s7", projectId: "p1", workspaceId: 42 })
    expect(second).toBeGreaterThan(first)
    Telemetry.noteWorkspaceUse("s7", "memory", 2)
    // Counts are per turn: the cancelled turn's rows read its own, the replacement's its own.
    expect(Telemetry.workspaceUseOf("s7", first)).toEqual({ skills: 1, memory: 0, integrations: 0 })
    expect(Telemetry.turnWorkspaceOf("s7")).toBe(42) // an explicit lookup for in-turn emitters
    expect(Telemetry.workspaceUseOf("s7", second)).toEqual({ skills: 0, memory: 2, integrations: 0 })
    Telemetry.endSession("s7", first) // the old generation, after the replacement started
    expect(Telemetry.workspaceUseOf("s7", first)).toEqual({ skills: 0, memory: 0, integrations: 0 })
    expect(Telemetry.workspaceUseOf("s7").memory).toBe(2)
    // A use landing with a stale turn does not count toward the replacement.
    Telemetry.noteWorkspaceUse("s7", "integrations", 1, "add", first)
    expect(Telemetry.workspaceUseOf("s7").integrations).toBe(0)
    Telemetry.noteWorkspaceUse("s7", "integrations", 1, "add", second)
    expect(Telemetry.workspaceUseOf("s7").integrations).toBe(1)
    Telemetry.endSession("s7", second)
    expect(Telemetry.workspaceUseOf("s7")).toEqual({ skills: 0, memory: 0, integrations: 0 })
    expect(Telemetry.turnWorkspaceOf("s7")).toBeUndefined()
    // Tokens never repeat, so a stale end can never hit a later turn.
    const stale = Telemetry.setContext({ sessionId: "s8", projectId: "p1", workspaceId: 5 })
    Telemetry.endSession("s8", stale)
    const fresh = Telemetry.setContext({ sessionId: "s8", projectId: "p1", workspaceId: 6 })
    expect(fresh).toBeGreaterThan(stale)
    Telemetry.noteWorkspaceUse("s8", "skills")
    Telemetry.endSession("s8", stale)
    expect(Telemetry.workspaceUseOf("s8", fresh).skills).toBe(1)
    Telemetry.endSession("s8", fresh)
    Telemetry.setContext({ sessionId: "", projectId: "" })
  })

  test("a row carries the workspace it names and nothing is stamped from the context", async () => {
    await Telemetry.shutdown()
    await Telemetry.init()
    Telemetry.setContext({ sessionId: "s1", projectId: "p1", workspaceId: 42 })
    expect(Telemetry.getContext().workspaceId).toBe(42)

    Telemetry.track(startup("bound")) // names none: carries none, whatever the context holds
    Telemetry.track({
      type: "workspace_linked",
      timestamp: Date.now(),
      session_id: "s1",
      workspace_id: 7,
      how: "bind_existing",
    })
    Telemetry.track({ type: "workspace_unlinked", timestamp: Date.now(), session_id: "s1" })
    Telemetry.track({ type: "workspace_unlinked", timestamp: Date.now(), session_id: "s1", workspace_id: undefined })
    await Telemetry.flush()
    const bound = envelopes().find((e) => e.data.baseData.properties.command === "bound")
    expect("workspace_id" in bound.data.baseData.properties).toBe(false)
    expect(bound.data.baseData.properties.client).toBe("altimate-code")
    const linked = envelopes().find((e) => e.data.baseData.name === "workspace_linked")
    expect(linked.data.baseData.properties.workspace_id).toBe("7")
    const unlinked = envelopes().filter((e) => e.data.baseData.name === "workspace_unlinked")
    expect(unlinked.map((e) => e.data.baseData.properties.workspace_id)).toEqual([undefined, undefined])
    Telemetry.endSession("s1")
  })
})
