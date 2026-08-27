// altimate_change - new file
//
// Unit coverage for the workspace → local engine attach flow. Every side
// effect goes through `syncInternals`, so this exercises the decision logic
// without booting an instance, spawning a process, or touching MCP state.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  compareVersions,
  engineToolKeys,
  ensure,
  resetForTests,
  syncInternals,
  pinnedWorkspace,
  whenAttached,
  ATTACH_WAIT_MS,
  INSTALL_HINT,
  MIN_ENGINE_VERSION,
  MAX_TRACKED_SESSIONS,
  trackedSessionsForTests,
  sessionsForTests,
  trackedChainsForTests,
  settledOutcome,
  attributableEngine,
  installWouldHelp,
  planForEntry,
  clearsFloor,
  type LocalMcpConfig,
  type Outcome,
} from "../../../src/altimate/workspace/engine-sync"
import type { CachedBinding } from "../../../src/altimate/workspace/state"
import type { ExistingEntry } from "../../../src/altimate/workspace/engine-sync"

const ORIGINAL_FLAG = process.env.ALTIMATE_WORKSPACE

const binding: CachedBinding = {
  datamateId: 42,
  datamateName: "analytics",
  repoRemote: "git@github.com:acme/analytics.git",
  projectPath: "/tmp/analytics",
} as CachedBinding

type Harness = {
  added: Array<{ name: string; cfg: LocalMcpConfig }>
  persisted: Array<{ name: string; cfg: LocalMcpConfig }>
  connects: string[]
  removes: string[]
  toasts: Array<{ title: string; message: string; variant: string }>
  toolsChanged: number
  restores: Array<unknown>
  statusQueue: Array<Record<string, { status: string; error?: string } | undefined>>
  tools: Record<string, unknown>
  spawnedNow?: ExistingEntry
}

function install(opts: {
  binding?: CachedBinding | null
  which?: string | null
  version?: string | null | ((bin: string) => string | null)
  declared?: { keys: string[]; extensionKeys: string[] } | null
  statuses?: Harness["statusQueue"]
  tools?: Record<string, unknown>
  existing?: { type?: string; url?: string; command?: string[] | string; args?: string[]; enabled?: boolean } | null
}): Harness {
  const h: Harness = {
    added: [],
    persisted: [],
    connects: [],
    removes: [],
    toasts: [],
    toolsChanged: 0,
    restores: [],
    statusQueue: opts.statuses ?? [{}],
    tools: opts.tools ?? {},
    // A configured entry that is already CONNECTED was bootstrapped from that
    // entry, which is what MCP records. A failed one has no record: production
    // only records a spawn when the client actually came up.
    spawnedNow: ((opts.statuses?.[0]?.["datamate"]?.status === "connected" ? opts.existing : undefined) ??
      undefined) as ExistingEntry | undefined,
  }
  syncInternals.resolveBinding = async () => (opts.binding === undefined ? binding : opts.binding)
  syncInternals.which = () => (opts.which === undefined ? "/usr/local/bin/datamate" : opts.which)
  syncInternals.versionOf = async (bin) => {
    if (typeof opts.version === "function") return opts.version(bin)
    return opts.version === undefined ? "0.7.0" : opts.version
  }
  syncInternals.declared = async () =>
    opts.declared === undefined ? { keys: ["dbt_build_model", "dbt_compile_model"], extensionKeys: [] } : opts.declared
  syncInternals.persist = async (name, cfg) => {
    h.persisted.push({ name, cfg })
  }
  syncInternals.existingEntry = async () => {
    if (opts.existing !== undefined) return opts.existing
    // Production persists the pinned entry before adding it, so a later read
    // sees it. Without this the harness under-reports and a legitimate memo
    // looks like a workspace change.
    const last = h.persisted[h.persisted.length - 1]
    return last ? ({ type: "local", command: last.cfg.command, enabled: true } as ExistingEntry) : null
  }
  syncInternals.notify = async (toast) => {
    h.toasts.push(toast)
  }
  syncInternals.toolsChanged = async () => {
    h.toolsChanged += 1
  }
  syncInternals.persistRestore = async (_name, previous) => {
    h.restores.push(previous ?? null)
  }
  // The project file has no entry of its own unless a test says otherwise. This
  // used to be supplied by accident: the real reader swallowed its own errors
  // and returned null, so an unstubbed harness looked like an empty project
  // file. It now throws, because "there was nothing here" and "I could not
  // look" mean opposite things to a restore.
  syncInternals.projectEntry = async () => null
  syncInternals.projectConfigPath = async () => "/tmp/test/.altimate-code/altimate-code.json"
  syncInternals.mcp = {
    status: async () => h.statusQueue.length > 1 ? h.statusQueue.shift()! : h.statusQueue[0]!,
    add: async (name, cfg) => {
      h.added.push({ name, cfg })
      h.spawnedNow = cfg as ExistingEntry
    },
    connect: async (name) => {
      h.connects.push(name)
    },
    remove: async (name) => {
      h.removes.push(name)
      h.spawnedNow = undefined
    },
    // Models MCP's own record of what it launched: whatever we last added, or —
    // when nothing was added in this process — the entry MCP bootstrapped from.
    spawned: async () => h.spawnedNow,
    tools: async () => h.tools,
  }
  return h
}

beforeEach(() => {
  process.env.ALTIMATE_WORKSPACE = "1"
  resetForTests()
})

afterEach(() => {
  for (const key of Object.keys(syncInternals) as Array<keyof typeof syncInternals>) delete syncInternals[key]
  if (ORIGINAL_FLAG === undefined) delete process.env.ALTIMATE_WORKSPACE
  else process.env.ALTIMATE_WORKSPACE = ORIGINAL_FLAG
})

describe("compareVersions", () => {
  test("orders numerically, not lexically", () => {
    expect(compareVersions("0.10.0", "0.6.3")).toBeGreaterThan(0)
    expect(compareVersions("0.6.3", "0.6.3")).toBe(0)
    expect(compareVersions("0.6.2", "0.6.3")).toBeLessThan(0)
  })
  test("tolerates a v prefix and a pre-release tag", () => {
    expect(compareVersions("v0.7.0-beta.1", "0.6.3")).toBeGreaterThan(0)
  })
  test("garbage compares as older", () => {
    expect(compareVersions("not-a-version", "0.6.3")).toBeLessThan(0)
  })
})

describe("engineToolKeys", () => {
  test("keeps only datamate_-prefixed tools and strips the prefix", () => {
    const keys = engineToolKeys({ datamate_dbt_build_model: 1, sql_execute: 1, other_x: 1 })
    expect([...keys]).toEqual(["dbt_build_model"])
  })
})

describe("ensure", () => {
  test("is inert when the pilot flag is off", async () => {
    delete process.env.ALTIMATE_WORKSPACE
    const h = install({})
    expect(await ensure("s1")).toEqual({ kind: "disabled" })
    expect(h.added).toHaveLength(0)
  })

  test("is inert with no local binding", async () => {
    const h = install({ binding: null })
    expect(await ensure("s1")).toEqual({ kind: "unbound" })
    expect(h.added).toHaveLength(0)
    expect(h.toasts).toHaveLength(0)
  })

  test("reuses a connected entry that is pinned to this workspace, without spawning", async () => {
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] },
      statuses: [{ datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1, datamate_dbt_compile_model: 1 },
    })
    expect(await ensure("s1")).toEqual({ kind: "reused", available: 2, declared: 2, missing: [] })
    expect(h.added).toHaveLength(0)
    expect(h.persisted).toHaveLength(0)
  })

  test("offers the install when no engine is on PATH — and does NOT fall back to hosted", async () => {
    const h = install({ which: null })
    expect(await ensure("s1")).toEqual({ kind: "engine-missing", declared: 2 })
    expect(h.added).toHaveLength(0)
    expect(h.persisted).toHaveLength(0)
    expect(h.toasts).toHaveLength(1)
    expect(h.toasts[0].variant).toBe("warning")
    expect(h.toasts[0].message).toContain('Workspace "analytics" declares 2 integration tools')
    expect(h.toasts[0].message).toContain(INSTALL_HINT)
  })

  test("refuses an engine below the version floor", async () => {
    const h = install({ version: "0.5.9" })
    expect(await ensure("s1")).toEqual({ kind: "engine-too-old", found: "0.5.9" })
    expect(h.added).toHaveLength(0)
  })

  test("spawns the engine pinned to the bound workspace and reports the declared-vs-delivered gap", async () => {
    const h = install({
      statuses: [{}, { datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1, sql_execute: 1 },
    })
    const outcome = await ensure("s1")
    expect(outcome).toEqual({ kind: "attached", available: 1, declared: 2, missing: ["dbt_compile_model"] })

    expect(h.persisted).toHaveLength(1)
    expect(h.added).toHaveLength(1)
    const cfg = h.added[0].cfg
    expect(h.added[0].name).toBe("datamate")
    expect(cfg.type).toBe("local")
    expect(cfg.command).toEqual(["datamate", "start-stdio", "--datamate", "42"])

    expect(h.toasts).toHaveLength(1)
    expect(h.toasts[0].variant).toBe("warning")
    expect(h.toasts[0].message).toContain("1 of 2 declared integration tools available")
    expect(h.toasts[0].message).toContain("dbt_compile_model")
  })

  test("a clean attach reports success with no gap", async () => {
    const h = install({
      statuses: [{}, { datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1, datamate_dbt_compile_model: 1 },
    })
    expect(await ensure("s1")).toEqual({ kind: "attached", available: 2, declared: 2, missing: [] })
    expect(h.toasts[0].variant).toBe("success")
  })

  test("a failed spawn is reported, never routed to hosted", async () => {
    const h = install({
      statuses: [{}, { datamate: { status: "failed", error: "spawn ENOENT" } }],
    })
    expect(await ensure("s1")).toEqual({ kind: "connect-failed", error: "spawn ENOENT" })
    // exactly one add, and it was the LOCAL spawn — no second, remote config
    expect(h.added).toHaveLength(1)
    expect(h.added[0].cfg.type).toBe("local")
    expect(h.toasts).toHaveLength(1)
    expect(h.toasts[0].variant).toBe("error")
    expect(h.toasts[0].message).toContain("not falling back to the hosted endpoint")
  })

  test("a down COMMAND entry that is OURS is retried once, then reported — never double-spawned", async () => {
    // Reviving is for our own engine. The entry must be pinned to this
    // workspace to reach the retry at all — see the wedge test below.
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] },
      statuses: [{ datamate: { status: "failed", error: "exit 1" } }, { datamate: { status: "failed", error: "exit 1" } }],
    })
    expect(await ensure("s1")).toEqual({ kind: "connect-failed", error: "exit 1" })
    // Revived with `add`, never `connect`: connect writes `enabled: true` into
    // whichever config owns the entry, turning a local repair into a global
    // config write. One restart attempt, and nothing persisted.
    expect(h.connects, "used the config-writing primitive to repair").toHaveLength(0)
    expect(h.added).toHaveLength(1)
    expect(h.persisted).toHaveLength(0)
  })

  test("a down entry pinned ELSEWHERE is replaced, never revived — this is the wedge", async () => {
    // With connectivity above attribution this could not clear: the retry
    // answered before the pin was ever consulted, so an entry pinned to a
    // workspace the project no longer holds was retried every turn, reported
    // `connect-failed` every turn, and never replaced — the project sat wedged
    // until someone edited config by hand.
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "9"] },
      statuses: [{ datamate: { status: "failed", error: "exit 1" } }, { datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1, datamate_dbt_compile_model: 1 },
    })
    expect(await ensure("s1")).toMatchObject({ kind: "attached" })
    expect(h.connects, "revived an engine belonging to another workspace").toHaveLength(0)
    expect(h.added, "did not replace the unattributable entry").toHaveLength(1)
  })

  test("a dead URL entry (IDE engine not running) is replaced by a local spawn, and the replacement is reported", async () => {
    const h = install({
      existing: { type: "remote", url: "http://localhost:7801/sse" },
      statuses: [
        { datamate: { status: "failed", error: "SSE error: Unable to connect" } },
        { datamate: { status: "connected" } },
      ],
      tools: { datamate_dbt_build_model: 1, datamate_dbt_compile_model: 1 },
    })
    const outcome = await ensure("s1")
    expect(outcome).toEqual({
      kind: "attached",
      available: 2,
      declared: 2,
      missing: [],
      replaced: "http://localhost:7801/sse",
    })
    expect(h.connects).toHaveLength(0) // no pointless retry of a dead port
    expect(h.removes).toHaveLength(0) // a dead URL has nothing live to close
    expect(h.added).toHaveLength(1)
    expect(h.added[0].cfg.command).toEqual(["datamate", "start-stdio", "--datamate", "42"])
    expect(h.toasts[0].message).toContain("Replaced the unreachable engine URL http://localhost:7801/sse")
  })

  test("is idempotent per session", async () => {
    const h = install({
      statuses: [{}, { datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1, datamate_dbt_compile_model: 1 },
    })
    const first = await ensure("s1")
    const second = await ensure("s1")
    expect(second).toBe(first)
    expect(h.added).toHaveLength(1)
  })
})

