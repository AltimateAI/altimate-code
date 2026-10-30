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
import { RuleClassify } from "./classify"
import { RuleEvents, type ProposalCard } from "./events"
import { RulesStore } from "./store"
import { RulesSync } from "./sync"
import { RulesTelemetry, type AnswerOutcome, type CardTrigger } from "./telemetry"

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
  /** The memory block the agent meant to write (memory tool): Memory saves it under that id and those tags. */
  memory?: { id: string; tags: string[] }
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
  /** What raised the card, and wording edits accepted so far (telemetry). */
  trigger: CardTrigger
  edits: number
  /** The session the evidence came from: the card can move to another session, its evidence does not. */
  sourceSession: string
  memory?: Draft["memory"]
  /** For a card the person asked for: saves it as it would have been saved without a card, when the card closes
   * unanswered (it expired, or its instance went away). Bound to the asking instance. */
  unanswered?: (text: string) => Promise<void>
  /** The account and workspace the card was shown for: a send or approve is queued only for them. */
  scope?: RulesStore.Scope
  /** The request is kept on disk (`RulesStore.RememberRequest`) until the card is answered or its fallback ran. */
  persisted?: boolean
  /** Closed (expired, or its instance went away) while a reply was running: the reply settles it when it ends, then
   * calls `done`, which resolves the promise `close` returned (`drop` waits on it). */
  closed?: { message: string; why: "expired" | "closed"; here: string | undefined; done: () => void }
}

/** An unanswered card lasts a day; after that it is dropped rather than re-offered to every new client. */
export const CARD_TTL_MS = 24 * 60 * 60_000

/** Remove a card no client can answer any more, and tell clients so they stop showing it. Resolves once a requested
 * card is saved: by its fallback, or, for a card whose reply is running, once that reply ended (it saved the card, or
 * failed and the fallback saved it). */
function close(id: string, entry: Pending, message: string, why: "expired" | "closed", here: string | undefined): Promise<void> {
  pending.delete(id)
  if (entry.busy) return new Promise((done) => void (entry.closed = { message, why, here, done }))
  return settle(id, entry, message, why, here)
}

/** What a "remember" card keeps on disk so the request survives the process (`RulesRemember.recoverRequests`). */
export type RequestRecord = Pick<RulesStore.RememberRequest, "session" | "via" | "memory" | "training">

/** A save that can never succeed as asked (the project's memory or training is full, the text is too long): retrying
 * it is pointless, so its request is not kept for recovery. Any other failure is kept and retried. */
export class SaveRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SaveRefusedError"
  }
}

async function persistRequest(entry: Pending, request: RequestRecord) {
  const record: RulesStore.RememberRequest = {
    ...request,
    card: entry.card.id,
    text: entry.card.text,
    directory: entry.directory,
    pid: process.pid,
    boot: RulesStore.PROCESS_BOOT,
    at: new Date().toISOString(),
  }
  // Best effort: the card and its in-memory fallback work without it; only a crash would then lose the request. Never
  // past the limit: a live record is not evicted (`proposeFor` saves without a card when it is full).
  let kept = false
  await RulesStore.update(entry.root, (s) => {
    const others = s.remember_requests.filter((r) => r.card !== record.card)
    if (others.length >= RulesStore.MAX_REMEMBER_REQUESTS) return
    s.remember_requests = [...others, record]
    kept = true
  }).then(
    () => void (entry.persisted = kept),
    (error) => log.warn("remember request not kept on disk", { card: record.card, error }),
  )
}

/** The card was answered, or its request was saved: it no longer needs keeping. Retried, since a record left behind
 * would be saved again by recovery; removing it twice is harmless. */
async function forgetRequest(id: string, entry: Pending) {
  if (!entry.persisted) return
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await RulesStore.update(entry.root, (s) => {
        s.remember_requests = s.remember_requests.filter((r) => r.card !== id)
      })
      entry.persisted = false
      return
    } catch (error) {
      log.warn("remember request not cleared", { id, attempt, error })
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt))
    }
  }
}

