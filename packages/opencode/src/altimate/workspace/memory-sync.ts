// altimate_change - new file
//
// Mirrors Altimate Code memory blocks to the workspace memory store, and loads
// a workspace's memory back into a session.
//
// Additive by design: the local Markdown files remain authoritative and every
// operation here is fire-and-forget, so a cloud failure can neither fail nor
// slow a local memory save.
//
// Write — a saved block is pushed to the store, tagged with the workspace the
// project is bound to. A create is followed by an update that restores the text
// verbatim, because a create runs an extractor that rewrites it. Blocks the
// extractor declines are left unindexed so a later edit retries them.
//
// Read — one fetch per session, held in memory and merged at injection time.
// Nothing is written to disk: local files are the source of truth, and a cloud
// record can have been edited elsewhere by a client that does not preserve this
// CLI's metadata.
import { createHash } from "node:crypto"
import { Flag as CoreFlag } from "@opencode-ai/core/flag/flag"
import { Flag } from "@/flag/flag"
import { Instance } from "@/project/instance"
import { Log } from "@/altimate/util/log"
import type { MemoryBlock } from "@/memory/types"
import { TRAINING_META_COMMENT } from "@/altimate/training/types"
import { readLocalBinding, type CachedBinding } from "./state"
import { indexKey, readIndex, readIndexEntry, recordIndexEntry } from "./memory-index"
import { WorkspaceApi } from "./api-client"
import {
  LIST_LIMIT,
  MemoryApi,
  MIRROR_SOURCE,
  isArchived,
  isMirrorRecord,
  type CloudMemoryRecord,
  type MirrorMetadata,
} from "./memory-api"

const log = Log.create({ service: "altimate-workspace-memory-sync" })

/** How long an injection waits on an in-flight hydration before proceeding
 * without it. Sessions are often a single turn, so injecting one turn late
 * would read as the feature not working; blocking on the full request budget
 * would be worse. */
const HYDRATION_WAIT_MS = 3_000

/** Parallelism for the bind-time backfill. Low on purpose: a backfill can be
 * every block the machine holds, and each create costs an LLM pass server-side. */
const BACKFILL_CONCURRENCY = 2

/** A cloud block merged into a session's injection. */
export interface RemoteMemoryBlock extends MemoryBlock {
  /** Marks the block as cloud-sourced. A remote training block must never
   * drive TrainingStore.incrementApplied, which writes to the LOCAL store and
   * would fabricate a file for a block this machine never had. */
  remote: true
  /** Human-readable origin, when the block came from a different project in
   * the same workspace. Absent for this project's own blocks and for globals. */
  origin?: string
}

/** Per-session hydration state.
 *
 * Keyed by session id rather than held in module scope: the server runs
 * concurrent sessions, potentially in different projects bound to different
 * workspaces, and a single shared overlay would let one session read another's
 * workspace memory. Binding resolution needs no such keying — ``Instance`` is
 * AsyncLocalStorage-backed, so ``Instance.directory`` is already correct for
 * whichever session's async context is running. */
interface SessionMemory {
  overlay: RemoteMemoryBlock[]
  hydration: Promise<void> | null
  touchedAt: number
  /** Set once a bounded wait expired, so later injections do not re-wait. */
  waitTimedOut?: boolean
  /** Set when the last fetch for this session failed, so a caller can tell an
   * empty workspace apart from an unreadable one. */
  hydrateFailed?: boolean
}

const sessions = new Map<string, SessionMemory>()

/** Sessions are evicted oldest-first rather than on a session-end hook, which
 * does not exist here. Well above any plausible concurrent-session count, and
 * an eviction only costs a refetch. */
const MAX_TRACKED_SESSIONS = 32

function sessionState(sessionID: string): SessionMemory {
  let state = sessions.get(sessionID)
  if (!state) {
    if (sessions.size >= MAX_TRACKED_SESSIONS) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0]
      if (oldest) sessions.delete(oldest[0])
    }
    state = { overlay: [], hydration: null, touchedAt: Date.now() }
    sessions.set(sessionID, state)
  }
  state.touchedAt = Date.now()
  return state
}

/** The mirror rides the workspace pilot flag and honours the memory opt-out.
 * Never active for anyone who has not opted into the pilot. */