describe("whenAttached", () => {
  test("the cap stays well under MCP's own connect timeout", () => {
    // A turn must never inherit MCP's 30s connect budget; past this cap the
    // tools arrive over `tools/list_changed` instead.
    expect(ATTACH_WAIT_MS).toBeLessThan(30_000)
  })

  test("does not wait when no attach was started for the session", async () => {
    install({})
    const started = performance.now()
    await whenAttached("never-ensured", 1_000)
    expect(performance.now() - started).toBeLessThan(50)
  })

  test("returns once a fresh attach has landed, so its tools make this turn", async () => {
    const h = install({ tools: { datamate_dbt_build_model: 1, datamate_dbt_compile_model: 1 } })
    void ensure("s1")
    const started = performance.now()
    await whenAttached("s1", 5_000)
    expect(performance.now() - started).toBeLessThan(1_000)
    // The engine is connected by the time the caller resolves its tool list.
    expect(h.added).toHaveLength(1)
    expect(engineToolKeys(h.tools).size).toBe(2)
  })

  test("an unbound session settles without waiting", async () => {
    install({ binding: null })
    void ensure("s1")
    const started = performance.now()
    await whenAttached("s1", 5_000)
    expect(performance.now() - started).toBeLessThan(50)
  })

  test("a disabled session settles without waiting", async () => {
    delete process.env.ALTIMATE_WORKSPACE
    install({})
    void ensure("s1")
    const started = performance.now()
    await whenAttached("s1", 5_000)
    expect(performance.now() - started).toBeLessThan(50)
  })

  test("gives up after the cap, and later turns in the session do not pay it again", async () => {
    install({})
    // An engine that never answers: the attach promise stays pending for MCP's
    // full connect budget, which no turn may inherit.
    syncInternals.versionOf = () => new Promise<string | null>(() => {})
    void ensure("s1")

    const first = performance.now()
    await whenAttached("s1", 25)
    expect(performance.now() - first).toBeGreaterThanOrEqual(20)

    // Every user turn runs the same block; only the first one waits.
    const second = performance.now()
    await whenAttached("s1", 5_000)
    expect(performance.now() - second).toBeLessThan(50)
  })
})

describe("pinnedWorkspace", () => {
  test("reads the pin from opencode's argv shape", () => {
    expect(pinnedWorkspace({ type: "local", command: ["datamate", "start-stdio", "--datamate", "5"] })).toBe("5")
  })
  test("reads the pin from the IDE's { command, args } shape", () => {
    expect(pinnedWorkspace({ command: "datamate", args: ["start-stdio", "--datamate", "5"] })).toBe("5")
  })
  test("accepts the --datamate=5 spelling", () => {
    expect(pinnedWorkspace({ type: "local", command: ["datamate", "start-stdio", "--datamate=5"] })).toBe("5")
  })
  test("a repeated flag resolves last-wins, as the engine's CLI does", () => {
    expect(
      pinnedWorkspace({ type: "local", command: ["datamate", "--datamate", "5", "--datamate", "9"] }),
    ).toBe("9")
  })
  test("an entry with no pin is not attributable — this is what the extension writes", () => {
    expect(pinnedWorkspace({ command: "datamate", args: ["start-stdio"] })).toBeNull()
    expect(pinnedWorkspace({ type: "local", command: ["datamate", "start-stdio"] })).toBeNull()
  })
  test("a URL entry pins nothing, and a missing entry is not attributable", () => {
    expect(pinnedWorkspace({ type: "remote", url: "http://localhost:7801/sse" })).toBeNull()
    expect(pinnedWorkspace(null)).toBeNull()
  })
  test("a dangling --datamate with no value is not a pin", () => {
    expect(pinnedWorkspace({ type: "local", command: ["datamate", "start-stdio", "--datamate"] })).toBeNull()
  })
})

describe("ensure — attribution of a CONNECTED entry", () => {
  const liveTwice: Harness["statusQueue"] = [
    { datamate: { status: "connected" } },
    { datamate: { status: "connected" } },
  ]
  const twoTools = { datamate_dbt_build_model: 1, datamate_dbt_compile_model: 1 }

  test("an UNPINNED entry is replaced by a pinned spawn — this is the extension's entry", async () => {
    const h = install({
      existing: { command: "datamate", args: ["start-stdio"] },
      statuses: liveTwice,
      tools: twoTools,
    })
    const outcome = await ensure("s1")
    expect(outcome).toEqual({
      kind: "attached",
      available: 2,
      declared: 2,
      missing: [],
      replaced: "datamate start-stdio",
    })
    // The replacement is a pinned spawn, so the engine we end up on is ours.
    expect(h.added[0].cfg.command).toEqual(["datamate", "start-stdio", "--datamate", "42"])
    // ...and the live one it displaced was torn down first. `MCP.add` does not
    // close the client it overwrites, so skipping this orphans a second live
    // engine. It must be `remove` (runtime-only), never `disconnect`, which
    // would persist `enabled: false` into the config that owns the entry.
    expect(h.removes).toEqual(["datamate"])
    expect(h.toasts[0].message).toContain("not pinned to this workspace")
  })

  test("an entry pinned to ANOTHER workspace is replaced, and says which", async () => {
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "7"] },
      statuses: liveTwice,
      tools: twoTools,
    })
    const outcome = await ensure("s1")
    expect(outcome).toMatchObject({ kind: "attached", replaced: "datamate start-stdio --datamate 7" })
    expect(h.added[0].cfg.command).toEqual(["datamate", "start-stdio", "--datamate", "42"])
    expect(h.toasts[0].message).toContain("pinned to workspace 7")
  })

  test("a CONNECTED url entry is replaced too — rule 4 forbids adopting hosted", async () => {
    const h = install({
      existing: { type: "remote", url: "https://api.altimate.ai/sse" },
      statuses: liveTwice,
      tools: twoTools,
    })
    const outcome = await ensure("s1")
    expect(outcome).toMatchObject({ kind: "attached", replaced: "https://api.altimate.ai/sse" })
    expect(h.added[0].cfg.type).toBe("local")
  })

  test("a matching pin is reused — no spawn, no persist", async () => {
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] },
      statuses: [{ datamate: { status: "connected" } }],
      tools: twoTools,
    })
    expect(await ensure("s1")).toEqual({ kind: "reused", available: 2, declared: 2, missing: [] })
    expect(h.added).toHaveLength(0)
    expect(h.persisted).toHaveLength(0)
    expect(h.removes).toHaveLength(0) // reuse must never tear down what it reuses
  })

  test("a down UNPINNED entry is replaced without being revived first", async () => {
    // It was previously retried back to life and only then judged unattributable
    // and replaced — a spawn spent on a process we were always going to discard.
    // Attribution above connectivity means we never start it.
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio"] },
      statuses: [
        { datamate: { status: "failed", error: "exit 1" } },
        { datamate: { status: "connected" } },
        { datamate: { status: "connected" } },
      ],
      tools: twoTools,
    })
    const outcome = await ensure("s1")
    expect(h.connects, "revived an entry it was going to replace anyway").toHaveLength(0)
    expect(outcome).toMatchObject({ kind: "attached", replaced: "datamate start-stdio" })
  })
})

describe("ensure — the version floor applies to a REUSED entry", () => {
  test("a pinned entry below the floor is replaced when PATH has a newer engine", async () => {
    const h = install({
      existing: { type: "local", command: ["/opt/old/datamate", "start-stdio", "--datamate", "42"] },
      statuses: [{ datamate: { status: "connected" } }, { datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1, datamate_dbt_compile_model: 1 },
      version: (bin) => (bin === "/opt/old/datamate" ? "0.6.3" : "0.7.0"),
    })
    const outcome = await ensure("s1")
    expect(outcome).toMatchObject({
      kind: "attached",
      replaced: "/opt/old/datamate start-stdio --datamate 42",
    })
    expect(h.added[0].cfg.command).toEqual(["datamate", "start-stdio", "--datamate", "42"])
  })

  test("a pinned entry below the floor with nothing newer on PATH is reported, not reused", async () => {
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] },
      statuses: [{ datamate: { status: "connected" } }],
      version: () => "0.6.3",
    })
    expect(await ensure("s1")).toEqual({ kind: "engine-too-old", found: "0.6.3" })
    expect(h.added).toHaveLength(0)
    expect(h.persisted).toHaveLength(0)
    expect(h.toasts[0].message).toContain(MIN_ENGINE_VERSION)
  })

  test("an entry whose binary reports no version is not trusted for reuse", async () => {
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] },
      statuses: [{ datamate: { status: "connected" } }],
      version: () => null,
    })
    expect(await ensure("s1")).toEqual({ kind: "engine-too-old", found: "unknown" })
    expect(h.added).toHaveLength(0)
  })
})

