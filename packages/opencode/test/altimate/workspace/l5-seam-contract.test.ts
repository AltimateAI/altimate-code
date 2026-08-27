// Gate lens 5 — adversarial probes of the `settledOutcome` seam and the
// `pinnedWorkspace` parser against the precedence contract. Disposable.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  ensure,
  resetForTests,
  syncInternals,
  pinnedWorkspace,
  settledOutcome,
  attributableEngine,
  MAX_TRACKED_SESSIONS,
  trackedSessionsForTests,
  type LocalMcpConfig,
  type Outcome,
} from "../../../src/altimate/workspace/engine-sync"
import { SERVING, INSTALL_HELPS } from "../../../src/altimate/workspace/engine-types"
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
}

function install(opts: {
  binding?: CachedBinding | null
  which?: string | null
  version?: string | null | ((bin: string) => string | null)
  declared?: { keys: string[]; extensionKeys: string[] } | null
  statuses?: Harness["statusQueue"]
  tools?: Record<string, unknown>
  existing?: ExistingEntry | null
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
  // The project file has no entry of its own unless a test says otherwise.
  // Required since the project reader stopped swallowing its own errors.
  if (!syncInternals.projectEntry) syncInternals.projectEntry = async () => null
  if (!syncInternals.projectConfigPath)
    syncInternals.projectConfigPath = async () => "/tmp/test/.altimate-code/altimate-code.json"
  syncInternals.mcp = {
    status: async () => (h.statusQueue.length > 1 ? h.statusQueue.shift()! : h.statusQueue[0]!),
    add: async (name, cfg) => {
      h.added.push({ name, cfg })
    },
    remove: async (name) => {
      h.removes.push(name)
    },
    tools: async () => h.tools,
  }
  return h
}

const connected = { datamate: { status: "connected" } }
const never = () => new Promise<string | null>(() => {})
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  process.env.ALTIMATE_WORKSPACE = "1"
  resetForTests()
})

afterEach(() => {
  for (const key of Object.keys(syncInternals) as Array<keyof typeof syncInternals>) delete syncInternals[key]
  if (ORIGINAL_FLAG === undefined) delete process.env.ALTIMATE_WORKSPACE
  else process.env.ALTIMATE_WORKSPACE = ORIGINAL_FLAG
})

// ───────────────────────────── P1: pure synchronous read ─────────────────────────────
describe("P1 — settledOutcome is a pure synchronous read", () => {
  test("is a plain function whose body has no await/then and never touches the task", () => {
    expect(settledOutcome.constructor.name).toBe("Function")
    const src = settledOutcome.toString()
    expect(src).not.toMatch(/\bawait\b/)
    expect(src).not.toMatch(/\.then\b/)
    expect(src).not.toMatch(/\btask\b/)
    expect(src).toMatch(/outcome/)
  })

  test("returns immediately, not a promise, while an attach is in flight on a probe that never resolves", async () => {
    install({})
    syncInternals.versionOf = never
    void ensure("s1")
    const t0 = performance.now()
    const one = settledOutcome("s1")
    const dtOne = performance.now() - t0
    expect(one).toBeUndefined()
    expect(one).not.toBeInstanceOf(Promise)
    expect(dtOne).toBeLessThan(5)

    const t1 = performance.now()
    for (let i = 0; i < 10_000; i++) settledOutcome("s1")
    expect(performance.now() - t1).toBeLessThan(200)

    await tick()
    expect(settledOutcome("s1")).toBeUndefined()
  })
})