export function isEnabled(): boolean {
  return CoreFlag.ALTIMATE_WORKSPACE && !Flag.ALTIMATE_DISABLE_MEMORY
}

/** Test seam. Production leaves this unset and resolves the binding from the
 * active instance; tests set it so they need not boot one. */
export const syncInternals: {
  resolveBinding?: () => Promise<CachedBinding | null>
  /** Test seam for the local-existence check. Production reads the store. */
  blockExists?: (block: MemoryBlock, directory?: string) => Promise<boolean>
} = {}

/** Instance.directory throws synchronously with no instance context, so a
 * trailing .catch() on a promise built from it never fires. */
function currentDirectory(): string | null {
  try {
    return Instance.directory
  } catch {
    return null
  }
}

export function projectKeyFor(binding: CachedBinding): string {
  return binding.repoRemote ?? binding.projectPath ?? "unknown"
}

async function currentBinding(): Promise<CachedBinding | null> {
  if (syncInternals.resolveBinding) return syncInternals.resolveBinding()
  const directory = currentDirectory()
  if (!directory) return null
  try {
    return await readLocalBinding(directory)
  } catch (err) {
    log.warn("could not resolve binding for memory mirror", { err: String(err) })
    return null
  }
}

/** How long an ENABLED workspace is trusted before re-checking. Without this
 * every memory write would cost a workspace lookup, including writes that turn
 * out to be no-ops.
 *
 * Only positives are cached. A workspace starts with memory disabled, so
 * caching that verdict would leave the CLI ignoring the setting for a full TTL
 * after the user switches it on — and a disabled workspace writes nothing, so
 * re-checking it costs a lookup on an operation that was going to be a no-op
 * anyway. */
const MEMORY_ENABLED_TTL_MS = 60_000

const memoryEnabledCache = new Map<number, { checkedAt: number }>()

/** Warn once per workspace, not once per write. */
const missingFieldWarned = new Set<number>()

/** Whether the bound workspace has memory switched on.
 *
 * The workspace app exposes this as a user-facing toggle, so mirroring into a
 * workspace with memory disabled would contradict what the user is shown.
 * Fails closed: if the check cannot be made, nothing is mirrored. */
async function memoryEnabled(binding: CachedBinding): Promise<boolean> {
  const cached = memoryEnabledCache.get(binding.datamateId)
  if (cached && Date.now() - cached.checkedAt < MEMORY_ENABLED_TTL_MS) return true
  try {
    const workspaces = await WorkspaceApi.listDatamates()
    const match = workspaces.find((w) => w.id === binding.datamateId)
    if (match && match.memoryEnabled === undefined && !missingFieldWarned.has(binding.datamateId)) {
      // Fail-closed is right, but a backend that has not shipped the field
      // turns the whole feature into a silent no-op. Say so once.
      missingFieldWarned.add(binding.datamateId)
      log.warn("workspace has no memory_enabled field; treating memory as disabled", {
        workspace: binding.datamateId,
      })
    }
    const value = match?.memoryEnabled === true
    if (value) memoryEnabledCache.set(binding.datamateId, { checkedAt: Date.now() })
    else memoryEnabledCache.delete(binding.datamateId)
    return value
  } catch (err) {
    log.warn("could not confirm workspace memory setting, skipping mirror", { err: String(err) })
    // Not cached either way: a transient failure should neither disable the
    // mirror for a minute nor keep it enabled. Failing closed already prevents
    // this particular write.
    return false
  }
}

/** Strips the training metadata comment.
 *
 * TrainingStore.incrementApplied rewrites a training block on EVERY session
 * start to bump a counter embedded in that comment. Mirroring those rewrites
 * would fire a request per training block per session for a change no reader
 * can see, so the counter is normalised away before hashing. */
function stripTrainingMeta(content: string): string {
  return content.replace(TRAINING_META_COMMENT, "").trim()
}

/** Fingerprint of everything about a block that reaches the store. Tags and
 * expiry are included because both are mirrored. */
