// altimate_change - new file
//
// Local binding cache — offline fallback for the server-authoritative
// pre-check. Scoped to (tenant, apiUrl) at the top level so an account switch
// silently invalidates every cached entry (the switched-to session never sees
// another tenant's workspace names).
//
// Shared between the TuiPlugin and the `altimate link` CLI subcommand so both
// entry points see the same view of local state. File lives under
// ``Global.Path.state`` at 0o600 — chmod is applied post-write since
// ``Filesystem.writeJsonAtomic`` does not chmod (see filesystem.ts:294 for
// why; codex round-2 flagged this gap).
import { chmodSync, existsSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import { AltimateApi } from "@/altimate/api/client"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { Log } from "@/altimate/util/log"
// Type-only: the value side is imported dynamically in resolveBinding to keep
// this module's import graph free of the API client at load time.
import type { Binding, ProjectBindingLookup } from "./api-client"

const CACHE_VERSION = 1

const log = Log.create({ service: "altimate-workspace-state" })

export interface CachedBinding {
  datamateId: number
  datamateName: string
  /** Either ``repoRemote`` or ``projectPath`` is populated (at least one).
   * Mirrors the server-side binding row, which is identified by whichever
   * fields it has. */
  repoRemote: string | null
  projectPath: string | null
  linkedAt: number
  /** True when this row was adopted from the server rather than created by an
   * explicit link. Consumers that mean "the user approved this" must require
   * ``!adopted``; the absent ``seededAt`` is not a substitute, because only the
   * memory backfill consults it. */
  adopted?: boolean
  /** Set once a bind-time seed completed without failures. Absent means the
   * seed has not run, errored, or was skipped because memory was off — all of
   * which must stay retryable, so a later warm sweeps again. */
  seededAt?: number
}

interface CacheFile {
  version: 1
  tenant: string
  apiUrl: string
  bindings: Record<string, CachedBinding>
}

export function cachePath(): string {
  return path.join(Global.Path.state, "altimate-workspace-bindings.json")
}

/** Runtime shape check for a parsed cache file — the JSON blob comes from
 * disk and could be anything (older CLI version, hand-edited, corrupted
 * mid-write). The type assertion alone doesn't guard against e.g.
 * ``{"version": 1, "bindings": null}`` which then throws on
 * ``cache.bindings[k]``. Discard anything that fails the shape check so
 * readers always get a valid ``CacheFile`` or null. (CR round 2.) */
function isValidCacheFile(raw: unknown): raw is CacheFile {
  if (!raw || typeof raw !== "object") return false
  const r = raw as Record<string, unknown>
  if (r.version !== CACHE_VERSION) return false
  if (typeof r.tenant !== "string" || !r.tenant) return false
  if (typeof r.apiUrl !== "string" || !r.apiUrl) return false
  if (!r.bindings || typeof r.bindings !== "object" || Array.isArray(r.bindings)) return false
  for (const [k, v] of Object.entries(r.bindings)) {
    if (typeof k !== "string") return false
    if (!v || typeof v !== "object") return false
    const b = v as Record<string, unknown>
    if (typeof b.datamateId !== "number" || !Number.isInteger(b.datamateId)) return false
    if (typeof b.datamateName !== "string") return false
    if (b.repoRemote !== null && typeof b.repoRemote !== "string") return false
    if (b.projectPath !== null && typeof b.projectPath !== "string") return false
    // At least one identity — otherwise the cached row can never be verified
    // against a project and would surface as a "phantom" workspace on the
    // offline-fallback render path. (cubic round 3.)
    const hasIdentity =
      (typeof b.repoRemote === "string" && b.repoRemote.length > 0) ||
      (typeof b.projectPath === "string" && b.projectPath.length > 0)
    if (!hasIdentity) return false
    if (typeof b.linkedAt !== "number") return false
    // A corrupt marker must not read as "already seeded" and suppress the sweep.
    if (b.seededAt !== undefined && typeof b.seededAt !== "number") return false
  }
  return true
}

function readCache(): CacheFile | null {
  const p = cachePath()
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown
    if (!isValidCacheFile(raw)) return null
    return raw
  } catch (err) {
    log.warn("workspace binding cache is corrupt, discarding", {
      code: (err as NodeJS.ErrnoException)?.code,
    })
    return null
  }
}

