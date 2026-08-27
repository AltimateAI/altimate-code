// altimate_change - new file
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { ensure, resetForTests, syncInternals, type LocalMcpConfig, settledOutcome } from "../../../src/altimate/workspace/engine-sync"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Config } from "../../../src/config/config"
import { Filesystem } from "../../../src/util/filesystem"
import { addMcpToConfig, readMcpEntryFromDisk } from "../../../src/mcp/config"
import type { CachedBinding } from "../../../src/altimate/workspace/state"
import type { ExistingEntry } from "../../../src/altimate/workspace/engine-sync"

describe("every exit gives back what it took", () => {
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
    // Mirrors production: once this attach has persisted, the project file holds
    // OUR entry — which is what the undo reads to decide whether what is there
    // is still its own work. A stub that always returns the pre-install value
    // models a file that never received the write.
    syncInternals.projectEntry = async () => {
      const last = h.persisted[h.persisted.length - 1]
      return last ? ({ ...last.cfg } as unknown as ExistingEntry) : (opts.projectEntry ?? null)
    }
    syncInternals.notify = async (t) => { h.toasts.push(t) }
    syncInternals.toolsChanged = async () => {}
    syncInternals.persistRestore = async (_n, prev) => { h.restores.push(prev ?? null) }
    syncInternals.mcp = {
      status: async () => (h.statusQueue.length > 1 ? h.statusQueue.shift()! : h.statusQueue[0]!),
      add: async (name, cfg) => { h.added.push({ name, cfg }) },
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

  describe("a supersede does not skip a teardown that does not depend on the binding", () => {
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
      // The answer is
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
      // Teardown holds; the answer is `superseded`.
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
      // The install region gives back both
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
      // A failed spawn is a non-attached
      // exit, so the region gives back the pin it wrote — it does not survive to
      // wedge the next turn.
      // The re-link lands during the add, so the refusal revalidates and declines
      // to answer for the workspace the project has left.
      expect(outcome).toMatchObject({ kind: "superseded" })
      // Both halves: the pin WAS written, and it was given back.
      expect(h.persisted.map((p) => p.cfg.command)).toEqual([["datamate", "start-stdio", "--datamate", "42"]])
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
      // Turn 1's re-link
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
      // A throw does not unwind past the undo — the
      // region gives back both halves on any non-attached exit, including one
      // nobody wrote. And because this throw lands AFTER a re-link, it is now the
      // same silent `superseded` as every other refusal for a workspace the
      // project has left: answering would name the wrong workspace, and toasting
      // about it would be worse.
      expect(outcome).toMatchObject({ kind: "superseded" })
      expect(h.toasts, "announced a failure for the workspace the project had left").toHaveLength(0)
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
      // Repairing a down
      // IDE-shaped entry used `MCP.connect`, which persists `enabled: true` into
      // the file that owns the entry — a global write from a local decision.
      //
      // Asserting only "connect was not called" is now vacuous, since the seam no
      // longer carries it. What earns its place is that the repair happened, with
      // the right primitive and the entry we judged, and wrote nothing.
      // And the scenario no longer reaches the repair at all: an IDE-shaped entry
      // is UNPINNED, so attribution replaces it before connectivity is ever
      // consulted. What lands is our own pinned entry, written to the project
      // config — not a global write to theirs, which was the defect.
      expect(h.added.map((a) => a.cfg.command)).toEqual([["datamate", "start-stdio", "--datamate", "42"]])
      expect(h.persisted.map((p) => p.cfg.command)).toEqual([["datamate", "start-stdio", "--datamate", "42"]])
    })
  })

  describe("a failing pin never blocks the workspace the project is bound to", () => {
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
      // 42's pin is unattributable under
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
      // A throwing announce no longer
      // reaches the catch-all, so the verdict stands and no second toast fires.
      expect(notifyCalls, "a failed announcement was retried through a second toast site").toBe(1)
      expect(outcome.kind, "a throwing announce relabels entry-disabled as connect-failed").toBe("entry-disabled")
    })
  })
})