/** A closed card nobody answered: save a requested one as before cards, record it, tell its clients. */
async function settle(id: string, entry: Pending, message: string, why: "expired" | "closed", here: string | undefined): Promise<void> {
  // The Bus is per project: announced from another project's request it would reach the wrong clients. The card's own
  // clients then learn it is gone from their next list or reply (`not_open`).
  if (here === entry.directory)
    void publish(RuleEvents.Event.Replied, { id, sessionID: entry.card.sessionID, action: "expired", message })
  // A "remember" the person asked for is saved as it was before cards. That save can still fail: recorded as a failed
  // close. Its kept request is cleared only once saved, or when the save can never succeed (`SaveRefusedError`);
  // after any other failure it stays, and the next process opening the project saves it (`recoverRequests`).
  let refused = false
  const saved = entry.unanswered
    ? await entry.unanswered(entry.card.text).then(() => true, (error) => {
        refused = error instanceof SaveRefusedError
        log.warn("unanswered card not saved", { id, error })
        return false
      })
    : undefined
  if (saved !== false || refused) await forgetRequest(id, entry)
  RulesTelemetry.answered({
    card: entry.card,
    trigger: entry.trigger,
    action: why,
    status: saved === false ? "failed" : "ok",
    ...(saved ? { outcome: "saved_unanswered" as const } : {}),
    edits: entry.edits,
    shownAt: entry.at,
  })
}

/** After a reply that did not close the card: if the card was closed meanwhile, settle it now. */
async function settleIfClosed(id: string, entry: Pending): Promise<ReplyResult | undefined> {
  if (!entry.closed) return undefined
  const { message, why, here, done } = entry.closed
  await settle(id, entry, message, why, here).finally(done)
  return { ok: false, code: "not_open", error: "This proposal is no longer open." }
}

// A client that renders cards (the TUI, the IDE extension) holds a lease for the project it shows: it calls
// `POST /rule-proposal/renderer` (in that project's directory) when it starts and every `RENDERER_RENEW_MS` while it runs.
// While no lease is live for a directory, nothing would show its cards: the save tools save as they did before cards, and
// the after-turn check waits (`rendererAttached`). A client that went away stops renewing, so its lease lapses; one that
// failed to register retries on the next renewal. A lease for one project says nothing about another one served by the
// same process.
export const RENDERER_RENEW_MS = 30_000
export const RENDERER_LEASE_MS = 3 * RENDERER_RENEW_MS
const RENDERERS = Symbol.for("altimate.rules.proposal.renderers")
const renderers = ((globalThis as Record<symbol, unknown>)[RENDERERS] ??= new Map()) as Map<string, number>
const leaseKey = (directory: string, client: string) => `${directory}\0${client}`

/** A client that shows proposal cards holds a live lease for `directory`. */
export function rendererAttached(directory: string, now = Date.now()) {
  let live = false
  for (const [key, until] of renderers) {
    if (until <= now) renderers.delete(key)
    else if (key.startsWith(`${directory}\0`)) live = true
  }
  return live
}

/** `POST /rule-proposal/renderer`: `client` shows cards of `directory` for the next `RENDERER_LEASE_MS`. */
export function renewRenderer(directory: string, client: string, now = Date.now()) {
  renderers.set(leaseKey(directory, client), now + RENDERER_LEASE_MS)
}

/** For tests: a lease for `directory` that never lapses, or none at all. */
export function setRendererForTest(directory: string | undefined) {
  renderers.clear()
  if (directory !== undefined) renderers.set(leaseKey(directory, "test"), Number.MAX_SAFE_INTEGER)
}

/** Drop cards past `CARD_TTL_MS`. `here`: the directory of the request doing it (its project's clients are told). */
function expire(here: string | undefined, now = Date.now()) {
  for (const [id, entry] of pending) if (now - entry.at > CARD_TTL_MS) close(id, entry, "This proposal expired.", "expired", here)
}

/** Drop the cards of a project (its instance is going away; nobody can answer them after that). Resolves once the
 * requested cards among them are saved, so the instance is not torn down under those writes. */
export async function drop(directory: string) {
  const saves: Promise<void>[] = []
  for (const [id, entry] of pending)
    if (entry.directory === directory) saves.push(close(id, entry, "This proposal was closed.", "closed", directory))
  await Promise.allSettled(saves)
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
    ...(draft.choose ? { choose: true, memory_scope: memoryScopeOf(draft.text, draft.memory) } : {}),
    topics: draft.topics.map((t) => t.toLowerCase()),
  }
}

