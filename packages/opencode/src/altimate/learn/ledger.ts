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
import { Log } from "@/util/log"
import { canonical } from "./lesson"
import { assertLearnLock } from "./lock"
import * as SafeFS from "./safe-fs"
import * as Store from "./store"
import { BatchItem, LessonOut, MAX_USAGE_ITEMS, Tombstone, UsageItem } from "../workspace/lesson-api"

const log = Log.create({ service: "learn.ledger" })

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
  /** Keyset cursor into the caller's submissions: the last row read, `(updated_at, public_id)`. */
  submissions_cursor: z.string().optional(),
  submissions_after_id: z.string().optional(),
  /** Where the next pull's `local_keys` window starts when the store has more keys than one request carries. */
  local_keys_offset: z.number().int().nonnegative().default(0),
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

/** A malformed cache or sync state reads as absent: both are rebuilt by the next pull. */
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

/** The outbox in `raw`; when it is malformed (`intact: false`), every entry that is still valid. */
function parseOutbox(raw: string): { outbox: Outbox; intact: boolean } {
  let value: unknown
  try { value = JSON.parse(raw) } catch { value = undefined }
  const whole = Outbox.safeParse(value)
  if (whole.success) return { outbox: whole.data, intact: true }
  const fields = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const valid = <T>(list: unknown, schema: z.ZodType<T>) =>
    Array.isArray(list) ? list.flatMap((item) => { const parsed = schema.safeParse(item); return parsed.success ? [parsed.data] : [] }) : []
  return { outbox: { version: 1, proposals: valid(fields.proposals, Proposal), usage: valid(fields.usage, UsageBatch) }, intact: false }
}

/** An outbox as read: `intact: false` when the file was malformed and must be set aside before it is replaced. */
export type ReadOutbox = Outbox & { intact: boolean }

/**
 * The outbox is the only copy of what is waiting to be sent, so a malformed file never reads as empty: it yields
 * its valid entries, and `writeOutbox` sets the file aside (`outbox.json.corrupt-<ms>`) before replacing it.
 * Usage batches over `MAX_USAGE_ITEMS` (queued by an earlier version) are split here, never sent whole.
 */
export async function readOutbox(root: string, store: string): Promise<ReadOutbox> {
  const raw = await read(root, files(root, store).outbox)
  if (raw === undefined) return { version: 1, proposals: [], usage: [], intact: true }
  const { outbox, intact } = parseOutbox(raw)
  if (!intact) log.warn("learn outbox is malformed; using its valid entries", { store, proposals: outbox.proposals.length, usage: outbox.usage.length })
  const usage = outbox.usage.flatMap((batch) => usageBatches(batch.batch_id, batch.scope, batch.created_at, batch.items))
  return { ...outbox, usage, intact }
}

/** `outbox` is what `readOutbox` returned, changed; a malformed file it was read from is kept aside first. */
export async function writeOutbox(root: string, store: string, outbox: Outbox & { intact?: boolean }) {
  await assertLearnLock(root)
  const file = files(root, store).outbox
  const { intact, ...value } = outbox
  if (intact === false) {
    const aside = `${file}.corrupt-${Date.now()}`
    const moved = await SafeFS.rename(root, file, aside).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false
      throw error
    })
    if (moved) log.warn("learn outbox was malformed; kept a copy and started a new one", { store, file: path.basename(aside) })
  }
  await write(root, store, file, value)
  // Set aside once: a second write from the same read must not move the new file.
  if (intact === false) outbox.intact = true
}

export async function readSyncState(root: string, store: string): Promise<SyncState> {
  return (await readParsed(root, files(root, store).sync, SyncState)) ?? SyncState.parse({ version: 1 })
}
export const writeSyncState = (root: string, store: string, state: SyncState) => write(root, store, files(root, store).sync, state)

/** The ledger as it stands for `scope`; a different scope's ledger and backfill are discarded, never reused. */
export function forScope(state: SyncState, scope: Scope): SyncState {
  if (state.scope === scopeKey(scope)) return state
  return { ...state, scope: scopeKey(scope), submissions_cursor: undefined, submissions_after_id: undefined, backfill: { complete: false, done: [] }, ledger: {}, unsyncable: {}, unsupported_until: undefined }
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
    const cursor = state.submissions_cursor
    if (!cursor || row.updated_at > cursor || (row.updated_at === cursor && row.public_id > (state.submissions_after_id ?? ""))) {
      state.submissions_cursor = row.updated_at
      state.submissions_after_id = row.public_id
    }
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

/** A stable RFC 4122-shaped id from a hex digest (the server only requires a UUID for `batch_id`). */
export function uuidFrom(hex: string): string {
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/**
 * Usage items as outbox batches of at most `MAX_USAGE_ITEMS`. The server keys its receipt on `batch_id`, so
 * each chunk gets its own id, derived from `id` and the chunk index; a single chunk keeps `id` itself.
 */
export function usageBatches(id: string, scope: Scope, created_at: string, items: readonly z.infer<typeof UsageItem>[]): UsageBatch[] {
  if (items.length <= MAX_USAGE_ITEMS) return [{ batch_id: id, scope, created_at, items: [...items] }]
  const batches: UsageBatch[] = []
  for (let start = 0; start < items.length; start += MAX_USAGE_ITEMS)
    batches.push({
      batch_id: uuidFrom(createHash("sha256").update(`${id}\0${start / MAX_USAGE_ITEMS}`).digest("hex")),
      scope, created_at, items: items.slice(start, start + MAX_USAGE_ITEMS),
    })
  return batches
}
