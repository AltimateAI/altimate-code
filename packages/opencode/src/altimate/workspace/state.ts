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
import { createHash } from "node:crypto"
import { chmodSync, existsSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import { AltimateApi } from "@/altimate/api/client"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { Log } from "@/altimate/util/log"
// Type-only: the value side is imported dynamically in resolveBinding to keep
// this module's import graph free of the API client at load time.
import type { Binding, ProjectBindingLookup } from "./api-client"
import type { SeedOutcome } from "./memory-backfill"
// altimate_change — the IDE extension's workspace pin; see ./pin.ts
import { readPinLogged, resolveWithinRoot, type ValidPin } from "./pin"
import { resolveProjectIdentifier } from "./detect"

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
  /** altimate_change — this binding came from the IDE extension's workspace pin
   * (see ./pin.ts), not from disk or the server. Ephemeral for the life of the
   * process: it is never written to the cache, and `readCache` strips it back
   * off anything that claims it on disk. Callers use it to tell an explicit,
   * user-made selection apart from a binding the server volunteered.
   *
   * No production consumer yet, by design: the write-authorization guard it exists for
   * (`memory-sync` currently has no `adopted` checks at all, so adopted bindings are writable
   * despite the contract documented above) is a pre-existing gap being fixed separately. This
   * carries the signal that guard will key on, so the two land independently. */
  pinned?: boolean
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
    // altimate_change — `pinned` is the IDE extension's in-process authorization marker and is
    // never written here. Anything on disk claiming it is corrupt or hand-edited, and honouring it
    // would let a file grant the write access a real selection is supposed to gate. Strip, don't
    // reject: the rest of the row is still usable.
    if ("pinned" in b) delete b.pinned
    // A corrupt marker must not read as "already seeded" and suppress the sweep.
    if (b.seededAt !== undefined && typeof b.seededAt !== "number") return false
  }
  return true
}

/** `strict`: a cache file that is present but cannot be read, parsed or
 * validated throws instead of reading as absent. The engine overlay needs the
 * difference — an unreadable link must not pass for an unlinked directory —
 * while every other caller degrades to "no cache" as before. */
function readCache(opts: { strict?: boolean } = {}): CacheFile | null {
  const p = cachePath()
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown
    if (!isValidCacheFile(raw)) {
      if (opts.strict) throw new Error("workspace binding cache has an unexpected shape")
      return null
    }
    return raw
  } catch (err) {
    if (opts.strict) throw err
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
export function canonicalDirectory(directory: string): string {
  return canonicalizeKey(directory)
}

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
  return (await readLocalBindingScoped(directory)).binding
}

/** `readLocalBinding` plus the credential scope (`tenant|apiUrl`) the hit was
 * validated against — one credential snapshot for both, so a binding can never
 * be paired with another tenant's scope. Workspace ids are tenant-local; the
 * scope is what tells the same id in two tenants apart. */
export async function readLocalBindingScoped(
  directory: string,
): Promise<{ binding: CachedBinding | null; scope: string | null }> {
  const key = await tenantKey()
  if (!key) return { binding: null, scope: null }
  const scope = `${key.tenant}|${key.apiUrl}`
  return { binding: await readCachedBinding(directory, key), scope }
}

/** `readLocalBindingScoped` for the engine overlay, which must not mistake an
 * unreadable link for an unlinked directory. Absent credentials or an absent
 * cache file still read as unbound; a credentials or cache file that is
 * present and cannot be read or parsed throws instead. */
export async function readLocalBindingScopedStrict(
  directory: string,
): Promise<{ binding: CachedBinding | null; scope: string | null }> {
  if (!(await AltimateApi.isConfigured())) return { binding: null, scope: null }
  const c = await AltimateApi.getCredentials()
  const key = { tenant: c.altimateInstanceName, apiUrl: c.altimateUrl }
  return { binding: await readCachedBinding(directory, key, { strict: true }), scope: `${key.tenant}|${key.apiUrl}` }
}

