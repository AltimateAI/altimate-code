// altimate_change - new file
//
// The proposed-rule card, built once in the session server and rendered by every client (the TUI now, the
// IDE extension later) — the same ask/reply shape as `question`: `ask` publishes `rule.proposal.asked` on the
// Bus wildcard (so it reaches `/event`), the client answers with `POST /rule-proposal/:id/reply`.
//
// The card never blocks the turn. Actions depend on the project:
// - linked, member: send (to the owner's review queue), edit, dismiss ("Not a rule")
// - linked, owner: approve too (send and approve in one step; "approve anyway" when flagged)
// - not linked: save_local (project training, no review), edit, dismiss
import { randomUUID } from "node:crypto"
import { Bus } from "@/bus"
import { Log } from "@/util/log"
import { lint, normalizeText, verificationWarning } from "../learn/curator"
import { redactSecrets } from "../learn/digest"
import { RuleEvents, type ProposalCard } from "./events"
import { RulesStore } from "./store"
import { RulesSync } from "./sync"

const log = Log.create({ service: "rules.proposal" })
export const MAX_EXCERPT = 280

export interface Draft {
  text: string
  applies_to: string[]
  why?: string
  change: "add" | "edit" | "retire"
  replaces?: { public_id: string; text: string; version: number }
  origin: "session" | "explicit"
  evidence: { sessions: number; correction?: { excerpt: string; at: string } }
  topics: string[]
  /** Offer "Save as: Memory · Team rule · Skip": the wording did not say which. */
  choose?: boolean
}

interface Pending {
  card: ProposalCard
  root: string
  directory: string
  learn: { enabled?: boolean } | undefined
}

// Process-global like `question`'s registry: the server routes and the session loop may load this module
// through different import paths in one process.
const REGISTRY = Symbol.for("altimate.rules.proposal.pending")
const pending: Map<string, Pending> = ((globalThis as Record<symbol, unknown>)[REGISTRY] ??= new Map()) as Map<string, Pending>

export const excerpt = (text: string) => {
  const line = redactSecrets(normalizeText(text)).replace(/\s+/g, " ").trim()
  return line.length <= MAX_EXCERPT ? line : line.slice(0, MAX_EXCERPT - 1) + "…"
}

async function publish<T extends (typeof RuleEvents.Event)[keyof typeof RuleEvents.Event]>(def: T, properties: Parameters<typeof Bus.publish<T>>[1]) {
  await Bus.publish(def, properties).catch((error) => log.warn("rule event not published", { type: def.type, error }))
}

function build(id: string, sessionID: string, draft: Draft, state: RulesStore.State): ProposalCard {
  const linked = !!state.scope && !!state.workspace
  const flag = verificationWarning(draft.text)
  const team: ProposalCard["actions"] = linked
    ? [...(state.workspace!.is_owner ? (["approve"] as const) : []), "send"]
    : ["save_local"]
  const actions: ProposalCard["actions"] = draft.choose ? ["save_memory", ...team, "dismiss"] : [...team, "edit", "dismiss"]
  return {
    id,
    sessionID,
    text: draft.text,
    applies_to: draft.applies_to,
    ...(draft.why ? { why: draft.why } : {}),
    change: draft.change,
    ...(draft.replaces ? { replaces: draft.replaces } : {}),
    origin: draft.origin,
    evidence: draft.evidence,
    chars: draft.text.length,
    ...(flag ? { weakens_verification: flag } : {}),
    ...(linked ? { workspace: state.workspace! } : {}),
    actions,
    ...(draft.choose ? { choose: true } : {}),
    topics: draft.topics.map((t) => t.toLowerCase()),
  }
}

/** Show a card for `draft` in `sessionID`. Returns the card, or undefined when its topic was dismissed. */
export async function ask(input: { sessionID: string; root: string; directory: string; learn: Pending["learn"]; draft: Draft }) {
  const state = await RulesStore.read(input.root)
  if (input.draft.origin === "session" && input.draft.topics.some((topic) => RulesStore.dismissed(state, topic))) return undefined
  for (const existing of pending.values())
    if (existing.root === input.root && existing.card.text.toLowerCase() === input.draft.text.toLowerCase()) return existing.card
  const card = build(randomUUID(), input.sessionID, input.draft, state)
  pending.set(card.id, { card, root: input.root, directory: input.directory, learn: input.learn })
  await publish(RuleEvents.Event.Asked, card)
  return card
}

export function list(directory?: string): ProposalCard[] {
  return [...pending.values()].filter((p) => !directory || p.directory === directory).map((p) => p.card)
}