/** True when every key in the cache is already the canonical form of itself
 * (i.e. no earlier-CLI-build unresolved keys remain). Cheap side condition
 * so we can skip the per-read migration once the cache has been rewritten. */
function isCanonicalized(cache: CacheFile): boolean {
  for (const k of Object.keys(cache.bindings)) {
    if (canonicalizeKey(k) !== k) return false
  }
  return true
}

/** One-shot migration: rewrite the cache with canonical keys, collapsing any
 * pair that resolves to the same target (last-writer-wins by ``linkedAt``).
 * After this runs the O(n) lookup-time rescan in ``readLocalBinding`` is
 * dead code — every subsequent read hits the direct key lookup. */
function migrateToCanonicalKeys(cache: CacheFile): CacheFile {
  const migrated: Record<string, CachedBinding> = {}
  for (const [k, v] of Object.entries(cache.bindings)) {
    const canon = canonicalizeKey(k)
    const existing = migrated[canon]
    if (!existing || existing.linkedAt <= v.linkedAt) migrated[canon] = v
  }
  const next: CacheFile = { ...cache, bindings: migrated }
  // Best-effort — a failing write (read-only state dir, full disk, EACCES)
  // must not throw out of ``readLocalBinding``. The migrated shape is
  // still returned in-memory for THIS call, and the next successful
  // ``recordApprovedBinding`` will persist the canonical form. Without
  // this wrap, the offline-fallback path (``workspace.tsx`` runFlow →
  // readLocalBinding) surfaces a "Workspace setup failed" toast for a
  // perfectly-readable binding. (kilo-code-bot #1100 comment 3841208552.)
  try {
    writeCache(next)
  } catch (err) {
    log.warn("could not persist canonical-key migration; retry on next write", {
      err: String(err),
    })
  }
  return next
}

function writeCache(cache: CacheFile): void {
  const p = cachePath()
  Filesystem.writeJsonAtomic(p, cache)
  // Best-effort chmod — if the process dies before this line the file exists
  // with umask perms, and the next successful write repairs it. Acceptable
  // window given the cache holds workspace names, not credentials.
  try {
    chmodSync(p, 0o600)
  } catch (err) {
    log.warn("could not chmod workspace binding cache", {
      code: (err as NodeJS.ErrnoException)?.code,
    })
  }
}

/** Canonicalize a directory path so cache lookups survive symlink differences
 * (macOS ``/tmp`` → ``/private/tmp`` is the common case). Writers and readers
 * must both funnel through this or a shell-cwd write silently misses when the
 * TUI's canonicalized ``state.path.directory`` looks it back up. */
function canonicalizeKey(directory: string): string {
  try {
    return realpathSync(path.resolve(directory))
  } catch {
    return path.resolve(directory)
  }
}

async function tenantKey(): Promise<{ tenant: string; apiUrl: string } | null> {
  // Best-effort: ``AltimateApi.getCredentials`` can throw ``SyntaxError`` on
  // a corrupt credentials JSON, ``ZodError`` on schema drift, or a raw
  // ``Error`` on an unresolvable ``${env:...}`` reference — anything the
  // credential-loader library can produce. This helper is the last gate
  // between those errors and callers who treat their failures as fatal (the
  // TUI's fire-and-forget bind path terminates on unhandled rejections), so
  // swallow them and treat as "no credentials". (Kilo cycle 6.)
  try {
    if (!(await AltimateApi.isConfigured())) return null
    const c = await AltimateApi.getCredentials()
    return { tenant: c.altimateInstanceName, apiUrl: c.altimateUrl }
  } catch (err) {
    log.warn("could not resolve workspace credentials for cache scoping", {
      err: String(err),
    })
    return null
  }
}

