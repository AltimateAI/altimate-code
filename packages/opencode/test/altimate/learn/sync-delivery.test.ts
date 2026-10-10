// altimate_change - new file
//
// Delivery with lesson sync: team lessons are delivered from `remote.json`, and every cached delivery path
// (frozen section, request notes, compaction, file hook) is re-checked by qualified identity after a pull,
// whatever the lesson's source. Usage of team lessons goes to the outbox, never to local usage.json.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Delivery } from "../../../src/altimate/learn/delivery"
import { canonical, type Lesson } from "../../../src/altimate/learn/lesson"
import * as Store from "../../../src/altimate/learn/store"
import { files, readOutbox, writeRemote, type Remote, type Scope } from "../../../src/altimate/learn/ledger"
import type { LessonOut } from "../../../src/altimate/workspace/lesson-api"
import { SessionPrompt } from "../../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../../src/session/schema"
import { ModelID, ProviderID } from "../../../src/provider/schema"
import type { MessageV2 } from "../../../src/session/message-v2"

const NAME = "team-playbook"
const REPO = "https://github.com/acme/analytics"
const scope: Scope = { apiUrl: "http://x", tenant: "acme", account: "a".repeat(64), datamateId: 7, repoRemote: "git@github.com:acme/analytics.git" }
const view = { scope: () => scope }
const lesson = (id: string, text: string, extra: Partial<Lesson> = {}): Lesson => ({
  id, text, tags: [], scope: "project", helpful: 0, harmful: 0, applied: 0,
  created: "2026-10-01T00:00:00.000Z", updated: "2026-10-01T00:00:00.000Z", ...extra,
})
const out = (key: string, text: string, extra: Partial<LessonOut> = {}): LessonOut => ({
  public_id: `pub-${key}`, lesson_key: key, repo_identity: REPO, store: NAME, text, tags: [], trigger_paths: [],
  pinned: false, coexists: [], helpful: 0, harmful: 0, applied: 0, version: 1, updated_at: "2026-10-02T00:00:00.000Z", ...extra,
})
let pulls = 0
const tomb = (key: string) => ({ repo_identity: REPO, store: NAME, lesson_key: key })

let root: string
beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "learn-sync-delivery-"))) })
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

async function approve(lessons: Lesson[]) {
  const p = Store.paths(root, NAME)
  await fs.mkdir(p.learnDir, { recursive: true })
  await fs.writeFile(p.approved, canonical(lessons))
}
/** What a pull writes: each call is a new pull (`pulled_at` changes). */
async function pulled(lessons: LessonOut[], tombstones: Remote["tombstones"] = [], at = scope) {
  pulls++
  const remote: Remote = {
    version: 1, scope: at, revision: pulls, pulled_at: new Date(Date.UTC(2026, 9, 2, 0, pulls)).toISOString(), repo_identity: REPO,
    share: false, pending_count: 0, lessons, tombstones,
  }
  await Store.transaction(root, () => writeRemote(root, NAME, remote))
}

