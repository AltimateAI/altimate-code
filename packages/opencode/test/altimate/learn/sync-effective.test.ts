// altimate_change - new file
//
// Lesson sync, pure parts: the gate, the effective set by qualified identity, ledger-driven proposal
// choice, the reflection partition, first-sync backfill, and the server's submission hash.
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { syncEnabled } from "../../../src/altimate/learn/config"
import { curatorView, effectiveLessons, resolve, withRemote } from "../../../src/altimate/learn/effective"
import { identityKey, textHash, type Remote, type SyncState } from "../../../src/altimate/learn/ledger"
import { backfillIntents, lessonIntent, partition, promoteIntents, submissionHash, toItem, unsyncableReason, type Intent } from "../../../src/altimate/learn/proposals"
import { lint, normalizeText } from "../../../src/altimate/learn/curator"
import type { Lesson } from "../../../src/altimate/learn/lesson"
import type { LessonOut } from "../../../src/altimate/workspace/lesson-api"
import { materialHash } from "./sync-fixture"

const STORE = "team-playbook"
const REPO = "https://github.com/acme/analytics"
const lesson = (id: string, text: string, extra: Partial<Lesson> = {}): Lesson => ({
  id, text, tags: [], scope: "project", helpful: 0, harmful: 0, applied: 0,
  created: "2026-10-01T00:00:00.000Z", updated: "2026-10-01T00:00:00.000Z", ...extra,
})
const out = (key: string, text: string, extra: Partial<LessonOut> = {}): LessonOut => ({
  public_id: `pub-${key}`, lesson_key: key, repo_identity: REPO, store: STORE, text, tags: [], trigger_paths: [],
  pinned: false, coexists: [], helpful: 0, harmful: 0, applied: 0, version: 1, updated_at: "2026-10-02T00:00:00.000Z", ...extra,
})
const scope = { apiUrl: "http://x", tenant: "acme", account: "a".repeat(64), datamateId: 7, repoRemote: "git@github.com:acme/analytics.git" }
const remote = (lessons: LessonOut[], tombstones: Remote["tombstones"] = []): Remote => ({
  version: 1, scope, revision: 3, pulled_at: "2026-10-02T00:00:00.000Z", repo_identity: REPO, share: false,
  pending_count: 0, lessons, tombstones,
})
const emptyState = (): SyncState => ({ version: 1, backfill: { complete: false, done: [] }, ledger: {}, unsyncable: {} })
const id = (key: string, repo: string | null = REPO) => ({ repo_identity: repo, store: STORE, lesson_key: key })

describe("sync gate", () => {
  const on = { sync: true }
  test("off by default, opt-in through config, env overrides both ways", () => {
    expect(syncEnabled(undefined, {})).toBe(false)
    expect(syncEnabled(on, {})).toBe(true)
    expect(syncEnabled(on, { ALTIMATE_LEARN_SYNC: "0" })).toBe(false)
    expect(syncEnabled({}, { ALTIMATE_LEARN_SYNC: "TRUE" })).toBe(true)
  })
  test("the learning and workspace kill switches win", () => {
    expect(syncEnabled({ ...on, enabled: false }, {})).toBe(false)
    expect(syncEnabled(on, { ALTIMATE_LEARN: "0" })).toBe(false)
    expect(syncEnabled(on, { ALTIMATE_DISABLE_WORKSPACE: "1" })).toBe(false)
    expect(syncEnabled(on, { ALTIMATE_DISABLE_WORKSPACE: "yes" })).toBe(false)
    expect(syncEnabled(on, { ALTIMATE_DISABLE_WORKSPACE: "0" })).toBe(true)
  })
  test("independent of capture", () => {
    expect(syncEnabled({ sync: true, capture: false }, {})).toBe(true)
  })
})

