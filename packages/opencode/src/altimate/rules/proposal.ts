// altimate_change - new file
//
// The proposed-rule card, built once in the session server and rendered by every client (the TUI now, the
// IDE extension later) — the same ask/reply shape as `question`: `ask` publishes `rule.proposal.asked` on the
// Bus wildcard (so it reaches `/event`), the client answers with `POST /rule-proposal/:id/reply`.
//
// The card never blocks the turn. Actions depend on the project:
// - linked, member: send (to the owner's review queue), edit, dismiss ("Not a rule")
// - linked, owner: approve instead of send (send and approve in one step; "approve anyway" when flagged): an owner
//   reviewing their own proposal later adds nothing, so the card offers one team action, never both
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
  /** A reply is being carried out: a second one is refused. */
  busy?: boolean
  /** When the card was asked (ms): cards older than `CARD_TTL_MS` are dropped. */
  at: number
}

/** An unanswered card lasts a day; after that it is dropped rather than re-offered to every new client. */
export const CARD_TTL_MS = 24 * 60 * 60_000

/** Remove a card no client can answer any more, and tell clients so they stop showing it. */
function close(id: string, entry: Pending, message: string) {
  pending.delete(id)
  void publish(RuleEvents.Event.Replied, { id, sessionID: entry.card.sessionID, action: "expired", message })
}

function expire(now = Date.now()) {
  for (const [id, entry] of pending) if (now - entry.at > CARD_TTL_MS) close(id, entry, "This proposal expired.")
}

/** Drop the cards of a project (its instance is going away; nobody can answer them after that). */
export function drop(directory: string) {
  for (const [id, entry] of pending) if (entry.directory === directory) close(id, entry, "This proposal was closed.")
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
  // Retiring removes the rule as it stands: there is no wording to edit, and removing a rule weakens nothing.
  const flag = draft.change === "retire" ? undefined : verificationWarning(draft.text)
  const team: ProposalCard["actions"] = linked
    ? [state.workspace!.is_owner ? "approve" : "send"]
    : ["save_local"]
  const actions: ProposalCard["actions"] = draft.choose
    ? ["save_memory", ...team, "dismiss"]
    : [...team, ...(draft.change === "retire" ? [] : (["edit"] as const)), "dismiss"]
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
  expire()
  const state = await RulesStore.read(input.root)
  if (input.draft.origin === "session" && input.draft.topics.some((topic) => RulesStore.dismissed(state, topic))) return undefined
  for (const existing of pending.values())
    if (existing.root === input.root && existing.card.text.toLowerCase() === input.draft.text.toLowerCase()) {
      // Asked again: the card moves to the session that asked (clients show cards per session), and a client that
      // missed it gets it back.
      if (existing.card.sessionID !== input.sessionID) {
        existing.card = { ...existing.card, sessionID: input.sessionID }
        await publish(RuleEvents.Event.Updated, existing.card)
      } else await publish(RuleEvents.Event.Asked, existing.card)
      return existing.card
    }
  const card = build(randomUUID(), input.sessionID, input.draft, state)
  pending.set(card.id, { card, root: input.root, directory: input.directory, learn: input.learn, at: Date.now() })
  await publish(RuleEvents.Event.Asked, card)
  return card
}

/** Open cards, optionally of one project and one session. */
export function list(directory?: string, sessionID?: string): ProposalCard[] {
  expire()
  return [...pending.values()]
    .filter((p) => (!directory || p.directory === directory) && (!sessionID || p.card.sessionID === sessionID))
    .map((p) => p.card)
}

export type ReplyAction = ProposalCard["actions"][number]
/** Why a reply did not go through, for clients and HTTP status: the card is gone, the request does not fit this
 * card (or another reply is running), the new wording failed the lint, or the action itself failed. */
export type ReplyFailure = "not_open" | "busy" | "not_available" | "invalid_text" | "failed"
export type ReplyResult =
  | { ok: true; message: string; card?: ProposalCard; closed: boolean }
  | { ok: false; code: ReplyFailure; error: string; card?: ProposalCard }

/** Lint an edited wording like the curator does for any rule: one line, within the limit, no commands. */
function editProblem(text: string): string | undefined {
  const reason = lint(text)
  if (reason) return reason
  return normalizeText(text).trim() !== text ? "contains hidden or non-normalized characters" : undefined
}

/** A memory or training name for a rule: a readable prefix and a hash of the whole text, so two rules that
 * start alike do not overwrite each other. */
export function slug(text: string): string {
  const prefix = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/^-+|-+$/g, "")
  const hash = new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 8)
  return prefix ? `${prefix}-${hash}` : hash
}

/** Answer card `id`. With `directory`, only a card of that project is answered. The card stays open until the
 * chosen action succeeds. */
