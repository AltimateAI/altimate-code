// altimate_change - new file
//
// The workspace engine overlay, end to end through its seams: what the config
// loader gets, what a turn boundary does, what the session is told. No
// instance is booted, no process spawned, no MCP state touched.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  FAILED_PROBE_TTL_MS,
  INSTALL_COMMAND,
  MAX_TRACKED_SESSIONS,
  beforeTurn,
  invalidateProbe,
  managedWorkspace,
  overlay,
  overlayForTests,
  pinnedWorkspace,
  resetForTests,
  settledOutcome,
  syncInternals,
  trackedSessionsForTests,
  type Declared,
  type LocalMcpConfig,
  type Toast,
} from "../../../src/altimate/workspace/engine-overlay"
import type { CachedBinding } from "../../../src/altimate/workspace/state"

const DIR = "/tmp/analytics"
const ORIGINAL_FLAG = process.env.ALTIMATE_WORKSPACE

const bound = (id: number, name = "analytics"): CachedBinding =>
  ({ datamateId: id, datamateName: name, repoRemote: null, projectPath: DIR, linkedAt: 0 }) as CachedBinding

type Harness = {
  config: { mcp?: Record<string, unknown> }
  binding: CachedBinding | null
  which: string | null
  version: string | null
  status: string
  statusError?: string
  onAdd?: () => void
  tools: Record<string, unknown>
  added: LocalMcpConfig[]
  removes: number
  gets: number
  invalidates: number
  probes: number
  toasts: Toast[]
  lines: string[]
  clock: number
}

function install(opts: {
  flag?: boolean
  serve?: boolean
  headless?: boolean
  binding?: CachedBinding | null
  which?: string | null
  version?: string | null
  declared?: Declared | null
  status?: string
  statusError?: string
  onAdd?: () => void
  tools?: Record<string, unknown>
  mcp?: Record<string, unknown>
  noMcpKey?: boolean
}): Harness {
  const h: Harness = {
    config: opts.noMcpKey ? {} : { mcp: opts.mcp ?? {} },
    binding: opts.binding === undefined ? bound(42) : opts.binding,
    which: opts.which === undefined ? "/usr/local/bin/datamate" : opts.which,
    version: opts.version === undefined ? "0.7.0" : opts.version,
    status: opts.status ?? "connected",
    statusError: opts.statusError,
    onAdd: opts.onAdd,
    tools: opts.tools ?? { datamate_dbt_build_model: {}, datamate_dbt_compile_model: {} },
    added: [],
    removes: 0,
    gets: 0,
    invalidates: 0,
    probes: 0,
    toasts: [],
    lines: [],
    clock: 1_000_000,
  }
  process.env.ALTIMATE_WORKSPACE = opts.flag === false ? "" : "1"
  syncInternals.serve = () => opts.serve === true
  syncInternals.headless = () => opts.headless === true
  syncInternals.instanceDirectory = () => DIR
  syncInternals.resolveBinding = async () => h.binding
  syncInternals.which = () => h.which
  syncInternals.versionOf = async () => {
    h.probes += 1
    return h.version
  }
  syncInternals.declared = async () =>
    opts.declared === undefined
      ? { keys: ["dbt_build_model", "dbt_compile_model", "dbt_execute_sql"], extensionKeys: [] }
      : opts.declared
  syncInternals.notify = async (toast) => {
    h.toasts.push(toast)
  }
  syncInternals.printLine = (line) => {
    h.lines.push(line)
  }
  syncInternals.now = () => h.clock
  syncInternals.mcp = {
    status: async () => ({ datamate: { status: h.status, ...(h.statusError ? { error: h.statusError } : {}) } }),
    add: async (_name, cfg) => {
      h.added.push(cfg)
      h.onAdd?.()
    },
    remove: async () => {
      h.removes += 1
    },
    tools: async () => h.tools,
  }
  // Models the real Config cache: `get` loads once and is then served from
  // cache until `invalidate`; a load rebuilds the config from its sources (so
  // nothing the overlay injected earlier survives a reload) and runs the overlay.
  const initialMcp = opts.mcp ? structuredClone(opts.mcp) : undefined
  let loaded = false
  syncInternals.config = {
    invalidate: async () => {
      h.invalidates += 1
      loaded = false
    },
    get: async () => {
      h.gets += 1
      if (loaded) return
      h.config = opts.noMcpKey ? {} : { mcp: structuredClone(initialMcp ?? {}) }
      await overlay(DIR, h.config)
      loaded = true
    },
  }
  return h
}

