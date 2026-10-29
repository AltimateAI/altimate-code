// altimate_change - new file
//
// Workspace rules sync for a linked project:
//
// - Pull (`POST /rules/sync`): the approved rules for this repository into the `workspace-rules` store mirror, the
//   workspace settings, and this person's proposals the owner reviewed since the last pull. Each review
//   becomes a notice (`rule.proposal.reviewed`): "approved", or "rejected" with the owner's reason.
// - Push: the outbox of proposals the person sent from a card (or bootstrap), then "Approve now" for an
//   owner who chose it. Offline-safe: an unsent proposal stays queued for the next run, across key rotations and
//   sign-ins of the same person (the scope is the user, not the key). One sender per checkout across processes.
// - Usage: per rule version, the sessions it was delivered in (`applied`, each session once) and sessions where the
//   person corrected the same topic after it was shown (`corrected_again`, from recurrence).
//
// Timing: a pull at session start (bounded wait), then every `REFRESH_MS` in the background, plus
// "Sync now". Never throws to an automatic caller: failures are recorded and reported.
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import { Log } from "@/util/log"
import { Flock } from "@opencode-ai/core/util/flock"
import { learnEnabled } from "../learn/config"
import * as SafeFS from "../learn/safe-fs"
import type { ActAs } from "../workspace/api-client"
import { Bus } from "@/bus"
import { RulesApi, RulesApiError, type ProposalItem, type ProposalResult } from "./api"
import { RuleEvents } from "./events"
import { RulesStore, type Scope, type State } from "./store"
import { RulesTelemetry, type SyncTrigger } from "./telemetry"

const log = Log.create({ service: "rules.sync" })
export const REFRESH_MS = 5 * 60_000
export const SESSION_WAIT_MS = 2_000
export const MAX_PROPOSALS = 50
const MAX_USAGE_DELTA = 50
/** The server's per-batch limit on usage items (`MAX_USAGE_ITEMS`). */
const MAX_USAGE_ITEMS = 500

type LearnConfig = { enabled?: boolean } | undefined

/** `code`: a stable value for telemetry; `reason` is for people. */
export type Context =
  | { status: "off"; code: "learning_off"; reason: string }
  | { status: "skipped"; code: SkipCode; reason: string; unlinked?: boolean }
  | { status: "ready"; scope: Scope; actAs: ActAs }

type SkipCode = "not_signed_in" | "not_linked" | "link_unconfirmed" | "no_remote" | "account_changed" | "account_unconfirmed"

/** The signed-in user per credential digest, for this process: one `GET /users/me` per key, not per run. */
const principals = new Map<string, string>()

/** Rules need learning on and workspaces on. */
export function rulesEnabled(learn: LearnConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  const disabled = env["ALTIMATE_DISABLE_WORKSPACE"]?.trim().toLowerCase()
  return learnEnabled(learn, env) && (disabled === undefined || disabled === "" || disabled === "0" || disabled === "false")
}

/** Resolve the gate and scope. Binding resolution may ask the server; never call this under the learn lock. */
export async function context(directory: string, learn: LearnConfig): Promise<Context> {
  if (!rulesEnabled(learn)) return { status: "off", code: "learning_off", reason: "learning or workspaces are turned off" }
  const [{ WorkspaceApi }, { resolveBindingOutcome, credentialDigest, accountDigest }] = await Promise.all([
    import("../workspace/api-client"),
    import("../workspace/state"),
  ])
  const actAs = await WorkspaceApi.captureCredentials()
  if (!actAs) return { status: "skipped", code: "not_signed_in", reason: "not signed in to Altimate" }
  const outcome = await resolveBindingOutcome(directory).catch(() => ({ status: "unknown" as const }))
  if (outcome.status === "unbound") return { status: "skipped", code: "not_linked", reason: "this project is not linked to a workspace", unlinked: true }
  if (outcome.status !== "bound") return { status: "skipped", code: "link_unconfirmed", reason: "the workspace link could not be confirmed" }
  if (!outcome.binding.repoRemote) return { status: "skipped", code: "no_remote", reason: "this project has no git remote" }
  const digest = credentialDigest(actAs.url, actAs.instance, actAs.apiKey)
  // The binding was resolved with the ambient credential: it must still be the captured one.
  if ((await accountDigest()) !== digest) return { status: "skipped", code: "account_changed", reason: "the Altimate account changed" }
  // Queued state belongs to a person, not to a key: rotating the key or signing in again keeps it, another user on
  // the same tenant does not. Unknown for now (the server did not answer): skipped, nothing reset.
  let account = principals.get(digest)
  if (!account) {
    const id = await WorkspaceApi.whoami(actAs).catch(() => undefined)
    if (id === undefined) return { status: "skipped", code: "account_unconfirmed", reason: "the Altimate account could not be confirmed" }
    account = `user:${id}`
    principals.set(digest, account)
  }
  return {
    status: "ready",
    actAs,
    scope: {
      apiUrl: actAs.url.replace(/\/+$/, ""),
      tenant: actAs.instance,
      account,
      datamateId: outcome.binding.datamateId,
      repoRemote: outcome.binding.repoRemote,
    },
  }
}

