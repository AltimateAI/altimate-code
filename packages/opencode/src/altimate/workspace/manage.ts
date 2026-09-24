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
import { WorkspaceApi, type ProjectIdentifier } from "./api-client"
import { resolveProjectIdentifier } from "./detect"
import * as MemorySync from "./memory-sync"
import * as SkillSync from "./skill-sync"
import {
  clearLocalBinding,
  currentScope,
  peekRowUnscoped,
  readLocalBinding,
  resolveBinding,
  resolvePinnedBindingForRouting,
  type CachedBinding,
} from "./state"

const log = Log.create({ service: "altimate-workspace-manage" })

/** What this project is bound to, and what that binding currently carries. */
export interface StatusReport {
  binding: CachedBinding | null
  /** Blocks held locally for this project, and how many have not reached the
   * workspace. `null` when memory is off — "not synced" and "not applicable" are
   * different answers and a status line must not conflate them. */
  /** `unsynced: null` means the workspace's memory setting is not known — from
   * cache for the menu, which never asks; from the bounded poller path for the
   * sidebar, when the service could not be reached. Rendering that as
   * 0 would tell the user their memory is current when nobody knows. */
  memory: { local: number; unsynced: number | null } | null
  skillsEnabled: boolean
  /** When workspace skills last synced successfully, or null if they have not in
   * this process. Null is genuinely "unknown", not "never" — the store is
   * per-process, so a fresh session has not synced yet even for a project whose
   * snapshot is current on disk. Callers must not render it as "never synced". */
  skillsSyncedAt: number | null
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
  /** WHY the sweep never ran, when `gated`. Four things produce `gated: true`
   * and only one of them is the workspace's memory toggle; a toast that said
   * "memory is off" for a failed local read sent the user to a setting that was
   * fine. */
  gatedBecause?: "flag-off" | "no-binding" | "memory-off" | "read-failed"
  sent: number
  failed: number
  /** Already present in the workspace at their current payload. */
  skipped: number
  /** Refused by the service (quota, permissions). Not a transport failure. */
  declined: number
  /** Not sent this time, but not failed either: the workspace holds a newer
   * copy, or its record set could not be read. A later save retries them. Kept
   * out of `skipped`, which means "already there at its current payload" —
   * a sweep that deferred everything is not an all-clear. */
  deferred: number
}

/** What the project is linked to and how far its local state has drifted.
 *
 * Cheap enough for a status line: one binding read from the local cache and, when
 * memory is on, one index read. Network only when there is no cached row, or
 * on the poller path. */
export async function status(
  directory: string,
  opts: {
    /** Set for the sidebar poller. Resolves the workspace's memory setting
     * through the poller path — the service is asked at most once every few
     * minutes when the answer is "no" and not at all once it is "yes" — because
     * on a cold cache nothing else would ever warm it, and the counts would
     * simply never appear. The binding goes through the resolver too: the
     * poll runs in the background, and it is what revalidates a cached row.
     *
     * Unset for the `/workspace` menu, which is awaited before the dialog can
     * open and must NOT wait on the network: there the setting is read from
     * cache alone and reported as unknown (`null`) if not held, and a cached
     * row is taken as it is. `sync` does the live check. */
    poll?: boolean
    /** A binding the caller has already resolved this pass. The sidebar
     * resolves before it asks for status; resolving again here doubled the
     * requests during an outage, when neither answer is memoized. */
    binding?: CachedBinding | null
  } = {},
): Promise<StatusReport> {
  // The cached row first, and the resolver only when there is none — for the
  // menu. A fresh clone, or a new machine, whose project is still bound
  // server-side has no cached row, and reading only the cache answered "this
  // project is not linked" with a lone Done — so that case asks. But the
  // resolver revalidates a cached row too, and on the first call of a process
  // nothing has been validated yet: the menu then sat on the API's full
  // timeout when the service was unreachable.
  const binding =
    opts.binding !== undefined
      ? opts.binding
      : opts.poll
        ? await resolveBinding(directory).catch(() => null)
        : ((await readLocalBinding(directory).catch(() => null)) ??
          (await resolveBinding(directory).catch(() => null)))
  return {
    binding,
    memory: await memoryCounts(directory, binding, opts.poll === true),
    skillsEnabled: SkillSync.isEnabled(),
    skillsSyncedAt: await skillsSyncedAt(directory, binding),
  }
}

