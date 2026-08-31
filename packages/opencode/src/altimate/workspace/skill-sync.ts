// altimate_change - new file
//
// Mirror a bound workspace's custom skill bundles onto disk, where the existing
// skill discovery in ``@/skill`` finds them with no other change.
//
// Scope (v0): custom uploaded bundles only. The 21 skills that ship with the
// binary already live in ``~/.altimate/builtin``, and the datamate-computed
// skills document MCP tool names rather than this CLI's tools — neither is
// synced here.
//
// Activation is not handled HERE, but that is not the same as "cannot happen".
// A synced skill is discovered like any other: normally it is listed in
// ``<available_skills>`` by name + description and loaded only when the model
// invokes the Skill tool. Whatever frontmatter an author put in the bundle
// flows through untouched — including ``alwaysApply`` and ``applyPaths``, which
// discovery carries into ``Info`` (skill/index.ts) and which
// ``collectAutoLoadedSkills`` (session/system.ts) injects into every applicable
// system prompt with no Skill-tool call and no permission prompt.
//
// That is a real consequence worth stating plainly: anyone who can upload a
// skill to a workspace can put standing instructions into the prompts of every
// member bound to it. The backend has no activation field, so this can only
// arrive through the uploaded SKILL.md.
//
// This was raised in review as needing an explicit product decision rather than
// a source comment, and it has one: auto-activation is APPROVED FOR THE PILOT,
// so synced bundles keep `alwaysApply`/`applyPaths` and this module does not
// strip frontmatter an author wrote. The exposure is therefore accepted, not
// overlooked, and is bounded by who can upload to a workspace — revisit it if
// upload rights widen beyond the pilot's members.
//
// Server contract (app/api/datamates/custom_skills.py, mounted at ``/skills``):
//   GET ""                       -> Page[CustomSkillSummary]  (paginated)
//   GET "/{public_id}"           -> CustomSkillDetail  (adds files[] + content)
//   GET "/{public_id}/files/{p}" -> {path, content} JSON (NOT raw bytes)
// The summary carries ``file_count``, not an inventory, and nothing in the API
// exposes a checksum — ``CustomSkillFileMeta`` is ``{path, size}``. So change
// detection is per-skill ``updated_at`` and the only integrity check available
// is byte length.
import fs from "fs/promises"
import { statSync } from "node:fs"
import path from "path"
import { Flag as CoreFlag } from "@opencode-ai/core/flag/flag"
import { Log } from "@/altimate/util/log"
import { AltimateApi } from "@/altimate/api/client"
import { resolveBindingOutcome, type CachedBinding } from "./state"
import { altimateRequest, WorkspaceApiError } from "./api-client"

const log = Log.create({ service: "altimate-workspace-skill-sync" })

/** Base path for the skills API on the backend (``custom_skills_router`` is
 * mounted at ``/skills`` in ``app/main.py``). */
const SKILLS_BASE = "/skills"

/** The list endpoint is paginated by ``add_pagination(app)``; walk every page
 * rather than trusting the first. A bound is kept so a server that never
 * advances ``page`` cannot spin forever. */
const MAX_PAGES = 50

/** Managed subdirectory. Everything inside is ours and may be replaced
 * wholesale; nothing outside it is ever written or removed. The directory
 * boundary is the ownership marker — we deliberately do NOT stamp a marker
 * into the files themselves, because unlike the VS Code extension (which
 * generates rule files) we mirror author-written content verbatim, and editing
 * it would alter what the model reads. */
const MANAGED_DIR = path.join(".altimate-code", "skill", "_workspace")
/** Staging lives here, deliberately NOT under `.altimate-code/skill/`, which
 * discovery scans. See the swap in `syncSkills`. */
const STAGING_DIR = path.join(".altimate-code", "skill-staging")
const MANIFEST_NAME = ".manifest.json"

export interface ManifestSkill {
  /** Server's ``updated_at``, verbatim. The only change signal the API offers. */
  updatedAt: string
  files: Record<string, number>
}

export interface Manifest {
  version: 1
  tenant: string
  apiUrl: string
  datamateId: number
  skills: Record<string, ManifestSkill>
}

/** A row of ``Page[CustomSkillSummary]``, narrowed to what sync needs. */
interface RemoteSummary {
  publicId: string
  updatedAt: string
}

/** ``CustomSkillDetail.files`` — ``CustomSkillFileMeta`` is ``{path, size}``. */
interface RemoteFile {
  path: string
  size: number
}

export function isEnabled(): boolean {
  return CoreFlag.ALTIMATE_WORKSPACE
}

function managedRoot(directory: string): string {
  return path.join(directory, MANAGED_DIR)
}

