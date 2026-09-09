// altimate_change - new file
//
// The operations behind `/workspace`: what this project is linked to, and the two
// ways its state can be brought back in line with the workspace.
//
// TRANSPORT-AGNOSTIC ON PURPOSE. Every function here returns a plain report and
// prints nothing, imports no TUI or CLI module, and takes its session and directory
// as arguments rather than resolving them from an ambient instance.
//
// There are two callers in view, not one. The slash command serves a user in the
// TUI. The IDE extension runs this CLI headless via `serve`, so it reaches these
// operations over an HTTP route rather than through the tool catalog — it consumes
// none of our tools, and a model-callable tool would not have reached it. Keeping
// the operations here, and the presentation in each adapter, is what lets the
// second surface be added without touching this file.
//
// What is deliberately NOT here:
//
//   * Skill-registry invalidation. `refresh` reports `skillsChanged` and leaves the
//     invalidation to the caller, because that path runs through `AppRuntime` and
//     the in-context services — the same split `session/prompt.ts` already makes.
//   * Routing/integration refresh. `Precedence` is re-derived per STEP, not per
//     session, so there is nothing stale for a user to ask for.
import { MemoryStore } from "@/memory/store"
import { Log } from "@/altimate/util/log"
import { WorkspaceApi } from "./api-client"
import { resolveProjectIdentifier } from "./detect"
import * as MemorySync from "./memory-sync"
import * as SkillSync from "./skill-sync"
import { clearLocalBinding, readLocalBinding, type CachedBinding } from "./state"

const log = Log.create({ service: "altimate-workspace-manage" })

/** What this project is bound to, and what that binding currently carries. */
export interface StatusReport {
  binding: CachedBinding | null
  /** Blocks held locally for this project, and how many have not reached the
   * workspace. `null` when memory is off — "not synced" and "not applicable" are
   * different answers and a status line must not conflate them. */
  memory: { local: number; unsynced: number } | null
  skillsEnabled: boolean
}

export interface RefreshReport {
  /** True when the skill snapshot on disk changed. The caller owns the registry
   * invalidation this implies; see the note at the top of the file. */
  skillsChanged: boolean
  /** Absent when workspace memory is off, or when no session was supplied. */
  memory?: MemorySync.RefreshResult
  /** Set when there was no session to reload in place, so the overlay was
   * invalidated instead and the next turn re-hydrates it. Callers should say so
   * rather than claim a reload that has not happened yet. */
  memoryInvalidated?: boolean
  /** Set when a half failed. `refresh` never throws: a failed re-sync must leave
   * the session with what it already had rather than take the turn down. */
  errors: string[]
}

export interface SyncReport {
  /** `true` when the sweep never ran at all — memory off, or no binding — as
   * opposed to running and having nothing to send. A caller reporting "nothing to
   * do" must be able to tell those apart. */
  gated: boolean
  sent: number
  failed: number
  /** Already present in the workspace at their current payload. */
  skipped: number
  /** Refused by the service (quota, permissions). Not a transport failure. */
  declined: number
}

/** What the project is linked to and how far its local state has drifted.
 *
 * Cheap enough for a status line: one binding read from the local cache and, when
 * memory is on, one index read. No network. */
export async function status(directory: string): Promise<StatusReport> {
  const binding = await readLocalBinding(directory).catch(() => null)
  return {
    binding,
    memory: await memoryCounts(directory),
    skillsEnabled: SkillSync.isEnabled(),
  }
}

/** Pull: bring local state in line with the workspace.
 *
 * Both halves are attempted even if one fails — they are independent, and a
 * memory outage is no reason to leave skills stale. Neither call self-throttles:
 * `recentlySynced` is a caller-side skip on the per-message path, so an explicit
 * refresh gets a real one.
 *
 * ``sessionID`` is optional because the two callers differ. A palette command has
 * no session to hand us — the plugin API exposes ``session.get(id)`` but nothing
 * that names the current one — so the memory overlay is invalidated and reloads on
 * the next turn. The server route, which the extension uses, does have one, and
 * gets the reload (and its block count) immediately. */
