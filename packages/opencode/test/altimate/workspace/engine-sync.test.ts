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
  whenAttached,
  ATTACH_WAIT_MS,
  INSTALL_HINT,
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
  toasts: Array<{ title: string; message: string; variant: string }>
  statusQueue: Array<Record<string, { status: string; error?: string } | undefined>>
  tools: Record<string, unknown>
}

function install(opts: {
  binding?: CachedBinding | null
  which?: string | null
  version?: string | null
  declared?: { keys: string[]; extensionKeys: string[] } | null
  statuses?: Harness["statusQueue"]
  tools?: Record<string, unknown>
  existing?: { type?: string; url?: string; command?: string[] } | null
}): Harness {
  const h: Harness = {
    added: [],
    persisted: [],
    connects: [],
    toasts: [],
    statusQueue: opts.statuses ?? [{}],
    tools: opts.tools ?? {},
  }
  syncInternals.resolveBinding = async () => (opts.binding === undefined ? binding : opts.binding)
  syncInternals.which = () => (opts.which === undefined ? "/usr/local/bin/datamate" : opts.which)
  syncInternals.versionOf = async () => (opts.version === undefined ? "0.6.3" : opts.version)
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

  test("reuses an already-connected engine entry without spawning", async () => {
    const h = install({
      statuses: [{ datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1, datamate_dbt_compile_model: 1 },
    })
    expect(await ensure("s1")).toEqual({ kind: "reused", available: 2 })
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