// ───────────────────── P2: undefined means "not settled", never stale ─────────────────────
describe("P2 — undefined for in-flight AND never-attached; no premature or stale write", () => {
  test("never attached → undefined; attributableEngine(undefined) → false", () => {
    expect(settledOutcome("nobody")).toBeUndefined()
    expect(attributableEngine(undefined)).toBe(false)
  })

  test("no outcome table has a pending/in-flight kind that a caller could mistake for a verdict", () => {
    const kinds = Object.keys(SERVING).sort()
    expect(kinds).toEqual(
      [
        "attached",
        "reused",
        "disabled",
        "unbound",
        "engine-missing",
        "engine-too-old",
        "connect-failed",
        "entry-disabled",
        "superseded",
      ].sort(),
    )
    expect(Object.keys(INSTALL_HELPS).sort()).toEqual(kinds)
  })

  test("nothing is written to the memo before run() returns — probed at MCP.add and at the final notify", async () => {
    const h = install({ statuses: [{}, connected], tools: { datamate_dbt_build_model: 1 } })
    const seen: Array<Outcome | undefined> = []
    const add = syncInternals.mcp!.add
    syncInternals.mcp!.add = async (n, c) => {
      seen.push(settledOutcome("s1"))
      await add(n, c)
    }
    syncInternals.notify = async (t) => {
      seen.push(settledOutcome("s1"))
      h.toasts.push(t)
    }
    const outcome = await ensure("s1")
    expect(outcome).toMatchObject({ kind: "attached" })
    expect(seen).toEqual([undefined, undefined])
    expect(settledOutcome("s1")).toBe(outcome)
  })

  test("a re-link re-attach does NOT carry the previous session outcome forward while the new attach is in flight", async () => {
    let current: CachedBinding | null = binding // 42
    const h = install({
      statuses: [{}, connected, connected, connected],
      tools: { datamate_dbt_build_model: 1 },
    })
    syncInternals.resolveBinding = async () => current
    const first = await ensure("s1")
    expect(first).toMatchObject({ kind: "attached" })
    expect(settledOutcome("s1")).toBe(first)

    // Project re-linked to 99; the replacement spawn hangs at the version probe.
    current = { ...binding, datamateId: 99, datamateName: "other" } as CachedBinding
    syncInternals.versionOf = never
    void ensure("s1")
    // The dangerous reading would be `attached` (42's engine) under binding 99.
    expect(settledOutcome("s1")).toBeUndefined()
    await tick()
    expect(settledOutcome("s1")).toBeUndefined()
    expect(attributableEngine(settledOutcome("s1"))).toBe(false)
    // and the 42 client was already torn down by the re-attach's rejection
    expect(h.removes).toContain("datamate")
  })

  test("a concurrent second ensure for the same session while the first is in flight stays undefined until settle", async () => {
    install({ statuses: [{}, connected], tools: { datamate_dbt_build_model: 1 } })
    let release: (v: string | null) => void = () => {}
    syncInternals.versionOf = () => new Promise<string | null>((r) => (release = r))
    const a = ensure("s1")
    await tick(5)
    const b = ensure("s1") // turn 2 while turn 1 is still probing
    expect(settledOutcome("s1")).toBeUndefined()
    release("0.7.0")
    const [oa, ob] = await Promise.all([a, b])
    expect(oa).toMatchObject({ kind: "attached" })
    expect(ob).toBe(oa)
    expect(settledOutcome("s1")).toBe(oa)
  })

  test("OBSERVATION: on every later turn the memo is replaced by a fresh entry, so the seam reads undefined during re-validation", async () => {
    const h = install({ statuses: [{}, connected, connected, connected], tools: { datamate_dbt_build_model: 1 } })
    const first = await ensure("s1")
    expect(settledOutcome("s1")).toBe(first)
    // Turn 2, same binding, engine still live → the memo path.
    const t = ensure("s1")
    const during = settledOutcome("s1")
    const after = await t
    expect(after).toBe(first)
    expect(settledOutcome("s1")).toBe(first)
    // Record what the window reads. `undefined` = fail-open (shadowing off) for the
    // duration of the awaited re-validation; not a mis-route.
    expect(during).toBeUndefined()
    expect(h.added).toHaveLength(1)
  })
})