async function readCachedBinding(
  directory: string,
  key: { tenant: string; apiUrl: string },
  opts: { strict?: boolean } = {},
): Promise<CachedBinding | null> {
  let cache = readCache(opts)
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
  | {
      status: "bound"
      binding: CachedBinding
      /** Served from the local cache because the server could not be asked (or
       * there is no account to ask with): the link may since have been detached
       * or rebound elsewhere. Absent when the server confirmed it inside the
       * revalidation window. */
      stale?: true
    }
  | {
      status: "unbound"
      /** Answered from the miss memo (`MISS_TTL_MS`), not from the server just
       * now: a link made elsewhere inside that window is not yet reflected. */
      stale?: true
    }
  | { status: "unknown" }

/** How long a validated pin is trusted before its datamate is re-checked against the account.
 * Matches `REVALIDATE_MS` deliberately — this is the same question that rule answers, asked of a
 * different source of truth. */
export const PIN_VALIDATION_TTL_MS = REVALIDATE_MS

/** Memoized `listDatamates` verdicts, keyed by `tenant|apiUrl|datamateId`. `resolveBindingOutcome`
 * runs on every turn AND every memory write, so an unmemoized probe would put an HTTP round trip
 * on both hot paths. Only SUCCESSFUL verdicts are stored: caching a failure would turn one network
 * blip into five minutes of a dead workspace. */
const pinValidation = new Map<string, { name: string; at: number }>()
/** Bounded like the other per-process caches here. The key carries the credential digest and
 * the datamate id, both fixed for a `serve` process's lifetime, so growth is only ever re-auths —
 * but a cap costs nothing and keeps a later change to when the pin is read from reopening it. */
const PIN_VALIDATION_MAX = 64

/** How long a validated pin may keep being served once the account becomes UNREACHABLE. Bounded
 * on purpose: without it, one successful validation plus an indefinitely failing endpoint would
 * serve the pin forever. Beyond this the pin fails closed until the account answers again. */
export const PIN_STALE_IF_ERROR_MS = 30 * 60 * 1000

/** Reads the clock. Seam so tests can advance past the TTLs above instead of sleeping — without it
 * a second resolution is always a cache hit and the stale-on-error branches cannot be exercised. */
let pinNow: () => number = () => Date.now()

/** Exposed for tests; production never calls either. */
export function __resetPinValidation(clock?: () => number): void {
  pinValidation.clear()
  pinNow = clock ?? (() => Date.now())
}

/**
 * Whether a `listDatamates()` failure may be treated as "the account is unreachable" and so allow
 * a previously-validated pin to keep being served.
 *
 * Only transport-shaped failures qualify. An authorization failure is a real answer — the account
 * no longer has access — and collapsing it into the offline path lets a revoked or rotated
 * credential keep its previous authorization until the process restarts.
 *
 * Classified by ERROR TYPE, not by a `status` property. `api-client.ts` throws `ForbiddenError`,
 * `NotFoundError` and `NotConfiguredError` as plain named errors carrying NO status field, so a
 * status-based test silently sorted a real 403 into the transient bucket — the exact opposite of
 * the intent. Only `WorkspaceApiError` carries a status, and it is also what a genuine transport
 * failure ("Cannot reach …") is reported as, with the status left undefined.
 *
 * The default is NOT transient: for a check that decides whether to keep serving authorization,
 * an error we cannot classify must fail closed.
 */
async function isTransientApiFailure(err: unknown): Promise<boolean> {
  const { ForbiddenError, NotFoundError, NotConfiguredError, ConflictError, PreconditionFailedError, WorkspaceApiError } =
    await import("./api-client")
  // Definite answers about access or identity. Never transient.
  if (
    err instanceof ForbiddenError ||
    err instanceof NotFoundError ||
    err instanceof NotConfiguredError ||
    err instanceof ConflictError ||
    err instanceof PreconditionFailedError
  ) {
    return false
  }
  if (err instanceof WorkspaceApiError) {
    // No status = could not reach the host at all (DNS, refused, TLS, abort, timeout).
    if (err.status === undefined) return true
    // 408/429 are retry-shaped; 5xx is the server failing rather than the caller being refused.
    return err.status === 408 || err.status === 429 || err.status >= 500
  }
  return false
}

/** Per-directory `resolveProjectIdentifier` cache. That call runs `spawnSync("git", …)` with a
 * 3s timeout, and `resolveBindingOutcome` is reached per turn AND per memory write — so leaving it
 * on the hot path put a synchronous subprocess (and up to 3s of blocked event loop) on both. The
 * repo remote and project path do not change for the life of a `serve` process. */
const projectIdentifierCache = new Map<string, ReturnType<typeof resolveProjectIdentifier>>()

/** Bounded because the key derives from a caller-supplied directory. `resolveWithinRoot` proves
 * containment, not existence, and `serve` is unsecured by default — so a local caller can ask about an unlimited
 * number of distinct nonexistent subpaths under the pinned root and grow this map forever. In
 * normal use a `serve` process sees one directory, so the ceiling is never approached. */
const PROJECT_IDENTIFIER_CACHE_MAX = 256

function cachedProjectIdentifier(directory: string): ReturnType<typeof resolveProjectIdentifier> {
  const hit = projectIdentifierCache.get(directory)
  if (hit) {
    // Refresh recency: re-inserting moves the key to the end of the Map's insertion order, so the
    // eviction below drops the least recently USED entry rather than the oldest one, and a hot
    // directory cannot be evicted by a flood of one-shot lookups.
    projectIdentifierCache.delete(directory)
    projectIdentifierCache.set(directory, hit)
    return hit
  }
  const ident = resolveProjectIdentifier(directory)
  projectIdentifierCache.set(directory, ident)
  if (projectIdentifierCache.size > PROJECT_IDENTIFIER_CACHE_MAX) {
    const oldest = projectIdentifierCache.keys().next()
    if (!oldest.done) projectIdentifierCache.delete(oldest.value)
  }
  return ident
}

/** In-flight `listDatamates()` calls, keyed like `pinValidation`. Concurrent turns that both find
 * a cold or expired memo would otherwise each fire their own request before either writes back.
 * Correctness was never at stake; this just stops the duplicate round trips. */
const pinValidationInFlight = new Map<string, Promise<{ id: number; name: string }[]>>()

function listDatamatesOnce(
  cacheKey: string,
  actAs: { url: string; instance: string; apiKey: string },
): Promise<{ id: number; name: string }[]> {
  const existing = pinValidationInFlight.get(cacheKey)
  // Safe to share: `cacheKey` contains the credential digest, so two callers only ever join the
  // same request when they are acting as the same credential.
  if (existing) return existing
  const started = (async () => {
    const { WorkspaceApi } = await import("./api-client")
    return WorkspaceApi.listDatamates(actAs)
  })()
  pinValidationInFlight.set(cacheKey, started)
  // Only the caller that STARTED this request clears it, and only if the slot still holds its own
  // promise. A waiter clearing on settle could delete a newer request some third caller had just
  // registered, which would put the duplicate round trips straight back.
  void started
    .catch(() => undefined)
    .finally(() => {
      if (pinValidationInFlight.get(cacheKey) === started) pinValidationInFlight.delete(cacheKey)
    })
  return started
}

/**
 * Resolve the extension's pin into a binding, or refuse.
 *
 * Refusals are `unknown`, never `unbound`: `unbound` is a positive statement that this project has
 * no workspace, which callers act on destructively (`skill-sync` takes a snapshot out of service on
 * it). "We could not confirm the pin" does not justify that.
 */
async function resolvePinnedBinding(directory: string, pin: ValidPin): Promise<BindingOutcome> {
  // The pin is scoped to the tree `serve` was launched for. `serve` resolves an instance per
  // request from the `x-opencode-directory` header and runs unsecured by default, so without this
  // any local caller could have an unrelated directory's memory attributed to the pinned workspace.
  // Keep the path containment actually validated. Everything below awaits — credentials, a network
  // round trip — and re-deriving the directory from the caller's string afterwards would authorise
  // one path and then use whatever that string resolves to later.
  const canonicalDirectory = resolveWithinRoot(directory, pin.root)
  if (canonicalDirectory === null) {
    log.warn("ignoring workspace pin for a directory outside the pinned root", { directory })
    return { status: "unknown" }
  }

  // `tenantKey()` is deliberately not used here: it resolves the same credentials internally, so
  // calling both duplicated the work and gave two failure paths an identical log line, leaving the
  // message unable to say which had refused. (The validation path below reads credentials a second
  // time on purpose — see the TOCTOU note there. That read only happens on a cache miss.)
  //
  // Scoped to the CREDENTIAL, not just the tenant. `tenantKey()` yields only `{tenant, apiUrl}`, so
  // two accounts on one tenant shared a cache entry: switching credentials mid-process let the new
  // principal inherit the previous one's successful authorization for the whole TTL, before it had
  // demonstrated any visibility of its own. Only a short digest of the key is stored, never the key
  // — same treatment as the memory index.
  const creds = await AltimateApi.getCredentials().catch(() => null)
  if (!creds?.altimateApiKey || !creds.altimateInstanceName || !creds.altimateUrl) {
    log.warn("cannot honour the workspace pin: no Altimate credentials resolved")
    return { status: "unknown" }
  }
  const account = createHash("sha256").update(creds.altimateApiKey).digest("hex").slice(0, 16)
  const cacheKey = `${creds.altimateInstanceName}|${creds.altimateUrl}|${account}|${pin.datamateId}`

  const memo = pinValidation.get(cacheKey)
  // Seeded from the memo rather than the environment: past the TTL an offline fallback would
  // otherwise report the stale name the extension started with, discarding the server-confirmed
  // one. Inside the TTL this is already `memo.name`, so no second assignment is needed.
  let datamateName = memo?.name ?? pin.datamateName
  // Set when this call could not re-verify and is serving on the strength of an earlier
  // validation: the caller that speaks to the user can then say "last known" rather than "is",
  // exactly as the non-pinned path marks a cached binding it could not re-check.
  let stale = false
  if (!(memo && pinNow() - memo.at < PIN_VALIDATION_TTL_MS)) {
    let accessible: { id: number; name: string }[] | null = null
    let transient = false
    try {
      // The request acts as the credential this cache key was derived from, rather than resolving
      // the ambient one again. An earlier version compared the credential before and after the
      // call instead; that cannot distinguish "unchanged" from "changed and changed back", so an
      // A->B->A switch passed the comparison while the answer had been served as B. There is
      // nothing left to compare when the request and the key are the same credential by
      // construction.
      accessible = await listDatamatesOnce(cacheKey, {
        url: creds.altimateUrl,
        instance: creds.altimateInstanceName,
        apiKey: creds.altimateApiKey,
      })
    } catch (err) {
      // Unreachable and unauthorized are different answers and must not collapse: only the former
      // earns the stale grace below.
      accessible = null
      transient = await isTransientApiFailure(err)
      log.warn("could not verify the pinned workspace", { err: String(err), transient })
    }
    if (accessible) {
      const hit = accessible.find((d) => d.id === pin.datamateId)
      // The account genuinely cannot see this workspace. That is a real answer, so fail closed —
      // and do not let a previously-cached verdict keep it alive.
      if (!hit) {
        pinValidation.delete(cacheKey)
        log.warn("pinned workspace is not visible to this account", { datamateId: pin.datamateId })
        return { status: "unknown" }
      }
      // The server's name wins over the environment's, which can be stale if the workspace was
      // renamed after the extension spawned this process.
      datamateName = hit.name
      pinValidation.set(cacheKey, { name: hit.name, at: pinNow() })
      if (pinValidation.size > PIN_VALIDATION_MAX) {
        const oldest = pinValidation.keys().next()
        if (!oldest.done) pinValidation.delete(oldest.value)
      }
    } else if (!memo || !transient || pinNow() - memo.at >= PIN_STALE_IF_ERROR_MS) {
      // Nothing was ever established, OR the failure was a refusal rather than a network problem,
      // OR the grace window has run out. A revoked credential must stop working, and an endpoint
      // that fails forever must not grant an unbounded licence.
      pinValidation.delete(cacheKey)
      return { status: "unknown" }
    }
    // Validated earlier and now genuinely unreachable, inside the grace window: keep serving it,
    // which is what this module already does for a cached binding rather than tear a working setup
    // down over a network blip.
    else stale = true
  }

  const ident = cachedProjectIdentifier(canonicalDirectory)
  // Logged on success as well as on every refusal: a silently-working pin is indistinguishable
  // from a pin that was never read, which is exactly the ambiguity that makes this hard to support.
  log.info("resolved the workspace pinned by the IDE extension", {
    datamateId: pin.datamateId,
    datamateName,
  })
  return {
    status: "bound",
    binding: {
      datamateId: pin.datamateId,
      datamateName,
      repoRemote: ident.repoRemote ?? null,
      projectPath: ident.projectPath,
      linkedAt: Date.now(),
      pinned: true,
    },
    ...(stale ? { stale: true as const } : {}),
  }
}

/** The pin's verdict for callers that otherwise read the local cache directly, or `null` when
 * there is no pin to honour.
 *
 * altimate_change — `resolveBindingOutcome` consults the pin before anything else, so identity,
 * skills and memory all follow the IDE extension's selection. Warehouse tool routing does not go
 * through it: `precedence.currentBinding` and `engine-probes.resolveBinding` read the on-disk
 * binding, which the pin is deliberately never written to. That let one turn name the pinned
 * workspace in the identity section and route warehouse calls at the project's own link — two
 * different ids in one prompt, with nothing saying which governs execution (#1337).
 *
 * Exposed as the pin arm alone, rather than pointing those callers at `resolveBindingOutcome`,
 * because the rest of that function is not equivalent to the strict cache read they do today: with
 * no credentials configured it answers `unknown` where the strict read answers "no binding", and
 * the overlay treats those differently — one refuses and holds the datamate key, the other hands
 * it back. Layering only the pin keeps every unpinned session on exactly the path it has now.
 *
 * Returns `unknown` for a pin that cannot be honoured (malformed, outside its root, unresolvable
 * credentials, or naming a workspace this account cannot see). Routing must fail closed there
 * rather than fall through to the project's link: falling through is precisely the confusion this
 * fixes, and it would resurface whenever validation could not complete. */
export async function resolvePinnedBindingForRouting(
  directory: string,
): Promise<BindingOutcome | null> {
  const pin = readPinLogged()
  if (pin.kind === "absent") return null
  if (pin.kind === "invalid") return { status: "unknown" }
  return resolvePinnedBinding(directory, pin)
}

export async function resolveBindingOutcome(directory: string): Promise<BindingOutcome> {
  // altimate_change — the IDE extension's selection outranks whatever binding this project carries.
  // Checked before the local cache and before any server lookup: the whole point is that the panel,
  // not the project's history, decides which workspace this `serve` process works against.
  const pin = readPinLogged()
  if (pin.kind === "invalid") return { status: "unknown" }
  if (pin.kind === "valid") return resolvePinnedBinding(directory, pin)

  const local = await readLocalBinding(directory).catch(() => null)

  const key = await tenantKey()
  if (!key) return local ? { status: "bound", binding: local, stale: true } : { status: "unknown" }

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
      // a working setup down over a network blip — marked, so a caller that
      // speaks to the user can say "last known" instead of "is".
      return { status: "bound", binding: local, stale: true }
    }
    if (fresh.status === "unbound") {
      // Not stamped as validated. There is nothing to validate about "unbound",
      // and stamping it meant that if `forgetBinding`'s write persistently
      // failed, the NEXT resolve trusted the stale row for a full revalidation
      // window — undoing the unlink the server had just confirmed.
      forgetBinding(directory, key)
      return { status: "unbound" }
    }
    lastValidatedAt.set(accountScopedKey(directory, key), Date.now())
    // Rebound elsewhere: adopt the server's answer, replacing the cached row.
    if (fresh.binding.datamateId !== local.datamateId) return fresh
    // Same workspace: the local row's provenance (explicit link, seed marker)
    // with the server's current name and identifiers, which `lookupBinding`
    // just wrote to the cache — returning `local` as read handed the caller
    // the name from before a rename.
    return {
      status: "bound",
      binding: {
        ...local,
        datamateName: fresh.binding.datamateName,
        repoRemote: fresh.binding.repoRemote,
        projectPath: fresh.binding.projectPath,
      },
    }
  }
  return await lookupBinding(directory, key)
}