describe("delivery by identity", () => {
  test("team lessons are delivered alongside local ones; sync off delivers none", async () => {
    await approve([lesson("L-0001", "Keep amount_cents in integer cents.")])
    await pulled([out("L-0d01", "Prefix staging models with stg_.")])
    const synced = await new Delivery(root, {}, root, view).prepare("ses_1", "m1", "staging cents")
    expect(synced.section).toContain("Prefix staging models with stg_.")
    expect(synced.section).toContain("Keep amount_cents in integer cents.")
    const local = await new Delivery(root).prepare("ses_2", "m1", "staging cents")
    expect(local.section).not.toContain("Prefix staging models")
  })

  test("a locally sourced lesson later tombstoned leaves the frozen section", async () => {
    await approve([lesson("L-0001", "Keep amount_cents in integer cents."), lesson("L-0002", "Name surrogate keys after their grain.")])
    await pulled([])
    const delivery = new Delivery(root, {}, root, view)
    const before = await delivery.prepare("ses_1", "m1", "cents keys")
    expect(before.section).toContain("Keep amount_cents in integer cents.")
    expect(await delivery.reconcile("ses_1")).toBe(false)
    await pulled([], [tomb("L-0001")])
    expect(await delivery.reconcile("ses_1")).toBe(true)
    expect(delivery.generation).toBe(1)
    const section = await delivery.section("ses_1")
    expect(section).not.toContain("amount_cents")
    expect(section).toContain("Name surrogate keys after their grain.")
    // The cached request returns the rebuilt section; nothing else changed.
    expect((await delivery.prepare("ses_1", "m1", "cents keys")).section).toBe(section)
    expect(await delivery.reconcile("ses_1")).toBe(false)
  })

  test("an approved replacement retires a shown team lesson; a pin-only change keeps it", async () => {
    await approve([])
    await pulled([out("L-0d01", "Prefix staging models with stg_.")])
    const delivery = new Delivery(root, {}, root, view)
    await delivery.prepare("ses_1", "m1", "staging")
    await pulled([out("L-0d01", "Prefix staging models with stg_.", { version: 2, pinned: true })])
    expect(await delivery.reconcile("ses_1")).toBe(false)
    expect(await delivery.section("ses_1")).toContain("Prefix staging models with stg_.")
    await pulled([out("L-0d01", "Prefix staging models with stg_ and keep them thin.", { public_id: "pub-edit", version: 1 })])
    expect(await delivery.reconcile("ses_1")).toBe(true)
    expect(await delivery.section("ses_1")).toBe("")
    // The replacement can be selected by a later request; it was not shown yet.
    expect((await delivery.prepare("ses_1", "m2", "staging models thin")).requestNote).toContain("keep them thin")
  })

  test("a changed scope or sync turned off removes team lessons but keeps local ones", async () => {
    await approve([lesson("L-0001", "Keep amount_cents in integer cents.")])
    await pulled([out("L-0d01", "Prefix staging models with stg_.")])
    await new Delivery(root, {}, root, view).prepare("ses_1", "m1", "staging cents")
    const relinked = new Delivery(root, {}, root, { scope: () => ({ ...scope, datamateId: 8 }) })
    expect(await relinked.reconcile("ses_1")).toBe(true)
    expect(await relinked.section("ses_1")).not.toContain("stg_")
    expect(await relinked.section("ses_1")).toContain("amount_cents")

    await new Delivery(root, {}, root, view).prepare("ses_2", "m1", "staging cents")
    const off = new Delivery(root)
    expect(await off.reconcile("ses_2")).toBe(true)
    expect(await off.section("ses_2")).not.toContain("stg_")
  })

  test("request notes and their attached parts are rebuilt", async () => {
    await approve([])
    await pulled([out("L-0d01", "Prefix staging models with stg_.")])
    const limits = { core_lessons: 0, retrieved_lessons: 0 }
    const delivery = new Delivery(root, limits, root, view)
    await delivery.prepare("ses_1", "msg_m1", "hello")
    const note = (await delivery.prepare("ses_1", "msg_m2", "staging models")).requestNote
    expect(note).toContain("Prefix staging models with stg_.")
    const sessionID = SessionID.make("ses_1")
    const messageID = MessageID.make("msg_m2")
    const message: MessageV2.WithParts = {
      info: { id: messageID, sessionID, role: "user", time: { created: 0 }, agent: "build", model: { providerID: ProviderID.make("test"), modelID: ModelID.make("m") } },
      parts: [{ id: PartID.ascending(), sessionID, messageID, type: "text", text: "staging models" }],
    }
    const attached = await SessionPrompt.attachTeamRules(message, note, delivery, async () => {})
    await pulled([])
    expect(await delivery.reconcile("ses_1")).toBe(true)
    const rebuilt = await delivery.prepare("ses_1", "msg_m2", "staging models")
    expect(rebuilt.requestNote).toBe("")
    const writes: MessageV2.TextPart[] = []
    await SessionPrompt.attachTeamRules(message, rebuilt.requestNote, delivery, async (part) => { writes.push(part) })
    expect(writes).toEqual([expect.objectContaining({ id: attached!.id, ignored: true })])
  })

  test("compaction replay and the file hook use the reconciled set", async () => {
    await approve([lesson("L-0004", "Validate the customer_id before writing profiles.", { trigger: { paths: ["profiles/**"] } })])
    await pulled([out("L-0d01", "Prefix staging models with stg_.")])
    const delivery = new Delivery(root, { core_lessons: 5 }, root, view)
    await delivery.prepare("ses_1", "m1", "staging")
    await pulled([], [tomb("L-0004")])
    expect(await delivery.reconcile("ses_1")).toBe(true)
    expect(await delivery.compact("ses_1", "marker-1")).toBe("")
    expect(await delivery.file("ses_1", "profiles/a.ts")).toBe("")
    // Without the tombstone the same file event delivers it.
    await pulled([])
    const fresh = new Delivery(root, { core_lessons: 0, retrieved_lessons: 0 }, root, view)
    await fresh.prepare("ses_2", "m1", "hello")
    expect(await fresh.file("ses_2", "profiles/a.ts")).toContain("customer_id")
  })

  test("sync off with only local lessons: reconcile never locks or writes", async () => {
    await approve([lesson("L-0001", "Keep amount_cents in integer cents.")])
    const delivery = new Delivery(root)
    await delivery.prepare("ses_1", "m1", "cents")
    const file = path.join(root, ".altimate-code", "learn", ".sessions", Store.sha256("ses_1") + ".json")
    const before = [await fs.readFile(file, "utf8"), (await fs.stat(file)).mtimeMs]
    expect(await delivery.reconcile("ses_1")).toBe(false)
    expect([await fs.readFile(file, "utf8"), (await fs.stat(file)).mtimeMs]).toEqual(before)
  })
})

