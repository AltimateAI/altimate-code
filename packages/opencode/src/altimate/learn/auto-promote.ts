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
}

export interface AutoPromoteState {
  /** Recent automatic promotions (rolling-window rate limit), plus always the latest one. */
  promotions: AutoPromotion[]
  /** Lessons that went live without review: id -> hash of the text that was promoted. */
  auto: Record<string, string>
  lastHeldBack?: { at: string; reason: string; session?: string }
}

export type AutoPromoteResult =
  | { status: "promoted"; archived?: number; lessons: string[]; removed: string[] }
  | { status: "held"; reason: string }

export const autoPromoteStateFile = (root: string, name: string) => path.join(Store.paths(root, name).learnDir, "auto-promote.json")

const textHash = (text: string) => Store.sha256(text)

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
      (p.session === undefined || typeof p.session === "string")) &&
    !!state.auto && typeof state.auto === "object" && !Array.isArray(state.auto) &&
    Object.entries(state.auto).every(([id, hash]) => ID.test(id) && typeof hash === "string" && HASH.test(hash)) &&
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
 * Lessons marked auto only while their approved text is still the text that was auto-promoted.
 * A pinned lesson is a person's decision, so it is never automatic.
 */
export function autoPromotedIds(state: AutoPromoteState, approved: readonly Lessons.Lesson[]): Set<string> {
  return new Set(approved.filter((lesson) => !lesson.pinned && Object.hasOwn(state.auto, lesson.id) &&
    state.auto[lesson.id] === textHash(lesson.text)).map((lesson) => lesson.id))
}

/** `learn pin` / `unpin` are person actions: the lesson stops being automatic for good. Caller holds the lock. */
export async function forgetAutoPromoted(root: string, name: string, id: string): Promise<void> {
  let state: AutoPromoteState
  try {
    state = await readAutoPromoteState(root, name)
  } catch (error) {
    // Automatic promotion refuses to run on an unreadable state file, so there is nothing to protect.
    log.warn("automatic promotion state unreadable; pin recorded without clearing it", { error: redactSecrets(errText(error)) })
    return
  }
  if (!Object.hasOwn(state.auto, id)) return
  delete state.auto[id]
  await writeState(root, name, state)
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
  session?: string
  /** Set when the reflection's feedback looked like an instruction to the model. */
  flaggedFeedback?: string
  /** The candidate before this reflection staged its changes; its lesson changes were never reviewed. */
  previousCandidate?: readonly Lessons.Lesson[]
  limits: AutoPromoteLimits
  now?: number
  lockTimeoutMs?: number
}

/** Best effort after a failed publish: the original candidate and no leftover empty baseline. */
async function restore(root: string, name: string, candidate: string, rewritten: boolean, baseline: boolean) {
  const p = Store.paths(root, name)
  try {
    if (rewritten && (await Store.readCandidate(root, name)) !== undefined) await Store.writeAtomic(root, p.candidate, candidate)
    if (baseline && (await Store.readPromoted(root, name)) === Lessons.canonical([])) {
      await assertLearnLock(root)
      await SafeFS.remove(root, p.approved)
    }
  } catch (error) {
    log.warn("failed automatic promotion not fully restored", { error: redactSecrets(errText(error)) })
  }
}

const ids = (lessons: readonly Lessons.Lesson[]) => lessons.map((lesson) => lesson.id).join(", ")