/** Where "Memory" saves: the memory tool's block in its scope (project), otherwise as the wording reads. */
const memoryScopeOf = (text: string, memory: Draft["memory"]) => (memory ? "project" : RuleClassify.memoryScope(text))

/** Show a card for `draft` in `sessionID`. Returns the card, or undefined when its topic was dismissed.
 * `trigger` (telemetry) defaults from the draft's origin. */
export async function ask(input: {
  sessionID: string
  root: string
  directory: string
  learn: Pending["learn"]
  draft: Draft
  trigger?: CardTrigger
  unanswered?: Pending["unanswered"]
  /** With `unanswered`: what to keep on disk, so the request is saved even if this process dies. */
  request?: RequestRecord
}) {
  expire(input.directory)
  const trigger = input.trigger ?? (input.draft.origin === "explicit" ? "remember" : "recurrence")
  const state = await RulesStore.read(input.root)
  if (input.draft.origin === "session" && input.draft.topics.some((topic) => RulesStore.dismissed(state, topic))) {
    if (trigger !== "remember") RulesTelemetry.skipped(input.sessionID, trigger, "topic_dismissed")
    return undefined
  }
  for (const existing of pending.values())
    if (existing.root === input.root && existing.card.text.toLowerCase() === input.draft.text.toLowerCase()) {
      // Asked again: the card moves to the session that asked (clients show cards per session), and a client that
      // missed it gets it back.
      // The latest request's memory block and fallback win, whichever session asked.
      if (input.draft.memory) {
        existing.memory = input.draft.memory
        // The memory tool's block goes to project memory: the card says so.
        if (existing.card.memory_scope) existing.card = { ...existing.card, memory_scope: "project" }
      }
      if (input.unanswered) existing.unanswered = input.unanswered
      if (existing.card.sessionID !== input.sessionID) {
        // The asking session's project directory and config answer it from now on; the evidence keeps its session.
        existing.card = { ...existing.card, sessionID: input.sessionID }
        existing.directory = input.directory
        existing.learn = input.learn
        await publish(RuleEvents.Event.Updated, existing.card)
      } else await publish(RuleEvents.Event.Asked, existing.card)
      if (input.unanswered && input.request) await persistRequest(existing, input.request)
      RulesTelemetry.shown(existing.card, existing.trigger, true)
      return existing.card
    }
  const card = build(randomUUID(), input.sessionID, input.draft, state)
  const entry: Pending = {
    card, root: input.root, directory: input.directory, learn: input.learn, at: Date.now(), trigger, edits: 0,
    sourceSession: input.sessionID, memory: input.draft.memory, unanswered: input.unanswered, scope: state.scope,
  }
  pending.set(card.id, entry)
  if (input.unanswered && input.request) await persistRequest(entry, input.request)
  RulesTelemetry.shown(card, trigger, false)
  await publish(RuleEvents.Event.Asked, card)
  return card
}

/** Open cards, optionally of one project and one session. */
export function list(directory?: string, sessionID?: string): ProposalCard[] {
  expire(directory)
  return [...pending.values()]
    .filter((p) => (!directory || p.directory === directory) && (!sessionID || p.card.sessionID === sessionID))
    .map((p) => p.card)
}

/** A card's actions, plus `approve_anyway`: the confirmed approval of a card that weakens verification. A plain
 * `approve` on such a card is refused (`verification_flagged`), so every client has to ask for the confirmation. */
export type ReplyAction = ProposalCard["actions"][number] | "approve_anyway"
/** Why a reply did not go through, for clients and HTTP status: the card is gone, the request does not fit this
 * card (or another reply is running), a flagged card was approved without confirming, the new wording failed the
 * lint, or the action itself failed. */
export type ReplyFailure = "not_open" | "busy" | "not_available" | "verification_flagged" | "invalid_text" | "refused" | "failed"

