// altimate_change - new file
//
// Private per-store sync state under `.altimate-code/learn/<store>/` (ignored by the learn `.gitignore`):
//
// - `remote.json`  the last pull: approved team lessons in scope, tombstones, revision, and the scope it belongs to.
// - `outbox.json`  proposals and usage batches waiting to be sent, each stamped with the scope it was created in.
// - `sync.json`    pull/push status, backoff, backfill progress, and the ledger: what the server knows about each
//                  lesson identity (repo_identity, store, lesson_key) — approved, the caller's own pending proposal,
//                  and receipts of earlier submissions.
//
// Every write is atomic, mode 0600, and made under the learn lock. Nothing here does network I/O.
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import path from "node:path"
import z from "zod"
import { canonical } from "./lesson"
import { assertLearnLock } from "./lock"
import * as SafeFS from "./safe-fs"
import * as Store from "./store"
import { BatchItem, LessonOut, Tombstone, UsageItem } from "../workspace/lesson-api"

/** Where lessons sync to: an account (credential digest) on a host and tenant, a workspace, and a repository. */
export const Scope = z.object({
  apiUrl: z.string(),
  tenant: z.string(),
  account: z.string(),
  datamateId: z.number().int(),
  repoRemote: z.string(),
})
export type Scope = z.infer<typeof Scope>
export const scopeKey = (scope: Scope) => JSON.stringify([scope.apiUrl, scope.tenant, scope.account, scope.datamateId, scope.repoRemote])
export const sameScope = (a: Scope | undefined, b: Scope | undefined) => !!a && !!b && scopeKey(a) === scopeKey(b)

/** A lesson's qualified identity. `repo_identity` is server-derived; null means workspace-wide. */
export interface Identity {
  repo_identity: string | null
  store: string
  lesson_key: string
}
export const identityKey = (identity: Identity) => JSON.stringify([identity.repo_identity, identity.store, identity.lesson_key])

/** UTF-8 text hash, as the server computes it. Text is NFKC-normalized before it is hashed or sent. */
export const textHash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")

export const Remote = z.object({
  version: z.literal(1),
  scope: Scope,
  revision: z.number().int(),
  pulled_at: z.string(),
  repo_identity: z.string(),
  share: z.boolean(),
  pending_count: z.number().int().nonnegative(),
  lessons: z.array(LessonOut),
  tombstones: z.array(Tombstone),
})
export type Remote = z.infer<typeof Remote>

const Ref = z.object({ public_id: z.string(), version: z.number().int() })
export const LedgerEntry = z.object({
  approved: Ref.optional(),
  /** `content_hash` changes when the owner edits the proposal; `submission_hash` never does. */
  pending: Ref.extend({ submission_hash: z.string(), content_hash: z.string().optional() }).optional(),
  receipts: z.array(z.object({ submission_hash: z.string(), status: z.string(), public_id: z.string().optional() })).default([]),
})
export type LedgerEntry = z.infer<typeof LedgerEntry>

export const SyncState = z.object({
  version: z.literal(1),
  /** The scope the ledger and backfill belong to; another scope starts both afresh. */
  scope: z.string().optional(),
  last_pull: z.object({ at: z.string(), outcome: z.string(), error: z.string().optional(), latency_ms: z.number().optional() }).optional(),
  last_push: z.object({
    at: z.string(), submitted: z.number(), duplicate: z.number(), conflict: z.number(), deferred: z.number(),
    dropped: z.number().default(0), usage: z.number().default(0), error: z.string().optional(),
  }).optional(),
  /** The server has no lesson routes: retry after this time. */
  unsupported_until: z.string().optional(),
  submissions_cursor: z.string().optional(),
  backfill: z.object({ complete: z.boolean(), done: z.array(z.string()) }).default({ complete: false, done: [] }),
  ledger: z.record(z.string(), LedgerEntry).default({}),
  /** Local lessons the server would refuse as they are (for example grandfathered text over 140 characters). */
  unsyncable: z.record(z.string(), z.string()).default({}),
})
export type SyncState = z.infer<typeof SyncState>

export const Proposal = z.object({
  id: z.string(),
  scope: Scope,
  created_at: z.string(),
  /** `held` waits for `learn push --resubmit`: it conflicted with a change made on the server. */
  state: z.enum(["queued", "held"]),
  reason: z.string().optional(),
  /** Identity (repo_identity at creation, or null when not yet known) of the lesson the item proposes. */
  repo_identity: z.string().nullable(),
  item: BatchItem,
  submission_hash: z.string(),
  /** Identities the proposal supersedes besides its own lesson, so `learn push --resubmit` can rebase them. */
  targets: z.array(z.object({ repo_identity: z.string().nullable(), store: z.string(), lesson_key: z.string() })).default([]),
})
export type Proposal = z.infer<typeof Proposal>

export const UsageBatch = z.object({
  batch_id: z.string(),
  scope: Scope,
  created_at: z.string(),
  items: z.array(UsageItem),
})
export type UsageBatch = z.infer<typeof UsageBatch>

export const Outbox = z.object({
  version: z.literal(1),
  proposals: z.array(Proposal).default([]),
  usage: z.array(UsageBatch).default([]),
})
export type Outbox = z.infer<typeof Outbox>

