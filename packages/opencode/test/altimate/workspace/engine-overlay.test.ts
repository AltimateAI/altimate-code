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
  atTurnStart,
  beforeTurn,
  invalidateProbe,
  pinTurnTools,
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
  type McpEntry,
  type Toast,
} from "../../../src/altimate/workspace/engine-overlay"
import type { CachedBinding } from "../../../src/altimate/workspace/state"
import { DATAMATE_KEY } from "../../../src/altimate/datamate-transport"

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
  added: Array<LocalMcpConfig | McpEntry>
  removes: number
  gets: number
  invalidates: number
  probes: number
  toasts: Toast[]
  lines: string[]
  clock: number
  /** Whether MCP holds a client under the key — set when MCP "bootstraps" from
   * the first config load, then tracked through add/remove, as in the runtime. */
  live?: boolean
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
  managed?: boolean
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
    status: async () =>
      h.live ? { datamate: { status: h.status, ...(h.statusError ? { error: h.statusError } : {}) } } : {},
    add: async (_name, cfg) => {
      h.live = true
      h.added.push(cfg)
      h.onAdd?.()
    },
    remove: async () => {
      h.live = false
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
      if (loaded) return h.config
      h.config = opts.noMcpKey ? {} : { mcp: structuredClone(initialMcp ?? {}) }
      await overlay(DIR, h.config, { managed: opts.managed === true })
      // MCP bootstraps from the config as first loaded — after the overlay had
      // its say — and keeps whatever client that started until told otherwise.
      if (h.live === undefined) h.live = DATAMATE_KEY in (h.config.mcp ?? {})
      loaded = true
      return h.config
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

  test("a failed handshake is retried once per session, then settles connect-failed and is announced once", async () => {
    const h = install({ status: "failed", statusError: "Connection closed" })
    await beforeTurn("s1")
    expect(h.added).toHaveLength(1)
    expect(settledOutcome("s1")).toEqual({ kind: "connect-failed", error: "Connection closed" })
    expect(h.toasts).toHaveLength(1)
    expect(h.toasts[0].message).toContain("Connection closed")
    expect(h.toasts[0].message).toContain("Start a new session")
    await beforeTurn("s1")
    expect(h.added).toHaveLength(1)
    // The toast says a new session will try again, so a new session does.
    await beforeTurn("s2")
    expect(h.added).toHaveLength(2)
    expect(h.toasts).toHaveLength(2)
    await beforeTurn("s2")
    expect(h.added).toHaveLength(2)
  })

  test("overlay state is kept per directory, so one process can host two bound projects", async () => {
    const DIR_B = "/tmp/growth"
    const h = install({})
    const bindings: Record<string, CachedBinding> = { [DIR]: bound(42), [DIR_B]: bound(7, "growth") }
    syncInternals.resolveBinding = async (directory) => bindings[directory] ?? null
    const configA: { mcp?: Record<string, unknown> } = { mcp: {} }
    const configB: { mcp?: Record<string, unknown> } = { mcp: {} }
    await overlay(DIR, configA)
    await overlay(DIR_B, configB)
    expect(pinnedWorkspace(configA.mcp!.datamate as LocalMcpConfig)).toBe("42")
    expect(pinnedWorkspace(configB.mcp!.datamate as LocalMcpConfig)).toBe("7")
    expect(overlayForTests(DIR)?.workspace.id).toBe("42")
    expect(overlayForTests(DIR_B)?.workspace.id).toBe("7")
    // The writers ask for the current instance's directory.
    syncInternals.instanceDirectory = () => DIR_B
    expect(managedWorkspace()).toEqual({ id: "7", name: "growth" })
    syncInternals.instanceDirectory = () => DIR
    expect(managedWorkspace()).toEqual({ id: "42", name: "analytics" })
    // An Effect-side caller passes the instance directory explicitly.
    expect(managedWorkspace(DIR_B)).toEqual({ id: "7", name: "growth" })
    expect(managedWorkspace("/tmp/elsewhere")).toBeNull()
    // A's turn boundary sees A's overlay: nothing to reapply, no engine started for B.
    await beforeTurn("s1")
    expect(h.added).toEqual([])
    expect(settledOutcome("s1")?.kind).toBe("attached")
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
    expect(h.added).toEqual([])
    expect(h.config.mcp!.datamate).toBeUndefined()
    expect(managedWorkspace()).toBeNull()
    expect(settledOutcome("s1")).toEqual({ kind: "unbound" })
  })

  test("a client that predates a mid-session link is removed when the overlay refuses", async () => {
    // Unbound at boot with an IDE entry, so MCP bootstrapped that client. The
    // directory is then linked with no engine on PATH: the overlay refuses, and
    // the pre-link client must not go on serving the workspace under the key.
    const h = install({ binding: null, mcp: { datamate: IDE_ENTRY }, which: null })
    await beforeTurn("s1")
    expect(settledOutcome("s1")).toEqual({ kind: "unbound" })
    expect(h.removes).toBe(0)
    h.binding = bound(42)
    await beforeTurn("s1")
    expect(settledOutcome("s1")?.kind).toBe("engine-missing")
    expect(h.removes).toBe(1)
    expect(h.config.mcp!.datamate).toBeUndefined()
    await beforeTurn("s1")
    expect(h.removes).toBe(1)
  })

  test("an overlay that threw is retried at the probe TTL, not on every turn", async () => {
    // Each retry invalidates the whole config cache; a persistent fault must
    // not turn every turn boundary into a full config reload.
    const h = install({})
    syncInternals.which = () => {
      throw new Error("PATH unreadable")
    }
    await beforeTurn("s1")
    await beforeTurn("s1")
    await beforeTurn("s1")
    expect(h.invalidates).toBe(0)
    h.clock += FAILED_PROBE_TTL_MS
    await beforeTurn("s1")
    expect(h.invalidates).toBe(1)
    await beforeTurn("s1")
    expect(h.invalidates).toBe(1)
  })

  test("a datamate key set by managed preferences is left alone and is not managed here", async () => {
    const h = install({ mcp: { datamate: IDE_ENTRY }, managed: true })
    await beforeTurn("s1")
    await beforeTurn("s1")
    expect(h.config.mcp).toEqual({ datamate: IDE_ENTRY })
    expect(managedWorkspace()).toBeNull()
    expect(h.probes).toBe(0)
    // The feature is off here: no per-turn reload, no toast, nothing removed.
    expect(h.invalidates).toBe(0)
    expect(h.removes).toBe(0)
    expect(h.toasts).toEqual([])
    expect(settledOutcome("s1")).toEqual({ kind: "disabled" })
  })

  test("a transient overlay failure after attach keeps the running engine", async () => {
    const h = install({})
    // MCP bootstrapped the engine from the config as loaded; the hook adds nothing.
    await beforeTurn("s1")
    expect(h.added).toHaveLength(0)
    expect(settledOutcome("s1")?.kind).toBe("attached")
    // Something else invalidates config, and the overlay's probe now throws.
    // The usable-engine memo would mask the throw; forget it so the fault fires.
    syncInternals.which = () => {
      throw new Error("PATH unreadable")
    }
    invalidateProbe()
    await syncInternals.config!.invalidate()
    await beforeTurn("s1")
    expect(h.removes).toBe(0)
    expect(h.added).toHaveLength(0)
    expect(settledOutcome("s1")?.kind).toBe("attached")
    // The fault was real: the overlay is gone until its retry, the engine is not.
    expect(overlayForTests()).toBeNull()
    // The fault clears and the TTL passes: still the same engine, not a second one.
    h.which = "/usr/local/bin/datamate"
    syncInternals.which = () => h.which
    h.clock += FAILED_PROBE_TTL_MS
    await beforeTurn("s1")
    expect(h.added).toHaveLength(0)
    expect(h.removes).toBe(0)
    expect(settledOutcome("s1")?.kind).toBe("attached")
  })

  test("a relink whose overlay then fails releases the old workspace's engine and says so", async () => {
    // Workspace A's engine may not go on serving a directory now bound to B.
    const h = install({})
    await beforeTurn("s1")
    expect(settledOutcome("s1")?.kind).toBe("attached")
    h.binding = bound(43, "ops")
    syncInternals.which = () => {
      throw new Error("PATH unreadable")
    }
    invalidateProbe()
    await beforeTurn("s1")
    expect(h.removes).toBe(1)
    expect(h.added).toHaveLength(0)
    expect(settledOutcome("s1")?.kind).toBe("connect-failed")
    // The attach toast, then the failure's — naming the workspace now bound.
    expect(h.toasts).toHaveLength(2)
    expect(h.toasts[1].title).toContain("ops")
    expect(h.toasts[1].title).toContain("unavailable")
  })

  test("an unlink hands the key back to the entry the reloaded config restores", async () => {
    // The overlay had shadowed the user's own hosted entry; once unbound, config
    // reloads with that entry and MCP must be told to start it, because MCP only
    // enumerates live clients.
    const h = install({ mcp: { datamate: HOSTED_ENTRY } })
    await beforeTurn("s1")
    expect(pinnedWorkspace(h.config.mcp!.datamate as LocalMcpConfig)).toBe("42")
    h.binding = null
    await beforeTurn("s1")
    expect(h.removes).toBe(1)
    expect(h.added).toEqual([HOSTED_ENTRY])
    expect(h.config.mcp!.datamate).toEqual(HOSTED_ENTRY)
    expect(settledOutcome("s1")).toEqual({ kind: "unbound" })
  })

  test("an unlink after a refused overlay still hands the key back to the restored entry", async () => {
    // The overlay had removed the user's hosted entry (no engine, no fallback);
    // once unbound there is nothing to remove but the restored entry must start.
    const h = install({ which: null, mcp: { datamate: HOSTED_ENTRY } })
    await beforeTurn("s1")
    expect(settledOutcome("s1")?.kind).toBe("engine-missing")
    expect(h.config.mcp!.datamate).toBeUndefined()
    h.binding = null
    await beforeTurn("s1")
    expect(h.removes).toBe(0)
    expect(h.added).toEqual([HOSTED_ENTRY])
    expect(h.config.mcp!.datamate).toEqual(HOSTED_ENTRY)
    expect(settledOutcome("s1")).toEqual({ kind: "unbound" })
  })

  test("an unlink does not start an entry the user had disabled", async () => {
    const h = install({ mcp: { datamate: { ...HOSTED_ENTRY, enabled: false } } })
    await beforeTurn("s1")
    h.binding = null
    await beforeTurn("s1")
    expect(h.removes).toBe(1)
    expect(h.added).toEqual([])
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

  test("turn hooks for one directory run one at a time, so a re-link cannot interleave with another session's hook", async () => {
    const h = install({})
    // Session A's binding read blocks until released; a re-link lands and
    // session B's hook starts while A is inside its hook.
    let calls = 0
    let releaseA: () => void = () => {}
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    syncInternals.resolveBinding = async () => {
      calls += 1
      // The read observes the binding as it was when asked; only the delivery
      // of the answer is held back.
      const snapshot = h.binding
      if (calls === 2) await gateA
      return snapshot
    }
    const a = beforeTurn("A")
    await new Promise((r) => setTimeout(r, 5))
    h.binding = bound(7, "growth")
    const b = beforeTurn("B")
    await new Promise((r) => setTimeout(r, 5))
    // B is queued behind A: nothing has been applied for workspace 7 yet.
    expect(h.added).toEqual([])
    releaseA()
    await Promise.all([a, b])
    // A settled for the workspace it read; B's boundary then moved the engine.
    expect(h.toasts.map((t) => t.title)).toEqual(['Workspace "analytics"', 'Workspace "growth"'])
    expect(h.added).toHaveLength(1)
    expect(pinnedWorkspace(h.added[0] as LocalMcpConfig)).toBe("7")
    expect(managedWorkspace()?.id).toBe("7")
  })

  test("the lock is held through the turn's catalog, so another boundary waits for the snapshot", async () => {
    const h = install({})
    let releaseCatalog: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseCatalog = resolve
    })
    let catalogued = ""
    const a = atTurnStart("A", async () => {
      await gate
      catalogued = managedWorkspace()?.id ?? "none"
      return "A-catalog"
    })
    await new Promise((r) => setTimeout(r, 5))
    h.binding = bound(7, "growth")
    const b = beforeTurn("B")
    await new Promise((r) => setTimeout(r, 5))
    expect(h.added).toEqual([])
    releaseCatalog()
    expect(await a).toBe("A-catalog")
    await b
    // A catalogued while its own workspace was still the one applied.
    expect(catalogued).toBe("42")
    expect(managedWorkspace()?.id).toBe("7")
  })

  test("a body failure propagates to the caller but does not wedge the directory's lock", async () => {
    install({})
    await expect(
      atTurnStart("A", async () => {
        throw new Error("catalog exploded")
      }),
    ).rejects.toThrow("catalog exploded")
    await expect(atTurnStart("B", async () => "ok")).resolves.toBe("ok")
  })

  test("a turn keeps the engine tools it catalogued first for its later catalogs", async () => {
    install({})
    const first = { datamate_a: { id: "a1" }, sql_execute: { id: "sql" } }
    pinTurnTools("s1", true, first)
    // Another session's boundary replaced the engine mid-turn: step 2 re-catalogs
    // a different tool set under the same prefix.
    const later: Record<string, { id: string }> = {
      datamate_b: { id: "b1" },
      datamate_a: { id: "a2" },
      sql_execute: { id: "sql" },
    }
    pinTurnTools("s1", false, later)
    expect(later).toEqual({ sql_execute: { id: "sql" }, datamate_a: { id: "a1" } })
    // A new turn takes a fresh snapshot.
    pinTurnTools("s1", true, { datamate_b: { id: "b1" } })
    const step2: Record<string, { id: string }> = {}
    pinTurnTools("s1", false, step2)
    expect(step2).toEqual({ datamate_b: { id: "b1" } })
  })

  test("pinning is a no-op with the flag off and for a session with no step-1 snapshot", async () => {
    install({ flag: false })
    const tools: Record<string, { id: string }> = { datamate_a: { id: "a1" } }
    pinTurnTools("s1", false, tools)
    expect(tools).toEqual({ datamate_a: { id: "a1" } })
    install({})
    pinTurnTools("s9", false, tools)
    expect(tools).toEqual({ datamate_a: { id: "a1" } })
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