export type ReplyAction = ProposalCard["actions"][number]
export type ReplyResult =
  | { ok: true; message: string; card?: ProposalCard; closed: boolean }
  | { ok: false; error: string; card?: ProposalCard }

/** Lint an edited wording like the curator does for any rule: one line, within the limit, no commands. */
function editProblem(text: string): string | undefined {
  const reason = lint(text)
  if (reason) return reason
  return normalizeText(text).trim() !== text ? "contains hidden or non-normalized characters" : undefined
}

export async function reply(id: string, input: { action: ReplyAction; text?: string }): Promise<ReplyResult> {
  const entry = pending.get(id)
  if (!entry) return { ok: false, error: "This proposal is no longer open." }
  const { card } = entry
  if (!card.actions.includes(input.action)) return { ok: false, error: `"${input.action}" is not available for this proposal.`, card }

  if (input.action === "edit") {
    const text = (input.text ?? "").trim()
    const problem = editProblem(text)
    if (problem) return { ok: false, error: `Not changed: the rule ${problem}.`, card }
    const flag = verificationWarning(text)
    const next: ProposalCard = { ...card, text, chars: text.length, weakens_verification: flag }
    if (!flag) delete next.weakens_verification
    entry.card = next
    await publish(RuleEvents.Event.Updated, next)
    return { ok: true, message: "Wording updated.", card: next, closed: false }
  }

  pending.delete(id)
  let message: string
  if (input.action === "dismiss") {
    const until = new Date(Date.now() + RulesStore.DISMISS_MS).toISOString()
    await RulesStore.update(entry.root, (state) => {
      for (const topic of card.topics) state.dismissed.push({ topic, until })
    })
    message = "Not a rule: it won't be proposed again for 30 days."
  } else if (input.action === "save_memory") {
    const [{ MemoryStore }, { RuleClassify }] = await Promise.all([import("../../memory/store"), import("./classify")])
    const scope = RuleClassify.memoryScope(card.text)
    const id = `notes/${card.text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "note"}`
    const now = new Date().toISOString()
    await MemoryStore.write({ id, scope, tags: ["remembered"], created: now, updated: now, content: card.text })
    message = scope === "global" ? "Saved to your memory (all your projects)." : "Saved to this project's memory."
  } else if (input.action === "save_local") {
    const { TrainingStore } = await import("../training")
    const name = card.text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "rule"
    await TrainingStore.save({ kind: "rule", name, scope: "project", content: card.text, source: "proposed rule" })
    message = "Saved as a rule for this project."
  } else {
    const approve = input.action === "approve" ? (card.weakens_verification ? "approve_anyway" : "approve") : undefined
    await RulesSync.enqueue(entry.root, {
      change: card.change,
      text: card.text,
      applies_to: card.applies_to,
      ...(card.why ? { why: card.why } : {}),
      origin: card.origin,
      ...(card.replaces ? { replaces: card.replaces.public_id, replaces_version: card.replaces.version } : {}),
      evidence_sessions: card.evidence.sessions,
      corrections: card.evidence.correction
        ? [{ excerpt: card.evidence.correction.excerpt, corrected_at: card.evidence.correction.at, session_ref: hashRef(card.sessionID) }]
        : [],
    }, approve)
    const report = await RulesSync.runShared(entry.root, entry.directory, entry.learn).catch(() => undefined)
    const sent = report?.push?.sent.find((s) => s.text === card.text)
    const owner = card.workspace?.owner_name ?? "the workspace owner"
    if (!sent) message = `Queued: it will be sent to ${owner}'s review queue when the workspace is reachable.`
    else if (sent.error) message = `Not sent: ${sent.error}`
    else if (sent.status === "exists") message = "Already a team rule (or waiting for review): nothing new sent."
    else if (sent.approved) message = `Approved: now a team rule in ${card.workspace?.name ?? "the workspace"}.`
    else message = `Sent to ${owner}'s review queue in ${card.workspace?.name ?? "the workspace"}.`
  }
  await publish(RuleEvents.Event.Replied, { id, sessionID: card.sessionID, action: input.action, message })
  await publish(RuleEvents.Event.Changed, { directory: entry.directory })
  return { ok: true, message, closed: true }
}

/** A session reference the server can count without learning the session id. */
function hashRef(sessionID: string) {
  return new Bun.CryptoHasher("sha256").update(sessionID).digest("hex").slice(0, 16)
}

export * as RuleProposal from "./proposal"
