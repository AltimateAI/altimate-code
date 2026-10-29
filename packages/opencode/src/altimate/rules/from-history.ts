// altimate_change - new file
//
// `learn bootstrap` and `learn import-reviews` in a linked project: the rules they staged from history can go to the
// owner's review queue (origin `bootstrap` / `import_reviews`), without a card per rule but never without consent:
// `stagedRules` lists what this run staged (linted, scoped), the command shows the list and asks to send it to the
// named workspace (or takes `--send-for-review`), and only then `sendStaged` queues it. Only what this run staged is
// offered: the caller snapshots the candidate first (`candidateTexts`). A candidate this run created is discarded
// once everything in it was sent; otherwise, and when the person declines, it stays for `learn show` / `learn promote`.
import { lint } from "../learn/curator"
import * as Store from "../learn/store"
import type { ProposalItem } from "./api"
import { RulesStore } from "./store"
import { RulesSync } from "./sync"

/** Path globs per proposal, and their length: the same bounds the card applies. */
const MAX_APPLIES_TO = 4
const MAX_GLOB = 200

/** The candidate's rule texts before a run, or undefined when there is no candidate. */
export async function candidateTexts(root: string, name: string): Promise<Set<string> | undefined> {
  const candidate = await Store.loadCandidateLessons(root, name)
  return candidate ? new Set(candidate.map((lesson) => lesson.text)) : undefined
}

export interface Staged {
  workspace: { name: string; owner: string }
  /** What would be sent, in order. */
  items: ProposalItem[]
  /** Staged rules that failed the rule lint and stay local only. */
  invalid: { text: string; reason: string }[]
}

/** What this run staged that is not approved yet, as proposals. Undefined when not linked or nothing is new. */
export async function stagedRules(input: {
  root: string
  name: string
  origin: "bootstrap" | "import_reviews"
  /** `candidateTexts` before the run. */
  before: Set<string> | undefined
}): Promise<Staged | undefined> {
  const state = await RulesStore.read(input.root)
  if (!state.workspace) return undefined
  const [approved, candidate] = await Promise.all([
    Store.loadApproved(input.root, input.name),
    Store.loadCandidateLessons(input.root, input.name),
  ])
  if (!candidate) return undefined
  const known = new Set([...approved.map((lesson) => lesson.text), ...(input.before ?? [])])
  const items: ProposalItem[] = []
  const invalid: Staged["invalid"] = []
  for (const lesson of candidate) {
    if (known.has(lesson.text)) continue
    const reason = lint(lesson.text)
    if (reason) {
      invalid.push({ text: lesson.text, reason })
      continue
    }
    items.push({
      change: "add",
      text: lesson.text,
      applies_to: (lesson.trigger?.paths ?? []).filter((glob) => glob.length <= MAX_GLOB).slice(0, MAX_APPLIES_TO),
      why: input.origin === "bootstrap" ? "Found in past sessions (learn bootstrap)" : "Found in past pull request reviews",
      origin: input.origin,
      evidence_sessions: 1,
      corrections: [],
    })
  }
  if (!items.length && !invalid.length) return undefined
  return { workspace: { name: state.workspace.name, owner: state.workspace.owner_name ?? "the workspace owner" }, items, invalid }
}

/** Queue the confirmed proposals and send them now. */
export async function sendStaged(input: {
  root: string
  directory: string
  learn: Parameters<typeof RulesSync.run>[2]
  name: string
  staged: Staged
  /** `candidateTexts` before the run: a candidate that existed before is never discarded. */
  before: Set<string> | undefined
}): Promise<{ sent: number; queued: number; refused: number; message: string }> {
  const ids = await RulesSync.enqueueMany(input.root, input.staged.items.map((item) => ({ item })))
  const report = await RulesSync.runFresh(input.root, input.directory, input.learn)
  const state = await RulesStore.read(input.root)
  const outcomes = ids.map((id, index) => RulesSync.outcomeOf(state, report, id, input.staged.items[index].text))
  const queued = outcomes.filter((o) => o.status === "queued").length
  const refused = outcomes.filter((o) => o.status === "sent" && o.row?.error).length
  const sent = outcomes.length - queued - refused
  // The workspace's review queue replaces a candidate this run created, once it holds every rule of it.
  const discard = !input.before && queued === 0 && refused === 0 && input.staged.invalid.length === 0
  if (discard) await Store.reject(input.root, input.name)
  const { owner, name } = input.staged.workspace
  const message = `${sent} ${sent === 1 ? "rule" : "rules"} sent for ${owner}'s review in ${name}` +
    (queued ? `; ${queued} queued until the workspace is reachable` : "") +
    (refused ? `; ${refused} refused by the workspace` : "") + "." +
    (discard ? "" : " The local candidate was kept: `learn show`.")
  return { sent, queued, refused, message }
}

export * as RulesFromHistory from "./from-history"