// ───────────────────────────── P3: allowlist {attached, reused} ─────────────────────────────
describe("P3 — the allowlist is exactly {attached, reused}", () => {
  test("SERVING is true for exactly the consumer's two kinds", () => {
    const serving = Object.entries(SERVING)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .sort()
    expect(serving).toEqual(["attached", "reused"])
  })

  test("the consumer's inline allowlist and attributableEngine agree on every kind", () => {
    for (const kind of Object.keys(SERVING) as Array<Outcome["kind"]>) {
      const outcome = { kind } as Outcome
      const consumer = outcome.kind === "attached" || outcome.kind === "reused"
      expect(attributableEngine(outcome), kind).toBe(consumer)
    }
  })

  test("`attached` with `replaced` set describes the NEW pinned spawn, not the displaced entry", async () => {
    const h = install({
      existing: { command: "datamate", args: ["start-stdio"] }, // the extension's unpinned entry, live
      statuses: [connected, connected],
      tools: { datamate_dbt_build_model: 1 },
    })
    await ensure("s1")
    const out = settledOutcome("s1")
    expect(out).toMatchObject({ kind: "attached", replaced: "datamate start-stdio" })
    // the engine serving this session is the pinned spawn; the unpinned one was closed first
    expect(h.removes).toEqual(["datamate"])
    expect(h.added).toHaveLength(1)
    expect(h.added[0].cfg.command).toEqual(["datamate", "start-stdio", "--datamate", "42"])
  })
})

// ─────────────────────── P4: describes the engine serving THIS session ───────────────────────
describe("P4 — the outcome describes the engine actually serving this session", () => {
  test("`reused` is only emitted when the live entry's pin equals this binding; any other pin is replaced", async () => {
    const cases: Array<{ name: string; entry: ExistingEntry; want: "reused" | "attached" }> = [
      { name: "pinned to us", entry: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] }, want: "reused" },
      { name: "unpinned (extension entry)", entry: { command: "datamate", args: ["start-stdio"] }, want: "attached" },
      { name: "pinned elsewhere", entry: { type: "local", command: ["datamate", "start-stdio", "--datamate", "7"] }, want: "attached" },
      { name: "pinned elsewhere, = spelling", entry: { type: "local", command: ["datamate", "start-stdio", "--datamate=7"] }, want: "attached" },
      { name: "pinned to us then overridden elsewhere (last wins)", entry: { type: "local", command: ["datamate", "--datamate", "42", "--datamate", "7"] }, want: "attached" },
      { name: "pinned elsewhere then to us (last wins)", entry: { type: "local", command: ["datamate", "--datamate", "7", "--datamate=42"] }, want: "reused" },
      { name: "connected URL", entry: { type: "remote", url: "https://api.altimate.ai/sse" }, want: "attached" },
    ]
    for (const c of cases) {
      resetForTests()
      const h = install({ existing: c.entry, statuses: [connected, connected], tools: { datamate_dbt_build_model: 1 } })
      await ensure(`s-${c.name}`)
      const out = settledOutcome(`s-${c.name}`)
      expect(out?.kind, c.name).toBe(c.want)
      if (c.want === "attached") {
        expect(h.added[0]?.cfg.command, c.name).toEqual(["datamate", "start-stdio", "--datamate", "42"])
      } else {
        expect(h.added, c.name).toHaveLength(0)
      }
    }
  })

  test("a re-link during the REUSE lookup settles as `superseded` in the memo, not `reused`, and detaches", async () => {
    let current: CachedBinding | null = binding
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] },
      statuses: [connected],
      tools: { datamate_dbt_build_model: 1 },
    })
    syncInternals.resolveBinding = async () => current
    syncInternals.declared = async () => {
      current = { ...binding, datamateId: 99, datamateName: "other" } as CachedBinding
      return { keys: ["dbt_build_model"], extensionKeys: [] }
    }
    await ensure("s1")
    expect(settledOutcome("s1")).toEqual({ kind: "superseded" })
    expect(attributableEngine(settledOutcome("s1"))).toBe(false)
    expect(h.removes).toContain("datamate")
  })

  test("a re-link after the SPAWN's add settles as `superseded` in the memo, not `attached`", async () => {
    let current: CachedBinding | null = binding
    const h = install({ statuses: [{}, connected], tools: { datamate_dbt_build_model: 1 } })
    syncInternals.resolveBinding = async () => current
    const add = syncInternals.mcp!.add
    syncInternals.mcp!.add = async (n, c) => {
      await add(n, c)
      current = { ...binding, datamateId: 99, datamateName: "other" } as CachedBinding
    }
    await ensure("s1")
    expect(settledOutcome("s1")).toEqual({ kind: "superseded" })
    expect(h.removes).toContain("datamate")
    expect(h.restores.length).toBeGreaterThan(0)
  })

  test("`superseded` is repairable: the next turn re-attaches rather than riding the memo", async () => {
    let current: CachedBinding | null = binding
    const h = install({ statuses: [{}, connected, {}, connected], tools: { datamate_dbt_build_model: 1 } })
    syncInternals.resolveBinding = async () => current
    let flipOnce = true
    const add = syncInternals.mcp!.add
    syncInternals.mcp!.add = async (n, c) => {
      await add(n, c)
      if (flipOnce) {
        flipOnce = false
        current = { ...binding, datamateId: 99, datamateName: "other" } as CachedBinding
      }
    }
    expect(await ensure("s1")).toEqual({ kind: "superseded" })
    expect(await ensure("s1")).toMatchObject({ kind: "attached" })
    expect(h.added[h.added.length - 1].cfg.command).toEqual(["datamate", "start-stdio", "--datamate", "99"])
    expect(settledOutcome("s1")).toMatchObject({ kind: "attached" })
  })

  test("a memoised `attached` is dropped when the config pin moves under it (A→B→A with another session serving B)", async () => {
    let pin = "42"
    install({ statuses: [{}, connected, connected, {}, connected], tools: { datamate_dbt_build_model: 1 } })
    syncInternals.existingEntry = async () => ({ type: "local", command: ["datamate", "start-stdio", "--datamate", pin] })
    const first = await ensure("s1")
    expect(first).toMatchObject({ kind: "attached" })
    pin = "99" // the instance-wide client now serves B
    const t = ensure("s1")
    expect(settledOutcome("s1")).toBeUndefined()
    const second = await t
    expect(second).not.toBe(first)
  })

  test("OBSERVATION: the pin compared is the CONFIG entry's; MCP.status carries no argv, so a config-only rewrite is indistinguishable from a reconnect", async () => {
    // Harness: config says pinned-to-42 and status says connected. Nothing in
    // run() can tell whether the connected process was launched with that argv.
    install({
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] },
      statuses: [connected],
      tools: { datamate_dbt_build_model: 1 },
    })
    await ensure("s1")
    expect(settledOutcome("s1")).toMatchObject({ kind: "reused" })
  })
})