/** Every mutable table below is anchored on a process-global rather than being
 * plain module state. This file is reached through two different module graphs
 * in the same process — the bind path resolves it via one specifier and the
 * per-turn hook via another — and the runtime keeps a separate module record
 * for each, so module-level `Map`s silently fork — `inFlight` included, which
 * would let a bind and a turn stage and swap the same project concurrently.
 * A symbol-keyed global gives every copy of this module the same tables.
 *
 * Note this only reaches copies sharing a realm. Threads do NOT share
 * `globalThis`, so anything a bind must hand to a later turn goes through disk
 * instead — see `snapshotFingerprint`. */
/** Distinguishes the copies of this module that share a process.
 *
 * Staging directories are named `<kind>-<pid>-<realm>`. The pid alone is not
 * enough: a bind and a turn run on different threads, which share a pid but not
 * this module's state, so both would compute the same path — and `sweepStaging`
 * deliberately does NOT spare its own pid, so each would delete the other's
 * half-written tree and publish a mix of the two under one manifest. The pid
 * stays in the name so the cross-PROCESS liveness guard still works. */
const REALM_ID = Math.random().toString(36).slice(2, 8)

const STORE_KEY = Symbol.for("altimate.workspace.skill-sync.store")

interface SyncStore {
  inFlight: Map<string, Promise<{ changed: boolean }>>
  lastSyncedAt: Map<string, number>
  registryAppliedAt: Map<string, number>
  syncedFor: Map<string, string>
}

const globals = globalThis as unknown as Record<symbol, SyncStore | undefined>
const store: SyncStore = (globals[STORE_KEY] ??= {
  inFlight: new Map(),
  lastSyncedAt: new Map(),
  registryAppliedAt: new Map(),
  syncedFor: new Map(),
})

/** In-flight sync per canonical project directory, so a bind and a session
 * start racing on the same project do not both stage and swap. */
const inFlight = store.inFlight

/** How long a snapshot is trusted before the next turn re-checks the workspace.
 *
 * `prompt` runs per message, so syncing on every turn would put an HTTP round
 * trip in the one path whose first-answer latency is measured. Syncing once per
 * process is the other extreme: a skill added in the SaaS never reaches a
 * session that is already open. This bounds the staleness instead — at most one
 * list call per project per interval, and the list is Postgres-only server-side
 * (no S3 reads), so the check is cheap when nothing changed. */
const POLL_INTERVAL_MS = 5 * 60 * 1000

/** Ceilings on one snapshot. Nothing upstream bounds a workspace's size, and
 * every file is read fully into memory before it reaches disk, so without these
 * a single oversized bundle is an out-of-memory crash rather than a failed
 * sync. Exceeding either abandons the snapshot the same way any other error
 * does — the previous one is kept. */
const MAX_TOTAL_BYTES = 32 * 1024 * 1024
const MAX_TOTAL_FILES = 2000

/** Last SUCCESSFUL sync per canonical project, for the interval above. A failed
 * attempt must not stamp: doing so suppresses retry for a full interval on a
 * transient error, which is the opposite of what a failure should cause. */
const lastSyncedAt = store.lastSyncedAt

/** Which snapshot this caller has already refreshed its skill registry for.
 *
 * The comparison is against a fingerprint taken from DISK, not from a sibling
 * in-memory table. A bind and a turn do not share memory: the runtime loads this
 * module once per thread, so each gets its own module record AND its own
 * `globalThis`. A bind stamping an in-process map is invisible to the thread
 * that serves the next turn, which is exactly why a workspace linked
 * mid-session stayed invisible to the agent until the process restarted. The
 * manifest is swapped into place by every sync that changes files and removed
 * by a deactivate, so its mtime moves on exactly the events a refresh must
 * follow — and every thread reads the same number. */
const registryAppliedAt = store.registryAppliedAt

/** mtime of the snapshot manifest, or 0 when there is no snapshot. Both
 * directions matter: a sync that adds one moves this off 0, and a deactivate
 * that removes it moves it back, so a purge refreshes the registry too. */
function snapshotFingerprint(canon: string): number {
  try {
    return statSync(path.join(managedRoot(canon), MANIFEST_NAME)).mtimeMs
  } catch {
    return 0
  }
}

/** Does the skill registry still reflect a different snapshot than the one on
 * disk? True until `markRegistryApplied` records the current fingerprint. */
export function registryStale(directory: string): boolean {
  const canon = path.resolve(directory)
  const current = snapshotFingerprint(canon)
  const applied = registryAppliedAt.get(canon)
  // Nothing applied yet: stale only if there IS a snapshot. A project that has
  // never synced must not pay a config invalidation on the first turn of every
  // session. A bound project does pay one — this cannot tell a snapshot that
  // predates boot from one a bind just wrote, and refreshing a registry that
  // was already current is a cheap rescan, while missing a new one is the bug
  // this whole path exists to prevent.
  if (applied === undefined) return current !== 0
  return applied !== current
}

/** Record that the caller has refreshed the registry for the current snapshot. */
export function markRegistryApplied(directory: string): void {
  const canon = path.resolve(directory)
  registryAppliedAt.set(canon, snapshotFingerprint(canon))
}