/** Listeners fired when THIS process changes a project's binding.
 *
 * Exists for the sidebar tile, which otherwise learns about a link or unlink
 * only on its next 30s poll: the user hits Unlink, gets a success toast, and
 * watches the pane next to it keep naming the workspace for up to half a
 * minute. The stale half is the one that looks authoritative.
 *
 * Deliberately a plain listener set rather than an event bus. Every binding
 * write already funnels through this module, so one hook here covers link,
 * unlink and rebind; a bus would mean plumbing a dependency through each
 * writer for a single subscriber. The poll stays as the backstop — it is what
 * catches a change made by ANOTHER process, which no in-process notifier can
 * see. */
/** `directory` is the canonical path whose binding changed, so a listener can scope its
 * reaction to that project rather than to every project the process serves. */
const bindingChangeListeners = new Set<(directory: string) => void>()

export function onBindingChanged(listener: (directory: string) => void): () => void {
  bindingChangeListeners.add(listener)
  return () => {
    bindingChangeListeners.delete(listener)
  }
}

/** Never throws: a listener is a UI refresh, and one bad subscriber must not
 * fail the link or unlink that notified it. Iterates a copy so a listener that
 * unsubscribes itself mid-notify cannot skip the next one. */
function notifyBindingChanged(directory: string): void {
  const canonical = canonicalizeKey(directory)
  // Snapshot first: a listener may subscribe or unsubscribe while being
  // notified, and iterating the live Set would then walk a collection that
  // changed underneath us.
  const listeners = Array.from(bindingChangeListeners)
  for (const listener of listeners) {
    try {
      listener(canonical)
    } catch (err) {
      log.warn("a binding-change listener threw", { err: String(err) })
    }
  }
}