// ───────────────────────────── P5: keyed by session ID ─────────────────────────────
describe("P5 — keyed by session ID", () => {
  test("two sessions in one project hold distinct outcomes", async () => {
    const h = install({ statuses: [{}, connected, connected, connected], tools: { datamate_dbt_build_model: 1 } })
    await ensure("s1") // spawns → attached
    await ensure("s2") // finds the persisted pinned entry live → reused
    expect(settledOutcome("s1")).toMatchObject({ kind: "attached" })
    expect(settledOutcome("s2")).toMatchObject({ kind: "reused" })
    expect(settledOutcome("s3")).toBeUndefined()
    expect(h.added).toHaveLength(1)
  })

  test("keys are session ids, not project/binding: a refused session does not overwrite a served one", async () => {
    install({ statuses: [{}, connected, connected], tools: { datamate_dbt_build_model: 1 } })
    await ensure("s1")
    expect(settledOutcome("s1")).toMatchObject({ kind: "attached" })
    // s2 in the same project sees the entry disabled → refuses (and tears down).
    syncInternals.existingEntry = async () => ({ type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled: false })
    await ensure("s2")
    expect(settledOutcome("s2")).toEqual({ kind: "entry-disabled" })
    expect(settledOutcome("s1")).toMatchObject({ kind: "attached" })
  })

  test("OBSERVATION: eviction can drop a settled outcome while the session is live (fails open)", async () => {
    install({ statuses: [{}, connected], tools: { datamate_dbt_build_model: 1 } })
    await ensure("s1")
    expect(settledOutcome("s1")).toMatchObject({ kind: "attached" })
    syncInternals.resolveBinding = async () => null
    for (let i = 0; i < MAX_TRACKED_SESSIONS; i++) await ensure(`other-${i}`)
    expect(trackedSessionsForTests()).toBeLessThanOrEqual(MAX_TRACKED_SESSIONS)
    expect(settledOutcome("s1")).toBeUndefined()
  })

  test("OBSERVATION: another session's teardown leaves this session's settled `attached` stale until its next turn", async () => {
    const h = install({ statuses: [{}, connected, connected, connected], tools: { datamate_dbt_build_model: 1 } })
    await ensure("s1")
    syncInternals.existingEntry = async () => ({ type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled: false })
    await ensure("s2") // honours the disable: removes the instance-wide client
    expect(h.removes).toEqual(["datamate"])
    expect(settledOutcome("s1")).toMatchObject({ kind: "attached" }) // stale: client is gone
    // s1's next turn re-decides
    h.statusQueue = [{ datamate: { status: "disabled" } }]
    expect(await ensure("s1")).toEqual({ kind: "entry-disabled" })
  })
})