/** The workspace refused the proposal's content (a client-side condition, HTTP 422): the card stays open to edit. */
class RefusedError extends Error {}
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
  // Past its day: closed now (a requested one is saved as before cards), not answered.
  if (!entry.busy && Date.now() - entry.at > CARD_TTL_MS) {
    await close(id, entry, "This proposal expired.", "expired", entry.directory)
    return { ok: false, code: "not_open", error: "This proposal expired." }
  }
  const track = (status: "ok" | ReplyFailure, outcome?: AnswerOutcome) => {
    if (status !== "not_open")
      RulesTelemetry.answered({ card: entry.card, trigger: entry.trigger, action: input.action, status, outcome, edits: entry.edits, shownAt: entry.at })
  }
  if (entry.busy) {
    track("busy")
    return { ok: false, code: "busy", error: "This proposal is already being answered.", card: entry.card }
  }
  const { card } = entry
  const offered = input.action === "approve_anyway"
    ? card.actions.includes("approve") && !!card.weakens_verification
    : card.actions.includes(input.action)
  if (!offered) {
    track("not_available")
    return { ok: false, code: "not_available", error: `"${input.action}" is not available for this proposal.`, card }
  }
  if (input.action === "approve" && card.weakens_verification) {
    track("verification_flagged")
    return {
      ok: false,
      code: "verification_flagged",
      error: `This rule ${card.weakens_verification}: confirm with "approve_anyway" to approve it for the whole workspace.`,
      card,
    }
  }

  if (input.action === "edit") {
    const text = (input.text ?? "").trim()
    const problem = editProblem(text)
    if (problem) {
      track("invalid_text")
      return { ok: false, code: "invalid_text", error: `Not changed: the rule ${problem}.`, card }
    }
    const flag = verificationWarning(text)
    const next: ProposalCard = { ...card, text, chars: text.length, weakens_verification: flag }
    if (!flag) delete next.weakens_verification
    entry.busy = true
    try {
      entry.card = next
      entry.edits += 1
      // A kept request saves the wording as it stands (best effort, like keeping it).
      if (entry.persisted)
        await RulesStore.update(entry.root, (s) => {
          for (const r of s.remember_requests) if (r.card === id) r.text = text
        }).catch((error) => log.warn("remember request wording not updated", { id, error }))
      await publish(RuleEvents.Event.Updated, next)
    } finally {
      entry.busy = false
    }
    const gone = await settleIfClosed(id, entry)
    if (gone) return gone
    track("ok")
    return { ok: true, message: "Wording updated.", card: next, closed: false }
  }

  entry.busy = true
  let message: string
  try {
    const done = await act(entry, input.action)
    message = done.message
    track("ok", done.outcome)
  } catch (error) {
    if (error instanceof RulesSync.ScopeChangedError) {
      // Shown for another account or workspace: it is not sent to this one. The card closes; one the person asked for
      // is saved as before cards.
      entry.busy = false
      track("not_open")
      if (entry.closed) return (await settleIfClosed(id, entry))!
      pending.delete(id)
      const message = "The account or workspace changed since this proposal was shown: it was not sent."
      await settle(id, entry, message, "closed", entry.directory)
      return { ok: false, code: "not_open", error: message }
    }
    const code = error instanceof RefusedError ? "refused" : "failed"
    if (code === "failed") log.warn("rule proposal reply failed", { action: input.action, error })
    track(code)
    entry.busy = false
    // Closed while this ran: nothing was saved, so the requested card falls back to saving as before cards.
    return (await settleIfClosed(id, entry)) ?? { ok: false, code, error: `Not done: ${error instanceof Error ? error.message : String(error)}`, card: entry.card }
  } finally {
    entry.busy = false
  }
  pending.delete(id)
  await forgetRequest(id, entry)
  // Closed while this ran: the answer saved it, which is what the close was waiting for.
  entry.closed?.done()
  await publish(RuleEvents.Event.Replied, { id, sessionID: card.sessionID, action: input.action, message })
  await publish(RuleEvents.Event.Changed, { directory: entry.directory })
  return { ok: true, message, closed: true }
}