beforeEach(() => resetForTests())
afterEach(() => {
  resetForTests()
  for (const key of Object.keys(syncInternals)) delete (syncInternals as Record<string, unknown>)[key]
  if (ORIGINAL_FLAG === undefined) delete process.env.ALTIMATE_WORKSPACE
  else process.env.ALTIMATE_WORKSPACE = ORIGINAL_FLAG
})

const IDE_ENTRY = { type: "local", command: ["datamate", "start-stdio"] }
const HOSTED_ENTRY = { type: "remote", url: "https://mcpserver.example.invalid/sse" }

describe("overlay — what the config loader gets", () => {
  test("flag off leaves config.mcp untouched and nothing is managed", async () => {
    const h = install({ flag: false, mcp: { datamate: IDE_ENTRY, github: { type: "remote", url: "x" } } })
    await overlay(DIR, h.config)
    expect(h.config.mcp).toEqual({ datamate: IDE_ENTRY, github: { type: "remote", url: "x" } })
    expect(managedWorkspace()).toBeNull()
    expect(h.probes).toBe(0)
  })

  test("under serve the overlay is inert even when bound", async () => {
    const h = install({ serve: true, mcp: { datamate: IDE_ENTRY } })
    await overlay(DIR, h.config)
    expect(h.config.mcp).toEqual({ datamate: IDE_ENTRY })
    expect(managedWorkspace()).toBeNull()
  })

  test("an unbound directory leaves config.mcp untouched, including a hosted entry", async () => {
    const h = install({ binding: null, mcp: { datamate: HOSTED_ENTRY } })
    await overlay(DIR, h.config)
    expect(h.config.mcp).toEqual({ datamate: HOSTED_ENTRY })
    expect(managedWorkspace()).toBeNull()
    expect(h.probes).toBe(0)
  })

  test("an unbound directory with no mcp block gets none", async () => {
    const h = install({ binding: null, noMcpKey: true })
    await overlay(DIR, h.config)
    expect("mcp" in h.config).toBe(false)
  })

  test("a bound directory with a usable engine injects the pinned entry over an IDE entry", async () => {
    const h = install({ mcp: { datamate: IDE_ENTRY, github: { type: "remote", url: "x" } } })
    await overlay(DIR, h.config)
    const entry = h.config.mcp!.datamate as LocalMcpConfig
    expect(entry).toEqual({ type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled: true })
    expect(pinnedWorkspace(entry)).toBe("42")
    expect(h.config.mcp!.github).toEqual({ type: "remote", url: "x" })
    expect(managedWorkspace()).toEqual({ id: "42", name: "analytics" })
  })

  test("a bound directory with a usable engine replaces a hosted entry", async () => {
    const h = install({ mcp: { datamate: HOSTED_ENTRY } })
    await overlay(DIR, h.config)
    expect((h.config.mcp!.datamate as LocalMcpConfig).command).toContain("--datamate")
  })

  test("a bound directory with a usable engine creates the mcp block when there was none", async () => {
    const h = install({ noMcpKey: true })
    await overlay(DIR, h.config)
    expect(pinnedWorkspace(h.config.mcp!.datamate as LocalMcpConfig)).toBe("42")
  })

  test("a bound directory without an engine removes the key rather than falling back", async () => {
    const h = install({ which: null, mcp: { datamate: HOSTED_ENTRY, github: { type: "remote", url: "x" } } })
    await overlay(DIR, h.config)
    expect(h.config.mcp).toEqual({ github: { type: "remote", url: "x" } })
    expect(overlayForTests()?.refusal).toEqual({ kind: "engine-missing" })
    expect(managedWorkspace()).toEqual({ id: "42", name: "analytics" })
  })

  test("an engine below the floor is refused with its version; one that prints nothing is refused as broken", async () => {
    const old = install({ version: "0.6.3", mcp: { datamate: IDE_ENTRY } })
    await overlay(DIR, old.config)
    expect(old.config.mcp).toEqual({})
    expect(overlayForTests()?.refusal).toEqual({ kind: "engine-too-old", found: "0.6.3" })

    resetForTests()
    const broken = install({ version: null })
    await overlay(DIR, broken.config)
    expect(overlayForTests()?.refusal).toEqual({ kind: "engine-too-old", found: null })
  })

  test("a pre-release of the floor version does not clear it", async () => {
    const h = install({ version: "0.7.0-beta.1" })
    await overlay(DIR, h.config)
    expect(overlayForTests()?.entry).toBeNull()
  })

  test("a usable engine is probed once per process; a failed probe is asked again only after the TTL", async () => {
    const h = install({})
    await overlay(DIR, h.config)
    await overlay(DIR, h.config)
    expect(h.probes).toBe(1)

    resetForTests()
    const missing = install({ version: "0.6.3" })
    await overlay(DIR, missing.config)
    await overlay(DIR, missing.config)
    expect(missing.probes).toBe(1)
    missing.clock += FAILED_PROBE_TTL_MS
    await overlay(DIR, missing.config)
    expect(missing.probes).toBe(2)
  })

  test("a binding read that throws leaves the config as loaded", async () => {
    const h = install({ mcp: { datamate: IDE_ENTRY } })
    syncInternals.resolveBinding = async () => {
      throw new Error("cache unreadable")
    }
    await overlay(DIR, h.config)
    expect(h.config.mcp).toEqual({ datamate: IDE_ENTRY })
    expect(managedWorkspace()).toBeNull()
  })
})

