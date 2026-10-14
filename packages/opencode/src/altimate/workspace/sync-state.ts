// altimate_change start — workspace sync state
//
// One record per synced entity kind (skills, memory, …), kept per project, so every client
// can say when each kind was last checked, when it last changed and what changed — the
// TUI sidebar, and the IDE extension through `GET /altimate/workspace/status` and the
// `altimate.workspace.sync.changed` event.
//
// Written by the existing sync paths only; nothing here polls. A new entity kind records
// its items through `record` and gets the same metadata and change detection.
//
// Persisted rather than held in memory: in the TUI the per-turn syncs run in the server
// worker while the sidebar renders on the main thread, and the two share no module state
// (see `SkillSync.lastSuccessfulSyncAt`). A file is what both sides see.
//
// One file per kind, so two writers of different kinds — the TUI main thread, the server
// worker and a separate CLI process can each hold one — never read-modify-write the same
// file. Writes of one kind within this module realm are chained. Across realms, each record
// carries when its check read the items (`observedAt`, taken before the fetch), and a write
// whose observation is older than the stored one is dropped, so a slow sync cannot roll a
// newer record back. That compare is not atomic across processes: two writes landing in the
// same instant can still both pass it, and the later rename wins until the next check.
//
// Event delivery: `Bus.publish` reaches the bus of the instance the record runs in. That is
// the `/event` stream for `serve` (the IDE extension) and for the TUI's per-turn syncs, which
// run in its server worker. A refresh run on the TUI main thread, or by a separate CLI
// process, publishes to no `/event` subscriber — the file is still written, and the TUI
// sidebar and the status route read it from there.
import { createHash, randomBytes } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Global } from "@/global"
import { Log } from "@/altimate/util/log"
import { canonicalDirectory, currentScope, type AccountKey } from "./state"

const log = Log.create({ service: "altimate-workspace-sync-state" })

export const KINDS = ["skills", "memory"] as const
export type SyncKind = (typeof KINDS)[number]

/** What a kind holds: a stable id mapped to a display label and a version that moves when
 * the item's content does. Diffs are computed from this alone, so every kind compares the
 * same way. */
export type SyncItems = Record<string, { label: string; version: string }>

const Changes = z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  updated: z.array(z.string()),
})
export type SyncChanges = z.infer<typeof Changes>

const EntityState = z.object({
  kind: z.enum(KINDS),
  status: z.enum(["ok", "error"]),
  /** Items held after the last check; null when it has never been read successfully. */
  count: z.number().int().nonnegative().nullable(),
  /** Epoch ms at which the last recorded check started reading, successful or not. */
  lastCheckedAt: z.number(),
  /** Epoch ms at which the last check that read the items successfully started; null when
   * none has. A "loaded Xm ago" line reads this, not `lastCheckedAt`, which also moves on
   * failures. */
  lastSucceededAt: z.number().nullable(),
  /** Epoch ms of the last check that found a difference; null when none has. */
  lastChangedAt: z.number().nullable(),
  /** What that last change was, by label. Kept until the next change replaces it. */
  changes: Changes.nullable(),
  /** User-facing reason, set while `status` is "error". */
  error: z.string().optional(),
})
export type EntityState = z.infer<typeof EntityState>

export const Event = {
  /** Published only when a check found a difference, or when a kind's error state changed
   * (a new problem, a different problem, or recovery) — never for a check that found
   * nothing, so a client can surface every event without being noisy. */
  Changed: BusEvent.define(
    "altimate.workspace.sync.changed",
    z.object({
      directory: z.string(),
      datamateId: z.number(),
      kind: z.enum(KINDS),
      state: EntityState,
      /** This check's own difference; null for an error-state-only event. */
      changes: Changes.nullable(),
    }),
  ),
}

export interface WorkspaceSyncState {
  datamateId: number
  entities: Partial<Record<SyncKind, EntityState>>
}

interface StoredEntity extends EntityState {
  /** Absent until a check has read the items, so the first read is a baseline. */
  items?: SyncItems
  /** When the check that wrote this record started reading; see the header. */
  observedAt?: number
}

interface StoredFile {
  version: 2
  directory: string
  /** The account the state was recorded under. Workspace ids are per tenant, so the same id
   * under another account is another workspace. */
  scope: string
  datamateId: number
  entity: StoredEntity
}

function syncDir(): string {
  return path.join(Global.Path.state, "altimate-workspace-sync")
}