// ───────────────────────────── P6: pinnedWorkspace table ─────────────────────────────
describe("P6 — pinnedWorkspace over every argv shape", () => {
  const table: Array<{ name: string; entry: unknown; want: string | null | "THROWS" }> = [
    // contract shapes
    { name: "opencode argv, two tokens", entry: { type: "local", command: ["datamate", "start-stdio", "--datamate", "5"] }, want: "5" },
    { name: "IDE {command,args}, two tokens", entry: { command: "datamate", args: ["start-stdio", "--datamate", "5"] }, want: "5" },
    { name: "IDE {command,args}, = spelling", entry: { command: "datamate", args: ["start-stdio", "--datamate=5"] }, want: "5" },
    { name: "opencode argv, = spelling", entry: { type: "local", command: ["datamate", "start-stdio", "--datamate=5"] }, want: "5" },
    { name: "repeated two-token, last wins", entry: { type: "local", command: ["datamate", "--datamate", "5", "--datamate", "9"] }, want: "9" },
    { name: "repeated = then two-token, last wins", entry: { type: "local", command: ["datamate", "--datamate=5", "--datamate", "9"] }, want: "9" },
    { name: "repeated two-token then =, last wins", entry: { type: "local", command: ["datamate", "--datamate", "5", "--datamate=9"] }, want: "9" },
    { name: "pin split across command and args", entry: { command: ["datamate", "start-stdio", "--datamate"], args: ["5"] }, want: "5" },
    { name: "no pin", entry: { type: "local", command: ["datamate", "start-stdio"] }, want: null },
    { name: "null entry", entry: null, want: null },
    { name: "URL entry", entry: { type: "remote", url: "http://localhost:7801/sse" }, want: null },
    { name: "empty command", entry: { type: "local", command: [] }, want: null },
    // dangling / empty
    { name: "--datamate as last token, no value", entry: { type: "local", command: ["datamate", "start-stdio", "--datamate"] }, want: null },
    { name: "earlier pin then dangling --datamate (engine would refuse to start)", entry: { type: "local", command: ["datamate", "--datamate", "5", "--datamate"] }, want: null },
    { name: "--datamate= empty", entry: { type: "local", command: ["datamate", "--datamate="] }, want: null },
    { name: "--datamate=5 then --datamate= (engine: last wins = empty)", entry: { type: "local", command: ["datamate", "--datamate=5", "--datamate="] }, want: null },
    // odd values
    { name: "non-numeric value", entry: { type: "local", command: ["datamate", "--datamate", "abc"] }, want: "abc" },
    { name: "value that looks like a flag (commander: argument missing)", entry: { type: "local", command: ["datamate", "--datamate", "--verbose"] }, want: "--verbose" },
    { name: "quoted value inside the token", entry: { type: "local", command: ["datamate", "--datamate=\"5\""] }, want: "\"5\"" },
    { name: "value with surrounding whitespace", entry: { type: "local", command: ["datamate", "--datamate", " 5"] }, want: " 5" },
    { name: "=-value containing another =", entry: { type: "local", command: ["datamate", "--datamate=5=6"] }, want: "5=6" },
    { name: "leading-zero id", entry: { type: "local", command: ["datamate", "--datamate", "05"] }, want: "05" },
    // near-miss flag names
    { name: "--datamate-id is not the pin flag", entry: { type: "local", command: ["datamate", "--datamate-id", "5"] }, want: null },
    { name: "--datamatex=5 is not the pin flag", entry: { type: "local", command: ["datamate", "--datamatex=5"] }, want: null },
    { name: "case differs (commander is case-sensitive too)", entry: { type: "local", command: ["datamate", "--DATAMATE", "5"] }, want: null },
    { name: "single-dash", entry: { type: "local", command: ["datamate", "-datamate", "5"] }, want: null },
    // the flag inside another token / shell wrappers
    { name: "shell -c wrapper, whole command in one token", entry: { type: "local", command: ["sh", "-c", "datamate start-stdio --datamate 5"] }, want: null },
    { name: "cmd /c wrapper", entry: { type: "local", command: ["cmd", "/c", "datamate start-stdio --datamate 5"] }, want: null },
    { name: "IDE command string with spaces and no args", entry: { command: "datamate start-stdio --datamate 5" }, want: null },
    { name: "npx wrapper still parses the pin", entry: { type: "local", command: ["npx", "-y", "@altimateai/datamate", "start-stdio", "--datamate", "5"] }, want: "5" },
    { name: "pin as the VALUE of another flag (--config-file --datamate 5)", entry: { type: "local", command: ["datamate", "--config-file", "--datamate", "5"] }, want: "5" },
    { name: "pin only via environment, not argv", entry: { type: "local", command: ["datamate", "start-stdio"], environment: { DATAMATE_ID: "5" } }, want: null },
    { name: "URL entry that also carries args", entry: { type: "remote", url: "http://x/sse", args: ["--datamate", "5"] }, want: "5" },
    // defensive-read shapes (merged config written by other clients)
    { name: "args as a string, not an array", entry: { command: "datamate", args: "start-stdio --datamate 5" }, want: null },
    { name: "numeric token in argv (raw disk JSON)", entry: { type: "local", command: ["datamate", "start-stdio", "--datamate", 5] }, want: "THROWS" },
    { name: "null token BEFORE the last pin is never reached (scan from the end)", entry: { type: "local", command: ["datamate", null, "--datamate", "5"] }, want: "5" },
    { name: "null token AFTER the last pin throws", entry: { type: "local", command: ["datamate", "--datamate", "5", null] }, want: "THROWS" },
    { name: "numeric token AFTER the last pin throws", entry: { type: "local", command: ["datamate", "--datamate", "5", 7] }, want: "THROWS" },
    { name: "command is an object", entry: { type: "local", command: {} }, want: "THROWS" },
  ]

  for (const row of table) {
    test(row.name, () => {
      if (row.want === "THROWS") {
        expect(() => pinnedWorkspace(row.entry as never)).toThrow()
      } else {
        expect(pinnedWorkspace(row.entry as never)).toBe(row.want)
      }
    })
  }

  test("the consumer's comparison: pin vs String(datamateId)", () => {
    const pin = pinnedWorkspace({ type: "local", command: ["datamate", "--datamate", "5"] })
    expect(pin !== null && pin !== String(5)).toBe(false)
    expect(pin !== null && pin !== String("5")).toBe(false)
    const quoted = pinnedWorkspace({ type: "local", command: ["datamate", "--datamate=\"5\""] })
    expect(quoted !== null && quoted !== String(5)).toBe(true) // treated as pinned elsewhere
  })
})