/** Every key in the file that names this directory. Normally one — the
 * canonical path — but a file written before keys were canonicalised, or whose
 * migration could not be written back, can still hold a raw alias
 * (`readLocalBinding` reads through those). A delete that removed only the
 * canonical key left the alias to resurface the binding on the next read. */
function keysFor(cache: CacheFile, directory: string): string[] {
  const canon = canonicalizeKey(directory)
  return Object.keys(cache.bindings).filter((k) => k === canon || canonicalizeKey(k) === canon)
}

/** Drop a directory's row without checking which account the cache belongs to.
 *
 * Only for the no-credentials unlink path above. The scoped `forgetBinding` is
 * what every other caller should use — the scope check is what stops one
 * account's resolve from deleting another's row.
 *
 * The miss is still memoized, under the scope the FILE carries: with no
 * credentials there is nothing else to key it on, and without it the next
 * credentialed resolve asked the server straight away and could re-adopt a
 * binding whose delete was not yet visible. */
function forgetBindingUnscoped(directory: string): void {
  try {
    const cache = readCache()
    if (!cache) return
    const keys = keysFor(cache, directory)
    if (keys.length === 0) return
    for (const k of keys) delete cache.bindings[k]
    writeCache(cache)
    const scope = { tenant: cache.tenant, apiUrl: cache.apiUrl }
    lastValidatedAt.delete(accountScopedKey(directory, scope))
    serverLookupMissed.set(accountScopedKey(directory, scope), Date.now())
  } catch (err) {
    log.warn("could not drop a binding after an unlink with no credentials", { err: String(err) })
  }
}