function filePath(directory: string, kind: SyncKind): string {
  const key = createHash("sha256").update(canonicalDirectory(directory)).digest("hex").slice(0, 32)
  return path.join(syncDir(), `${key}.${kind}.json`)
}

function scopeKeyOf(scope: AccountKey | null): string | null {
  return scope ? `${scope.tenant}|${scope.apiUrl}|${scope.account}` : null
}

/** The account the caller's credentials name, as a string, or null when there is none. */
async function scopeKey(): Promise<string | null> {
  return scopeKeyOf(await currentScope().catch(() => null))
}

function readStored(directory: string, kind: SyncKind): StoredFile | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath(directory, kind), "utf8")) as StoredFile
    if (parsed?.version !== 2 || typeof parsed.datamateId !== "number" || !parsed.entity) return null
    // A hash collision or a moved file must not attribute another tree's state to this one.
    if (parsed.directory !== canonicalDirectory(directory)) return null
    return parsed
  } catch {
    return null
  }
}

/** Private from the first byte, like the binding cache and the memory index beside it: the
 * file holds the checkout path, skill names, memory titles and error text. The temp file is
 * created owner-only and restricted before it is renamed into place, and one that cannot be
 * restricted is never published. */
function writePrivate(target: string, value: unknown): void {
  mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp-${randomBytes(6).toString("hex")}`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  try {
    chmodSync(tmp, 0o600)
    renameSync(tmp, target)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/** The project's sync state for the workspace it is bound to now, under the account in use.
 * Null when nothing has been recorded for that workspace — after a rebind or an account
 * switch the previous workspace's state is not this one's. */
export async function read(directory: string, datamateId: number): Promise<WorkspaceSyncState | null> {
  const scope = await scopeKey()
  if (!scope) return null
  const entities: WorkspaceSyncState["entities"] = {}
  for (const kind of KINDS) {
    const stored = readStored(directory, kind)
    if (!stored || stored.datamateId !== datamateId || stored.scope !== scope) continue
    entities[kind] = publicState(stored.entity)
  }
  return Object.keys(entities).length > 0 ? { datamateId, entities } : null
}

/** Added, removed and updated labels between two item sets. Pure. Own keys only, so an id
 * such as `constructor` is not mistaken for an inherited property. */
export function diff(previous: SyncItems, next: SyncItems): SyncChanges {
  const added: string[] = []
  const updated: string[] = []
  for (const [id, item] of Object.entries(next)) {
    if (!Object.hasOwn(previous, id)) added.push(item.label)
    else if (previous[id].version !== item.version) updated.push(item.label)
  }
  const removed = Object.entries(previous)
    .filter(([id]) => !Object.hasOwn(next, id))
    .map(([, item]) => item.label)
  return { added: added.sort(), removed: removed.sort(), updated: updated.sort() }
}

function publicState(entity: StoredEntity): EntityState {
  const { items: _items, observedAt: _observedAt, ...state } = entity
  return state
}

function isEmpty(changes: SyncChanges): boolean {
  return changes.added.length === 0 && changes.removed.length === 0 && changes.updated.length === 0
}

/** A completed check. `items` is what the check read, absent when it could not read them
 * (the previous set is kept); `error` is a problem to report, which a partial read can
 * carry alongside the items it did get. */
export interface Outcome {
  items?: SyncItems
  error?: string
}

export interface RecordOptions {
  /** Whether the check still describes the project's current binding. Checked just before
   * the write: a long sync, or a detached memory record, can settle after the project was
   * rebound, and its result must not replace the new workspace's state. */
  isCurrent?: () => boolean | Promise<boolean>
  /** The account the check read under, captured before it fetched. Workspace ids are per
   * tenant, so a check that started under another account describes another workspace even
   * when the id matches, and is dropped. Null (no account then) is never recorded. */
  scope?: AccountKey | null
  /** When the check started reading (epoch ms); defaults to now. Also the record's
   * `lastCheckedAt`, and its `lastSucceededAt` when it read the items. */
  observedAt?: number
}

export interface ForgetOptions {
  /** Whether the binding the caller is retiring is still the project's. */
  isCurrent?: () => boolean | Promise<boolean>
  /** Only a record observed no later than this time (epoch ms) is removed: one observed
   * since describes a binding made after the caller decided to retire the old one. A tie is
   * removed, since the caller decided after that observation. */
  before?: number
}

/** Writes are chained per file within this module realm; see the header for other writers. */
const writes = new Map<string, Promise<void>>()

/** Record a completed check of one kind and publish when it changed something.
 *
 * Never throws: this is status metadata, and a failure here must not fail the sync that
 * reported it. Resolves once the state is written and any event published. */
export function record(
  directory: string,
  datamateId: number,
  kind: SyncKind,
  outcome: Outcome,
  options: RecordOptions = {},
): Promise<void> {
  return chain(filePath(directory, kind), () => apply(directory, datamateId, kind, outcome, options), kind)
}

/** Drop a kind's record, without an event: memory turned off, the project unlinked, or the
 * skill snapshot taken out of service. A problem recorded before would otherwise stay
 * latched for as long as nothing checks it, and a relink to the same workspace would bring
 * back a count and a load time that describe nothing on disk. */
export function forget(directory: string, kind: SyncKind, options: ForgetOptions = {}): Promise<void> {
  const file = filePath(directory, kind)
  return chain(
    file,
    async () => {
      if (options.isCurrent && !(await options.isCurrent())) return
      const stored = readStored(directory, kind)
      if (!stored) return
      const observed = stored.entity.observedAt ?? stored.entity.lastCheckedAt
      if (options.before !== undefined && observed > options.before) return
      rmSync(file, { force: true })
    },
    kind,
  )
}

function chain(file: string, work: () => Promise<void>, kind: SyncKind): Promise<void> {
  const run = (writes.get(file) ?? Promise.resolve()).then(work)
  const settled = run.catch((err) => log.warn("could not record workspace sync state", { kind, err: String(err) }))
  writes.set(file, settled)
  void settled.finally(() => {
    if (writes.get(file) === settled) writes.delete(file)
  })
  return settled
}

async function apply(
  directory: string,
  datamateId: number,
  kind: SyncKind,
  outcome: Outcome,
  options: RecordOptions,
): Promise<void> {
  const scope = await scopeKey()
  // No account, no attribution: a record that cannot say whose it is would be served to
  // whichever account looks next.
  if (!scope) return
  if (options.scope !== undefined && scopeKeyOf(options.scope) !== scope) {
    log.info("dropped a sync result read under another account", { kind, datamateId })
    return
  }
  // Last before the read-modify-write, which is synchronous from here on: nothing can rebind
  // between this check and the rename.
  if (options.isCurrent && !(await options.isCurrent())) {
    log.info("dropped a sync result for a binding that is no longer current", { kind, datamateId })
    return
  }
  const canon = canonicalDirectory(directory)
  const stored = readStored(directory, kind)
  // Another workspace's (or account's) state describes nothing about this one: start over.
  const previous = stored && stored.datamateId === datamateId && stored.scope === scope ? stored.entity : undefined
  const now = options.observedAt ?? Date.now()
  if (previous?.observedAt !== undefined && previous.observedAt > now) {
    log.info("dropped a sync result older than the recorded one", { kind, datamateId })
    return
  }

  let changes: SyncChanges | null = null
  if (outcome.items) {
    // The first check this project has ever recorded is a baseline, not a change: reporting
    // every existing item as "added" would announce the whole workspace on first use.
    const found = previous?.items ? diff(previous.items, outcome.items) : null
    changes = found && !isEmpty(found) ? found : null
  }
  // A check that could not read the items keeps what was last known: a failure says
  // nothing about them.
  const items = outcome.items ?? previous?.items
  const next: StoredEntity = {
    kind,
    status: outcome.error ? "error" : "ok",
    count: items ? Object.keys(items).length : null,
    lastCheckedAt: now,
    lastSucceededAt: outcome.items ? now : (previous?.lastSucceededAt ?? null),
    lastChangedAt: changes ? now : (previous?.lastChangedAt ?? null),
    changes: changes ?? previous?.changes ?? null,
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(items ? { items } : {}),
    observedAt: now,
  }
  const file: StoredFile = { version: 2, directory: canon, scope, datamateId, entity: next }
  writePrivate(filePath(directory, kind), file)

  const errorChanged = (previous?.status ?? "ok") !== next.status || previous?.error !== next.error
  if (!changes && !errorChanged) return
  const state = publicState(next)
  // Needs an instance (a turn, a server route). A sync started outside one — a bind from
  // the CLI — has no client listening anyway; the state above is what it leaves behind.
  await Bus.publish(Event.Changed, { directory: canon, datamateId, kind, state, changes }).catch((err) =>
    log.info("workspace sync change not published", { kind, err: String(err) }),
  )
}

// altimate_change end