/** The age of the last clean skill sync FOR THIS BINDING, or null. */
async function skillsSyncedAt(directory: string, binding: CachedBinding | null): Promise<number | null> {
  if (!binding) return null
  const scope = await currentScope()
  if (!scope) return null
  return SkillSync.lastSuccessfulSyncAt(directory, { datamateId: binding.datamateId, ...scope })
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
        memory = await MemorySync.refresh(sessionID, directory)
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
  const gated = (why: NonNullable<SyncReport["gatedBecause"]>): SyncReport => ({
    gated: true,
    gatedBecause: why,
    sent: 0,
    failed: 0,
    skipped: 0,
    declined: 0,
    deferred: 0,
  })
  if (!MemorySync.isEnabled()) return gated("flag-off")
  // altimate_change — the IDE extension's pin outranks the project's own link, as it does for
  // the per-write mirror (`memory-sync.resolveBinding`). Without it an extension-launched `serve`
  // answered "not linked" for the workspace it was pinned to. Only the pin arm is layered, so an
  // unpinned session keeps the cache-only read, and a pin that cannot be honoured stays gated
  // rather than falling through to the project's link.
  const pinned = await resolvePinnedBindingForRouting(directory).catch(() => ({ status: "unknown" as const }))
  const binding = pinned
    ? pinned.status === "bound"
      ? pinned.binding
      : null
    : await readLocalBinding(directory).catch(() => null)
  if (!binding) return gated("no-binding")

  const blocks = await MemoryStore.listAll({ directory }).catch((err) => {
    log.warn("could not read local memory for a workspace sync", { err: String(err) })
    return null
  })
  if (blocks === null) return gated("read-failed")

  // No empty-list short-circuit. It answered `gated: false` without consulting
  // the workspace's memory setting, so a bound project whose workspace has
  // memory switched OFF was told the sweep ran and found nothing — when
  // `backfill` would have refused to run at all. Letting `backfill` decide costs
  // one enablement check on an explicit user action and makes the two agree by
  // construction, which is the whole point of `gated`.
  const result = await MemorySync.backfill(blocks, binding, directory)
  return {
    gated: result.gated,
    // `backfill` gates on exactly one thing this far in: the workspace's own
    // setting. The flag and the binding were checked above.
    gatedBecause: result.gated ? "memory-off" : undefined,
    sent: result.ok,
    failed: result.failed,
    skipped: result.skipped,
    declined: result.declined,
    deferred: result.deferred,
  }
}

/** Local block count and how many have not reached the workspace, or null when
 * the memory feature is off in this build. A workspace whose own memory setting
 * is off still gets a count: the local blocks are real, and `unsynced: 0` is the
 * accurate claim — nothing is pending against a workspace that accepts nothing.
 * Best-effort: a status line must not fail because an index read did.
 *
 * The enablement policy differs by caller, and both are deliberate.
 *
 * The `/workspace` menu (`poll` false) is awaited before the dialog can appear,
 * so it reads the setting from cache alone: the check behind `pendingCount` is a
 * GET with a 15s budget, and on a slow or dead link the menu looked like it did
 * nothing. Not known from cache is `null`, and `sync` does the live check.
 *
 * The sidebar poller (`poll` true) may ask, on the rate-limited poller path.
 * It runs in the background, so a wait costs nothing visible — and on a cold
 * cache it is the only thing that will ever warm the answer the menu then
 * reads. Either way, "unknown" is reported as unknown, never as zero. */