/** Await every sync still in flight, so a short-lived process does not exit
 * with one half-finished.
 *
 * A one-shot `run` ends as soon as its turn does, which is routinely sooner
 * than a cold sync completes — measured at ~7.6s against a local backend
 * against a 2s wait bound. The staged tree was then discarded on exit and,
 * because nothing had been persisted, the next `run` started cold and lost the
 * same race: such a project never received its skills at all, however many
 * times it was run. The TUI never showed this because it outlives the sync.
 * Same reasoning as `awaitBackfill` on the bind path. */
export async function flushPendingSyncs(timeoutMs = 30_000): Promise<void> {
  const pending = [...inFlight.values()]
  if (pending.length === 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.allSettled(pending),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
  } finally {
    // An armed timer keeps the event loop alive — the very thing this is
    // called to avoid depending on.
    if (timer) clearTimeout(timer)
  }
}

/** Has this project's snapshot been checked within the poll interval? Callers
 * on a per-message path use this to skip the network entirely. */
export async function recentlySynced(directory: string): Promise<boolean> {
  // Checked first, for two reasons. It avoids a credentials read on every
  // message when the feature is off — this sits on the latency-measured path.
  // And it closes a correctness hole in the other direction: turning the flag
  // off AFTER a successful sync left `lastSyncedAt` inside the interval with a
  // matching account, so `syncSkills` was never called, `deactivate` never ran,
  // and the snapshot stayed live for up to a full interval.
  if (!isEnabled()) return false
  const canon = path.resolve(directory)
  const at = lastSyncedAt.get(canon)
  if (at === undefined || Date.now() - at >= POLL_INTERVAL_MS) return false
  // Scoped to the account in play RIGHT NOW, not the one the snapshot was
  // fetched for. Without this an account switch inside the interval keeps
  // serving the previous tenant's skills, because the poll that would notice
  // the change is the thing being skipped.
  let now: string | null = null
  try {
    const creds = await AltimateApi.getCredentials()
    now = accountKeyOf(creds.altimateInstanceName, creds.altimateUrl)
  } catch {
    // Unreadable OR absent — both fall through and let the sync decide, which
    // is the only place that distinguishes disconnected from corrupt.
    now = null
  }
  return now !== null && syncedFor.get(canon) === now
}

/** Which account each project's snapshot was last fetched for. */
const syncedFor = store.syncedFor

function accountKeyOf(tenant: string, apiUrl: string): string {
  return `${tenant}\u0000${apiUrl}`
}

