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
import { MAX_APPLIES_TO, MAX_GLOB } from "./trigger"

/** The candidate's rule texts before a run, or undefined when there is no candidate. */
export async function candidateTexts(root: string, name: string): Promise<Set<string> | undefined> {
  const candidate = await Store.loadCandidateLessons(root, name)
  return candidate ? new Set(candidate.map((lesson) => lesson.text)) : undefined
}

export interface Staged {
  workspace: { name: string; owner: string }
  /** The account and workspace these were listed for: they are queued only for them. */
  scope: RulesStore.Scope
  /** What would be sent, in order. */
  items: ProposalItem[]
  /** Staged rules that failed the rule lint and stay local only. */
  invalid: { text: string; reason: string }[]
  /** Local rules the run edited or removed: not team proposals, and a reason to keep the candidate. */
  localChanges: number
}

/** What this run staged that is not approved yet, as proposals. Undefined when not linked or nothing is new. */
export async function stagedRules(input: {
  root: string
  name: string
  origin: "bootstrap" | "import_reviews"
  /** `candidateTexts` before the run. */
  before: Set<string> | undefined
  /** The effective learn config: with learning or workspaces off nothing could be sent, so nothing is offered. */
  learn: Parameters<typeof RulesSync.run>[2]
}): Promise<Staged | undefined> {
  if (!RulesSync.rulesEnabled(input.learn)) return undefined
  const state = await RulesStore.read(input.root)
  if (!state.workspace || !state.scope) return undefined
  const [approved, candidate] = await Promise.all([
    Store.loadApproved(input.root, input.name),
    Store.loadCandidateLessons(input.root, input.name),
  ])
  if (!candidate) return undefined
  const known = new Set([...approved.map((lesson) => lesson.text), ...(input.before ?? [])])
  // The candidate starts as a copy of the approved store: a lesson with an approved id is a local rule (edited if its
  // text changed), and an approved id missing from it is a removal. Neither is a new team rule.
  const approvedIds = new Set(approved.map((lesson) => lesson.id))
  const candidateIds = new Set(candidate.map((lesson) => lesson.id))
  const edited = candidate.filter((lesson) => approvedIds.has(lesson.id) && !known.has(lesson.text)).length
  const removed = approved.filter((lesson) => !candidateIds.has(lesson.id)).length
  const items: ProposalItem[] = []
  const invalid: Staged["invalid"] = []
  for (const lesson of candidate) {
    if (known.has(lesson.text) || approvedIds.has(lesson.id)) continue
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
  return {
    workspace: { name: state.workspace.name, owner: state.workspace.owner_name ?? "the workspace owner" },
    scope: state.scope,
    items,
    invalid,
    localChanges: edited + removed,
  }
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
}): Promise<{ sent: number; queued: number; refused: number; lost: number; held: number; message: string }> {
  const { owner, name } = input.staged.workspace
  // Only what the outbox has room for is queued; the rest stays in the local candidate (not sent for review).
  const room = Math.max(0, RulesStore.MAX_OUTBOX - (await RulesStore.read(input.root)).outbox.length)
  const items = input.staged.items.slice(0, room)
  const held = input.staged.items.length - items.length
  const heldNote = held ? `; ${held} not sent: the queue of proposals waiting to be sent is full (${RulesStore.MAX_OUTBOX}), so they stay in the local candidate` : ""
  let ids: string[]
  try {
    ids = await RulesSync.enqueueMany(input.root, items.map((item) => ({ item })), input.staged.scope)
  } catch (error) {
    if (!(error instanceof RulesSync.ScopeChangedError)) throw error
    const message = `Nothing sent: the account or workspace changed since these rules were listed. The local candidate was kept: \`learn show\`.`
    return { sent: 0, queued: 0, refused: 0, lost: 0, held: input.staged.items.length, message }
  }
  // A push sends the oldest batch of the outbox, which can hold older proposals ahead of these: keep sending while these
  // are still queued and each run moves the outbox along. Stops when a run is not ready, keeps something back with an
  // error, or sends nothing; bounded by the batches a full outbox needs.
  let report = await RulesSync.runFresh(input.root, input.directory, input.learn, "import")
  let state = await RulesStore.read(input.root)
  for (let round = 1; round <= Math.ceil(RulesStore.MAX_OUTBOX / RulesSync.MAX_PROPOSALS); round++) {
    const waiting = ids.some((id) => state.outbox.some((entry) => entry.id === id))
    if (!waiting || report.context.status !== "ready" || report.push?.error || !report.push?.sent.length) break
    report = await RulesSync.runFresh(input.root, input.directory, input.learn, "import")
    state = await RulesStore.read(input.root)
  }
  const outcomes = ids.map((id) => RulesSync.outcomeOf(state, report, id))
  const queued = outcomes.filter((o) => o.status === "queued").length
  const refused = outcomes.filter((o) => o.status === "sent" && o.row?.error).length
  const sent = outcomes.filter((o) => o.status === "sent" && o.row && !o.row.error).length
  // Neither queued nor answered: dropped before sending (the account or workspace changed under it).
  const lost = outcomes.length - queued - refused - sent
  // The workspace's review queue replaces a candidate this run created, once it holds every rule of it: only when the
  // candidate is nothing but the adds that were sent (no local edits or removals, nothing invalid, refused or queued).
  const discard = !input.before && queued === 0 && refused === 0 && lost === 0 && held === 0 && input.staged.invalid.length === 0 &&
    input.staged.localChanges === 0
  if (discard) await Store.reject(input.root, input.name)
  // Why some stayed queued, as the run said it: sync not ready (not signed in, link lost …), kept back with an error, or
  // not reached yet behind older proposals.
  const why = report.context.status !== "ready"
    ? report.context.reason
    : report.push?.error ?? "behind older queued proposals"
  const message = `${sent} ${sent === 1 ? "rule" : "rules"} sent for ${owner}'s review in ${name}` +
    (queued ? `; ${queued} kept queued (${why}) and sent on a later sync` : "") +
    (refused ? `; ${refused} refused by the workspace` : "") +
    (lost ? `; ${lost} not sent (${RulesStore.scopeDropNote(state) ?? "the account or workspace changed"})` : "") + heldNote + "." +
    (discard
      ? ""
      : input.staged.localChanges
        ? ` The local candidate was kept: it also changes ${input.staged.localChanges} local ${input.staged.localChanges === 1 ? "rule" : "rules"} (\`learn show\`, \`learn promote\`).`
        : " The local candidate was kept: `learn show`.")
  return { sent, queued, refused, lost, held, message }
}

export * as RulesFromHistory from "./from-history"
