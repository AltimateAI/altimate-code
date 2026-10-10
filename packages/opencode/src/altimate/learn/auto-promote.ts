// altimate_change - new file
//
// Opt-in automatic promotion (`learn.auto_promote`). Runs only after automatic reflection staged a
// candidate, and promotes exactly that candidate when every gate passes; otherwise the candidate stays
// staged for review and the reason is recorded. Every check and write happens under the learn lock, and
// the promotion itself is `Store.promote`, so `learn rollback` undoes it like a manual promote.
// Never throws: learning must not change a run's outcome.
import path from "node:path"
import fs from "node:fs/promises"
import * as Store from "./store"
import * as Lessons from "./lesson"
import * as SafeFS from "./safe-fs"
import { verificationWarning } from "./curator"
import { redactSecrets } from "./digest"
import { assertLearnLock } from "./lock"
import { errText } from "./session-reflect"
import type { AutoPromoteLimits } from "./config"
import { readRemote, type Scope } from "./ledger"
import { recordPromotion } from "./proposals"
import { Log } from "@/util/log"

const log = Log.create({ service: "learn.auto-promote" })
const DAY_MS = 86_400_000
const LOCK_TIMEOUT_MS = 10_000
const HASH = /^[0-9a-f]{64}$/
const ID = /^L-[0-9a-f]{4,}$/

export interface AutoPromotion {
  at: string
  /** The archived previous version; `learn rollback` restores it. */
  archived?: number
  /** Lessons added or edited. */
  lessons: string[]
  /** Lessons removed. */
  removed?: string[]
  signals: number
  session?: string
  /** A rate-limit reservation whose publish has not been confirmed. Counts toward the daily limit only. */
  pending?: true
}

export interface AutoPromoteState {
  /** Recent automatic promotions (rolling-window rate limit), plus always the latest one. */
  promotions: AutoPromotion[]
  /** Lessons that went live without review: id -> hash of the text that was promoted. */
  auto: Record<string, string>
  /**
   * Hash of the approved set the last automatic promotion published. The `auto` marks are trusted only
   * while the approved set is unchanged: any person action (promote, rollback, pin, unpin, a pull) voids them.
   */
  approvedHash?: string
  lastHeldBack?: { at: string; reason: string; session?: string }
}

export type AutoPromoteResult =
  | { status: "promoted"; archived?: number; lessons: string[]; removed: string[]; warning?: string }
  | { status: "held"; reason: string }

export const autoPromoteStateFile = (root: string, name: string) => path.join(Store.paths(root, name).learnDir, "auto-promote.json")

/** Signal kinds that carry a person's or an external system's judgement; `tool_retry` is captured automatically. */
export const FEEDBACK_SIGNAL_KINDS: readonly string[] = ["user_correction", "review", "ci"]

const textHash = (text: string) => Store.sha256(text)
const approvedSetHash = (approved: readonly Lessons.Lesson[]) => Store.sha256(Lessons.canonical(approved))