async function act(entry: Pending, action: Exclude<ReplyAction, "edit">): Promise<{ message: string; outcome: AnswerOutcome }> {
  const { card } = entry
  let message: string
  let outcome: AnswerOutcome
  if (action === "dismiss") {
    outcome = "dismissed"
    const until = new Date(Date.now() + RulesStore.DISMISS_MS).toISOString()
    await RulesStore.update(entry.root, (state) => {
      for (const topic of card.topics) state.dismissed.push({ topic, until })
    })
    message = card.topics.length ? "Not a rule: it won't be proposed again for 30 days." : "Dismissed: nothing was saved."
  } else if (action === "save_memory") {
    const { MemoryStore } = await import("../../memory/store")
    // The scope the card showed. A card from the memory tool saves the block it was writing, in its scope (project):
    // the classifier's guess could put that block id into personal memory and overwrite an unrelated block there.
    const scope = entry.memory ? "project" : (card.memory_scope ?? RuleClassify.memoryScope(card.text))
    const id = entry.memory?.id ?? `notes/${slug(card.text)}`
    const tags = entry.memory?.tags.length ? entry.memory.tags : ["remembered"]
    const now = new Date().toISOString()
    await MemoryStore.write({ id, scope, tags, created: now, updated: now, content: card.text }, { sessionID: entry.sourceSession })
    message = scope === "global" ? "Saved to your memory (all your projects)." : "Saved to this project's memory."
    outcome = scope === "global" ? "saved_memory_global" : "saved_memory_project"
  } else if (action === "save_local") {
    const { TrainingStore } = await import("../training")
    await TrainingStore.save({ kind: "rule", name: slug(card.text), scope: "project", content: card.text, source: "proposed rule", sessionID: entry.sourceSession })
    message = "Saved as a rule for this project."
    outcome = "saved_local"
  } else {
    const approve = action === "approve" || action === "approve_anyway" ? action : undefined
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
        ? [{ excerpt: card.evidence.correction.excerpt, corrected_at: card.evidence.correction.at, session_ref: hashRef(entry.sourceSession) }]
        : [],
    }, approve, entry.scope)
    const report = await RulesSync.runFresh(entry.root, entry.directory, entry.learn, "card").catch(() => undefined)
    const sent = RulesSync.outcomeOf(await RulesStore.read(entry.root), report, outboxId)
    const owner = card.workspace?.owner_name ?? "the workspace owner"
    const ws = card.workspace?.name ?? "the workspace"
    if (sent.status === "queued" && report && report.context.status !== "ready") {
      // Not sent, and not until rules sync is available again (learning or workspaces off, signed out, not linked).
      message = `Kept queued: rules sync is not available (${report.context.reason}); it is sent on a later sync once it is.`
      outcome = "queued"
    } else if (sent.status === "queued") {
      message = sent.error
        ? `Not sent yet (${sent.error}): kept queued and sent again on the next sync.`
        : `Queued: it will be sent to ${owner}'s review queue when the workspace is reachable.`
      outcome = "queued"
    } else if (!sent.row) {
      // Sent by another run whose answer is no longer recorded.
      message = `Sent by another sync: \`/rules\` shows where it stands in ${ws}.`
      outcome = "sent"
    } else if (sent.row?.target_gone) {
      // The rule this card edits or retires changed or was removed since it was shown: resending cannot succeed.
      message = "Not sent: the team rule this changes was edited or removed since. Check `/rules` and propose it again if it still applies."
      outcome = "target_changed"
    } else if (sent.row?.error) {
      // Refused (e.g. an invalid wording): the card stays open so the wording can be edited and sent again.
      throw new RefusedError(`the workspace refused it: ${sent.row.error}`)
    } else if (sent.row?.status === "exists") {
      message = "Already a team rule (or waiting for review): nothing new sent."
      outcome = "exists"
    } else if (sent.row?.approved || sent.sent?.status === "active") {
      message = `Approved: now a team rule in ${ws}.`
      outcome = "approved"
    } else if (sent.row?.approve_error && sent.row.approve_retry) {
      message = `Sent to ${owner}'s review queue in ${ws}. Approving it failed for now (${sent.row.approve_error}); it is retried on the next sync.`
      outcome = "approve_retry"
    } else if (sent.row?.approve_error) {
      message = `Sent to ${owner}'s review queue in ${ws}, but approving it failed (${sent.row.approve_error}). Approve it in the workspace's Rules tab.`
      outcome = "approve_failed"
    } else {
      message = `Sent to ${owner}'s review queue in ${ws}.`
      outcome = "sent"
    }
  }
  return { message, outcome }
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
