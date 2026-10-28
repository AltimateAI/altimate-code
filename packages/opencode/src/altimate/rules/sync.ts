// altimate_change - new file
//
// Workspace rules sync for a linked project:
//
// - Pull (`POST /rules/sync`): the approved rules for this repository into the `team` store mirror, the
//   workspace settings, and this person's proposals the owner reviewed since the last pull. Each review
//   becomes a notice (`rule.proposal.reviewed`): "approved", or "rejected" with the owner's reason.
// - Push: the outbox of proposals the person sent from a card (or bootstrap), then "Approve now" for an
//   owner who chose it. Offline-safe: an unsent proposal stays queued for the next run.
// - Usage: per rule, sessions it was delivered in (`applied`) and sessions where the person corrected the
//   same topic after it was shown (`corrected_again`, from recurrence).
//
// Timing: a pull at session start (bounded wait), then every `REFRESH_MS` in the background, plus
// "Sync now". Never throws to an automatic caller: failures are recorded and reported.
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import { Log } from "@/util/log"
import { learnEnabled } from "../learn/config"
import type { ActAs } from "../workspace/api-client"
import { RulesApi, RulesApiError, type ProposalItem, type ProposalResult } from "./api"
import { RulesStore, type Scope, type State } from "./store"

const log = Log.create({ service: "rules.sync" })
export const REFRESH_MS = 5 * 60_000
export const SESSION_WAIT_MS = 2_000
const MAX_PROPOSALS = 50
const MAX_USAGE_DELTA = 50

type LearnConfig = { enabled?: boolean } | undefined

export type Context =
  | { status: "off"; reason: string }
  | { status: "skipped"; reason: string; unlinked?: boolean }
  | { status: "ready"; scope: Scope; actAs: ActAs }

/** Rules need learning on and workspaces on. */
export function rulesEnabled(learn: LearnConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  const disabled = env["ALTIMATE_DISABLE_WORKSPACE"]?.trim().toLowerCase()
  return learnEnabled(learn, env) && (disabled === undefined || disabled === "" || disabled === "0" || disabled === "false")
}