describe("beforeTurn — what a turn boundary does", () => {
  test("flag off settles disabled and touches nothing", async () => {
    const h = install({ flag: false })
    await beforeTurn("s1")
    expect(settledOutcome("s1")).toEqual({ kind: "disabled" })
    expect(h.gets).toBe(0)
    expect(h.added).toEqual([])
  })

  test("settledOutcome is undefined before the first turn boundary", async () => {
    install({})
    expect(settledOutcome("never")).toBeUndefined()
  })

  test("unbound settles unbound without touching MCP", async () => {
    const h = install({ binding: null })
    await beforeTurn("s1")
    expect(settledOutcome("s1")).toEqual({ kind: "unbound" })
    expect(h.added).toEqual([])
    expect(h.removes).toBe(0)
    expect(h.toasts).toEqual([])
  })

  test("a connected engine settles attached with the inventory and announces it once", async () => {
    const h = install({})
    await beforeTurn("s1")
    expect(settledOutcome("s1")).toEqual({
      kind: "attached",
      available: 2,
      declared: 3,
      missing: ["dbt_execute_sql"],
    })
    expect(h.toasts).toHaveLength(1)
    expect(h.toasts[0].message).toContain("2 of 3 declared integration tools available")
    expect(h.toasts[0].message).toContain("dbt_execute_sql")
    // The engine was started by MCP bootstrap from the injected entry, not by the hook.
    expect(h.added).toEqual([])
    await beforeTurn("s1")
    expect(h.toasts).toHaveLength(1)
    expect(settledOutcome("s1")?.kind).toBe("attached")
  })

  test("the inventory counts declared tools that are present, not every tool the engine serves", async () => {
    const h = install({
      tools: { datamate_dbt_build_model: {}, datamate_dbt_compile_model: {}, datamate_altimate_knowledge_search: {} },
      declared: { keys: ["dbt_build_model", "dbt_compile_model"], extensionKeys: [] },
    })
    await beforeTurn("s1")
    expect(settledOutcome("s1")).toEqual({ kind: "attached", available: 3, declared: 2, missing: [] })
    expect(h.toasts[0].message).toBe("2 of 2 declared integration tools available.")
  })

  test("attached without an allowlist reports only what is available", async () => {
    const h = install({ declared: null })
    await beforeTurn("s1")
    expect(settledOutcome("s1")).toEqual({ kind: "attached", available: 2 })
    expect(h.toasts[0].message).toBe("2 integration tools available.")
  })

  test("the inventory is announced per session, not per process", async () => {
    const h = install({})
    await beforeTurn("s1")
    await beforeTurn("s2")
    expect(h.toasts).toHaveLength(2)
  })

  test("a missing engine settles engine-missing with the declared count and announces the install command once", async () => {
    const h = install({ which: null })
    await beforeTurn("s1")
    expect(settledOutcome("s1")).toEqual({ kind: "engine-missing", declared: 3 })
    expect(h.toasts).toHaveLength(1)
    expect(h.toasts[0].message).toContain("declares 3 integration tools")
    expect(h.toasts[0].message).toContain(INSTALL_COMMAND)
    expect(h.added).toEqual([])
    await beforeTurn("s1")
    expect(h.toasts).toHaveLength(1)
  })

  test("a missing engine with no reachable allowlist still names the install command", async () => {
    const h = install({ which: null, declared: null })
    await beforeTurn("s1")
    expect(settledOutcome("s1")).toEqual({ kind: "engine-missing" })
    expect(h.toasts[0].message).toContain(INSTALL_COMMAND)
  })

  test("an engine below the floor settles engine-too-old and says which version was found", async () => {
    const h = install({ version: "0.6.3" })
    await beforeTurn("s1")
    expect(settledOutcome("s1")).toEqual({ kind: "engine-too-old", found: "0.6.3" })
    expect(h.toasts[0].message).toContain("Found datamate 0.6.3")
  })

  test("headless run prints exactly one stderr line for a refusal and no toast", async () => {
    const h = install({ which: null, headless: true })
    await beforeTurn("s1")
    await beforeTurn("s1")
    expect(h.lines).toHaveLength(1)
    expect(h.lines[0]).toContain(INSTALL_COMMAND)
    expect(h.toasts).toEqual([])
  })

  test("headless run stays silent on the happy path", async () => {
    const h = install({ headless: true })
    await beforeTurn("s1")
    expect(h.lines).toEqual([])
    expect(h.toasts).toEqual([])
    expect(settledOutcome("s1")?.kind).toBe("attached")
  })

  test("a failed handshake is retried once, then settles connect-failed and is announced once", async () => {
    const h = install({ status: "failed", statusError: "Connection closed" })
    await beforeTurn("s1")
    expect(h.added).toHaveLength(1)
    expect(settledOutcome("s1")).toEqual({ kind: "connect-failed", error: "Connection closed" })
    expect(h.toasts).toHaveLength(1)
    expect(h.toasts[0].message).toContain("Connection closed")
    await beforeTurn("s1")
    await beforeTurn("s2")
    expect(h.added).toHaveLength(1)
    expect(h.toasts).toHaveLength(2)
  })

  test("a retry that succeeds settles attached", async () => {
    const h = install({ status: "failed" })
    h.onAdd = () => {
      h.status = "connected"
    }
    await beforeTurn("s1")
    expect(h.added).toHaveLength(1)
    expect(settledOutcome("s1")?.kind).toBe("attached")
  })

  test("a re-link reloads the overlay and replaces the engine for the new workspace", async () => {
    const h = install({})
    await beforeTurn("s1")
    expect(managedWorkspace()?.id).toBe("42")
    h.binding = bound(7, "growth")
    await beforeTurn("s1")
    expect(h.invalidates).toBe(1)
    expect(h.added).toHaveLength(1)
    expect(pinnedWorkspace(h.added[0])).toBe("7")
    expect(pinnedWorkspace(h.config.mcp!.datamate as LocalMcpConfig)).toBe("7")
    expect(managedWorkspace()).toEqual({ id: "7", name: "growth" })
    expect(settledOutcome("s1")?.kind).toBe("attached")
    expect(h.toasts.at(-1)?.title).toContain("growth")
  })

  test("an unlink mid-session removes the engine and settles unbound", async () => {
    const h = install({})
    await beforeTurn("s1")
    h.binding = null
    await beforeTurn("s1")
    expect(h.removes).toBe(1)
    expect(h.config.mcp!.datamate).toBeUndefined()
    expect(managedWorkspace()).toBeNull()
    expect(settledOutcome("s1")).toEqual({ kind: "unbound" })
  })

  test("an engine installed after a refusal is picked up once the probe is asked again", async () => {
    const h = install({ which: null })
    await beforeTurn("s1")
    expect(settledOutcome("s1")?.kind).toBe("engine-missing")
    h.which = "/usr/local/bin/datamate"
    // Within the TTL the failed probe is not repeated...
    await beforeTurn("s1")
    expect(settledOutcome("s1")?.kind).toBe("engine-missing")
    expect(h.added).toEqual([])
    // ...the install offer invalidates it explicitly; a later turn re-probes on its own.
    invalidateProbe()
    await beforeTurn("s1")
    expect(h.added).toHaveLength(1)
    expect(pinnedWorkspace(h.added[0])).toBe("42")
    expect(settledOutcome("s1")?.kind).toBe("attached")
  })

  test("a failed probe is repeated on its own after the TTL", async () => {
    const h = install({ version: "0.6.3" })
    await beforeTurn("s1")
    h.version = "0.7.0"
    h.clock += FAILED_PROBE_TTL_MS
    await beforeTurn("s1")
    expect(h.added).toHaveLength(1)
    expect(settledOutcome("s1")?.kind).toBe("attached")
  })

  test("the session memo is bounded", async () => {
    install({})
    for (let i = 0; i < MAX_TRACKED_SESSIONS + 10; i++) await beforeTurn(`s${i}`)
    expect(trackedSessionsForTests()).toBe(MAX_TRACKED_SESSIONS)
    expect(settledOutcome("s0")).toBeUndefined()
    expect(settledOutcome(`s${MAX_TRACKED_SESSIONS + 9}`)?.kind).toBe("attached")
  })

  test("the turn hook never throws", async () => {
    install({})
    syncInternals.config = {
      invalidate: async () => {},
      get: async () => {
        throw new Error("config exploded")
      },
    }
    await expect(beforeTurn("s1")).resolves.toBeUndefined()
  })

  test("the key stays managed while the engine is missing, so writers still refuse", async () => {
    install({ which: null })
    await beforeTurn("s1")
    expect(managedWorkspace()).toEqual({ id: "42", name: "analytics" })
  })
})
