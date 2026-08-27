// Gate L4 attack tests — each test asserts the teardown property the lens
// requires; a FAILING test here is a demonstrated gap.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ensure, resetForTests, syncInternals, type LocalMcpConfig } from "../../../src/altimate/workspace/engine-sync"
import type { CachedBinding } from "../../../src/altimate/workspace/state"
import type { ExistingEntry } from "../../../src/altimate/workspace/engine-sync"

const ORIGINAL_FLAG = process.env.ALTIMATE_WORKSPACE
const binding: CachedBinding = {
  datamateId: 42,
  datamateName: "analytics",
  repoRemote: "git@github.com:acme/analytics.git",
  projectPath: "/tmp/analytics",
} as CachedBinding
const other = { ...binding, datamateId: 99, datamateName: "other" } as CachedBinding

type H = {
  added: Array<{ name: string; cfg: LocalMcpConfig }>
  persisted: Array<{ name: string; cfg: LocalMcpConfig }>
  connects: string[]
  removes: string[]
  toasts: Array<{ title: string; message: string; variant: string }>
  restores: Array<unknown>
  statusQueue: Array<Record<string, { status: string; error?: string } | undefined>>
  tools: Record<string, unknown>
}
function install(opts: {
  which?: string | null
  version?: string | null | ((bin: string) => string | null)
  statuses?: H["statusQueue"]
  tools?: Record<string, unknown>
  existing?: ExistingEntry | null
  projectEntry?: ExistingEntry | null
}): H {
  const h: H = { added: [], persisted: [], connects: [], removes: [], toasts: [], restores: [], statusQueue: opts.statuses ?? [{}], tools: opts.tools ?? {} }
  syncInternals.resolveBinding = async () => binding
  syncInternals.which = () => (opts.which === undefined ? "/usr/local/bin/datamate" : opts.which)
  syncInternals.versionOf = async (bin) => (typeof opts.version === "function" ? opts.version(bin) : opts.version === undefined ? "0.7.0" : opts.version)
  syncInternals.declared = async () => ({ keys: ["dbt_build_model"], extensionKeys: [] })
  syncInternals.persist = async (name, cfg) => { h.persisted.push({ name, cfg }) }
  syncInternals.existingEntry = async () => {
    if (opts.existing !== undefined) return opts.existing
    const last = h.persisted[h.persisted.length - 1]
    return last ? ({ type: "local", command: last.cfg.command, enabled: true } as ExistingEntry) : null
  }
  syncInternals.projectEntry = async () => opts.projectEntry ?? null
  syncInternals.notify = async (t) => { h.toasts.push(t) }
  syncInternals.toolsChanged = async () => {}
  syncInternals.persistRestore = async (_n, prev) => { h.restores.push(prev ?? null) }
  syncInternals.mcp = {
    status: async () => (h.statusQueue.length > 1 ? h.statusQueue.shift()! : h.statusQueue[0]!),
    add: async (name, cfg) => { h.added.push({ name, cfg }) },
    connect: async (name) => { h.connects.push(name) },
    remove: async (name) => { h.removes.push(name) },
    tools: async () => h.tools,
  }
  // The project file has no entry of its own unless a test says otherwise.
  // Required since the project reader stopped swallowing its own errors.
  if (!syncInternals.projectEntry) syncInternals.projectEntry = async () => null
  if (!syncInternals.projectConfigPath)
    syncInternals.projectConfigPath = async () => "/tmp/test/.altimate-code/altimate-code.json"
  return h
}
beforeEach(() => { process.env.ALTIMATE_WORKSPACE = "1"; resetForTests() })
afterEach(() => {
  for (const k of Object.keys(syncInternals) as Array<keyof typeof syncInternals>) delete syncInternals[k]
  if (ORIGINAL_FLAG === undefined) delete process.env.ALTIMATE_WORKSPACE
  else process.env.ALTIMATE_WORKSPACE = ORIGINAL_FLAG
})

