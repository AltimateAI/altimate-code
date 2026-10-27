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
import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { canonical, type Lesson } from "../learn/lesson"
import { withLearnLock } from "../learn/lock"
import * as Store from "../learn/store"
import { RuleOut, Settings } from "./api"

/** The read-only store team rules are mirrored into. */
export const TEAM_STORE = "team"
const LOCK = { timeoutMs: 5_000 }
const MAX_NOTICES = 50
const MAX_SENT = 200
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
  /** Set once `learn bootstrap` proposed rules from history for this scope. */
  bootstrapped_at: z.string().optional(),
})
export type State = z.infer<typeof State>

const EMPTY: State = State.parse({ version: 1 })

export function dir(root: string) {
  return Store.paths(root, TEAM_STORE).learnDir
}
const stateFile = (root: string) => path.join(dir(root), "rules.json")

export async function read(root: string): Promise<State> {
  const raw = await fs.readFile(stateFile(root), "utf8").catch(() => undefined)
  if (!raw) return structuredClone(EMPTY)
  try {
    return State.parse(JSON.parse(raw))
  } catch {
    return structuredClone(EMPTY)
  }
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

async function ensureDir(root: string) {
  await fs.mkdir(dir(root), { recursive: true })
  const ignore = path.join(dir(root), ".gitignore")
  // The mirror and the client state are per person and per account: never commit them.
  await fs.writeFile(ignore, "*\n", { flag: "wx" }).catch(() => {})
}

/** Read-modify-write under the learn lock. `change` may return a new state or mutate the one given. */
export async function update(root: string, change: (state: State) => State | void): Promise<State> {
  await ensureDir(root)
  return withLearnLock(root, async () => {
    const current = await read(root)
    const next = change(current) ?? current
    next.notices = next.notices.slice(-MAX_NOTICES)
    next.sent = next.sent.slice(-MAX_SENT)
    next.usage_sessions = next.usage_sessions.slice(-1000)
    next.processed_signals = next.processed_signals.slice(-1000)
    const now = Date.now()
    next.dismissed = next.dismissed.filter((d) => Date.parse(d.until) > now)
    await Store.writeAtomic(root, stateFile(root), JSON.stringify(next, null, 2) + "\n")
    await writeMirror(root, next.rules)
    return next
  }, LOCK)
}

async function writeMirror(root: string, rules: readonly RuleOut[]) {
  const file = Store.paths(root, TEAM_STORE).approved
  const text = canonical(rules.map(toLesson))
  const previous = await fs.readFile(file, "utf8").catch(() => undefined)
  if (previous !== text) await Store.writeAtomic(root, file, text)
}

/** Forget everything pulled for another scope (account, workspace or remote changed) or after unlinking. */
export async function reset(root: string): Promise<void> {
  await update(root, (state) => ({ ...structuredClone(EMPTY), dismissed: state.dismissed }))
}

export function dismissed(state: State, topic: string): boolean {
  return state.dismissed.some((d) => d.topic === topic.toLowerCase())
}

export * as RulesStore from "./store"
