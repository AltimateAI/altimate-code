// altimate_change - new file
//
// Local state for workspace rules, under `.altimate-code/learn/team/` (git-ignored):
//
// - `approved.json`: the workspace's approved rules for this repository, as lessons of a read-only `team`
//   store. Delivery, recurrence and `learn show` read it like any other store, so team rules reach the
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
export const TEAM_STORE = "team"
const log = Log.create({ service: "rules.store" })
const LOCK = { timeoutMs: 5_000 }
const MAX_NOTICES = 50
const MAX_SENT = 200
/** Safety cap for the session and signal id lists; `processed_signals` is also pruned to live signals. */
const MAX_TRACKED = 5000
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
  rules: z.array(RuleOut).default([]),
  outbox: z.array(OutboxItem).default([]),
  sent: z.array(Sent).default([]),
  notices: z.array(Notice).default([]),
  dismissed: z.array(z.object({ topic: z.string(), until: z.string() })).default([]),
  /** Sessions whose deliveries were already reported as `applied`. */
  usage_sessions: z.array(z.string()).default([]),
  /** Per rule, the "corrected again" count already reported. */
  corrected_reported: z.record(z.string(), z.number().int()).default({}),
  /** What the last post-turn check decided, for `learn status`. */
  last_check: z.object({ at: z.string(), session: z.string(), outcome: z.string() }).optional(),
  /** Correction signals already considered for a proposal. */
  processed_signals: z.array(z.string()).default([]),
  /** The person's own "learning from sessions" choice for this project (`/rules`), when they made one. Kept here,
   * not in the project config, because that file is usually committed and the choice is per person. */
  personal_learning: z.boolean().optional(),
  /** "Approve now" calls that failed for a reason that can pass (network, 5xx, credential): retried on the next push. */
  pending_approvals: z.array(z.object({
    public_id: z.string(),
    version: z.number().int(),
    action: z.enum(["approve", "approve_anyway"]),
    attempts: z.number().int().default(0),
  })).default([]),
  /** A usage report sent but not yet acknowledged: resent with the same `batch_id` so the server counts it once. */
  pending_usage: z.object({
    batch_id: z.string(),
    items: z.array(z.object({ public_id: z.string(), applied: z.number().int(), helpful: z.number().int(), harmful: z.number().int(), corrected_again: z.number().int() })),
    sessions: z.array(z.string()),
    corrected: z.record(z.string(), z.number().int()),
  }).optional(),
})
export type State = z.infer<typeof State>

const EMPTY: State = State.parse({ version: 1 })

export function dir(root: string) {
  return Store.paths(root, TEAM_STORE).learnDir
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
    let recovered = false
    if (!current) {
      // Written by another version or damaged: keep it for inspection rather than overwrite it.
      await Store.writeAtomic(root, `${stateFile(root)}.unreadable-${Date.now()}`, raw!, 0o600)
      current = structuredClone(EMPTY)
      recovered = true
    }
    const rulesBefore = JSON.stringify(current.rules)
    const next = change(current) ?? current
    next.notices = next.notices.slice(-MAX_NOTICES)
    next.sent = capSent(next.sent)
    next.usage_sessions = next.usage_sessions.slice(-MAX_TRACKED)
    next.processed_signals = next.processed_signals.slice(-MAX_TRACKED)
    const now = Date.now()
    next.dismissed = next.dismissed.filter((d) => Date.parse(d.until) > now)
    await Store.writeAtomic(root, stateFile(root), JSON.stringify(next, null, 2) + "\n")
    // Only a linked project (or one whose rules just changed, e.g. a reset) has a mirror to write: a project with no
    // workspace must not have its `team` directory touched. After an unreadable state was set aside, an existing
    // mirror no longer matches any state: rewrite it, so rules nothing vouches for stop being delivered.
    const staleMirror = recovered && (await fs.access(Store.paths(root, TEAM_STORE).approved).then(() => true, () => false))
    if (next.workspace || JSON.stringify(next.rules) !== rulesBefore || staleMirror) {
      await ensureIgnore(root)
      await writeMirror(root, next.rules)
    }
    return next
  }, LOCK)
}

async function writeMirror(root: string, rules: readonly RuleOut[]) {
  const file = Store.paths(root, TEAM_STORE).approved
  const text = canonical(rules.map(toLesson))
  const previous = await fs.readFile(file, "utf8").catch(() => undefined)
  if (previous === text) return
  // A playbook someone named `team` before workspace rules existed: keep a copy instead of overwriting it.
  if (previous !== undefined && !isMirror(previous)) {
    const backup = `${file}.before-workspace-rules-${Date.now()}`
    await Store.writeAtomic(root, backup, previous, 0o600)
    log.warn("an existing `team` rule store was set aside for the workspace team rules", { backup })
  }
  await Store.writeAtomic(root, file, text)
}

/** Whether an `approved.json` is this mirror: every entry came from a workspace rule. */
function isMirror(text: string): boolean {
  try {
    return parseLessons(text).every((lesson) => lesson.provenance?.startsWith("workspace rule "))
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
  await update(root, (state) => ({
    ...structuredClone(EMPTY),
    dismissed: state.dismissed,
    ...(state.personal_learning !== undefined ? { personal_learning: state.personal_learning } : {}),
    // What was already reported or considered stays: after a relink or an account round trip it must not be counted
    // again (sessions and signals are local; corrected counts are keyed by rule key).
    usage_sessions: state.usage_sessions,
    corrected_reported: state.corrected_reported,
    processed_signals: state.processed_signals,
    // A batch built for this scope can only be resent to it.
    ...(options.keepOutbox ? { outbox: state.outbox, scope: state.scope, ...(state.pending_usage ? { pending_usage: state.pending_usage } : {}) } : {}),
  }))
}

/** Queued proposals at most; a new one is refused (the card stays open) rather than an older one dropped. */
export const MAX_OUTBOX = 200

export function dismissed(state: State, topic: string): boolean {
  return state.dismissed.some((d) => d.topic === topic.toLowerCase())
}

export * as RulesStore from "./store"