describe("usage", () => {
  test("local counts go to usage.json; team counts to one outbox batch, keyed by the delivered public_id", async () => {
    await approve([lesson("L-0001", "Keep amount_cents in integer cents.")])
    await pulled([out("L-0d01", "Prefix staging models with stg_.")])
    const delivery = new Delivery(root, {}, root, view)
    await delivery.prepare("ses_1", "m1", "staging cents")
    await delivery.flush("ses_1")
    expect(await Store.readUsage(root, NAME)).toEqual({ "L-0001": 1 })
    const outbox = await readOutbox(root, NAME)
    expect(outbox.usage).toHaveLength(1)
    expect(outbox.usage[0].items).toEqual([{ public_id: "pub-L-0d01", applied: 1, helpful: 0, harmful: 0 }])
    expect(outbox.usage[0].batch_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    await delivery.flush("ses_1")
    expect((await readOutbox(root, NAME)).usage).toHaveLength(1)
  })

  test("a flush retried after a crash queues the same batch id", async () => {
    await approve([])
    await pulled([out("L-0d01", "Prefix staging models with stg_.")])
    const delivery = new Delivery(root, {}, root, view)
    await delivery.prepare("ses_1", "m1", "staging")
    const state = path.join(root, ".altimate-code", "learn", ".sessions", Store.sha256("ses_1") + ".json")
    const saved = await fs.readFile(state, "utf8")
    await delivery.flush("ses_1")
    const first = (await readOutbox(root, NAME)).usage[0].batch_id
    // Crash before the session ledger recorded the count: the retry rebuilds the same batch.
    await Store.transaction(root, () => fs.writeFile(state, saved))
    await delivery.flush("ses_1")
    const usage = (await readOutbox(root, NAME)).usage
    expect(usage.map((u) => u.batch_id)).toEqual([first])
  })
})

test("sync state files are kept out of Git by the learn .gitignore", async () => {
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited
  await pulled([])
  const p = files(root, NAME)
  await Store.transaction(root, async () => {
    for (const file of [p.outbox, p.sync]) await fs.writeFile(file, "{}")
  })
  await approve([])
  const ignored = async (file: string) => (await Bun.spawn(["git", "check-ignore", "-q", file], { cwd: root }).exited) === 0
  expect(await ignored(p.remote)).toBe(true)
  expect(await ignored(p.outbox)).toBe(true)
  expect(await ignored(p.sync)).toBe(true)
  expect(await ignored(Store.paths(root, NAME).approved)).toBe(false)
})