function contentHash(block: MemoryBlock): string {
  const payload = JSON.stringify([
    stripTrainingMeta(block.content),
    [...block.tags].sort(),
    block.expires ?? "",
  ])
  // sha-256, not a 32-bit non-cryptographic hash. This value is the single
  // gate deciding whether a save is sent at all: on a collision ``push``
  // returns "unchanged" and a real edit is silently never mirrored, with no
  // retry. A 32-bit space makes that reachable; node:crypto is already a
  // dependency of this feature (see ./memory-index.ts).
  return createHash("sha256").update(payload).digest("hex")
}

/** Read tags written by {@link buildMetadata}.
 *
 * Accepts the legacy comma-joined form so records written before the JSON
 * encoding still load; those cannot represent a tag containing a comma, which
 * is the defect the JSON form fixes. */
export function decodeTags(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return []
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed.filter((t): t is string => typeof t === "string" && t.length > 0)
    } catch {
      // Fall through to the legacy form.
    }
  }
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
}

export function buildMetadata(block: MemoryBlock, binding: CachedBinding | null): MirrorMetadata {
  const meta: MirrorMetadata = {
    source: MIRROR_SOURCE,
    block_id: block.id,
    block_scope: block.scope,
    visibility: "private",
    block_created: block.created,
    block_updated: block.updated,
  }
  // JSON, not a comma join: a tag containing a comma split into two on read.
  if (block.tags.length > 0) meta.block_tags = JSON.stringify(block.tags)
  if (block.expires) meta.block_expires = block.expires
  // Global blocks deliberately carry no workspace: they belong to the account
  // and apply in every workspace the user has.
  if (block.scope === "project" && binding) {
    meta.datamate_id = String(binding.datamateId)
    meta.datamate_name = binding.datamateName
    if (binding.repoRemote) meta.repo_remote = binding.repoRemote
    if (binding.projectPath) meta.project_path = binding.projectPath
  }
  return meta
}

/** Does a cloud record hold this block?
 *
 * Matches on logical identity only. Content is deliberately excluded: an
 * identity that moved when content changed could never find the record it
 * means to update. */
function isSameBlock(record: CloudMemoryRecord, block: MemoryBlock, binding: CachedBinding | null): boolean {
  if (!isMirrorRecord(record) || isArchived(record)) return false
  const m = record.metadata ?? {}
  if (m.block_id !== block.id) return false
  if (m.block_scope !== block.scope) return false
  if (block.scope !== "project") return true
  if (String(m.datamate_id ?? "") !== String(binding?.datamateId ?? "")) return false
  const recordProject = (m.repo_remote as string | undefined) ?? (m.project_path as string | undefined)
  return !recordProject || !binding || recordProject === projectKeyFor(binding)
}

/** Fetch the record set once, and report whether it was cut short.
 *
 * The service ignores paging parameters, so a full result at the limit means
 * records exist that no request can reach. Callers use ``truncated`` to avoid
 * acting on a partial view — creating a duplicate, or concluding a record is
 * absent when it is merely out of reach. */
async function fetchKnownRecords(): Promise<KnownRecords> {
  const records = await MemoryApi.list()
  // Exactly at the limit is the only ambiguous case. Treating ">= limit" as
  // truncated would permanently block creates for any user whose record set is
  // larger than the limit -- the service ignores paging, so a response LARGER
  // than the limit is positive proof the set came back whole.
  const truncated = records.length === LIST_LIMIT
  if (truncated) {
    log.warn("workspace memory read hit the service limit; some records are unreachable", {
      limit: LIST_LIMIT,
    })
  }
  return { records, truncated }
}

/** Records already known to the caller, so a sweep does not re-list per block. */
type KnownRecords = { records: CloudMemoryRecord[]; truncated: boolean }

/** What a push actually did. ``declined`` means the service kept nothing —
 * counting it as success made a sweep report blocks it had not stored. */
type PushOutcome = "stored" | "unchanged" | "declined" | "skipped"

/** Is this block still in the local store?
 *
 * Imported lazily: ``@/memory/store`` reaches this module on its write path, so
 * a static import would close an eval-order cycle (see ./memory-backfill.ts).
 * A read failure answers "yes" — refusing to mirror on a transient read error
 * would silently drop a memory the user does have. */