describe("A/B — detachRejected is gated on stillCurrent, so a supersede skips the runtime teardown", () => {
  test("A: entry DISABLED + connected, re-link lands between status() and refuse → client left serving", async () => {
    let current: CachedBinding | null = binding
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled: false },
      statuses: [{ datamate: { status: "connected" } }],
    })
    syncInternals.resolveBinding = async () => current
    const prevStatus = syncInternals.mcp!.status
    syncInternals.mcp!.status = async () => { const s = await prevStatus(); current = other; return s }
    const outcome = await ensure("s1")
    // ADAPTED ON LIFT: the teardown is the property and it holds. The answer is
    // `superseded` because a refusal is an answer too, and this one would have
    // described a workspace the project had already left.
    expect(outcome).toEqual({ kind: "superseded" })
    expect(h.removes, "disabled entry reported but its live client was NOT removed (detachRejected skipped on supersede)").toContain("datamate")
  })
  test("B: pinned-to-us, below floor, nothing better on PATH, re-link lands in versionOf → too-old client left serving", async () => {
    let current: CachedBinding | null = binding
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] },
      statuses: [{ datamate: { status: "connected" } }],
      version: () => { current = other; return "0.5.0" },
    })
    syncInternals.resolveBinding = async () => current
    const outcome = await ensure("s1")
    // ADAPTED ON LIFT: as above — teardown holds, the answer is `superseded`.
    expect(outcome).toMatchObject({ kind: "superseded" })
    expect(h.removes, "too-old engine reported but left registered (detachRejected skipped on supersede)").toContain("datamate")
  })
})

describe("D — connect-failed AFTER install never restores what persist() replaced", () => {
  test("user's hand-authored PROJECT entry is overwritten by our pin; spawn fails; nothing puts it back", async () => {
    const users: ExistingEntry = { type: "local", command: ["datamate", "start-stdio"] } // unpinned, in project file, live
    const h = install({
      existing: users,
      projectEntry: users,
      statuses: [{ datamate: { status: "connected" } }, { datamate: { status: "failed", error: "exit 1" } }],
    })
    const outcome = await ensure("s1")
    // ADAPTED ON LIFT: the finding is fixed. The install region gives back both
    // halves on every non-attached exit, so a failed spawn puts the user's own
    // entry back instead of leaving our pin over it.
    expect(outcome).toMatchObject({ kind: "connect-failed" })
    expect(h.persisted.map((p) => p.cfg.command)).toEqual([["datamate", "start-stdio", "--datamate", "42"]])
    expect(h.restores, "the failed spawn left our pin over the user's project entry").toEqual([users])
  })
})

describe("F — connect-failed after install, superseded: stale pin stays on disk and wedges the new workspace", () => {
  test("turn 1: install 42, re-link to 99 during add, spawn fails → refuse() without undoInstall", async () => {
    let current: CachedBinding | null = binding
    const h = install({ statuses: [{}, { datamate: { status: "failed", error: "exit 1" } }] })
    syncInternals.resolveBinding = async () => current
    const prevAdd = syncInternals.mcp!.add
    syncInternals.mcp!.add = async (n, c) => { await prevAdd(n, c); current = other }
    const outcome = await ensure("s1")
    // ADAPTED ON LIFT: the finding is fixed. A failed spawn is a non-attached
    // exit, so the region gives back the pin it wrote — it does not survive to
    // wedge the next turn.
    // The re-link lands during the add, so the refusal revalidates and declines
    // to answer for the workspace the project has left.
    expect(outcome).toMatchObject({ kind: "superseded" })
    expect(h.restores.length, "the failed spawn's pin was left on disk to wedge the next turn").toBeGreaterThan(0)
  })
  test("turn 2 under binding 99: the failing 42 pin is retried once and refused — 99 never spawns", async () => {
    let current: CachedBinding | null = binding
    const h = install({
      statuses: [
        {}, // turn 1 initial
        { datamate: { status: "failed", error: "exit 1" } }, // turn 1 after add
        { datamate: { status: "failed", error: "exit 1" } }, // turn 2 initial
        { datamate: { status: "failed", error: "exit 1" } }, // turn 2 after retry
      ],
    })
    syncInternals.resolveBinding = async () => current
    const prevAdd = syncInternals.mcp!.add
    syncInternals.mcp!.add = async (n, c) => { await prevAdd(n, c); current = other }
    // ADAPTED ON LIFT: the finding is fixed on both counts. Turn 1's re-link
    // during the add makes the refusal decline to answer for the workspace just
    // left, and its pin is given back rather than left to wedge turn 2. Turn 2
    // then judges 42's pin unattributable under binding 99 and REPLACES it
    // instead of retrying it, so 99 gets its engine. `connect-failed` on turn 2
    // is the fixture's own doing: its status queue reports the freshly spawned
    // engine as failed too.
    expect(await ensure("s1")).toMatchObject({ kind: "superseded" })
    syncInternals.mcp!.add = prevAdd
    const second = await ensure("s1")
    expect(second).toMatchObject({ kind: "connect-failed" })
    expect(h.connects, "revived an engine belonging to another workspace").toHaveLength(0)
    expect(h.added.map((a) => a.cfg.command), "workspace 99 never gets an engine: the stale failing 42 pin blocks it every turn").toContainEqual(["datamate", "start-stdio", "--datamate", "99"])
  })
})