describe("compareVersions — pre-release precedence (SemVer §11.3)", () => {
  test("a pre-release of the floor version does NOT clear the floor", () => {
    // The floor exists to require behaviour that shipped in a release; a
    // pre-release of that version predates it, so it must rank below.
    expect(compareVersions("0.7.0-beta.1", "0.7.0")).toBeLessThan(0)
    expect(compareVersions("0.7.0", "0.7.0-beta.1")).toBeGreaterThan(0)
    expect(compareVersions("0.7.0-beta.1", MIN_ENGINE_VERSION)).toBeLessThan(0)
  })
  test("identifiers order by SemVer rules", () => {
    expect(compareVersions("0.7.0-alpha", "0.7.0-beta")).toBeLessThan(0)
    expect(compareVersions("0.7.0-beta.2", "0.7.0-beta.10")).toBeLessThan(0) // numeric, not lexical
    expect(compareVersions("0.7.0-alpha", "0.7.0-alpha.1")).toBeLessThan(0) // fewer fields rank lower
    expect(compareVersions("0.7.0-alpha.1", "0.7.0-alpha.beta")).toBeLessThan(0) // numeric < alphanumeric
    expect(compareVersions("0.7.0-beta.1", "0.7.0-beta.1")).toBe(0)
  })
  test("build metadata is ignored", () => {
    expect(compareVersions("0.7.0+build.5", "0.7.0")).toBe(0)
    expect(compareVersions("0.8.0+x", "0.7.0")).toBeGreaterThan(0)
  })
  test("a release still outranks an older release", () => {
    expect(compareVersions("0.7.1", "0.7.0")).toBeGreaterThan(0)
    expect(compareVersions("0.6.9", "0.7.0")).toBeLessThan(0)
  })
})

describe("ensure — pre-release engines are refused", () => {
  test("an engine reporting a pre-release of the floor is too old", async () => {
    const h = install({ version: "0.7.0-beta.1" })
    expect(await ensure("s1")).toEqual({ kind: "engine-too-old", found: "0.7.0-beta.1" })
    expect(h.added).toHaveLength(0)
    expect(h.persisted).toHaveLength(0)
  })
})

describe("ensure — the memo follows the BINDING, not just the session id", () => {
  const spawnTwice: Harness["statusQueue"] = [
    {},
    { datamate: { status: "connected" } },
    {},
    { datamate: { status: "connected" } },
  ]

  test("a re-link mid-session attaches the NEW workspace", async () => {
    // recordApprovedBinding is reachable mid-session from the TUI workspace
    // panel, so a live session's binding really can change under it.
    let current: CachedBinding | null = binding // datamate 42
    const h = install({ statuses: spawnTwice, tools: { datamate_dbt_build_model: 1 } })
    syncInternals.resolveBinding = async () => current

    const first = await ensure("s1")
    expect(first).toMatchObject({ kind: "attached" })
    expect(h.added[0].cfg.command).toEqual(["datamate", "start-stdio", "--datamate", "42"])

    current = { ...binding, datamateId: 99, datamateName: "other" } as CachedBinding
    const second = await ensure("s1")
    expect(second).toMatchObject({ kind: "attached" })
    expect(h.added).toHaveLength(2)
    expect(h.added[1].cfg.command).toEqual(["datamate", "start-stdio", "--datamate", "99"])
  })

  test("a session that starts UNBOUND attaches once the project is linked", async () => {
    let current: CachedBinding | null = null
    const h = install({ statuses: spawnTwice, tools: { datamate_dbt_build_model: 1 } })
    syncInternals.resolveBinding = async () => current

    expect(await ensure("s1")).toEqual({ kind: "unbound" })
    expect(h.added).toHaveLength(0)

    current = binding
    expect(await ensure("s1")).toMatchObject({ kind: "attached" })
    expect(h.added).toHaveLength(1)
  })

  test("an unchanged binding is still memoised — no second attach per turn", async () => {
    const h = install({
      statuses: [{}, { datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1 },
    })
    const first = await ensure("s1")
    const second = await ensure("s1")
    const third = await ensure("s1")
    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(h.added).toHaveLength(1)
    expect(h.persisted).toHaveLength(1)
  })

  test("registration is SYNCHRONOUS, so whenAttached on the next line sees it", async () => {
    // ensure() must not await before registering: prompt.ts calls whenAttached
    // immediately after, and a late registration would make the turn skip the
    // wait entirely — the exact first-turn gap this module closes.
    const h = install({ tools: { datamate_dbt_build_model: 1 } })
    syncInternals.versionOf = () => new Promise<string | null>(() => {}) // never settles
    void ensure("s1")
    const started = performance.now()
    await whenAttached("s1", 30)
    expect(performance.now() - started).toBeGreaterThanOrEqual(20)
    expect(h).toBeDefined()
  })
})

describe("ensure — a REJECTED engine is detached even when it cannot be replaced", () => {
  const liveUnpinned = { type: "local", command: ["datamate", "start-stdio"] }

  test("no engine on PATH: still detaches, so resolveTools cannot serve the wrong workspace", async () => {
    const h = install({
      existing: liveUnpinned,
      statuses: [{ datamate: { status: "connected" } }],
      which: null,
      tools: { datamate_dbt_build_model: 1 },
    })
    expect(await ensure("s1")).toEqual({ kind: "engine-missing", declared: 2 })
    // The whole point: we judged it untrustworthy, so it must not still be serving.
    expect(h.removes).toEqual(["datamate"])
    expect(h.added).toHaveLength(0)
  })

  test("PATH engine below the floor: still detaches before reporting too-old", async () => {
    const h = install({
      existing: liveUnpinned,
      statuses: [{ datamate: { status: "connected" } }],
      version: "0.5.9",
      tools: { datamate_dbt_build_model: 1 },
    })
    expect(await ensure("s1")).toEqual({ kind: "engine-too-old", found: "0.5.9" })
    expect(h.removes).toEqual(["datamate"])
    expect(h.added).toHaveLength(0)
  })

  test("a pinned-but-below-floor engine with nothing better is detached, not left serving", async () => {
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] },
      statuses: [{ datamate: { status: "connected" } }],
      version: () => "0.6.3",
      tools: { datamate_dbt_build_model: 1 },
    })
    expect(await ensure("s1")).toEqual({ kind: "engine-too-old", found: "0.6.3" })
    expect(h.removes).toEqual(["datamate"])
  })
})

describe("ensure — reuse reports the declared-vs-delivered gap (rule 5)", () => {
  test("a reused engine missing a declared tool warns, and the outcome carries the gap", async () => {
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] },
      statuses: [{ datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1 }, // declared has two keys
    })
    expect(await ensure("s1")).toEqual({
      kind: "reused",
      available: 1,
      declared: 2,
      missing: ["dbt_compile_model"],
    })
    expect(h.toasts).toHaveLength(1)
    expect(h.toasts[0].variant).toBe("warning")
    expect(h.toasts[0].message).toContain("1 of 2 declared integration tools")
    expect(h.toasts[0].message).toContain("dbt_compile_model")
  })

  test("no gap means no toast", async () => {
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] },
      statuses: [{ datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1, datamate_dbt_compile_model: 1 },
    })
    expect(await ensure("s1")).toMatchObject({ kind: "reused", missing: [] })
    expect(h.toasts).toHaveLength(0)
  })

  test("an unreadable allowlist degrades quietly rather than inventing a gap", async () => {
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] },
      statuses: [{ datamate: { status: "connected" } }],
      declared: null,
      tools: { datamate_dbt_build_model: 1 },
    })
    expect(await ensure("s1")).toEqual({ kind: "reused", available: 1 })
    expect(h.toasts).toHaveLength(0)
  })
})

describe("ensure — an unbound project does not keep a stale MANAGED entry", () => {
  test("a pinned entry is LEFT ALONE when the binding is gone — argv is not provenance", async () => {
    // Reversed deliberately in round 5: a hand-authored entry is byte-identical
    // to one we wrote, so tearing it down would take the user's server offline.
    const h = install({
      binding: null,
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "5"] },
      statuses: [{ datamate: { status: "connected" } }],
    })
    expect(await ensure("s1")).toEqual({ kind: "unbound" })
    expect(h.removes).toHaveLength(0)
  })

  test("an IDE-written entry is LEFT ALONE — it is the user's, not ours", async () => {
    const h = install({
      binding: null,
      existing: { command: "datamate", args: ["start-stdio"] },
      statuses: [{ datamate: { status: "connected" } }],
    })
    expect(await ensure("s1")).toEqual({ kind: "unbound" })
    expect(h.removes).toHaveLength(0)
  })

  test("nothing registered means nothing to detach", async () => {
    const h = install({ binding: null, statuses: [{}] })
    expect(await ensure("s1")).toEqual({ kind: "unbound" })
    expect(h.removes).toHaveLength(0)
    expect(h.toasts).toHaveLength(0)
  })
})

