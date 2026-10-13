// altimate_change - new file
//
// Unit coverage for the workspace sync state (src/altimate/workspace/sync-state.ts):
// what a check records, what counts as a change, and when the change event is published.
// The state files are real, in a sandboxed state directory; the bus and the account in use
// are spied, because a publish needs an instance and a scope needs credentials, neither of
// which the unit under test owns.
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Bus } from "../../../src/bus"
import * as State from "../../../src/altimate/workspace/state"
import * as SyncState from "../../../src/altimate/workspace/sync-state"

const ORIGINAL_STATE_HOME = process.env.OPENCODE_TEST_STATE_HOME
const SANDBOX = path.join(os.tmpdir(), `altimate-sync-state-${process.pid}-${Date.now()}`)
const STATE_HOME = path.join(SANDBOX, "state")
mkdirSync(STATE_HOME, { recursive: true })
process.env.OPENCODE_TEST_STATE_HOME = STATE_HOME

afterAll(() => {
  if (ORIGINAL_STATE_HOME === undefined) delete process.env.OPENCODE_TEST_STATE_HOME
  else process.env.OPENCODE_TEST_STATE_HOME = ORIGINAL_STATE_HOME
  rmSync(SANDBOX, { recursive: true, force: true })
})

const ACCOUNT = { tenant: "acme", apiUrl: "https://api.example.com", account: "digest-a" }

let project: string
let published: Array<{ type: string; properties: any }>
let spies: Array<{ mockRestore: () => void }>
let scope: ReturnType<typeof spyOn>

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(SANDBOX, "project-")))
  published = []
  spies = [
    spyOn(Bus, "publish").mockImplementation((async (def: { type: string }, properties: unknown) => {
      published.push({ type: def.type, properties })
    }) as never),
  ]
  scope = spyOn(State, "currentScope").mockResolvedValue(ACCOUNT)
  spies.push(scope)
})

afterEach(() => {
  for (const spy of spies) spy.mockRestore()
})

const skill = (label: string, version = "v1") => ({ label, version })
const syncFiles = () => readdirSync(path.join(STATE_HOME, "altimate-workspace-sync"))

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

  test("an id named like an inherited property is still an item", () => {
    expect(SyncState.diff({}, { constructor: skill("Ctor") })).toEqual({ added: ["Ctor"], removed: [], updated: [] })
    expect(SyncState.diff({ toString: skill("Str") }, {})).toEqual({ added: [], removed: ["Str"], updated: [] })
  })
})