type Ready = Extract<Context, { status: "ready" }>

export interface PullResult {
  ok: boolean
  error?: string
  rules: number
  pending: number
  notices: State["notices"]
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** State pulled for another account, workspace or remote is dropped, outbox included: it never reaches this scope.
 * Decided and done in one locked write, so a proposal queued meanwhile is counted, never lost unsaid. */
export async function adopt(root: string, ctx: Ready): Promise<{ state: State; same: boolean }> {
  const state = await RulesStore.read(root)
  if (!state.scope || RulesStore.sameScope(state.scope, ctx.scope)) return { state, same: !!state.scope }
  let changed = false
  const after = await RulesStore.update(root, (s) => {
    if (!s.scope || RulesStore.sameScope(s.scope, ctx.scope)) return
    changed = true
    const dropped = s.outbox.length
    // The state now belongs to this scope: a run still finishing for the old one does not write into it (`pushLocked`).
    const next: State = { ...RulesStore.cleared(s), scope: ctx.scope }
    // Said, not silent: the person was told these were queued.
    if (dropped) next.scope_drop = { count: dropped, at: new Date().toISOString() }
    return next
  })
  return { state: after, same: !changed }
}

export async function pull(root: string, ctx: Ready): Promise<PullResult> {
  const { state: before, same } = await adopt(root, ctx)
  try {
    const response = await RulesApi.sync(ctx.actAs, ctx.scope.datamateId, {
      repo_remote: ctx.scope.repoRemote,
      ...(same && before.revision !== undefined ? { known_revision: before.revision } : {}),
      ...(same && before.cursor ? { reviewed_since: before.cursor } : {}),
    })
    const fresh: State["notices"] = []
    const state = await RulesStore.update(root, (state) => {
      state.scope = ctx.scope
      state.workspace = { name: response.workspace_name, owner_name: response.owner_name ?? null, is_owner: response.is_owner }
      state.settings = response.settings
      // A rule this version could not read was skipped: without the revision, the next pull fetches the full list
      // (a known revision would answer `unchanged` and the rule would stay missing).
      state.revision = response.skipped ? undefined : response.revision
      state.cursor = response.cursor
      state.pending_count = response.pending_count
      state.pulled_at = new Date().toISOString()
      state.last_error = response.skipped
        ? `${response.skipped} team ${response.skipped === 1 ? "rule" : "rules"} could not be read by this version of altimate-code; update it to get them`
        : undefined
      if (!response.unchanged) state.rules = response.rules
      for (const reviewed of response.my_reviewed) {
        if (state.notices.some((n) => n.public_id === reviewed.public_id && n.status === reviewed.status)) continue
        const notice = {
          public_id: reviewed.public_id,
          status: reviewed.status,
          text: reviewed.text,
          ...(reviewed.review_reason ? { reason: reviewed.review_reason } : {}),
          ...(reviewed.reviewed_by_name ? { reviewer: reviewed.reviewed_by_name } : {}),
          at: reviewed.reviewed_at ?? reviewed.updated_at,
        }
        state.notices.push(notice)
        fresh.push(notice)
        const sent = state.sent.find((s) => s.public_id === reviewed.public_id)
        if (sent) Object.assign(sent, { status: reviewed.status, reason: notice.reason, reviewer: notice.reviewer, updated_at: notice.at })
      }
    })
    return { ok: true, rules: state.rules.length, pending: state.pending_count, notices: fresh }
  } catch (error) {
    if (error instanceof RulesApiError && (error.kind === "workspace_not_found" || error.kind === "repo_not_bound" || error.kind === "forbidden")) {
      // The link is gone or access was taken away: stop delivering its rules. Queued proposals stay (same scope).
      await RulesStore.reset(root, { keepOutbox: true })
    } else {
      await RulesStore.update(root, (state) => { state.last_error = errorText(error) })
    }
    log.warn("rules pull failed", { error: errorText(error) })
    return { ok: false, error: errorText(error), rules: before.rules.length, pending: before.pending_count, notices: [] }
  }
}

export interface PushResult {
  sent: {
    /** The outbox entry this answers. */
    id: string
    text: string
    status: string
    public_id?: string
    /** Not stored: the server refused it, or answered with a non-storing status. */
    error?: string
    approved?: boolean
    /** Stored for review, but "Approve now" failed (e.g. verification_flagged). */
    approve_error?: string
    /** "Approve now" failed for a passing reason: it is retried on the next push. */
    approve_retry?: boolean
    /** The server's code for a refused item. */
    error_code?: string
    /** Refused because the rule an edit or retire was against changed or is gone: resending cannot succeed. */
    target_gone?: boolean
  }[]
  queued: number
  /** Proposals that were not sent (kept queued). */
  error?: string
  /** A retried "Approve now" failed (the proposals themselves may all have been sent). */
  approval_error?: string
}

type OutboxEntry = State["outbox"][number]
type Outcome = { entry: OutboxEntry; result?: ProposalResult; error?: RulesApiError }

/** Send `entries`. A batch the server refused outright is retried one item at a time, so one bad item
 * cannot hold back the rest. */
async function send(ctx: Ready, entries: OutboxEntry[], split = true): Promise<Outcome[]> {
  try {
    const results = await RulesApi.propose(ctx.actAs, ctx.scope.datamateId, {
      repo_remote: ctx.scope.repoRemote,
      items: entries.map((entry) => entry.item as ProposalItem),
    })
    const byIndex = new Map(results.map((result) => [result.index, result]))
    return entries.map((entry, index) => ({ entry, result: byIndex.get(index) }))
  } catch (error) {
    const failure = error instanceof RulesApiError ? error : RulesApi.classify(error)
    // Only a refusal of the content splits the batch. Scope and credential failures (`repo_not_bound`,
    // `workspace_not_found`, `forbidden`, `auth`, `unsupported`) are about the request: every item stays queued.
    if (split && entries.length > 1 && (failure.kind === "rejected" || uncodedContent(failure))) {
      const outcomes: Outcome[] = []
      for (const entry of entries) outcomes.push(...(await send(ctx, [entry])))
      if (failure.kind === "rejected") return outcomes
      // An uncoded 400/422 (e.g. a schema validation array) can be one item or the whole request: items that fail
      // alone, while others go through, are refused; when every item fails alike, it is the request and all stay queued.
      const alone = outcomes.filter((outcome) => outcome.error && uncodedContent(outcome.error))
      if (alone.length === outcomes.length) return entries.map((entry) => ({ entry, error: failure }))
      return outcomes.map((outcome) =>
        outcome.error && uncodedContent(outcome.error)
          ? { entry: outcome.entry, error: new RulesApiError("rejected", outcome.error.message, outcome.error.code, outcome.error.status) }
          : outcome)
    }
    return entries.map((entry) => ({ entry, error: failure }))
  }
}

/** A 400/422 without a code, which `classify` keeps `transient`: maybe about one item, maybe the whole request. */
const uncodedContent = (failure: RulesApiError) =>
  failure.kind === "transient" && !failure.code && (failure.status === 400 || failure.status === 422)

/** Per-item answers that leave nothing stored for the person: the rule an edit was against changed or went away. */
const TARGET_GONE = new Set(["target_changed", "target_not_found"])

/** A failed "Approve now" worth retrying: the moment or the credential, not a decision about the rule. */
const retryableApproval = (error: unknown) => {
  const kind = error instanceof RulesApiError ? error.kind : RulesApi.classify(error).kind
  return kind === "transient" || kind === "auth"
}
const MAX_APPROVAL_ATTEMPTS = 5
const MAX_PUSH_OUTCOMES = 200

/** Per-item answers that are about now, not about the proposal: it stays queued and is sent again later. */
const RETRY_LATER = new Set(["too_many_pending"])

/** Per project, the outbox (ids) whose items all failed alike, one by one, after an uncoded 400/422 of the whole batch:
 * the request itself is refused. Until the outbox changes it is sent as one batch, not split again on every refresh. */
const refusedWhole = new Map<string, string>()

/** `RulesStore.update`, tried again when the learn lock is busy: what it records was already sent. */
async function record(root: string, change: (state: State) => State | void): Promise<State> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await RulesStore.update(root, change)
    } catch (error) {
      if (attempt >= RECORD_ATTEMPTS) throw error
      log.warn("rules state busy; recording again", { attempt, error: errorText(error) })
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
    }
  }
}
const RECORD_ATTEMPTS = 3

