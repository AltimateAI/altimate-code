// altimate_change - new file
//
// Lesson sync against an in-memory server implementing the learned-lesson contract over real HTTP:
// pull, tombstones, backoff, push, conflicts held (never resent over an owner's edit), scope holds,
// usage replay, gate 9, and the end-to-end flow between two teammates and the workspace owner.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { canonical, type Lesson } from "../../../src/altimate/learn/lesson"
import * as Store from "../../../src/altimate/learn/store"
import * as Sync from "../../../src/altimate/learn/sync"
import { files, readOutbox, readRemote, readSyncState, type Scope } from "../../../src/altimate/learn/ledger"
import { enqueue, lessonIntent, type Intent } from "../../../src/altimate/learn/proposals"
import { reflectCore } from "../../../src/altimate/learn/session-reflect"
import { autoPromote, autoPromoteStateFile } from "../../../src/altimate/learn/auto-promote"
import { DEFAULT_AUTO_PROMOTE_LIMITS } from "../../../src/altimate/learn/config"
import { Delivery } from "../../../src/altimate/learn/delivery"
import { credentialDigest } from "../../../src/altimate/workspace/state"
import { checkout, repoIdentity, sandboxHome, startServer, syncEnv, type Server } from "./sync-fixture"

const NAME = "team-playbook"
const REMOTE = "git@github.com:acme/analytics.git"
const OTHER_REMOTE = "git@github.com:acme/finance.git"
const learn = { sync: true }
const limits = { core_lessons: 10, retrieved_lessons: 10, budget_tokens: 1500, session_max_lessons: 40 }
type Ready = Extract<Sync.Context, { status: "ready" }>

const lesson = (id: string, text: string, extra: Partial<Lesson> = {}): Lesson => ({
  id, text, tags: [], scope: "project", helpful: 0, harmful: 0, applied: 0,
  created: "2026-10-01T00:00:00.000Z", updated: "2026-10-01T00:00:00.000Z", ...extra,
})

let home: Awaited<ReturnType<typeof sandboxHome>>
let server: Server
let restoreEnv: () => void
const roots: string[] = []