describe("record", () => {
  test("the first check is a baseline: recorded, not announced", async () => {
    await SyncState.record(project, 7, "skills", { items: { a: skill("Alpha"), b: skill("Beta") } })

    const state = await SyncState.read(project, 7)
    expect(state?.entities.skills).toMatchObject({ kind: "skills", status: "ok", count: 2, lastChangedAt: null, changes: null })
    expect(state?.entities.skills?.lastCheckedAt).toBeNumber()
    expect(state?.entities.skills?.lastSucceededAt).toBe(state!.entities.skills!.lastCheckedAt)
    expect(published).toEqual([])
  })

  test("a later check that finds a difference records and publishes it", async () => {
    await SyncState.record(project, 7, "skills", { items: { a: skill("Alpha") } })
    await SyncState.record(project, 7, "skills", { items: { a: skill("Alpha", "v2"), b: skill("Beta") } })

    const entity = (await SyncState.read(project, 7))?.entities.skills
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
    expect((await SyncState.read(project, 7))?.entities.skills?.changes).toEqual({
      added: ["Beta"],
      removed: ["Alpha"],
      updated: [],
    })
  })

  test("an error is published once, keeps the last items and success time, and recovery is published", async () => {
    await SyncState.record(project, 7, "skills", { items: { a: skill("Alpha") } })
    const succeededAt = (await SyncState.read(project, 7))!.entities.skills!.lastSucceededAt
    await Bun.sleep(5)
    await SyncState.record(project, 7, "skills", { error: "could not fetch the workspace's skill list" })
    await SyncState.record(project, 7, "skills", { error: "could not fetch the workspace's skill list" })

    const failed = (await SyncState.read(project, 7))?.entities.skills
    expect(failed).toMatchObject({ status: "error", count: 1, error: "could not fetch the workspace's skill list" })
    // A failure is a check, not a load: "loaded Xm ago" must not move.
    expect(failed?.lastSucceededAt).toBe(succeededAt)
    expect(failed!.lastCheckedAt).toBeGreaterThan(succeededAt!)
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
    expect((await SyncState.read(project, 7))?.entities.memory).toMatchObject({ count: null, lastSucceededAt: null })
    published = []
    await SyncState.record(project, 7, "memory", { items: { m1: skill("Naming conventions") } })

    expect((await SyncState.read(project, 7))?.entities.memory?.changes).toBeNull()
    // The recovery is still news; the existing block is not "added".
    expect(published).toHaveLength(1)
    expect(published[0].properties.changes).toBeNull()
  })

  test("kinds are recorded independently, each in its own file", async () => {
    await Promise.all([
      SyncState.record(project, 7, "skills", { items: { a: skill("Alpha") } }),
      SyncState.record(project, 7, "memory", { items: { m1: skill("One"), m2: skill("Two") } }),
    ])
    const state = await SyncState.read(project, 7)
    expect(state?.entities.skills?.count).toBe(1)
    expect(state?.entities.memory?.count).toBe(2)
  })

  test("two writers of different kinds never overwrite each other", async () => {
    // Another realm's writer (the TUI main thread, a CLI process) has no share in this
    // module's write chain. Writing each kind to its own file is what keeps both records.
    const before = new Set(syncFiles())
    await SyncState.record(project, 7, "skills", { items: { a: skill("Alpha") } })
    await SyncState.record(project, 7, "memory", { items: { m1: skill("One") } })
    const written = syncFiles().filter((name) => !before.has(name))
    expect(written.map((name) => name.split(".").slice(1).join(".")).sort()).toEqual(["memory.json", "skills.json"])
    expect(new Set(written.map((name) => name.split(".")[0])).size).toBe(1)
    await SyncState.record(project, 7, "skills", { items: { a: skill("Alpha"), b: skill("Beta") } })

    const state = await SyncState.read(project, 7)
    expect(state?.entities.memory?.count).toBe(1)
    expect(state?.entities.skills?.count).toBe(2)
  })

  test("the state file is owner-only and no temp file is left behind", async () => {
    await SyncState.record(project, 7, "skills", { items: { a: skill("Alpha") } })
    const files = syncFiles()
    expect(files.some((name) => name.includes(".tmp-"))).toBe(false)
    // POSIX permission bits; Windows reports its own.
    if (process.platform !== "win32") {
      for (const name of files) {
        expect(statSync(path.join(STATE_HOME, "altimate-workspace-sync", name)).mode & 0o777).toBe(0o600)
      }
    }
  })

  test("another workspace's state is not this one's", async () => {
    await SyncState.record(project, 7, "skills", { items: { a: skill("Alpha") } })
    expect(await SyncState.read(project, 8)).toBeNull()

    // A rebind starts over: the new workspace's first check is again a baseline.
    await SyncState.record(project, 8, "skills", { items: { z: skill("Zeta") } })
    expect((await SyncState.read(project, 8))?.entities.skills?.changes).toBeNull()
    expect(await SyncState.read(project, 7)).toBeNull()
    expect(published).toEqual([])
  })

  test("a late result from a previous binding is dropped", async () => {
    await SyncState.record(project, 8, "memory", { items: { m1: skill("New workspace block") } })
    await SyncState.record(project, 7, "memory", { error: "could not load workspace memory" }, { isCurrent: () => false })

    const state = await SyncState.read(project, 8)
    expect(state?.entities.memory).toMatchObject({ status: "ok", count: 1 })
    expect(published).toEqual([])
  })

  test("the same workspace id under another account is another workspace", async () => {
    await SyncState.record(project, 7, "skills", { items: { a: skill("Alpha") } })
    scope.mockResolvedValue({ ...ACCOUNT, tenant: "other", account: "digest-b" })
    expect(await SyncState.read(project, 7)).toBeNull()

    // And its first check is a baseline, not "Alpha removed".
    await SyncState.record(project, 7, "skills", { items: { b: skill("Beta") } })
    expect((await SyncState.read(project, 7))?.entities.skills?.changes).toBeNull()
    expect(published).toEqual([])
  })

  test("a check that read under another account is dropped, even for the same workspace id", async () => {
    await SyncState.record(project, 7, "skills", { items: { a: skill("Alpha") } })
    // Started under account B, written after the switch back to A.
    const other = { ...ACCOUNT, tenant: "other", account: "digest-b" }
    await SyncState.record(project, 7, "skills", { items: { b: skill("B's skill") } }, { scope: other })

    expect((await SyncState.read(project, 7))?.entities.skills).toMatchObject({ count: 1, changes: null })
    expect(published).toEqual([])
  })

  test("a check with no account when it started is not recorded", async () => {
    await SyncState.record(project, 7, "skills", { items: { a: skill("Alpha") } }, { scope: null })
    expect(await SyncState.read(project, 7)).toBeNull()
  })

  test("an older observation never rolls a newer record back", async () => {
    await SyncState.record(
      project,
      7,
      "skills",
      { items: { a: skill("Alpha"), b: skill("Beta") } },
      { observedAt: 2_000 },
    )
    // A slow check that started earlier lands last.
    await SyncState.record(project, 7, "skills", { items: { a: skill("Alpha") } }, { observedAt: 1_000 })

    const entity = (await SyncState.read(project, 7))?.entities.skills
    expect(entity).toMatchObject({ count: 2, lastCheckedAt: 2_000 })
    expect(published).toEqual([])
  })

  test("without an account nothing is recorded or served", async () => {
    scope.mockResolvedValue(null)
    await SyncState.record(project, 7, "skills", { items: { a: skill("Alpha") } })
    expect(await SyncState.read(project, 7)).toBeNull()
    scope.mockResolvedValue(ACCOUNT)
    expect(await SyncState.read(project, 7)).toBeNull()
  })

  test("a publish failure does not fail the record", async () => {
    spies[0].mockRestore()
    spies[0] = spyOn(Bus, "publish").mockImplementation((async () => {
      throw new Error("no instance")
    }) as never)
    await SyncState.record(project, 7, "skills", { items: { a: skill("Alpha") } })
    await SyncState.record(project, 7, "skills", { items: { b: skill("Beta") } })
    expect((await SyncState.read(project, 7))?.entities.skills?.changes).toEqual({
      added: ["Beta"],
      removed: ["Alpha"],
      updated: [],
    })
  })
})