/**
 * Send the outbox. An item leaves it once the server answered for it, or refused it (`rejected`, reported
 * as an error); a transient failure, or no answer for that item, keeps it queued.
 */
export async function push(root: string, ctx: Ready): Promise<PushResult> {
  // One sender per checkout across processes (the TUI's timer, a second TUI, `learn sync`): the per-process `inflight`
  // cannot stop two of them from reading the same outbox and posting it twice. A run that finds another one sending
  // waits for it; the outcome it recorded per outbox id then answers this run's card.
  await SafeFS.mkdir(root, RulesStore.dir(root))
  try {
    return await Flock.withLock("rules-push", () => pushLocked(root, ctx), {
      dir: RulesStore.dir(root),
      staleMs: 60_000,
      timeoutMs: PUSH_LOCK_WAIT_MS,
    })
  } catch (error) {
    if (!/Timed out waiting for lock/.test(errorText(error))) throw error
    const queued = (await RulesStore.read(root)).outbox.length
    return { sent: [], queued, ...(queued ? { error: "another sync is still sending proposals" } : {}) }
  }
}

const PUSH_LOCK_WAIT_MS = 30_000

async function pushLocked(root: string, ctx: Ready): Promise<PushResult> {
  const state = await RulesStore.read(root)
  // The state was taken over by another account or workspace since this run started: none of it is this run's to send.
  if (state.scope && !RulesStore.sameScope(state.scope, ctx.scope)) return { sent: [], queued: 0 }
  const batch = state.outbox.slice(0, MAX_PROPOSALS)
  const retried = await retryApprovals(root, ctx, state.pending_approvals)
  if (!batch.length) return { sent: [], queued: 0, ...(retried ? { approval_error: retried } : {}) }
  const signature = batch.map((entry) => entry.id).join(",")
  const outcomes = await send(ctx, batch, refusedWhole.get(root) !== signature)
  if (batch.length > 1 && outcomes.every((outcome) => outcome.error && uncodedContent(outcome.error))) refusedWhole.set(root, signature)
  else refusedWhole.delete(root)
  const sent: PushResult["sent"] = []
  const approvals: { entry: OutboxEntry; publicId: string; version: number }[] = []
  const done = new Set<string>()
  const failed = new Map<string, string>()
  for (const { entry, result, error } of outcomes) {
    if (error) {
      // Only a refusal of this item leaves the outbox. An item that failed alone in a split batch already arrives as
      // `rejected`; anything else (a request-level failure, an uncoded 400/422 nobody can pin on one item) stays
      // queued with its error, which the card, `/rules` and `learn status` show.
      if (error.kind === "rejected") {
        done.add(entry.id)
        sent.push({ id: entry.id, text: entry.item.text, status: "rejected", error: error.message })
      } else failed.set(entry.id, error.message)
      continue
    }
    if (!result) {
      failed.set(entry.id, "no result from the server")
      continue
    }
    if (result.error_code && RETRY_LATER.has(result.error_code)) {
      failed.set(entry.id, result.error_detail ?? result.error_code)
      continue
    }
    done.add(entry.id)
    const ok = result.status === "pending" || result.status === "exists" || result.duplicate
    sent.push({
      id: entry.id,
      text: entry.item.text,
      status: result.status,
      // A refused item's `public_id` is not the person's proposal (a `stale` edit carries its target's).
      ...(ok && result.public_id ? { public_id: result.public_id } : {}),
      ...(!ok ? { error: result.error_detail ?? result.error_code ?? result.status } : {}),
      ...(!ok && result.error_code ? { error_code: result.error_code } : {}),
      ...(!ok && result.error_code && TARGET_GONE.has(result.error_code) ? { target_gone: true } : {}),
    })
    if (entry.approve && result.status === "pending" && result.public_id && result.version)
      approvals.push({ entry, publicId: result.public_id, version: result.version })
  }
  // Recorded before any "Approve now": what was sent leaves the outbox even if an approval or a later write fails.
  const now = new Date().toISOString()
  let foreign = false
  const after = await record(root, (s) => {
    if (s.scope && !RulesStore.sameScope(s.scope, ctx.scope)) return void (foreign = true)
    s.outbox = s.outbox.filter((entry) => !done.has(entry.id))
    for (const entry of s.outbox) {
      const error = failed.get(entry.id)
      if (error === undefined) continue
      entry.attempts += 1
      entry.last_error = error
    }
    recordOutcomes(s, sent)
    for (const row of sent) {
      if (!row.public_id || row.status === "exists") continue
      const existing = s.sent.find((x) => x.public_id === row.public_id)
      const change = batch.find((b) => b.id === row.id)?.item.change ?? "add"
      if (existing) Object.assign(existing, { status: row.status, updated_at: now })
      else s.sent.push({ public_id: row.public_id, text: row.text, change, status: row.status, sent_at: now, updated_at: now })
      if (row.status === "pending") s.pending_count += 1
    }
  })
  if (foreign) {
    log.warn("rules state changed scope while proposals were sent; their answers were not recorded")
    return { sent: [], queued: after.outbox.length }
  }
  const pendingApprovals: RulesStore.State["pending_approvals"] = []
  for (const approval of approvals) {
    const row = sent.find((s) => s.public_id === approval.publicId)
    try {
      const reviewed = await RulesApi.review(ctx.actAs, ctx.scope.datamateId, approval.publicId, {
        action: approval.entry.approve!,
        expected_version: approval.version,
      })
      if (row) Object.assign(row, { status: reviewed.status, approved: true })
    } catch (error) {
      if (row) row.approve_error = errorText(error)
      if (retryableApproval(error)) {
        if (row) row.approve_retry = true
        pendingApprovals.push({ public_id: approval.publicId, version: approval.version, action: approval.entry.approve!, attempts: 1 })
      }
    }
  }
  if (approvals.length)
    await record(root, (s) => {
      if (s.scope && !RulesStore.sameScope(s.scope, ctx.scope)) return
      for (const approval of pendingApprovals)
        if (!s.pending_approvals.some((p) => p.public_id === approval.public_id)) s.pending_approvals.push(approval)
      const answered = sent.filter((row) => approvals.some((a) => a.publicId === row.public_id))
      recordOutcomes(s, answered)
      for (const row of answered) {
        const existing = s.sent.find((x) => x.public_id === row.public_id)
        if (!existing || existing.status === row.status) continue
        if (existing.status === "pending") s.pending_count = Math.max(0, s.pending_count - 1)
        Object.assign(existing, { status: row.status, updated_at: now })
      }
    })
  const error = failed.size ? [...failed.values()][0] : undefined
  return { sent, queued: after.outbox.length, ...(error ? { error } : {}), ...(retried ? { approval_error: retried } : {}) }
}

