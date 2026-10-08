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
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Global } from "@/global"
import { Log } from "@/altimate/util/log"
import { Filesystem } from "@/util/filesystem"
import { canonicalDirectory } from "./state"

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
  /** Epoch ms of the last completed check, successful or not. */
  lastCheckedAt: z.number(),
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
}

interface StoredFile {
  version: 1
  directory: string
  datamateId: number
  entities: Partial<Record<SyncKind, StoredEntity>>
}

function filePath(directory: string): string {
  const key = createHash("sha256").update(canonicalDirectory(directory)).digest("hex").slice(0, 32)
  return path.join(Global.Path.state, "altimate-workspace-sync", `${key}.json`)
}

function readStored(directory: string): StoredFile | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath(directory), "utf8")) as StoredFile
    if (parsed?.version !== 1 || typeof parsed.datamateId !== "number" || !parsed.entities) return null
    // A hash collision or a moved file must not attribute another tree's state to this one.
    if (parsed.directory !== canonicalDirectory(directory)) return null
    return parsed
  } catch {
    return null
  }
}

/** The project's sync state for the workspace it is bound to now. Null when nothing has
 * been recorded for that workspace — after a rebind the previous workspace's state is not
 * this one's. */
export function read(directory: string, datamateId: number): WorkspaceSyncState | null {
  const stored = readStored(directory)
  if (!stored || stored.datamateId !== datamateId) return null
  const entities: WorkspaceSyncState["entities"] = {}
  for (const kind of KINDS) {
    const entity = stored.entities[kind]
    if (!entity) continue
    const { items: _items, ...state } = entity
    entities[kind] = state
  }
  return { datamateId, entities }
}

/** Added, removed and updated labels between two item sets. Pure. */
export function diff(previous: SyncItems, next: SyncItems): SyncChanges {
  const added: string[] = []
  const updated: string[] = []
  for (const [id, item] of Object.entries(next)) {
    const before = previous[id]
    if (!before) added.push(item.label)
    else if (before.version !== item.version) updated.push(item.label)
  }
  const removed = Object.entries(previous)
    .filter(([id]) => !(id in next))
    .map(([, item]) => item.label)
  return { added: added.sort(), removed: removed.sort(), updated: updated.sort() }
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

/** Writes are chained per file so two kinds settling at once cannot drop each other's update. */
const writes = new Map<string, Promise<void>>()

/** Record a completed check of one kind and publish when it changed something.
 *
 * Never throws: this is status metadata, and a failure here must not fail the sync that
 * reported it. Resolves once the state is written and any event published. */
export function record(directory: string, datamateId: number, kind: SyncKind, outcome: Outcome): Promise<void> {
  const file = filePath(directory)
  const run = (writes.get(file) ?? Promise.resolve()).then(() => apply(directory, datamateId, kind, outcome))
  const settled = run.catch((err) => log.warn("could not record workspace sync state", { kind, err: String(err) }))
  writes.set(file, settled)
  void settled.finally(() => {
    if (writes.get(file) === settled) writes.delete(file)
  })
  return settled
}

async function apply(directory: string, datamateId: number, kind: SyncKind, outcome: Outcome): Promise<void> {
  const canon = canonicalDirectory(directory)
  const stored = readStored(directory)
  // Another workspace's state describes nothing about this one: start over.
  const file: StoredFile =
    stored && stored.datamateId === datamateId ? stored : { version: 1, directory: canon, datamateId, entities: {} }
  const previous = file.entities[kind]
  const now = Date.now()

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
    lastChangedAt: changes ? now : (previous?.lastChangedAt ?? null),
    changes: changes ?? previous?.changes ?? null,
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(items ? { items } : {}),
  }
  file.entities[kind] = next
  Filesystem.writeJsonAtomic(filePath(directory), file)

  const errorChanged = (previous?.status ?? "ok") !== next.status || previous?.error !== next.error
  if (!changes && !errorChanged) return
  const { items: _items, ...state } = next
  // Needs an instance (a turn, a server route). A sync started outside one — a bind from
  // the CLI — has no client listening anyway; the state above is what it leaves behind.
  await Bus.publish(Event.Changed, { directory: canon, datamateId, kind, state, changes }).catch((err) =>
    log.info("workspace sync change not published", { kind, err: String(err) }),
  )
}

// altimate_change end