/** Read the local binding for ``directory`` — only returns a hit when the
 * cache's stored (tenant, apiUrl) matches the current credentials. Runs a
 * one-shot migration to canonical keys on the first read that finds an
 * unresolved key (macOS ``/tmp`` → ``/private/tmp``), then relies on direct
 * lookup for the process's remaining lifetime. */
export async function readLocalBinding(directory: string): Promise<CachedBinding | null> {
  const key = await tenantKey()
  if (!key) return null
  let cache = readCache()
  if (!cache) return null
  if (cache.tenant !== key.tenant || cache.apiUrl !== key.apiUrl) return null
  const canon = canonicalizeKey(directory)
  const direct = cache.bindings[canon]
  if (direct) return direct
  // Cache miss: check if the cache still has any non-canonical keys and
  // migrate the whole file once. After migration the lookup is a plain
  // property access on every future read.
  if (!isCanonicalized(cache)) {
    // The migration writes, and this is a read path: a read-only or full state
    // directory would otherwise turn a plain cache lookup into a rejection for
    // every caller. Degrade to the pre-migration lookup instead.
    try {
      cache = migrateToCanonicalKeys(cache)
    } catch (err) {
      log.warn("could not migrate workspace binding cache; reading it as-is", {
        err: String(err),
      })
      for (const [k, v] of Object.entries(cache.bindings)) {
        if (canonicalizeKey(k) === canon) return v
      }
      return null
    }
    return cache.bindings[canon] ?? null
  }
  return null
}

/** Record that this binding's seed completed, so later warms skip the sweep. */
function markSeeded(directory: string, binding: CachedBinding): void {
  try {
    const cache = readCache()
    if (!cache) return
    const key = canonicalizeKey(directory)
    const current = cache.bindings[key]
    if (!current || !sameBinding(current, binding)) return
    cache.bindings[key] = { ...current, seededAt: Date.now() }
    writeCache(cache)
  } catch (err) {
    log.warn("could not record the workspace memory seed marker", { err: String(err) })
  }
}

/** Same workspace and same project identity — i.e. nothing to re-seed.
 * ``linkedAt`` is deliberately ignored: it moves on every warm. */
function sameBinding(a: CachedBinding, b: CachedBinding): boolean {
  return (
    a.datamateId === b.datamateId &&
    (a.repoRemote ?? null) === (b.repoRemote ?? null) &&
    (a.projectPath ?? null) === (b.projectPath ?? null)
  )
}

/** Projects the server has already said are unbound, so an unbound project
 * pays the lookup once per process instead of once per sync. Keyed on the
 * canonical directory. Never holds a positive result — a hit is written to the
 * real cache, which is what later reads consult. */
const serverLookupMissed = new Map<string, number>()

/** The composite key both the negative-lookup memo and the revalidation stamp
 * are filed under. Includes the account, so switching tenants never inherits
 * the other account's verdict for the same directory. */
function accountScopedKey(directory: string, key: { tenant: string; apiUrl: string }): string {
  return `${key.tenant}\u0000${key.apiUrl}\u0000${canonicalizeKey(directory)}`
}

/** Forget a memoized "no binding here" answer. An explicit link is newer
 * information than any miss recorded before it: without this, linking within
 * `MISS_TTL_MS` of a turn taken while unlinked has the revalidation below read
 * the stale miss, call it authoritative, and delete the row the link just
 * wrote. (bot review) */
function clearLookupMiss(directory: string, key: { tenant: string; apiUrl: string }): void {
  serverLookupMissed.delete(accountScopedKey(directory, key))
}

/** How long a "this project is unbound" answer is trusted. Bounded because the
 * answer changes the moment someone links the project in the SaaS: a permanent
 * memo means skills and memory never appear until the process restarts. Keyed
 * with the tenant and API host so switching accounts does not inherit the other
 * account's verdict. */