describe("effective set", () => {
  test("without a pull it is exactly the local set", () => {
    const local = [lesson("L-0001", "Local rule one.")]
    expect(effectiveLessons(STORE, local, undefined)).toEqual([{ lesson: local[0], source: "local" }])
  })

  test("remote wins for the same identity; an exact-identity tombstone hides the local copy", () => {
    const local = [lesson("L-0001", "Old local text."), lesson("L-0002", "Retired upstream."), lesson("L-0003", "Only local.")]
    const entries = effectiveLessons(STORE, local, remote([out("L-0001", "Team text.")], [id("L-0002")]))
    expect(entries.map((e) => [e.lesson.id, e.lesson.text, e.source])).toEqual([
      ["L-0003", "Only local.", "local"],
      ["L-0001", "Team text.", "remote"],
    ])
    expect(entries[0].identity).toEqual(id("L-0003"))
  })

  test("a tombstone for another identity does not hide the local lesson", () => {
    const local = [lesson("L-0002", "Mine.")]
    expect(resolve(STORE, ["L-0002"], remote([], [id("L-0002", null)])).hidden.size).toBe(0)
    expect(effectiveLessons(STORE, local, remote([], [id("L-0002", "https://github.com/acme/other")])).map((e) => e.source)).toEqual(["local"])
  })

  test("another repository's lesson with a taken key gets a stable alias; coexists keys are filtered", () => {
    const local = [lesson("L-0001", "Local one.")]
    const shared = out("L-0001", "Other repo rule.", { repo_identity: "https://github.com/acme/other", public_id: "p-other", coexists: ["L-0009", "L-0005"] })
    const team = out("L-0005", "Workspace-wide rule.", { repo_identity: null })
    const first = effectiveLessons(STORE, local, remote([shared, team]))
    const again = effectiveLessons(STORE, local, remote([team, shared]))
    const alias = first.find((e) => e.remote?.public_id === "p-other")!.lesson
    expect(alias.id).not.toBe("L-0001")
    expect(alias.id).toMatch(/^L-[0-9a-f]{16}$/)
    expect(again.find((e) => e.remote?.public_id === "p-other")!.lesson.id).toBe(alias.id)
    // L-0009 is not live here; L-0005 is.
    expect(alias.coexists).toEqual(["L-0005"])
  })

  test("the curator view lists remote lessons with a reverse map, and hides shadowed local bullets", () => {
    const view = curatorView(STORE, ["L-0001", "L-0003"], remote([out("L-0001", "Team text."), out("L-0004", "Team four.")]))!
    expect([...view.hidden]).toEqual(["L-0001"])
    expect(withRemote([{ id: "L-0001", text: "x", helpful: 0, harmful: 0 }, { id: "L-0003", text: "y", helpful: 0, harmful: 0 }], view).map((b) => b.id))
      .toEqual(["L-0003", "L-0001", "L-0004"])
    expect(view.byId.get("L-0004")!.remote.public_id).toBe("pub-L-0004")
  })
})