describe("forget", () => {
  test("clears one kind's record, latched error included, and leaves the others", async () => {
    await SyncState.record(project, 7, "skills", { items: { a: skill("Alpha") } })
    await SyncState.record(project, 7, "memory", { error: "could not load workspace memory" })
    published = []

    await SyncState.forget(project, "memory")

    const state = await SyncState.read(project, 7)
    expect(state?.entities.memory).toBeUndefined()
    expect(state?.entities.skills?.count).toBe(1)
    expect(published).toEqual([])
  })

  test("keeps a record observed after the caller decided to retire the old one", async () => {
    await SyncState.record(project, 7, "memory", { items: { m1: skill("One") } }, { observedAt: 5_000 })
    await SyncState.forget(project, "memory", { before: 4_000 })
    expect((await SyncState.read(project, 7))?.entities.memory?.count).toBe(1)

    // A tie is removed: the caller decided after that observation.
    await SyncState.forget(project, "memory", { before: 5_000 })
    expect(await SyncState.read(project, 7)).toBeNull()
  })

  test("keeps the record when the binding being retired is no longer current", async () => {
    await SyncState.record(project, 7, "memory", { items: { m1: skill("One") } })
    await SyncState.forget(project, "memory", { isCurrent: () => false })
    expect((await SyncState.read(project, 7))?.entities.memory?.count).toBe(1)
  })
})