const MISS_TTL_MS = 5 * 60 * 1000

/** How long a cached POSITIVE binding is trusted before the server is asked
 * again. The cache is written by an explicit link and otherwise never expires,
 * so without this a project rebound or detached in the SaaS keeps serving its
 * OLD workspace's skills on this machine forever — including any carrying
 * `alwaysApply`. The server is authoritative; the cache covers the window
 * between checks and the case where the server cannot be reached. */
const REVALIDATE_MS = 5 * 60 * 1000

/** When each project's cached binding was last confirmed against the server. */
const lastValidatedAt = new Map<string, number>()

/** The binding for ``directory``: the local cache when it has one, otherwise
 * the server's answer, written to the cache for next time.
 *
 * The cache is only ever written by an explicit link. A project that is bound
 * server-side but has no local entry — a fresh clone of a repo a teammate
 * linked, a new machine, cleared state — therefore looks unbound to every
 * consumer, while ``link`` refuses to help because the server reports it as
 * already linked. That combination leaves the project permanently without
 * workspace skills and with no way out from the CLI.
 *
 * Adopting a binding here is a read, not an approval. The lookup is
 * access-controlled server-side (a workspace the caller cannot see answers 404
 * exactly as an unbound remote does), so this can only surface a binding the
 * caller could already see. It deliberately writes NO ``seededAt`` and does not
 * run the memory backfill: pulling a workspace's skills is read-only, whereas
 * pushing this machine's memory into a shared workspace is a write that stays
 * behind a real link.
 *
 * Never throws — a lookup failure is "unknown", which callers treat as "leave
 * whatever is on disk alone". */
export async function resolveBinding(directory: string): Promise<CachedBinding | null> {
  const outcome = await resolveBindingOutcome(directory)
  return outcome.status === "bound" ? outcome.binding : null
}

/** Whether a project is bound, and — crucially — whether we actually know.
 *
 * `null` collapses "the server confirmed this project is unbound" with "we
 * could not find out". Callers that DELETE on unbound must not act on the
 * second: a network blip would wipe a snapshot the user is still entitled to.
 * Callers that only need a binding can keep using `resolveBinding`. */
export type BindingOutcome =
  | { status: "bound"; binding: CachedBinding }
  | { status: "unbound" }
  | { status: "unknown" }

export async function resolveBindingOutcome(directory: string): Promise<BindingOutcome> {
  const local = await readLocalBinding(directory).catch(() => null)

  const key = await tenantKey()
  if (!key) return local ? { status: "bound", binding: local } : { status: "unknown" }

  // A cached binding is trusted only inside the revalidation window. Past it
  // the server decides, because it is the only thing that knows about a rebind
  // or a detach performed elsewhere.
  if (local) {
    const validated = lastValidatedAt.get(accountScopedKey(directory, key))
    if (validated !== undefined && Date.now() - validated < REVALIDATE_MS) {
      return { status: "bound", binding: local }
    }
    const fresh = await lookupBinding(directory, key)
    if (fresh.status === "unknown") {
      // Cannot reach the server: keep serving what we have rather than tearing
      // a working setup down over a network blip.
      return { status: "bound", binding: local }
    }
    lastValidatedAt.set(accountScopedKey(directory, key), Date.now())
    if (fresh.status === "unbound") {
      forgetBinding(directory, key)
      return { status: "unbound" }
    }
    // Rebound elsewhere: adopt the server's answer, replacing the cached row.
    if (fresh.binding.datamateId !== local.datamateId) return fresh
    return { status: "bound", binding: local }
  }
  return await lookupBinding(directory, key)
}

/** Drop a cached row the server no longer recognises, so later reads do not
 * resurrect it from disk. */
function forgetBinding(directory: string, key: { tenant: string; apiUrl: string }): void {
  try {
    const cache = readCache()
    if (!cache || cache.tenant !== key.tenant || cache.apiUrl !== key.apiUrl) return
    delete cache.bindings[canonicalizeKey(directory)]
    writeCache(cache)
  } catch (err) {
    log.warn("could not drop a binding the server no longer recognises", { err: String(err) })
  }
}

