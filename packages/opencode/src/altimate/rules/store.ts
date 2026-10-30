// altimate_change - new file
//
// Local state for workspace rules, under `.altimate-code/learn/workspace-rules/` (git-ignored):
//
// - `approved.json`: the workspace's approved rules for this repository, as lessons of the read-only
//   `workspace-rules` store (a name reserved for it; the person's own stores, `team` included, are separate). Delivery, recurrence and `learn show` read it like any other store, so team rules reach the
//   prompt ("Team rules"), their exposure is recorded, and "corrected again" falls out of recurrence.
//   Only a pull writes it; reflection and promotion never target this store.
// - `rules.json`: everything else this client keeps: the scope it was pulled for, workspace and owner,
//   settings, revision and review cursor, the outbox of proposals not yet sent, the person's sent
//   proposals and review notices, dismissed topics, and what usage has been reported.
//
// Writes take the learn lock (delivery reads the same directory) and are atomic.
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import * as SafeFS from "../learn/safe-fs"
import { Log } from "@/util/log"
import { canonical, parse as parseLessons, type Lesson } from "../learn/lesson"
import { withLearnLock } from "../learn/lock"
import * as Store from "../learn/store"
import { RuleOut, Settings } from "./api"

/** The read-only store team rules are mirrored into (reserved: `learn/store.ts` `RESERVED_STORES`). */
export const WORKSPACE_RULES_STORE = Store.WORKSPACE_RULES_STORE
const log = Log.create({ service: "rules.store" })
const LOCK = { timeoutMs: 5_000 }
const MAX_NOTICES = 50
const MAX_SENT = 200
/** Safety cap for the signal id list; `processed_signals` is also pruned to live signals. */
const MAX_TRACKED = 5000
/** How long the "queued proposals were dropped" notice of an account or workspace change stays shown. */
const SCOPE_DROP_NOTICE_MS = 7 * 24 * 60 * 60_000
/** "Not a rule" keeps a topic from being proposed again in this repository for this long. */
export const DISMISS_MS = 30 * 24 * 60 * 60_000

export const Scope = z.object({
  apiUrl: z.string(),
  tenant: z.string(),
  account: z.string(),
  datamateId: z.number().int(),
  repoRemote: z.string(),
})
export type Scope = z.infer<typeof Scope>
export const sameScope = (a: Scope | undefined, b: Scope | undefined) =>
  !!a && !!b && JSON.stringify([a.apiUrl, a.tenant, a.account, a.datamateId, a.repoRemote]) ===
    JSON.stringify([b.apiUrl, b.tenant, b.account, b.datamateId, b.repoRemote])

export const OutboxItem = z.object({
  id: z.string(),
  created_at: z.string(),
  attempts: z.number().int().default(0),
  last_error: z.string().optional(),
  /** The `ProposalItem` sent to `/proposals`. */
  item: z.object({
    change: z.enum(["add", "edit", "retire"]),
    text: z.string(),
    applies_to: z.array(z.string()),
    why: z.string().optional(),
    origin: z.enum(["session", "explicit", "bootstrap", "import_reviews"]),
    replaces: z.string().optional(),
    replaces_version: z.number().int().optional(),
    evidence_sessions: z.number().int(),
    corrections: z.array(z.object({ excerpt: z.string(), corrected_at: z.string(), session_ref: z.string().optional() })),
  }),
  /** Set by "Approve now": approve once the proposal is stored. */
  approve: z.enum(["approve", "approve_anyway"]).optional(),
})
export type OutboxItem = z.infer<typeof OutboxItem>

export const Sent = z.object({
  public_id: z.string(),
  text: z.string(),
  change: z.string(),
  status: z.string(),
  reason: z.string().optional(),
  reviewer: z.string().optional(),
  sent_at: z.string(),
  updated_at: z.string(),
})
export type Sent = z.infer<typeof Sent>

export const Notice = z.object({
  public_id: z.string(),
  status: z.string(),
  text: z.string(),
  reason: z.string().optional(),
  reviewer: z.string().optional(),
  at: z.string(),
})
export type Notice = z.infer<typeof Notice>

/** A "remember …" the person asked for, shown as a card and not yet answered: kept on disk so it is saved as before
 * cards even if the process that showed the card dies (`RulesRemember.recoverRequests`). Removed once the card is
 * answered, or its fallback ran. */