export async function reply(id: string, input: { action: ReplyAction; text?: string }, directory?: string): Promise<ReplyResult> {
  const entry = pending.get(id)
  if (!entry || (directory !== undefined && entry.directory !== directory))
    return { ok: false, code: "not_open", error: "This proposal is no longer open." }
  if (entry.busy) return { ok: false, code: "busy", error: "This proposal is already being answered.", card: entry.card }
  const { card } = entry
  if (!card.actions.includes(input.action))
    return { ok: false, code: "not_available", error: `"${input.action}" is not available for this proposal.`, card }

  if (input.action === "edit") {
    const text = (input.text ?? "").trim()
    const problem = editProblem(text)
    if (problem) return { ok: false, code: "invalid_text", error: `Not changed: the rule ${problem}.`, card }
    const flag = verificationWarning(text)
    const next: ProposalCard = { ...card, text, chars: text.length, weakens_verification: flag }
    if (!flag) delete next.weakens_verification
    entry.busy = true
    try {
      entry.card = next
      await publish(RuleEvents.Event.Updated, next)
    } finally {
      entry.busy = false
    }
    return { ok: true, message: "Wording updated.", card: next, closed: false }
  }

  entry.busy = true
  let message: string
  try {
    message = await act(entry, input.action)
  } catch (error) {
    log.warn("rule proposal reply failed", { action: input.action, error })
    return { ok: false, code: "failed", error: `Not done: ${error instanceof Error ? error.message : String(error)}`, card: entry.card }
  } finally {
    entry.busy = false
  }
  pending.delete(id)
  await publish(RuleEvents.Event.Replied, { id, sessionID: card.sessionID, action: input.action, message })
  await publish(RuleEvents.Event.Changed, { directory: entry.directory })
  return { ok: true, message, closed: true }
}

async function act(entry: Pending, action: Exclude<ReplyAction, "edit">): Promise<string> {
  const { card } = entry
  let message: string
  if (action === "dismiss") {
    const until = new Date(Date.now() + RulesStore.DISMISS_MS).toISOString()
    await RulesStore.update(entry.root, (state) => {
      for (const topic of card.topics) state.dismissed.push({ topic, until })
    })
    message = card.topics.length ? "Not a rule: it won't be proposed again for 30 days." : "Dismissed: nothing was saved."
  } else if (action === "save_memory") {
    const [{ MemoryStore }, { RuleClassify }] = await Promise.all([import("../../memory/store"), import("./classify")])
    const scope = RuleClassify.memoryScope(card.text)
    const id = `notes/${slug(card.text)}`
    const now = new Date().toISOString()
    await MemoryStore.write({ id, scope, tags: ["remembered"], created: now, updated: now, content: card.text })
    message = scope === "global" ? "Saved to your memory (all your projects)." : "Saved to this project's memory."
  } else if (action === "save_local") {
    const { TrainingStore } = await import("../training")
    await TrainingStore.save({ kind: "rule", name: slug(card.text), scope: "project", content: card.text, source: "proposed rule" })
    message = "Saved as a rule for this project."
  } else {
    const approve = action === "approve" ? (card.weakens_verification ? "approve_anyway" : "approve") : undefined
    // The workspace decides whether the person's words travel with a proposal: without quotes, `why` (which can
    // paraphrase the correction) is replaced by a neutral line too.
    const quotes = (await RulesStore.read(entry.root)).settings?.include_quotes !== false
    const why = card.why ? (quotes ? redactSecrets(card.why) : neutralWhy(card)) : undefined
    const outboxId = await RulesSync.enqueue(entry.root, {
      change: card.change,
      text: card.text,
      applies_to: card.applies_to,
      ...(why ? { why } : {}),
      origin: card.origin,
      ...(card.replaces ? { replaces: card.replaces.public_id, replaces_version: card.replaces.version } : {}),
      evidence_sessions: card.evidence.sessions,
      corrections: card.evidence.correction && quotes
        ? [{ excerpt: card.evidence.correction.excerpt, corrected_at: card.evidence.correction.at, session_ref: hashRef(card.sessionID) }]
        : [],
    }, approve)
    const report = await RulesSync.runFresh(entry.root, entry.directory, entry.learn).catch(() => undefined)
    const outcome = RulesSync.outcomeOf(await RulesStore.read(entry.root), report, outboxId, card.text)
    const owner = card.workspace?.owner_name ?? "the workspace owner"
    const ws = card.workspace?.name ?? "the workspace"
    if (outcome.status === "queued") {
      message = `Queued: it will be sent to ${owner}'s review queue when the workspace is reachable.`
    } else if (outcome.row?.error) {
      // Refused (e.g. an invalid wording): the card stays open so the wording can be edited and sent again.
      throw new Error(`not sent: ${outcome.row.error}`)
    } else if (outcome.row?.status === "exists") {
      message = "Already a team rule (or waiting for review): nothing new sent."
    } else if (outcome.row?.approved || outcome.sent?.status === "active") {
      message = `Approved: now a team rule in ${ws}.`
    } else if (outcome.row?.approve_error) {
      message = `Sent to ${owner}'s review queue in ${ws}, but approving it failed (${outcome.row.approve_error}). Approve it in the workspace's Rules tab.`
    } else {
      message = `Sent to ${owner}'s review queue in ${ws}.`
    }
  }
  return message
}

/** `why` without the drafter's wording, for a workspace that keeps the person's words out of proposals. */
function neutralWhy(card: ProposalCard): string {
  if (card.origin === "explicit") return "Asked to remember this"
  if (card.change !== "add") return "Corrected after the rule was shown"
  return card.evidence.sessions > 1 ? `Corrected in ${card.evidence.sessions} sessions` : "Corrected in a session"
}

/** A session reference the server can count without learning the session id. */
function hashRef(sessionID: string) {
  return new Bun.CryptoHasher("sha256").update(sessionID).digest("hex").slice(0, 16)
}

export * as RuleProposal from "./proposal"