/** The server's answer for this project, with no cache consulted. */
async function lookupBinding(
  directory: string,
  key: { tenant: string; apiUrl: string },
): Promise<BindingOutcome> {
  const canon = accountScopedKey(directory, key)
  const missedAt = serverLookupMissed.get(canon)
  if (missedAt !== undefined && Date.now() - missedAt < MISS_TTL_MS) return { status: "unbound" }

  let hit: ProjectBindingLookup | null = null
  try {
    const { resolveProjectIdentifier } = await import("./detect")
    const { WorkspaceApi } = await import("./api-client")
    hit = await WorkspaceApi.getBindingForProject(resolveProjectIdentifier(directory))
  } catch (err) {
    // Unreachable or a 5xx: unknown, not unbound. Deliberately NOT memoized —
    // the next session should ask again rather than inherit a network blip.
    log.warn("could not look up the workspace binding for this project", { err: String(err) })
    return { status: "unknown" }
  }
  if (!hit) {
    serverLookupMissed.set(canon, Date.now())
    return { status: "unbound" }
  }
  // cubic P2: a malformed 2xx would otherwise throw on the dereference below,
  // outside the try above, aborting the whole sync. An unrecognised body is
  // unknown, not unbound — the same rule the rest of this feature follows.
  const row = (hit as { binding?: Partial<Binding> }).binding
  if (
    !row ||
    typeof row.datamate_id !== "number" ||
    typeof row.datamate_name !== "string" ||
    (row.repo_remote !== null && row.repo_remote !== undefined && typeof row.repo_remote !== "string") ||
    (row.project_path !== null && row.project_path !== undefined && typeof row.project_path !== "string")
  ) {
    log.warn("workspace binding lookup returned an unrecognised body; treating as unknown")
    return { status: "unknown" }
  }

  const adopted: CachedBinding = {
    adopted: true,
    datamateId: row.datamate_id,
    datamateName: row.datamate_name,
    repoRemote: row.repo_remote ?? null,
    projectPath: row.project_path ?? null,
    linkedAt: Date.now(),
  }
  try {
    const existing = readCache()
    const cache: CacheFile =
      existing && existing.tenant === key.tenant && existing.apiUrl === key.apiUrl
        ? existing
        : { version: CACHE_VERSION, tenant: key.tenant, apiUrl: key.apiUrl, bindings: {} }
    // Confirming the binding the cache already holds is not an adoption: keep
    // the explicit-link label and the seed marker, or a later re-link re-runs
    // the whole memory backfill and an explicit row silently becomes `adopted`.
    const prior = cache.bindings[canonicalizeKey(directory)]
    cache.bindings[canonicalizeKey(directory)] =
      prior && prior.datamateId === adopted.datamateId
        ? { ...adopted, adopted: prior.adopted, seededAt: prior.seededAt, linkedAt: prior.linkedAt }
        : adopted
    writeCache(cache)
  } catch (err) {
    // The binding still stands for this call; only the cache write failed, so
    // the next process looks it up again. Same reasoning as recordApprovedBinding.
    log.warn("could not cache the workspace binding discovered on the server", { err: String(err) })
  }
  lastValidatedAt.set(accountScopedKey(directory, key), Date.now())
  log.info("adopted the workspace binding this project already has on the server", {
    datamateId: adopted.datamateId,
  })
  return { status: "bound", binding: adopted }
}