export const RememberRequest = z.object({
  card: z.string(),
  text: z.string(),
  session: z.string(),
  /** The instance directory that asked: the request is saved into that project. */
  directory: z.string(),
  via: z.enum(["training", "memory"]),
  /** The memory tool's block (`via: "memory"`). */
  memory: z.object({ id: z.string(), tags: z.array(z.string()) }).optional(),
  /** `training_save`'s entry (`via: "training"`). */
  training: z.object({ name: z.string(), source: z.string().optional(), citations: z.array(z.unknown()).optional() }).optional(),
  /** The process that shows the card: while it lives, its own fallback saves the request. */
  pid: z.number().int(),
  at: z.string(),
})
export type RememberRequest = z.infer<typeof RememberRequest>
/** Requests kept at most; the oldest beyond it are dropped (each is also bounded by its card's day). */
const MAX_REMEMBER_REQUESTS = 50

export const State = z.object({
  version: z.literal(1),
  scope: Scope.optional(),
  workspace: z.object({ name: z.string(), owner_name: z.string().nullable().optional(), is_owner: z.boolean() }).optional(),
  settings: Settings.optional(),
  revision: z.number().int().optional(),
  cursor: z.string().optional(),
  pending_count: z.number().int().default(0),
  pulled_at: z.string().optional(),
  last_error: z.string().optional(),
  /** Queued proposals dropped because the account or workspace changed. Its own field: a later pull's error (or its
   * success) does not erase it. Shown for `SCOPE_DROP_NOTICE_MS`. */
  scope_drop: z.object({ count: z.number().int(), at: z.string() }).optional(),
  rules: z.array(RuleOut).default([]),
  outbox: z.array(OutboxItem).default([]),
  sent: z.array(Sent).default([]),
  notices: z.array(Notice).default([]),
  dismissed: z.array(z.object({ topic: z.string(), until: z.string() })).default([]),
  /** (session, rule version) pairs already reported as `applied`, as `session|public_id`: a session keeps showing
   * rules on later turns (requests, files), and each rule it showed counts once. Kept while the session has a snapshot
   * file (`reportUsage` prunes the rest), never trimmed by count: a trimmed live pair would be counted again. */
  usage_reported: z.array(z.string()).default([]),
  /** Per rule, the "corrected again" count already reported. */
  corrected_reported: z.record(z.string(), z.number().int()).default({}),
  /** What the last post-turn check decided, for `learn status`. */
  last_check: z.object({ at: z.string(), session: z.string(), outcome: z.string() }).optional(),
  /** Correction signals already considered for a proposal. */
  processed_signals: z.array(z.string()).default([]),
  /** The person's own "learning from sessions" choice for this project (`/rules`), when they made one. Kept here,
   * not in the project config, because that file is usually committed and the choice is per person. */
  personal_learning: z.boolean().optional(),
  /** The last push outcome per outbox id, so a card can tell what happened to its proposal even when another run (the
   * timer, a session start, `learn sync`) sent it. Capped. */
  push_outcomes: z.record(z.string(), z.object({
    status: z.string(),
    public_id: z.string().optional(),
    error: z.string().optional(),
    error_code: z.string().optional(),
    approved: z.boolean().optional(),
    approve_error: z.string().optional(),
    approve_retry: z.boolean().optional(),
  })).default({}),
  /** "Approve now" calls that failed for a reason that can pass (network, 5xx, credential): retried on the next push. */
  pending_approvals: z.array(z.object({
    public_id: z.string(),
    version: z.number().int(),
    action: z.enum(["approve", "approve_anyway"]),
    attempts: z.number().int().default(0),
  })).default([]),
  remember_requests: z.array(RememberRequest).default([]),
  /** A usage report sent but not yet acknowledged: resent with the same `batch_id` so the server counts it once. */
  pending_usage: z.object({
    batch_id: z.string(),
    items: z.array(z.object({ public_id: z.string(), applied: z.number().int(), helpful: z.number().int(), harmful: z.number().int(), corrected_again: z.number().int() })),
    pairs: z.array(z.string()),
    corrected: z.record(z.string(), z.number().int()),
  }).optional(),
})
export type State = z.infer<typeof State>

const EMPTY: State = State.parse({ version: 1 })

export function dir(root: string) {
  return Store.paths(root, WORKSPACE_RULES_STORE).learnDir
}
const stateFile = (root: string) => path.join(dir(root), "rules.json")

