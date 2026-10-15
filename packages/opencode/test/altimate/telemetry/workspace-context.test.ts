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

  test("a turn ends only its own entries: a cancelled turn unwinding late leaves the replacement's", () => {
    const first = Telemetry.setContext({ sessionId: "s7", projectId: "p1", workspaceId: 42 })
    Telemetry.noteWorkspaceUse("s7", "skills")
    const second = Telemetry.setContext({ sessionId: "s7", projectId: "p1", workspaceId: 42 })
    expect(second).toBeGreaterThan(first)
    Telemetry.noteWorkspaceUse("s7", "memory", 2)
    // Counts are per turn: the cancelled turn's rows read its own, the replacement's its own.
    expect(Telemetry.workspaceUseOf("s7", first)).toEqual({ skills: 1, memory: 0, integrations: 0 })
    expect(Telemetry.workspaceUseOf("s7", second)).toEqual({ skills: 0, memory: 2, integrations: 0 })
    Telemetry.endSession("s7", first) // the old generation, after the replacement started
    expect(Telemetry.workspaceOf("s7")).toBe(42)
    expect(Telemetry.workspaceUseOf("s7", first)).toEqual({ skills: 0, memory: 0, integrations: 0 })
    expect(Telemetry.workspaceUseOf("s7").memory).toBe(2)
    // A use landing with a stale turn does not count toward the replacement.
    Telemetry.noteWorkspaceUse("s7", "integrations", 1, "add", first)
    expect(Telemetry.workspaceUseOf("s7").integrations).toBe(0)
    Telemetry.noteWorkspaceUse("s7", "integrations", 1, "add", second)
    expect(Telemetry.workspaceUseOf("s7").integrations).toBe(1)
    Telemetry.endSession("s7", second)
    expect(Telemetry.workspaceOf("s7")).toBeUndefined()
    expect(Telemetry.workspaceUseOf("s7")).toEqual({ skills: 0, memory: 0, integrations: 0 })
    // Without a turn, the end is unconditional (tests and shutdown paths).
    Telemetry.setContext({ sessionId: "s7", projectId: "p1", workspaceId: 9 })
    Telemetry.endSession("s7")
    expect(Telemetry.workspaceOf("s7")).toBeUndefined()
    // Evicted and re-created entries never reuse a token a stale turn still holds.
    const stale = Telemetry.setContext({ sessionId: "s8", projectId: "p1", workspaceId: 5 })
    for (let i = 0; i < 1100; i++) Telemetry.setContext({ sessionId: `evict-${i}`, projectId: "p1" })
    expect(Telemetry.workspaceOf("s8")).toBeUndefined() // evicted
    const fresh = Telemetry.setContext({ sessionId: "s8", projectId: "p1", workspaceId: 6 })
    expect(fresh).toBeGreaterThan(stale)
    Telemetry.endSession("s8", stale)
    expect(Telemetry.workspaceOf("s8")).toBe(6)
    Telemetry.endSession("s8", fresh)
    for (let i = 0; i < 1100; i++) Telemetry.endSession(`evict-${i}`)
    Telemetry.setContext({ sessionId: "", projectId: "" })
  })

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
    // Another session's turn moves the context (a serve process) before the batch is serialised, and
    // before s1 tracks its next rows: every row still carries the workspace of its own session.
    Telemetry.setContext({ sessionId: "s2", projectId: "p1" })
    Telemetry.track(startup("unbound"))
    Telemetry.track({ type: "workspace_unlinked", timestamp: Date.now(), session_id: "s1" })
    Telemetry.track({ type: "workspace_unlinked", timestamp: Date.now(), session_id: "s2" })
    Telemetry.track({ type: "workspace_unlinked", timestamp: Date.now(), session_id: "s3" }) // never set the context
    Telemetry.setContext({ sessionId: "s4", projectId: "p1", workspaceId: 9 })
    Telemetry.track({ type: "workspace_unlinked", timestamp: Date.now(), session_id: "s2" })
    await Telemetry.flush()
    const bound = envelopes().find((e) => e.data.baseData.properties.command === "bound")
    expect(bound.data.baseData.properties.workspace_id).toBe("42")
    expect(bound.data.baseData.properties.client).toBe("altimate-code")
    const linked = envelopes().find((e) => e.data.baseData.name === "workspace_linked")
    expect(linked.data.baseData.properties.workspace_id).toBe("7") // the row's own id, not the context's
    const unlinked = envelopes().filter((e) => e.data.baseData.name === "workspace_unlinked")
    expect(unlinked.map((e) => [e.tags["ai.session.id"], e.data.baseData.properties.workspace_id])).toEqual([
      ["s1", "42"],
      ["s2", undefined],
      ["s3", undefined],
      ["s2", undefined],
    ])

    const unbound = envelopes().find((e) => e.data.baseData.properties.command === "unbound")
    expect("workspace_id" in unbound.data.baseData.properties).toBe(false)

    // One session's turn ending (endSession, and the shutdown the loop runs after it) leaves the
    // other sessions' entries alone; the ended session's later rows gain no key.
    posts = []
    Telemetry.endSession("s1")
    await Telemetry.shutdown()
    await Telemetry.init()
    expect(Telemetry.workspaceOf("s4")).toBe(9)
    expect(Telemetry.workspaceOf("s1")).toBeUndefined()
    Telemetry.track({ type: "workspace_unlinked", timestamp: Date.now(), session_id: "s4" })
    Telemetry.track({ type: "workspace_unlinked", timestamp: Date.now(), session_id: "s1" })
    await Telemetry.flush()
    const later = envelopes().filter((e) => e.data.baseData.name === "workspace_unlinked")
    expect(later.map((e) => [e.tags["ai.session.id"], e.data.baseData.properties.workspace_id])).toEqual([
      ["s4", "9"],
      ["s1", undefined],
    ])
    Telemetry.endSession("s4")
  })
})