beforeAll(async () => { home = await sandboxHome() })
afterAll(async () => { await home.restore() })
beforeEach(() => {
  server = startServer()
  server.bindings.set(REMOTE, server.datamateId)
  restoreEnv = syncEnv()
})
afterEach(async () => {
  server.stop()
  restoreEnv()
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

async function project(remote = REMOTE) {
  const root = await checkout(remote)
  roots.push(root)
  return root
}

async function ready(apiKey: string, remote = REMOTE, datamateId = server.datamateId): Promise<Ready> {
  const actAs = await home.signIn(server.url, apiKey)
  const scope: Scope = { apiUrl: server.url, tenant: "acme", account: credentialDigest(server.url, "acme", apiKey), datamateId, repoRemote: remote }
  return { status: "ready", actAs, scope }
}

async function approve(root: string, lessons: Lesson[]) {
  const p = Store.paths(root, NAME)
  await fs.mkdir(p.learnDir, { recursive: true })
  await fs.writeFile(p.approved, canonical(lessons))
}

async function queue(root: string, ctx: Ready, intents: Intent[]) {
  return Store.transaction(root, () => enqueue(root, NAME, ctx.scope, intents))
}

const upsert = (key: string, text: string, repo = repoIdentity(REMOTE)): Intent =>
  lessonIntent(NAME, { repo_identity: repo }, lesson(key, text), "manual", () => undefined)
const batches = () => server.requests.filter((r) => r.path.endsWith("/lessons/batch"))

describe("pull", () => {
  test("caches approved team lessons, sends local keys, and records tombstones and the ledger", async () => {
    const root = await project()
    const ctx = await ready("key-a")
    const team = server.add({ lesson_key: "L-00a1", text: "Prefix staging models with stg_." }, REMOTE)
    server.add({ lesson_key: "L-00b1", text: "Old rule.", status: "retired" }, REMOTE)
    await approve(root, [lesson("L-00b1", "Old rule."), lesson("L-00c1", "Local only.")])
    expect(await Sync.pull(root, NAME, ctx)).toMatchObject({ outcome: "ok", lessons: 1, tombstones: 1 })
    expect(server.requests.find((r) => r.path.endsWith("/sync"))!.body).toMatchObject({ repo_remote: REMOTE, store: NAME, local_keys: ["L-00b1", "L-00c1"] })
    const remote = (await readRemote(root, NAME))!
    expect(remote.lessons.map((l) => l.lesson_key)).toEqual(["L-00a1"])
    expect(remote.tombstones).toEqual([{ repo_identity: repoIdentity(REMOTE), store: NAME, lesson_key: "L-00b1" }])
    expect(remote.repo_identity).toBe(repoIdentity(REMOTE))
    const state = await readSyncState(root, NAME)
    expect(Object.values(state.ledger).find((e) => e.approved)?.approved).toEqual({ public_id: team.public_id, version: 1 })
    // Private state: mode 0600.
    for (const file of [files(root, NAME).remote, files(root, NAME).sync]) expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
  })

  test("an unchanged revision keeps the cached lessons and still returns tombstones", async () => {
    const root = await project()
    const ctx = await ready("key-a")
    server.add({ lesson_key: "L-00a1", text: "Team rule." }, REMOTE)
    await Sync.pull(root, NAME, ctx)
    // A terminal row alone does not change the served set or its revision.
    const retired = server.add({ lesson_key: "L-00d1", text: "Gone.", status: "retired" }, REMOTE)
    await approve(root, [lesson("L-00d1", retired.text)])
    expect(await Sync.pull(root, NAME, ctx)).toMatchObject({ outcome: "unchanged", lessons: 1, tombstones: 1 })
    expect(server.requests.filter((r) => r.path.endsWith("/sync")).at(-1)!.body.known_revision).toBe(server.revision)
  })

  test("a retired key restored by Git or rollback after a successful sync stays hidden", async () => {
    const root = await project()
    const ctx = await ready("key-a")
    server.add({ lesson_key: "L-00e1", text: "Retired team rule about cents.", status: "retired" }, REMOTE)
    await approve(root, [lesson("L-00e1", "Retired team rule about cents.")])
    await Sync.pull(root, NAME, ctx)
    // Rolled back locally: the key is no longer sent, so the server returns no tombstone for it...
    await approve(root, [])
    await Sync.pull(root, NAME, ctx)
    // ...and a later Git restore brings it back. The cached tombstone still hides it.
    await approve(root, [lesson("L-00e1", "Retired team rule about cents.")])
    const delivery = new Delivery(root, limits, root, { scope: () => ctx.scope })
    expect((await delivery.prepare("ses_1", "msg_1", "cents")).section).toBe("")
  })

  test("a route the server lacks backs off for 24 hours", async () => {
    const root = await project()
    const ctx = await ready("key-a")
    server.routesMissing = true
    expect((await Sync.pull(root, NAME, ctx)).outcome).toBe("unsupported")
    const until = Date.parse((await readSyncState(root, NAME)).unsupported_until!)
    expect(until - Date.now()).toBeGreaterThan(23 * 3600_000)
    const count = server.requests.length
    expect((await Sync.pull(root, NAME, ctx)).outcome).toBe("unsupported")
    expect((await Sync.push(root, NAME, ctx)).error).toContain("does not support")
    expect(server.requests.length).toBe(count)
  })

  test("transient errors keep the cache; workspace_not_found invalidates it", async () => {
    const root = await project()
    const ctx = await ready("key-a")
    server.add({ lesson_key: "L-00a1", text: "Team rule." }, REMOTE)
    await Sync.pull(root, NAME, ctx)
    server.failNext = 1
    expect(await Sync.pull(root, NAME, ctx)).toMatchObject({ outcome: "error", kind: "transient" })
    expect(await readRemote(root, NAME)).toBeDefined()
    server.datamateId = 99
    expect(await Sync.pull(root, NAME, ctx)).toMatchObject({ outcome: "error", kind: "workspace_not_found" })
    expect(await readRemote(root, NAME)).toBeUndefined()
  })

  test("a result whose account changed in flight is discarded", async () => {
    const root = await project()
    const ctx = await ready("key-a")
    server.add({ lesson_key: "L-00a1", text: "Team rule." }, REMOTE)
    await home.signIn(server.url, "key-b")
    expect((await Sync.pull(root, NAME, ctx)).outcome).toBe("discarded")
    expect(await readRemote(root, NAME)).toBeUndefined()
  })
})

describe("push", () => {
  test("offline retries create no duplicates", async () => {
    const root = await project()
    const ctx = await ready("key-a")
    await Sync.pull(root, NAME, ctx)
    await queue(root, ctx, [upsert("L-0f01", "Name surrogate keys after their grain.")])
    server.failNext = 1
    const failed = await Sync.push(root, NAME, ctx)
    expect(failed).toMatchObject({ submitted: 0, deferred: 1 })
    expect(failed.error).toBeDefined()
    // A restart: the outbox survives on disk.
    const saved = await fs.readFile(files(root, NAME).outbox, "utf8")
    expect(await Sync.push(root, NAME, ctx)).toMatchObject({ submitted: 1, deferred: 0 })
    // A crash after sending but before the acknowledgement was recorded resends the same item.
    await Store.transaction(root, async () => fs.writeFile(files(root, NAME).outbox, saved))
    expect(await Sync.push(root, NAME, ctx)).toMatchObject({ submitted: 0, duplicate: 1 })
    expect(server.rows.filter((r) => r.lesson_key === "L-0f01")).toHaveLength(1)
    expect((await readOutbox(root, NAME)).proposals).toEqual([])
  })

  test("a version conflict is held and never resent over an owner edit; --resubmit rebases explicitly", async () => {
    const root = await project()
    const ctx = await ready("key-a")
    await Sync.pull(root, NAME, ctx)
    await queue(root, ctx, [upsert("L-0f02", "Document every mart in its schema file.")])
    await Sync.push(root, NAME, ctx)
    await Sync.pull(root, NAME, ctx)
    const mine = server.rows.find((r) => r.lesson_key === "L-0f02")!
    // The owner edits the proposal (version 2) while the member revises it from version 1.
    server.editCandidate(mine.public_id, "Document every mart and its grain in its schema file.")
    const sent = batches().length
    await queue(root, ctx, [upsert("L-0f02", "Document every new mart in the schema file.")])
    const pushed = await Sync.push(root, NAME, ctx)
    expect(pushed).toMatchObject({ conflict: 1, held: 1 })
    expect(batches().length).toBe(sent + 1)
    const outbox = await readOutbox(root, NAME)
    expect(outbox.proposals[0]).toMatchObject({ state: "held" })
    expect(outbox.proposals[0].reason).toContain("version_conflict")
    // Held proposals are not sent again by later pushes.
    await Sync.push(root, NAME, ctx)
    expect(batches().length).toBe(sent + 1)
    expect(server.rows.find((r) => r.public_id === mine.public_id)!.text).toBe("Document every mart and its grain in its schema file.")
    // An explicit resubmit is based on the owner's version.
    await Sync.pull(root, NAME, ctx)
    expect(await Sync.push(root, NAME, ctx, { resubmit: "L-0f02" })).toMatchObject({ submitted: 1, held: 0 })
    expect(batches().at(-1)!.body.items[0]).toMatchObject({ revises_public_id: mine.public_id, revises_version: 2 })
    expect(server.rows.find((r) => r.public_id === mine.public_id)!.status).toBe("rejected")
  })

  test("a conflict whose content the server already holds is dropped as satisfied", async () => {
    const root = await project()
    const ctx = await ready("key-a")
    await Sync.pull(root, NAME, ctx)
    await queue(root, ctx, [upsert("L-0f03", "Keep incremental models idempotent.")])
    await Sync.push(root, NAME, ctx)
    await Sync.pull(root, NAME, ctx)
    const mine = server.rows.find((r) => r.lesson_key === "L-0f03")!
    server.editCandidate(mine.public_id, "Keep incremental models idempotent on reruns.")
    await queue(root, ctx, [upsert("L-0f03", "Keep incremental models idempotent on reruns.")])
    expect(await Sync.push(root, NAME, ctx)).toMatchObject({ conflict: 0, duplicate: 1, held: 0 })
    expect((await readOutbox(root, NAME)).proposals).toEqual([])
  })

  test("a rejected submission is never re-sent", async () => {
    const root = await project()
    const ctx = await ready("key-a")
    await Sync.pull(root, NAME, ctx)
    const intent = upsert("L-0f04", "Use singular names for dimensions.")
    await queue(root, ctx, [intent])
    await Sync.push(root, NAME, ctx)
    server.reject(server.rows.find((r) => r.lesson_key === "L-0f04")!.public_id)
    await Sync.pull(root, NAME, ctx)
    expect(await queue(root, ctx, [intent])).toBe(0)
    const sent = batches().length
    await Sync.push(root, NAME, ctx)
    expect(batches().length).toBe(sent)
  })

  test("proposals created for another workspace are held and never retargeted", async () => {
    const root = await project()
    const first = await ready("key-a")
    await Sync.pull(root, NAME, first)
    await queue(root, first, [upsert("L-0f05", "Prefer explicit column lists.")])
    const relinked = { ...first, scope: { ...first.scope, datamateId: 8 } }
    server.datamateId = 8
    server.bindings.set(REMOTE, 8)
    const report = await Sync.push(root, NAME, relinked)
    expect(report).toMatchObject({ submitted: 0, heldOtherScope: 1 })
    expect(batches()).toHaveLength(0)
    expect((await readOutbox(root, NAME)).proposals).toHaveLength(1)
  })

  test("a usage batch replayed after a crash is counted once", async () => {
    const root = await project()
    const ctx = await ready("key-a")
    const team = server.add({ lesson_key: "L-00a1", text: "Team rule." }, REMOTE)
    await Sync.pull(root, NAME, ctx)
    await Store.transaction(root, () => enqueue(root, NAME, ctx.scope, [], [{ public_id: team.public_id, applied: 2, helpful: 0, harmful: 0 }]))
    const saved = await fs.readFile(files(root, NAME).outbox, "utf8")
    expect((await Sync.push(root, NAME, ctx)).usage).toBe(1)
    await Store.transaction(root, async () => fs.writeFile(files(root, NAME).outbox, saved))
    expect((await Sync.push(root, NAME, ctx)).usage).toBe(1)
    expect(server.rows.find((r) => r.public_id === team.public_id)!.applied).toBe(2)
    expect((await readOutbox(root, NAME)).usage).toEqual([])
  })

  test("a grandfathered long lesson is not sent; status names it", async () => {
    const root = await project()
    const ctx = await ready("key-a")
    await approve(root, [lesson("L-0a03", "y".repeat(150)), lesson("L-0a04", "Short rule.")])
    await Sync.pull(root, NAME, ctx)
    expect(await Sync.push(root, NAME, ctx)).toMatchObject({ backfilled: 1, submitted: 1 })
    expect(server.rows.map((r) => r.lesson_key)).toEqual(["L-0a04"])
    const status = await Sync.status(root, NAME, { sync: true })
    expect(status.not_syncable).toEqual([{ lesson_key: "L-0a03", reason: expect.stringContaining("too long") }])
  })

  test("first sync uploads the staged set once, as backfill", async () => {
    const root = await project()
    const ctx = await ready("key-a")
    await approve(root, [lesson("L-0a01", "Approved one.", { helpful: 2 }), lesson("L-0a02", "Approved two.")])
    await Sync.pull(root, NAME, ctx)
    expect(await Sync.push(root, NAME, ctx)).toMatchObject({ backfilled: 2, submitted: 2 })
    expect(batches()[0].body.items.map((i: { lesson_key: string; origin: string }) => [i.lesson_key, i.origin]))
      .toEqual([["L-0a01", "backfill"], ["L-0a02", "backfill"]])
    expect(await Sync.push(root, NAME, ctx)).toMatchObject({ backfilled: 0, submitted: 0 })
    expect((await readSyncState(root, NAME)).backfill.complete).toBe(true)
  })
})

describe("gate", () => {
  test("off: no requests at all", async () => {
    const root = await project()
    await home.signIn(server.url, "key-a")
    const report = await Sync.run(root, root, {})
    expect(report.context.status).toBe("off")
    expect(server.requests).toEqual([])
  })

  test("resolves the bound workspace from the git remote, and an unlinked project invalidates the cache", async () => {
    const root = await project()
    await home.signIn(server.url, "key-a")
    server.add({ lesson_key: "L-00a1", text: "Team rule." }, REMOTE)
    const report = await Sync.run(root, root, learn)
    // The binding's remote, as the server stores it (the client sends the remote git reports).
    expect(report.context).toMatchObject({ status: "ready", scope: { datamateId: server.datamateId } })
    expect(report.pulls[0]).toMatchObject({ outcome: "ok", lessons: 1 })
    const unlinked = await project(OTHER_REMOTE)
    await Store.transaction(unlinked, async () => {
      const { writeRemote } = await import("../../../src/altimate/learn/ledger")
      await writeRemote(unlinked, NAME, (await readRemote(root, NAME))!)
    })
    expect((await Sync.run(unlinked, unlinked, learn)).context).toMatchObject({ status: "skipped", invalidate: true })
    expect(await readRemote(unlinked, NAME)).toBeUndefined()
  })
})

describe("session start", () => {
  const syncs = () => server.requests.filter((r) => r.path.endsWith("/lessons/sync")).length

  test("without a valid cache it waits for the pull before the first delivery, once per session", async () => {
    const root = await project()
    await home.signIn(server.url, "key-a")
    server.add({ lesson_key: "L-00a1", text: "Prefix staging models with stg_." }, REMOTE)
    const started = await Sync.sessionStart(root, root, learn, { session: "ses_start_1" })
    expect(started!.scope()).toMatchObject({ datamateId: server.datamateId })
    expect((await new Delivery(root, limits, root, started).prepare("ses_start_1", "m1", "staging")).section).toContain("stg_")
    await started!.done
    const again = await Sync.sessionStart(root, root, learn, { session: "ses_start_1" })
    expect(again).toBe(started)
    expect(syncs()).toBe(1)
  })

  test("a valid cache is used at once while the pull continues; a slow server without one is waited for briefly", async () => {
    const root = await project()
    await home.signIn(server.url, "key-a")
    server.add({ lesson_key: "L-00a1", text: "Prefix staging models with stg_." }, REMOTE)
    await (await Sync.sessionStart(root, root, learn, { session: "ses_warm" }))!.done
    server.delayMs = 1_500
    let at = Date.now()
    const cached = await Sync.sessionStart(root, root, learn, { session: "ses_cached", waitMs: 5_000 })
    expect(Date.now() - at).toBeLessThan(1_000)
    expect(cached!.scope()).toBeDefined()
    await cached!.done

    const cold = await project()
    server.delayMs = 600
    at = Date.now()
    const waited = await Sync.sessionStart(cold, cold, learn, { session: "ses_cold", waitMs: 300 })
    expect(Date.now() - at).toBeLessThan(600)
    expect(waited!.scope()).toBeUndefined()
    await waited!.done
    expect(waited!.scope()).toBeDefined()
  }, 20_000)

  test("concurrent pulls share one request", async () => {
    const root = await project()
    const ctx = await ready("key-a")
    server.delayMs = 100
    const [first, second] = await Promise.all([Sync.pull(root, NAME, ctx), Sync.pull(root, NAME, ctx)])
    expect(first).toBe(second)
    expect(syncs()).toBe(1)
  })

  test("sync off: no session sync at all", async () => {
    const root = await project()
    await home.signIn(server.url, "key-a")
    expect(await Sync.sessionStart(root, root, {}, { session: "ses_off" })).toBeUndefined()
    expect(server.requests).toEqual([])
  })
})

describe("auto-promote gate 9", () => {
  test("a team lesson is person-approved even when a stale local auto mark claims it", async () => {
    const root = await project()
    const ctx = await ready("key-a")
    const approved = [lesson("L-0b01", "Prefix staging models with stg_.")]
    await approve(root, approved)
    server.add({ lesson_key: "L-0b01", text: "Prefix staging models with stg_." }, REMOTE)
    await Sync.pull(root, NAME, ctx)
    await Store.transaction(root, async () => {
      await fs.writeFile(autoPromoteStateFile(root, NAME), JSON.stringify({
        promotions: [], auto: { "L-0b01": Store.sha256(approved[0].text) }, approvedHash: Store.sha256(canonical(approved)),
      }))
    })
    await Store.transaction(root, () => fs.writeFile(Store.paths(root, NAME).candidate, canonical([lesson("L-0b01", "Prefix staging models with stg_ and keep them thin.")])))
    const hash = Store.sha256(canonical((await Store.loadCandidateLessons(root, NAME))!))
    const result = await autoPromote({
      root, name: NAME, expectedCandidateHash: hash, signals: 1, signalKinds: ["user_correction"],
      limits: { ...DEFAULT_AUTO_PROMOTE_LIMITS }, sync: { scope: ctx.scope },
    })
    expect(result).toMatchObject({ status: "held" })
    expect((result as { reason: string }).reason).toContain("person-approved lesson L-0b01")
  })

  test("an automatic promotion records its proposals before the candidate is consumed", async () => {
    const root = await project()
    const ctx = await ready("key-a")
    await Sync.pull(root, NAME, ctx)
    await Store.transaction(root, () => fs.writeFile(Store.paths(root, NAME).candidate, canonical([lesson("L-0b02", "Name surrogate keys after the grain.")])))
    await Store.transaction(root, async () => {
      const state = await readSyncState(root, NAME)
      // The first sync is done: this test isolates the promotion's own proposal.
      const { writeSyncState, forScope } = await import("../../../src/altimate/learn/ledger")
      await writeSyncState(root, NAME, { ...forScope(state, ctx.scope), backfill: { complete: true, done: [] } })
    })
    const hash = Store.sha256(canonical((await Store.loadCandidateLessons(root, NAME))!))
    const result = await autoPromote({
      root, name: NAME, expectedCandidateHash: hash, signals: 1, signalKinds: ["user_correction"],
      limits: { ...DEFAULT_AUTO_PROMOTE_LIMITS }, sync: { scope: ctx.scope },
    })
    expect(result.status).toBe("promoted")
    expect((await readOutbox(root, NAME)).proposals.map((p) => [p.item.lesson_key, p.item.change_type, p.item.origin]))
      .toEqual([["L-0b02", "add", "auto_promote"]])
  })
})

describe("a local lesson the team retired", () => {
  test("backfill, approval, retirement: hidden from every delivery path and marked as retired", async () => {
    const root = await project()
    const ctx = await ready("key-a")
    const key = "L-1234abcd5678ef90"
    const text = "Name staging models stg_source__entity in models/staging."
    await approve(root, [lesson(key, text, { trigger: { paths: ["models/staging/**"] } })])
    // First sync backfills it; the owner approves it.
    await Sync.pull(root, NAME, ctx)
    expect(await Sync.push(root, NAME, ctx)).toMatchObject({ backfilled: 1, submitted: 1 })
    expect((await Sync.markers(root, NAME))!.mark(key, text)).toBe("pending review")
    const row = server.rows.find((r) => r.lesson_key === key)!
    server.approve(row.public_id)
    await Sync.pull(root, NAME, ctx)
    expect((await Sync.markers(root, NAME))!.mark(key, text)).toBe("team")
    const delivered = new Delivery(root, limits, root, { scope: () => ctx.scope })
    expect((await delivered.prepare("ses_before", "m1", "staging models")).section).toContain("stg_source__entity")

    // The owner retires it; the next pull returns a tombstone for the key still in approved.json.
    server.retire(row.public_id)
    expect(await Sync.pull(root, NAME, ctx)).toMatchObject({ outcome: "ok", lessons: 0, tombstones: 1 })
    expect((await Store.loadApproved(root, NAME)).map((l) => l.id)).toEqual([key])

    // Every delivery path leaves it out: core section, retrieval, per-request notes, and the file hook.
    const fresh = new Delivery(root, limits, root, { scope: () => ctx.scope })
    expect((await fresh.prepare("ses_after", "m1", "staging models stg_source__entity")).section).toBe("")
    expect((await fresh.prepare("ses_after", "m2", "rename staging models entity")).requestNote).toBe("")
    expect(await fresh.file("ses_after", "models/staging/stg_orders.sql")).toBe("")
    // A running session that was shown it drops it from its frozen section.
    expect(await delivered.reconcile("ses_before")).toBe(true)
    expect(await delivered.section("ses_before")).not.toContain("stg_source__entity")

    // `learn show` and `learn status --json` say why.
    expect((await Sync.markers(root, NAME))!.mark(key, text)).toBe("retired by team — not delivered")
    expect((await Sync.status(root, NAME, { sync: true })).hidden_local).toEqual([{ lesson_key: key, reason: "retired by team — not delivered" }])
  })

  test("a local copy that differs from the team version is marked as replaced", async () => {
    const root = await project()
    const ctx = await ready("key-a")
    await approve(root, [lesson("L-0c01", "Old local wording.")])
    server.add({ lesson_key: "L-0c01", text: "Team wording." }, REMOTE)
    await Sync.pull(root, NAME, ctx)
    expect((await Sync.markers(root, NAME))!.mark("L-0c01", "Old local wording.")).toBe("team version delivered instead")
  })
})

describe("end to end", () => {
  test("stage, review, receive, share, edit, retire, fresh clone, and offline retries", async () => {
    // 1. User A stages a lesson by reflection.
    const a = await project()
    const ctxA = await ready("key-a")
    await Sync.pull(a, NAME, ctxA)
    await Store.transaction(a, async () => {
      const state = await readSyncState(a, NAME)
      const { writeSyncState, forScope } = await import("../../../src/altimate/learn/ledger")
      await writeSyncState(a, NAME, { ...forScope(state, ctxA.scope), backfill: { complete: true, done: [] } })
    })
    const text = "Convert amount_cents columns to dollars in staging models."
    const reflected = await reflectCore({
      root: a, name: NAME, source: { prompts: [], calls: [] }, feedback: "Amounts must be in dollars.", kind: "review", origin: "ses_a",
      generate: async () => ({ deltas: [{ op: "ADD", text, reason: "review" }] }), sync: { scope: ctxA.scope, origin: "manual" },
    })
    expect(reflected.proposals).toBe(1)
    // Staged locally (candidate), never approved locally, and queued for review.
    expect((await Store.loadCandidateLessons(a, NAME))!.map((l) => l.text)).toEqual([text])
    expect(await Store.readPromoted(a, NAME)).toBeUndefined()
    expect(await Sync.push(a, NAME, ctxA)).toMatchObject({ submitted: 1 })

    // 2. It is in the owner's queue and not delivered to B.
    const proposal = server.rows.find((r) => r.text === text)!
    expect(proposal.status).toBe("candidate")
    const b = await project()
    const ctxB = await ready("key-b")
    await Sync.pull(b, NAME, ctxB)
    const sessionB = new Delivery(b, limits, b, { scope: () => ctxB.scope })
    expect((await sessionB.prepare("ses_b0", "m1", "amount cents")).section).not.toContain(text)

    // 3. The owner approves; B receives it.
    server.approve(proposal.public_id)
    await Sync.pull(b, NAME, ctxB)
    const running = new Delivery(b, limits, b, { scope: () => ctxB.scope })
    expect((await running.prepare("ses_b1", "m1", "amount cents")).section).toContain(text)

    // 4. Another repository does not receive it until sharing is on.
    server.bindings.set(OTHER_REMOTE, server.datamateId)
    const c = await project(OTHER_REMOTE)
    const ctxC = await ready("key-b", OTHER_REMOTE)
    await Sync.pull(c, NAME, ctxC)
    expect((await readRemote(c, NAME))!.lessons).toEqual([])
    server.share = true
    server.revision++
    await Sync.pull(c, NAME, ctxC)
    expect((await readRemote(c, NAME))!.lessons.map((l) => l.text)).toEqual([text])
    server.share = false
    server.revision++

    // 5. An edit keeps the old lesson live until it is approved.
    await ready("key-a")
    await Sync.pull(a, NAME, ctxA)
    const edited = "Convert amount_cents columns to dollars with a _usd suffix in staging."
    await queue(a, ctxA, [upsert(proposal.lesson_key, edited)])
    await Sync.push(a, NAME, ctxA)
    const edit = server.rows.find((r) => r.text === edited)!
    expect(edit).toMatchObject({ change_type: "edit", status: "candidate", replaces: [{ public_id: proposal.public_id, version: 2 }] })
    await ready("key-b")
    await Sync.pull(b, NAME, ctxB)
    expect((await readRemote(b, NAME))!.lessons.map((l) => l.text)).toEqual([text])
    server.approve(edit.public_id)

    // 6. Retirement removes it from new sessions and from the cached section of a running one.
    await Sync.pull(b, NAME, ctxB)
    expect(await running.reconcile("ses_b1")).toBe(true)
    expect(await running.section("ses_b1")).not.toContain(text)
    server.retire(edit.public_id)
    await Sync.pull(b, NAME, ctxB)
    const fresh = new Delivery(b, limits, b, { scope: () => ctxB.scope })
    expect((await fresh.prepare("ses_b2", "m1", "amount cents")).section).not.toContain("amount_cents")

    // 7. A fresh clone with an old approved.json does not resurrect the retired lesson.
    const clone = await project()
    await approve(clone, [lesson(proposal.lesson_key, edited)])
    await Sync.pull(clone, NAME, ctxB)
    const cloneSession = new Delivery(clone, limits, clone, { scope: () => ctxB.scope })
    expect((await cloneSession.prepare("ses_c1", "m1", "amount cents")).section).toBe("")

    // 8. Offline retries create no duplicates and no double counts.
    const counted = server.add({ lesson_key: "L-0e01", text: "Keep incremental models idempotent on reruns." }, REMOTE)
    await Sync.pull(b, NAME, ctxB)
    const session = new Delivery(b, limits, b, { scope: () => ctxB.scope })
    expect((await session.prepare("ses_b3", "m1", "incremental models")).section).toContain(counted.text)
    await session.flush("ses_b3")
    const saved = await fs.readFile(files(b, NAME).outbox, "utf8")
    server.failNext = 1
    expect((await Sync.push(b, NAME, ctxB)).error).toBeDefined()
    expect((await Sync.push(b, NAME, ctxB)).usage).toBe(1)
    // A second flush of the same session counts nothing new; a replayed batch is counted once.
    await session.flush("ses_b3")
    await Store.transaction(b, async () => fs.writeFile(files(b, NAME).outbox, saved))
    await Sync.push(b, NAME, ctxB)
    expect(server.rows.find((r) => r.public_id === counted.public_id)!.applied).toBe(1)
    expect(server.usageReceipts.size).toBe(1)
  })
})