async function memoryCounts(
  directory: string,
  binding: CachedBinding | null,
  poll: boolean,
): Promise<{ local: number; unsynced: number | null } | null> {
  if (!MemorySync.isEnabled()) return null
  try {
    const blocks = await MemoryStore.listAll({ directory })
    if (poll && binding) {
      const status = await MemorySync.memoryEnabledForPoller(binding)
      // "disabled" is a real answer: memory is off, so nothing is outstanding
      // and 0 is the truth. "unknown" is not — the service could not be
      // reached, and reporting 0 there claims the workspace is up to date on
      // the strength of a failed request.
      if (status !== "enabled") return { local: blocks.length, unsynced: status === "disabled" ? 0 : null }
      // Enablement is settled; `pendingCount`'s own gate must not re-ask.
      return { local: blocks.length, unsynced: await MemorySync.pendingCount(blocks, binding, { trustEnabled: true }) }
    }
    return { local: blocks.length, unsynced: await MemorySync.pendingCount(blocks, binding, { network: false }) }
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
  /** True when there WAS a snapshot and it could not be removed — the purge
   * refused (a symlinked `.altimate-code`) or threw. Distinct from "nothing to
   * remove", which is the ordinary case and not worth a warning. */
  skillsLeftBehind: boolean
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
  // First, before any await: the row under whatever account the file belongs
  // to, so the cleanup can tell a file that was already another account's
  // from one another account wrote during the request. Taken any later and a
  // relink landing during the reads below would be captured as pre-existing.
  const before = peekRowUnscoped(directory)
  const was = await readLocalBinding(directory).catch(() => null)
  // Pinned before the server call. The cleanup below keys on this scope, and
  // resolving it again afterwards could name a different account if the
  // credentials changed mid-unlink — the removed binding would then stay on
  // disk under the account that deleted it.
  const scope = await currentScope()

  // Identify the binding by what it was RECORDED with, not by what this checkout
  // looks like now. The two diverge: a repo whose remote was renamed, or added
  // after the link, re-detects as a different project — and the delete would then
  // name a binding that is not the one being unlinked, or none at all. The cached
  // row carries the server's own identifiers, so it says exactly which row to
  // remove. `unbindProject` sends one identifier and prefers the remote, so the
  // recorded path rides along only when there is no recorded remote. Detection —
  // a blocking git call — is reached only for a project with no local row, which
  // is the case unlink exists to repair.
  let identifier: ProjectIdentifier
  if (was?.repoRemote) identifier = { repoRemote: was.repoRemote }
  else if (was?.projectPath) identifier = { projectPath: was.projectPath }
  else {
    const detected = resolveProjectIdentifier(directory)
    identifier = detected
    // No cached row, and detection alone is not enough here. `unbindProject`
    // sends the remote whenever one is present, so a project the server bound
    // by PATH (linked before it had a remote, or linked from a checkout without
    // one) would be deleted by an identifier the server never stored: 404,
    // which this client reads as "nothing to remove", clears local state, and
    // leaves the binding live to be re-adopted on the next resolve. Ask which
    // arm the server actually matches on and delete on that one — `matchedBy`
    // exists for exactly this choice. A lookup that cannot be made propagates:
    // swallowing it fell back to the detected identifier, which is the exact
    // wrong-arm delete this branch exists to avoid, with local state cleared
    // behind it. The client already maps a genuine 404 to `null`.
    const hit = await WorkspaceApi.getBindingForProject(detected)
    if (hit?.matchedBy === "path" && detected.projectPath) {
      identifier = { projectPath: detected.projectPath }
    }
  }
  const removedServerSide = await WorkspaceApi.unbindProject(identifier)

  // Only the row unlink started from. A relink that completed while the DELETE
  // was in flight recorded a new row, and removing that — then memoizing the
  // miss over it for five minutes — would undo a link the user just made. With
  // no cached row to start from, any row present now is that relink.
  const local = await clearLocalBinding(directory, {
    scope,
    expect: was ? { datamateId: was.datamateId, linkedAt: was.linkedAt } : "none",
    before,
  })
  if (local === "kept") {
    // A relink landed during the request. Whether its server-side row
    // survived depends on ordering: a relink that reached the server BEFORE
    // the DELETE was removed by it, since the DELETE names the project, not
    // a row. Ask before keeping local state that says bound: a row the server
    // no longer holds would otherwise stand until the next revalidation.
    // Asked by the identifiers the relink RECORDED, for the same reason the
    // delete used the original row's: this checkout's remote may have changed
    // during the request, and a re-detect would then miss a remote-only row.
    const kept = await readLocalBinding(directory).catch(() => null)
    const keptUnscoped = peekRowUnscoped(directory)
    const identifier: ProjectIdentifier | null = kept?.repoRemote
      ? { repoRemote: kept.repoRemote }
      : kept?.projectPath
        ? { projectPath: kept.projectPath }
        : null
    let serverStillBound: boolean | null = null
    if (identifier) {
      try {
        serverStillBound = (await WorkspaceApi.getBindingForProject(identifier)) !== null
      } catch (err) {
        // Unknown, not unbound — keep the row rather than remove it on a blip.
        log.warn("could not confirm the relinked binding after unlink", { err: String(err) })
      }
    }
    // The snapshot belongs to the binding the relink recorded — its own bind
    // synced it — and is not this unlink's to remove. The overlay is reset
    // regardless: hydration is idempotent per session, so a session that
    // already pulled the OLD workspace's memory keeps it until told
    // otherwise, and the relink is not what told it.
    const leaveRelinked = (): UnlinkReport => {
      log.info("unlink left a binding recorded during the request in place")
      try {
        MemorySync.resetOverlay()
      } catch (err) {
        log.warn("could not reset the memory overlay after a relink", { err: String(err) })
      }
      return { was, removedServerSide, skillsPurged: false, skillsLeftBehind: false }
    }
    if (serverStillBound !== false || !kept) return leaveRelinked()
    log.info("the binding recorded during unlink was removed by it; clearing local state")
    // Still guarded: a further relink could have landed since the check — and
    // if one did, it is kept the same way, snapshot included.
    const again = await clearLocalBinding(directory, {
      scope,
      expect: { datamateId: kept.datamateId, linkedAt: kept.linkedAt },
      before: keptUnscoped,
    })
    if (again === "kept") return leaveRelinked()
  }
  // Skills are not the only thing a detached workspace leaves behind. `hydrate`
  // is idempotent for the life of a session, so a session that already pulled
  // this workspace's memory keeps it for every later prompt — still answering
  // out of a workspace this project is no longer bound to. Same reset the
  // refresh path uses when it has no session to reload in place.
  // Unconditional. `overlayBlocks()` is not gated on the flag, so a flag
  // flipped off mid-session would otherwise leave the old overlay merged into
  // every later prompt.
  try {
    MemorySync.resetOverlay()
  } catch (err) {
    log.warn("could not reset the memory overlay after unlink", { err: String(err) })
  }
  // Without this the workspace's skills keep loading into every session of a
  // project that is no longer bound to it — the snapshot lives under the
  // ordinary skill glob, so nothing else would stop it.
  const purge = await SkillSync.purgeManagedSnapshot(directory, "the project was unlinked from its workspace").catch(
    (err) => {
      log.warn("could not purge the workspace skill snapshot after unlink", { err: String(err) })
      return "failed" as const
    },
  )

  return {
    was,
    removedServerSide,
    skillsPurged: purge === "removed",
    // The caller must say this. A toast reading "Unlinked from X" while the
    // snapshot is still on disk means X's skills keep loading into every session
    // of a project that is no longer bound to it, and nothing else will tell the
    // user why.
    skillsLeftBehind: purge === "refused" || purge === "failed",
  }
}