export async function refresh(directory: string, sessionID?: string): Promise<RefreshReport> {
  const errors: string[] = []

  let skillsChanged = false
  try {
    skillsChanged = (await SkillSync.syncSkills(directory)).changed
  } catch (err) {
    // `syncSkills` documents that it never throws. Caught anyway: this is the
    // user asking for a repair, and the one thing it must not do is fail the turn.
    errors.push(`skills: ${String(err)}`)
    log.warn("workspace skill refresh failed", { err: String(err) })
  }

  let memory: MemorySync.RefreshResult | undefined
  let memoryInvalidated = false
  if (MemorySync.isEnabled()) {
    try {
      if (sessionID) {
        memory = await MemorySync.refresh(sessionID)
        if (!memory.ok && memory.status === "error") errors.push("memory: could not be reloaded")
      } else {
        // Forget every session's hydration. `hydrate` is idempotent for the life
        // of a session, so without this the overlay a session already holds is
        // never re-read — which is the staleness the user is asking us to fix.
        MemorySync.resetOverlay()
        memoryInvalidated = true
      }
    } catch (err) {
      errors.push(`memory: ${String(err)}`)
      log.warn("workspace memory refresh failed", { err: String(err) })
    }
  }

  return { skillsChanged, memory, memoryInvalidated, errors }
}

/** Push: re-send local memory the workspace never received.
 *
 * Not a routine counterpart to `refresh` — blocks mirror as they are written, so
 * in a healthy project this sends nothing. It exists for the two states that
 * strand blocks with no other remedy:
 *
 *   * Memory was enabled AFTER the project was bound. `backfillOnBind` is reached
 *     from exactly one place (the bind path), and nothing hooks the enable, so
 *     every block written while memory was off stays local forever. Given memory
 *     ships disabled, "link, work, then enable" is the expected order.
 *   * A mirror that failed is never retried, so local and workspace diverge
 *     silently.
 *
 * `backfill` is throttled and resumable — blocks already present at their current
 * payload are skipped — so running this when there is nothing to do costs an index
 * read, not uploads. */
export async function sync(directory: string): Promise<SyncReport> {
  if (!MemorySync.isEnabled()) return { gated: true, sent: 0, failed: 0, skipped: 0, declined: 0 }
  const binding = await readLocalBinding(directory).catch(() => null)
  if (!binding) return { gated: true, sent: 0, failed: 0, skipped: 0, declined: 0 }

  const blocks = await MemoryStore.listAll({ directory }).catch((err) => {
    log.warn("could not read local memory for a workspace sync", { err: String(err) })
    return null
  })
  if (blocks === null) return { gated: true, sent: 0, failed: 0, skipped: 0, declined: 0 }

  // No empty-list short-circuit. It answered `gated: false` without consulting
  // the workspace's memory setting, so a bound project whose workspace has
  // memory switched OFF was told the sweep ran and found nothing — when
  // `backfill` would have refused to run at all. Letting `backfill` decide costs
  // one enablement check on an explicit user action and makes the two agree by
  // construction, which is the whole point of `gated`.
  const result = await MemorySync.backfill(blocks, binding, directory)
  return {
    gated: result.gated,
    sent: result.ok,
    failed: result.failed,
    skipped: result.skipped,
    declined: result.declined,
  }
}

/** Local block count and how many have not reached the workspace, or null when
 * memory is off. Best-effort: a status line must not fail because an index read
 * did. */
async function memoryCounts(directory: string): Promise<{ local: number; unsynced: number } | null> {
  if (!MemorySync.isEnabled()) return null
  try {
    const blocks = await MemoryStore.listAll({ directory })
    const binding = await readLocalBinding(directory).catch(() => null)
    return { local: blocks.length, unsynced: await MemorySync.pendingCount(blocks, binding) }
  } catch (err) {
    log.warn("could not count local memory for the workspace status", { err: String(err) })
    return null
  }
}