/** Keep each row's answer per outbox id (capped), for a card whose proposal another run sent. */
function recordOutcomes(s: State, rows: PushResult["sent"]) {
  for (const row of rows) s.push_outcomes[row.id] = toRecorded(row)
  const ids = Object.keys(s.push_outcomes)
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_PUSH_OUTCOMES))) delete s.push_outcomes[id]
}

/**
 * Retry "Approve now" calls that failed for a passing reason. One that succeeds, or is refused for good (the rule
 * changed, is flagged, the person is no longer the owner), leaves the list; a refusal is recorded on the person's
 * proposal so `/rules` shows it. Gives up after `MAX_APPROVAL_ATTEMPTS`. Returns the last error, if any.
 */
async function retryApprovals(root: string, ctx: Ready, pending: RulesStore.State["pending_approvals"]): Promise<string | undefined> {
  if (!pending.length) return undefined
  const settled = new Map<string, { status?: string; reason?: string }>()
  const retry = new Map<string, number>()
  let last: string | undefined
  for (const approval of pending) {
    try {
      const reviewed = await RulesApi.review(ctx.actAs, ctx.scope.datamateId, approval.public_id, {
        action: approval.action,
        expected_version: approval.version,
      })
      settled.set(approval.public_id, { status: reviewed.status })
    } catch (error) {
      last = `approving a proposal failed: ${errorText(error)}`
      if (retryableApproval(error) && approval.attempts + 1 < MAX_APPROVAL_ATTEMPTS) retry.set(approval.public_id, approval.attempts + 1)
      else settled.set(approval.public_id, { reason: `"Approve now" failed: ${errorText(error)}. Approve it in the workspace's Rules tab.` })
    }
  }
  const now = new Date().toISOString()
  await RulesStore.update(root, (s) => {
    s.pending_approvals = s.pending_approvals.flatMap((p) => {
      if (settled.has(p.public_id)) return []
      const attempts = retry.get(p.public_id)
      return [attempts === undefined ? p : { ...p, attempts }]
    })
    for (const [publicId, outcome] of settled) {
      const row = s.sent.find((x) => x.public_id === publicId)
      if (!row) continue
      if (outcome.status) Object.assign(row, { status: outcome.status, updated_at: now })
      if (outcome.reason) Object.assign(row, { reason: outcome.reason, updated_at: now })
    }
  })
  return last
}

