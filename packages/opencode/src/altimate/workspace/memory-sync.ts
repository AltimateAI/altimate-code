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
import { Flag as CoreFlag } from "@opencode-ai/core/flag/flag"
import { Flag } from "@/flag/flag"
import { Instance } from "@/project/instance"
import { Log } from "@/altimate/util/log"
import type { MemoryBlock } from "@/memory/types"
import { readLocalBinding, type CachedBinding } from "./state"
import { indexKey, readIndex, readIndexEntry, recordIndexEntry } from "./memory-index"
import { WorkspaceApi } from "./api-client"
import {
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

let overlay: RemoteMemoryBlock[] = []
let hydratedFor: string | null = null
let hydration: Promise<void> | null = null
/** Guards against a hydration from a previous session resolving after a reset
 * and writing its results into the new session's overlay. */
let generation = 0

/** The mirror rides the workspace pilot flag and honours the memory opt-out.
 * Never active for anyone who has not opted into the pilot. */
export function isEnabled(): boolean {
  return CoreFlag.ALTIMATE_WORKSPACE && !Flag.ALTIMATE_DISABLE_MEMORY
}

/** Test seam. Production leaves this unset and resolves the binding from the
 * active instance; tests set it so they need not boot one. */
export const syncInternals: {
  resolveBinding?: () => Promise<CachedBinding | null>
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
  return content.replace(/^<!--\s*training\n[\s\S]*?-->\n*/, "").trim()
}

/** Fingerprint of everything about a block that reaches the store. Tags and
 * expiry are included because both are mirrored. */
function contentHash(block: MemoryBlock): string {
  const payload = JSON.stringify([
    stripTrainingMeta(block.content),
    [...block.tags].sort(),
    block.expires ?? "",
  ])
  // Non-cryptographic (FNV-1a): this only has to detect change, and must not
  // pull in a hashing dependency.
  let h = 0x811c9dc5
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16)
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
  if (block.tags.length > 0) meta.block_tags = block.tags.join(",")
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

/** Find an existing record for this block.
 *
 * Runs when the local index has no entry — a second machine, a reinstalled
 * CLI, or a create whose response was lost after the store had committed.
 * Without it those cases all produce a duplicate. */
async function findExisting(
  block: MemoryBlock,
  binding: CachedBinding | null,
): Promise<string | undefined> {
  try {
    const records = await MemoryApi.list()
    return records.find((r) => isSameBlock(r, block, binding))?.id
  } catch (err) {
    log.warn("could not check for an existing record", { id: block.id, err: String(err) })
    return undefined
  }
}

async function push(block: MemoryBlock, binding: CachedBinding | null): Promise<void> {
  const key = indexKey({
    scope: block.scope,
    blockId: block.id,
    datamateId: binding?.datamateId,
    projectKey: binding ? projectKeyFor(binding) : undefined,
  })
  const hash = contentHash(block)
  const existing = await readIndexEntry(key)
  if (existing?.contentHash === hash) return

  const metadata = buildMetadata(block, binding)

  const known = existing?.memoryId ?? (await findExisting(block, binding))
  if (known) {
    await MemoryApi.update(known, block.content, metadata)
    await recordIndexEntry(key, { memoryId: known, contentHash: hash, syncedAt: Date.now() })
    return
  }

  const created = await MemoryApi.add(block.content, metadata)
  if (!created) {
    // The extractor declined the content and stored nothing. Leaving the block
    // unindexed means a later edit retries it rather than silently skipping.
    log.warn("workspace declined to store memory block", { id: block.id, scope: block.scope })
    return
  }
  // Repair the create: the extractor rewrote the text and replaced our
  // memory_type/title. update() is verbatim and replaces the whole metadata
  // dict, restoring the block exactly as written.
  await MemoryApi.update(created, block.content, metadata)
  await recordIndexEntry(key, { memoryId: created, contentHash: hash, syncedAt: Date.now() })
}

/** Mirror one block. Safe to call unconditionally — returns immediately when
 * the pilot flag is off, the project is unbound, or the workspace has memory
 * disabled. */
export async function mirrorBlock(block: MemoryBlock): Promise<void> {
  if (!isEnabled()) return
  // A binding is required for EVERY scope, not just project. Memories are
  // associated with a workspace, and the workspace is what carries the
  // memory_enabled setting — mirroring from an unbound directory would upload
  // with nothing to consult and nothing to attribute it to. Global blocks still
  // carry no workspace themselves, so they apply everywhere on read; the
  // binding governs only whether we upload at all.
  const binding = await currentBinding()
  if (!binding) return
  if (!(await memoryEnabled(binding))) return
  await push(block, binding)
}

/** Archive a block's cloud record rather than deleting it, so the workspace
 * keeps the history. Only this client filters the marker — other readers do
 * not — so an archived record stays visible elsewhere. */
export async function archiveBlock(scope: "global" | "project", blockId: string): Promise<void> {
  if (!isEnabled()) return
  const binding = await currentBinding()
  if (!binding) return
  if (!(await memoryEnabled(binding))) return

  const key = indexKey({
    scope,
    blockId,
    datamateId: binding?.datamateId,
    projectKey: binding ? projectKeyFor(binding) : undefined,
  })
  const entry = await readIndexEntry(key)
  if (!entry) return

  const records = await MemoryApi.list()
  const current = records.find((r) => r.id === entry.memoryId)
  if (!current) return

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
  await MemoryApi.update(entry.memoryId, current.memory ?? "", metadata)
  await recordIndexEntry(key, { memoryId: entry.memoryId, contentHash: "", syncedAt: Date.now() })
}

async function runQueue<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  concurrency: number,
): Promise<{ ok: number; failed: number }> {
  let cursor = 0
  let ok = 0
  let failed = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]
      try {
        await worker(item)
        ok++
      } catch (err) {
        failed++
        log.warn("memory mirror task failed", { err: String(err) })
      }
    }
  })
  await Promise.all(runners)
  return { ok, failed }
}

