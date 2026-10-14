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