describe("ledger-driven proposals", () => {
  const upsert = (key: string, text: string, extra: Partial<Intent> = {}): Intent => ({
    ...lessonIntent(STORE, { repo_identity: REPO }, lesson(key, text), "manual", () => undefined), ...extra,
  })

  test("no server record: add", () => {
    const item = toItem(upsert("L-0001", "New rule."), remote([]), emptyState())!
    expect(item).toMatchObject({ change_type: "add", replaces: [], revises_public_id: null, revises_version: null })
  })

  test("own open proposal: a revision of it", () => {
    const state = emptyState()
    state.ledger[identityKey(id("L-0001"))] = { pending: { public_id: "mine", version: 2, submission_hash: "h" }, receipts: [] }
    expect(toItem(upsert("L-0001", "Better rule."), remote([]), state)).toMatchObject({ change_type: "add", revises_public_id: "mine", revises_version: 2 })
  })

  test("approved on the server: edit with replaces at the known version", () => {
    const item = toItem(upsert("L-0001", "Edited."), remote([out("L-0001", "Original.", { version: 4 })]), emptyState())!
    expect(item).toMatchObject({ change_type: "edit", replaces: [{ public_id: "pub-L-0001", version: 4 }] })
  })

  test("a local edit of a lesson the server never saw is an add; removing it is nothing", () => {
    expect(toItem(upsert("L-0007", "Edited unknown."), remote([]), emptyState())!.change_type).toBe("add")
    expect(toItem({ ...upsert("L-0007", "x"), kind: "remove" }, remote([]), emptyState())).toBeUndefined()
  })

  test("removal of an approved lesson names it; counter-only edits are not proposals", () => {
    const r = remote([out("L-0001", "Same text.", { version: 2 })])
    expect(toItem({ ...upsert("L-0001", "Same text."), kind: "remove" }, r, emptyState())).toMatchObject({ change_type: "remove", replaces: [{ public_id: "pub-L-0001", version: 2 }] })
    expect(toItem(upsert("L-0001", "Same text."), r, emptyState())).toBeUndefined()
  })

  test("ADD supersedes two team lessons: one edit with the new key and both targets", () => {
    const r = remote([out("L-00a1", "Use cents.", { version: 2 }), out("L-00a2", "Use dollars.", { version: 5 })])
    const view = curatorView(STORE, [], r)!
    const result = partition({
      view, local: [], lessons: new Map(), origin: "auto_reflect",
      curated: {
        next: [{ id: "L-00b1", text: "Store amounts in dollars with a _usd suffix.", helpful: 0, harmful: 0 }],
        applied: [
          { op: "REMOVE", id: "L-00a1", reason: "superseded by L-00b1", note: "superseded" },
          { op: "REMOVE", id: "L-00a2", reason: "superseded by L-00b1", note: "superseded" },
          { op: "ADD", id: "L-00b1", text: "Store amounts in dollars with a _usd suffix.", supersedes: "L-00a1", reason: "r" },
        ],
      },
    })
    expect(result.next).toEqual([])
    expect(result.applied).toEqual([])
    expect(result.intents).toHaveLength(1)
    const item = toItem(result.intents[0], r, emptyState())!
    expect(item).toMatchObject({ lesson_key: "L-00b1", change_type: "edit" })
    expect(item.replaces).toEqual([{ public_id: "pub-L-00a1", version: 2 }, { public_id: "pub-L-00a2", version: 5 }])
  })

  test("reflection partition: team lessons never reach the local snapshot; local changes are staged and proposed", () => {
    const r = remote([out("L-0d01", "Team rule about staging.", { version: 3 }), out("L-0001", "Team copy of local one.")])
    const local = [{ id: "L-0001", text: "Shadowed local one.", helpful: 0, harmful: 0 }, { id: "L-0002", text: "Local two.", helpful: 1, harmful: 0 }]
    const view = curatorView(STORE, local.map((b) => b.id), r)!
    const curated = {
      next: [
        { id: "L-0002", text: "Local two, edited.", helpful: 1, harmful: 0, coexists: ["L-0d01"] },
        { id: "L-0d01", text: "Team rule about staging, edited.", helpful: 1, harmful: 0 },
        { id: "L-0001", text: "Team copy of local one.", helpful: 0, harmful: 0 },
        { id: "L-0003", text: "Brand new local rule.", helpful: 0, harmful: 0 },
      ],
      applied: [
        { op: "EDIT" as const, id: "L-0002", text: "Local two, edited.", coexists: ["L-0d01"], reason: "r" },
        { op: "EDIT" as const, id: "L-0d01", text: "Team rule about staging, edited.", reason: "r" },
        { op: "HELPFUL" as const, id: "L-0d01", reason: "r" },
        { op: "ADD" as const, id: "L-0003", text: "Brand new local rule.", reason: "r" },
      ],
    }
    const result = partition({ view, local, lessons: new Map(), curated, origin: "auto_reflect" })
    // Remote ids are gone, the remote coexists reference is stripped, the shadowed local lesson is kept unchanged.
    expect(result.next).toEqual([
      { id: "L-0001", text: "Shadowed local one.", helpful: 0, harmful: 0 },
      { id: "L-0002", text: "Local two, edited.", helpful: 1, harmful: 0 },
      { id: "L-0003", text: "Brand new local rule.", helpful: 0, harmful: 0 },
    ])
    expect(result.applied.map((a) => a.id)).toEqual(["L-0002", "L-0003"])
    expect(result.usage).toEqual([{ public_id: "pub-L-0d01", applied: 0, helpful: 1, harmful: 0 }])
    const items = result.intents.map((intent) => toItem(intent, r, emptyState())!)
    expect(items.map((i) => [i.lesson_key, i.change_type])).toEqual([["L-0002", "add"], ["L-0d01", "edit"], ["L-0003", "add"]])
    // The relationship is kept in the proposal: hashes of both texts at declaration time.
    expect(items[0].coexists).toEqual([{ lesson_key: "L-0d01", source_text_hash: textHash("Local two, edited."), target_text_hash: textHash("Team rule about staging, edited.") }])
    expect(items[1].replaces).toEqual([{ public_id: "pub-L-0d01", version: 3 }])
  })

  test("promote: no removals are inferred from team lessons missing locally", () => {
    const before = [lesson("L-0001", "One.")]
    const after = [lesson("L-0001", "One."), lesson("L-0002", "Two.")]
    const intents = promoteIntents(STORE, { repo_identity: REPO }, before, after, "manual")
    expect(intents.map((i) => [i.kind, i.lesson_key])).toEqual([["upsert", "L-0002"]])
  })

  test("promote: a superseded lesson becomes a target of its replacement, not a separate removal", () => {
    const before = [lesson("L-0001", "Old.")]
    const after = [lesson("L-0002", "New.")]
    const intents = promoteIntents(STORE, { repo_identity: REPO }, before, after, "manual", new Map([["L-0001", "L-0002"]]))
    expect(intents).toHaveLength(1)
    expect(intents[0].supersedes).toEqual([id("L-0001")])
    const item = toItem(intents[0], remote([out("L-0001", "Old.", { version: 2 })]), emptyState())!
    expect(item).toMatchObject({ lesson_key: "L-0002", change_type: "edit", replaces: [{ public_id: "pub-L-0001", version: 2 }] })
  })

  test("submission hash and text hash match the backend's pinned vector", () => {
    const item = {
      change_type: "edit" as const, text: "Préfér CTEs — not subqueries", tags: ["sql"], trigger_paths: ["models/**/*.sql"],
      coexists: [{ lesson_key: "L-bbbb", source_text_hash: "a".repeat(64), target_text_hash: "b".repeat(64) }], pinned: true,
      replaces: [{ public_id: "11111111-2222-3333-4444-555555555555", version: 3 }],
    }
    expect(submissionHash(item)).toBe("f263303253a769a66cb3a5f6b9150a9af457d6f5279b3acaee332c7ef1fd5d5f")
    expect(textHash("Préfér CTEs — not subqueries")).toBe("c33338e9e6377121deac3e96565411342a276a37043c15d8252d25edc9dad863")
  })

  test("items the server would refuse are recognised before sending", () => {
    expect(unsyncableReason({ text: "x".repeat(141), trigger_paths: [] })).toContain("too long")
    expect(unsyncableReason({ text: "Fine rule.", trigger_paths: ["models/\u200b**"] })).toContain("path trigger")
    expect(unsyncableReason({ text: "Fine rule.", trigger_paths: ["models/**"] })).toBeUndefined()
  })

  test("removal sends the approved lesson's current text", () => {
    const r = remote([out("L-0001", "Server text.", { version: 2 })])
    expect(toItem({ ...upsert("L-0001", "Stale local text."), kind: "remove" }, r, emptyState())).toMatchObject({ change_type: "remove", text: "Server text." })
  })

  test("submission hash matches the server's canonical JSON, including non-ASCII text", () => {
    const item = toItem(upsert("L-0001", "Préférez les colonnes explicites — toujours."), remote([]), emptyState())!
    expect(submissionHash(item)).toBe(materialHash(item))
    expect(lessonIntent(STORE, { repo_identity: REPO }, lesson("L-0001", "ｃｏｌｕｍｎ"), "manual", () => undefined).text).toBe("column")
  })
})