async function existsLocally(block: MemoryBlock, directory?: string): Promise<boolean> {
  if (syncInternals.blockExists) return syncInternals.blockExists(block, directory)
  try {
    const { MemoryStore } = await import("@/memory/store")
    // ``directory`` is the tree that owned the write. Without it this resolves
    // project scope from the ambient instance, which for a fire-and-forget
    // mirror can be a different project entirely.
    return !!(await MemoryStore.read(block.scope, block.id, directory))
  } catch (err) {
    log.warn("could not confirm a block still exists locally; mirroring anyway", {
      id: block.id,
      err: String(err),
    })
    return true
  }
}

async function push(
  block: MemoryBlock,
  binding: CachedBinding | null,
  known?: KnownRecords,
  directory?: string,
): Promise<PushOutcome> {
  const key = indexKey({
    scope: block.scope,
    blockId: block.id,
    datamateId: binding?.datamateId,
    projectKey: binding ? projectKeyFor(binding) : undefined,
  })
  const hash = contentHash(block)
  const existing = await readIndexEntry(key)
  if (existing?.contentHash === hash) return "unchanged"

  const metadata = buildMetadata(block, binding)

  // Resolve the record set even when the index already names a record. Every
  // safety check below needs it, and previously only ``backfill`` passed one:
  // on the ordinary per-save path the truncation guard, the lookup-failure
  // path and the newer-remote guard were all unreachable. Fetched only after
  // the hash check above, so an unchanged block still costs nothing.
  let view = known
  if (!view) {
    try {
      view = await fetchKnownRecords()
    } catch (err) {
      // A failed lookup must not read as "no record exists" -- that is how a
      // duplicate gets created. Leave the block unindexed so a later save
      // retries it.
      log.warn("could not read the workspace record set; deferring", { id: block.id, err: String(err) })
      return "skipped"
    }
  }

  // The local store is the authority on whether this block still exists.
  // `backfill` registers a block on the serialize queue only when a worker
  // dequeues it, so a delete issued mid-sweep runs first and this push would
  // otherwise undo it -- recreating a record the user deleted, or reviving an
  // archived one, and then marking it synced so no later sweep re-archives it.
  if (!(await existsLocally(block, directory))) {
    log.warn("skipping mirror for a block that no longer exists locally", {
      id: block.id,
      scope: block.scope,
    })
    return "skipped"
  }

  // An archived record is a tombstone. Ignoring the index here sends us to the
  // identity search below, which excludes archived records -- so a block the
  // user recreated under an old id gets a fresh record instead of un-archiving
  // the old one (`MemoryApi.update` replaces metadata wholesale, which would
  // drop the archived marker).
  const indexed = existing?.memoryId
    ? view.records.find((r) => r.id === existing.memoryId)
    : undefined
  const indexUsable = existing?.memoryId && (!indexed || !isArchived(indexed))
  const match = (indexUsable ? existing?.memoryId : undefined) ?? view.records.find((r) => isSameBlock(r, block, binding))?.id
  if (match) {
    // Refuse to move a record backwards. Two machines editing the same block,
    // or a stale clone running a sweep, would otherwise overwrite a newer cloud
    // value with older local content — last-request-wins rather than
    // convergence. This narrows the window rather than closing it; closing it
    // needs a conditional update the service does not offer.
    const remote = view.records.find((r) => r.id === match)
    const remoteUpdated = remote && (remote.metadata ?? {}).block_updated
    if (typeof remoteUpdated === "string" && remoteUpdated > block.updated) {
      log.warn("declining to overwrite a newer workspace record with older local content", {
        id: block.id,
        localUpdated: block.updated,
        remoteUpdated,
      })
      return "skipped"
    }
    await MemoryApi.update(match, block.content, metadata)
    await recordIndexEntry(key, { memoryId: match, contentHash: hash, syncedAt: Date.now() })
    return "stored"
  }

  // Creating against a list we know was cut short risks a duplicate: the
  // record may exist just beyond the window. Refusing leaves the block
  // unindexed, so a later save retries once the set is readable.
  if (view.truncated) {
    log.warn("skipping create against a truncated record set", { id: block.id, scope: block.scope })
    return "skipped"
  }

  const created = await MemoryApi.add(block.content, metadata)
  if (created.length === 0) {
    // The extractor declined the content and stored nothing. Leaving the block
    // unindexed means a later edit retries it rather than silently skipping.
    log.warn("workspace declined to store memory block", { id: block.id, scope: block.scope })
    return "declined"
  }

  // Repair the create: the extractor rewrote the text and replaced our
  // memory_type/title. update() is verbatim and replaces the whole metadata
  // dict, restoring the block exactly as written.
  const [primary, ...extras] = created
  await MemoryApi.update(primary, block.content, metadata)
  await recordIndexEntry(key, { memoryId: primary, contentHash: hash, syncedAt: Date.now() })

  // An extractor may split one submission into several records, each carrying
  // the metadata we sent. Only one can represent the block; the rest would
  // otherwise be injected as duplicates under the same block id, holding text
  // the user never wrote.
  for (const extra of extras) {
    log.warn("archiving an extra record produced by one create", { id: block.id, memoryId: extra })
    await MemoryApi.update(extra, "", { ...metadata, archived: "true", archived_at: new Date().toISOString() })
  }
  return "stored"
}