/** The row on disk for a directory under WHATEVER account the file belongs
 * to, with that scope. For a caller that must later tell "the file was
 * already another account's" from "another account wrote it while I was
 * busy": the two look the same at cleanup time, and only a snapshot taken
 * before tells them apart. */
export interface UnscopedRow {
  tenant: string
  apiUrl: string
  datamateId: number
  linkedAt: number
}

export function peekRowUnscoped(directory: string): UnscopedRow | null {
  try {
    const cache = readCache()
    if (!cache) return null
    const row = primaryRow(cache, directory)
    if (!row) return null
    return { tenant: cache.tenant, apiUrl: cache.apiUrl, datamateId: row.datamateId, linkedAt: row.linkedAt }
  } catch {
    return null
  }
}

/** The row reads win for a directory: the canonical key, or failing that the
 * newest alias. */
function primaryRow(cache: CacheFile, directory: string): CachedBinding | undefined {
  return (
    cache.bindings[canonicalizeKey(directory)] ??
    keysFor(cache, directory)
      .map((k) => cache.bindings[k])
      .sort((a, b) => (b?.linkedAt ?? 0) - (a?.linkedAt ?? 0))[0]
  )
}

function sameUnscoped(a: UnscopedRow | null, b: UnscopedRow | null): boolean {
  if (!a || !b) return a === b
  return a.tenant === b.tenant && a.apiUrl === b.apiUrl && a.datamateId === b.datamateId && a.linkedAt === b.linkedAt
}