describe("ensure — a repairable failure is re-probed on the next turn", () => {
  test("engine-missing is retried once the engine appears, without a new session", async () => {
    let onPath: string | null = null
    const h = install({
      statuses: [{}, { datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1, datamate_dbt_compile_model: 1 },
    })
    syncInternals.which = () => onPath

    // Turn 1: no engine. We print the install hint.
    expect(await ensure("s1")).toEqual({ kind: "engine-missing", declared: 2 })
    expect(h.added).toHaveLength(0)

    // The user follows that hint mid-session.
    onPath = "/usr/local/bin/datamate"
    expect(await ensure("s1")).toMatchObject({ kind: "attached" })
    expect(h.added).toHaveLength(1)
  })

  test("engine-too-old is retried after an update", async () => {
    let version = "0.5.9"
    const h = install({
      statuses: [{}, { datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1, datamate_dbt_compile_model: 1 },
    })
    syncInternals.versionOf = async () => version

    expect(await ensure("s1")).toEqual({ kind: "engine-too-old", found: "0.5.9" })
    version = "0.7.0"
    expect(await ensure("s1")).toMatchObject({ kind: "attached" })
    expect(h.added).toHaveLength(1)
  })

  test("a SUCCESSFUL outcome is still memoised — retry must not mean re-attach every turn", async () => {
    const h = install({
      statuses: [{}, { datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1, datamate_dbt_compile_model: 1 },
    })
    const first = await ensure("s1")
    expect(first).toMatchObject({ kind: "attached" })
    expect(await ensure("s1")).toBe(first)
    expect(await ensure("s1")).toBe(first)
    expect(h.added).toHaveLength(1)
  })

  test("a repairable retry does not re-arm the turn wait, even when the retry HANGS", async () => {
    // The earlier version of this test let the retry settle immediately, so
    // whenAttached returned on settle and the test passed whatever the flag
    // said. The retry must hang for the flag to be the thing under test.
    let onPath: string | null = null
    install({})
    syncInternals.which = () => onPath
    expect(await ensure("s1")).toEqual({ kind: "engine-missing", declared: 2 })

    onPath = "/usr/local/bin/datamate"
    syncInternals.versionOf = () => new Promise<string | null>(() => {}) // never settles
    void ensure("s1")
    const started = performance.now()
    await whenAttached("s1", 5_000)
    expect(performance.now() - started).toBeLessThan(150)
  })
})

describe("ensure — the version probe targets the engine, not its wrapper", () => {
  test("an npx-wrapped entry is not trusted on the wrapper's version", async () => {
    const probed: string[] = []
    const h = install({
      existing: { type: "local", command: ["npx", "@altimateai/datamate@0.6.3", "start-stdio", "--datamate", "42"] },
      statuses: [{ datamate: { status: "connected" } }, { datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1, datamate_dbt_compile_model: 1 },
    })
    syncInternals.versionOf = async (bin) => {
      probed.push(bin)
      return "0.7.0"
    }
    const outcome = await ensure("s1")
    // npx is never probed — a modern wrapper must not vouch for an old engine.
    expect(probed).not.toContain("npx")
    // Unverifiable, so it is replaced by a pinned spawn we can vouch for.
    expect(outcome).toMatchObject({ kind: "attached" })
    expect(h.removes).toEqual(["datamate"])
    expect(h.added[0].cfg.command).toEqual(["datamate", "start-stdio", "--datamate", "42"])
  })

  test("an absolute path to a real datamate IS probed and reused", async () => {
    const probed: string[] = []
    const h = install({
      existing: { type: "local", command: ["/opt/bin/datamate", "start-stdio", "--datamate", "42"] },
      statuses: [{ datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1, datamate_dbt_compile_model: 1 },
    })
    syncInternals.versionOf = async (bin) => {
      probed.push(bin)
      return "0.7.0"
    }
    expect(await ensure("s1")).toMatchObject({ kind: "reused" })
    expect(probed).toContain("/opt/bin/datamate")
    expect(h.added).toHaveLength(0)
  })
})

describe("ensure — a superseded attach cannot overwrite the current one", () => {
  test("the re-linked workspace wins even when the old attach is slower", async () => {
    let current: CachedBinding | null = binding // 42
    const h = install({
      statuses: [
        {},
        { datamate: { status: "connected" } },
        {},
        { datamate: { status: "connected" } },
      ],
      tools: { datamate_dbt_build_model: 1 },
    })
    syncInternals.resolveBinding = async () => current
    // Make the FIRST attach slow, so without serialization it would land last.
    let firstAdd = true
    syncInternals.mcp!.add = async (name, cfg) => {
      if (firstAdd) {
        firstAdd = false
        await new Promise((r) => setTimeout(r, 60))
      }
      h.added.push({ name, cfg })
    }

    const a = ensure("s1") // workspace 42
    current = { ...binding, datamateId: 99, datamateName: "other" } as CachedBinding
    const b = ensure("s1") // re-link to 99
    await Promise.all([a, b])

    // Both ran, but in order: the LAST add must be the workspace we re-linked to.
    expect(h.added).toHaveLength(2)
    expect(h.added[h.added.length - 1].cfg.command).toEqual(["datamate", "start-stdio", "--datamate", "99"])
  })
})

describe("ensure — round 4", () => {
  test("an explicitly disabled entry is respected, never silently re-enabled", async () => {
    // MCP.connect persists `enabled: true` into whichever config owns the entry,
    // so retrying a DISABLED entry would undo a deliberate global disable for
    // every other project.
    const h = install({
      // A real user disable is `enabled: false` in the config. The runtime
      // status alone is not evidence of intent — see the round-5 test below.
      existing: { type: "local", command: ["datamate", "start-stdio"], enabled: false },
      statuses: [{ datamate: { status: "disabled" } }],
    })
    expect(await ensure("s1")).toEqual({ kind: "entry-disabled" })
    expect(h.connects).toHaveLength(0)
    expect(h.added).toHaveLength(0)
    expect(h.persisted).toHaveLength(0)
  })

  test("a genuinely FAILED entry that is OURS is still retried once", async () => {
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] },
      statuses: [
        { datamate: { status: "failed", error: "exit 1" } },
        { datamate: { status: "failed", error: "exit 1" } },
      ],
    })
    expect(await ensure("s1")).toEqual({ kind: "connect-failed", error: "exit 1" })
    expect(h.connects, "used the config-writing primitive to repair").toHaveLength(0)
    expect(h.added).toHaveLength(1)
  })

  test("two overlapping SESSIONS in one project never attach concurrently", async () => {
    // MCP state is instance-wide and MCP.add is last-writer-wins, while
    // SessionRunState keeps independent runners per session id — so per-session
    // ordering is not enough. The invariant is that no two attaches for the same
    // project are ever in their mutating phase at the same time.
    const h = install({
      statuses: [{}, { datamate: { status: "connected" } }, {}, { datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1 },
    })
    let inFlight = 0
    let peak = 0
    syncInternals.mcp!.add = async (name, cfg) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 40))
      h.added.push({ name, cfg })
      inFlight -= 1
    }

    await Promise.all([ensure("sessionA"), ensure("sessionB")])

    expect(h.added).toHaveLength(2)
    expect(peak).toBe(1) // 2 without project-scoped serialization
  })
})

describe("ensure — round 5", () => {
  test("a REMOVED entry is not mistaken for a user disable — repair still works", async () => {
    // MCP.remove deletes s.status[name], and MCP.status() reports a configured
    // entry with no status as "disabled". Reading that as user intent made every
    // turn after a rejection teardown return entry-disabled, permanently —
    // silently undoing the repairable-retry fix from the previous round.
    let onPath: string | null = null
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio"] }, // unpinned -> rejected
      statuses: [
        { datamate: { status: "connected" } },
        { datamate: { status: "disabled" } }, // synthesized after remove
        { datamate: { status: "connected" } },
        { datamate: { status: "connected" } },
      ],
      tools: { datamate_dbt_build_model: 1, datamate_dbt_compile_model: 1 },
    })
    syncInternals.which = () => onPath

    // Turn 1: rejected and torn down, and no engine to replace it with.
    expect(await ensure("s1")).toEqual({ kind: "engine-missing", declared: 2 })
    expect(h.removes).toEqual(["datamate"])

    // The user installs the engine and takes another turn.
    onPath = "/usr/local/bin/datamate"
    const second = await ensure("s1")
    expect(second).not.toEqual({ kind: "entry-disabled" })
    expect(second).toMatchObject({ kind: "attached" })
    expect(h.added[h.added.length - 1].cfg.command).toEqual(["datamate", "start-stdio", "--datamate", "42"])
  })

  test("an unbound project does NOT tear down an entry it cannot prove it owns", async () => {
    // argv shape is not provenance: a hand-authored entry looks identical to ours.
    const h = install({
      binding: null,
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "5"] },
      statuses: [{ datamate: { status: "connected" } }],
    })
    expect(await ensure("s1")).toEqual({ kind: "unbound" })
    expect(h.removes).toHaveLength(0) // the user's server stays up
  })

  test("the session map does not grow without bound", async () => {
    install({ binding: null })
    for (let i = 0; i < MAX_TRACKED_SESSIONS + 25; i++) await ensure(`s${i}`)
    expect(trackedSessionsForTests()).toBeLessThanOrEqual(MAX_TRACKED_SESSIONS)
  })
})