/** Cloud operations for one logical block, run one at a time.
 *
 * Both callers are fire-and-forget from the store's write and delete paths, so
 * without this a delete issued while a mirror is still in flight finds no
 * record to archive, and the mirror then creates a live one -- resurrecting
 * memory the user deleted. Two rapid saves race the same way and create
 * duplicates. Keyed by scope+id, so unrelated blocks still mirror in parallel.
 */
const blockQueues = new Map<string, Promise<unknown>>()

function serialize<T>(scope: "global" | "project", blockId: string, op: () => Promise<T>): Promise<T> {
  const key = `${scope}:${blockId}`
  const prior = blockQueues.get(key) ?? Promise.resolve()
  const next = prior.then(op, op)
  // Retain only while this op is the tail, so the map cannot grow unbounded.
  blockQueues.set(key, next)
  const settled = next.catch(() => undefined)
  void settled.then(() => {
    if (blockQueues.get(key) === next) blockQueues.delete(key)
  })
  return next
}

/** Mirror one block. Safe to call unconditionally — returns immediately when
 * the pilot flag is off, the project is unbound, or the workspace has memory
 * disabled. */
export async function mirrorBlock(block: MemoryBlock, directory?: string): Promise<void> {
  if (!isEnabled()) return
  // Queued BEFORE the binding lookup, not after. Both are async, so resolving
  // them first let two operations on one block reach `serialize` in the
  // opposite order to the writes that triggered them.
  await serialize(block.scope, block.id, async () => {
    // A binding is required for EVERY scope, not just project. Memories are
    // associated with a workspace, and the workspace is what carries the
    // memory_enabled setting — mirroring from an unbound directory would upload
    // with nothing to consult and nothing to attribute it to. Global blocks still
    // carry no workspace themselves, so they apply everywhere on read; the
    // binding governs only whether we upload at all.
    const binding = await currentBinding()
    if (!binding) return
    if (!(await memoryEnabled(binding))) return
    await push(block, binding, undefined, directory)
  })
}

/** Archive a block's cloud record rather than deleting it, so the workspace
 * keeps the history. Only this client filters the marker — other readers do
 * not — so an archived record stays visible elsewhere. */
export async function archiveBlock(scope: "global" | "project", blockId: string): Promise<void> {
  if (!isEnabled()) return
  // Queued behind any in-flight mirror for the same block, so a delete cannot
  // run before the create it is meant to undo. The binding lookup happens
  // inside the queued op for the same reason as in `mirrorBlock`.
  return serialize(scope, blockId, async () => {
    const binding = await currentBinding()
    if (!binding) return
    if (!(await memoryEnabled(binding))) return
    await archiveNow(scope, blockId, binding)
  })
}