describe("E — a throw after install bypasses undoInstall entirely", () => {
  test("re-link during add, then tools() throws → engine for 42 stays installed under binding 99, outcome connect-failed", async () => {
    let current: CachedBinding | null = binding
    const h = install({ statuses: [{}, { datamate: { status: "connected" } }] })
    syncInternals.resolveBinding = async () => current
    const prevAdd = syncInternals.mcp!.add
    syncInternals.mcp!.add = async (n, c) => { await prevAdd(n, c); current = other }
    syncInternals.mcp!.tools = async () => { throw new Error("tools listing exploded") }
    const outcome = await ensure("s1")
    // ADAPTED ON LIFT: a throw no longer unwinds past the undo — the region is
    // shaped so any non-attached exit, including one nobody wrote, gives back
    // both halves.
    expect(outcome).toMatchObject({ kind: "connect-failed" })
    expect(h.added.map((a) => a.cfg.command)).toEqual([["datamate", "start-stdio", "--datamate", "42"]])
    expect(h.removes, "a throw left the client registered").toContain("datamate")
    expect(h.restores, "a throw left our pin on disk").toHaveLength(1)
  })
})

describe("C — retry-connect calls MCP.connect on a global-only entry (persists enabled:true into the owning file)", () => {
  test("a down, enabled, IDE-shaped entry is retried via MCP.connect", async () => {
    const h = install({
      existing: { command: "datamate", args: ["start-stdio"] }, // IDE shape, no `enabled` field, lives in global
      statuses: [{ datamate: { status: "failed", error: "exit 1" } }, { datamate: { status: "connected" } }],
    })
    await ensure("s1")
    // ADAPTED ON LIFT: the finding is fixed. Repairing a down IDE-shaped entry
    // used `MCP.connect`, which persists `enabled: true` into the file that owns
    // the entry — a global write from a local decision. It re-adds now.
    expect(h.connects, "repaired a global entry by writing to it").toHaveLength(0)
  })
})

describe("F3 — the general wedge: a persisted pin that later fails blocks the NEW workspace forever", () => {
  test("clean attach of 42; user re-links to 99; 42's engine is now down → retried once, refused; 99 never spawns", async () => {
    let current: CachedBinding | null = binding
    const h = install({
      statuses: [
        {}, // turn 1 initial
        { datamate: { status: "connected" } }, // turn 1 after add
        { datamate: { status: "failed", error: "exit 1" } }, // turn 2 initial (42's engine died)
        { datamate: { status: "failed", error: "exit 1" } }, // turn 2 after retry
      ],
      tools: { datamate_dbt_build_model: 1 },
    })
    syncInternals.resolveBinding = async () => current
    expect(await ensure("s1")).toMatchObject({ kind: "attached" })
    current = other
    const second = await ensure("s1")
    // ADAPTED ON LIFT: the wedge is fixed. 42's pin is unattributable under
    // binding 99, so it is replaced rather than retried, and 99 gets its engine.
    // `connect-failed` here is the fixture's own doing — the status queue reports
    // the freshly spawned engine as failed too.
    expect(second).toMatchObject({ kind: "connect-failed" })
    expect(h.connects, "revived an engine belonging to another workspace").toHaveLength(0)
    expect(h.added.map((a) => a.cfg.command), "99 blocked behind the failing 42 pin").toContainEqual(["datamate", "start-stdio", "--datamate", "99"])
  })
})

describe("G — refuse() order at 2d8bea2d0: teardown runs BEFORE announceRefusal; a throwing announce relabels the outcome", () => {
  test("disabled+connected entry, notify seam throws: client IS removed (teardown first), but outcome becomes connect-failed and a 2nd toast fires", async () => {
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled: false },
      statuses: [{ datamate: { status: "connected" } }],
    })
    let notifyCalls = 0
    syncInternals.notify = async (t) => {
      notifyCalls += 1
      if (notifyCalls === 1) throw new Error("dialog surface exploded")
      h.toasts.push(t)
    }
    const outcome = await ensure("s1")
    expect(h.removes, "teardown did not run before the announce").toContain("datamate")
    // ADAPTED ON LIFT: the finding is fixed. A throwing announce no longer
    // reaches the catch-all, so the verdict stands and no second toast fires.
    expect(notifyCalls, "a failed announcement was retried through a second toast site").toBe(1)
    expect(outcome.kind, "a throwing announce relabels entry-disabled as connect-failed").toBe("entry-disabled")
  })
})