describe("ensure — round 6: a stale binding must not be installed", () => {
  test("a re-link DURING an attach abandons it instead of installing the old workspace", async () => {
    // run() snapshots the binding, then spends seconds in status, version and
    // API work before persisting. A re-link inside that window used to install
    // the workspace the session had already left.
    let current: CachedBinding | null = binding // 42
    const h = install({
      statuses: [{}, { datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1 },
    })
    syncInternals.resolveBinding = async () => current
    // The re-link lands while the attach is in its slow phase.
    syncInternals.declared = async () => {
      current = { ...binding, datamateId: 99, datamateName: "other" } as CachedBinding
      return { keys: ["dbt_build_model", "dbt_compile_model"], extensionKeys: [] }
    }

    expect(await ensure("s1")).toEqual({ kind: "superseded" })
    // The decisive assertion: workspace 42's engine is never installed.
    expect(h.added).toHaveLength(0)
    expect(h.persisted).toHaveLength(0)
  })

  test("an unchanged binding still attaches normally", async () => {
    const h = install({
      statuses: [{}, { datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1, datamate_dbt_compile_model: 1 },
    })
    expect(await ensure("s1")).toMatchObject({ kind: "attached" })
    expect(h.added[0].cfg.command).toEqual(["datamate", "start-stdio", "--datamate", "42"])
  })
})

describe("ensure — round 7", () => {
  test("an unexpected attach error still tells the user", async () => {
    // Every explicit failure branch notifies; an unexpected throw must not be
    // the one path that leaves the user with neither tools nor an explanation.
    const h = install({ statuses: [{}] })
    syncInternals.persist = async () => {
      throw new Error("EACCES: project config is not writable")
    }
    const outcome = await ensure("s1")
    expect(outcome).toMatchObject({ kind: "connect-failed" })
    expect(h.toasts).toHaveLength(1)
    expect(h.toasts[0].variant).toBe("error")
    expect(h.toasts[0].message).toContain("EACCES")
  })
})

describe("ensure — round 8", () => {
  test("a malformed core is refused, not treated as equal to the floor", () => {
    // parseInt("7rc") is 7, so "0.7rc.0" compared EQUAL to a 0.7.0 floor, and a
    // bare "1" won on major before its missing components were examined.
    expect(compareVersions("0.7rc.0", MIN_ENGINE_VERSION)).toBeLessThan(0)
    expect(compareVersions("1", MIN_ENGINE_VERSION)).toBeLessThan(0)
    expect(compareVersions("1.0", MIN_ENGINE_VERSION)).toBeLessThan(0)
    // Well-formed versions must still behave.
    expect(compareVersions("0.7.0", MIN_ENGINE_VERSION)).toBe(0)
    expect(compareVersions("1.0.0", MIN_ENGINE_VERSION)).toBeGreaterThan(0)
    expect(compareVersions("0.6.9", MIN_ENGINE_VERSION)).toBeLessThan(0)
  })

  test("an engine reporting a malformed version is refused", async () => {
    const h = install({ version: "0.7rc.0" })
    expect(await ensure("s1")).toEqual({ kind: "engine-too-old", found: "0.7rc.0" })
    expect(h.added).toHaveLength(0)
  })



  test("settled project attach chains are not retained", async () => {
    install({ binding: null })
    await ensure("s1")
    expect(trackedChainsForTests()).toBe(0)
  })
})

describe("settledOutcome — a read-only view for other modules", () => {
  test("undefined before an attach exists, the outcome after it settles", async () => {
    const h = install({
      statuses: [{}, { datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1 },
    })
    expect(settledOutcome("s1")).toBeUndefined() // never attached
    const outcome = await ensure("s1")
    expect(settledOutcome("s1")).toEqual(outcome)
    expect(h.added).toHaveLength(1)
  })

  test("undefined while the attach is still in flight — never a premature answer", async () => {
    install({})
    syncInternals.versionOf = () => new Promise<string | null>(() => {}) // never settles
    void ensure("s1")
    expect(settledOutcome("s1")).toBeUndefined()
    await new Promise((r) => setTimeout(r, 20))
    expect(settledOutcome("s1")).toBeUndefined()
  })

  test("reading never mutates the memo or the project chain", async () => {
    const h = install({
      statuses: [{}, { datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1 },
    })
    await ensure("s1")
    const sessionsBefore = trackedSessionsForTests()
    const chainsBefore = trackedChainsForTests()
    for (let i = 0; i < 5; i++) settledOutcome("s1")
    expect(trackedSessionsForTests()).toBe(sessionsBefore)
    expect(trackedChainsForTests()).toBe(chainsBefore)
    expect(h.added).toHaveLength(1) // no attach was triggered by reading
  })
})

describe("ensure — round 9", () => {
  test("a live disconnect is honoured even when the config cache is stale", async () => {
    // MCP.disconnect writes enabled:false to disk without invalidating Config,
    // so the cached entry still says enabled:true. Believing the cache would
    // reconnect the entry and persist it enabled again — undoing the user's
    // disconnect, globally if the owning entry is global.
    let reads = 0
    const h = install({
      statuses: [{ datamate: { status: "disabled" } }],
    })
    // Reads go through freshConfig now, so the disk value is what is seen.
    syncInternals.existingEntry = undefined
    syncInternals.freshConfig = async () => {
      reads += 1
      return { mcp: { datamate: { type: "local", command: ["datamate", "start-stdio"], enabled: false } } }
    }

    expect(await ensure("s1")).toEqual({ kind: "entry-disabled" })
    expect(reads).toBeGreaterThan(0)
    expect(h.connects).toHaveLength(0) // MCP.connect would persist enabled:true
    expect(h.persisted).toHaveLength(0)
  })

  test("an unrunnable engine is described as broken, not as out of date", async () => {
    const broken = install({ version: null })
    expect(await ensure("s1")).toEqual({ kind: "engine-too-old", found: "unknown" })
    expect(broken.toasts[0].title).toContain("not runnable")
    expect(broken.toasts[0].message).toContain("did not report a usable version")
    expect(broken.toasts[0].message).not.toContain("needs 0.7.0 or newer")

    resetForTests()
    const old = install({ version: "0.6.9" })
    expect(await ensure("s2")).toEqual({ kind: "engine-too-old", found: "0.6.9" })
    expect(old.toasts[0].title).toContain("too old")
    expect(old.toasts[0].message).toContain("needs 0.7.0 or newer")
  })
})

describe("ensure — round 10", () => {
  test("a successful add announces the new tools", async () => {
    // MCP.add stores the client but publishes nothing, so a late attach — after
    // the bounded wait expired, or on a repair retry — left the session with
    // tools it had no way to learn about until another user turn.
    const h = install({
      statuses: [{}, { datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1 },
    })
    expect(await ensure("s1")).toMatchObject({ kind: "attached" })
    expect(h.toolsChanged).toBe(1)
  })


  test("a stalled catalog lookup cannot block the local engine", async () => {
    const h = install({
      statuses: [{}, { datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1 },
    })
    syncInternals.declared = () => new Promise(() => {}) // API accepts then stalls
    const outcome = await ensure("s1")
    // The engine is on PATH and the binding is cached; reporting is optional.
    expect(outcome).toMatchObject({ kind: "attached" })
    expect(h.added).toHaveLength(1)
  })

  test("config is read fresh, so an external write is never missed", async () => {
    // Nothing in this module can enumerate the writers — MCP writes raw, and an
    // IDE rewriting the entry never touches Config at all — so freshness has to
    // be structural at the point of read.
    let onDisk: Record<string, unknown> = { type: "local", command: ["datamate", "start-stdio"], enabled: true }
    let invalidations = 0
    const h = install({ statuses: [{ datamate: { status: "disabled" } }] })
    syncInternals.existingEntry = undefined // let the real reader go through freshConfig
    syncInternals.freshConfig = async () => {
      invalidations += 1
      return { mcp: { datamate: onDisk as ExistingEntry } }
    }
    onDisk = { type: "local", command: ["datamate", "start-stdio"], enabled: false }
    expect(await ensure("s1")).toEqual({ kind: "entry-disabled" })
    expect(invalidations).toBeGreaterThan(0)
    expect(h.connects).toHaveLength(0)
  })
})

describe("ensure — round 11", () => {
  test("a stalled catalog lookup cannot block the REUSE path either", async () => {
    // The bound added last round covered only the fresh-spawn path; a compatible
    // pinned engine still awaited the lookup with no limit, and the generic API
    // request attaches no abort signal at all.
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] },
      statuses: [{ datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1 },
    })
    syncInternals.declared = () => new Promise(() => {}) // accepts, then stalls
    const outcome = await ensure("s1")
    // Reuse still succeeds; only the optional reporting degrades.
    expect(outcome).toMatchObject({ kind: "reused", available: 1 })
    expect(h.added).toHaveLength(0)
  })
})

describe("ensure — round 12", () => {
  test("an externally added entry is seen even when MCP status has not caught up", async () => {
    // MCP.status() reads the same cached config as everything else, so an entry
    // an IDE adds after the cache is warm is absent from status. Without a fresh
    // read first, rule 1 never runs and we persist over the user's entry.
    const h = install({
      statuses: [{}, { datamate: { status: "connected" } }], // status omits it
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] }, // but config has it
      tools: { datamate_dbt_build_model: 1 },
    })
    let readBeforeStatus = false
    let statusCalls = 0
    const realStatus = syncInternals.mcp!.status
    syncInternals.mcp!.status = async () => {
      statusCalls += 1
      return realStatus()
    }
    syncInternals.existingEntry = async () => {
      if (statusCalls === 0) readBeforeStatus = true
      return { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] }
    }
    await ensure("s1")
    // The ordering is the fix: the config refresh must precede the status gate.
    expect(readBeforeStatus).toBe(true)
    expect(h).toBeDefined()
  })
})

describe("ensure — round 13", () => {
  test("a re-link during the reuse lookup is not answered with the old workspace", async () => {
    // The reuse branch awaits the allowlist lookup for up to the bound. Returning
    // `reused` afterwards asserts the connected engine serves the CURRENT binding
    // — so a re-link inside that await would hand this turn workspace A's tools,
    // and its credentials, under binding B.
    let current: CachedBinding | null = binding // 42
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] },
      statuses: [{ datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1 },
    })
    syncInternals.resolveBinding = async () => current
    syncInternals.declared = async () => {
      current = { ...binding, datamateId: 99, datamateName: "other" } as CachedBinding
      return { keys: ["dbt_build_model"], extensionKeys: [] }
    }
    expect(await ensure("s1")).toEqual({ kind: "superseded" })
    expect(h.added).toHaveLength(0)
  })
})

