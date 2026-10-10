// altimate_change - new file
//
// Lesson sync with the bound workspace (`learn.sync`, opt-in). Pull: approved team lessons and tombstones into
// `remote.json`, the caller's own proposals into the ledger. Push: the outbox (proposals, usage batches) and the
// first-sync backfill. See ledger.ts for the state files, effective.ts for how remote lessons are delivered, and
// proposals.ts for how local changes become review-queue proposals.
//
// Rules this module keeps:
// - Gate: learning on, workspaces on, `learn.sync` / `ALTIMATE_LEARN_SYNC` on, and a binding (pin first) to a
//   workspace with a git remote. Otherwise no network traffic at all.
// - No network I/O under the learn lock: requests run first, state is written in a short locked step after.
// - Requests use the credential captured for the scope; a result whose scope changed in flight is discarded.
// - A missing route (404 without a code) backs off for 24 hours. Transient errors keep every cache.
// - Never fails a run: automatic callers get outcomes, not exceptions.
import fs from "node:fs/promises"
import path from "node:path"
import { Log } from "@/util/log"
import * as Playbook from "./playbook"
import * as Store from "./store"
import { syncEnabled } from "./config"
import { errText } from "./session-reflect"
import { redactSecrets } from "./digest"
import {
  applyPull, applyResult, applySubmissions, forScope, identityKey, readOutbox, readRemote, readSyncState, remoteFor, removeRemote,
  sameScope, scopeKey, writeOutbox, writeRemote, writeSyncState, type Proposal, type Remote, type Scope, type SyncState,
} from "./ledger"
import { backfillIntents, enqueue, submissionHash, toItem } from "./proposals"
import { hiddenReasons, RETIRED_MARK, remoteIdentity } from "./effective"
import { LessonApi, LessonApiError, MAX_BATCH_ITEMS, MAX_LOCAL_KEYS, MAX_USAGE_ITEMS, type BatchResult, type FailureKind } from "../workspace/lesson-api"
import type { ActAs } from "../workspace/api-client"

const log = Log.create({ service: "learn.sync" })
export const SESSION_WAIT_MS = 2_000
export const UNSUPPORTED_BACKOFF_MS = 24 * 60 * 60_000
export const BACKFILL_CAP = 200
const LOCK_OPTIONS = { timeoutMs: 5_000 }
/** Errors the server reports when a proposal's base moved: refresh, compare, and hold instead of resending. */
const CONFLICTS = new Set(["version_conflict", "open_proposal_exists", "bad_target", "stale_target"])
/** Item errors that end a proposal: the server will never accept it as is. */
const FINAL = new Set(["invalid", "no_change"])

type LearnConfig = Parameters<typeof syncEnabled>[0]

export type Context =
  | { status: "off" }
  | { status: "skipped"; reason: string; invalidate?: boolean }
  | { status: "ready"; scope: Scope; actAs: ActAs }

type SyncEvent = Omit<Extract<import("../telemetry").Telemetry.Event, { type: "learn_sync" }>, "type" | "timestamp" | "session_id">

/** Telemetry must never affect sync. */
function track(event: SyncEvent) {
  import("../telemetry")
    .then(({ Telemetry }) => Telemetry.track({ type: "learn_sync", timestamp: Date.now(), session_id: Telemetry.getContext().sessionId, ...event }))
    .catch(() => {})
}

let epoch = 0
let watching = false

/** Bumped when this process links, unlinks or rebinds a project: a pull in flight across it is discarded. */
async function watchBindings() {
  if (watching) return
  watching = true
  const { onBindingChanged } = await import("../workspace/state")
  onBindingChanged(() => { epoch++ })
}

