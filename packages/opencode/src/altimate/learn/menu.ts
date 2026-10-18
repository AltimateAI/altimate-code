// altimate_change - new file
//
// What the TUI's `/learn` menu shows and does, kept apart from the dialog so it can be tested: a summary of the
// project's lessons and their sync, turning sync off or on, and syncing now. Everything here reads local files,
// except `syncNow`, which runs the same pull and push as `learn sync`.
import { syncEnabled, learnEnabled } from "./config"
import * as Playbook from "./playbook"
import * as Store from "./store"
import * as Sync from "./sync"
import { writeProjectLearning } from "./project-config"
import { sha256 } from "./store"
import { canonical, type Lesson } from "./lesson"

type LearnConfig = Parameters<typeof syncEnabled>[0]

export interface Summary {
  learning: boolean
  sync: boolean
  /** Approved lessons in the project, over every store. */
  approved: number
  /** Stores with a staged candidate waiting for `learn promote`. */
  staged: string[]
  /** Lesson sync at a glance; absent when sync is off or has not run here for this account. */
  lessons?: Sync.SidebarStatus
  /** The last pull's error, when it failed. */
  pullError?: string
  /** Set while the server is known not to support lesson sync. */
  unsupportedUntil?: string
  /** Why sync is off when the project config cannot turn it on: an environment override or a kill switch. */
  forcedOff?: string
}

export async function summary(root: string, directory: string, learn: LearnConfig | undefined): Promise<Summary> {
  const out: Summary = { learning: learnEnabled(learn), sync: syncEnabled(learn), approved: 0, staged: [] }
  for (const store of await Sync.stores(root)) {
    out.approved += (await Store.loadApproved(root, store).catch(() => [])).length
    if (await Store.loadCandidateLessons(root, store).catch(() => undefined)) out.staged.push(store)
  }
  if (!out.sync) {
    // Even `learn.sync: true` would not turn it on: the environment or a kill switch wins over the project config.
    if (!syncEnabled({ ...learn, sync: true }))
      out.forcedOff = "Turned off by ALTIMATE_LEARN_SYNC=0, ALTIMATE_DISABLE_WORKSPACE or ALTIMATE_LEARN=0, or learning is off for this project."
    return out
  }
  const lessons = await Sync.sidebarStatus(directory, learn)
  if (lessons) out.lessons = lessons
  const state = await Sync.status(root, Playbook.DEFAULT_NAME, learn).catch(() => undefined)
  if (state?.last_pull?.outcome === "error" && state.last_pull.error) out.pullError = state.last_pull.error
  if (state?.unsupported_until && Date.parse(state.unsupported_until) > Date.now()) out.unsupportedUntil = state.unsupported_until
  return out
}

/** Turn lesson sync off or on in the project config. Off also drops the pulled team lessons, like `learn disable --sync`. */
export async function setSync(root: string, directory: string, on: boolean): Promise<{ file: string }> {
  const file = await writeProjectLearning(root, directory, undefined, undefined, on)
  if (!on) await Sync.invalidate(root)
  return { file }
}

/** One line for a toast, from a `learn sync` run. */
export function describeRun(report: Sync.SyncReport): { ok: boolean; message: string } {
  if (report.context.status === "off") return { ok: false, message: "Lesson sync is off for this project." }
  if (report.context.status === "skipped") return { ok: false, message: `Lesson sync skipped: ${report.context.reason}.` }
  const team = report.pulls.reduce((n, p) => n + (p.lessons ?? 0), 0)
  const submitted = report.pushes.reduce((n, p) => n + p.submitted, 0)
  const held = report.pushes.reduce((n, p) => n + p.held, 0)
  const errors = [...new Set([...report.pulls.flatMap((p) => (p.error ? [p.error] : [])), ...report.pushes.flatMap((p) => (p.error ? [p.error] : []))])]
  const parts = [`${team} team ${team === 1 ? "lesson" : "lessons"}`, `${submitted} sent for review`]
  if (held) parts.push(`${held} held`)
  if (errors.length) return { ok: false, message: `Synced with problems: ${parts.join(", ")}; ${errors.join("; ")}` }
  return { ok: true, message: `Synced: ${parts.join(", ")}. The session picks it up on your next message.` }
}

export async function syncNow(root: string, directory: string, learn: LearnConfig | undefined) {
  return describeRun(await Sync.run(root, directory, learn ?? {}))
}

/** A staged candidate as per-lesson changes against the approved set, for review before promote. */
export interface StagedReview {
  store: string
  /** Hash of the candidate this review shows: promote refuses a candidate that changed since. */
  candidateHash: string
  added: Lesson[]
  changed: { before: Lesson; after: Lesson }[]
  removed: Lesson[]
  /** Lessons that mention skipping or disabling verification, as `learn show` warns. */
  warnings: string[]
}

const material = (lesson: Lesson) => canonical({ text: lesson.text, tags: lesson.tags, pinned: lesson.pinned ?? false, trigger: lesson.trigger })