describe("the undo obeys the world it undoes into", () => {
  const ORIGINAL_FLAG = process.env.ALTIMATE_WORKSPACE
  const binding: CachedBinding = { datamateId: 42, datamateName: "analytics", repoRemote: "x", projectPath: "/tmp/analytics" } as CachedBinding
  const other = { ...binding, datamateId: 99, datamateName: "other" } as CachedBinding
  type H = { trace: string[]; added: Array<{ name: string; cfg: LocalMcpConfig }>; persisted: Array<{ name: string; cfg: LocalMcpConfig }>; removes: string[]; toasts: Array<{ title: string; message: string; variant: string }>; restores: Array<unknown>; statusQueue: Array<Record<string, { status: string; error?: string } | undefined>>; tools: Record<string, unknown> }
  function install(opts: { which?: string | null; version?: string | null | ((bin: string) => string | null); statuses?: H["statusQueue"]; tools?: Record<string, unknown>; existing?: ExistingEntry | null | (() => ExistingEntry | null); projectEntry?: ExistingEntry | null | (() => ExistingEntry | null) }): H {
    const h: H = { trace: [], added: [], persisted: [], removes: [], toasts: [], restores: [], statusQueue: opts.statuses ?? [{}], tools: opts.tools ?? {} }
    const t = (s: string) => h.trace.push(s)
    syncInternals.resolveBinding = async () => (t("resolveBinding"), binding)
    syncInternals.which = () => (opts.which === undefined ? "/usr/local/bin/datamate" : opts.which)
    syncInternals.versionOf = async (bin) => (t("versionOf"), typeof opts.version === "function" ? opts.version(bin) : opts.version === undefined ? "0.7.0" : opts.version)
    syncInternals.declared = async () => (t("declared"), { keys: ["dbt_build_model"], extensionKeys: [] })
    syncInternals.persist = async (name, cfg) => { t("persist"); h.persisted.push({ name, cfg }) }
    syncInternals.existingEntry = async () => { t("existingEntry"); if (typeof opts.existing === "function") return opts.existing(); if (opts.existing !== undefined) return opts.existing; const last = h.persisted[h.persisted.length - 1]; return last ? ({ type: "local", command: last.cfg.command, enabled: true } as ExistingEntry) : null }
    syncInternals.projectEntry = async () => { t("projectEntry"); return typeof opts.projectEntry === "function" ? opts.projectEntry() : (opts.projectEntry ?? null) }
    syncInternals.projectConfigPath = async () => "/tmp/test/.altimate-code/altimate-code.json"
    syncInternals.notify = async (tt) => { t("notify"); h.toasts.push(tt) }
    syncInternals.toolsChanged = async () => { t("toolsChanged") }
    syncInternals.persistRestore = async (_n, prev) => { t("persistRestore"); h.restores.push(prev ?? null) }
    syncInternals.mcp = { status: async () => (t("status"), h.statusQueue.length > 1 ? h.statusQueue.shift()! : h.statusQueue[0]!), add: async (name, cfg) => { t("add"); h.added.push({ name, cfg }) }, remove: async (name) => { t("remove"); h.removes.push(name) }, tools: async () => (t("tools"), h.tools) }
    return h
  }
  beforeEach(() => { process.env.ALTIMATE_WORKSPACE = "1"; resetForTests() })
  afterEach(() => { for (const k of Object.keys(syncInternals) as Array<keyof typeof syncInternals>) delete syncInternals[k]; if (ORIGINAL_FLAG === undefined) delete process.env.ALTIMATE_WORKSPACE; else process.env.ALTIMATE_WORKSPACE = ORIGINAL_FLAG })
  const ours: ExistingEntry = { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled: true }

  describe("the undo reads the world at undo time", () => {
    test("a disable landing on our node during the boot is kept, not deleted", async () => {
      let phase = 0
      const h = install({
        statuses: [{}, { datamate: { status: "connected" } }], tools: { datamate_dbt_build_model: 1 },
        existing: () => (phase === 0 ? null : { ...ours, enabled: false }),
        projectEntry: () => (phase === 0 ? null : { ...ours, enabled: false }),
      })
      const prevAdd = syncInternals.mcp!.add
      syncInternals.mcp!.add = async (n, c) => { await prevAdd(n, c); phase = 1 }
      const outcome = await ensure("s1")
      expect(outcome).toEqual({ kind: "entry-disabled" })
      expect(h.removes).toContain("datamate")
      expect(h.restores, "the user's disable was undone").toEqual([{ ...ours, enabled: false }])
    })
    test("an undo whose re-read throws does not write blind", async () => {
      let phase = 0
      const h = install({
        statuses: [{}, { datamate: { status: "connected" } }], tools: { datamate_dbt_build_model: 1 },
        existing: () => (phase === 0 ? null : { ...ours, enabled: false }),
        projectEntry: () => { if (phase === 0) return null; throw new Error("EACCES on re-read") },
      })
      const prevAdd = syncInternals.mcp!.add
      syncInternals.mcp!.add = async (n, c) => { await prevAdd(n, c); phase = 1 }
      const outcome = await ensure("s1")
      expect(outcome).toEqual({ kind: "entry-disabled" })
      expect(h.restores, "a failed re-read fell back to restoring the snapshot: the user's disabled node is removed").not.toEqual([null])
    })
    test("a disable on the global entry leaves the project node ours to remove", async () => {
      let phase = 0
      const h = install({
        statuses: [{}, { datamate: { status: "connected" } }], tools: { datamate_dbt_build_model: 1 },
        existing: () => (phase === 0 ? null : { type: "local", command: ["datamate", "start-stdio"], enabled: false }),
        projectEntry: () => (phase === 0 ? null : ours),
      })
      const prevAdd = syncInternals.mcp!.add
      syncInternals.mcp!.add = async (n, c) => { await prevAdd(n, c); phase = 1 }
      const outcome = await ensure("s1")
      expect(outcome).toEqual({ kind: "entry-disabled" })
      expect(h.restores).toEqual([null])
    })
  })

  describe("an in-region refusal undoes before it announces", () => {
    test("post-add connect-failed: remove and persistRestore precede notify; exactly one remove and one restore", async () => {
      const h = install({ statuses: [{}, { datamate: { status: "failed", error: "exit 1" } }] })
      const outcome = await ensure("s1")
      expect(outcome).toMatchObject({ kind: "connect-failed" })
      const iRemove = h.trace.indexOf("remove"), iRestore = h.trace.indexOf("persistRestore"), iNotify = h.trace.indexOf("notify")
      expect(iRemove).toBeGreaterThanOrEqual(0)
      expect(iRestore).toBeGreaterThan(iRemove)
      expect(iNotify, `trace: ${h.trace.join(" > ")}`).toBeGreaterThan(iRestore)
      expect(h.removes).toEqual(["datamate"])
      expect(h.restores).toEqual([null])
      expect(h.toasts).toHaveLength(1)
    })
    test("persist refused as 'disabled' → nothing installed, nothing undone, entry-disabled announced once", async () => {
      const h = install({ statuses: [{}] })
      syncInternals.persist = async () => "disabled"
      const outcome = await ensure("s1")
      expect(outcome).toEqual({ kind: "entry-disabled" })
      expect(h.added).toHaveLength(0)
      expect(h.restores).toHaveLength(0)
      expect(h.toasts).toHaveLength(1)
    })
  })

  describe("W — an undo that fails is announced once, naming the file; the triggering outcome survives", () => {
    test("post-add connect-failed + restore failed → two toasts (engine failed; config left behind in <path>), outcome connect-failed", async () => {
      const h = install({ statuses: [{}, { datamate: { status: "failed", error: "exit 1" } }] })
      syncInternals.persistRestore = async () => "failed"
      const outcome = await ensure("s1")
      expect(outcome).toMatchObject({ kind: "connect-failed", error: "exit 1" })
      expect(h.toasts.map((t) => t.title)).toEqual(["Workspace engine config left behind", "Workspace engine failed to start"])
      expect(h.toasts[0]!.message).toContain("/tmp/test/.altimate-code/altimate-code.json")
    })
    test("superseded + restore failed → exactly one toast (config left behind), outcome superseded", async () => {
      let current: CachedBinding | null = binding
      const h = install({ statuses: [{}, { datamate: { status: "connected" } }], tools: { datamate_dbt_build_model: 1 } })
      syncInternals.resolveBinding = async () => (h.trace.push("resolveBinding"), current)
      const prevAdd = syncInternals.mcp!.add
      syncInternals.mcp!.add = async (n, c) => { await prevAdd(n, c); current = other }
      syncInternals.persistRestore = async () => { throw new Error("EACCES") }
      const outcome = await ensure("s1")
      expect(outcome).toEqual({ kind: "superseded" })
      expect(h.toasts.map((t) => t.title)).toEqual(["Workspace engine config left behind"])
    })
  })

  // A client this attach started is
  // torn down whatever is bound now, which is what the teardown split said
  // all along — the definition was right and the plumbing did not carry it
  // as far as this exit.
  describe("INVARIANT — a client we started is torn down whatever is bound now", () => {
    test("(i) revive succeeds, then the re-inspection read THROWS → revived client left connected, outcome connect-failed via the catch-all", async () => {
      let reads = 0
      const h = install({
        statuses: [{ datamate: { status: "failed", error: "closed" } }, { datamate: { status: "connected" } }],
        existing: () => { reads += 1; if (reads >= 3) throw new Error("config unreadable"); return ours },
        tools: { datamate_dbt_build_model: 1 },
      })
      const outcome = await ensure("s1")
      expect(h.added.map((a) => a.cfg.command)).toEqual([["datamate", "start-stdio", "--datamate", "42"]])
      expect(outcome.kind).toBe("connect-failed")
      expect(h.removes, "the client this attach started is left registered and connected under a connect-failed outcome").toContain("datamate")
    })
    test("(ii) revive succeeds, the file is rewritten unpinned and the binding moves: the revived client is still torn down", async () => {
      let current: CachedBinding | null = binding
      let reads = 0
      const h = install({
        statuses: [{ datamate: { status: "failed", error: "closed" } }, { datamate: { status: "connected" } }],
        existing: () => { reads += 1; return reads >= 3 ? { type: "local", command: ["datamate", "start-stdio"] } : ours },
        tools: { datamate_dbt_build_model: 1 },
      })
      syncInternals.resolveBinding = async () => (h.trace.push("resolveBinding"), current)
      const prevAdd = syncInternals.mcp!.add
      syncInternals.mcp!.add = async (n, c) => { await prevAdd(n, c); current = other }
      const outcome = await ensure("s1")
      expect(h.added).toHaveLength(1)
      expect(outcome).toEqual({ kind: "superseded" })
      expect(h.removes, "the client this attach started is left registered and connected").toContain("datamate")
    })
  })
})