/** Resolve the sync gate and scope. Binding resolution may ask the server; never call this under the learn lock. */
export async function context(directory: string, learn: LearnConfig): Promise<Context> {
  if (!syncEnabled(learn)) return { status: "off" }
  await watchBindings()
  const [{ WorkspaceApi }, { resolveBindingOutcome, credentialDigest, accountDigest }] = await Promise.all([
    import("../workspace/api-client"), import("../workspace/state"),
  ])
  const actAs = await WorkspaceApi.captureCredentials()
  if (!actAs) return { status: "skipped", reason: "not signed in to Altimate" }
  const outcome = await resolveBindingOutcome(directory).catch(() => ({ status: "unknown" as const }))
  if (outcome.status === "unbound") return { status: "skipped", reason: "this project is not linked to a workspace", invalidate: true }
  if (outcome.status !== "bound") return { status: "skipped", reason: "the workspace link could not be confirmed" }
  if (!outcome.binding.repoRemote) return { status: "skipped", reason: "this project has no git remote" }
  const account = credentialDigest(actAs.url, actAs.instance, actAs.apiKey)
  // The binding was resolved with the ambient credential: it must still be the captured one.
  if ((await accountDigest()) !== account) return { status: "skipped", reason: "the Altimate account changed" }
  return {
    status: "ready",
    actAs,
    scope: { apiUrl: actAs.url, tenant: actAs.instance, account, datamateId: outcome.binding.datamateId, repoRemote: outcome.binding.repoRemote },
  }
}