describe("ensure — round 14", () => {
  test("a cached success stops being trusted if the engine drops below the floor", async () => {
    // The pin is only trustworthy because the floor is: engines below it do not
    // lock the pin. An entry reconnected behind the same pin with a pre-floor
    // binary would otherwise ride the cached success forever.
    let version = "0.7.0"
    let command = ["datamate", "start-stdio", "--datamate", "42"]
    const h = install({
      statuses: [{}, { datamate: { status: "connected" } }, { datamate: { status: "connected" } }, {}, { datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1 },
    })
    syncInternals.versionOf = async () => version
    syncInternals.existingEntry = async () => ({ type: "local", command })

    const first = await ensure("s1")
    expect(first).toMatchObject({ kind: "attached" })

    // The entry is replaced behind the same pin by an older engine.
    command = ["/opt/old/datamate", "start-stdio", "--datamate", "42"]
    version = "0.6.3"
    const second = await ensure("s1")
    expect(second).not.toBe(first)
  })

  test("an unchanged command is not re-probed every turn", async () => {
    let probes = 0
    const h = install({
      statuses: [{}, { datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1 },
    })
    syncInternals.versionOf = async () => {
      probes += 1
      return "0.7.0"
    }
    await ensure("s1")
    const afterAttach = probes
    await ensure("s1")
    await ensure("s1")
    // Probing spawns a process; the reuse path must not pay it on every turn.
    expect(probes).toBeLessThanOrEqual(afterAttach + 1)
    expect(h.added).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANTS
//
// These assert the module's contract rather than the shape of any one fix. A
// per-fix test says "this bug is gone"; an invariant says "this cannot happen",
// which is what catches the NEXT instance of a class rather than the last one.
// Four fixes in this file's history created the following defect, and no per-fix
// test could have seen that. These are the net underneath the next change.
// ─────────────────────────────────────────────────────────────────────────────
describe("INVARIANT — one engine per project", () => {
  test("a replacement never leaves two engines registered: every add over a live entry is preceded by a removal", async () => {
    const live: Array<{ name: string; existing: Harness["statusQueue"][number]; entry: unknown }> = [
      { name: "unpinned", existing: { datamate: { status: "connected" } }, entry: { type: "local", command: ["datamate", "start-stdio"] } },
      { name: "pinned elsewhere", existing: { datamate: { status: "connected" } }, entry: { type: "local", command: ["datamate", "start-stdio", "--datamate", "7"] } },
      { name: "connected url", existing: { datamate: { status: "connected" } }, entry: { type: "remote", url: "https://api.example/sse" } },
    ]
    for (const scenario of live) {
      resetForTests()
      const h = install({
        existing: scenario.entry as never,
        statuses: [scenario.existing, { datamate: { status: "connected" } }],
        tools: { datamate_dbt_build_model: 1 },
      })
      await ensure(`s-${scenario.name}`)
      if (h.added.length > 0) {
        expect(h.removes.length, `${scenario.name}: added without removing the live entry first`).toBeGreaterThan(0)
      }
    }
  })

  test("concurrent attaches in one project never overlap their mutating phase", async () => {
    const h = install({
      statuses: [{}, { datamate: { status: "connected" } }, {}, { datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1 },
    })
    let inFlight = 0
    let peak = 0
    syncInternals.mcp!.add = async (name, cfg) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 30))
      h.added.push({ name, cfg })
      inFlight -= 1
    }
    await Promise.all([ensure("a"), ensure("b")])
    expect(peak).toBe(1)
  })
})

describe("INVARIANT — no MCP mutation on a stale binding", () => {
  // The binding is flipped at each await seam in turn. Whatever the flow was
  // doing, it must not mutate MCP state for a workspace the project has left.
  const seams = ["existingEntry", "versionOf", "declared", "tools", "add"] as const

  for (const seam of seams) {
    test(`a re-link at the ${seam} seam never installs or tears down for the old workspace`, async () => {
      resetForTests()
      let current: CachedBinding | null = binding // 42
      const flip = () => {
        current = { ...binding, datamateId: 99, datamateName: "other" } as CachedBinding
      }
      const h = install({
        statuses: [{}, { datamate: { status: "connected" } }],
        tools: { datamate_dbt_build_model: 1 },
      })
      syncInternals.resolveBinding = async () => current
      if (seam === "existingEntry") syncInternals.existingEntry = async () => (flip(), null)
      if (seam === "versionOf") syncInternals.versionOf = async () => (flip(), "0.7.0")
      if (seam === "declared") syncInternals.declared = async () => (flip(), { keys: [], extensionKeys: [] })
      if (seam === "tools") syncInternals.mcp!.tools = async () => (flip(), {})
      if (seam === "add") {
        const prev = syncInternals.mcp!.add
        syncInternals.mcp!.add = async (n, c) => {
          await prev(n, c)
          flip()
        }
      }
      await ensure("s1")
      // Anything installed for 42 after the project moved to 99 must not survive.
      const strayFor42 = h.added.filter((a) => a.cfg.command.includes("42")).length
      if (strayFor42 > 0) {
        expect(h.removes.length, `${seam}: installed workspace 42 after the re-link and left it`).toBeGreaterThan(0)
      }
    })
  }
})

describe("INVARIANT — every config read is fresh", () => {
  test("no config read bypasses the refreshing accessor", async () => {
    let fresh = 0
    const h = install({ statuses: [{ datamate: { status: "disabled" } }] })
    syncInternals.existingEntry = undefined
    syncInternals.freshConfig = async () => {
      fresh += 1
      return { mcp: { datamate: { type: "local", command: ["datamate", "start-stdio"], enabled: false } } }
    }
    await ensure("s1")
    // If any read went through a cached path instead, this would be 0.
    expect(fresh).toBeGreaterThan(0)
    expect(h.connects).toHaveLength(0)
  })
})

describe("INVARIANT — an actionable failure tells the user exactly once", () => {
  const actionable: Array<{ name: string; opts: Parameters<typeof install>[0]; kind: string }> = [
    { name: "engine-missing", opts: { which: null }, kind: "engine-missing" },
    { name: "engine-too-old", opts: { version: "0.5.9" }, kind: "engine-too-old" },
    { name: "unrunnable engine", opts: { version: null }, kind: "engine-too-old" },
    {
      name: "entry-disabled",
      opts: {
        existing: { type: "local", command: ["datamate", "start-stdio"], enabled: false },
        statuses: [{ datamate: { status: "disabled" } }],
      },
      kind: "entry-disabled",
    },
    {
      name: "connect-failed",
      opts: {
        existing: { type: "local", command: ["datamate", "start-stdio"] },
        statuses: [
          { datamate: { status: "failed", error: "exit 1" } },
          { datamate: { status: "failed", error: "exit 1" } },
        ],
      },
      kind: "connect-failed",
    },
  ]
  for (const c of actionable) {
    test(`${c.name} is never silent`, async () => {
      resetForTests()
      const h = install(c.opts)
      const outcome = await ensure("s1")
      expect(outcome.kind).toBe(c.kind as never)
      // EXACTLY one, not at least one. "At least one" accepts a double signal,
      // and a double signal is what a refusal path grows when a second way of
      // reaching the user is added beside the first — a dialog and a toast
      // saying the same thing. A suite asserting a toast fires and a suite
      // asserting an offer is raised can both be green while the user sees two.
      expect(h.toasts.length, `${c.name} told the user ${h.toasts.length} times, not once`).toBe(1)
    })
  }

  test("a refusal for a workspace the project has left says nothing at all", async () => {
    // Zero, not one: the message would name a workspace this project no longer
    // holds. The teardown still happens — it is binding-independent — but the
    // answer becomes `superseded` and the user hears nothing about a decision
    // that no longer applies to them.
    let current: CachedBinding | null = binding
    const h = install({
      which: null,
      statuses: [{}],
    })
    syncInternals.resolveBinding = async () => current
    syncInternals.declared = async () => {
      current = { ...binding, datamateId: 99, datamateName: "other" } as CachedBinding
      return { keys: ["dbt_build_model"], extensionKeys: [] }
    }
    expect(await ensure("s1")).toEqual({ kind: "superseded" })
    expect(h.toasts.length, "announced a refusal for the workspace the project had left").toBe(0)
  })

  test("the teardown happens before the announcement, not after", async () => {
    // Load-bearing rather than incidental: the announcement is a substitution
    // point, and a body that waits on a person — a dialog — would hold a
    // rejected client connected until they clicked. Stop serving first, explain
    // second.
    const order: string[] = []
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled: false },
      statuses: [{ datamate: { status: "connected" } }],
    })
    const previousRemove = syncInternals.mcp!.remove
    syncInternals.mcp!.remove = async (name: string) => {
      order.push("teardown")
      return previousRemove(name)
    }
    syncInternals.notify = async (toast) => {
      order.push("announce")
      h.toasts.push(toast)
    }
    expect(await ensure("s1")).toEqual({ kind: "entry-disabled" })
    expect(order, "explained before it stopped serving").toEqual(["teardown", "announce"])
  })
})

describe("INVARIANT — a superseded attach leaves nothing installed", () => {
  test("whatever it installed before noticing, it does not leave it serving", async () => {
    let current: CachedBinding | null = binding
    const h = install({
      statuses: [{}, { datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1 },
    })
    syncInternals.resolveBinding = async () => current
    const prevAdd = syncInternals.mcp!.add
    syncInternals.mcp!.add = async (n, c) => {
      await prevAdd(n, c)
      current = { ...binding, datamateId: 99, datamateName: "other" } as CachedBinding
    }
    const outcome = await ensure("s1")
    expect(outcome).toEqual({ kind: "superseded" })
    expect(h.removes, "superseded left the engine it installed still registered").toContain("datamate")
    // The runtime is only half of it. `persist()` already wrote the old
    // workspace's pin to disk, so a restart before the next attach would
    // bootstrap it again — "leaves nothing installed" has to mean the config too.
    expect(h.restores.length, "superseded left the old workspace pinned on disk").toBeGreaterThan(0)
  })

  test("a superseded REUSE detaches the engine it declined to answer with", async () => {
    // The caller runs resolveTools regardless of the outcome, so returning
    // `superseded` while the old client stays registered still hands that turn
    // the previous workspace's tools — and its credentials.
    let current: CachedBinding | null = binding // 42
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] },
      statuses: [{ datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1 },
    })
    syncInternals.resolveBinding = async () => current
    syncInternals.declared = async () => {
      current = { ...binding, datamateId: 99, datamateName: "other" } as CachedBinding
      return { keys: ["dbt_build_model"], extensionKeys: [] }
    }
    expect(await ensure("s1")).toEqual({ kind: "superseded" })
    expect(h.removes, "left the old workspace's client registered for resolveTools to find").toContain("datamate")
  })
})

describe("INVARIANT — a cached success is re-probed and re-attributed", () => {
  const invalidations = [
    { name: "engine died", statuses: [{}, { datamate: { status: "connected" } }, { datamate: { status: "failed", error: "closed" } }, {}, { datamate: { status: "connected" } }], entry: null },
    { name: "pin moved to another workspace", statuses: [{}, { datamate: { status: "connected" } }, { datamate: { status: "connected" } }, {}, { datamate: { status: "connected" } }], entry: "99" },
  ] as const

  for (const c of invalidations) {
    test(`a cached success is not reused when the ${c.name}`, async () => {
      resetForTests()
      let pin = "42"
      const h = install({ statuses: c.statuses as never, tools: { datamate_dbt_build_model: 1 } })
      if (c.entry !== null) {
        syncInternals.existingEntry = async () => ({ type: "local", command: ["datamate", "start-stdio", "--datamate", pin] })
      }
      const first = await ensure("s1")
      expect(first).toMatchObject({ kind: "attached" })
      if (c.entry !== null) pin = c.entry
      const second = await ensure("s1")
      expect(second, `${c.name}: the cached success was reused unchecked`).not.toBe(first)
    })
  }
})

describe("ensure — round 18", () => {
  test("a re-link DURING cached-success validation is not answered with the old workspace", async () => {
    // The memoised-success path does its own awaited validation outside run(),
    // so it never had run()'s final binding check. Status, config and version
    // work all await; a re-link inside them left `boundTo` pointing at the old
    // workspace and returned its cached task — handing the turn A's tools and
    // credentials under binding B.
    let current: CachedBinding | null = binding // 42
    const h = install({
      statuses: [{}, { datamate: { status: "connected" } }, { datamate: { status: "connected" } }, {}, { datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1 },
    })
    syncInternals.resolveBinding = async () => current
    const first = await ensure("s1")
    expect(first).toMatchObject({ kind: "attached" })

    // The re-link lands while the cached success is being re-validated.
    syncInternals.versionOf = async () => {
      current = { ...binding, datamateId: 99, datamateName: "other" } as CachedBinding
      return "0.7.0"
    }
    const second = await ensure("s1")
    expect(second, "returned the cached success for a workspace the project had left").not.toBe(first)
  })

  test("a superseded attach removes the project override rather than copying the global entry", async () => {
    // existingEntry() returns the MERGED value, which may come from global, while
    // persist() writes to the project file. Restoring the merged value would
    // write a copy of the global entry into the project — a permanent override
    // shadowing every later global update, disable or removal.
    let current: CachedBinding | null = binding
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio"], enabled: true }, // merged, from global
      statuses: [{ datamate: { status: "connected" } }, { datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1 },
    })
    syncInternals.resolveBinding = async () => current
    syncInternals.projectEntry = async () => null // the PROJECT file has no entry of its own
    const prevAdd = syncInternals.mcp!.add
    syncInternals.mcp!.add = async (n, c) => {
      await prevAdd(n, c)
      current = { ...binding, datamateId: 99, datamateName: "other" } as CachedBinding
    }
    expect(await ensure("s1")).toEqual({ kind: "superseded" })
    expect(h.restores, "restored something into the project file instead of removing the override").toEqual([null])
  })
})