async function archiveNow(
  scope: "global" | "project",
  blockId: string,
  binding: CachedBinding,
): Promise<void> {
  const key = indexKey({
    scope,
    blockId,
    datamateId: binding?.datamateId,
    projectKey: binding ? projectKeyFor(binding) : undefined,
  })
  const entry = await readIndexEntry(key)

  // Read through ``fetchKnownRecords`` so a truncated response is detectable
  // — a workspace with >= LIST_LIMIT records that includes the target block
  // beyond the window would silently fall through the ``!current`` branch and
  // the delete would no-op. The block then stays live in the cloud and gets
  // re-injected on every session with no diagnostic trace. (altimate-harness-
  // bot #1116 comment 3841102064.)
  const { records, truncated } = await fetchKnownRecords()

  // The index is per-machine and is discarded on account switch, corruption or
  // a wiped state directory. Without a fallback, deleting a block on a machine
  // that has lost its index leaves the record live, and every later session
  // re-injects it with no way to remove it. Match on logical identity instead,
  // exactly as the write path does.
  const current = entry
    ? records.find((r) => r.id === entry.memoryId)
    : // Matching on workspace alone is too coarse: two projects in one
      // workspace may hold the same block id, and deleting one would archive
      // the other's record. Use the write path's own identity test so the
      // fallback can only ever hit the record this block would have written.
      records.find((r) =>
        isSameBlock(r, { id: blockId, scope, tags: [], content: "", created: "", updated: "" } as MemoryBlock, binding),
      )
  if (!current) {
    if (truncated) {
      // Distinguish "record isn't there" (silent no-op is correct) from
      // "record is beyond the LIST_LIMIT window" (silent no-op leaves a
      // live block whose delete looks successful client-side).
      log.warn(
        "could not archive block — record set is truncated at LIST_LIMIT; the block may still be live in the cloud",
        { blockId, scope, limit: LIST_LIMIT },
      )
    }
    return
  }

  const now = new Date().toISOString()
  const metadata: MirrorMetadata = {
    ...((current.metadata ?? {}) as unknown as MirrorMetadata),
    source: MIRROR_SOURCE,
    block_id: blockId,
    block_scope: scope,
    visibility: "private",
    archived: "true",
    archived_at: now,
  }
  // Keep the text — archiving hides a record from injection, it does not erase
  // what it said.
  await MemoryApi.update(current.id, current.memory ?? "", metadata)
  // Written only after the remote archive lands, so a failure leaves the entry
  // pointing at a record that is still live rather than losing track of it.
  await recordIndexEntry(key, { memoryId: current.id, contentHash: "", syncedAt: Date.now() })
}

async function runQueue<T>(
  items: T[],
  worker: (item: T) => Promise<PushOutcome>,
  concurrency: number,
): Promise<{ ok: number; failed: number; declined: number; skipped: number }> {
  let cursor = 0
  let ok = 0
  let failed = 0
  let declined = 0
  let skipped = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]
      try {
        const outcome = await worker(item)
        if (outcome === "declined") declined++
        else if (outcome === "skipped" || outcome === "unchanged") skipped++
        else ok++
      } catch (err) {
        failed++
        log.warn("memory mirror task failed", { err: String(err) })
      }
    }
  })
  await Promise.all(runners)
  return { ok, failed, declined, skipped }
}

/** Push a set of blocks — the sweep that runs when a project is bound to a
 * workspace. Throttled and resumable: blocks whose payload is already synced
 * are skipped, so a re-run after a partial failure sends only what is missing. */
export async function backfill(
  blocks: MemoryBlock[],
  explicitBinding?: CachedBinding,
  sweepDirectory?: string,
): Promise<{ ok: number; failed: number; skipped: number; declined: number; gated: boolean }> {
  // ``gated`` says the sweep never ran, as opposed to running and storing
  // nothing. A caller recording "this binding is seeded" must be able to tell
  // those apart: memory being off is not a completed seed.
  if (!isEnabled()) return { ok: 0, failed: 0, skipped: 0, declined: 0, gated: true }
  // The bind path passes the binding it just recorded; there is no ambient
  // instance to resolve one from on the `link` subcommand.
  const binding = explicitBinding ?? (await currentBinding())
  if (!binding || !(await memoryEnabled(binding)))
    return { ok: 0, failed: 0, skipped: blocks.length, declined: 0, gated: true }
  const index = await readIndex()

  const pending: { block: MemoryBlock; binding: CachedBinding | null; directory?: string }[] = []
  let skipped = 0
  for (const block of blocks) {
    const target = block.scope === "project" ? binding : null
    if (block.scope === "project" && !target) {
      skipped++
      continue
    }
    const key = indexKey({
      scope: block.scope,
      blockId: block.id,
      datamateId: target?.datamateId,
      projectKey: target ? projectKeyFor(target) : undefined,
    })
    if (index[key]?.contentHash === contentHash(block)) {
      skipped++
      continue
    }
    pending.push({ block, binding: target, directory: sweepDirectory })
  }

  if (pending.length === 0) return { ok: 0, failed: 0, skipped, declined: 0, gated: false }

  // One read for the whole sweep. Every block in a first bind is an index miss,
  // so resolving each through its own lookup made a bind cost one full record
  // fetch per block.
  let known: KnownRecords | undefined
  try {
    known = await fetchKnownRecords()
  } catch (err) {
    log.warn("could not prefetch records for backfill; falling back per block", {
      err: String(err),
    })
  }

  log.info("workspace memory backfill starting", { pending: pending.length, skipped })
  const result = await runQueue(
    pending,
    (item) =>
      serialize(item.block.scope, item.block.id, () =>
        push(item.block, item.binding, known, item.directory),
      ),
    BACKFILL_CONCURRENCY,
  )
  // `skipped` combines blocks filtered before the queue (already synced, or
  // project blocks with no workspace) with those the queue itself declined to
  // act on — a truncated read, or a remote copy that is newer.
  const totals = { ...result, skipped: result.skipped + skipped, gated: false }
  log.info("workspace memory backfill finished", totals)
  return totals
}