/** What an unlink started from, so the cleanup can tell a row it should remove
 * from one a relink wrote while the server call was in flight. `"none"` is the
 * no-cached-row case: any row present afterwards was created during the
 * request. A row is the same one when its workspace AND its link time match —
 * the id alone would treat a relink to the same workspace as unchanged. */
export type ExpectedRow = { datamateId: number; linkedAt: number } | "none"

function sameRow(row: CachedBinding | undefined, expect: ExpectedRow): boolean {
  if (!row) return false
  if (expect === "none") return false
  return row.datamateId === expect.datamateId && row.linkedAt === expect.linkedAt
}

/** Drop a cached row the server no longer recognises, so later reads do not
 * resurrect it from disk. With `expect`, only when the row on disk is still the
 * one the caller started from: an unlink whose server round trip overlapped a
 * relink must not remove the binding the relink just recorded. Returns false
 * in exactly that case — the row was kept on purpose — so the caller knows not
 * to memoize a miss over it either. A row already gone, or a write that failed,
 * is not that case. */
function forgetBinding(
  directory: string,
  key: { tenant: string; apiUrl: string },
  expect?: ExpectedRow,
  before?: UnscopedRow | null,
): boolean {
  let dropped = false
  try {
    const cache = readCache()
    if (!cache) return true
    if (cache.tenant !== key.tenant || cache.apiUrl !== key.apiUrl) {
      // Another account's file. For an unguarded drop that is simply not ours
      // to touch. For a guarded one it MAY be evidence: the file is
      // single-scope, so a scope that changed since the caller pinned it means
      // a relink under another account replaced it — and whatever that relink
      // recorded must be kept, snapshot included. But a file that was already
      // another account's before the request began, and is unchanged, is not
      // a relink; it is stale, and the cleanup proceeds past it (leaving the
      // row, which is not ours to touch) so the purge can judge the snapshot.
      const now = peekRowUnscoped(directory)
      if (expect !== undefined && now && !(before !== undefined && sameUnscoped(before, now))) {
        log.info("leaving a binding recorded under another account after the unlink began")
        return false
      }
      return true
    }
    const keys = keysFor(cache, directory)
    if (keys.length === 0) return true
    // Judged on the row that reads win: the canonical key, or failing that the
    // newest alias. A stale alias beside it is not a concurrent relink, and
    // must not keep the whole directory's rows from being cleaned up.
    const primary = primaryRow(cache, directory)
    if (expect !== undefined && !sameRow(primary, expect)) {
      log.info("leaving a binding recorded after the unlink began")
      return false
    }
    for (const k of keys) delete cache.bindings[k]
    writeCache(cache)
    dropped = true
  } catch (err) {
    log.warn("could not drop a binding the server no longer recognises", { err: String(err) })
  }
  // Outside the try on purpose. A listener is a UI refresh; its failure is not
  // a failed cache drop, and notifying from inside would log a throwing
  // subscriber as "could not drop a binding" — a misleading line about a write
  // that had already succeeded.
  //
  // Only when something on disk changed. Notifying on a failed write too was
  // tried, so the tile would not name an unlinked workspace until the next
  // poll — and it made a hot loop: the sidebar answers a notification with a
  // resolve, the resolve hears the memoized miss and re-enters here, the
  // write fails again, and it notifies again, forty times in as many
  // milliseconds for as long as the state directory stays unwritable. A
  // read-only state directory now costs one poll interval of staleness
  // instead, which is the right trade. (Ralph, review of #1279.)
  if (dropped) notifyBindingChanged(directory)
  return true
}

