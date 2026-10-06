// altimate_change - new file
//
// Opt-in automatic promotion: config resolution, every gate, the success path and its undo,
// the rolling daily limit, the CLI opt-in, and the real automatic-reflection entry point.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { parse as parseJsonc } from "jsonc-parser"
import { tmpdir } from "../../fixture/fixture"
import { Instance } from "../../../src/project/instance"
import { Session } from "../../../src/session"
import * as Reflect from "../../../src/altimate/learn/reflect"
import * as Signals from "../../../src/altimate/learn/signals"
import * as Store from "../../../src/altimate/learn/store"
import * as Lessons from "../../../src/altimate/learn/lesson"
import * as Playbook from "../../../src/altimate/learn/playbook"
import { autoReflectSession, describeOutcome } from "../../../src/altimate/learn/auto"
import {
  autoPromote, autoPromotedIds, autoPromoteStateFile, readAutoPromoteState, type AutoPromoteInput,
} from "../../../src/altimate/learn/auto-promote"
import { autoPromoteEnabled, DEFAULT_AUTO_PROMOTE_LIMITS, resolveAutoPromoteLimits } from "../../../src/altimate/learn/config"

const NAME = Playbook.DEFAULT_NAME
const limits = { ...DEFAULT_AUTO_PROMOTE_LIMITS }
const A = { id: "L-000a", text: "Prefer explicit column lists in staging models." }
const B = { id: "L-000b", text: "Name surrogate keys after the grain they represent." }
const C = { id: "L-000c", text: "Document every new mart in its schema file." }
const D = { id: "L-000d", text: "Keep incremental models idempotent on reruns." }
const E = { id: "L-000e", text: "Use singular table names for dimension models." }
type Rule = { id: string; text: string }

async function stage(root: string, rules: Rule[]) {
  await Store.saveCandidate(root, NAME, Playbook.withBullets(Playbook.create({ name: NAME }),
    rules.map((rule) => ({ helpful: 0, harmful: 0, ...rule }))))
  return candidateHash(root)
}

async function candidateHash(root: string) {
  return Store.sha256(Lessons.canonical((await Store.loadCandidateLessons(root, NAME))!))
}

/** A person reviewed and approved these rules with `learn promote`. */
async function approve(root: string, rules: Rule[], allowFlagged = false) {
  await stage(root, rules)
  await Store.promote(root, NAME, { allowFlagged })
}

const approvedIds = async (root: string) => (await Store.loadApproved(root, NAME)).map((lesson) => lesson.id)
const input = (root: string, expectedCandidateHash: string, extra: Partial<AutoPromoteInput> = {}): AutoPromoteInput =>
  ({ root, name: NAME, expectedCandidateHash, signals: 1, session: "ses_test", limits, ...extra })