/** Short label for a record's originating project. */
function originLabel(meta: Record<string, unknown>): string | undefined {
  const remote = typeof meta.repo_remote === "string" ? meta.repo_remote : undefined
  if (remote) {
    const trimmed = remote.replace(/[/]+$/, "").replace(/\.git$/, "").replace(/[/]+$/, "")
    const last = trimmed.split(/[/:]/).pop()
    if (last) return last
  }
  const projectPath = typeof meta.project_path === "string" ? meta.project_path : undefined
  if (projectPath) {
    const base = projectPath.replace(/\/$/, "").split("/").pop()
    if (base) return base
  }
  return undefined
}

/** Map a cloud record back to an injectable block, or null if it is not a
 * well-formed mirrored block. */
export function toBlock(
  record: CloudMemoryRecord,
  ownProjectKey: string | undefined,
): RemoteMemoryBlock | null {
  const meta = record.metadata
  if (!meta || typeof meta !== "object") return null
  const blockId = typeof meta.block_id === "string" ? meta.block_id : undefined
  const scope = meta.block_scope === "global" || meta.block_scope === "project" ? meta.block_scope : undefined
  if (!blockId || !scope || !record.memory) return null

  const tags = decodeTags(meta.block_tags)
  const updated =
    (typeof meta.block_updated === "string" ? meta.block_updated : undefined) ??
    record.updated_at ??
    new Date().toISOString()

  const recordProjectKey =
    (typeof meta.repo_remote === "string" ? meta.repo_remote : undefined) ??
    (typeof meta.project_path === "string" ? meta.project_path : undefined)
  const fromSibling = scope === "project" && !!recordProjectKey && recordProjectKey !== ownProjectKey

  return {
    id: blockId,
    scope,
    tags,
    created: (typeof meta.block_created === "string" ? meta.block_created : undefined) ?? record.created_at ?? updated,
    updated,
    expires: typeof meta.block_expires === "string" ? meta.block_expires : undefined,
    content: record.memory,
    remote: true,
    ...(fromSibling ? { origin: originLabel(meta) } : {}),
  }
}

/** Does this record apply to the workspace the current project is bound to?
 *
 * Project blocks apply to their workspace regardless of which project wrote
 * them — a session anywhere in the workspace sees them. Global blocks carry no
 * workspace and apply everywhere; omitting that arm would make them
 * write-only. */
export function belongsHere(record: CloudMemoryRecord, ownWorkspace: string | undefined): boolean {
  const meta = record.metadata ?? {}
  if (meta.block_scope === "global") return true
  if (!ownWorkspace) return false
  return String(meta.datamate_id ?? "") === ownWorkspace
}

/** Fetch a session's workspace memory once.
 *
 * Idempotent: safe to call on every turn, which matters because the caller's
 * enclosing block runs per user turn rather than once per session. Repeat calls
 * return the in-flight or completed hydration instead of refetching, and the
 * existing overlay is never cleared first — clearing before a refetch made
 * workspace memory blink out of the prompt whenever a fetch ran long. */