/** The server's answer for this project, with no cache consulted. */
async function lookupBinding(
  directory: string,
  key: { tenant: string; apiUrl: string },
): Promise<BindingOutcome> {
  const canon = accountScopedKey(directory, key)
  const missedAt = serverLookupMissed.get(canon)
  if (missedAt !== undefined && Date.now() - missedAt < MISS_TTL_MS) return { status: "unbound", stale: true }

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
  let adoptedNow = false
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
    // Anything the tile renders or the delete identifies by: a rename, or a
    // remote/path the server now holds differently, is a change worth waking
    // the sidebar for, even under the same id.
    adoptedNow =
      !prior ||
      prior.datamateId !== adopted.datamateId ||
      prior.datamateName !== adopted.datamateName ||
      prior.repoRemote !== adopted.repoRemote ||
      prior.projectPath !== adopted.projectPath
  } catch (err) {
    // The binding still stands for this call; only the cache write failed, so
    // the next process looks it up again. Same reasoning as recordApprovedBinding.
    log.warn("could not cache the workspace binding discovered on the server", { err: String(err) })
  }
  lastValidatedAt.set(accountScopedKey(directory, key), Date.now())
  log.info("adopted the workspace binding this project already has on the server", {
    datamateId: adopted.datamateId,
  })
  // An adoption is a binding change this process made to its cache, and the
  // sidebar is not always the caller — a `/workspace` open that adopts left
  // the tile to the next poll. Stamped as validated above, so the sidebar's
  // answering resolve trusts the row and does not come back here.
  if (adoptedNow) notifyBindingChanged(directory)
  return { status: "bound", binding: adopted }
}

/** Drop this project's cached binding after a server-side unlink.
 *
 * Also memoizes the miss. Without that, the next resolve pays a round trip to
 * re-learn what this call just did — and if the server delete had NOT actually
 * happened, the lookup would re-adopt the binding and silently undo the unlink.
 * Marking the miss makes the local state agree with the request that was made,
 * and the ordinary ``MISS_TTL_MS`` revalidation still corrects it if the server
 * disagrees.
 *
 * Best-effort, like every other write to this cache: the server-side binding is
 * the source of truth, and a read-only state directory must not turn a
 * successful unlink into a reported failure. */
export async function clearLocalBinding(
  directory: string,
  opts: {
    /** The account scope the server delete was made under. Resolved again here
     * it could differ — credentials switched mid-unlink — and the cleanup would
     * then target another account's cache and leave the removed binding on
     * disk under the first. */
    scope?: { tenant: string; apiUrl: string } | null
    /** The row unlink started from. When it is no longer the row on disk, a
     * relink won the race and the cleanup (and the miss memo) must not undo it. */
    expect?: ExpectedRow
    /** The row on disk under ANY account when unlink started
     * (`peekRowUnscoped`), so a file that already belonged to another account
     * is not mistaken for a relink under one. */
    before?: UnscopedRow | null
  } = {},
): Promise<"removed" | "kept"> {
  const key = opts.scope === undefined ? await tenantKey() : opts.scope
  if (!key) {
    // Credentials would not resolve, so there is no scope to key the memos on.
    // Returning here used to leave the row on disk: reads also fail closed
    // without a key, so nothing was stale WHILE the credentials were missing —
    // but the row resurfaced the moment they came back, naming a workspace this
    // project had been unlinked from. It self-heals on the next revalidation,
    // which is why this is a narrowing rather than a rewrite: drop the row for
    // this directory whatever tenant the file belongs to. The user asked to
    // unlink THIS project, and the worst case is a re-lookup.
    forgetBindingUnscoped(directory)
    return "removed"
  }
  if (!forgetBinding(directory, key, opts.expect, opts.before)) return "kept"
  lastValidatedAt.delete(accountScopedKey(directory, key))
  serverLookupMissed.set(accountScopedKey(directory, key), Date.now())
  return "removed"
}