/** Stores to sync: the default store and every local store directory. */
export async function stores(root: string): Promise<string[]> {
  const names = new Set([Playbook.DEFAULT_NAME])
  const entries = await fs.readdir(path.join(root, ".altimate-code", "learn"), { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try { names.add(Playbook.validateName(entry.name)) } catch {}
  }
  return [...names].sort()
}

/** Cached for the current account (and the locally recorded link, when there is one): usable without asking anyone. */
export async function cachedScope(root: string, directory: string, store = Playbook.DEFAULT_NAME): Promise<Scope | undefined> {
  const remote = await readRemote(root, store).catch(() => undefined)
  if (!remote) return undefined
  const { accountDigest, readLocalBinding } = await import("../workspace/state")
  if ((await accountDigest().catch(() => null)) !== remote.scope.account) return undefined
  const local = await readLocalBinding(directory).catch(() => null)
  if (local && local.datamateId !== remote.scope.datamateId) return undefined
  return remote.scope
}

export interface PullOutcome {
  store: string
  outcome: "ok" | "unchanged" | "skipped" | "unsupported" | "discarded" | "error"
  error?: string
  kind?: FailureKind
  lessons?: number
  tombstones?: number
}

const now = () => new Date().toISOString()
const inFlight = new Map<string, Promise<PullOutcome>>()

async function localKeys(root: string, store: string): Promise<string[]> {
  const approved = await Store.loadApproved(root, store).catch(() => [])
  return approved.map((lesson) => lesson.id).slice(0, MAX_LOCAL_KEYS)
}

/** Concurrent pulls of one store share a request. */
export function pull(root: string, store: string, ctx: Extract<Context, { status: "ready" }>): Promise<PullOutcome> {
  const key = `${root}\0${store}\0${scopeKey(ctx.scope)}`
  const existing = inFlight.get(key)
  if (existing) return existing
  const started = pullOnce(root, store, ctx).finally(() => inFlight.delete(key))
  inFlight.set(key, started)
  return started
}

async function pullOnce(root: string, store: string, ctx: Extract<Context, { status: "ready" }>): Promise<PullOutcome> {
  const { scope, actAs } = ctx
  const before = await readSyncState(root, store)
  if (before.unsupported_until && Date.parse(before.unsupported_until) > Date.now())
    return { store, outcome: "unsupported", error: "the workspace server does not support lesson sync yet" }
  const cached = await remoteFor(root, store, scope)
  const started = Date.now()
  const startEpoch = epoch
  let response: Awaited<ReturnType<typeof LessonApi.sync>>
  try {
    response = await LessonApi.sync(actAs, scope.datamateId, {
      repo_remote: scope.repoRemote, store,
      ...(cached ? { known_revision: cached.revision } : {}),
      local_keys: await localKeys(root, store),
    })
  } catch (error) {
    return recordPullFailure(root, store, error, Date.now() - started)
  }
  // The caller's own proposals refresh the ledger's pending and receipt slots. Optional: a failure keeps the pull.
  const submissions = await ownSubmissions(actAs, scope.datamateId, forScope(before, scope).submissions_cursor).catch((error) => {
    log.warn("learn sync submissions refresh failed", { store, error: redactSecrets(errText(error)) })
    return undefined
  })
  const latency = Date.now() - started
  const { accountDigest } = await import("../workspace/state")
  if (epoch !== startEpoch || (await accountDigest().catch(() => null)) !== scope.account) {
    log.info("learn sync pull discarded: scope changed in flight", { store })
    return { store, outcome: "discarded" }
  }
  return Store.transaction(root, async () => {
    const previous = await remoteFor(root, store, scope)
    const lessons = response.unchanged && previous ? previous.lessons : response.lessons
    const live = new Set(lessons.map((lesson) => identityKey(remoteIdentity(lesson))))
    // Tombstones accumulate: a retired key restored later by Git or `learn rollback` stays hidden immediately.
    const tombstones = new Map([...(previous?.tombstones ?? []), ...response.tombstones].map((t) => [identityKey(t), t]))
    const remote: Remote = {
      version: 1, scope, revision: response.revision, pulled_at: now(), repo_identity: response.repo_identity,
      share: response.share_lessons_across_repos, pending_count: response.pending_count,
      lessons, tombstones: [...tombstones.values()].filter((t) => !live.has(identityKey(t))),
    }
    await writeRemote(root, store, remote)
    const state = forScope(await readSyncState(root, store), scope)
    applyPull(state, remote, !response.unchanged || !previous)
    if (submissions) applySubmissions(state, store, submissions)
    state.last_pull = { at: now(), outcome: response.unchanged ? "unchanged" : "ok", latency_ms: latency }
    delete state.unsupported_until
    await writeSyncState(root, store, state)
    log.info("learn sync pull", { store, outcome: state.last_pull.outcome, latency_ms: latency, lessons: lessons.length, tombstones: remote.tombstones.length })
    track({ operation: "pull", outcome: state.last_pull.outcome, latency_ms: latency, lessons: lessons.length, tombstones: remote.tombstones.length })
    return { store, outcome: response.unchanged ? "unchanged" : "ok", lessons: lessons.length, tombstones: remote.tombstones.length } as PullOutcome
  }, LOCK_OPTIONS).catch((error) => ({ store, outcome: "error" as const, error: redactSecrets(errText(error)) }))
}

const SUBMISSIONS_PAGE = 1000
const SUBMISSIONS_MAX_PAGES = 10

/** The server pages by `updated_at` (inclusive, oldest first, at most 1000 per call). */
async function ownSubmissions(actAs: ActAs, datamateId: number, since: string | undefined) {
  const rows: Awaited<ReturnType<typeof LessonApi.submissions>> = []
  for (let page = 0; page < SUBMISSIONS_MAX_PAGES; page++) {
    const batch = await LessonApi.submissions(actAs, datamateId, since)
    rows.push(...batch)
    if (batch.length < SUBMISSIONS_PAGE || batch.at(-1)!.updated_at === since) break
    since = batch.at(-1)!.updated_at
  }
  return rows
}

async function recordPullFailure(root: string, store: string, error: unknown, latency: number): Promise<PullOutcome> {
  const failure = error instanceof LessonApiError ? error : new LessonApiError("transient", errText(error))
  const message = redactSecrets(failure.message)
  log.warn("learn sync pull failed", { store, kind: failure.kind, latency_ms: latency, error: message })
  track({ operation: "pull", outcome: "error", error_kind: failure.kind, latency_ms: latency })
  await Store.transaction(root, async () => {
    const state = await readSyncState(root, store)
    state.last_pull = { at: now(), outcome: failure.kind === "unsupported" ? "unsupported" : "error", error: message, latency_ms: latency }
    if (failure.kind === "unsupported") state.unsupported_until = new Date(Date.now() + UNSUPPORTED_BACKOFF_MS).toISOString()
    // Access answers invalidate the cache; transient failures keep it.
    if (failure.kind === "workspace_not_found" || failure.kind === "forbidden" || failure.kind === "repo_not_bound") await removeRemote(root, store)
    await writeSyncState(root, store, state)
  }, LOCK_OPTIONS).catch((e) => log.warn("learn sync status not recorded", { error: redactSecrets(errText(e)) }))
  return { store, outcome: failure.kind === "unsupported" ? "unsupported" : "error", kind: failure.kind, error: message }
}

/** Drop every store's pulled cache: sync was turned off, or the project was unlinked. */
export async function invalidate(root: string) {
  const names = await stores(root)
  await Store.transaction(root, async () => {
    for (const store of names) await removeRemote(root, store)
  }, LOCK_OPTIONS)
}

export interface PushReport {
  store: string
  submitted: number
  duplicate: number
  conflict: number
  deferred: number
  dropped: number
  usage: number
  held: number
  /** Held because they were created for another workspace, repository or account. */
  heldOtherScope: number
  backfilled: number
  error?: string
}

const emptyReport = (store: string): PushReport =>
  ({ store, submitted: 0, duplicate: 0, conflict: 0, deferred: 0, dropped: 0, usage: 0, held: 0, heldOtherScope: 0, backfilled: 0 })

const proposalIdentity = (proposal: Proposal, store: string, remote: Remote | undefined) =>
  ({ repo_identity: proposal.repo_identity ?? remote?.repo_identity ?? null, store, lesson_key: proposal.item.lesson_key })

/** Re-derive a held proposal against the ledger as it stands now: an explicit decision to resubmit over newer versions. */
function rebase(proposal: Proposal, store: string, remote: Remote | undefined, state: SyncState): Proposal | undefined {
  const item = toItem({
    kind: proposal.item.change_type === "remove" ? "remove" : "upsert", lesson_key: proposal.item.lesson_key,
    identity: proposalIdentity(proposal, store, remote), text: proposal.item.text, tags: proposal.item.tags,
    trigger_paths: proposal.item.trigger_paths, pinned: proposal.item.pinned, coexists: proposal.item.coexists,
    supersedes: proposal.targets, provenance: proposal.item.provenance ?? undefined, origin: proposal.item.origin,
  }, remote, state)
  if (!item) return undefined
  return { ...proposal, state: "queued", reason: undefined, item, submission_hash: submissionHash(item) }
}

/** Does the server already hold what this proposal asked for? */
function satisfied(proposal: Proposal, store: string, remote: Remote | undefined, state: SyncState): boolean {
  const identity = proposalIdentity(proposal, store, remote)
  const entry = state.ledger[identityKey(identity)]
  if (entry?.pending?.submission_hash === proposal.submission_hash || entry?.pending?.content_hash === proposal.submission_hash) return true
  if (entry?.receipts.some((r) => r.submission_hash === proposal.submission_hash && r.status !== "rejected")) return true
  const live = remote?.lessons.find((l) => identityKey(remoteIdentity(l)) === identityKey(identity))
  if (proposal.item.change_type === "remove") return !live
  return !!live && live.text === proposal.item.text && live.pinned === proposal.item.pinned &&
    JSON.stringify(live.tags) === JSON.stringify(proposal.item.tags) && JSON.stringify(live.trigger_paths) === JSON.stringify(proposal.item.trigger_paths)
}

/**
 * Send this scope's queued proposals and usage batches, after the first-sync backfill. Items created for another
 * scope are never retargeted: they stay held and are reported. `resubmit` re-derives held proposals for one key.
 */
export async function push(root: string, store: string, ctx: Extract<Context, { status: "ready" }>, opts: { resubmit?: string; deadline?: number } = {}): Promise<PushReport> {
  const report = emptyReport(store)
  const { scope, actAs } = ctx
  const live = () => opts.deadline === undefined || Date.now() < opts.deadline
  const sync = await readSyncState(root, store)
  if (sync.unsupported_until && Date.parse(sync.unsupported_until) > Date.now()) {
    report.error = "the workspace server does not support lesson sync yet"
    return report
  }
  if (!(await remoteFor(root, store, scope))) {
    const pulled = await pull(root, store, ctx)
    if (pulled.outcome !== "ok" && pulled.outcome !== "unchanged") {
      report.error = pulled.error ?? `pull ${pulled.outcome}`
      return report
    }
  }
  // Locked: backfill, resubmission, and the batch to send. No network here.
  const plan = await Store.transaction(root, async () => {
    const remote = await remoteFor(root, store, scope)
    let state = forScope(await readSyncState(root, store), scope)
    if (remote && !state.backfill.complete) {
      const staged = (await Store.loadCandidateLessons(root, store)) ?? await Store.loadApproved(root, store)
      const backfill = backfillIntents(store, staged, remote, state, BACKFILL_CAP)
      report.backfilled = await enqueue(root, store, scope, backfill.intents)
      state = forScope(await readSyncState(root, store), scope)
      state.backfill = { complete: backfill.complete, done: [...state.backfill.done, ...backfill.done] }
      await writeSyncState(root, store, state)
    }
    const outbox = await readOutbox(root, store)
    if (opts.resubmit) {
      outbox.proposals = outbox.proposals.flatMap((p) => {
        if (p.state !== "held" || p.item.lesson_key !== opts.resubmit || !sameScope(p.scope, scope)) return [p]
        const next = rebase(p, store, remote, state)
        return next ? [next] : []
      })
      await writeOutbox(root, store, outbox)
    }
    const queued = outbox.proposals.filter((p) => p.state === "queued" && sameScope(p.scope, scope))
    // A rejected submission is never re-sent.
    const rejected = queued.filter((p) => state.ledger[identityKey(proposalIdentity(p, store, remote))]
      ?.receipts.some((r) => r.submission_hash === p.submission_hash && r.status === "rejected"))
    if (rejected.length) {
      outbox.proposals = outbox.proposals.filter((p) => !rejected.includes(p))
      report.dropped += rejected.length
      await writeOutbox(root, store, outbox)
    }
    report.heldOtherScope = outbox.proposals.filter((p) => !sameScope(p.scope, scope)).length +
      outbox.usage.filter((u) => !sameScope(u.scope, scope)).length
    report.held = outbox.proposals.filter((p) => p.state === "held" && sameScope(p.scope, scope)).length
    return {
      proposals: queued.filter((p) => !rejected.includes(p)),
      usage: outbox.usage.filter((u) => sameScope(u.scope, scope)),
    }
  }, LOCK_OPTIONS)

  const results: { proposal: Proposal; result: BatchResult }[] = []
  let failure: LessonApiError | undefined
  for (let i = 0; i < plan.proposals.length && live() && !failure; i += MAX_BATCH_ITEMS) {
    const chunk = plan.proposals.slice(i, i + MAX_BATCH_ITEMS)
    try {
      const answer = await LessonApi.batch(actAs, scope.datamateId, { repo_remote: scope.repoRemote, store, items: chunk.map((p) => p.item) })
      chunk.forEach((proposal, index) => {
        const result = answer.find((r) => r.lesson_key === proposal.item.lesson_key && (r.submission_hash ?? proposal.submission_hash) === proposal.submission_hash) ?? answer[index]
        if (result) results.push({ proposal, result })
      })
    } catch (error) {
      failure = error instanceof LessonApiError ? error : new LessonApiError("transient", errText(error))
    }
  }
  const sentUsage: string[] = []
  const droppedUsage: string[] = []
  for (const batch of plan.usage) {
    if (!live() || failure) break
    try {
      for (let i = 0; i < batch.items.length; i += MAX_USAGE_ITEMS)
        await LessonApi.usage(actAs, scope.datamateId, { batch_id: batch.batch_id, items: batch.items.slice(i, i + MAX_USAGE_ITEMS) })
      sentUsage.push(batch.batch_id)
    } catch (error) {
      const classified = error instanceof LessonApiError ? error : new LessonApiError("transient", errText(error))
      // The same batch id with another payload: never resend it.
      if (classified.kind === "batch_conflict") droppedUsage.push(batch.batch_id)
      else failure = classified
    }
  }
  const conflicts = results.filter(({ result }) => result.error_code && CONFLICTS.has(result.error_code))
  // A conflict means the server moved: refresh before deciding whether the proposal is already satisfied.
  if (conflicts.length) await pull(root, store, ctx).catch(() => undefined)

  await Store.transaction(root, async () => {
    const remote = await remoteFor(root, store, scope)
    const state = forScope(await readSyncState(root, store), scope)
    const outbox = await readOutbox(root, store)
    const remove = new Set<string>()
    for (const { proposal, result } of results) {
      const key = identityKey(proposalIdentity(proposal, store, remote ?? undefined))
      if (!result.error_code) {
        if (result.public_id && result.version != null && result.status)
          applyResult(state, key, { submission_hash: result.submission_hash ?? proposal.submission_hash, public_id: result.public_id, version: result.version, status: result.status })
        remove.add(proposal.id)
        if (result.duplicate) report.duplicate++
        else report.submitted++
        continue
      }
      if (FINAL.has(result.error_code)) {
        remove.add(proposal.id)
        report.dropped++
        log.info("learn sync proposal dropped", { store, code: result.error_code })
        continue
      }
      if (CONFLICTS.has(result.error_code) && satisfied(proposal, store, remote, state)) {
        remove.add(proposal.id)
        report.duplicate++
        continue
      }
      // Never resent automatically with a newer version: that could overwrite an owner's edit.
      report.conflict++
      const held = outbox.proposals.find((p) => p.id === proposal.id)
      if (held) Object.assign(held, {
        state: "held",
        reason: `${result.error_code}${result.error_detail ? `: ${result.error_detail}` : ""}; review it in the workspace, then \`learn push --resubmit ${proposal.item.lesson_key}\``,
      })
    }
    outbox.proposals = outbox.proposals.filter((p) => !remove.has(p.id))
    outbox.usage = outbox.usage.filter((u) => !sentUsage.includes(u.batch_id) && !droppedUsage.includes(u.batch_id))
    report.usage = sentUsage.length
    report.deferred = outbox.proposals.filter((p) => p.state === "queued" && sameScope(p.scope, scope)).length
    report.held = outbox.proposals.filter((p) => p.state === "held" && sameScope(p.scope, scope)).length
    if (failure) {
      report.error = redactSecrets(failure.message)
      if (failure.kind === "unsupported") state.unsupported_until = new Date(Date.now() + UNSUPPORTED_BACKOFF_MS).toISOString()
    }
    state.last_push = {
      at: now(), submitted: report.submitted, duplicate: report.duplicate, conflict: report.conflict, deferred: report.deferred,
      dropped: report.dropped, usage: report.usage, ...(report.error ? { error: report.error } : {}),
    }
    await writeOutbox(root, store, outbox)
    await writeSyncState(root, store, state)
  }, LOCK_OPTIONS)
  const oldest = plan.proposals.map((p) => Date.parse(p.created_at)).sort()[0]
  track({
    operation: "push", outcome: failure ? "error" : "ok", ...(failure ? { error_kind: failure.kind } : {}),
    submitted: report.submitted, duplicate: report.duplicate, conflict: report.conflict, deferred: report.deferred,
    dropped: report.dropped, usage_batches: report.usage, queue_age_ms: oldest ? Date.now() - oldest : 0,
  })
  log.info("learn sync push", {
    store, submitted: report.submitted, duplicate: report.duplicate, conflict: report.conflict, deferred: report.deferred,
    dropped: report.dropped, usage: report.usage, queue_age_ms: oldest ? Date.now() - oldest : 0, ...(failure ? { kind: failure.kind } : {}),
  })
  return report
}

export interface SyncReport {
  context: Context
  pulls: PullOutcome[]
  pushes: PushReport[]
}

/** Pull and/or push every store. Never throws. */
export async function run(root: string, directory: string, learn: LearnConfig, opts: { pull?: boolean; push?: boolean; resubmit?: string; deadline?: number; ctx?: Context } = {}): Promise<SyncReport> {
  const report: SyncReport = { context: { status: "off" }, pulls: [], pushes: [] }
  try {
    const ctx = opts.ctx ?? await context(directory, learn)
    report.context = ctx
    if (ctx.status === "skipped" && ctx.invalidate) await invalidate(root).catch(() => {})
    if (ctx.status !== "ready") return report
    for (const store of await stores(root)) {
      if (opts.pull !== false) report.pulls.push(await pull(root, store, ctx))
      if (opts.push !== false) report.pushes.push(await push(root, store, ctx, opts).catch((error) => ({ ...emptyReport(store), error: redactSecrets(errText(error)) })))
    }
  } catch (error) {
    log.warn("learn sync skipped", { error: redactSecrets(errText(error)) })
  }
  return report
}

const background = new Map<string, Promise<unknown>>()

/** Push in the background after reflect, promote or auto-promote. Deduplicated per project; never throws. */
export function pushSoon(root: string, directory: string, learn: LearnConfig, deadlineMs = 30_000): Promise<unknown> {
  if (!syncEnabled(learn)) return Promise.resolve()
  const existing = background.get(root)
  if (existing) return existing
  const started = run(root, directory, learn, { pull: false, deadline: Date.now() + deadlineMs }).catch(() => undefined).finally(() => background.delete(root))
  background.set(root, started)
  return started
}

/** What delivery needs to use the cache: the scope it may trust. Updated when the session's pull lands. */
export interface RemoteView {
  scope(): Scope | undefined
}

export interface SessionSync extends RemoteView {
  /** Resolves when the session-start pull and push have finished (or failed). */
  done: Promise<unknown>
}

/**
 * Session start, before the first delivery: read the cache first; wait (at most `SESSION_WAIT_MS`) for the pull
 * only when there is no valid cache. Pull and outbox push continue in the background.
 */
const sessions = new Map<string, Promise<SessionSync | undefined>>()
const SESSION_MEMO_MAX = 64

export function sessionStart(root: string, directory: string, learn: LearnConfig, opts: { session?: string; waitMs?: number } = {}): Promise<SessionSync | undefined> {
  if (!syncEnabled(learn)) return Promise.resolve(undefined)
  // Each prompt loop of a session starts here; one pull per session is enough.
  const key = opts.session && `${root}\0${opts.session}`
  const existing = key ? sessions.get(key) : undefined
  if (existing) return existing
  const started = startSession(root, directory, learn, opts.waitMs ?? SESSION_WAIT_MS)
  if (key) {
    sessions.set(key, started)
    if (sessions.size > SESSION_MEMO_MAX) sessions.delete(sessions.keys().next().value!)
  }
  return started
}

async function startSession(root: string, directory: string, learn: LearnConfig, waitMs: number): Promise<SessionSync | undefined> {
  let scope = await cachedScope(root, directory).catch(() => undefined)
  const done = (async () => {
    const ctx = await context(directory, learn)
    if (ctx.status === "skipped" && ctx.invalidate) {
      scope = undefined
      await invalidate(root).catch(() => {})
    }
    if (ctx.status !== "ready") return
    const result = await run(root, directory, learn, { ctx })
    if (result.pulls.some((p) => p.outcome === "ok" || p.outcome === "unchanged")) scope = ctx.scope
    else if (result.pulls.some((p) => p.kind === "workspace_not_found" || p.kind === "forbidden" || p.kind === "repo_not_bound")) scope = undefined
    else if (scope && !sameScope(scope, ctx.scope)) scope = undefined
  })().catch((error) => log.warn("learn session sync failed", { error: redactSecrets(errText(error)) }))
  if (!scope) {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([done, new Promise((resolve) => { timer = setTimeout(resolve, waitMs) })])
    clearTimeout(timer)
  }
  return { scope: () => scope, done }
}

/** Workspace skills synced to this project that are learn-managed playbooks (published by `promote --publish`). */
export async function legacyPlaybookSkills(directory: string): Promise<string[]> {
  const { snapshotRoot } = await import("../workspace/skill-sync")
  const base = snapshotRoot(directory)
  const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => [])
  const found: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const text = await fs.readFile(path.join(base, entry.name, "SKILL.md"), "utf8").catch(() => "")
    if (text.split(/\r?\n/).includes(Playbook.HEADER)) found.push(entry.name)
  }
  return found.sort()
}