type SentRow = PushResult["sent"][number]
type Recorded = State["push_outcomes"][string]

/** A push answer as kept per outbox id, and back: the two directions in one place so they cannot drift. */
function toRecorded(row: SentRow): Recorded {
  return {
    status: row.status,
    ...(row.public_id ? { public_id: row.public_id } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.error_code ? { error_code: row.error_code } : {}),
    ...(row.approved ? { approved: true } : {}),
    ...(row.approve_error ? { approve_error: row.approve_error } : {}),
    ...(row.approve_retry ? { approve_retry: true } : {}),
  }
}

function fromRecorded(id: string, recorded: Recorded): SentRow {
  return {
    id,
    text: "",
    ...recorded,
    ...(recorded.error_code && TARGET_GONE.has(recorded.error_code) ? { target_gone: true } : {}),
  }
}

/** Queue proposals for the next push, in one write. Returns their outbox ids, in order. Refuses past `MAX_OUTBOX`. */
export async function enqueueMany(root: string, items: readonly { item: ProposalItem; approve?: "approve" | "approve_anyway" }[]): Promise<string[]> {
  const ids = items.map(() => randomUUID())
  const at = new Date().toISOString()
  await RulesStore.update(root, (state) => {
    if (state.outbox.length + items.length > RulesStore.MAX_OUTBOX)
      throw new Error(
        items.length > RulesStore.MAX_OUTBOX
          ? `${items.length} proposals are more than can wait to be sent at once (${RulesStore.MAX_OUTBOX}); send fewer`
          : `${state.outbox.length} proposals are already waiting to be sent, and ${items.length} more would pass the limit of ${RulesStore.MAX_OUTBOX}; sync before proposing more`,
      )
    items.forEach(({ item, approve }, index) =>
      state.outbox.push({ id: ids[index], created_at: at, attempts: 0, item, ...(approve ? { approve } : {}) }))
  })
  return ids
}