export async function hydrate(sessionID: string): Promise<void> {
  if (!isEnabled()) return
  const state = sessionState(sessionID)
  if (state.hydration) return state.hydration
  state.hydration = doHydrate(sessionID)
  return state.hydration
}

/** Wait for a session's in-flight hydration, capped. Resolves immediately once
 * the fetch has settled, so only the first injection of a session pays. */
export async function whenHydrated(
  sessionID: string,
  timeoutMs: number = HYDRATION_WAIT_MS,
): Promise<void> {
  const state = sessions.get(sessionID)
  const pending = state?.hydration
  if (!pending || !state) return
  // A hydration that already blew the budget must not be waited on again: the
  // promise stays unresolved, so every later injection in the session would pay
  // the full timeout. Wait once, then let the overlay fill in whenever it lands.
  if (state.waitTimedOut) return
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  try {
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true
          resolve()
        }, timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (timedOut) state.waitTimedOut = true
  }
}

async function doHydrate(sessionID: string): Promise<void> {
  try {
    const binding = await currentBinding()
    if (!binding || !(await memoryEnabled(binding))) {
      sessionState(sessionID).overlay = []
      return
    }
    const ownProjectKey = binding ? projectKeyFor(binding) : undefined
    const ownWorkspace = binding ? String(binding.datamateId) : undefined

    const records = await MemoryApi.list()

    const blocks: RemoteMemoryBlock[] = []
    for (const record of records) {
      if (!record?.id) continue
      if (!isMirrorRecord(record) || isArchived(record)) continue
      if (!belongsHere(record, ownWorkspace)) continue
      const block = toBlock(record, ownProjectKey)
      if (!block) continue
      // A TTL'd block must expire everywhere, not just on the machine that
      // wrote it. The cloud copy is not swept, so honour it on read.
      if (block.expires && new Date(block.expires) <= new Date()) continue
      blocks.push(block)
    }

    const done = sessionState(sessionID)
    done.overlay = blocks
    done.hydrateFailed = false
    if (blocks.length > 0) {
      log.info("workspace memory hydrated", { blocks: blocks.length, workspace: binding?.datamateName })
    }
  } catch (err) {
    log.warn("workspace memory hydration failed", { err: String(err) })
    const failed = sessionState(sessionID)
    failed.overlay = []
    failed.hydrateFailed = true
  }
}

/** A session's cloud overlay. Returns a copy so a caller cannot mutate the
 * cached state in place. */
export function overlayBlocks(sessionID: string): RemoteMemoryBlock[] {
  return [...(sessions.get(sessionID)?.overlay ?? [])]
}

/** Re-read this session's workspace memory, discarding what it already holds.
 *
 * ``hydrate`` is idempotent for the life of a session, which is what keeps the
 * per-turn call cheap -- but it also means a session started before a teammate
 * (or this user on another machine) wrote a block never sees it. This is the
 * on-demand path: drop the session's state so the next hydrate genuinely
 * refetches. Returns how many blocks the session now holds. */
export async function refresh(sessionID: string): Promise<{ count: number; ok: boolean }> {
  if (!isEnabled()) return { count: 0, ok: false }
  // Keep what the session already has. A failed fetch empties the overlay
  // (hydration failure is indistinguishable from an empty workspace at session
  // start, where [] is correct) -- but mid-session that would silently destroy
  // working memory because the user asked to reload and the network hiccuped.
  const previous = overlayBlocks(sessionID)
  // Clears overlay, hydration promise and the timed-out latch together.
  sessions.delete(sessionID)
  await hydrate(sessionID)
  const state = sessions.get(sessionID)
  if (state?.hydrateFailed) {
    state.overlay = previous
    return { count: previous.length, ok: false }
  }
  return { count: overlayBlocks(sessionID).length, ok: true }
}

/** Forget a session's hydration, or all of them.
 *
 * Not called per turn: doing so defeated ``hydrate``'s idempotence and made
 * every turn refetch. Exposed for tests and for a future session-end hook. */
export function resetOverlay(sessionID?: string): void {
  if (sessionID === undefined) {
    sessions.clear()
    memoryEnabledCache.clear()
    return
  }
  sessions.delete(sessionID)
}