describe("INVARIANT — a disabled entry serves nothing", () => {
  // "Disabled" is a claim about what the model can reach, not about what the
  // config file says. The config is where the user expresses it; the runtime is
  // where it either holds or doesn't.
  test("an entry disabled AFTER it connected is torn down, not merely reported", async () => {
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled: false },
      // The status a live disable actually produces. `MCP.status()` returns live
      // client state and `MCP.tools()` gates on exactly that, consulting the
      // config only for a timeout — so reporting `entry-disabled` while the
      // client stays registered hands that turn the tools and the credentials
      // of the workspace the user just switched off.
      statuses: [{ datamate: { status: "connected" } }],
    })
    expect(await ensure("s1")).toEqual({ kind: "entry-disabled" })
    expect(h.removes, "reported the entry disabled but left its client serving tools").toContain("datamate")
    // Respecting the edit must not turn into rewriting it, and must not turn
    // into attaching over it: for an unpinned entry the replacement path would
    // otherwise persist it enabled again, undoing the very edit being honoured.
    expect(h.added, "attached over an entry the user had disabled").toHaveLength(0)
    expect(h.persisted, "wrote to the config while honouring a disable").toHaveLength(0)
    expect(h.connects, "retried an entry the user disabled").toHaveLength(0)
  })

  test("a memoised success does not outlive the entry being disabled", async () => {
    // The disable check lives in `run()`, and a settled success never re-enters
    // it. Every later turn of that session is decided by the memo alone, so the
    // check has to be reachable from the validation path too.
    let enabled = true
    const h = install({
      statuses: [
        {},
        { datamate: { status: "connected" } },
        { datamate: { status: "connected" } },
        { datamate: { status: "connected" } },
      ],
      tools: { datamate_dbt_build_model: 1, datamate_dbt_compile_model: 1 },
    })
    syncInternals.existingEntry = async () =>
      ({ type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled }) as ExistingEntry
    expect(await ensure("s1")).toMatchObject({ kind: "attached" })

    enabled = false
    expect(await ensure("s1"), "rode the memo straight past the user's disable").toEqual({ kind: "entry-disabled" })
    expect(h.removes, "kept serving the disabled entry's tools for the rest of the session").toContain("datamate")
  })

  test("nothing awaits between the final binding check and the install", async () => {
    // The guard is only worth what the gap after it is: any await between the
    // check and the mutations reopens the window the check exists to close. The
    // late guard would undo this attach — but only after it had spawned an
    // engine and taken the per-project lock, which is long enough for the
    // replacement attach's first-turn wait to expire.
    let current: CachedBinding | null = binding
    const h = install({
      statuses: [{}, { datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1 },
    })
    syncInternals.resolveBinding = async () => current
    syncInternals.projectEntry = async () => {
      current = { ...binding, datamateId: 99, datamateName: "other" } as CachedBinding
      return null
    }
    expect(await ensure("s1")).toEqual({ kind: "superseded" })
    expect(h.added, "installed an engine for a workspace the project had already left").toHaveLength(0)
    expect(h.persisted, "pinned a workspace the project had already left").toHaveLength(0)
  })
})

describe("INVARIANT — every outcome answers both consumer questions deliberately", () => {
  // Typed by the union on purpose. Adding a state to `Outcome` fails to compile
  // here until someone decides what it means for BOTH consumers — which is the
  // point: the bug this guards against is not a wrong answer, it is a state
  // acquiring an answer nobody chose.
  const EXPECTED: Record<Outcome["kind"], { serving: boolean; installHelps: boolean }> = {
    attached: { serving: true, installHelps: false },
    reused: { serving: true, installHelps: false },
    disabled: { serving: false, installHelps: false },
    unbound: { serving: false, installHelps: false },
    "engine-missing": { serving: false, installHelps: true },
    "engine-too-old": { serving: false, installHelps: true },
    "connect-failed": { serving: false, installHelps: false },
    "entry-disabled": { serving: false, installHelps: false },
    superseded: { serving: false, installHelps: false },
  }

  test("attribution and remedy are decided across the whole union, not a sample", () => {
    for (const [kind, want] of Object.entries(EXPECTED)) {
      const outcome = { kind } as Outcome
      expect(attributableEngine(outcome), `attribution for ${kind}`).toBe(want.serving)
      expect(installWouldHelp(outcome), `install remedy for ${kind}`).toBe(want.installHelps)
    }
  })

  test("an unsettled attach answers neither question", () => {
    // `undefined` means in-flight OR never attached. Both consumers fail open on
    // it, so it must never be mistaken for a settled verdict.
    expect(attributableEngine(undefined)).toBe(false)
    expect(installWouldHelp(undefined)).toBe(false)
  })

  test("refusing to attach is not the same as being unable to obtain an engine", () => {
    // The distinction the offer depends on: these refused, but an install fixes
    // none of them — a user who switched their engine off would be offered the
    // engine they already have.
    expect(installWouldHelp({ kind: "entry-disabled" })).toBe(false)
    expect(installWouldHelp({ kind: "connect-failed", error: "exit 1" })).toBe(false)
    expect(installWouldHelp({ kind: "superseded" })).toBe(false)
    // ...and these are exactly the two an install does fix.
    expect(installWouldHelp({ kind: "engine-missing", declared: 0 })).toBe(true)
    expect(installWouldHelp({ kind: "engine-too-old", found: "0.6.3" })).toBe(true)
  })

  test("a superseded attach is never attributed to the session that raced it", () => {
    // The binding moved mid-flight, so what is connected belongs to a workspace
    // this project has left. Attributing it would route queries there with its
    // credentials.
    expect(attributableEngine({ kind: "superseded" })).toBe(false)
  })

  test("attribution is keyed to the session, not to the last attach anywhere", async () => {
    install({ statuses: [{ datamate: { status: "connected" } }], existing: null, which: null })
    await ensure("s1")
    expect(settledOutcome("s1")).toBeDefined()
    expect(settledOutcome("s2"), "a session that never attached inherited another's verdict").toBeUndefined()
  })
})

describe("INVARIANT — the entry decision is ordered by authority and cannot await", () => {
  // The order is the contract: intent > connectivity > attribution > version.
  // Three review rounds each found one of these checks on the wrong side of
  // another, and every one of those defects was reachable only because an await
  // separated them. These assert the order directly, on the function that has
  // no awaits to separate anything.
  const live = { status: "connected" }
  const ours = { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled: true }
  const theirs = { type: "local", command: ["datamate", "start-stdio", "--datamate", "9"], enabled: true }
  const unpinned = { type: "local", command: ["datamate", "start-stdio"], enabled: true }

  test("intent outranks connectivity — a disabled entry is honoured while its client is live", () => {
    expect(planForEntry({ entry: { ...ours, enabled: false }, observed: live }, "42", false).act).toBe("honour-disable")
  })

  test("intent outranks attribution — a disabled entry is honoured even when it is not ours", () => {
    expect(planForEntry({ entry: { ...theirs, enabled: false }, observed: live }, "42", false).act).toBe("honour-disable")
  })

  test("attribution outranks connectivity — an unreachable entry is judged ours BEFORE being revived", () => {
    // Whose engine is this, not how is it doing. Reviving one that is not ours
    // spends a spawn on another client's process, and — with the old order —
    // wedged the project on `connect-failed` forever, because the retry
    // answered before the pin was consulted.
    expect(planForEntry({ entry: theirs, observed: { status: "failed", error: "exit 1" } }, "42", false).act).toBe(
      "replace-unattributable",
    )
    // Ours and down IS revived: that is what the retry is for.
    expect(planForEntry({ entry: ours, observed: { status: "failed", error: "exit 1" } }, "42", false).act).toBe(
      "retry-connect",
    )
  })

  test("attribution outranks version — an entry pinned elsewhere is replaced, never probed", () => {
    expect(planForEntry({ entry: theirs, observed: live }, "42", false)).toEqual({
      act: "replace-unattributable",
      entry: "datamate start-stdio --datamate 9",
      pinnedTo: "9",
    })
    // An unpinned entry is equally unattributable: it follows its owner's active
    // teammate, which this client does not control.
    expect(planForEntry({ entry: unpinned, observed: live }, "42", false).act).toBe("replace-unattributable")
  })

  test("one retry, never two — the bound is an argument, not a branch", () => {
    const failed = { status: "failed", error: "exit 1" }
    expect(planForEntry({ entry: ours, observed: failed }, "42", false).act).toBe("retry-connect")
    expect(planForEntry({ entry: ours, observed: failed }, "42", true)).toEqual({ act: "refuse-unreachable", error: "exit 1" })
  })

  test("a dead URL is replaced rather than retried — only the IDE can restore its port", () => {
    const url = { type: "remote", url: "http://localhost:7801/sse", enabled: true }
    expect(planForEntry({ entry: url, observed: { status: "failed" } }, "42", false)).toEqual({
      act: "replace-unreachable-url",
      url: "http://localhost:7801/sse",
    })
  })

  test("nothing registered is a spawn, and ours-and-live goes to the version check", () => {
    expect(planForEntry({ entry: null, observed: undefined }, "42", false).act).toBe("spawn")
    expect(planForEntry({ entry: ours, observed: live }, "42", false).act).toBe("check-version")
  })

  test("the decision is a value, not a promise — nothing can interleave inside it", () => {
    const plan = planForEntry({ entry: ours, observed: live }, "42", false) as unknown as { then?: unknown }
    expect(typeof plan.then).toBe("undefined")
  })

  test("an unreadable version is below the floor, because it cannot be shown to lock its pin", () => {
    expect(clearsFloor(null)).toBe(false)
    expect(clearsFloor("0.6.3")).toBe(false)
    expect(clearsFloor(MIN_ENGINE_VERSION)).toBe(true)
    expect(clearsFloor("1.0.0")).toBe(true)
  })
})