/** Local status for `learn status`: no network. */
export async function status(root: string, store: string, learn: LearnConfig) {
  const enabled = syncEnabled(learn)
  const [remote, state, outbox] = await Promise.all([readRemote(root, store), readSyncState(root, store), readOutbox(root, store)])
  const { accountDigest } = await import("../workspace/state")
  const account = await accountDigest().catch(() => null)
  const current = remote && remote.scope.account === account ? remote : undefined
  const scoped = (s: Scope) => !current || sameScope(s, current.scope)
  const queued = outbox.proposals.filter((p) => p.state === "queued" && scoped(p.scope))
  return {
    enabled,
    workspace: current ? { id: current.scope.datamateId, repo_remote: current.scope.repoRemote, repo_identity: current.repo_identity } : null,
    revision: current?.revision ?? null,
    pulled_at: current?.pulled_at ?? null,
    share_across_repos: current?.share ?? null,
    team_lessons: current?.lessons.filter((l) => l.store === store).length ?? 0,
    tombstones: current?.tombstones.length ?? 0,
    pending_review: current?.pending_count ?? 0,
    outbox: {
      queued: queued.length,
      held: outbox.proposals.filter((p) => p.state === "held" && scoped(p.scope)).map((p) => ({ lesson_key: p.item.lesson_key, change_type: p.item.change_type, reason: p.reason ?? "" })),
      other_scope: outbox.proposals.filter((p) => !scoped(p.scope)).length + outbox.usage.filter((u) => !scoped(u.scope)).length,
      usage_batches: outbox.usage.filter((u) => scoped(u.scope)).length,
      oldest_queued_at: queued.map((p) => p.created_at).sort()[0] ?? null,
    },
    last_pull: state.last_pull ?? null,
    last_push: state.last_push ?? null,
    unsupported_until: state.unsupported_until ?? null,
    backfill: { complete: state.backfill.complete, uploaded: state.backfill.done.length },
    not_syncable: Object.entries(state.unsyncable).map(([lesson_key, reason]) => ({ lesson_key, reason })),
    /** Local approved lessons that are not delivered because of the workspace (retired, or replaced by a team version). */
    hidden_local: [...hiddenReasons(store, current ? await Store.loadApproved(root, store).catch(() => []) : [], current)]
      .map(([lesson_key, reason]) => ({ lesson_key, reason })),
  }
}