/** Queue one proposal; it is sent by the next push. Returns its outbox id. */
export async function enqueue(root: string, item: ProposalItem, approve?: "approve" | "approve_anyway"): Promise<string> {
  return (await enqueueMany(root, [{ item, ...(approve ? { approve } : {}) }]))[0]
}

/**
 * Where an enqueued proposal stands after a run: still queued, or sent with the server's answer. Looked up by outbox
 * id: this run's report first, then the outcome another run (the timer, a session start, `learn sync`) recorded. Never
 * by text, which an older proposal can share.
 */
export function outcomeOf(state: State, report: RunReport | undefined, outboxId: string):
  | { status: "queued"; error?: string }
  | { status: "sent"; row: PushResult["sent"][number] | undefined; sent?: State["sent"][number] } {
  const queued = state.outbox.find((entry) => entry.id === outboxId)
  if (queued) return { status: "queued", ...(queued.last_error ? { error: queued.last_error } : {}) }
  const recorded = state.push_outcomes[outboxId]
  const row = report?.push?.sent.find((s) => s.id === outboxId) ?? (recorded ? fromRecorded(outboxId, recorded) : undefined)
  return { status: "sent", row, sent: row?.public_id ? state.sent.find((s) => s.public_id === row.public_id) : undefined }
}

type PendingUsage = NonNullable<State["pending_usage"]>

/** A usage refusal that resending the same batch cannot fix. */
function permanentUsageFailure(error: unknown) {
  const failure = error instanceof RulesApiError ? error : RulesApi.classify(error)
  return failure.kind === "rejected" || failure.kind === "conflict" || (failure.status === 404 && failure.kind !== "unsupported" && failure.kind !== "workspace_not_found")
}

/** Send one batch; on success advance the reported state and clear it from `pending_usage`. */
async function sendUsage(root: string, ctx: Ready, batch: PendingUsage): Promise<void> {
  await RulesApi.usage(ctx.actAs, ctx.scope.datamateId, { batch_id: batch.batch_id, items: batch.items })
  await markReported(root, batch)
}

/** A batch is done (acknowledged, or refused for good): its pairs and corrections count as reported, and it leaves
 * `pending_usage`. The one place that decides what "reported" means. */
async function markReported(root: string, batch: PendingUsage) {
  await RulesStore.update(root, (s) => {
    const known = new Set(s.usage_reported)
    s.usage_reported.push(...batch.pairs.filter((pair) => !known.has(pair)))
    s.corrected_reported = { ...s.corrected_reported, ...batch.corrected }
    if (s.pending_usage?.batch_id === batch.batch_id) s.pending_usage = undefined
  })
}

/**
 * Report usage of team rules: delivered sessions and "corrected again", each counted once. A batch is saved
 * (`pending_usage`) before it is sent and resent with the same `batch_id` until the server acknowledges it, so a
 * lost response cannot count twice. At most `MAX_USAGE_ITEMS` rules per batch; the rest go in the next run.
 */