export async function autoPromote(input: AutoPromoteInput): Promise<AutoPromoteResult> {
  const { root, name } = input
  const now = input.now ?? Date.now()
  try {
    return await Store.transaction(root, async () => {
      let state: AutoPromoteState
      try {
        state = await readAutoPromoteState(root, name)
      } catch (error) {
        return { status: "held", reason: `automatic promotion state is unreadable (${errText(error)}); repair or delete it` } as const
      }
      const held = async (reason: string): Promise<AutoPromoteResult> => {
        state.lastHeldBack = { at: new Date(now).toISOString(), reason, ...(input.session ? { session: input.session } : {}) }
        await writeState(root, name, state).catch((error) =>
          log.warn("automatic promotion status not recorded", { error: redactSecrets(errText(error)) }))
        return { status: "held", reason }
      }
      // Gate: evidence. Reflection without external feedback never goes live on its own.
      if (input.signals < 1) return held("no feedback signal behind this reflection")
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
      // Gate: a person's approval is never undone automatically.
      const auto = autoPromotedIds(state, approved)
      const person = [...edited, ...removed].filter((lesson) => !auto.has(lesson.id))
      if (person.length) return held(`it would edit or remove person-approved lesson ${ids(person)}`)
      // Gate: size.
      const count = changed.length + removed.length
      if (count > input.limits.auto_promote_max_changes)
        return held(`${count} lesson changes exceed learn.auto_promote_max_changes (${input.limits.auto_promote_max_changes})`)
      // Gate: rate. Timestamps in the future count as recent, so a clock change cannot reopen the window.
      const recent = state.promotions.filter((promotion) => Date.parse(promotion.at) > now - DAY_MS)
      if (recent.length >= input.limits.auto_promote_daily)
        return held(`daily limit reached (${recent.length} automatic promotions in 24 hours; learn.auto_promote_daily=${input.limits.auto_promote_daily})`)

      const promotion: AutoPromotion = {
        at: new Date(now).toISOString(), lessons: changed.map((lesson) => lesson.id), signals: input.signals,
        ...(removed.length ? { removed: removed.map((lesson) => lesson.id) } : {}),
        ...(input.session ? { session: input.session } : {}),
      }
      const previous = state.promotions.at(-1)
      const promotions = [...recent.filter((p) => p !== previous), ...(previous ? [previous] : []), promotion]
      // Record only the rate-limit entry before publishing, so an interrupted publish can only overcount.
      // Auto marks are written after the publish succeeds: a stale mark would let a later automatic
      // promotion remove a lesson a person approved.
      await writeState(root, name, { ...state, promotions })
      // Person-approved lessons go live with their approved counters: an automatic promotion must not
      // reorder the core tier. The candidate's counter updates stay staged for review.
      const before = new Map(approved.map((lesson) => [lesson.id, lesson]))
      const publish = candidate.map((lesson) => before.has(lesson.id) && !auto.has(lesson.id) ? before.get(lesson.id)! : lesson)
      const original = Lessons.canonical(candidate)
      const publishText = Lessons.canonical(publish)
      const p = Store.paths(root, name)
      let baseline = false
      try {
        if (publishText !== original) await Store.writeAtomic(root, p.candidate, publishText)
        // A first promotion archives an empty set, so `learn rollback` can always undo it.
        if ((await Store.readPromoted(root, name)) === undefined) {
          await assertLearnLock(root)
          await SafeFS.mkdir(root, p.learnDir)
          await Store.writeAtomic(root, p.approved, Lessons.canonical([]))
          baseline = true
        }
        const { archived } = await Store.promote(root, name, {
          expectedCandidateHash: Store.sha256(publishText),
          // Every flagged lesson left in the candidate is unchanged from the approved set (checked above).
          allowFlagged: true,
          history: {
            action: "auto-promote", lessons: promotion.lessons, signals: input.signals, session: input.session,
            ...(promotion.removed ? { removed: promotion.removed } : {}),
          },
        })
        if (archived !== undefined) promotion.archived = archived
        const live = new Set(publish.map((lesson) => lesson.id))
        const nextAuto = Object.fromEntries([
          ...approved.filter((lesson) => auto.has(lesson.id)).map((lesson) => [lesson.id, state.auto[lesson.id]] as const),
          ...changed.map((lesson) => [lesson.id, textHash(lesson.text)] as const),
        ].filter(([id]) => live.has(id)))
        const { lastHeldBack: _cleared, ...rest } = state
        await writeState(root, name, { ...rest, promotions, auto: nextAuto }).catch((error) =>
          log.warn("automatic promotion marks not recorded", { error: redactSecrets(errText(error)) }))
        if (publishText !== original)
          await Store.writeAtomic(root, p.candidate, original).catch((error) =>
            log.warn("staged counter updates not restored", { error: redactSecrets(errText(error)) }))
        return { status: "promoted", archived, lessons: promotion.lessons, removed: promotion.removed ?? [] }
      } catch (error) {
        // Nothing went live: put the reviewed inputs back as they were.
        await restore(root, name, original, publishText !== original, baseline)
        if (!(error instanceof Store.StoreError)) throw error
        state.promotions = promotions.filter((p) => p !== promotion)
        return held(error.message.replace(/^Refusing to promote: /, "promote refused: "))
      }
    }, { timeoutMs: input.lockTimeoutMs ?? LOCK_TIMEOUT_MS })
  } catch (error) {
    const reason = `automatic promotion failed (${redactSecrets(errText(error))})`
    log.warn(reason, { name })
    return { status: "held", reason }
  }
}