export function files(root: string, store: string) {
  const dir = Store.paths(root, store).learnDir
  return { remote: path.join(dir, "remote.json"), outbox: path.join(dir, "outbox.json"), sync: path.join(dir, "sync.json") }
}

async function read(root: string, file: string): Promise<string | undefined> {
  try {
    const handle = await SafeFS.open(root, file, constants.O_RDONLY)
    try { return await handle.readFile("utf8") } finally { await handle.close() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

/** A malformed state file reads as absent: sync state is a cache and a queue, rebuilt by the next pull. */
async function readParsed<T>(root: string, file: string, schema: z.ZodType<T>): Promise<T | undefined> {
  const raw = await read(root, file)
  if (raw === undefined) return undefined
  try { return schema.parse(JSON.parse(raw)) } catch { return undefined }
}

async function write(root: string, store: string, file: string, value: unknown) {
  await assertLearnLock(root)
  await SafeFS.mkdir(root, Store.paths(root, store).learnDir)
  await Store.writeAtomic(root, file, canonical(value), 0o600)
}

export const readRemote = (root: string, store: string) => readParsed(root, files(root, store).remote, Remote)
export const writeRemote = (root: string, store: string, remote: Remote) => write(root, store, files(root, store).remote, remote)
export async function removeRemote(root: string, store: string) {
  await assertLearnLock(root)
  await SafeFS.remove(root, files(root, store).remote)
}

export async function readOutbox(root: string, store: string): Promise<Outbox> {
  return (await readParsed(root, files(root, store).outbox, Outbox)) ?? { version: 1, proposals: [], usage: [] }
}
export const writeOutbox = (root: string, store: string, outbox: Outbox) => write(root, store, files(root, store).outbox, outbox)

export async function readSyncState(root: string, store: string): Promise<SyncState> {
  return (await readParsed(root, files(root, store).sync, SyncState)) ?? SyncState.parse({ version: 1 })
}
export const writeSyncState = (root: string, store: string, state: SyncState) => write(root, store, files(root, store).sync, state)

/** The ledger as it stands for `scope`; a different scope's ledger and backfill are discarded, never reused. */
export function forScope(state: SyncState, scope: Scope): SyncState {
  if (state.scope === scopeKey(scope)) return state
  return { ...state, scope: scopeKey(scope), submissions_cursor: undefined, backfill: { complete: false, done: [] }, ledger: {}, unsyncable: {} }
}

/** The pulled cache, only when it was pulled for exactly this scope. */
export async function remoteFor(root: string, store: string, scope: Scope | undefined): Promise<Remote | undefined> {
  if (!scope) return undefined
  const remote = await readRemote(root, store)
  return remote && sameScope(remote.scope, scope) ? remote : undefined
}

const entry = (state: SyncState, key: string): LedgerEntry => (state.ledger[key] ??= { receipts: [] })

/** Record the approved slot from a pull. Unchanged pulls keep it; tombstoned identities lose it. */
export function applyPull(state: SyncState, remote: Remote, changed: boolean) {
  if (changed) {
    const live = new Set<string>()
    for (const lesson of remote.lessons) {
      const key = identityKey({ repo_identity: lesson.repo_identity, store: lesson.store, lesson_key: lesson.lesson_key })
      live.add(key)
      entry(state, key).approved = { public_id: lesson.public_id, version: lesson.version }
    }
    for (const [key, value] of Object.entries(state.ledger)) if (value.approved && !live.has(key)) delete value.approved
  }
  for (const tombstone of remote.tombstones) {
    const value = state.ledger[identityKey(tombstone)]
    if (value) delete value.approved
  }
}

const OPEN = "candidate"

/** Record the caller's own proposals: the open one is the pending slot, every other status is a receipt. */
export function applySubmissions(state: SyncState, store: string, rows: { public_id: string; lesson_key: string; repo_identity: string | null; store: string; status: string; version: number; submission_hash: string; content_hash?: string | null; updated_at: string }[]) {
  for (const row of rows) {
    if (!state.submissions_cursor || row.updated_at > state.submissions_cursor) state.submissions_cursor = row.updated_at
    if (row.store !== store) continue
    const value = entry(state, identityKey(row))
    const receipt = value.receipts.find((r) => r.submission_hash === row.submission_hash)
    if (receipt) Object.assign(receipt, { status: row.status, public_id: row.public_id })
    else value.receipts.push({ submission_hash: row.submission_hash, status: row.status, public_id: row.public_id })
    if (row.status === OPEN)
      value.pending = { public_id: row.public_id, version: row.version, submission_hash: row.submission_hash, ...(row.content_hash ? { content_hash: row.content_hash } : {}) }
    else if (value.pending?.public_id === row.public_id) delete value.pending
  }
}

/** Record a batch item's acknowledgement. */
export function applyResult(state: SyncState, key: string, result: { submission_hash: string; public_id: string; version: number; status: string }) {
  const value = entry(state, key)
  const receipt = value.receipts.find((r) => r.submission_hash === result.submission_hash)
  if (receipt) Object.assign(receipt, { status: result.status, public_id: result.public_id })
  else value.receipts.push({ submission_hash: result.submission_hash, status: result.status, public_id: result.public_id })
  if (result.status === OPEN) value.pending = { public_id: result.public_id, version: result.version, submission_hash: result.submission_hash }
  else if (value.pending?.public_id === result.public_id) delete value.pending
}