export interface UnlinkReport {
  /** What the project was bound to, read before anything was removed, so a
   * caller can name the workspace it just detached from. */
  was: CachedBinding | null
  /** False when the server had no active binding to remove — already unlinked
   * elsewhere, or on another machine. Not an error, and the local cleanup still
   * runs, because local state disagreeing with the server is the thing unlink
   * exists to fix. */
  removedServerSide: boolean
  /** Whether the workspace-owned skill snapshot was removed from disk. */
  skillsPurged: boolean
}

/** Detach this project from its workspace.
 *
 * Server first, deliberately. The server-side binding is the source of truth and
 * `lookupBinding` re-asks it whenever the local cache misses, so clearing local
 * state first would be undone by the very next resolve if the request then
 * failed. A server error propagates with nothing touched locally, leaving the
 * project in a consistent bound state rather than a half-unlinked one.
 *
 * The two local steps run even when the server reports nothing to remove: that
 * response means the binding is already gone server-side, which is exactly when
 * a stale local row most needs clearing. */
export async function unlink(directory: string): Promise<UnlinkReport> {
  const was = await readLocalBinding(directory).catch(() => null)

  // Identify the binding by what it was RECORDED with, not by what this checkout
  // looks like now. The two diverge: a repo whose remote was renamed, or added
  // after the link, re-detects as a different project — and the delete would then
  // name a binding that is not the one being unlinked, or none at all. The cached
  // row carries the server's own identifiers, so it says exactly which row to
  // remove. Detection is the fallback for a project with no local row, which is
  // the case unlink exists to repair.
  const detected = resolveProjectIdentifier(directory)
  let identifier = was?.repoRemote
    ? { repoRemote: was.repoRemote, projectPath: was.projectPath ?? detected.projectPath }
    : was?.projectPath
      ? { projectPath: was.projectPath }
      : detected
  if (!was) {
    // No cached row — the case unlink exists to repair — and detection alone is
    // not enough here. `unbindProject` sends the remote whenever one is present,
    // so a project the server bound by PATH (linked before it had a remote, or
    // linked from a checkout without one) would be deleted by an identifier the
    // server never stored: 404, which this client reads as "nothing to remove",
    // clears local state, and leaves the binding live to be re-adopted on the
    // next resolve. Ask which arm the server actually matches on and delete on
    // that one — `matchedBy` exists for exactly this choice.
    const hit = await WorkspaceApi.getBindingForProject(detected).catch(() => null)
    if (hit?.matchedBy === "path" && detected.projectPath) {
      identifier = { projectPath: detected.projectPath }
    }
  }
  const removedServerSide = await WorkspaceApi.unbindProject(identifier)

  await clearLocalBinding(directory)
  // Skills are not the only thing a detached workspace leaves behind. `hydrate`
  // is idempotent for the life of a session, so a session that already pulled
  // this workspace's memory keeps it for every later prompt — still answering
  // out of a workspace this project is no longer bound to. Same reset the
  // refresh path uses when it has no session to reload in place.
  if (MemorySync.isEnabled()) {
    try {
      MemorySync.resetOverlay()
    } catch (err) {
      log.warn("could not reset the memory overlay after unlink", { err: String(err) })
    }
  }
  // Without this the workspace's skills keep loading into every session of a
  // project that is no longer bound to it — the snapshot lives under the
  // ordinary skill glob, so nothing else would stop it.
  const skillsPurged = await SkillSync.purgeManagedSnapshot(
    directory,
    "the project was unlinked from its workspace",
  ).catch((err) => {
    log.warn("could not purge the workspace skill snapshot after unlink", { err: String(err) })
    return false
  })

  return { was, removedServerSide, skillsPurged }
}