async function readManifest(directory: string): Promise<Manifest | null> {
  try {
    const raw = await fs.readFile(path.join(managedRoot(directory), MANIFEST_NAME), "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return null
    const m = parsed as Partial<Manifest>
    // A manifest we cannot validate is treated as absent, never as ownership:
    // the tree it describes gets rebuilt rather than trusted.
    if (m.version !== 1) return null
    if (typeof m.datamateId !== "number") return null
    if (typeof m.tenant !== "string" || typeof m.apiUrl !== "string") return null
    if (!m.skills || typeof m.skills !== "object") return null
    return m as Manifest
  } catch {
    return null
  }
}

/** Reject a bundle path that would escape the skill's own directory. */
function safeRelativePath(p: unknown): p is string {
  if (typeof p !== "string" || !p) return false
  if (path.isAbsolute(p)) return false
  if (p.includes("\0")) return false // symmetrical with safePathComponent
  return !p.split(/[\\/]/).includes("..")
}

/** Reject a ``public_id`` that is not usable as a single directory name.
 *
 * The id is server-generated, but it is still remote input concatenated into a
 * filesystem path. Without this a malformed or compromised response could place
 * bundle files anywhere the process can write — the per-file guard above does
 * not help, because the escape happens one component earlier. */
function safePathComponent(p: unknown): p is string {
  if (typeof p !== "string" || !p) return false
  if (p === "." || p === "..") return false
  if (path.isAbsolute(p)) return false
  // These two are written as FILES at the staged root. An id of either name
  // becomes a directory there, the write fails EISDIR, and that workspace can
  // never sync again.
  if (p === MANIFEST_NAME || p === ".gitignore") return false
  return !/[\\/\0]/.test(p)
}

/** Read one page of the list endpoint, refusing anything unrecognised.
 *
 * Returning null means "error", never "empty" — the distinction is what stops a
 * malformed 200 from reading as an empty workspace and deleting the user's
 * tree. ``api-client``'s helpers coerce unknown envelopes to ``[]``, so an
 * empty result is only trustworthy when the envelope itself parsed. */
function parsePage(payload: unknown, expectedPage: number): { rows: RemoteSummary[]; pages: number } | null {
  if (!payload || typeof payload !== "object") return null
  const p = payload as { items?: unknown; pages?: unknown }
  if (!Array.isArray(p.items)) return null
  // `pages` decides when to stop paginating, so a missing or nonsense value
  // must be an error, not a default of 1 — defaulting turns a partial first
  // page into "the whole workspace" and prunes everything on later pages.
  const rawPages = (payload as { pages?: unknown }).pages
  if (typeof rawPages !== "number" || !Number.isInteger(rawPages) || rawPages < 1) return null
  const pages = rawPages
  // An empty page while the envelope claims rows exist is a proxy or backend
  // inconsistency, not an empty workspace — and "empty workspace" is the one
  // answer that deletes the user's snapshot. Refuse it.
  const total = (payload as { total?: unknown }).total
  if (p.items.length === 0 && typeof total === "number" && total > 0) return null
  // A page that is not the one requested means the accumulation below would be
  // wrong; treat it as unrecognised rather than merging it.
  const echoed = (payload as { page?: unknown }).page
  if (typeof echoed === "number" && echoed !== expectedPage) return null
  const rows: RemoteSummary[] = []
  for (const row of p.items) {
    if (!row || typeof row !== "object") return null
    const r = row as { public_id?: unknown; updated_at?: unknown }
    if (typeof r.public_id !== "string" || !r.public_id) return null
    if (typeof r.updated_at !== "string" || !r.updated_at) return null
    rows.push({ publicId: r.public_id, updatedAt: r.updated_at })
  }
  return { rows, pages }
}

/** ``GET /skills/{id}/files/{path}`` answers ``{path, content}``. Anything else
 * is an error, not an empty file — see ``parsePage`` for why that matters. */
function parseFileContent(body: unknown, expectedPath: string): string | null {
  if (!body || typeof body !== "object") return null
  const b = body as { content?: unknown; path?: unknown }
  // The echoed path must be the one requested. Without checking it, a
  // mis-routed or cached response of the same length is written under the
  // filename we asked for — and no checksum exists to catch it later.
  // Required, not "checked when present": a mis-routed or cached response is
  // exactly the case where the field may be absent, which is what this guard
  // was written for.
  if (b.path !== expectedPath) return null
  return typeof b.content === "string" ? b.content : null
}

function parseDetailFiles(payload: unknown): RemoteFile[] | null {
  if (!payload || typeof payload !== "object") return null
  // The detail view wraps its body in ``{skill: {...}}`` while the list view
  // does not wrap at all. Verified against a local backend on `development`;
  // the inconsistency is the contract, so accept the wrapper and also the bare
  // object in case the envelope is ever dropped.
  const inner = (payload as { skill?: unknown }).skill
  const body = inner && typeof inner === "object" ? inner : payload
  const files = (body as { files?: unknown }).files
  if (!Array.isArray(files)) return null
  const out: RemoteFile[] = []
  for (const f of files) {
    if (!f || typeof f !== "object") return null
    const e = f as { path?: unknown; size?: unknown }
    if (!safeRelativePath(e.path)) return null
    if (typeof e.size !== "number" || e.size < 0) return null
    out.push({ path: e.path, size: e.size })
  }
  return out
}

/** Is the managed directory ours to replace?
 *
 * Ours means: absent, or present with the manifest this module writes. Anything
 * else is a directory that happens to sit at our path — a hand-written skill, a
 * checkout from an older tool — and we must not delete it. The name is ours by
 * convention only, and convention is not an ownership check. */
async function ownsManagedDir(directory: string): Promise<boolean> {
  const root = managedRoot(directory)
  let entries: string[]
  try {
    entries = await fs.readdir(root)
  } catch (err) {
    // ONLY "absent" means the first sync may create it. `readdir` also throws
    // ENOTDIR for a plain file at this path and EACCES for a directory we
    // cannot read — answering "ours" to those hands a user's own file to
    // `fs.rm`, which is the exact outcome this guard exists to prevent.
    return (err as NodeJS.ErrnoException)?.code === "ENOENT"
  }
  if (entries.length === 0) return true
  if (!entries.includes(MANIFEST_NAME)) return false
  // The filename alone is not proof. A directory holding an unrelated or
  // corrupt `.manifest.json` is someone else's; require one we can actually
  // read as ours.
  return (await readManifest(directory)) !== null
}

/** Is every component this module writes through a real directory?
 *
 * `readdir` follows symlinks, so a repository shipping
 * ``.altimate-code/skill-staging -> ../..`` (git tracks symlinks, so it
 * survives a clone) would have the sweep below enumerate and recursively delete
 * the link's target. The same applies to symlinked ANCESTORS, which every
 * mkdir, rename and write resolves through. Nothing here should ever traverse a
 * link, so refuse rather than try to make traversal safe. */
async function pathsAreReal(directory: string): Promise<boolean> {
  const candidates = [
    path.join(directory, ".altimate-code"),
    path.join(directory, ".altimate-code", "skill"),
    path.join(directory, STAGING_DIR),
    managedRoot(directory),
  ]
  for (const candidate of candidates) {
    try {
      const st = await fs.lstat(candidate)
      if (!st.isDirectory()) return false // a symlink lstats as a link, not a dir
    } catch (err) {
      // Absent is fine — it will be created as a real directory.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") return false
    }
  }
  return true
}

/** Remove staging trees this project abandoned — a SIGKILL mid-sync leaves one
 * behind, and nothing else would ever collect it. */
async function sweepStaging(directory: string): Promise<void> {
  const dir = path.join(directory, STAGING_DIR)
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return // nothing staged
  }
  for (const entry of entries) {
    // Leave another process's work alone. These are named `<kind>-<pid>`, and
    // deleting a live owner's staging makes it publish a snapshot missing every
    // file written before the sweep, with a manifest that claims them.
    // `<kind>-<pid>` (older trees) or `<kind>-<pid>-<realm>` (current).
    const owner = /-(\d+)(?:-[a-z0-9]+)?$/.exec(entry)?.[1]
    const mine = entry.endsWith(`-${process.pid}-${REALM_ID}`)
    // Another live process's tree is never touched. Within THIS process only
    // this realm's own tree is swept: a sibling thread's staging is in flight,
    // and deleting it makes that thread publish a tree missing everything
    // written so far, under a manifest that claims the files.
    if (owner && owner === String(process.pid) && !mine) continue
    if (owner && owner !== String(process.pid) && processAlive(Number(owner))) continue
    const target = path.join(dir, entry)
    try {
      const st = await fs.lstat(target)
      if (!st.isDirectory()) {
        // A symlink here would have `rm -r` follow into its target.
        await fs.unlink(target).catch(() => {})
        continue
      }
    } catch {
      continue
    }
    await fs.rm(target, { recursive: true, force: true }).catch(() => {})
  }
}

