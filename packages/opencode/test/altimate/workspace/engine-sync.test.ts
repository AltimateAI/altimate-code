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
  type LocalMcpConfig,
} from "../../../src/altimate/workspace/engine-sync"
import type { CachedBinding } from "../../../src/altimate/workspace/state"

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
  statusQueue: Array<Record<string, { status: string; error?: string } | undefined>>
  tools: Record<string, unknown>
}

function install(opts: {
  binding?: CachedBinding | null
  which?: string | null
  version?: string | null | ((bin: string) => string | null)
  declared?: { keys: string[]; extensionKeys: string[] } | null
  statuses?: Harness["statusQueue"]
  tools?: Record<string, unknown>
  existing?: { type?: string; url?: string; command?: string[] | string; args?: string[] } | null
}): Harness {
  const h: Harness = {
    added: [],
    persisted: [],
    connects: [],
    removes: [],
    toasts: [],
    statusQueue: opts.statuses ?? [{}],
    tools: opts.tools ?? {},
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
  syncInternals.existingEntry = async () => (opts.existing === undefined ? null : opts.existing)
  syncInternals.notify = async (toast) => {
    h.toasts.push(toast)
  }
  syncInternals.mcp = {
    status: async () => h.statusQueue.length > 1 ? h.statusQueue.shift()! : h.statusQueue[0]!,
    add: async (name, cfg) => {
      h.added.push({ name, cfg })
    },
    connect: async (name) => {
      h.connects.push(name)
    },
    remove: async (name) => {
      h.removes.push(name)
    },
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

  test("a down COMMAND entry is retried once, then reported — never double-spawned", async () => {
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio"] },
      statuses: [{ datamate: { status: "failed", error: "exit 1" } }, { datamate: { status: "failed", error: "exit 1" } }],
    })
    expect(await ensure("s1")).toEqual({ kind: "connect-failed", error: "exit 1" })
    expect(h.connects).toEqual(["datamate"])
    expect(h.added).toHaveLength(0)
    expect(h.persisted).toHaveLength(0)
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

  test("a recovered entry is gated too: retried back to life but unpinned, it is replaced", async () => {
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
    expect(h.connects).toEqual(["datamate"]) // the one retry still happened
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
  test("our own pinned entry is detached when the binding is gone", async () => {
    const h = install({
      binding: null,
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "5"] },
      statuses: [{ datamate: { status: "connected" } }],
    })
    expect(await ensure("s1")).toEqual({ kind: "unbound" })
    expect(h.removes).toEqual(["datamate"])
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
