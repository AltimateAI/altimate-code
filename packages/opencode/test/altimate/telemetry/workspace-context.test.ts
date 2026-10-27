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
      surface: command,
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
    const first = Telemetry.setContext({ sessionId: "s7", projectId: "p1" })
    Telemetry.noteWorkspaceUse("s7", "skills")
    const second = Telemetry.setContext({ sessionId: "s7", projectId: "p1" })
    expect(second).toBeGreaterThan(first)
    Telemetry.noteWorkspaceUse("s7", "memory", 2)
    // Counts are per turn: the cancelled turn's rows read its own, the replacement's its own.
    expect(Telemetry.workspaceUseOf("s7", first)).toEqual({ skills: 1, memory: 0, integrations: 0 })
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
    // Tokens never repeat, so a stale end can never hit a later turn.
    const stale = Telemetry.setContext({ sessionId: "s8", projectId: "p1" })
    Telemetry.endSession("s8", stale)
    const fresh = Telemetry.setContext({ sessionId: "s8", projectId: "p1" })
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
    Telemetry.setContext({ sessionId: "s1", projectId: "p1" })
    // The context holds no workspace: a row names its own.
    expect("workspaceId" in Telemetry.getContext()).toBe(false)

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

  // Every event type the workspace rows added, one each.
  const workspaceRows = (): Telemetry.Event[] => {
    const base = { timestamp: Date.now(), session_id: "s1" }
    return [
      { ...base, type: "workspace_linked", workspace_id: 1, how: "bind_existing" },
      { ...base, type: "workspace_created", workspace_id: 1, how: "create_and_bind" },
      { ...base, type: "workspace_link_failed", how: "bind_existing", reason: "auth" },
      { ...base, type: "workspace_unlinked", workspace_id: 1 },
      { ...base, type: "workspace_switched", to_workspace_id: 2, how: "rebind_remote" },
      { ...base, type: "workspace_auth_expired", endpoint: "GET /datamates/", status: 401 },
      { ...base, type: "workspace_api_error", endpoint: "GET /datamates/", status_class: "5xx", status: 500 },
      { ...base, type: "starter_shown", workspace_id: 1, knowledge: "off" },
      { ...base, type: "starter_action_picked", workspace_id: 1, action: "done" },
      { ...base, type: "workspace_memory_contributed", workspace_id: 1, block_count: 1 },
      { ...base, type: "workspace_sync_failed", workspace_id: 1, kind: "skills", reason: "network" },
      { ...base, type: "workspace_engine_attach", outcome: "attached", workspace_id: 1 },
      { ...base, type: "workspace_engine_install_prompt", action: "shown", reason: "engine-missing" },
      {
        ...base,
        type: "workspace_engine_precedence",
        enabled: true,
        shadowed_types: 0,
        shadowed_connections: 0,
        extensions: 0,
        escape_hatch: false,
      },
      { ...base, type: "workspace_engine_redirect", tool: "datamate", operation: "status", outcome: "refused" },
      { ...base, type: "workspace_engine_error", stage: "attach", message: "boom" },
    ]
  }

  test("the workspace rows are sent when telemetry is on and dropped when it is off", async () => {
    const names = workspaceRows().map((e) => e.type)
    expect(new Set(names).size).toBe(16) // plus tool_call rows, which are not new types

    await Telemetry.shutdown()
    await Telemetry.init()
    for (const row of workspaceRows()) Telemetry.track(row)
    await Telemetry.flush()
    const sent = new Set(envelopes().map((e) => e.data.baseData.name))
    for (const name of names) expect(sent.has(name)).toBe(true)

    for (const flag of DISABLE_FLAGS) {
      posts = []
      await Telemetry.shutdown()
      process.env[flag] = "1"
      await Telemetry.init()
      expect(Telemetry.isEnabled()).toBe(false)
      for (const row of workspaceRows()) Telemetry.track(row)
      await Telemetry.flush()
      expect(posts).toEqual([])
      delete process.env[flag]
    }
  })
})