describe("the restore refuses on the text it edits", () => {
  const binding: CachedBinding = {
    datamateId: 42,
    datamateName: "analytics",
    repoRemote: "git@github.com:acme/analytics.git",
    projectPath: "/tmp/analytics",
  } as CachedBinding

  type H = {
    added: Array<{ name: string; cfg: LocalMcpConfig }>
    persisted: Array<{ name: string; cfg: LocalMcpConfig }>
    removes: string[]
    restores: Array<ExistingEntry | null>
    toasts: Array<{ title: string; message: string }>
    statusQueue: Array<Record<string, { status: string; error?: string } | undefined>>
    reads: Array<boolean | undefined>
    spawnedNow?: ExistingEntry
  }

  function install(statuses: H["statusQueue"], entry: () => ExistingEntry | null, opts: { realPersist?: boolean; spawned?: ExistingEntry } = {}): H {
    const h: H = { added: [], persisted: [], removes: [], restores: [], toasts: [], statusQueue: statuses, reads: [], spawnedNow: opts.spawned }
    syncInternals.resolveBinding = async () => binding
    syncInternals.which = () => "/usr/local/bin/datamate"
    syncInternals.versionOf = async () => "0.7.0"
    syncInternals.declared = async () => ({ keys: ["dbt_build_model"], extensionKeys: [] })
    if (!opts.realPersist) {
      syncInternals.persist = async (name, cfg) => {
        h.persisted.push({ name, cfg })
      }
    }
    syncInternals.existingEntry = async () => {
      const e = entry()
      h.reads.push(e?.enabled)
      return e
    }
    syncInternals.notify = async (t) => {
      h.toasts.push({ title: t.title, message: t.message })
    }
    syncInternals.toolsChanged = async () => {}
    syncInternals.persistRestore = async (_n, prev) => {
      h.restores.push(prev)
    }
    syncInternals.projectEntry = async () => null
    syncInternals.projectConfigPath = async () => "/tmp/test/.altimate-code/altimate-code.json"
    syncInternals.mcp = {
      status: async () => (h.statusQueue.length > 1 ? h.statusQueue.shift()! : h.statusQueue[0]!),
      add: async (name, cfg) => {
        h.added.push({ name, cfg })
        h.spawnedNow = cfg as ExistingEntry
      },
      remove: async (name) => {
        h.removes.push(name)
        h.spawnedNow = undefined
      },
      spawned: async () => h.spawnedNow,
      tools: async () => ({ datamate_dbt_build_model: 1 }),
    }
    return h
  }

  beforeEach(() => {
    process.env.ALTIMATE_WORKSPACE = "1"
    resetForTests()
  })
  afterEach(() => {
    for (const key of Object.keys(syncInternals) as Array<keyof typeof syncInternals>) delete syncInternals[key]
  })

  const DISABLED_FILE = JSON.stringify({ mcp: { datamate: { type: "local", command: ["datamate", "start-stdio"], enabled: false } } }, null, 2)
  const PINNED42 = { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled: true } as ExistingEntry

  describe("the write checks the same text it modifies", () => {
    let file: string
    let invalidateSpy: ReturnType<typeof spyOn>
    const originalReadText = Filesystem.readText
    beforeEach(async () => {
      file = path.join(mkdtempSync(path.join(tmpdir(), "l3r4-")), "altimate-code.json")
      await addMcpToConfig("datamate", { type: "local", command: ["datamate", "start-stdio"], enabled: true } as never, file)
      invalidateSpy = spyOn(Config, "invalidate").mockImplementation(async () => {})
    })
    afterEach(() => {
      invalidateSpy.mockRestore()
      Filesystem.readText = originalReadText
    })
    const diskEntry = async () => (await readMcpEntryFromDisk("datamate", file)) as ExistingEntry | undefined

    /** After the guard's intent read, config-file readText #1 is now addMcpToConfig's
     * ONLY read (persist has no separate check read any more). */
    function stage(where: "intent-read-end" | "before-write-read" | "after-write-read") {
      const h = install([{ datamate: { status: "connected" } }, { datamate: { status: "connected" } }], () => null, { realPersist: true })
      syncInternals.projectConfigPath = async () => file
      let armed = false
      let landed = false
      let n = 0
      syncInternals.existingEntry = async () => {
        const e = (await diskEntry()) ?? null
        h.reads.push(e?.enabled)
        if (h.reads.length === 2) {
          if (where === "intent-read-end" && !landed) {
            landed = true
            writeFileSync(file, DISABLED_FILE)
          }
          armed = true
        }
        return e
      }
      syncInternals.projectEntry = async () => (await diskEntry()) ?? null
      Filesystem.readText = async (p: string) => {
        if (!armed || p !== file || landed) return originalReadText(p)
        n += 1
        if (n !== 1) return originalReadText(p)
        landed = true
        if (where === "before-write-read") {
          writeFileSync(file, DISABLED_FILE)
          return originalReadText(p)
        }
        const text = await originalReadText(p)
        writeFileSync(file, DISABLED_FILE)
        return text
      }
      return { h, reads: () => n }
    }

    test("a disable landing after the guard is refused by the write's own read", async () => {
      const { h } = stage("intent-read-end")
      const out = await ensure("s1")
      expect(out.kind).toBe("entry-disabled")
      expect((await diskEntry())?.enabled).toBe(false)
      expect(h.added).toHaveLength(0)
      expect(h.toasts).toHaveLength(1)
    })

    test("a disable landing before the write is refused", async () => {
      const { h, reads } = stage("before-write-read")
      const out = await ensure("s1")
      console.log("W0/W2:", JSON.stringify(out), "disk:", JSON.stringify(await diskEntry()), "config reads after guard:", reads())
      expect(out.kind).toBe("entry-disabled")
      expect((await diskEntry())?.enabled).toBe(false)
      expect(h.added).toHaveLength(0)
    })

    test("a disable landing inside the write itself is lost — the named residual", async () => {
      const { h } = stage("after-write-read")
      const out = await ensure("s1")
      const after = await diskEntry()
      console.log("W3:", JSON.stringify(out), "disk:", JSON.stringify(after))
      expect(out.kind).toBe("attached")
      expect(after?.enabled).toBe(true)
      expect(after?.command).toEqual(["datamate", "start-stdio", "--datamate", "42"])
      expect(h.added).toHaveLength(1)
      expect(await ensure("s1")).toBe(out)
    })
  })

  describe("a config read that throws, at each read in turn", () => {
    function realReader(throwAt: (n: number) => boolean, onDisk: () => ExistingEntry | null) {
      const h = install([{}, { datamate: { status: "connected" } }], () => null)
      delete syncInternals.existingEntry
      let n = 0
      syncInternals.freshConfig = async () => {
        n += 1
        if (throwAt(n)) throw new Error(n === 1 || throwAt(1) ? "EIO" : `EIO#`)
        const e = onDisk()
        return { mcp: e ? { datamate: e } : {} }
      }
      return { h, calls: () => n }
    }

    test("read #1 (inspection) throws → connect-failed, 1 toast, no mutation", async () => {
      const { h } = realReader((n) => n === 1, () => null)
      const out = await ensure("s1")
      expect(out).toMatchObject({ kind: "connect-failed", error: "configuration unreadable: Error: EIO" })
      expect(h.toasts.map((t) => t.title)).toEqual(["Workspace engine not attached"])
      expect(h.persisted).toHaveLength(0)
      expect(h.added).toHaveLength(0)
    })

    test("read #2 (pre-install guard) throws → connect-failed, 1 toast, no mutation; same label as the inspection", async () => {
      const { h } = realReader((n) => n === 2, () => null)
      const out = await ensure("s1")
      expect(out).toMatchObject({ kind: "connect-failed", error: "configuration unreadable: intent could not be confirmed" })
      expect(h.toasts.map((t) => t.title)).toEqual(["Workspace engine not attached"])
      expect(h.persisted).toHaveLength(0)
      expect(h.added).toHaveLength(0)
    })

    test("read #3 (post-install guard) throws → install undone, connect-failed, 1 toast", async () => {
      const { h } = realReader((n) => n === 3, () => null)
      const out = await ensure("s1")
      expect(out).toMatchObject({ kind: "connect-failed" })
      expect(h.toasts.map((t) => t.title)).toEqual(["Workspace engine not attached"])
      expect(h.persisted).toHaveLength(1)
      expect(h.added).toHaveLength(1)
      expect(h.removes).toEqual(["datamate"])
      expect(h.restores).toEqual([null])
    })

    test("undo re-read (projectEntry #2) throws → FAILS CLOSED: no restore, one left-behind toast, superseded", async () => {
      let current: CachedBinding | null = binding
      const h = install([{}, { datamate: { status: "connected" } }], () => null)
      syncInternals.resolveBinding = async () => current
      let pe = 0
      syncInternals.projectEntry = async () => {
        pe += 1
        if (pe === 2) throw new Error("EIO undo re-read")
        return null
      }
      syncInternals.mcp!.tools = async () => ((current = { ...binding, datamateId: 99 } as CachedBinding), { datamate_dbt_build_model: 1 })
      const out = await ensure("s1")
      expect(out.kind).toBe("superseded")
      expect(pe).toBe(2)
      expect(h.restores).toEqual([])
      expect(h.removes).toEqual(["datamate"])
      expect(h.toasts.map((t) => t.title)).toEqual(["Workspace engine config left behind"])
    })

    test("memo validation read throws (transient) → not served, re-decided → reused; no toast", async () => {
      const { h } = realReader((n) => n === 4, () => (h.added.length ? PINNED42 : null))
      const first = await ensure("s1")
      expect(first.kind).toBe("attached")
      h.statusQueue = [{ datamate: { status: "connected" } }]
      const second = await ensure("s1")
      expect(second).not.toBe(first)
      expect(second.kind).toBe("reused")
      expect(h.toasts).toHaveLength(1)
    })

    test("PERSISTENT throw: three turns re-decide but announce ONCE (AL)", async () => {
      const { h, calls } = realReader(() => true, () => null)
      const a = await ensure("s1")
      const b = await ensure("s1")
      const c = await ensure("s1")
      console.log("AH persistent:", a.kind, b.kind, c.kind, "toasts:", h.toasts.length, "freshConfig calls:", calls())
      expect([a.kind, b.kind, c.kind]).toEqual(["connect-failed", "connect-failed", "connect-failed"])
      expect(h.toasts.length).toBe(1)
      expect(h.persisted).toHaveLength(0)
    })
  })

  describe("a probe that keeps failing is refused once, not every turn", () => {
    test("turn 1: detach + refuse once (engine-too-old), client not left registered; later turns re-decide silently (AL)", async () => {
      const h = install(
        [{ datamate: { status: "connected" } }, { datamate: { status: "disabled" } }, { datamate: { status: "connected" } }],
        () => PINNED42,
        { spawned: PINNED42 },
      )
      syncInternals.versionOf = async () => {
        throw new Error("EACCES")
      }
      const a = await ensure("s1")
      expect(a.kind).toBe("engine-too-old")
      expect(h.removes).toEqual(["datamate"])
      expect(h.spawnedNow).toBeUndefined()
      expect(h.toasts).toHaveLength(1)
      expect(settledOutcome("s1")?.kind).toBe("engine-too-old")

      // Turn 2: the outcome is REPAIRABLE, so the memo does not hold it — run() again.
      const b = await ensure("s1")
      const c = await ensure("s1")
      console.log("AJ:", b.kind, c.kind, "toasts:", h.toasts.length, "added:", h.added.length, "removes:", h.removes.length)
      expect(b).not.toBe(a)
      expect(h.toasts.length).toBe(1)
    })
  })

  describe("spawned cleared on onclose / disconnect — the next attach", () => {
    test("child exit (record cleared, status failed) → revived via add → reused", async () => {
      const h = install([{ datamate: { status: "failed", error: "Connection closed" } }, { datamate: { status: "connected" } }], () => PINNED42)
      const out = await ensure("s1")
      expect(out.kind).toBe("reused")
      expect(h.added).toHaveLength(1)
      expect(h.spawnedNow?.command).toEqual(PINNED42.command)
      expect(h.persisted).toHaveLength(0)
    })

    test("disconnect (record cleared, status disabled, config enabled:false) → entry-disabled; then /mcp enable-style re-add → reused", async () => {
      let enabled = true
      let status: { status: string } = { status: "connected" }
      const h = install([], () => ({ ...PINNED42, enabled }), { spawned: PINNED42 })
      syncInternals.mcp!.status = async () => ({ datamate: status })
      expect((await ensure("s1")).kind).toBe("reused")
      // MCP.disconnect: closeClient, delete spawned, status disabled, persist enabled:false
      enabled = false
      status = { status: "disabled" }
      h.spawnedNow = undefined
      const mid = await ensure("s1")
      expect(mid.kind).toBe("entry-disabled")
      expect(h.added).toHaveLength(0)
      // MCP.connect (prompt.ts /mcp enable): createAndStore → spawned set, status connected, persist enabled:true
      enabled = true
      status = { status: "connected" }
      h.spawnedNow = PINNED42
      const back = await ensure("s1")
      expect(back.kind).toBe("reused")
      expect(h.added).toHaveLength(0)
      expect(h.persisted).toHaveLength(0)
    })
  })

  describe("when a repeated verdict speaks again", () => {
    test("same kind, changed detail (engine-too-old 0.5.9 → 0.6.0) speaks again", async () => {
      let v = "0.5.9"
      const h = install([{}], () => null)
      syncInternals.versionOf = async () => v
      expect((await ensure("s1")).kind).toBe("engine-too-old")
      expect((await ensure("s1")).kind).toBe("engine-too-old")
      v = "0.6.0"
      expect((await ensure("s1")).kind).toBe("engine-too-old")
      console.log("AL detail:", h.toasts.length, h.toasts.map((t) => t.message.slice(0, 40)))
      expect(h.toasts.length).toBe(2)
    })
    test("two sessions with the same verdict each hear it once", async () => {
      const h = install([{}], () => null)
      syncInternals.which = () => null
      await ensure("a"); await ensure("a"); await ensure("b"); await ensure("b")
      expect(h.toasts.length).toBe(2)
    })
    test("a reuse after a refusal clears the record: refusal → reused → same refusal speaks again", async () => {
      let onPath: string | null = null
      let status: { status: string } = { status: "disabled" }
      const h = install([], () => PINNED42, { spawned: undefined })
      syncInternals.which = () => onPath
      syncInternals.mcp!.status = async () => ({ datamate: status })
      expect((await ensure("s1")).kind).toBe("engine-missing") // ours+down → retry → revive? no: which null → refuse-unreachable → engine-missing
      onPath = "/usr/local/bin/datamate"; status = { status: "connected" }; h.spawnedNow = PINNED42
      expect((await ensure("s1")).kind).toBe("reused")
      onPath = null; status = { status: "disabled" }; h.spawnedNow = undefined
      expect((await ensure("s1")).kind).toBe("engine-missing")
      expect(h.toasts.filter((t) => t.title.includes("unavailable")).length).toBe(2)
    })
  })

  describe("a disable landing between the undo's read and the restore's write", () => {
    let file: string
    let invalidateSpy: ReturnType<typeof spyOn>
    const originalReadText = Filesystem.readText
    beforeEach(() => {
      file = path.join(mkdtempSync(path.join(tmpdir(), "l3r4-restore-")), "altimate-code.json")
      invalidateSpy = spyOn(Config, "invalidate").mockImplementation(async () => {})
    })
    afterEach(() => {
      invalidateSpy.mockRestore()
      Filesystem.readText = originalReadText
    })
    const diskEntry = async () => (await readMcpEntryFromDisk("datamate", file)) as ExistingEntry | undefined

    function stageRestore(initial: ExistingEntry | null) {
      let current: CachedBinding | null = binding
      const statuses: H["statusQueue"] = initial ? [{ datamate: { status: "connected" } }, { datamate: { status: "connected" } }] : [{}, { datamate: { status: "connected" } }]
      const h = install(statuses, () => null, { realPersist: true })
      delete syncInternals.persistRestore // REAL restore
      syncInternals.projectConfigPath = async () => file
      syncInternals.resolveBinding = async () => current
      syncInternals.existingEntry = async () => {
        const e = (await diskEntry()) ?? null
        h.reads.push(e?.enabled)
        return e
      }
      let pe = 0
      let armed = false
      let landed = false
      syncInternals.projectEntry = async () => {
        pe += 1
        const e = (await diskEntry()) ?? null
        if (pe === 2) armed = true // the undo's own read has just completed
        return e
      }
      // binding moves during tools() → post-install guard → undo
      syncInternals.mcp!.tools = async () => ((current = { ...binding, datamateId: 99 } as CachedBinding), { datamate_dbt_build_model: 1 })
      Filesystem.readText = async (p: string) => {
        if (armed && !landed && p === file) {
          landed = true
          // the user disables OUR entry after the undo read it and before the restore writes
          const now = (await readMcpEntryFromDisk("datamate", file)) as ExistingEntry
          writeFileSync(file, JSON.stringify({ mcp: { datamate: { ...now, enabled: false } } }, null, 2))
        }
        return originalReadText(p)
      }
      return { h, landed: () => landed }
    }

    test("a restore does not overwrite a disable with the entry it replaced", async () => {
      await addMcpToConfig("datamate", { type: "local", command: ["datamate", "start-stdio"], enabled: true } as never, file)
      const { h, landed } = stageRestore({ type: "local", command: ["datamate", "start-stdio"], enabled: true })
      const out = await ensure("s1")
      const after = await diskEntry()
      console.log("RT:", JSON.stringify(out), "disk:", JSON.stringify(after), "landed:", landed(), "toasts:", h.toasts.map((t) => t.title))
      expect(landed()).toBe(true)
      expect(out.kind).toBe("superseded")
      expect(after?.enabled, "the restore wrote the enabled previous entry over the user's disable").toBe(false)
    })

    test("a restore does not delete a node the user has disabled", async () => {
      writeFileSync(file, "{}\n")
      const { h, landed } = stageRestore(null)
      const out = await ensure("s1")
      const after = await diskEntry()
      console.log("RU:", JSON.stringify(out), "disk:", JSON.stringify(after), "landed:", landed(), "toasts:", h.toasts.map((t) => t.title))
      expect(landed()).toBe(true)
      expect(out.kind).toBe("superseded")
      expect(after, "the restore deleted the node the user had just disabled").toBeDefined()
      expect(after?.enabled).toBe(false)
    })
  })
})
