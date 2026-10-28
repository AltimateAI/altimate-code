// altimate_change - new file
//
// `learn bootstrap` and `learn import-reviews` in a linked project: the lessons they staged from history become
// proposals in the owner's review queue (origin `bootstrap` / `import_reviews`), sent without a card per rule.
// Only what this run staged is sent: the caller snapshots the candidate first (`candidateTexts`). A candidate
// that this run created is discarded; one that existed before is kept for `learn show` / `learn promote`.
// One summary line reports how many were sent.
import * as Store from "../learn/store"
import { RulesStore } from "./store"
import { RulesSync } from "./sync"

/** The candidate's lesson texts before a run, or undefined when there is no candidate. */
export async function candidateTexts(root: string, name: string): Promise<Set<string> | undefined> {
  const candidate = await Store.loadCandidateLessons(root, name)
  return candidate ? new Set(candidate.map((lesson) => lesson.text)) : undefined
}

export async function proposeStaged(input: {
  root: string
  directory: string
  learn: Parameters<typeof RulesSync.run>[2]
  name: string
  origin: "bootstrap" | "import_reviews"
  /** `candidateTexts` before the run. */
  before: Set<string> | undefined
}): Promise<{ status: "not_linked" } | { status: "none" } | { status: "sent"; proposed: number; sent: number; queued: number; message: string }> {
  const state = await RulesStore.read(input.root)
  if (!state.scope) return { status: "not_linked" }
  const [approved, candidate] = await Promise.all([
    Store.loadApproved(input.root, input.name),
    Store.loadCandidateLessons(input.root, input.name),
  ])
  if (!candidate) return { status: "none" }
  const known = new Set([...approved.map((lesson) => lesson.text), ...(input.before ?? [])])
  const added = candidate.filter((lesson) => !known.has(lesson.text))
  if (!added.length) {
    // Nothing new beyond the approved lessons: a candidate this run created only duplicates them.
    if (!input.before) await Store.reject(input.root, input.name)
    return { status: "none" }
  }
  for (const lesson of added)
    await RulesSync.enqueue(input.root, {
      change: "add",
      text: lesson.text,
      applies_to: lesson.trigger?.paths ?? [],
      why: input.origin === "bootstrap" ? "Found in past sessions (learn bootstrap)" : "Found in past pull request reviews",
      origin: input.origin,
      evidence_sessions: 1,
      corrections: [],
    })
  // The workspace's review queue replaces a candidate this run created.
  if (!input.before) await Store.reject(input.root, input.name)
  const report = await RulesSync.runFresh(input.root, input.directory, input.learn)
  const sent = report.push?.sent.filter((s) => s.status === "pending").length ?? 0
  const queued = (await RulesStore.read(input.root)).outbox.length
  const owner = state.workspace?.owner_name ?? "the workspace owner"
  return {
    status: "sent",
    proposed: added.length,
    sent,
    queued,
    message: `${sent} ${sent === 1 ? "rule" : "rules"} sent for ${owner}'s review in ${state.workspace?.name ?? "the workspace"}` +
      (queued ? `; ${queued} queued until the workspace is reachable` : "") + "." +
      (input.before ? " Your earlier local candidate was kept: `learn show`." : ""),
  }
}

export * as RulesFromHistory from "./from-history"