async function history(root: string) {
  return (await fs.readFile(Store.paths(root, NAME).history, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
}

describe("auto-promote settings", () => {
  const on = { capture: true, auto_reflect: true, auto_promote: true }

  test("off by default and opt-in through config", () => {
    expect(autoPromoteEnabled(undefined, {})).toBe(false)
    expect(autoPromoteEnabled({ capture: true, auto_reflect: true }, {})).toBe(false)
    expect(autoPromoteEnabled(on, {})).toBe(true)
  })

  test("needs capture and automatic reflection", () => {
    expect(autoPromoteEnabled({ ...on, capture: false }, {})).toBe(false)
    expect(autoPromoteEnabled({ ...on, auto_reflect: false }, {})).toBe(false)
    expect(autoPromoteEnabled(on, { ALTIMATE_LEARN_AUTO: "0" })).toBe(false)
    expect(autoPromoteEnabled(on, { ALTIMATE_LEARN_CAPTURE: "false" })).toBe(false)
  })

  test("the learning kill switch wins in both config and env", () => {
    expect(autoPromoteEnabled({ ...on, enabled: false }, {})).toBe(false)
    expect(autoPromoteEnabled(on, { ALTIMATE_LEARN: "0" })).toBe(false)
    expect(autoPromoteEnabled({ ...on, enabled: false }, { ALTIMATE_LEARN_AUTO_PROMOTE: "1" })).toBe(false)
  })

  test("ALTIMATE_LEARN_AUTO_PROMOTE overrides config in both directions", () => {
    expect(autoPromoteEnabled(on, { ALTIMATE_LEARN_AUTO_PROMOTE: "0" })).toBe(false)
    expect(autoPromoteEnabled(on, { ALTIMATE_LEARN_AUTO_PROMOTE: "FALSE" })).toBe(false)
    expect(autoPromoteEnabled({ ...on, auto_promote: false }, { ALTIMATE_LEARN_AUTO_PROMOTE: "1" })).toBe(true)
    expect(autoPromoteEnabled({ capture: true, auto_reflect: true }, { ALTIMATE_LEARN_AUTO_PROMOTE: "true" })).toBe(true)
    expect(autoPromoteEnabled(on, { ALTIMATE_LEARN_AUTO_PROMOTE: "maybe" })).toBe(true)
  })

  test("limits default, read config, and let env override", () => {
    expect(resolveAutoPromoteLimits(undefined, {})).toEqual({ auto_promote_max_changes: 3, auto_promote_daily: 5 })
    expect(resolveAutoPromoteLimits({ auto_promote_max_changes: 1, auto_promote_daily: 0 }, {}))
      .toEqual({ auto_promote_max_changes: 1, auto_promote_daily: 0 })
    expect(resolveAutoPromoteLimits({ auto_promote_daily: 2 }, { ALTIMATE_LEARN_AUTO_PROMOTE_DAILY: "7" }).auto_promote_daily).toBe(7)
    expect(() => resolveAutoPromoteLimits({}, { ALTIMATE_LEARN_AUTO_PROMOTE_MAX_CHANGES: "-1" })).toThrow("nonnegative")
    expect(() => resolveAutoPromoteLimits({ auto_promote_daily: 1.5 }, {})).toThrow("auto_promote_daily")
  })
})

describe("auto-promote success path", () => {
  test("archives, records history, marks the lesson, and `learn rollback` restores the previous set", async () => {
    await using dir = await tmpdir({ git: true })
    await approve(dir.path, [A])
    const hash = await stage(dir.path, [A, B])
    const result = await autoPromote(input(dir.path, hash, { signals: 2 }))
    expect(result).toEqual({ status: "promoted", archived: 1, lessons: [B.id], removed: [] })
    expect(await approvedIds(dir.path)).toEqual([A.id, B.id])
    expect(await Store.readCandidate(dir.path, NAME)).toBeUndefined()
    expect(Lessons.parse((await fs.readFile(path.join(Store.paths(dir.path, NAME).versions, "v1.json"), "utf8"))).map((l) => l.id)).toEqual([A.id])
    expect((await history(dir.path)).at(-1)).toMatchObject({ action: "auto-promote", version: 1, lessons: [B.id], signals: 2, session: "ses_test" })
    const state = await readAutoPromoteState(dir.path, NAME)
    expect(state.promotions).toHaveLength(1)
    expect(state.promotions[0]).toMatchObject({ archived: 1, lessons: [B.id], signals: 2 })
    expect([...autoPromotedIds(state, await Store.loadApproved(dir.path, NAME))]).toEqual([B.id])

    expect(await Store.rollback(dir.path, NAME)).toEqual({ restored: 1 })
    expect(await approvedIds(dir.path)).toEqual([A.id])
  })

  test("a first promotion archives an empty set so rollback can undo it", async () => {
    await using dir = await tmpdir({ git: true })
    const hash = await stage(dir.path, [B])
    expect(await autoPromote(input(dir.path, hash))).toMatchObject({ status: "promoted", archived: 1 })
    expect(await approvedIds(dir.path)).toEqual([B.id])
    await Store.rollback(dir.path, NAME)
    expect(await approvedIds(dir.path)).toEqual([])
  })

  test("a lesson that was itself auto-promoted can be edited or removed automatically", async () => {
    await using dir = await tmpdir({ git: true })
    await approve(dir.path, [A])
    expect(await autoPromote(input(dir.path, await stage(dir.path, [A, B])))).toMatchObject({ status: "promoted" })
    const edited = { id: B.id, text: "Name surrogate keys after their grain." }
    expect(await autoPromote(input(dir.path, await stage(dir.path, [A, edited])))).toMatchObject({ status: "promoted", lessons: [B.id] })
    const state = await readAutoPromoteState(dir.path, NAME)
    expect([...autoPromotedIds(state, await Store.loadApproved(dir.path, NAME))]).toEqual([B.id])
    expect(await autoPromote(input(dir.path, await stage(dir.path, [A])))).toMatchObject({ status: "promoted", lessons: [], removed: [B.id] })
    expect(await approvedIds(dir.path)).toEqual([A.id])
    // Removal-only promotions still say what they removed.
    expect((await readAutoPromoteState(dir.path, NAME)).promotions.at(-1)).toMatchObject({ lessons: [], removed: [B.id] })
    expect((await history(dir.path)).at(-1)).toMatchObject({ action: "auto-promote", lessons: [], removed: [B.id] })
  })

  test("a successful promotion clears the last held-back reason", async () => {
    await using dir = await tmpdir({ git: true })
    await autoPromote(input(dir.path, await stage(dir.path, [B]), { signals: 0 }))
    expect((await readAutoPromoteState(dir.path, NAME)).lastHeldBack).toBeDefined()
    expect(await autoPromote(input(dir.path, await stage(dir.path, [B])))).toMatchObject({ status: "promoted" })
    expect((await readAutoPromoteState(dir.path, NAME)).lastHeldBack).toBeUndefined()
  })

  test("a pinned lesson is a person's decision: pinning or unpinning an auto lesson protects it", async () => {
    await using dir = await tmpdir({ git: true })
    await approve(dir.path, [A])
    await autoPromote(input(dir.path, await stage(dir.path, [A, B])))
    await Store.setPinned(dir.path, NAME, B.id, true)
    let state = await readAutoPromoteState(dir.path, NAME)
    expect(state.auto[B.id]).toBeUndefined()
    expect([...autoPromotedIds(state, await Store.loadApproved(dir.path, NAME))]).toEqual([])
    expect(await autoPromote(input(dir.path, await stage(dir.path, [A])))).toMatchObject({ status: "held", reason: expect.stringContaining(`person-approved lesson ${B.id}`) })
    await Store.reject(dir.path, NAME)
    await Store.setPinned(dir.path, NAME, B.id, false)
    state = await readAutoPromoteState(dir.path, NAME)
    expect([...autoPromotedIds(state, await Store.loadApproved(dir.path, NAME))]).toEqual([])
    expect(await autoPromote(input(dir.path, await stage(dir.path, [A])))).toMatchObject({ status: "held", reason: expect.stringContaining(`person-approved lesson ${B.id}`) })
    expect(await approvedIds(dir.path)).toEqual([A.id, B.id])
  })

  test("a pinned lesson with a stale auto mark (from before pin cleared marks) still counts as person-approved", () => {
    const state = { promotions: [], auto: { [B.id]: Store.sha256(B.text) } }
    const lesson = (pinned?: boolean): Lessons.Lesson => ({ ...B, tags: [], scope: "project", helpful: 0, harmful: 0, applied: 0,
      created: "2026-10-01T00:00:00.000Z", updated: "2026-10-01T00:00:00.000Z", ...(pinned === undefined ? {} : { pinned }) })
    expect([...autoPromotedIds(state, [lesson()])]).toEqual([B.id])
    expect([...autoPromotedIds(state, [lesson(true)])]).toEqual([])
  })

  test("counter updates on person-approved lessons stay staged instead of going live", async () => {
    await using dir = await tmpdir({ git: true })
    await approve(dir.path, [A])
    const hash = await stage(dir.path, [{ ...A, harmful: 9 } as Rule, B])
    expect(await autoPromote(input(dir.path, hash))).toMatchObject({ status: "promoted", lessons: [B.id] })
    const approved = await Store.loadApproved(dir.path, NAME)
    expect(approved.map((l) => [l.id, l.harmful])).toEqual([[A.id, 0], [B.id, 0]])
    // The counter update is carried forward in the candidate for review.
    const staged = await Store.loadCandidateLessons(dir.path, NAME)
    expect(staged?.map((l) => [l.id, l.harmful])).toEqual([[A.id, 9], [B.id, 0]])
    // A later reflection on top of the counter-only candidate can still auto-promote its own change.
    const previousCandidate = staged
    const next = await stage(dir.path, [{ ...A, harmful: 9 } as Rule, B, C])
    expect(await autoPromote(input(dir.path, next, { previousCandidate }))).toMatchObject({ status: "promoted", lessons: [C.id] })
    expect((await Store.loadApproved(dir.path, NAME)).map((l) => [l.id, l.harmful])).toEqual([[A.id, 0], [B.id, 0], [C.id, 0]])
  })

  test("counter updates on auto-promoted lessons go live with them", async () => {
    await using dir = await tmpdir({ git: true })
    await approve(dir.path, [A])
    await autoPromote(input(dir.path, await stage(dir.path, [A, B])))
    await autoPromote(input(dir.path, await stage(dir.path, [A, { ...B, helpful: 2 } as Rule, C])))
    expect((await Store.loadApproved(dir.path, NAME)).find((l) => l.id === B.id)?.helpful).toBe(2)
    expect(await Store.readCandidate(dir.path, NAME)).toBeUndefined()
  })

  test("a lesson a person re-approved with new text is no longer treated as automatic", async () => {
    await using dir = await tmpdir({ git: true })
    await approve(dir.path, [A])
    await autoPromote(input(dir.path, await stage(dir.path, [A, B])))
    await approve(dir.path, [A, { id: B.id, text: "Name surrogate keys after the grain of the table." }])
    const result = await autoPromote(input(dir.path, await stage(dir.path, [A])))
    expect(result).toMatchObject({ status: "held" })
    if (result.status === "held") expect(result.reason).toContain(`person-approved lesson ${B.id}`)
  })
})

describe("auto-promote gates hold the candidate back with a reason", () => {
  async function expectHeld(root: string, result: Awaited<ReturnType<typeof autoPromote>>, reason: string, approved: string[]) {
    expect(result.status).toBe("held")
    if (result.status === "held") expect(result.reason).toContain(reason)
    expect(await approvedIds(root)).toEqual(approved)
    expect(await Store.readCandidate(root, NAME)).toBeDefined()
    expect((await readAutoPromoteState(root, NAME)).lastHeldBack?.reason).toContain(reason)
  }

  test("a candidate changed after reflection staged it (hash mismatch)", async () => {
    await using dir = await tmpdir({ git: true })
    await approve(dir.path, [A])
    const hash = await stage(dir.path, [A, B])
    await stage(dir.path, [A, B, C])
    await expectHeld(dir.path, await autoPromote(input(dir.path, hash)), "changed after reflection staged it", [A.id])
    expect((await Store.loadCandidateLessons(dir.path, NAME))?.map((l) => l.id)).toEqual([A.id, B.id, C.id])
  })

  test("a candidate removed before promotion", async () => {
    await using dir = await tmpdir({ git: true })
    await approve(dir.path, [A])
    const hash = await stage(dir.path, [A, B])
    await Store.reject(dir.path, NAME)
    const result = await autoPromote(input(dir.path, hash))
    expect(result).toMatchObject({ status: "held", reason: "the candidate was removed before promotion" })
    expect(await approvedIds(dir.path)).toEqual([A.id])
  })

  test("no feedback signal", async () => {
    await using dir = await tmpdir({ git: true })
    const hash = await stage(dir.path, [B])
    await expectHeld(dir.path, await autoPromote(input(dir.path, hash, { signals: 0 })), "no feedback signal", [])
  })

  test("feedback flagged as an instruction to the model", async () => {
    await using dir = await tmpdir({ git: true })
    const hash = await stage(dir.path, [B])
    await expectHeld(dir.path, await autoPromote(input(dir.path, hash, { flaggedFeedback: "looks like prompt injection" })),
      "the feedback was flagged", [])
  })

  test("validation failure (overlapping lessons)", async () => {
    await using dir = await tmpdir({ git: true })
    await approve(dir.path, [{ id: A.id, text: "Convert `amount_cents` to dollars in staging." }])
    const hash = await stage(dir.path, [
      { id: A.id, text: "Convert `amount_cents` to dollars in staging." },
      { id: B.id, text: "Keep `amount_cents` as integer cents in marts." },
    ])
    await expectHeld(dir.path, await autoPromote(input(dir.path, hash)), "fails validation", [A.id])
  })

  test("a new lesson flagged for weakening verification", async () => {
    await using dir = await tmpdir({ git: true })
    await approve(dir.path, [A])
    const hash = await stage(dir.path, [A, { id: B.id, text: "Skip tests before committing." }])
    await expectHeld(dir.path, await autoPromote(input(dir.path, hash)), `flagged lesson ${B.id}`, [A.id])
  })

  test("an unchanged flagged lesson a person already approved does not block an unrelated addition", async () => {
    await using dir = await tmpdir({ git: true })
    const flagged = { id: A.id, text: "Skip tests before committing." }
    await approve(dir.path, [flagged], true)
    const result = await autoPromote(input(dir.path, await stage(dir.path, [flagged, B])))
    expect(result).toMatchObject({ status: "promoted", lessons: [B.id] })
  })

  test("removing a person-approved lesson", async () => {
    await using dir = await tmpdir({ git: true })
    await approve(dir.path, [A, B])
    const hash = await stage(dir.path, [A])
    await expectHeld(dir.path, await autoPromote(input(dir.path, hash)), `person-approved lesson ${B.id}`, [A.id, B.id])
  })

  test("editing a person-approved lesson", async () => {
    await using dir = await tmpdir({ git: true })
    await approve(dir.path, [A])
    const hash = await stage(dir.path, [{ id: A.id, text: "Prefer explicit column lists in every model." }])
    await expectHeld(dir.path, await autoPromote(input(dir.path, hash)), `person-approved lesson ${A.id}`, [A.id])
  })

  test("more lesson changes than learn.auto_promote_max_changes", async () => {
    await using dir = await tmpdir({ git: true })
    await approve(dir.path, [A])
    const hash = await stage(dir.path, [A, B, C, D, E])
    await expectHeld(dir.path, await autoPromote(input(dir.path, hash)), "4 lesson changes exceed learn.auto_promote_max_changes (3)", [A.id])
    const zero = await autoPromote(input(dir.path, hash, { limits: { ...limits, auto_promote_max_changes: 0 } }))
    expect(zero).toMatchObject({ status: "held" })
  })

  test("counter-only changes", async () => {
    await using dir = await tmpdir({ git: true })
    await approve(dir.path, [A])
    await Store.saveCandidate(dir.path, NAME, Playbook.withBullets(Playbook.create({ name: NAME }), [{ ...A, helpful: 3, harmful: 0 }]))
    await expectHeld(dir.path, await autoPromote(input(dir.path, await candidateHash(dir.path))), "counter updates only", [A.id])
  })

  test("a malformed state file fails closed", async () => {
    await using dir = await tmpdir({ git: true })
    const hash = await stage(dir.path, [B])
    await fs.writeFile(autoPromoteStateFile(dir.path, NAME), "{\"promotions\": \"nope\"")
    const result = await autoPromote(input(dir.path, hash))
    expect(result).toMatchObject({ status: "held" })
    if (result.status === "held") expect(result.reason).toContain("unreadable")
    expect(await Store.readPromoted(dir.path, NAME)).toBeUndefined()
    await fs.writeFile(autoPromoteStateFile(dir.path, NAME), JSON.stringify({ promotions: [{ at: "never", lessons: [], signals: 1 }], auto: {} }))
    expect(await autoPromote(input(dir.path, hash))).toMatchObject({ status: "held" })
    expect(await Store.readPromoted(dir.path, NAME)).toBeUndefined()
  })

  test("earlier unreviewed changes in the candidate (manual reflect, bootstrap, a previous hold)", async () => {
    await using dir = await tmpdir({ git: true })
    await approve(dir.path, [A])
    await stage(dir.path, [A, B])
    const previousCandidate = await Store.loadCandidateLessons(dir.path, NAME)
    const hash = await stage(dir.path, [A, B, C])
    await expectHeld(dir.path, await autoPromote(input(dir.path, hash, { previousCandidate })), "already had lesson changes waiting for review", [A.id])
    // Counter-only differences in the earlier candidate do not block this reflection's own change.
    await Store.saveCandidate(dir.path, NAME, Playbook.withBullets(Playbook.create({ name: NAME }), [{ ...A, helpful: 2, harmful: 0 }]))
    const counters = await Store.loadCandidateLessons(dir.path, NAME)
    const next = await stage(dir.path, [{ ...A }, B])
    expect(await autoPromote(input(dir.path, next, { previousCandidate: counters }))).toMatchObject({ status: "promoted", lessons: [B.id] })
  })

  test("a held-back candidate stays held when a later reflection adds a safe change", async () => {
    await using dir = await tmpdir({ git: true })
    await approve(dir.path, [A, B])
    // Held: it removes the person-approved B.
    expect(await autoPromote(input(dir.path, await stage(dir.path, [A])))).toMatchObject({ status: "held" })
    // The next reflection stages a safe addition on top of the held candidate.
    const previousCandidate = await Store.loadCandidateLessons(dir.path, NAME)
    const result = await autoPromote(input(dir.path, await stage(dir.path, [A, C]), { previousCandidate }))
    expect(result).toMatchObject({ status: "held", reason: "the candidate already had lesson changes waiting for review" })
    expect(await approvedIds(dir.path)).toEqual([A.id, B.id])
  })

  test("a failure inside promote (not a refusal) leaves no auto mark, restores the candidate and the empty baseline", async () => {
    await using dir = await tmpdir({ git: true })
    const hash = await stage(dir.path, [B])
    const promote = spyOn(Store, "promote").mockImplementationOnce(async () => { throw new Error("EIO: lease lost") })
    let result
    try {
      result = await autoPromote(input(dir.path, hash))
    } finally {
      promote.mockRestore()
    }
    expect(result).toMatchObject({ status: "held", reason: expect.stringContaining("automatic promotion failed (EIO: lease lost)") })
    expect(await Store.readPromoted(dir.path, NAME)).toBeUndefined()
    expect(await candidateHash(dir.path)).toBe(hash)
    const state = await readAutoPromoteState(dir.path, NAME)
    expect(state.auto).toEqual({})
    // The rate-limit entry may overcount, never undercount.
    expect(state.promotions).toHaveLength(1)
    // A person then reviews and promotes the same text: it is theirs, so it is never removed automatically.
    await Store.promote(dir.path, NAME)
    expect([...autoPromotedIds(await readAutoPromoteState(dir.path, NAME), await Store.loadApproved(dir.path, NAME))]).toEqual([])
    expect(await autoPromote(input(dir.path, await stage(dir.path, [])))).toMatchObject({ status: "held", reason: expect.stringContaining(`person-approved lesson ${B.id}`) })
    expect(await approvedIds(dir.path)).toEqual([B.id])
  })

  test("a promote refusal rolls the state back and restores the rewritten candidate", async () => {
    await using dir = await tmpdir({ git: true })
    await approve(dir.path, [A])
    const hash = await stage(dir.path, [{ ...A, harmful: 4 } as Rule, B])
    const promote = spyOn(Store, "promote").mockImplementationOnce(async () => { throw new Store.StoreError("Refusing to promote: simulated") })
    let result
    try {
      result = await autoPromote(input(dir.path, hash))
    } finally {
      promote.mockRestore()
    }
    expect(result).toEqual({ status: "held", reason: "promote refused: simulated" })
    const state = await readAutoPromoteState(dir.path, NAME)
    expect(state.promotions).toEqual([])
    expect(state.auto).toEqual({})
    expect(state.lastHeldBack?.reason).toBe("promote refused: simulated")
    expect(await candidateHash(dir.path)).toBe(hash)
    expect(await approvedIds(dir.path)).toEqual([A.id])
  })
})

describe("auto-promote daily limit", () => {
  test("caps promotions in a rolling 24 hours and reopens after the window", async () => {
    await using dir = await tmpdir({ git: true })
    const daily = { ...limits, auto_promote_daily: 2 }
    const start = Date.parse("2026-10-01T12:00:00Z")
    const rules = [A, B, C, D]
    for (const [i, now] of [start, start + 3_600_000].entries())
      expect(await autoPromote(input(dir.path, await stage(dir.path, rules.slice(0, i + 1)), { limits: daily, now }))).toMatchObject({ status: "promoted" })
    const hash = await stage(dir.path, rules.slice(0, 3))
    const blocked = await autoPromote(input(dir.path, hash, { limits: daily, now: start + 86_400_000 - 1 }))
    expect(blocked).toMatchObject({ status: "held" })
    if (blocked.status === "held") expect(blocked.reason).toContain("daily limit reached (2 automatic promotions in 24 hours")
    // The first promotion leaves the window; the second still counts.
    expect(await autoPromote(input(dir.path, hash, { limits: daily, now: start + 86_400_000 + 1 }))).toMatchObject({ status: "promoted" })
    const next = await stage(dir.path, rules)
    expect(await autoPromote(input(dir.path, next, { limits: daily, now: start + 86_400_000 + 2 }))).toMatchObject({ status: "held" })
    expect(await approvedIds(dir.path)).toEqual([A.id, B.id, C.id])
  })

  test("a limit of zero never promotes", async () => {
    await using dir = await tmpdir({ git: true })
    const result = await autoPromote(input(dir.path, await stage(dir.path, [B]), { limits: { ...limits, auto_promote_daily: 0 } }))
    expect(result).toMatchObject({ status: "held" })
  })
})

describe("auto-promote outcome line", () => {
  test("promoted, held, and manual-only lines", () => {
    expect(describeOutcome("+1 added", 1, ".altimate-code/learn/team-playbook/candidate.json", { status: "promoted", archived: 3, lessons: [B.id], removed: [] }))
      .toBe("learn: 1 signal -> +1 added; auto-promoted (previous lessons archived as v3). Undo with `altimate-code learn rollback`")
    expect(describeOutcome("+1 added", 2, ".altimate-code/learn/team-playbook/candidate.json", { status: "held", reason: "daily limit reached" }))
      .toBe("learn: 2 signals -> +1 added; staged .altimate-code/learn/team-playbook/candidate.json for review (not auto-promoted: daily limit reached), review with `altimate-code learn show`")
    expect(describeOutcome("+1 added", 1, ".altimate-code/learn/team-playbook/candidate.json"))
      .toBe("learn: 1 signal -> +1 added; staged .altimate-code/learn/team-playbook/candidate.json, review with `altimate-code learn show`")
  })
})

describe("automatic reflection entry point", () => {
  const keys = ["ALTIMATE_LEARN", "ALTIMATE_LEARN_CAPTURE", "ALTIMATE_LEARN_AUTO", "ALTIMATE_LEARN_AUTO_PROMOTE", "ALTIMATE_LEARN_MODEL"]
  let original: Record<string, string | undefined>
  beforeEach(() => {
    original = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    for (const key of keys) delete process.env[key]
  })
  afterEach(async () => {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
    await Instance.disposeAll()
  })

  async function reflectOnce(config: object, env: Record<string, string> = {}, before?: (root: string) => Promise<unknown>) {
    await using dir = await tmpdir({ git: true, config: { learn: { capture: true, auto_reflect: true, model: "test/model", ...config } } })
    await before?.(dir.path)
    Object.assign(process.env, env)
    const model = spyOn(Reflect, "providerGenerate").mockImplementation(() => Effect.succeed(async () => ({
      deltas: [{ op: "ADD", text: "List result columns explicitly.", reason: "user correction" }],
    })))
    try {
      return await Instance.provide({ directory: dir.path, fn: async () => {
        const session = await Session.create({})
        await Signals.appendSignal(dir.path, {
          kind: "user_correction", sessionID: session.id, text: "No, list result columns explicitly.", reason: "correction",
        })
        const outcome = await autoReflectSession(session.id)
        return {
          outcome,
          approved: (await Store.loadApproved(dir.path, NAME)).map((lesson) => lesson.text),
          candidate: await Store.loadCandidateLessons(dir.path, NAME),
          history: (await history(dir.path)).map((entry) => entry.action),
          signals: await Signals.listSignals(dir.path),
        }
      } })
    } finally {
      model.mockRestore()
      await Instance.disposeAll()
    }
  }

  test("with auto_promote on, the reflected lesson goes live without a manual step", async () => {
    const result = await reflectOnce({ auto_promote: true })
    expect(result.outcome).toMatchObject({ ok: true, signals: 1, promotion: { status: "promoted", archived: 1 } })
    expect(result.outcome?.line).toBe(
      "learn: 1 signal -> +1 added; auto-promoted (previous lessons archived as v1). Undo with `altimate-code learn rollback`")
    expect(result.approved).toEqual(["List result columns explicitly."])
    expect(result.candidate).toBeUndefined()
    expect(result.history).toEqual(["reflect", "auto-promote"])
    expect(result.signals).toEqual([])
  })

  test("by default the candidate is only staged", async () => {
    const result = await reflectOnce({})
    expect(result.outcome?.promotion).toBeUndefined()
    expect(result.outcome?.line).toContain("staged")
    expect(result.approved).toEqual([])
    expect(result.candidate).toHaveLength(1)
    expect(result.history).toEqual(["reflect"])
  })

  test("ALTIMATE_LEARN_AUTO_PROMOTE=0 overrides config", async () => {
    const result = await reflectOnce({ auto_promote: true }, { ALTIMATE_LEARN_AUTO_PROMOTE: "0" })
    expect(result.outcome?.promotion).toBeUndefined()
    expect(result.approved).toEqual([])
    expect(result.candidate).toHaveLength(1)
  })

  test("a candidate staged earlier by manual reflection is never promoted automatically", async () => {
    const result = await reflectOnce({ auto_promote: true }, {}, (root) => stage(root, [B]))
    expect(result.outcome?.promotion).toMatchObject({ status: "held", reason: "the candidate already had lesson changes waiting for review" })
    expect(result.approved).toEqual([])
    expect(result.candidate?.map((lesson) => lesson.text)).toEqual([B.text, "List result columns explicitly."])
  })

  test("no promotion once the reflection's deadline or abort has fired", async () => {
    await using dir = await tmpdir({ git: true, config: { learn: { capture: true, auto_reflect: true, auto_promote: true, model: "test/model" } } })
    const model = spyOn(Reflect, "providerGenerate").mockImplementation(() => Effect.succeed(async () => ({
      deltas: [{ op: "ADD", text: "List result columns explicitly.", reason: "user correction" }],
    })))
    try {
      await Instance.provide({ directory: dir.path, fn: async () => {
        const session = await Session.create({})
        await Signals.appendSignal(dir.path, {
          kind: "user_correction", sessionID: session.id, text: "No, list result columns explicitly.", reason: "correction",
        })
        // Cancellation arrives right after the reflection committed its candidate.
        const staged = () => Bun.file(Store.paths(dir.path, NAME).candidate).size > 0
        const outcome = await autoReflectSession(session.id, { shouldContinue: () => !staged() })
        expect(outcome?.promotion).toMatchObject({ status: "held", reason: expect.stringContaining("deadline or was cancelled") })
        expect(await Store.readPromoted(dir.path, NAME)).toBeUndefined()
        expect(await Store.loadCandidateLessons(dir.path, NAME)).toHaveLength(1)
      } })
    } finally {
      model.mockRestore()
      await Instance.disposeAll()
    }
  })

  test("a held-back promotion reports why and leaves the candidate staged", async () => {
    const result = await reflectOnce({ auto_promote: true, auto_promote_daily: 0 })
    expect(result.outcome?.promotion).toMatchObject({ status: "held" })
    expect(result.outcome?.line).toContain("for review (not auto-promoted: daily limit reached")
    expect(result.approved).toEqual([])
    expect(result.candidate).toHaveLength(1)
  })
})

describe("learn CLI", () => {
  const entry = path.resolve(import.meta.dir, "../../../src/index.ts")
  async function learn(cwd: string, args: string[], env: Record<string, string> = {}) {
    const proc = Bun.spawn(["bun", "run", "--conditions=browser", entry, "learn", ...args], {
      cwd,
      env: {
        ...process.env, ALTIMATE_DISABLE_TELEMETRY: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", NO_COLOR: "1",
        OPENCODE_TEST_STATE_HOME: path.join(cwd, "state"), ALTIMATE_LEARN: "", ALTIMATE_LEARN_CAPTURE: "",
        ALTIMATE_LEARN_AUTO: "", ALTIMATE_LEARN_AUTO_PROMOTE: "", ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    return { stdout, stderr, code }
  }

  test("enable --auto-promote writes the key, plain enable keeps it, disable turns it off", async () => {
    await using dir = await tmpdir({ git: true })
    const file = path.join(dir.path, "opencode.json")
    await fs.writeFile(file, JSON.stringify({ learn: { capture: false } }))
    const read = async () => parseJsonc(await fs.readFile(file, "utf8")).learn

    const plain = await learn(dir.path, ["enable"])
    expect(plain.code).toBe(0)
    expect(await read()).toEqual({ capture: true, auto_reflect: true })
    expect(plain.stdout).toContain("review with `altimate-code learn show`")

    const enabled = await learn(dir.path, ["enable", "--auto-promote"])
    expect(enabled.code).toBe(0)
    expect(await read()).toEqual({ capture: true, auto_reflect: true, auto_promote: true })
    expect(enabled.stdout).toContain("Automatic promotion: on")
    expect((await learn(dir.path, ["enable"])).code).toBe(0)
    expect((await read()).auto_promote).toBe(true)
    const status = JSON.parse((await learn(dir.path, ["status", "--json"])).stdout)
    expect(status).toMatchObject({ auto_promote: true, last_auto_promotion: null, last_held_back: null })
    expect(status.limits).toMatchObject({ auto_promote_max_changes: 3, auto_promote_daily: 5 })

    const overridden = await learn(dir.path, ["enable", "--auto-promote"], { ALTIMATE_LEARN_AUTO_PROMOTE: "0" })
    expect(overridden.code).toBe(0)
    expect(overridden.stdout).toContain("Automatic promotion stays off")

    expect((await learn(dir.path, ["disable"])).code).toBe(0)
    expect(await read()).toEqual({ capture: false, auto_reflect: false, auto_promote: false })
    expect(JSON.parse((await learn(dir.path, ["status", "--json"])).stdout).auto_promote).toBe(false)
  }, 120_000)

  test("status lists lessons an automatic promotion removed", async () => {
    await using dir = await tmpdir({ git: true })
    await approve(dir.path, [A])
    await autoPromote(input(dir.path, await stage(dir.path, [A, B])))
    await autoPromote(input(dir.path, await stage(dir.path, [A])))
    const status = await learn(dir.path, ["status"])
    expect(status.stdout).toMatch(new RegExp(`Last auto-promotion: \\S+ - removed ${B.id}; previous lessons archived as v2`))
    expect(JSON.parse((await learn(dir.path, ["status", "--json"])).stdout).last_auto_promotion).toMatchObject({ lessons: [], removed: [B.id] })
  }, 60_000)

  test("status reports the last auto-promotion and hold-back; show marks auto-promoted lessons", async () => {
    await using dir = await tmpdir({ git: true })
    await approve(dir.path, [A])
    await autoPromote(input(dir.path, await stage(dir.path, [A, B])))
    await autoPromote(input(dir.path, await stage(dir.path, [B])))
    const status = await learn(dir.path, ["status"])
    expect(status.code).toBe(0)
    expect(status.stdout).toContain("Automatic promotion: off")
    expect(status.stdout).toMatch(new RegExp(`Last auto-promotion: \\S+ - ${B.id}; previous lessons archived as v1`))
    expect(status.stdout).toContain(`Last held back: `)
    expect(status.stdout).toContain(`person-approved lesson ${A.id}`)
    const show = await learn(dir.path, ["show"])
    expect(show.stdout).toContain(`[${B.id}] ${B.text} (auto-promoted)`)
    expect(show.stdout).toContain(`[${A.id}] ${A.text}\n`)
  }, 60_000)
})