export async function reportUsage(root: string, ctx: Ready): Promise<{ items: number; error?: string }> {
  const before = await RulesStore.read(root)
  if (before.pending_usage) {
    try {
      await sendUsage(root, ctx, before.pending_usage)
    } catch (error) {
      if (!permanentUsageFailure(error)) return { items: 0, error: errorText(error) }
      await dropUsage(root, before.pending_usage, error)
    }
  }
  const state = await RulesStore.read(root)
  if (!state.rules.length) return { items: 0 }
  const byLesson = new Map(state.rules.map((rule) => [RulesStore.lessonId(rule.rule_key), rule]))
  const [{ readShownSnapshots, lessonTextHash, snapshotFiles, snapshotFile }, { analyzeRecurrence }] = await Promise.all([import("../learn/delivery"), import("../learn/recurrence")])
  const { snapshots } = await readShownSnapshots(root)
  // A reported pair is kept while its session has a snapshot (any of them, not only the newest read here): a resumed
  // session comes back into the newest, and its pairs must still read as reported. A pair whose session is gone can
  // never be counted again, so it is let go: the list stays as small as the sessions on disk.
  const files = await snapshotFiles(root).catch(() => undefined)
  const sessionOf = (pair: string) => pair.slice(0, pair.lastIndexOf("|"))
  if (files && state.usage_reported.some((pair) => !files.has(snapshotFile(sessionOf(pair)))))
    await RulesStore.update(root, (s) => {
      s.usage_reported = s.usage_reported.filter((pair) => files.has(snapshotFile(sessionOf(pair))))
    })
  const reported = new Set(state.usage_reported)
  const counts = new Map<string, { applied: number; corrected_again: number }>()
  const pairs: string[] = []
  // Each (session, rule version) once: a session keeps showing rules on later turns, and a rule shown on turn 4 counts
  // even when the session was reported after turn 1. A rule counts at most `MAX_USAGE_DELTA` sessions per report, and
  // a batch at most `MAX_USAGE_ITEMS` rules: the rest waits for the next report.
  for (const snapshot of snapshots) {
    // Only against the version the session was shown: the lesson id (from `rule_key`) survives an approved edit, the
    // text does not. A session shown an earlier version is not counted against the current one.
    const shown = [...new Set(snapshot.shown
      .filter((entry) => entry.name === RulesStore.WORKSPACE_RULES_STORE)
      .flatMap((entry) => {
        const rule = byLesson.get(entry.id)
        return rule && entry.textHash === lessonTextHash(rule.text) ? [rule.public_id] : []
      }))]
    for (const publicId of shown) {
      const pair = `${snapshot.session}|${publicId}`
      if (reported.has(pair)) continue
      const row = counts.get(publicId) ?? { applied: 0, corrected_again: 0 }
      if (row.applied >= MAX_USAGE_DELTA) continue
      if (!counts.has(publicId) && counts.size >= MAX_USAGE_ITEMS) continue
      row.applied += 1
      counts.set(publicId, row)
      pairs.push(pair)
    }
  }
  // `recurred` is a window over recent snapshots and can fall as old ones age out. The reported baseline
  // follows it down, so a later rise is reported, and only what was sent is added to it.
  const corrected: Record<string, number> = {}
  const recurrence = await analyzeRecurrence(root).catch(() => undefined)
  for (const row of recurrence?.lessons ?? []) {
    if (row.name !== RulesStore.WORKSPACE_RULES_STORE) continue
    const rule = byLesson.get(row.id)
    if (!rule) continue
    // Keyed by rule key, which survives an approved edit (a new version gets a new public id), so the old version's
    // corrections are not reported again against the new one.
    const baseline = Math.min(state.corrected_reported[rule.rule_key] ?? 0, row.recurred)
    const delta = Math.min(row.recurred - baseline, MAX_USAGE_DELTA)
    if (delta > 0 && !counts.has(rule.public_id) && counts.size >= MAX_USAGE_ITEMS) continue
    corrected[rule.rule_key] = baseline + Math.max(0, delta)
    if (delta <= 0) continue
    const entry = counts.get(rule.public_id) ?? { applied: 0, corrected_again: 0 }
    entry.corrected_again += delta
    counts.set(rule.public_id, entry)
  }
  if (!counts.size) {
    if (Object.keys(corrected).length) await RulesStore.update(root, (s) => { s.corrected_reported = { ...s.corrected_reported, ...corrected } })
    return { items: 0 }
  }
  const batch: PendingUsage = {
    batch_id: randomUUID(),
    items: [...counts].map(([public_id, c]) => ({ public_id, applied: c.applied, helpful: 0, harmful: 0, corrected_again: c.corrected_again })),
    pairs,
    corrected,
  }
  // Another process (a second instance, `learn sync`) may have built a batch from the same unreported sessions in
  // the meantime: while it is pending, that one is sent (same batch id, so the server counts it once). If it was
  // already acknowledged, some of these sessions or corrections are reported: this batch is stale and is dropped
  // (the next run recounts from what is left).
  let stale = false
  const after = await RulesStore.update(root, (s) => {
    if (s.pending_usage) return
    stale = pairs.some((pair) => s.usage_reported.includes(pair)) ||
      Object.keys(corrected).some((key) => (s.corrected_reported[key] ?? 0) !== (state.corrected_reported[key] ?? 0))
    if (!stale) s.pending_usage = batch
  })
  if (stale) return { items: 0 }
  const saved = after.pending_usage ?? batch
  try {
    await sendUsage(root, ctx, saved)
  } catch (error) {
    if (permanentUsageFailure(error)) await dropUsage(root, saved, error)
    return { items: 0, error: errorText(error) }
  }
  return { items: saved.items.length }
}

/**
 * Drop a batch the server refused for good (`batch_conflict`, a coded 400/422, a rule it no longer serves): resending
 * can never succeed and would block every later report. Its sessions and corrections are marked reported, so the same
 * batch is not rebuilt and refused again; those counts are lost, which is the lesser harm.
 */
async function dropUsage(root: string, batch: PendingUsage, error: unknown) {
  await markReported(root, batch)
  log.warn("rules usage batch refused; dropped", { error: errorText(error) })
}

export interface RunReport {
  context: Context
  push?: PushResult
  pull?: PullResult
  usage?: { items: number; error?: string }
}

/** A run report safe to hand to a client or print: the captured credential (`actAs`) is left out. */
export function publicReport(report: RunReport) {
  const { context, ...rest } = report
  return { ...rest, context: context.status === "ready" ? { status: context.status, scope: context.scope } : context }
}

/** Push, pull, then report usage: "Sync now", `learn sync`, and the background refresh. `trigger` says which,
 * for telemetry. */
export async function run(root: string, directory: string, learn: LearnConfig, trigger: SyncTrigger = "refresh"): Promise<RunReport> {
  const startedAt = Date.now()
  try {
    const report = await runUntracked(root, directory, learn)
    RulesTelemetry.synced(trigger, report, startedAt)
    return report
  } catch (error) {
    // A run that threw (the learn lock timed out, the state is not writable): still one `failed` sync.
    RulesTelemetry.syncThrew(trigger, startedAt)
    throw error
  }
}