/** Is a PID still running? Used only to avoid sweeping a live sibling's staging;
 * a wrong answer costs a stale directory, never a deletion of live work. */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM"
  }
}

/** Take the snapshot out of service when this client is no longer entitled to
 * serve it — the account was disconnected, or the feature was switched off.
 *
 * Leaving it is not neutral. Discovery loads whatever is on disk without
 * consulting the manifest, so a disconnected user keeps getting the workspace's
 * skills, and any of them carrying ``alwaysApply`` keeps being injected into
 * every prompt. Returns whether anything was actually removed, so the caller
 * knows to refresh the registry.
 *
 * Only removes a tree this client owns, for the same reason the sync does. */
async function deactivate(directory: string, why: string): Promise<boolean> {
  const root = managedRoot(directory)
  try {
    await fs.stat(root)
  } catch {
    return false // nothing published here
  }
  if (!(await ownsManagedDir(directory))) return false
  await removeManaged(directory)
  await sweepStaging(directory)
  log.info("removed the workspace skill snapshot", { why, path: root })
  return true
}

async function removeManaged(directory: string): Promise<void> {
  await fs.rm(managedRoot(directory), { recursive: true, force: true })
}

/** Sync the bound workspace's custom skills into ``directory``.
 *
 * Never throws: skills must not be able to block a bind or a turn. Every
 * failure path leaves whatever is already on disk in place, except the
 * deliberate purge described below. */