/** Resolve the gate and scope. Binding resolution may ask the server; never call this under the learn lock. */
export async function context(directory: string, learn: LearnConfig): Promise<Context> {
  if (!rulesEnabled(learn)) return { status: "off", reason: "learning or workspaces are turned off" }
  const [{ WorkspaceApi }, { resolveBindingOutcome, credentialDigest, accountDigest }] = await Promise.all([
    import("../workspace/api-client"),
    import("../workspace/state"),
  ])
  const actAs = await WorkspaceApi.captureCredentials()
  if (!actAs) return { status: "skipped", reason: "not signed in to Altimate" }
  const outcome = await resolveBindingOutcome(directory).catch(() => ({ status: "unknown" as const }))
  if (outcome.status === "unbound") return { status: "skipped", reason: "this project is not linked to a workspace", unlinked: true }
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

type Ready = Extract<Context, { status: "ready" }>

export interface PullResult {
  ok: boolean
  error?: string
  rules: number
  pending: number
  notices: State["notices"]
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** State pulled for another account, workspace or remote is dropped, outbox included: it never reaches this scope. */
export async function adopt(root: string, ctx: Ready): Promise<{ state: State; same: boolean }> {
  const state = await RulesStore.read(root)
  const same = RulesStore.sameScope(state.scope, ctx.scope)
  if (state.scope && !same) {
    await RulesStore.reset(root)
    return { state: await RulesStore.read(root), same }
  }
  return { state, same }
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
      state.revision = response.revision
      state.cursor = response.cursor
      state.pending_count = response.pending_count
      state.pulled_at = new Date().toISOString()
      state.last_error = undefined
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
    if (error instanceof RulesApiError && (error.kind === "workspace_not_found" || error.kind === "repo_not_bound")) {
      // The link is gone: stop delivering its rules.
      await RulesStore.reset(root)
    } else {
      await RulesStore.update(root, (state) => { state.last_error = errorText(error) })
    }
    log.warn("rules pull failed", { error: errorText(error) })
    return { ok: false, error: errorText(error), rules: before.rules.length, pending: before.pending_count, notices: [] }
  }
}

export interface PushResult {
  sent: { text: string; status: string; public_id?: string; error?: string; approved?: boolean }[]
  queued: number
  error?: string
}

type OutboxEntry = State["outbox"][number]
type Outcome = { entry: OutboxEntry; result?: ProposalResult; error?: RulesApiError }

/** Send `entries`. A batch the server refused outright is retried one item at a time, so one bad item
 * cannot hold back the rest. */
async function send(ctx: Ready, entries: OutboxEntry[]): Promise<Outcome[]> {
  try {
    const results = await RulesApi.propose(ctx.actAs, ctx.scope.datamateId, {
      repo_remote: ctx.scope.repoRemote,
      items: entries.map((entry) => entry.item as ProposalItem),
    })
    const byIndex = new Map(results.map((result) => [result.index, result]))
    return entries.map((entry, index) => ({ entry, result: byIndex.get(index) }))
  } catch (error) {
    const failure = error instanceof RulesApiError ? error : RulesApi.classify(error)
    if (failure.kind === "rejected" && entries.length > 1) {
      const outcomes: Outcome[] = []
      for (const entry of entries) outcomes.push(...(await send(ctx, [entry])))
      return outcomes
    }
    return entries.map((entry) => ({ entry, error: failure }))
  }
}

/**
 * Send the outbox. An item leaves it once the server answered for it, or refused it (`rejected`, reported
 * as an error); a transient failure, or no answer for that item, keeps it queued.
 */
export async function push(root: string, ctx: Ready): Promise<PushResult> {
  const state = await RulesStore.read(root)
  const batch = state.outbox.slice(0, MAX_PROPOSALS)
  if (!batch.length) return { sent: [], queued: 0 }
  const outcomes = await send(ctx, batch)
  const sent: PushResult["sent"] = []
  const approvals: { entry: OutboxEntry; publicId: string; version: number }[] = []
  const done = new Set<string>()
  const failed = new Map<string, string>()
  for (const { entry, result, error } of outcomes) {
    if (error) {
      if (error.kind === "rejected") {
        done.add(entry.id)
        sent.push({ text: entry.item.text, status: "rejected", error: error.message })
      } else failed.set(entry.id, error.message)
      continue
    }
    if (!result) {
      failed.set(entry.id, "no result from the server")
      continue
    }
    done.add(entry.id)
    const ok = result.status === "pending" || result.status === "exists" || result.duplicate
    sent.push({
      text: entry.item.text,
      status: result.status,
      ...(result.public_id ? { public_id: result.public_id } : {}),
      ...(!ok ? { error: result.error_detail ?? result.error_code ?? result.status } : {}),
    })
    if (entry.approve && result.status === "pending" && result.public_id && result.version)
      approvals.push({ entry, publicId: result.public_id, version: result.version })
  }
  for (const approval of approvals) {
    try {
      const reviewed = await RulesApi.review(ctx.actAs, ctx.scope.datamateId, approval.publicId, {
        action: approval.entry.approve!,
        expected_version: approval.version,
      })
      const row = sent.find((s) => s.public_id === approval.publicId)
      if (row) Object.assign(row, { status: reviewed.status, approved: true })
    } catch (error) {
      const row = sent.find((s) => s.public_id === approval.publicId)
      if (row) row.error = `sent for review; approving failed: ${errorText(error)}`
    }
  }
  const now = new Date().toISOString()
  const after = await RulesStore.update(root, (s) => {
    s.outbox = s.outbox.filter((entry) => !done.has(entry.id))
    for (const entry of s.outbox) {
      const error = failed.get(entry.id)
      if (error === undefined) continue
      entry.attempts += 1
      entry.last_error = error
    }
    for (const row of sent) {
      if (!row.public_id || row.status === "exists") continue
      const existing = s.sent.find((x) => x.public_id === row.public_id)
      const change = batch.find((b) => b.item.text === row.text)?.item.change ?? "add"
      if (existing) Object.assign(existing, { status: row.status, updated_at: now })
      else s.sent.push({ public_id: row.public_id, text: row.text, change, status: row.status, sent_at: now, updated_at: now })
      if (row.status === "pending") s.pending_count += 1
    }
  })
  const error = failed.size ? [...failed.values()][0] : undefined
  return { sent, queued: after.outbox.length, ...(error ? { error } : {}) }
}

/** Queue a proposal; it is sent by the next push. */
export async function enqueue(root: string, item: ProposalItem, approve?: "approve" | "approve_anyway") {
  await RulesStore.update(root, (state) => {
    state.outbox.push({ id: randomUUID(), created_at: new Date().toISOString(), attempts: 0, item, ...(approve ? { approve } : {}) })
  })
}

/** Report usage of team rules: delivered sessions and "corrected again", each counted once. */
export async function reportUsage(root: string, ctx: Ready): Promise<{ items: number; error?: string }> {
  const state = await RulesStore.read(root)
  if (!state.rules.length) return { items: 0 }
  const byLesson = new Map(state.rules.map((rule) => [RulesStore.lessonId(rule.rule_key), rule]))
  const [{ readShownSnapshots }, { analyzeRecurrence }] = await Promise.all([import("../learn/delivery"), import("../learn/recurrence")])
  const { snapshots } = await readShownSnapshots(root)
  const reported = new Set(state.usage_sessions)
  const counts = new Map<string, { applied: number; corrected_again: number }>()
  const sessions: string[] = []
  // A rule counts at most `MAX_USAGE_DELTA` sessions per report: later sessions wait for the next one.
  for (const snapshot of snapshots) {
    if (reported.has(snapshot.session)) continue
    const shown = [...new Set(snapshot.shown.filter((entry) => entry.name === RulesStore.TEAM_STORE).map((entry) => entry.id))]
      .flatMap((id) => byLesson.get(id)?.public_id ?? [])
    if (!shown.length) continue
    if (shown.some((publicId) => (counts.get(publicId)?.applied ?? 0) >= MAX_USAGE_DELTA)) break
    sessions.push(snapshot.session)
    for (const publicId of shown) {
      const row = counts.get(publicId) ?? { applied: 0, corrected_again: 0 }
      row.applied += 1
      counts.set(publicId, row)
    }
  }
  // `recurred` is a window over recent snapshots and can fall as old ones age out. The reported baseline
  // follows it down, so a later rise is reported, and only what was sent is added to it.
  const corrected: Record<string, number> = {}
  const recurrence = await analyzeRecurrence(root).catch(() => undefined)
  for (const row of recurrence?.lessons ?? []) {
    if (row.name !== RulesStore.TEAM_STORE) continue
    const rule = byLesson.get(row.id)
    if (!rule) continue
    const baseline = Math.min(state.corrected_reported[rule.public_id] ?? 0, row.recurred)
    const delta = Math.min(row.recurred - baseline, MAX_USAGE_DELTA)
    corrected[rule.public_id] = baseline + Math.max(0, delta)
    if (delta <= 0) continue
    const entry = counts.get(rule.public_id) ?? { applied: 0, corrected_again: 0 }
    entry.corrected_again += delta
    counts.set(rule.public_id, entry)
  }
  if (!counts.size) {
    if (Object.keys(corrected).length) await RulesStore.update(root, (s) => { s.corrected_reported = { ...s.corrected_reported, ...corrected } })
    return { items: 0 }
  }
  const items = [...counts].map(([public_id, c]) => ({ public_id, applied: c.applied, helpful: 0, harmful: 0, corrected_again: c.corrected_again }))
  try {
    await RulesApi.usage(ctx.actAs, ctx.scope.datamateId, { batch_id: randomUUID(), items })
  } catch (error) {
    return { items: 0, error: errorText(error) }
  }
  await RulesStore.update(root, (s) => {
    s.usage_sessions.push(...sessions)
    s.corrected_reported = { ...s.corrected_reported, ...corrected }
  })
  return { items: items.length }
}

export interface RunReport {
  context: Context
  push?: PushResult
  pull?: PullResult
  usage?: { items: number; error?: string }
}

/** Push, pull, then report usage: "Sync now", `learn sync`, and the background refresh. */
export async function run(root: string, directory: string, learn: LearnConfig): Promise<RunReport> {
  const key = await canonicalRoot(root)
  const ctx = await context(directory, learn)
  if (ctx.status !== "ready") {
    if (ctx.status === "skipped" && ctx.unlinked) {
      const state = await RulesStore.read(root)
      if (state.scope) await RulesStore.reset(root)
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
export async function runShared(root: string, directory: string, learn: LearnConfig): Promise<RunReport> {
  const key = await canonicalRoot(root)
  const existing = inflight.get(key)
  if (existing) return existing
  const started = run(root, directory, learn).finally(() => inflight.delete(key))
  inflight.set(key, started)
  return started
}

/** A run that starts after anything already queued: waits out an in-flight run (which may have pushed
 * already) and starts a new one. */
export async function runFresh(root: string, directory: string, learn: LearnConfig): Promise<RunReport> {
  await inflight.get(await canonicalRoot(root))?.catch(() => undefined)
  return runShared(root, directory, learn)
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
export async function sessionStart(root: string, directory: string, learn: LearnConfig, waitMs = SESSION_WAIT_MS): Promise<void> {
  if (!rulesEnabled(learn)) return
  const existing = inflight.get(await canonicalRoot(root))
  if (!existing && !(await due(root))) return
  const running = (existing ?? runShared(root, directory, learn)).catch((error) => log.warn("rules session sync failed", { error: errorText(error) }))
  await Promise.race([running, new Promise((resolve) => setTimeout(resolve, waitMs).unref?.())])
}

export * as RulesSync from "./sync"