/** The state file's text, or undefined when there is none. Other read errors propagate. */
async function readRaw(root: string): Promise<string | undefined> {
  return fs.readFile(stateFile(root), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
}


function parse(raw: string | undefined): State | undefined {
  if (!raw) return structuredClone(EMPTY)
  try {
    return State.parse(JSON.parse(raw))
  } catch {
    return undefined
  }
}

/** The client state. A file this version cannot parse reads as empty; `update` sets it aside before writing. */
export async function read(root: string): Promise<State> {
  return parse(await readRaw(root)) ?? structuredClone(EMPTY)
}

/** The lesson id a team rule is delivered and attributed under. */
export const lessonId = (ruleKey: string) => `L-${ruleKey.slice(2)}`

export function toLesson(rule: RuleOut): Lesson {
  return {
    id: lessonId(rule.rule_key),
    text: rule.text,
    tags: rule.tags,
    scope: "project",
    ...(rule.pinned ? { pinned: true } : {}),
    ...(rule.applies_to.length ? { trigger: { paths: rule.applies_to } } : {}),
    helpful: 0,
    harmful: 0,
    applied: 0,
    created: rule.updated_at,
    updated: rule.updated_at,
    provenance: `workspace rule ${rule.public_id}`,
  }
}

const IGNORE = "*\n"

/** Under the learn lock. The parent learn ignore already keeps `rules.json` out of Git but shares each store's
 * `approved.json`, so the mirror needs this one too (whatever an older file said). Written with the mirror only,
 * so a project without a workspace never gets it. */
async function ensureIgnore(root: string) {
  const ignore = path.join(dir(root), ".gitignore")
  const current = await SafeFS.open(root, ignore, constants.O_RDONLY)
    .then(async (handle) => { try { return await handle.readFile("utf8") } finally { await handle.close() } })
    .catch(() => undefined)
  if (current !== IGNORE) await Store.writeAtomic(root, ignore, IGNORE)
}

/** Keep every pending proposal; cap only the ones the owner already settled. */
function capSent(sent: Sent[]): Sent[] {
  const settled = sent.filter((s) => s.status !== "pending")
  const drop = new Set(settled.slice(0, Math.max(0, settled.length - MAX_SENT)))
  return sent.filter((s) => !drop.has(s))
}

/** Read-modify-write under the learn lock. `change` may return a new state or mutate the one given. */
export async function update(root: string, change: (state: State) => State | void): Promise<State> {
  return withLearnLock(root, async () => {
    await SafeFS.mkdir(root, dir(root))
    const raw = await readRaw(root)
    let current = parse(raw)
    if (!current) {
      // Written by another version or damaged: keep it for inspection rather than overwrite it.
      await Store.writeAtomic(root, `${stateFile(root)}.unreadable-${Date.now()}`, raw!, 0o600)
      current = structuredClone(EMPTY)
    }
    const rulesBefore = JSON.stringify(current.rules)
    const next = change(current) ?? current
    next.notices = next.notices.slice(-MAX_NOTICES)
    next.sent = capSent(next.sent)
    next.processed_signals = next.processed_signals.slice(-MAX_TRACKED)
    next.remember_requests = next.remember_requests.slice(-MAX_REMEMBER_REQUESTS)
    const now = Date.now()
    next.dismissed = next.dismissed.filter((d) => Date.parse(d.until) > now)
    if (next.scope_drop && !scopeDropShown(next.scope_drop, now)) delete next.scope_drop
    await Store.writeAtomic(root, stateFile(root), JSON.stringify(next, null, 2) + "\n")
    // Only a linked project (or one whose rules just changed, e.g. a reset) has a mirror to write: in a project with no
    // workspace, only the state file is written (a dismissal, a learning choice), never an `approved.json` that delivery
    // would read. A mirror left behind by a write that failed after the state was saved (or by an unreadable state set
    // aside) no longer matches the state: it is rewritten, so rules nothing vouches for stop being delivered.
    const staleMirror = !next.workspace && JSON.stringify(next.rules) === rulesBefore && (await mirrorDiffers(root, next.rules))
    if (next.workspace || JSON.stringify(next.rules) !== rulesBefore || staleMirror) {
      await ensureIgnore(root)
      await writeMirror(root, next.rules)
    }
    return next
  }, LOCK)
}

/** An existing mirror (not someone's own playbook) whose rules are not `rules`. */
async function mirrorDiffers(root: string, rules: readonly RuleOut[]) {
  const previous = await fs.readFile(Store.paths(root, WORKSPACE_RULES_STORE).approved, "utf8").catch(() => undefined)
  if (previous === undefined || !isMirror(previous)) return false
  return canonical(parseLessons(previous)) !== canonical(rules.map(toLesson))
}

async function writeMirror(root: string, rules: readonly RuleOut[]) {
  const file = Store.paths(root, WORKSPACE_RULES_STORE).approved
  const text = canonical(rules.map(toLesson))
  const previous = await fs.readFile(file, "utf8").catch(() => undefined)
  if (previous === text) return
  // A playbook someone named `workspace-rules` before workspace rules existed: keep a copy instead of overwriting it.
  if (previous !== undefined && !isMirror(previous)) {
    const backup = `${file}.before-workspace-rules-${Date.now()}`
    await Store.writeAtomic(root, backup, previous, 0o600)
    log.warn("an existing `workspace-rules` store was set aside for the workspace team rules", { backup })
  }
  await Store.writeAtomic(root, file, text)
}

/** Whether an `approved.json` is this mirror: every entry came from a workspace rule. An empty list is written by the
 * mirror itself (no rules yet, or the last one retired), and holds nothing to keep either way. */
function isMirror(text: string): boolean {
  try {
    const lessons = parseLessons(text)
    return lessons.every((lesson) => lesson.provenance?.startsWith("workspace rule "))
  } catch {
    return false
  }
}

/**
 * Forget what was pulled. The person's dismissals and own learning choice always survive. Queued proposals survive
 * too when the scope did not change (`keepOutbox`: the link went away or access was refused, possibly for a while);
 * `adopt` drops them before anything is sent to a different scope.
 */
export async function reset(root: string, options: { keepOutbox?: boolean } = {}): Promise<void> {
  await update(root, (state) => cleared(state, options))
}

/** `reset` as a state change, for a caller that decides inside its own `update` (`adopt`). */
export function cleared(state: State, options: { keepOutbox?: boolean } = {}): State {
  return {
    ...structuredClone(EMPTY),
    dismissed: state.dismissed,
    ...(state.personal_learning !== undefined ? { personal_learning: state.personal_learning } : {}),
    // What was already reported or considered stays: after a relink or an account round trip it must not be counted
    // again (sessions and signals are local; corrected counts are keyed by rule key).
    usage_reported: state.usage_reported,
    corrected_reported: state.corrected_reported,
    processed_signals: state.processed_signals,
    // A batch built for this scope can only be resent to it.
    // The same scope comes back (the link or access returns): its queue, approvals, the person's sent history and the
    // review cursor stay, so reviews made meanwhile are still announced.
    ...(options.keepOutbox
      ? {
          outbox: state.outbox,
          scope: state.scope,
          pending_approvals: state.pending_approvals,
          sent: state.sent,
          ...(state.cursor ? { cursor: state.cursor } : {}),
          ...(state.pending_usage ? { pending_usage: state.pending_usage } : {}),
        }
      : {}),
    // A drop notice outlives a later reset: it is about proposals the person was told were queued.
    ...(state.scope_drop ? { scope_drop: state.scope_drop } : {}),
    // A "remember" is saved locally whatever the workspace: no reset loses it.
    remember_requests: state.remember_requests,
  }
}

const scopeDropShown = (drop: NonNullable<State["scope_drop"]>, now: number) => now - Date.parse(drop.at) < SCOPE_DROP_NOTICE_MS

/** The notice for proposals dropped by an account or workspace change, while it is shown. Checked on read: a project
 * nothing writes to any more (unlinked) still stops showing it. */
export function scopeDropNote(state: State, now = Date.now()): string | undefined {
  const drop = state.scope_drop
  if (!drop || !scopeDropShown(drop, now)) return undefined
  return `${drop.count} queued ${drop.count === 1 ? "proposal was" : "proposals were"} for another account or workspace and ${drop.count === 1 ? "was" : "were"} not sent`
}

/** Queued proposals at most; a new one is refused (the card stays open) rather than an older one dropped. */
export const MAX_OUTBOX = 200

/** Whether `topic` is dismissed now. Expired entries are dropped on the next write, and do not count before it. */
export function dismissed(state: State, topic: string, now = Date.now()): boolean {
  return state.dismissed.some((d) => d.topic === topic.toLowerCase() && Date.parse(d.until) > now)
}

export * as RulesStore from "./store"