/** Push a set of blocks — the sweep that runs when a project is bound to a
 * workspace. Throttled and resumable: blocks whose payload is already synced
 * are skipped, so a re-run after a partial failure sends only what is missing. */
export async function backfill(blocks: MemoryBlock[]): Promise<{ ok: number; failed: number; skipped: number }> {
  if (!isEnabled()) return { ok: 0, failed: 0, skipped: 0 }
  const binding = await currentBinding()
  if (!binding || !(await memoryEnabled(binding))) return { ok: 0, failed: 0, skipped: blocks.length }
  const index = await readIndex()

  const pending: { block: MemoryBlock; binding: CachedBinding | null }[] = []
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
    pending.push({ block, binding: target })
  }

  if (pending.length === 0) return { ok: 0, failed: 0, skipped }
  log.info("workspace memory backfill starting", { pending: pending.length, skipped })
  const result = await runQueue(pending, (item) => push(item.block, item.binding), BACKFILL_CONCURRENCY)
  log.info("workspace memory backfill finished", { ...result, skipped })
  return { ...result, skipped }
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

  const tags =
    typeof meta.block_tags === "string" && meta.block_tags
      ? meta.block_tags.split(",").map((t) => t.trim()).filter(Boolean)
      : []
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

/** Fetch this session's workspace memory once. Idempotent per session id. */
export async function hydrate(sessionID: string): Promise<void> {
  if (!isEnabled()) return
  if (hydratedFor === sessionID) return hydration ?? undefined
  hydratedFor = sessionID
  hydration = doHydrate(++generation)
  return hydration
}

/** Wait for an in-flight hydration, capped. Resolves immediately once the
 * fetch has settled, so only the first injection of a session pays. */
export async function whenHydrated(timeoutMs: number = HYDRATION_WAIT_MS): Promise<void> {
  if (!hydration) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      hydration,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function doHydrate(forGeneration: number): Promise<void> {
  try {
    const binding = await currentBinding()
    if (!binding || !(await memoryEnabled(binding))) {
      if (forGeneration === generation) overlay = []
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
      if (block) blocks.push(block)
    }

    // A hydration from a previous session must not overwrite the current one.
    if (forGeneration !== generation) return
    overlay = blocks
    if (blocks.length > 0) {
      log.info("workspace memory hydrated", { blocks: blocks.length, workspace: binding?.datamateName })
    }
  } catch (err) {
    log.warn("workspace memory hydration failed", { err: String(err) })
    if (forGeneration === generation) overlay = []
  }
}

/** The current session's cloud overlay. */
export function overlayBlocks(): RemoteMemoryBlock[] {
  return overlay
}

/** Drop the overlay. Called at session start so a long-lived process does not
 * carry one project's workspace memory into the next session. */
export function resetOverlay(): void {
  overlay = []
  hydratedFor = null
  hydration = null
  generation++
  // A new session re-checks the toggle rather than inheriting a stale verdict.
  memoryEnabledCache.clear()
}
