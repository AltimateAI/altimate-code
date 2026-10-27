// altimate_change - new file
//
// `learn bootstrap` and `learn import-reviews` in a linked project: the lessons they staged from history become
// proposals in the owner's review queue (origin `bootstrap` / `import_reviews`), sent without a card per rule,
// and the local candidate is discarded. One summary line reports how many were sent.
import * as Store from "../learn/store"
import { RulesStore } from "./store"
import { RulesSync } from "./sync"

export async function proposeStaged(input: {
  root: string
  directory: string
  learn: Parameters<typeof RulesSync.run>[2]
  name: string
  origin: "bootstrap" | "import_reviews"
}): Promise<{ status: "not_linked" } | { status: "none" } | { status: "sent"; proposed: number; sent: number; queued: number; message: string }> {
  const state = await RulesStore.read(input.root)
  if (!state.scope) return { status: "not_linked" }
  const [approved, candidate] = await Promise.all([
    Store.loadApproved(input.root, input.name),
    Store.loadCandidateLessons(input.root, input.name),
  ])
  if (!candidate) return { status: "none" }
  const before = new Set(approved.map((lesson) => lesson.text))
  const added = candidate.filter((lesson) => !before.has(lesson.text))
  if (!added.length) return { status: "none" }
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
  // The workspace's review queue replaces the local candidate.
  await Store.reject(input.root, input.name)
  const report = await RulesSync.run(input.root, input.directory, input.learn)
  const sent = report.push?.sent.filter((s) => s.status === "pending").length ?? 0
  const queued = (await RulesStore.read(input.root)).outbox.length
  const owner = state.workspace?.owner_name ?? "the workspace owner"
  return {
    status: "sent",
    proposed: added.length,
    sent,
    queued,
    message: `${sent} ${sent === 1 ? "rule" : "rules"} sent for ${owner}'s review in ${state.workspace?.name ?? "the workspace"}` +
      (queued ? `; ${queued} queued until the workspace is reachable` : "") + ".",
  }
}

export * as RulesFromHistory from "./from-history"