describe("INVARIANT — the attach flow never writes config from a repair", () => {
  // `MCP.connect` persists `enabled: true` into whichever config owns the entry.
  // For an IDE-written global entry that is merely down, repairing it locally
  // would therefore write global config — and if a disable landed during the
  // connect window, that disable is destroyed on disk with nothing to repair it,
  // because every later read says enabled. Round 4 closed the `enabled: false`
  // half of this; the `enabled: true` half lived on in the retry.
  //
  // The flow revives with `add`, which starts a process and writes nothing. This
  // asserts the primitive is never reached, on every path that could reach it.
  const scenarios: Array<[string, Parameters<typeof install>[0]]> = [
    [
      "ours and down",
      {
        existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] },
        statuses: [{ datamate: { status: "failed", error: "exit 1" } }, { datamate: { status: "connected" } }],
        tools: { datamate_dbt_build_model: 1 },
      },
    ],
    [
      "ours and down, staying down",
      {
        existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] },
        statuses: [{ datamate: { status: "failed", error: "exit 1" } }, { datamate: { status: "failed", error: "x" } }],
      },
    ],
    [
      "disabled while connected",
      {
        existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled: false },
        statuses: [{ datamate: { status: "connected" } }],
      },
    ],
    [
      "pinned elsewhere and down",
      {
        existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "9"] },
        statuses: [{ datamate: { status: "failed", error: "exit 1" } }, { datamate: { status: "connected" } }],
        tools: { datamate_dbt_build_model: 1 },
      },
    ],
    [
      "a dead URL entry",
      {
        existing: { type: "remote", url: "http://localhost:7801/sse" },
        statuses: [{ datamate: { status: "failed" } }, { datamate: { status: "connected" } }],
        tools: { datamate_dbt_build_model: 1 },
      },
    ],
  ]

  for (const [name, opts] of scenarios) {
    test(`no config-writing repair: ${name}`, async () => {
      const h = install(opts)
      await ensure("s1")
      expect(h.connects, `${name} repaired the entry with the config-writing primitive`).toHaveLength(0)
    })
  }
})

describe("INVARIANT — attribution asks the running engine, not only the config", () => {
  // The config says what SHOULD run; MCP's spawn record says what IS running.
  // They diverge whenever the file is rewritten after a client started: another
  // process re-pinning a shared config, an IDE replacing the entry through
  // MCP.add, a re-link. Judging on the config alone let every check agree with
  // itself while the live client served another workspace's data — and its
  // credentials — under this workspace's name. Nothing in-process could tell.
  const ours = { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled: true }
  const theirs = { type: "local", command: ["datamate", "start-stdio", "--datamate", "5"], enabled: true }

  test("a config that names us over a runtime that does not is NOT reused", () => {
    const plan = planForEntry({ entry: ours, observed: { status: "connected" }, runtime: theirs }, "42", false)
    expect(plan, "reused an engine that was started for another workspace").toMatchObject({
      act: "replace-unattributable",
      pinnedTo: "5",
    })
  })

  test("agreement between the two is what earns a reuse", () => {
    expect(planForEntry({ entry: ours, observed: { status: "connected" }, runtime: ours }, "42", false).act).toBe(
      "check-version",
    )
  })

  test("no runtime record means nothing of ours is running, so the config decides alone", () => {
    // Absent is not "mismatched": a key with no live client has no record, and
    // the config is then the only evidence there is.
    expect(planForEntry({ entry: ours, observed: { status: "connected" }, runtime: undefined }, "42", false).act).toBe(
      "check-version",
    )
  })

  test("the whole-session case: a re-pin under a live engine is caught end to end", async () => {
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled: true },
      statuses: [{ datamate: { status: "connected" } }, { datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1, datamate_dbt_compile_model: 1 },
    })
    // Another process started this client for workspace 5 and then re-pinned the
    // shared config to 42 — which is what this project is bound to, so the
    // config agrees with the binding and always would have.
    h.spawnedNow = { type: "local", command: ["datamate", "start-stdio", "--datamate", "5"] } as never
    const outcome = await ensure("s1")
    expect(outcome, "answered `reused` about a process serving another workspace").toMatchObject({ kind: "attached" })
    expect(h.added, "did not replace the misattributed engine").toHaveLength(1)
  })
})

describe("INVARIANT — never write what you cannot undo, and never stop waiting forever", () => {
  test("an unreadable project config refuses to install rather than installing something it cannot undo", async () => {
    // The restore reads the project file to learn what to put back. If that read
    // fails and is reported as "no entry here", the undo REMOVES — so a
    // transient read failure could delete the user's own entry as the undo of an
    // attach meant to leave it alone.
    const h = install({ statuses: [{}], tools: { datamate_dbt_build_model: 1 } })
    syncInternals.projectEntry = async () => {
      throw new Error("EACCES: permission denied")
    }
    const outcome = await ensure("s1")
    expect(outcome.kind, "installed an engine it had no way to undo").toBe("connect-failed")
    expect(h.persisted, "wrote config it could not restore").toHaveLength(0)
    expect(h.added, "registered a client it could not undo").toHaveLength(0)
    expect(h.toasts, "failed silently").toHaveLength(1)
  })

  test("a settled memo is re-validated inside the turn's wait, even after an earlier timeout", async () => {
    const h = install({
      statuses: [{}, { datamate: { status: "connected" } }, { datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1, datamate_dbt_compile_model: 1 },
    })
    expect(await ensure("s1")).toMatchObject({ kind: "attached" })
    // Turn 1 gave up waiting. That must not silence the wait for every later
    // turn: re-validating a settled memo is a status read and a config read with
    // no spawn, and during that window the outcome reads as "not settled" — a
    // consumer that fails open on it stops routing for the turn and says so.
    sessionsForTests().get("s1")!.waitTimedOut = true

    // Deterministic on purpose: the first draft of this test observed a flag
    // during the wait and passed with the defect reinstated, because the task
    // had not reached the seam yet when the check ran. It proved the fixture.
    // Elapsed time is the thing that actually differs — with the wait silenced,
    // `whenAttached` returns before the re-validation has happened at all.
    const previousEntry = syncInternals.existingEntry!
    syncInternals.existingEntry = async (name: string) => {
      await new Promise((r) => setTimeout(r, 25))
      return previousEntry(name)
    }
    const started = performance.now()
    const pending = ensure("s1")
    await whenAttached("s1", 2000)
    const waited = performance.now() - started
    await pending
    expect(waited, "resolved the turn's tools without waiting for the memo re-validation").toBeGreaterThanOrEqual(20)
    expect(settledOutcome("s1"), "no settled outcome at the point tools are resolved").toBeDefined()
    expect(h.added, "re-validating a good memo spawned a second engine").toHaveLength(1)
  })
})

describe("INVARIANT — the last thing awaited before a mutation is the world check", () => {
  // The mechanical form of "every await after a guard belongs to the guard's
  // problem". Individual tests flip a binding at one seam and check one
  // outcome; that only ever catches the seam someone thought of, which is why
  // an await inserted after the final guard survived the whole suite, and why
  // deleting a teardown's guard outright survived it too.
  //
  // This records the order seams are awaited in and asserts adjacency: for every
  // binding-DEPENDENT mutation, the seam awaited immediately before it is the
  // binding read. persist -> add is sanctioned as one commit, since the guard
  // covers the pair.
  //
  // Binding-INDEPENDENT teardowns are deliberately out of scope: a disabled or
  // below-floor engine is torn down whatever is bound, so requiring a binding
  // read before those would assert the opposite of what they are for. The
  // scenarios below exercise only paths whose mutations are binding-dependent.
  const MUTATIONS = new Set(["persist", "add", "remove", "connect", "persistRestore"])

  function traced(opts: Parameters<typeof install>[0]) {
    const h = install(opts)
    const trace: string[] = []
    const wrapRead = <T extends (...args: never[]) => Promise<unknown>>(name: string, fn: T) =>
      (async (...args: never[]) => {
        const out = await fn(...args)
        trace.push(name)
        return out
      }) as T
    const wrapMutation = <T extends (...args: never[]) => Promise<unknown>>(name: string, fn: T) =>
      (async (...args: never[]) => {
        trace.push(name)
        return await fn(...args)
      }) as T

    syncInternals.resolveBinding = wrapRead("resolveBinding", syncInternals.resolveBinding!)
    syncInternals.existingEntry = wrapRead("existingEntry", syncInternals.existingEntry!)
    syncInternals.projectEntry = wrapRead("projectEntry", syncInternals.projectEntry!)
    syncInternals.declared = wrapRead("declared", syncInternals.declared!)
    syncInternals.versionOf = wrapRead("versionOf", syncInternals.versionOf!)
    syncInternals.persist = wrapMutation("persist", syncInternals.persist!)
    syncInternals.persistRestore = wrapMutation("persistRestore", syncInternals.persistRestore!)
    const m = syncInternals.mcp!
    syncInternals.mcp = {
      ...m,
      status: wrapRead("status", m.status),
      tools: wrapRead("tools", m.tools!),
      spawned: m.spawned ? wrapRead("spawned", m.spawned) : undefined,
      add: wrapMutation("add", m.add),
      remove: wrapMutation("remove", m.remove),
      connect: wrapMutation("connect", m.connect),
    }
    return { h, trace }
  }

  const scenarios: Array<[string, Parameters<typeof install>[0]]> = [
    ["a fresh spawn", { statuses: [{}, { datamate: { status: "connected" } }], tools: { datamate_dbt_build_model: 1 } }],
    [
      "replacing an entry pinned elsewhere",
      {
        existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "9"], enabled: true },
        statuses: [{ datamate: { status: "connected" } }, { datamate: { status: "connected" } }],
        tools: { datamate_dbt_build_model: 1 },
      },
    ],
    [
      "replacing an unpinned entry",
      {
        existing: { type: "local", command: ["datamate", "start-stdio"], enabled: true },
        statuses: [{ datamate: { status: "connected" } }, { datamate: { status: "connected" } }],
        tools: { datamate_dbt_build_model: 1 },
      },
    ],
  ]

  for (const [name, opts] of scenarios) {
    test(`${name}: every mutation is preceded by the world check`, async () => {
      const { trace } = traced(opts)
      await ensure("s1")
      const offenders: string[] = []
      trace.forEach((step, i) => {
        if (!MUTATIONS.has(step)) return
        const before = trace[i - 1]
        if (before === "resolveBinding") return
        if (step === "add" && before === "persist") return // one commit, one guard
        offenders.push(`${step} followed ${before ?? "(nothing)"}`)
      })
      expect(offenders, `${name}: ${offenders.join("; ")} — trace was ${trace.join(" -> ")}`).toEqual([])
    })
  }
})
