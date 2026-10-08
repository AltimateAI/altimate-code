// altimate_change - new file
//
// Unit coverage for the workspace sync state (src/altimate/workspace/sync-state.ts):
// what a check records, what counts as a change, and when the change event is published.
// The state file is real, in a sandboxed state directory; only the bus is spied, because a
// publish needs an instance the unit under test does not own.
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// Global.Path.state resolves at module load, so the sandbox must exist first.
const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME
const SANDBOX = path.join(os.tmpdir(), `altimate-sync-state-${process.pid}-${Date.now()}`)
mkdirSync(path.join(SANDBOX, "state"), { recursive: true })
process.env.XDG_STATE_HOME = path.join(SANDBOX, "state")

afterAll(() => {
  if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME
  rmSync(SANDBOX, { recursive: true, force: true })
})

const { Bus } = await import("../../../src/bus")
const SyncState = await import("../../../src/altimate/workspace/sync-state")

let project: string
let published: Array<{ type: string; properties: any }>
let publish: ReturnType<typeof spyOn>

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(SANDBOX, "project-")))
  published = []
  publish = spyOn(Bus, "publish").mockImplementation((async (def: { type: string }, properties: unknown) => {
    published.push({ type: def.type, properties })
  }) as never)
})

afterEach(() => {
  publish.mockRestore()
})

const skill = (label: string, version = "v1") => ({ label, version })

describe("diff", () => {
  test("reports added, removed and updated labels, sorted", () => {
    const changes = SyncState.diff(
      { a: skill("Alpha"), b: skill("Beta"), c: skill("Gamma") },
      { a: skill("Alpha"), b: skill("Beta", "v2"), d: skill("Delta") },
    )
    expect(changes).toEqual({ added: ["Delta"], removed: ["Gamma"], updated: ["Beta"] })
  })

  test("identical sets have no changes", () => {
    expect(SyncState.diff({ a: skill("Alpha") }, { a: skill("Alpha") })).toEqual({ added: [], removed: [], updated: [] })
  })
})

describe("record", () => {
  test("the first check is a baseline: recorded, not announced", async () => {
    await SyncState.record(project, 7, "skills", { items: { a: skill("Alpha"), b: skill("Beta") } })

    const state = SyncState.read(project, 7)
    expect(state?.entities.skills).toMatchObject({ kind: "skills", status: "ok", count: 2, lastChangedAt: null, changes: null })
    expect(state?.entities.skills?.lastCheckedAt).toBeNumber()
    expect(published).toEqual([])
  })

  test("a later check that finds a difference records and publishes it", async () => {
    await SyncState.record(project, 7, "skills", { items: { a: skill("Alpha") } })
    await SyncState.record(project, 7, "skills", { items: { a: skill("Alpha", "v2"), b: skill("Beta") } })

    const entity = SyncState.read(project, 7)?.entities.skills
    expect(entity?.changes).toEqual({ added: ["Beta"], removed: [], updated: ["Alpha"] })
    expect(entity?.lastChangedAt).toBe(entity!.lastCheckedAt)
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      type: "altimate.workspace.sync.changed",
      properties: { datamateId: 7, kind: "skills", changes: { added: ["Beta"], removed: [], updated: ["Alpha"] } },
    })
    // The event carries what the status route serves — never the raw item map.
    expect(published[0].properties.state.items).toBeUndefined()
  })

  test("a check that finds nothing new publishes nothing and keeps the last change", async () => {
    await SyncState.record(project, 7, "skills", { items: { a: skill("Alpha") } })
    await SyncState.record(project, 7, "skills", { items: { b: skill("Beta") } })
    published = []
    await SyncState.record(project, 7, "skills", { items: { b: skill("Beta") } })

    expect(published).toEqual([])
    expect(SyncState.read(project, 7)?.entities.skills?.changes).toEqual({ added: ["Beta"], removed: ["Alpha"], updated: [] })
  })

  test("an error is published once, keeps the last items, and recovery is published", async () => {
    await SyncState.record(project, 7, "skills", { items: { a: skill("Alpha") } })
    await SyncState.record(project, 7, "skills", { error: "could not fetch the workspace's skill list" })
    await SyncState.record(project, 7, "skills", { error: "could not fetch the workspace's skill list" })

    const failed = SyncState.read(project, 7)?.entities.skills
    expect(failed).toMatchObject({ status: "error", count: 1, error: "could not fetch the workspace's skill list" })
    expect(published).toHaveLength(1)
    expect(published[0].properties.changes).toBeNull()

    // Recovery with the same items: no difference, but the error state cleared.
    await SyncState.record(project, 7, "skills", { items: { a: skill("Alpha") } })
    expect(published).toHaveLength(2)
    expect(published[1].properties.state).toMatchObject({ status: "ok" })
    expect(published[1].properties.state.error).toBeUndefined()
  })

  test("a failure before anything was read leaves the next read as the baseline", async () => {
    await SyncState.record(project, 7, "memory", { error: "could not load workspace memory" })
    published = []
    await SyncState.record(project, 7, "memory", { items: { m1: skill("Naming conventions") } })

    expect(SyncState.read(project, 7)?.entities.memory?.changes).toBeNull()
    // The recovery is still news; the existing block is not "added".
    expect(published).toHaveLength(1)
    expect(published[0].properties.changes).toBeNull()
  })

  test("kinds are recorded independently", async () => {
    await Promise.all([
      SyncState.record(project, 7, "skills", { items: { a: skill("Alpha") } }),
      SyncState.record(project, 7, "memory", { items: { m1: skill("One"), m2: skill("Two") } }),
    ])
    const state = SyncState.read(project, 7)
    expect(state?.entities.skills?.count).toBe(1)
    expect(state?.entities.memory?.count).toBe(2)
  })

  test("another workspace's state is not this one's", async () => {
    await SyncState.record(project, 7, "skills", { items: { a: skill("Alpha") } })
    expect(SyncState.read(project, 8)).toBeNull()

    // A rebind starts over: the new workspace's first check is again a baseline.
    await SyncState.record(project, 8, "skills", { items: { z: skill("Zeta") } })
    expect(SyncState.read(project, 8)?.entities.skills?.changes).toBeNull()
    expect(SyncState.read(project, 7)).toBeNull()
    expect(published).toEqual([])
  })

  test("a publish failure does not fail the record", async () => {
    publish.mockImplementation((async () => {
      throw new Error("no instance")
    }) as never)
    await SyncState.record(project, 7, "skills", { items: { a: skill("Alpha") } })
    await SyncState.record(project, 7, "skills", { items: { b: skill("Beta") } })
    expect(SyncState.read(project, 7)?.entities.skills?.changes).toEqual({ added: ["Beta"], removed: ["Alpha"], updated: [] })
  })
})