export async function syncSkills(directory: string): Promise<{ changed: boolean }> {
  const canon = path.resolve(directory)
  // Joined BEFORE the flag is read, so the opt-out purge is serialised against
  // a sync too. Both paths write the same tree; with the purge outside this
  // gate, an enabled run already past its own flag check could publish
  // `_workspace` moments after a disabled run deleted it, leaving a snapshot on
  // disk for a feature that is off. (bot review)
  const existing = inFlight.get(canon)
  if (existing) {
    // Report the joined run's real outcome. Returning a hard-coded `false` is a
    // false answer waiting for the next caller to trust it.
    return await existing.catch(() => ({ changed: false }))
  }
  if (!isEnabled()) {
    // Opting out has to actually take effect: a snapshot left behind keeps
    // loading into every session. Still gated on the symlink check — this path
    // deletes, and it runs before the one inside `run`, so without it a
    // symlinked `.altimate-code` would have the purge follow the link.
    const purge = (async () => {
      const dropped = (await pathsAreReal(canon).catch(() => false))
        ? await deactivate(canon, "the workspace feature is off").catch(() => false)
        : false
      return { changed: dropped }
    })()
    inFlight.set(canon, purge)
    try {
      return await purge
    } finally {
      inFlight.delete(canon)
    }
  }
  let changed = false
  let failed = false
  // Set once the workspace's list has actually been read. Only then has this
  // project been "checked", and only then should the poll interval start.
  let sawRemote = false
  const run = (async () => {
    // Checked BEFORE the binding: `resolveBinding` needs credentials too, so a
    // disconnected client would otherwise return on a null binding and never
    // reach this. Disconnected is different from "could not read the
    // credentials" — the first is a decision the user made and must take
    // effect, the second is unknown, and unknown never destroys a snapshot.
    if (!(await AltimateApi.isConfigured())) {
      // Symlink-guarded like every other deletion here. This branch runs BEFORE
      // the `pathsAreReal` check below, so without its own guard a symlinked
      // `.altimate-code` has `removeManaged`/`sweepStaging` resolve through the
      // link and delete the target's tree. (bot review)
      if ((await pathsAreReal(canon).catch(() => false)) && (await deactivate(canon, "no altimate credentials")))
        changed = true
      return
    }

    // Nothing below should ever traverse a symlink. Checked before any write,
    // rename or sweep, all of which resolve through these components.
    if (!(await pathsAreReal(canon))) {
      log.warn("refusing to sync: a workspace skill path is not a real directory", {
        path: managedRoot(canon),
      })
      failed = true
      return
    }

    // Read credentials and the manifest BEFORE resolving the binding, so an
    // account switch can be acted on. `resolveBinding` returns null for both
    // "confirmed unbound" and "lookup failed", and the old code returned on
    // that null before ever reaching the foreign-manifest purge — so switching
    // to an account with no binding here left the previous tenant's skills on
    // disk and loading into prompts, with every retry hitting the same return.
    const credsForPurge = await AltimateApi.getCredentials().catch(() => null)
    if (credsForPurge) {
      const priorManifest = await readManifest(canon)
      if (
        priorManifest &&
        (priorManifest.tenant !== credsForPurge.altimateInstanceName ||
          priorManifest.apiUrl !== credsForPurge.altimateUrl)
      ) {
        if (await deactivate(canon, "the snapshot belongs to another account")) changed = true
      }
    }

    // `resolveBinding`, not `readLocalBinding`: the local cache is written only
    // by an explicit link, so a project bound server-side (fresh clone, new
    // machine, cleared state) would otherwise never get its workspace's skills.
    const outcome = await resolveBindingOutcome(canon)
    if (outcome.status !== "bound") {
      // A CONFIRMED unbind must take the snapshot out of service — discovery
      // does not consult the manifest, so leaving it keeps serving a workspace
      // this project is no longer attached to. "Unknown" must not: a lookup
      // failure is not evidence of anything, and deleting on it would wipe a
      // snapshot on a network blip.
      if (outcome.status === "unbound") {
        if (await deactivate(canon, "this project is no longer bound to a workspace")) changed = true
      }
      return
    }
    const binding = outcome.binding

    // Refuse to touch a directory we did not create. Everything below either
    // deletes this tree or replaces it wholesale, so without this a user's own
    // files at our path are destroyed by a routine sync.
    if (!(await ownsManagedDir(canon))) {
      log.warn(
        "refusing to manage the workspace skill directory: it has contents this client did not write",
        { path: managedRoot(canon) },
      )
      return
    }
    await sweepStaging(canon)

    let creds: { altimateUrl: string; altimateInstanceName: string }
    try {
      creds = await AltimateApi.getCredentials()
    } catch (err) {
      log.warn("could not read altimate credentials; keeping the existing snapshot", {
        err: String(err),
      })
      return
    }

    const manifest = await readManifest(canon)

    // Purge on rebind or account change. ``recordApprovedBinding`` persists the
    // new binding before any sync runs, and skill discovery loads whatever is
    // on disk without consulting this manifest — so leaving a previous
    // workspace's tree in place through a failed pull would silently feed the
    // model another workspace's skills. Empty is correct; wrong-workspace is not.
    const foreign =
      manifest !== null &&
      (manifest.datamateId !== binding.datamateId ||
        manifest.tenant !== creds.altimateInstanceName ||
        manifest.apiUrl !== creds.altimateUrl)
    if (foreign) {
      log.info("this project's snapshot belongs to another workspace or account; dropping it", {
        was: manifest.datamateId,
        now: binding.datamateId,
      })
      await removeManaged(canon)
      changed = true
    }

    const remote = await listAll(binding)
    if (!remote) return // error, not empty — keep what is on disk
    sawRemote = true
    syncedFor.set(canon, accountKeyOf(creds.altimateInstanceName, creds.altimateUrl))

    if (!foreign && (await upToDate(canon, manifest, remote))) return

    if (remote.length === 0) {
      await removeManaged(canon)
      changed = true
      log.info("workspace has no custom skills; removed the local snapshot")
      return
    }

    // Stage a complete snapshot, then swap. A partial bundle is never
    // published: any failure abandons the staging directory and leaves the
    // previous snapshot untouched.
    const root = managedRoot(canon)
    // Staged OUTSIDE `.altimate-code/skill/`, because discovery globs
    // `{skill,skills}/**/SKILL.md` from the config dir — a staging tree that
    // lived beside `_workspace` would be scanned, so a half-downloaded snapshot
    // (or one abandoned by a SIGKILL) would be loaded as real skills.
    const staging = path.join(canon, STAGING_DIR, `pending-${process.pid}-${REALM_ID}`)
    await fs.mkdir(path.join(canon, STAGING_DIR), { recursive: true })
    await fs.writeFile(path.join(canon, STAGING_DIR, ".gitignore"), "*\n").catch(() => {})
    await fs.rm(staging, { recursive: true, force: true })
    const next: Manifest = {
      version: 1,
      tenant: creds.altimateInstanceName,
      apiUrl: creds.altimateUrl,
      datamateId: binding.datamateId,
      skills: {},
    }
    try {
      let totalFiles = 0
      let totalBytes = 0
      let skipped = 0
      for (const summary of remote) {
        // Per skill, not per snapshot. A single unusable bundle previously threw
        // out of the whole loop, so one bad file cost the workspace EVERY skill,
        // on every client, re-attempted every poll forever. The blast radius of a
        // bad bundle is now that bundle. (review)
        try {
          if (!safePathComponent(summary.publicId)) {
            throw new WorkspaceApiError(`unusable skill id in the workspace listing: ${summary.publicId}`)
          }
          const detail = await altimateRequest<unknown>(
            "GET",
            `/${encodeURIComponent(summary.publicId)}`,
            { base: SKILLS_BASE },
          )
          const files = parseDetailFiles(detail)
          if (!files) throw new WorkspaceApiError(`unrecognised detail for ${summary.publicId}`)
          // Decided BEFORE downloading, and against this skill's declared size,
          // so a workspace that is legal server-side (10MB per bundle) but over
          // the client ceiling loses the bundles that do not fit rather than all
          // of them. (review)
          const skillFiles = files.length
          const skillBytes = files.reduce((n, f) => n + f.size, 0)
          if (totalFiles + skillFiles > MAX_TOTAL_FILES || totalBytes + skillBytes > MAX_TOTAL_BYTES) {
            throw new WorkspaceApiError(
              `would exceed the client snapshot limit (${totalFiles + skillFiles} files, ${totalBytes + skillBytes} bytes)`,
            )
          }
          const recorded: Record<string, number> = {}
          for (const file of files) {
            const encoded = file.path.split("/").map(encodeURIComponent).join("/")
            // The file endpoint answers with ``{path, content}`` JSON, not the raw
            // object — the server decodes the bundle file and hands back a string.
            const body = await altimateRequest<unknown>(
              "GET",
              `/${encodeURIComponent(summary.publicId)}/files/${encoded}`,
              // Bounded: this is the one response whose size is set by remote
              // bundle content rather than by our own query.
              { base: SKILLS_BASE, boundResponse: true },
            )
            const content = parseFileContent(body, file.path)
            if (content === null) {
              throw new WorkspaceApiError(`unrecognised file body for ${summary.publicId}/${file.path}`)
            }
            // No checksum exists in the API, so length is the only integrity check
            // available. `size` is the stored object's byte count, so the
            // comparison has to be on UTF-8 bytes rather than string length — the
            // two differ for any non-ASCII skill. It still catches a truncated
            // download, which is what would otherwise publish half a skill.
            const bytes = Buffer.from(content, "utf8")
            if (bytes.byteLength !== file.size) {
              throw new WorkspaceApiError(
                `size mismatch for ${summary.publicId}/${file.path}: expected ${file.size}, got ${bytes.byteLength}`,
              )
            }
            const dest = path.join(staging, summary.publicId, file.path)
            await fs.mkdir(path.dirname(dest), { recursive: true })
            await fs.writeFile(dest, bytes)
            recorded[file.path] = file.size
          }
          next.skills[summary.publicId] = { updatedAt: summary.updatedAt, files: recorded }
          totalFiles += skillFiles
          totalBytes += skillBytes
          next.skills[summary.publicId] = { updatedAt: summary.updatedAt, files: recorded }
        } catch (err) {
          skipped += 1
          // A skill that synced before keeps its previous copy rather than
          // disappearing over a transient failure — the same "error is never
          // emptiness" rule the rest of this file follows, applied per skill.
          const prior = manifest?.skills[summary.publicId]
          const priorDir = path.join(root, summary.publicId)
          let carried = false
          if (prior) {
            try {
              await fs.rm(path.join(staging, summary.publicId), { recursive: true, force: true })
              await fs.cp(priorDir, path.join(staging, summary.publicId), { recursive: true })
              next.skills[summary.publicId] = prior
              carried = true
            } catch {
              carried = false
            }
          }
          if (!carried) {
            await fs.rm(path.join(staging, summary.publicId), { recursive: true, force: true }).catch(() => {})
          }
          log.warn("skipping a workspace skill; the rest of the snapshot still publishes", {
            skill: summary.publicId,
            carriedPrevious: carried,
            err: String(err),
          })
        }
      }
      if (remote.length > 0 && Object.keys(next.skills).length === 0) {
        // Nothing survived. That is indistinguishable from a broken server, and
        // publishing an empty snapshot here would delete skills the user still
        // has a right to. Abandon and keep what is on disk.
        throw new WorkspaceApiError(`every workspace skill failed to sync (${skipped} of ${remote.length})`)
      }
      if (skipped > 0) {
        log.warn("published a partial workspace snapshot", { skipped, published: Object.keys(next.skills).length })
      }
      // Manifest goes inside the staged tree so files and manifest commit
      // together — a snapshot is never live without the record of what it is.
      // Ignore everything this directory holds, itself included. The tree is
      // a mirror of the workspace and is rebuilt from the server on demand, so
      // it has no business in the user's history — and committing it would put
      // one workspace's private instructions into a repo other workspaces read.
      // Written into staging so it lands atomically with the snapshot.
      await fs.writeFile(path.join(staging, ".gitignore"), "*\n")
      await fs.writeFile(path.join(staging, MANIFEST_NAME), JSON.stringify(next, null, 2))
      // Move the live tree aside rather than deleting it first. `rm` then
      // `rename` leaves a window with no snapshot at all — a crash or a reader
      // inside it sees the skills vanish. The retired tree is removed only
      // after the new one is in place.
      await fs.mkdir(path.dirname(root), { recursive: true })
      const retired = path.join(canon, STAGING_DIR, `retired-${process.pid}-${REALM_ID}`)
      await fs.rm(retired, { recursive: true, force: true }).catch(() => {})
      let hadPrevious = true
      try {
        await fs.rename(root, retired)
      } catch {
        hadPrevious = false // nothing published yet
      }
      try {
        await fs.rename(staging, root)
      } catch (err) {
        if (hadPrevious) await fs.rename(retired, root).catch(() => {})
        throw err
      }
      await fs.rm(retired, { recursive: true, force: true }).catch(() => {})
      changed = true
      log.info("workspace skills synced", {
        datamateId: binding.datamateId,
        skills: remote.length,
      })
    } catch (err) {
      failed = true
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
      log.warn("workspace skill sync failed; kept the existing snapshot", { err: String(err) })
    }
  })()
  // Published to `inFlight` so a joining caller awaits the SAME settled result
  // this one returns, rather than a hard-coded guess.
  const settled = (async () => {
    let ok = true
    try {
      await run
    } catch (err) {
      ok = false
      log.warn("workspace skill sync errored", { err: String(err) })
    }
    // Only a clean run earns the poll interval. `failed` is set by the inner
    // catch, which swallows so that skills can never block a turn.
    if (ok && !failed && sawRemote) lastSyncedAt.set(canon, Date.now())
    return { changed }
  })()
  inFlight.set(canon, settled)
  try {
    return await settled
  } finally {
    inFlight.delete(canon)
  }
}