// ───────────── 2d8bea2d0: the connect-retry re-inspection vs the memo ─────────────
describe("the retry re-inspects, and never writes the memo early or twice", () => {
  // ADAPTED ON LIFT. These were written against `MCP.connect`, which the retry
  // no longer uses: connect writes `enabled: true` into whichever config owns
  // the entry, so a local repair became a global config write, and it started
  // whatever MCP had retained rather than the entry the decision examined. The
  // retry re-adds instead. The PROPERTIES here are unchanged — re-inspect whole,
  // judge on the post-retry entry, write the memo exactly once — only the seam
  // that stands in for "the retry happened" has moved from `connect` to `add`.
  test("two inspections, one status per inspection, memo written exactly once, after the retry settles", async () => {
    const reads: Array<Outcome | undefined> = []
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] },
      statuses: [{ datamate: { status: "failed", error: "exit 1" } }, connected],
      tools: { datamate_dbt_build_model: 1 },
    })
    let entryReads = 0
    let statusReads = 0
    syncInternals.existingEntry = async () => {
      entryReads += 1
      reads.push(settledOutcome("s1"))
      return { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] }
    }
    const status = syncInternals.mcp!.status
    syncInternals.mcp!.status = async () => {
      statusReads += 1
      reads.push(settledOutcome("s1"))
      return status()
    }
    const add = syncInternals.mcp!.add
    syncInternals.mcp!.add = async (n, cfg) => {
      reads.push(settledOutcome("s1"))
      return add(n, cfg)
    }
    const outcome = await ensure("s1")
    expect(outcome).toMatchObject({ kind: "reused" })
    expect(h.connects, "repaired with the config-writing primitive").toHaveLength(0)
    expect(h.added, "the retry restarts the entry exactly once").toHaveLength(1)
    // Three: the inspection, the pre-revive world check's intent read, and the
    // re-inspection. The middle one is the guard confirming intent immediately
    // before starting a process — a mutation, and mutations re-read.
    expect(entryReads).toBe(3)
    expect(statusReads).toBe(2)
    expect(reads.every((r) => r === undefined)).toBe(true) // nothing observable mid-run
    expect(settledOutcome("s1")).toBe(outcome)
  })

  test("the pin is judged on the POST-retry entry", async () => {
    // One case changed verdict when attribution moved above connectivity, and it
    // changed for the better: an UNPINNED entry is no longer revived and then
    // discovered to be unattributable — it is replaced without being started at
    // all, so the retry never runs for it. The retry is for OUR engine.
    const cases: Array<{ name: string; before: ExistingEntry; after: ExistingEntry; want: "reused" | "attached" }> = [
      {
        name: "unpinned → never retried, replaced outright",
        before: { type: "local", command: ["datamate", "start-stdio"] },
        after: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] },
        want: "attached",
      },
      {
        name: "pinned 42 → unpinned",
        before: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] },
        after: { type: "local", command: ["datamate", "start-stdio"] },
        want: "attached",
      },
      {
        name: "pinned 42 → pinned 7",
        before: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] },
        after: { type: "local", command: ["datamate", "start-stdio", "--datamate", "7"] },
        want: "attached",
      },
      {
        name: "pinned 42 → pinned 42",
        before: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] },
        after: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] },
        want: "reused",
      },
    ]
    for (const c of cases) {
      resetForTests()
      let retried = false
      const h = install({
        statuses: [{ datamate: { status: "failed", error: "exit 1" } }, connected, connected],
        tools: { datamate_dbt_build_model: 1 },
      })
      syncInternals.existingEntry = async () => (retried ? c.after : c.before)
      const add = syncInternals.mcp!.add
      syncInternals.mcp!.add = async (n, cfg) => {
        retried = true
        return add(n, cfg)
      }
      await ensure(`s-${c.name}`)
      const out = settledOutcome(`s-${c.name}`)
      expect(out?.kind, c.name).toBe(c.want)
      if (c.want === "attached") {
        expect(h.added.at(-1)?.cfg.command, c.name).toEqual(["datamate", "start-stdio", "--datamate", "42"])
      }
    }
  })

  test("a disable that lands during the retry is honoured on re-inspection and torn down", async () => {
    let retried = false
    const h = install({
      statuses: [{ datamate: { status: "failed", error: "exit 1" } }, connected],
      tools: { datamate_dbt_build_model: 1 },
    })
    syncInternals.existingEntry = async () =>
      retried
        ? { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled: false }
        : { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] }
    const add = syncInternals.mcp!.add
    syncInternals.mcp!.add = async (n, cfg) => {
      retried = true
      return add(n, cfg)
    }
    await ensure("s1")
    expect(settledOutcome("s1")).toEqual({ kind: "entry-disabled" })
    expect(h.removes).toEqual(["datamate"])
    expect(h.persisted, "wrote config while honouring a disable").toHaveLength(0)
  })
})