export async function recordApprovedBinding(
  directory: string,
  binding: CachedBinding,
  opts?: { awaitBackfill?: boolean },
): Promise<void> {
  const key = await tenantKey()
  if (!key) return
  // An explicit link is the newest word on this project, so retire any memoized
  // "no binding here" from before it and count the row as server-validated —
  // the link is what created it. Without the first, revalidation reads the
  // stale miss and deletes the row this call just wrote; without the second,
  // every bind pays an immediate round trip to confirm what it just did.
  clearLookupMiss(directory, key)
  lastValidatedAt.set(accountScopedKey(directory, key), Date.now())
  // Best-effort: cache persistence is a UX convenience, not the source of
  // truth (the server-side binding is). If the state directory is read-only
  // or the disk is full, callers otherwise report "link failed" and prompt
  // duplicate retries against a workspace that IS bound server-side.
  // (cubic round 3.) canonicalizeKey resolves symlinks so writes and reads
  // funnel through the same key (macOS ``/tmp`` → ``/private/tmp``).
  // Whether this call actually changes the binding. A flow that merely warms
  // the cache with the binding already on disk must not trigger a sweep: the
  // seed exists for a NEW or CHANGED bind, and re-running it on every warm
  // costs a full read of local memory and a round trip per block -- now paid
  // synchronously on the `link` path, which awaits the seed.
  let bindingChanged = true
  let alreadySeeded = false
  try {
    const existing = readCache()
    const cache: CacheFile =
      existing && existing.tenant === key.tenant && existing.apiUrl === key.apiUrl
        ? existing
        : { version: CACHE_VERSION, tenant: key.tenant, apiUrl: key.apiUrl, bindings: {} }
    const prior = cache.bindings[canonicalizeKey(directory)]
    bindingChanged = !prior || !sameBinding(prior, binding)
    alreadySeeded = !bindingChanged && !!prior?.seededAt
    // Carry the seed marker across a warm so a completed seed is not repeated.
    cache.bindings[canonicalizeKey(directory)] =
      !bindingChanged && prior?.seededAt ? { ...binding, seededAt: prior.seededAt } : binding
    writeCache(cache)
  } catch (err) {
    // An unreadable cache means the prior binding is unknown, so fall back to
    // seeding: a missed seed is worse than a redundant one.
    bindingChanged = true
    log.warn("could not persist workspace binding cache", {
      code: (err as NodeJS.ErrnoException)?.code,
      err: String(err),
    })
  }

  // altimate_change start - seed the workspace with the memory this machine
  // already holds. Deliberately OUTSIDE the try above: a failed cache write
  // must not skip the backfill, and a failed backfill must not read as a failed
  // link. The dynamic import keeps the module graph acyclic — see the header of
  // ./memory-backfill.ts for why a static import cannot be used.
  //
  // ``awaitBackfill`` exists because the CLI calls ``process.exit()`` as soon
  // as a command handler returns (src/index.ts): a detached sweep is killed
  // mid-flight there, so a bind that reported success could seed nothing. The
  // TUI stays resident and leaves it detached so the dialog closes at once.
  // Pull the workspace's custom skills. Deliberately ABOVE the ``alreadySeeded``
  // return below: that marker tracks the one-shot memory seed, and skills are a
  // different lifecycle — they must re-sync on every bind, including a rebind to
  // a workspace this machine has already seeded memory for. Awaited on the same
  // condition as the backfill, for the same reason: the CLI exits as soon as the
  // handler returns, so a detached sync there would be killed mid-flight.
  const skillsSynced = import("./skill-sync")
    .then((m) => m.syncSkills(canonicalizeKey(directory)))
    .catch((err) => {
      log.warn("could not sync workspace skills", { err: String(err) })
      return { changed: false }
    })
  if (opts?.awaitBackfill) await skillsSynced

  // Skip only when this exact binding has already been seeded successfully. A
  // warm after a failed or skipped seed must try again, or the blocks this
  // machine already holds never reach the workspace.
  if (alreadySeeded) return
  const seeded = import("./memory-backfill")
    .then((m) => m.backfillOnBind(canonicalizeKey(directory), binding))
    .then((ok) => {
      if (ok) markSeeded(directory, binding)
      return ok
    })
    .catch((err) => {
      log.warn("could not start workspace memory backfill", { err: String(err) })
      return false
    })
  if (opts?.awaitBackfill) await seeded
  else void seeded
  // altimate_change end
}