/** Walk every page of the list endpoint. Returns null on any error or
 * unrecognised payload — callers must treat that as "unknown", not "empty". */
async function listAll(binding: CachedBinding): Promise<RemoteSummary[] | null> {
  const all: RemoteSummary[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    let payload: unknown
    try {
      payload = await altimateRequest<unknown>("GET", "", {
        base: SKILLS_BASE,
        query: { datamate_id: String(binding.datamateId), page: String(page) },
      })
    } catch (err) {
      log.warn("could not list workspace skills; keeping the existing snapshot", {
        err: String(err),
      })
      return null
    }
    const parsed = parsePage(payload, page)
    if (!parsed) {
      log.warn("workspace skill list was not in a recognised shape; keeping the existing snapshot")
      return null
    }
    // Dedupe across pages. The manifest is keyed by id, so a row repeated
    // across a page boundary makes the length comparison in `upToDate`
    // permanently unequal and re-downloads the whole workspace every poll.
    for (const row of parsed.rows) {
      if (!all.some((seen) => seen.publicId === row.publicId)) all.push(row)
    }
    if (page >= parsed.pages || parsed.rows.length === 0) return all
  }
  log.warn("workspace skill list exceeded the page bound; keeping the existing snapshot")
  return null
}

/** Does the on-disk snapshot already match the remote set?
 *
 * Compared on the server's ``updated_at`` per skill, because the API exposes no
 * checksum and the list carries only ``file_count``. */
async function upToDate(
  directory: string,
  manifest: Manifest | null,
  remote: RemoteSummary[],
): Promise<boolean> {
  if (!manifest) return false
  const ids = Object.keys(manifest.skills)
  if (ids.length !== remote.length) return false
  for (const summary of remote) {
    const local = manifest.skills[summary.publicId]
    if (!local || local.updatedAt !== summary.updatedAt) return false
  }
  // The manifest agreeing with the server says nothing about the files still
  // being there. A deleted, truncated or partially checked-out snapshot would
  // otherwise be declared current forever, and the missing skill would never
  // come back. The recorded sizes are already on hand, so verify against them.
  const root = managedRoot(directory)
  for (const [publicId, entry] of Object.entries(manifest.skills)) {
    for (const [rel, size] of Object.entries(entry.files)) {
      try {
        const stat = await fs.stat(path.join(root, publicId, rel))
        if (stat.size !== size) return false
      } catch {
        return false
      }
    }
  }
  return true
}