export async function stagedReview(root: string, store: string): Promise<StagedReview | undefined> {
  const [approved, candidate] = await Promise.all([Store.loadApproved(root, store), Store.loadCandidateLessons(root, store)])
  if (!candidate) return undefined
  const before = new Map(approved.map((lesson) => [lesson.id, lesson]))
  const after = new Map(candidate.map((lesson) => [lesson.id, lesson]))
  const review: StagedReview = {
    store,
    candidateHash: sha256(canonical(candidate)),
    added: candidate.filter((lesson) => !before.has(lesson.id)),
    changed: candidate.flatMap((lesson) => {
      const was = before.get(lesson.id)
      return was && material(was) !== material(lesson) ? [{ before: was, after: lesson }] : []
    }),
    removed: approved.filter((lesson) => !after.has(lesson.id)),
    warnings: Store.verificationWarnings(JSON.stringify(candidate)),
  }
  return review.added.length || review.changed.length || review.removed.length ? review : undefined
}

/**
 * Promote exactly the reviewed candidate, as `learn promote` does after its confirmation: with sync on, the
 * promotion's proposals are queued and sent (bounded) for the workspace owner's review.
 */
export async function promote(root: string, directory: string, store: string, candidateHash: string, learn: LearnConfig | undefined) {
  const scope = await Sync.proposalScope(root, directory, learn ?? {}).catch(() => undefined)
  const { promotionHooks } = await import("./proposals")
  const { archived } = await Store.promote(root, store, {
    expectedCandidateHash: candidateHash,
    // A person reviewed the flagged lessons in the dialog, as with the CLI's interactive confirmation.
    allowFlagged: true,
    ...(scope ? promotionHooks(root, store, scope, "manual") : {}),
  })
  const sent = syncEnabled(learn)
    ? await Sync.run(root, directory, learn ?? {}, { pull: false, deadline: Date.now() + Sync.PUSH_BUDGET_MS }).catch(() => undefined)
    : undefined
  const submitted = sent?.pushes.reduce((n, p) => n + p.submitted, 0) ?? 0
  return {
    message: `Promoted "${store}"${archived ? ` (previous version archived as v${archived})` : ""}.` +
      (submitted ? ` ${submitted} sent for the workspace owner's review.` : ""),
  }
}

export interface HeldProposal {
  store: string
  lesson_key: string
  change_type: string
  text: string
  reason: string
}

/** Proposals held for this account and workspace: a conflict to review, or a request the workspace refused. */
export async function heldProposals(root: string, learn: LearnConfig | undefined): Promise<HeldProposal[]> {
  if (!syncEnabled(learn)) return []
  const held: HeldProposal[] = []
  for (const store of await Sync.stores(root)) {
    const state = await Sync.status(root, store, learn).catch(() => undefined)
    for (const entry of state?.outbox.held ?? []) held.push({ store, ...entry })
  }
  return held
}

/** `learn push --resubmit <key>`: pull, then send the held proposals for this key against the current versions. */
export async function resubmit(root: string, directory: string, key: string, learn: LearnConfig | undefined) {
  const report = await Sync.run(root, directory, learn ?? {}, { resubmit: key })
  const result = describeRun(report)
  if (!result.ok) return result
  if ((await heldProposals(root, learn)).some((p) => p.lesson_key === key))
    return { ok: false, message: `${key} is still held: the workspace changed it again. Review it there first.` }
  if (!report.pushes.some((p) => p.submitted > 0))
    return { ok: true, message: `${key} needed nothing more: the workspace already holds that change.` }
  return { ok: true, message: `Resubmitted ${key}. ${result.message}` }
}

export interface LessonRow {
  store: string
  id: string
  text: string
  tags: string[]
  /** `learn show` markers: team, local, pending review, held, retired by team, pinned, workspace-wide. */
  marks: string[]
  source: "approved" | "team"
}

/**
 * The project's lessons as `learn show` lists them, for reading in the TUI: approved lessons with their sync
 * markers, then team lessons from the workspace that have no local copy. Local files only.
 */
export async function lessons(root: string, learn: LearnConfig | undefined): Promise<LessonRow[]> {
  const rows: LessonRow[] = []
  for (const store of await Sync.stores(root)) {
    const approved = await Store.loadApproved(root, store).catch(() => [])
    const team = syncEnabled(learn) ? await Sync.markers(root, store).catch(() => undefined) : undefined
    for (const lesson of approved)
      rows.push({
        store, id: lesson.id, text: lesson.text, tags: lesson.tags, source: "approved",
        marks: [team?.mark(lesson.id, lesson.text) ?? "", lesson.pinned ? "pinned" : ""].filter(Boolean),
      })
    const local = new Set(approved.map((lesson) => lesson.id))
    for (const lesson of team?.team ?? []) {
      if (local.has(lesson.lesson_key)) continue
      rows.push({
        store, id: lesson.lesson_key, text: lesson.text, tags: lesson.tags, source: "team",
        marks: ["team", lesson.pinned ? "pinned" : "", lesson.repo_identity === null ? "workspace-wide" : ""].filter(Boolean),
      })
    }
  }
  return rows
}