/** Test seam: forget that a directory's row was recently validated, so the
 * next resolve asks the server — the only way a test can observe whether a
 * lookup miss was memoized over that row. */
export function expireValidationForTests(directory: string): void {
  const suffix = `\u0000${canonicalizeKey(directory)}`
  for (const k of Array.from(lastValidatedAt.keys())) if (k.endsWith(suffix)) lastValidatedAt.delete(k)
}

/** The account scope a server call made now would run under, or null when
 * credentials do not resolve. For callers that must pin one scope across a
 * server round trip and the local cleanup that follows it. */
export async function currentScope(): Promise<{ tenant: string; apiUrl: string } | null> {
  return tenantKey()
}

/** A digest of the full credential (URL, tenant and API key), or null when none resolves.
 * The binding cache is scoped by tenant and URL only, so a same-tenant key switch needs this. */
export async function accountDigest(): Promise<string | null> {
  const c = await AltimateApi.getCredentials().catch(() => null)
  if (!c?.altimateApiKey || !c.altimateInstanceName || !c.altimateUrl) return null
  return createHash("sha256").update(`${c.altimateUrl}|${c.altimateInstanceName}|${c.altimateApiKey}`).digest("hex")
}

export async function recordApprovedBinding(
  directory: string,
  binding: CachedBinding,
  // `seed: false` warms the cache for a link the user has not accepted yet: a discovered
  // link must not upload local memory before they choose Attach. `account` (from
  // `accountDigest`) pins the write and the seed to the credential that confirmed the link.
  opts?: { awaitBackfill?: boolean; seed?: boolean; account?: string },
): Promise<SeedOutcome | null> {
  const key = await tenantKey()
  if (!key) return null
  if (opts?.account !== undefined && (await accountDigest()) !== opts.account) {
    log.warn("the Altimate account changed before the link was recorded; not recording it")
    return null
  }
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
  /** The name as it was on disk, so a rename can be detected even when the
   * binding's identity is unchanged. `undefined` when there was no prior row. */
  let priorName: string | undefined
  try {
    const existing = readCache()
    const cache: CacheFile =
      existing && existing.tenant === key.tenant && existing.apiUrl === key.apiUrl
        ? existing
        : { version: CACHE_VERSION, tenant: key.tenant, apiUrl: key.apiUrl, bindings: {} }
    const prior = cache.bindings[canonicalizeKey(directory)]
    priorName = prior?.datamateName
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

  // Only when something a subscriber could render actually changed. A warm
  // cache re-read must not wake the tile on every resolve.
  //
  // `bindingChanged` alone is not the right test: `sameBinding` compares
  // identity (id, remote, path) because it also gates the memory seed, and
  // widening it would re-seed a whole workspace every time someone renamed one.
  // But the sidebar renders `datamateName`, so a rename is a visible change
  // with an unchanged identity. Checked separately for that reason. (cubic P2
  // on #1279.)
  if (bindingChanged || priorName !== binding.datamateName) notifyBindingChanged(directory)

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
  if (alreadySeeded) return { status: "already", sent: 0, pending: 0 }
  if (opts?.seed === false) return null
  if (opts?.account !== undefined && (await accountDigest()) !== opts.account) {
    log.warn("the Altimate account changed before the memory seed; not seeding")
    return null
  }
  const seeded = import("./memory-backfill")
    .then((m) => m.seedOnBind(canonicalizeKey(directory), binding))
    .then((outcome) => {
      if (outcome.status === "seeded") markSeeded(directory, binding)
      return outcome
    })
    .catch((err): SeedOutcome => {
      log.warn("could not start workspace memory backfill", { err: String(err) })
      return { status: "incomplete", sent: 0, pending: 0 }
    })
  if (opts?.awaitBackfill) return seeded
  void seeded
  return null
  // altimate_change end
}