describe("first-sync backfill", () => {
  test("the candidate is the full staged set; a removal it staged is not uploaded", () => {
    // approved had L-0001 and L-0002; the candidate dropped L-0002 and added L-0003.
    const staged = [lesson("L-0001", "One.", { helpful: 1 }), lesson("L-0003", "Three.", { helpful: 5 })]
    const plan = backfillIntents(STORE, staged, remote([]), emptyState(), 200)
    expect(plan.intents.map((i) => [i.lesson_key, i.origin])).toEqual([["L-0003", "backfill"], ["L-0001", "backfill"]])
    expect(plan.complete).toBe(true)
  })

  test("capped per run, best first, resumable; known lessons are skipped", () => {
    const staged = [lesson("L-0001", "One.", { helpful: 1 }), lesson("L-0002", "Two.", { helpful: 3 }), lesson("L-0003", "Three.", { harmful: 2 }), lesson("L-0004", "Four.")]
    const state = emptyState()
    const r = remote([out("L-0004", "Four.")])
    const first = backfillIntents(STORE, staged, r, state, 2)
    expect(first.intents.map((i) => i.lesson_key)).toEqual(["L-0002", "L-0001"])
    expect(first.complete).toBe(false)
    state.backfill.done.push(...first.done)
    const second = backfillIntents(STORE, staged, r, state, 2)
    // L-0004 is already a team lesson.
    expect(second.intents.map((i) => i.lesson_key)).toEqual(["L-0003"])
    expect(second.complete).toBe(true)
  })
})

describe("shared lint fixture", () => {
  // The backend validates submissions with a port of this lint; both repositories run the same cases.
  const file = path.join(import.meta.dir, "fixtures", "lint_cases.json")
  const cases: { text: string; ok: boolean; reason?: string }[] = JSON.parse(fs.readFileSync(file, "utf8"))
  // The per-text check `Store.validateCandidate` applies before anything is promoted.
  const check = (text: string) => lint(text) ?? (normalizeText(text) !== text ? "contains hidden or non-normalized characters" : undefined)
  test("every case agrees with the client lint", () => {
    const disagreements = cases.filter((c) => (check(c.text) === undefined) !== c.ok || (!c.ok && c.reason !== undefined && check(c.text) !== c.reason))
      .map((c) => ({ ...c, client: check(c.text) }))
    expect(disagreements).toEqual([])
    expect(cases.length).toBeGreaterThan(10)
  })
})