async function runUntracked(root: string, directory: string, learn: LearnConfig): Promise<RunReport> {
  const key = await canonicalRoot(root)
  const ctx = await context(directory, learn)
  if (ctx.status !== "ready") {
    if (ctx.status === "skipped" && ctx.unlinked) {
      const state = await RulesStore.read(root)
      if (state.workspace) await RulesStore.reset(root, { keepOutbox: true })
    }
    failedAt.set(key, Date.now())
    return { context: ctx }
  }
  await adopt(root, ctx)
  const pushed = await push(root, ctx)
  const pulled = await pull(root, ctx)
  if (pulled.ok) failedAt.delete(key)
  else failedAt.set(key, Date.now())
  const usage = pulled.ok ? await reportUsage(root, ctx).catch((error) => ({ items: 0, error: errorText(error) })) : undefined
  return { context: ctx, push: pushed, pull: pulled, ...(usage ? { usage } : {}) }
}

// Keyed by the real path: the service and the session loop may name one project through different paths.
const inflight = new Map<string, Promise<RunReport>>()
/** When the last run for a project failed or was skipped; a session start does not wait on it again. */
const failedAt = new Map<string, number>()

const canonicalRoot = (root: string) => fs.realpath(root).catch(() => root)

/** One run per project at a time; concurrent callers share it. */
export async function runShared(root: string, directory: string, learn: LearnConfig, trigger: SyncTrigger = "refresh"): Promise<RunReport> {
  return (await joinOrStart(root, directory, learn, trigger)).report
}

/** `runShared`, saying whether this call started the run. The run that starts announces what it pulled, once, whoever
 * waits on it (the timer, "Sync now", a session start, a card reply, `learn sync`). */
async function joinOrStart(root: string, directory: string, learn: LearnConfig, trigger: SyncTrigger) {
  const key = await canonicalRoot(root)
  const existing = inflight.get(key)
  if (existing) return { report: existing, started: false }
  const report = run(root, directory, learn, trigger)
    .then(async (done) => {
      await announce(directory, done)
      return done
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, report)
  return { report, started: true }
}

/** Review notices from a pull become `rule.proposal.reviewed`, and clients refresh (`altimate.rules.changed`). On the
 * Bus of the instance the run started in; a run outside one (none to tell) publishes nothing. */
async function announce(directory: string, report: RunReport) {
  for (const notice of report.pull?.notices ?? [])
    await Bus.publish(RuleEvents.Event.Reviewed, {
      public_id: notice.public_id,
      text: notice.text,
      status: notice.status,
      ...(notice.reason ? { reason: notice.reason } : {}),
      ...(notice.reviewer ? { reviewer: notice.reviewer } : {}),
    }).catch(() => {})
  if (report.context.status === "ready") await Bus.publish(RuleEvents.Event.Changed, { directory }).catch(() => {})
}

/** A run that starts after anything already queued: waits out an in-flight run (which may have pushed
 * already) and starts a new one. */
export async function runFresh(root: string, directory: string, learn: LearnConfig, trigger: SyncTrigger = "refresh"): Promise<RunReport> {
  await inflight.get(await canonicalRoot(root))?.catch(() => undefined)
  return runShared(root, directory, learn, trigger)
}

/** A pull is due when none succeeded within `REFRESH_MS`, and no attempt failed within it. */
export async function due(root: string): Promise<boolean> {
  const failed = failedAt.get(await canonicalRoot(root))
  if (failed !== undefined && Date.now() - failed < REFRESH_MS) return false
  const state = await RulesStore.read(root)
  const at = state.pulled_at ? Date.parse(state.pulled_at) : 0
  return !Number.isFinite(at) || Date.now() - at >= REFRESH_MS
}

/** Session start: wait (at most `waitMs`) for a run in flight, or start one when due, so the first turn sees
 * fresh rules. */
export async function sessionStart(
  root: string,
  directory: string,
  learn: LearnConfig,
  options: { waitMs?: number; startIfDue?: boolean } = {},
): Promise<void> {
  if (!rulesEnabled(learn)) return
  const existing = inflight.get(await canonicalRoot(root))
  // With `startIfDue: false` only a run already in flight is waited on (the service's first pull of a freshly
  // linked project); nothing new is started on the prompt path.
  if (!existing && (options.startIfDue === false || !(await due(root)))) return
  // The run announces its own notices (`joinOrStart`), whether this call started it or joined it.
  const running = existing ?? joinOrStart(root, directory, learn, "session_start").then(({ report }) => report)
  const settled = running.catch((error) => log.warn("rules session sync failed", { error: errorText(error) }))
  await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, options.waitMs ?? SESSION_WAIT_MS).unref?.())])
}

export * as RulesSync from "./sync"