/** `learn show` markers from local files: (team) approved in the workspace, (pending review) your open proposal, (local). */
export async function markers(root: string, store: string) {
  const remote = await readRemote(root, store)
  const { accountDigest } = await import("../workspace/state")
  if (!remote || remote.scope.account !== (await accountDigest().catch(() => null))) return undefined
  const state = forScope(await readSyncState(root, store), remote.scope)
  const outbox = await readOutbox(root, store)
  const team = remote.lessons.filter((lesson) => lesson.store === store)
  const live = new Set(team.filter((l) => l.repo_identity === remote.repo_identity).map((l) => l.lesson_key))
  const queued = new Set(outbox.proposals.filter((p) => sameScope(p.scope, remote.scope)).map((p) => p.item.lesson_key))
  return {
    team,
    /** `text` is the local lesson's text: a different team version means the local copy is not delivered. */
    mark(id: string, text?: string): string {
      const hidden = text === undefined ? undefined : hiddenReasons(store, [{ id, text }], remote).get(id)
      if (hidden) return hidden
      if (live.has(id)) return "team"
      if (remote.tombstones.some((t) => t.store === store && t.lesson_key === id && t.repo_identity === remote.repo_identity)) return RETIRED_MARK
      const entry = state.ledger[identityKey({ repo_identity: remote.repo_identity, store, lesson_key: id })]
      return entry?.pending || queued.has(id) ? "pending review" : "local"
    },
  }
}