/** Throws on a malformed file: automatic promotion fails closed rather than forgetting its rate limit. */
export async function readAutoPromoteState(root: string, name: string): Promise<AutoPromoteState> {
  let raw: string
  try {
    raw = await fs.readFile(await SafeFS.assertSafePath(root, autoPromoteStateFile(root, name)), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { promotions: [], auto: {} }
    throw error
  }
  const state = JSON.parse(raw) as AutoPromoteState
  const valid = !!state && typeof state === "object" && !Array.isArray(state) &&
    Array.isArray(state.promotions) && state.promotions.every((p) => !!p && typeof p === "object" &&
      typeof p.at === "string" && Number.isFinite(Date.parse(p.at)) &&
      Array.isArray(p.lessons) && p.lessons.every((id) => typeof id === "string" && ID.test(id)) &&
      (p.removed === undefined || (Array.isArray(p.removed) && p.removed.every((id) => typeof id === "string" && ID.test(id)))) &&
      Number.isSafeInteger(p.signals) && p.signals >= 0 &&
      (p.archived === undefined || (Number.isSafeInteger(p.archived) && p.archived > 0)) &&
      (p.session === undefined || typeof p.session === "string") &&
      (p.pending === undefined || p.pending === true)) &&
    !!state.auto && typeof state.auto === "object" && !Array.isArray(state.auto) &&
    Object.entries(state.auto).every(([id, hash]) => ID.test(id) && typeof hash === "string" && HASH.test(hash)) &&
    (state.approvedHash === undefined || (typeof state.approvedHash === "string" && HASH.test(state.approvedHash))) &&
    (state.lastHeldBack === undefined || (!!state.lastHeldBack && typeof state.lastHeldBack.at === "string" &&
      typeof state.lastHeldBack.reason === "string"))
  if (!valid) throw new Error(`Invalid automatic promotion state in ${autoPromoteStateFile(root, name)}`)
  return state
}

async function writeState(root: string, name: string, state: AutoPromoteState) {
  const file = autoPromoteStateFile(root, name)
  await assertLearnLock(root)
  await SafeFS.mkdir(root, path.dirname(file))
  await Store.writeAtomic(root, file, JSON.stringify(state, null, 2) + "\n", 0o600)
}

/**
 * Person actions on the approved set (`learn promote`, `rollback`, `pin`, `unpin`) end automatic ownership
 * for good, even if the set later returns to the same bytes. Called under the learn lock before the
 * action's first write. A failed write aborts the action (fail closed): the error says nothing changed.
 * An unreadable state file trusts no marks already (automatic promotion refuses to run), so it is left alone.
 */
export async function voidAutoOwnership(root: string, name: string): Promise<void> {
  let state: AutoPromoteState
  try {
    state = await readAutoPromoteState(root, name)
  } catch (error) {
    // Its marks could become readable again later, so a person action must not go ahead without voiding them.
    throw new Error(`Cannot read ${autoPromoteStateFile(root, name)} to record that lessons are no longer automatic ` +
      `(${redactSecrets(errText(error))}); nothing was changed. Fix the file's permissions or delete it, then retry.`)
  }
  if (Object.keys(state.auto).length === 0 && state.approvedHash === undefined) return
  const { approvedHash: _voided, ...rest } = state
  try {
    await writeState(root, name, { ...rest, auto: {} })
  } catch (error) {
    throw new Error(`Cannot record that lessons are no longer automatic in ${autoPromoteStateFile(root, name)} ` +
      `(${redactSecrets(errText(error))}); nothing was changed. Fix the file's permissions or delete it, then retry.`)
  }
}

/** The latest promotion whose publish completed; reservations are not promotions. */
export function lastCompletedPromotion(state: AutoPromoteState): AutoPromotion | undefined {
  return state.promotions.findLast((promotion) => !promotion.pending)
}

/**
 * Lessons a person never approved: those published by the last automatic promotion (or carried through it),
 * while the approved set is still exactly what it published and the lesson text is unchanged.
 * A pinned lesson is a person's decision, so it is never automatic.
 */
export function autoPromotedIds(state: AutoPromoteState, approved: readonly Lessons.Lesson[]): Set<string> {
  if (state.approvedHash === undefined || state.approvedHash !== approvedSetHash(approved)) return new Set()
  return new Set(approved.filter((lesson) => !lesson.pinned && Object.hasOwn(state.auto, lesson.id) &&
    state.auto[lesson.id] === textHash(lesson.text)).map((lesson) => lesson.id))
}

/** Counter-only differences (helpful, harmful, applied, updated) are not lesson changes. */
function material(lesson: Lessons.Lesson) {
  return Lessons.canonical({
    text: lesson.text, tags: lesson.tags, scope: lesson.scope, pinned: lesson.pinned,
    trigger: lesson.trigger, coexists: lesson.coexists,
  })
}

export function lessonChanges(approved: readonly Lessons.Lesson[], candidate: readonly Lessons.Lesson[]) {
  const before = new Map(approved.map((lesson) => [lesson.id, lesson]))
  const after = new Set(candidate.map((lesson) => lesson.id))
  return {
    added: candidate.filter((lesson) => !before.has(lesson.id)),
    edited: candidate.filter((lesson) => before.has(lesson.id) && material(before.get(lesson.id)!) !== material(lesson)),
    removed: approved.filter((lesson) => !after.has(lesson.id)),
  }
}

export interface AutoPromoteInput {
  root: string
  name: string
  /** Hash of the candidate the reflection staged; any other candidate is never auto-promoted. */
  expectedCandidateHash: string
  /** Signals the reflection consumed. */
  signals: number
  /** Their kinds: at least one must be feedback from a person or an external check. */
  signalKinds: readonly string[]
  session?: string
  /** Set when the reflection's feedback looked like an instruction to the model. */
  flaggedFeedback?: string
  /** The candidate before this reflection staged its changes; its lesson changes were never reviewed. */
  previousCandidate?: readonly Lessons.Lesson[]
  limits: AutoPromoteLimits
  /** The reflection's cancellation and deadline, rechecked under the lock before anything is written. */
  shouldContinue?: () => boolean
  deadline?: number
  now?: number
  lockTimeoutMs?: number
  /** Lesson sync is on: the promotion's changes are queued as proposals before anything is published. */
  sync?: { scope: Scope }
}

/**
 * Keys of this store's team lessons in the last pull, whatever scope it was pulled for. A lesson the workspace
 * owner approved is person-approved, and a stale local auto-ownership mark must never override that.
 */
async function teamKeys(root: string, name: string): Promise<Set<string>> {
  const remote = await readRemote(root, name).catch(() => undefined)
  return new Set((remote?.lessons ?? []).filter((lesson) => lesson.store === name).map((lesson) => lesson.lesson_key))
}

export const CANCELLED_REASON = "reflection reached its deadline or was cancelled before promotion"
const ids = (lessons: readonly Lessons.Lesson[]) => lessons.map((lesson) => lesson.id).join(", ")

async function latestArchive(root: string, name: string): Promise<number | undefined> {
  const names = await fs.readdir(await SafeFS.assertSafePath(root, Store.paths(root, name).versions)).catch(() => [] as string[])
  const numbers = names.flatMap((file) => /^v(\d+)\.json$/.exec(file)?.[1] ?? []).map(Number)
  return numbers.length ? Math.max(...numbers) : undefined
}

/** Outside the lock (cancelled before acquiring it): record the reason if the lock is free right now. */
async function recordHeldUnlocked(input: AutoPromoteInput, reason: string, now: number) {
  await Store.transaction(input.root, async () => {
    const state = await readAutoPromoteState(input.root, input.name)
    state.lastHeldBack = { at: new Date(now).toISOString(), reason, ...(input.session ? { session: input.session } : {}) }
    await writeState(input.root, input.name, state)
  }, { timeoutMs: 1_000 }).catch((error) =>
    log.warn("automatic promotion status not recorded", { error: redactSecrets(errText(error)) }))
}

export async function autoPromote(input: AutoPromoteInput): Promise<AutoPromoteResult> {
  const { root, name } = input
  const now = input.now ?? Date.now()
  const live = () => (input.shouldContinue?.() ?? true) && (input.deadline === undefined || Date.now() < input.deadline)
  if (!live()) {
    await recordHeldUnlocked(input, CANCELLED_REASON, now)
    return { status: "held", reason: CANCELLED_REASON }
  }
  const lockTimeoutMs = Math.min(input.lockTimeoutMs ?? LOCK_TIMEOUT_MS,
    input.deadline === undefined ? Infinity : Math.max(1, input.deadline - Date.now()))
  try {
    return await Store.transaction(root, async () => {
      let state: AutoPromoteState
      try {
        state = await readAutoPromoteState(root, name)
      } catch (error) {
        // Not overwritten: the file holds the rate limit. `learn status` reports it as unreadable.
        return { status: "held", reason: `automatic promotion state is unreadable (${errText(error)}); repair or delete it` } as const
      }
      const held = async (reason: string): Promise<AutoPromoteResult> => {
        state.lastHeldBack = { at: new Date(now).toISOString(), reason, ...(input.session ? { session: input.session } : {}) }
        await writeState(root, name, state).catch((error) =>
          log.warn("automatic promotion status not recorded", { error: redactSecrets(errText(error)) }))
        return { status: "held", reason }
      }
      // The lock wait may have outlived the reflection; nothing is published after that.
      if (!live()) return held(CANCELLED_REASON)
      // Gate: evidence. A person or an external check must be behind the change.
      if (input.signals < 1 || input.signalKinds.length === 0) return held("no feedback signal behind this reflection")
      if (!input.signalKinds.some((kind) => FEEDBACK_SIGNAL_KINDS.includes(kind)))
        return held("only automatically captured tool failures behind this reflection; it needs a correction, review or CI signal")
      if (input.flaggedFeedback) return held(`the feedback was flagged (${input.flaggedFeedback})`)
      // Gate: exactly the candidate this reflection staged.
      const candidateText = await Store.readCandidate(root, name)
      if (candidateText === undefined) return held("the candidate was removed before promotion")
      const candidate = Lessons.parse(candidateText)
      if (Store.sha256(Lessons.canonical(candidate)) !== input.expectedCandidateHash)
        return held("the candidate changed after reflection staged it")
      // Gate: the same validation as `learn promote` (lint, hidden characters, coexistence, overlaps).
      const invalid = Store.validateCandidate(name, candidateText, { grandfathered: await Store.grandfathered(root, name) })
      if (invalid) return held(`it fails validation: ${invalid}`)
      const approved = await Store.loadApproved(root, name)
      // Gate: only this reflection's changes. Earlier staged changes (manual reflect, bootstrap,
      // import-reviews, or a candidate held back before) wait for a person.
      if (input.previousCandidate) {
        const earlier = lessonChanges(approved, input.previousCandidate)
        if (earlier.added.length + earlier.edited.length + earlier.removed.length)
          return held("the candidate already had lesson changes waiting for review")
      }
      const { added, edited, removed } = lessonChanges(approved, candidate)
      const changed = [...added, ...edited]
      if (changed.length + removed.length === 0) return held("no lesson text changed (counter updates only)")
      // Gate: verification-weakening lessons always need a person. Unchanged flagged lessons were already approved.
      const flagged = changed.filter((lesson) => verificationWarning(lesson.text))
      if (flagged.length) return held(`flagged lesson ${ids(flagged)} mentions skipping or weakening verification`)
      // Gate: a person's approval is never undone automatically. Team lessons count as person-approved.
      const team = await teamKeys(root, name)
      const auto = new Set([...autoPromotedIds(state, approved)].filter((id) => !team.has(id)))
      const person = [...edited, ...removed].filter((lesson) => !auto.has(lesson.id))
      if (person.length) return held(`it would edit or remove person-approved lesson ${ids(person)}`)
      // Gate: size.
      const count = changed.length + removed.length
      if (count > input.limits.auto_promote_max_changes)
        return held(`${count} lesson changes exceed learn.auto_promote_max_changes (${input.limits.auto_promote_max_changes})`)
      // Gate: rate. Reservations count; timestamps in the future count, so a clock change cannot reopen the window.
      const recent = state.promotions.filter((promotion) => Date.parse(promotion.at) > now - DAY_MS)
      if (recent.length >= input.limits.auto_promote_daily)
        return held(`daily limit reached (${recent.length} automatic promotions in 24 hours; learn.auto_promote_daily=${input.limits.auto_promote_daily})`)
      if (!live()) return held(CANCELLED_REASON)

      const promotion: AutoPromotion = {
        at: new Date(now).toISOString(), lessons: changed.map((lesson) => lesson.id), signals: input.signals,
        ...(removed.length ? { removed: removed.map((lesson) => lesson.id) } : {}),
        ...(input.session ? { session: input.session } : {}),
      }
      // Keep the window (for the rate limit) and the last completed promotion (for status), in order.
      const completed = lastCompletedPromotion(state)
      const kept = state.promotions.filter((p) => p === completed || recent.includes(p))
      // Reserve the rate-limit slot before publishing, so an interrupted publish can only overcount.
      // Auto marks are written only once the publish is confirmed: a stale mark would let a later
      // automatic promotion remove a lesson a person approved.
      const reservation = { ...promotion, pending: true as const }
      await writeState(root, name, { ...state, promotions: [...kept, reservation] })
      // Person-approved lessons go live with their approved counters, so an automatic promotion cannot
      // reorder the core tier. The candidate file is left untouched and keeps those counter updates staged.
      const before = new Map(approved.map((lesson) => [lesson.id, lesson]))
      const publish = candidate.map((lesson) => before.has(lesson.id) && !auto.has(lesson.id) ? before.get(lesson.id)! : lesson)
      const publishText = Lessons.canonical(publish)
      const keepCandidate = publishText !== Lessons.canonical(candidate)
      const p = Store.paths(root, name)
      const finish = async (archived: number | undefined, warning?: string): Promise<AutoPromoteResult> => {
        const done: AutoPromotion = { ...promotion, ...(archived !== undefined ? { archived } : {}) }
        const nextAuto = Object.fromEntries([
          ...approved.filter((lesson) => auto.has(lesson.id)).map((lesson) => [lesson.id, state.auto[lesson.id]] as const),
          ...changed.map((lesson) => [lesson.id, textHash(lesson.text)] as const),
        ].filter(([id]) => publish.some((lesson) => lesson.id === id)))
        const { lastHeldBack: _cleared, ...rest } = state
        let note = warning
        await writeState(root, name, {
          ...rest, promotions: [...kept, done], auto: nextAuto, approvedHash: approvedSetHash(publish),
        }).catch((error) => {
          // Without the marks, the new lessons simply count as person-approved.
          note = [warning, `automatic promotion bookkeeping not recorded (${redactSecrets(errText(error))})`].filter(Boolean).join("; ")
          log.warn(note)
        })
        return { status: "promoted", archived, lessons: promotion.lessons, removed: promotion.removed ?? [], ...(note ? { warning: note } : {}) }
      }
      let baseline = false
      let published = false
      try {
        // A first promotion archives an empty set, so `learn rollback` can always undo it.
        if ((await Store.readPromoted(root, name)) === undefined) {
          await assertLearnLock(root)
          await SafeFS.mkdir(root, p.learnDir)
          await Store.writeAtomic(root, p.approved, Lessons.canonical([]))
          baseline = true
        }
        const { archived } = await Store.promote(root, name, {
          expectedCandidateHash: input.expectedCandidateHash,
          publish: publishText,
          keepCandidate,
          onPublished: () => { published = true },
          ...(input.sync ? { beforePublish: async (before: Lessons.Lesson[], after: Lessons.Lesson[]) => {
            await recordPromotion(root, name, input.sync!.scope, before, after, "auto_promote")
          } } : {}),
          // Every flagged lesson left in the candidate is unchanged from the approved set (checked above).
          allowFlagged: true,
          history: {
            action: "auto-promote", lessons: promotion.lessons, signals: input.signals, session: input.session,
            ...(promotion.removed ? { removed: promotion.removed } : {}),
          },
        })
        return await finish(archived)
      } catch (error) {
        // Store.promote can fail after approved.json was replaced (history, retired reconciliation), with any
        // error type. Then the lessons are live: report the promotion and record its marks rather than claiming
        // it was held. Only Store.promote's own signal counts; equal content alone may have come from a pull.
        const current = await Store.readPromoted(root, name).catch(() => undefined)
        if (published)
          return await finish(await latestArchive(root, name), `published, but finishing failed: ${redactSecrets(errText(error))}`)
        // Nothing went live: no leftover empty baseline.
        if (baseline && current === Lessons.canonical([]))
          await assertLearnLock(root).then(() => SafeFS.remove(root, p.approved)).catch((e) =>
            log.warn("empty baseline not removed", { error: redactSecrets(errText(e)) }))
        if (error instanceof Store.StoreError) {
          // A refusal publishes nothing: release the reservation.
          state.promotions = kept
          return held(error.message.replace(/^Refusing to promote: /, "promote refused: "))
        }
        // Unknown failure: keep the reservation so the daily limit can only overcount.
        state.promotions = [...kept, reservation]
        return held(`automatic promotion failed (${redactSecrets(errText(error))})`)
      }
    }, { timeoutMs: lockTimeoutMs })
  } catch (error) {
    // Lock timeout or a failure outside any recoverable step: the reason cannot be recorded without the lock.
    const reason = `automatic promotion failed (${redactSecrets(errText(error))})`
    log.warn(reason, { name })
    return { status: "held", reason }
  }
}
