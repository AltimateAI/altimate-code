// Gate L4 round-3 attack tests against 6cb70bb43. A FAILING test = demonstrated gap (or a documented observation, as labelled).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ensure, resetForTests, syncInternals, type LocalMcpConfig } from "../../../src/altimate/workspace/engine-sync"
import type { CachedBinding } from "../../../src/altimate/workspace/state"
import type { ExistingEntry } from "../../../src/altimate/workspace/engine-sync"

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

describe("AB — the undo re-reads the project entry at undo time", () => {
  test("AB-1: disable lands on OUR node during the boot; re-read succeeds → the disabled node is kept (not deleted), outcome entry-disabled", async () => {
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
  test("AB-2 (#13): same, but the undo-time re-read THROWS → falls back to the snapshot restore and DELETES the node the user disabled", async () => {
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
  test("AB-3: the disable landed on the GLOBAL entry (merged says disabled, project node is ours, enabled) → our node is removed, global untouched", async () => {
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

describe("AD — in-region refusals undo BEFORE announcing; the finally is idempotent", () => {
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

// RENAMED ON LIFT: no longer a residual. A client this attach started is
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
