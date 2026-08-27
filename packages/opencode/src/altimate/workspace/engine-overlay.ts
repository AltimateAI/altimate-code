// altimate_change - new file
//
// The workspace engine overlay.
//
// A project bound to a workspace gets that workspace's integration tools from
// the local engine (`datamate start-stdio --datamate <id>`), served under the
// `datamate` MCP key. This module derives that entry at config-load time and
// never writes it anywhere:
//
//   config load  →  overlay(): bound + engine on PATH clearing the floor
//                   → `mcp.datamate` is the pinned local spawn, whatever any
//                     file, IDE or discovery pass put there; otherwise the key
//                     is removed so nothing else answers for the workspace.
//   MCP bootstrap  starts it like any configured stdio server and awaits it
//                  before the first tool list — first-turn readiness for free.
//   turn boundary  →  beforeTurn(): re-read the binding; on a re-link reload
//                     config and replace the engine; on a failed handshake
//                     retry once per process; settle this session's outcome;
//                     tell the user once per verdict.
//
// What this deliberately is not: a reconciler over other writers of the key.
// In workspace mode the key is owned here — the in-process writers refuse it
// (see `managedWorkspace`), and anything another process changes is observed
// at the next turn boundary. The tools a turn holds are the ones resolved at
// that turn's start.
import { DATAMATE_KEY } from "@/altimate/datamate-transport"
import { MCP } from "@/mcp"
import { Config } from "@/config/config"
import {
  currentDirectory,
  isEnabled,
  isHeadless,
  isServe,
  log,
  syncInternals,
  type ScopedBinding,
} from "./engine-seams"
import { declaredBounded, notify, printLine, resolveBinding, versionOf, which } from "./engine-probes"
import { installCommand, offerOrNotify, type EngineOffer } from "./engine-offer"
import {
  ENGINE_BINARY,
  INSTALL_HELPS,
  REPAIRABLE,
  TOOL_PREFIX,
  clearsFloor,
  describeMissing,
  describeRefusal,
  engineEntry,
  engineToolKeys,
  isMcpEntry,
  type Declared,
  type LocalMcpConfig,
  type McpEntry,
  type McpStatus,
  type Outcome,
  type Toast,
} from "./engine-types"

export * from "./engine-types"
export * from "./engine-offer"
export { isEnabled, isHeadless, isServe, syncInternals } from "./engine-seams"

/** Sessions remembered per process. It is a memo; an evicted session just re-settles. */
export const MAX_TRACKED_SESSIONS = 256
/** A failed probe is repeated at most this often, so a missing engine does not
 * cost a process spawn on every turn while still being noticed once installed. */
export const FAILED_PROBE_TTL_MS = 30_000
/** A failed allowlist lookup is retried at most this often. */
const DECLARED_RETRY_MS = 60_000

// ── the engine on PATH ──────────────────────────────────────────────────────

type Probe = { kind: "ok"; version: string } | { kind: "missing" } | { kind: "too-old"; found: string | null }

let probeMemo: { result: Probe; at: number } | null = null

function now(): number {
  return syncInternals.now ? syncInternals.now() : Date.now()
}

async function probeEngine(): Promise<Probe> {
  const at = now()
  const bin = which(ENGINE_BINARY)
  // A usable engine is remembered for the process. A missing one is asked
  // about on every call — `which` is a PATH scan, no process spawn — so an
  // install made from the offer dialog (which runs in another module realm and
  // cannot reach this memo) is seen on the next turn. A too-old or broken one
  // costs a spawn to re-check, so that is rate-limited by the TTL.
  if (probeMemo && probeMemo.result.kind === "ok") return probeMemo.result
  if (probeMemo && probeMemo.result.kind === "too-old" && bin && at - probeMemo.at < FAILED_PROBE_TTL_MS) {
    return probeMemo.result
  }
  let result: Probe
  if (!bin) {
    result = { kind: "missing" }
  } else {
    const version = await versionOf(bin)
    result = clearsFloor(version) ? { kind: "ok", version: version! } : { kind: "too-old", found: version }
  }
  probeMemo = { result, at }
  return result
}

/** Forget the last probe, so the next turn boundary looks for the engine
 * again immediately. The install offer calls this after an install. */
export function invalidateProbe(): void {
  probeMemo = null
}

// ── the overlay ─────────────────────────────────────────────────────────────

type Overlay = {
  directory: string
  /** `key` is the workspace's identity across accounts — ids are tenant-local,
   * so the same number in another tenant is another workspace, and a session
   * that switched accounts must not keep the old one's engine or inventory. */
  workspace: { id: string; name: string; key: string }
  /** The derived entry, or null when the engine is unusable. */
  entry: LocalMcpConfig | null
  refusal: Extract<Outcome, { kind: "engine-missing" | "engine-too-old" }> | null
}

/** Per-directory state. Config and MCP state are per project instance, and one
 * server process can host several directories, so the overlay is keyed the same
 * way — a module-wide value would let project B's overlay start B's engine
 * inside A's MCP state. */
type DirectoryState = {
  /** The overlay as of the last config load for this directory. */
  current: Overlay | null
  /** Turn hooks for one directory run one at a time. Sessions in a directory
   * share the key (a sub-agent's session is enough to make two concurrent),
   * and a hook's binding read, reload and engine replacement must not
   * interleave with another's — otherwise one session's boundary could
   * replace the engine between another's read and its apply. */
  chain: Promise<void>
  /** What MCP is believed to be running under the key: the overlay as it stood
   * when MCP bootstrapped (config load precedes MCP init, which reads the cached
   * config), then whatever the turn hook last applied. `undefined` until the
   * first turn boundary. Kept apart from `current` because any consumer can
   * invalidate and reload config between turns, re-running the overlay without
   * touching MCP. */
  applied: Overlay | null | undefined
  /** When the last overlay attempt threw. A failed attempt is retried at the
   * probe TTL, not on every turn — each retry invalidates the whole config. */
  failedAt?: number
  /** The last overlay attempt could not read the binding: a file that is
   * present but unreadable, not a derivation failure, so not throttled — the
   * next readable boundary reloads at once. Holds the read's error. */
  linkUnreadable?: string
  /** The turn hook dropped a foreign entry under the key over an unreadable
   * link. Should the directory then read as unbound, the entry is handed back. */
  droppedForeign?: boolean
  /** The key is set by organisation-managed config: nothing here claims it. */
  managed?: boolean
}
const directories = new Map<string, DirectoryState>()

function stateFor(directory: string): DirectoryState {
  let state = directories.get(directory)
  if (!state) {
    state = { current: null, applied: undefined, chain: Promise.resolve() }
    directories.set(directory, state)
  }
  return state
}

/** Identity of the workspace a binding names: the credential scope it was
 * read under plus the tenant-local id. */
function workspaceKey(binding: ScopedBinding): string {
  return `${binding.scope ?? ""}|${binding.datamateId}`
}

function sameEntry(a: LocalMcpConfig | null, b: LocalMcpConfig | null): boolean {
  return !!a && !!b && a.command.join("\0") === b.command.join("\0")
}

/** Derive the `datamate` entry for a bound directory into `config.mcp`.
 *
 * Called from the config loader after external MCP discovery, so it has the
 * last word over every other source of the key. Mutates `config.mcp` only when
 * the directory is bound with the pilot on. Never throws. */
export async function overlay(
  directory: string,
  config: { mcp?: Record<string, unknown> },
  opts: { managed?: boolean } = {},
): Promise<void> {
  const state = stateFor(directory)
  state.failedAt = undefined
  state.linkUnreadable = undefined
  state.managed = opts.managed === true
  try {
    if (!isEnabled() || isServe()) {
      state.current = null
      return
    }
    if (opts.managed) {
      // Organisation-managed config (MDM) is authoritative over everything,
      // this overlay included: the key stays as managed, and nothing here
      // claims it, so its writers are not refused either.
      log.info("workspace engine overlay skipped: the datamate key is set by managed preferences", { directory })
      state.current = null
      return
    }
    const read = await resolveBinding(directory)
    if (read.kind === "failed") {
      // Whether the directory is bound is unknown: nothing claimed, and the
      // turn boundary decides what may run under the key meanwhile. Not a
      // derivation failure, so the boundary reloads as soon as it can read.
      log.warn("workspace engine overlay failed: the binding could not be read", { directory, err: read.error })
      state.current = null
      state.linkUnreadable = read.error
      return
    }
    if (read.kind === "unbound") {
      // Logged because "flag on, nothing happened" is the question every
      // first-run report asks; the directory is the usual answer.
      log.info("workspace engine overlay skipped: directory is not bound", { directory })
      state.current = null
      return
    }
    const binding = read.binding
    const workspace = {
      id: String(binding.datamateId),
      name: binding.datamateName,
      key: workspaceKey(binding),
    }
    const probe = await probeEngine()
    if (probe.kind === "ok") {
      const entry = engineEntry(workspace.id)
      config.mcp ??= {}
      config.mcp[DATAMATE_KEY] = entry
      state.current = { directory, workspace, entry, refusal: null }
      log.info("workspace engine overlay applied", { workspaceId: workspace.id, version: probe.version })
      return
    }
    // No hosted fallback in workspace mode: the hosted endpoint serves a
    // different tool set, and an IDE's unpinned engine serves whichever
    // teammate is active there. Either would answer for the workspace with
    // tools it did not declare.
    if (config.mcp && DATAMATE_KEY in config.mcp) delete config.mcp[DATAMATE_KEY]
    state.current = {
      directory,
      workspace,
      entry: null,
      refusal: probe.kind === "missing" ? { kind: "engine-missing" } : { kind: "engine-too-old", found: probe.found },
    }
    log.info("workspace engine overlay refused", { workspaceId: workspace.id, reason: probe.kind })
  } catch (err) {
    log.warn("workspace engine overlay failed; leaving the MCP config as loaded", { err: String(err) })
    state.current = null
    state.failedAt = now()
  }
}

/** The workspace that owns the `datamate` key for the current instance's
 * directory, or null.
 *
 * Synchronous, for the in-process writers of that key (the reload endpoint,
 * the HTTP add route, `datamate_manager add`): in workspace mode they refuse
 * the key and say why, instead of replacing the engine underneath a turn. */
export function managedWorkspace(directory: string | null = currentDirectory()): { id: string; name: string } | null {
  if (!directory) return null
  const state = directories.get(directory)
  // The key stays owned for as long as an applied engine is running — through
  // a transient overlay failure being retried, and through the unlink teardown
  // between the reload that clears `current` and the release that clears
  // `applied`. A writer answered "free" in either window could replace the
  // very engine the sessions are still using.
  const workspace = state?.current?.workspace ?? state?.applied?.workspace
  return workspace ? { id: workspace.id, name: workspace.name } : null
}

/** `managedWorkspace` once the overlay has run for this instance. The overlay
 * runs inside config load, and on a fresh instance a writer's request can be
 * the first thing that happens — asked before the load, the key looks free. */
export async function managedWorkspaceLoaded(
  directory: string | null = currentDirectory(),
): Promise<{ id: string; name: string } | null> {
  if (!directory) return null
  await config().get()
  return managedWorkspace(directory)
}

// ── per-session outcome ─────────────────────────────────────────────────────

/** `retried`: this session already spent its one re-add on a failed handshake.
 * Per session, so "start a new session to try again" is true. */
type SessionRecord = { outcome: Outcome; announced?: string; retried?: boolean }
const sessions = new Map<string, SessionRecord>()
const declaredCache = new Map<string, { value: Declared | null; at: number }>()

function record(sessionID: string, outcome: Outcome): SessionRecord {
  const previous = sessions.get(sessionID)
  sessions.delete(sessionID)
  const next: SessionRecord = { outcome, announced: previous?.announced, retried: previous?.retried }
  sessions.set(sessionID, next)
  while (sessions.size > MAX_TRACKED_SESSIONS) {
    const oldest = sessions.keys().next().value
    if (oldest === undefined) break
    sessions.delete(oldest)
  }
  return next
}

/** The outcome a session settled at its last turn boundary. A pure read;
 * `undefined` before the first `beforeTurn` for that session. */
export function settledOutcome(sessionID: string): Outcome | undefined {
  return sessions.get(sessionID)?.outcome
}

function mcp() {
  return (
    syncInternals.mcp ?? {
      status: () => MCP.status() as Promise<McpStatus>,
      add: (name: string, cfg: LocalMcpConfig | McpEntry) => MCP.add(name, cfg as Parameters<typeof MCP.add>[1]),
      remove: (name: string) => MCP.remove(name),
      tools: () => MCP.tools() as Promise<Record<string, unknown>>,
    }
  )
}

function config() {
  return (
    syncInternals.config ?? {
      invalidate: () => Config.invalidate(),
      get: async () => (await Config.get()) as { mcp?: Record<string, unknown> },
    }
  )
}

/** An unreadable link is not an unlink. Fail closed: an engine of ours keeps
 * running and the key stays owned; with nothing of ours running, whatever MCP
 * started from the loaded config is dropped rather than left to answer for a
 * workspace this directory may well be bound to — and remembered, so that a
 * directory which then reads as unbound gets its entry back. The binding is
 * read again at the next boundary. */
async function refuseUnreadableLink(sessionID: string, state: DirectoryState, error: string): Promise<void> {
  if (!state.applied?.entry && DATAMATE_KEY in (await mcp().status())) {
    await mcp().remove(DATAMATE_KEY)
    state.droppedForeign = true
  }
  const outcome: Outcome = { kind: "connect-failed", error: "the workspace link could not be read" }
  record(sessionID, outcome)
  const kept = state.applied?.entry ? "the running engine is kept and " : ""
  await announceRefusal(sessionID, outcome, {
    title: state.applied ? `Workspace "${state.applied.workspace.name}": link could not be read` : "Workspace link could not be read",
    message: `${outcome.error} (${error}); ${kept}it is read again next turn.`,
    variant: "warning",
  })
}

/** Hand the key back to whatever the reloaded config says now that the overlay
 * no longer fills it: the user's own hosted or IDE-written entry, if any. MCP
 * enumerates live clients only, so a restored config entry must be started or
 * the project's standalone datamate tools stay gone for the rest of the process. */
async function releaseKey(loaded: { mcp?: Record<string, unknown> } | undefined, hadEngine: boolean): Promise<void> {
  if (hadEngine) await mcp().remove(DATAMATE_KEY)
  const restored = loaded?.mcp?.[DATAMATE_KEY]
  if (isMcpEntry(restored) && restored.enabled !== false) {
    log.info("workspace engine released the datamate key; starting the configured entry", { type: restored.type })
    await mcp().add(DATAMATE_KEY, restored)
  }
}

async function declaredFor(workspace: { id: string; key: string }): Promise<Declared | null> {
  // Cached per workspace identity, not per id: the same id in another tenant
  // is another allowlist.
  const cached = declaredCache.get(workspace.key)
  if (cached && (cached.value || now() - cached.at < DECLARED_RETRY_MS)) return cached.value
  const value = await declaredBounded(workspace.id)
  declaredCache.set(workspace.key, { value, at: now() })
  return value
}

/** Reconcile, settle and announce for one session. Runs at the start of every
 * user turn, before the tool list is resolved. Never throws. */
export async function beforeTurn(sessionID: string): Promise<void> {
  await atTurnStart(sessionID, async () => undefined)
}

/** Run the turn boundary and then `body` — the turn's tool cataloguing — under
 * the directory's lock, so no other session's boundary can replace the engine
 * between this session's reconcile and its catalog snapshot. The hook's own
 * failures are logged and swallowed; `body`'s propagate. */
export async function atTurnStart<T>(sessionID: string, body: () => Promise<T>): Promise<T> {
  if (!isEnabled() || isServe()) {
    record(sessionID, { kind: "disabled" })
    return body()
  }
  const directory = currentDirectory()
  if (!directory) {
    record(sessionID, { kind: "unbound" })
    return body()
  }
  const state = stateFor(directory)
  const run = state.chain.then(async () => {
    try {
      await reconcile(sessionID, directory, state)
    } catch (err) {
      log.warn("workspace engine turn hook failed", { sessionID, err: String(err) })
    }
    return body()
  })
  state.chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** The engine tools a turn catalogued first, kept for its later catalogs.
 * `resolveTools` re-snapshots MCP on every step, so a re-link applied by
 * another session's boundary mid-turn would otherwise be re-catalogued here;
 * pinning keeps this turn on the engine its boundary read. A call through a
 * pinned wrapper after a replacement reaches the closed client and fails — it
 * never routes to the other workspace. */
const turnTools = new Map<string, Record<string, unknown>>()

export function pinTurnTools<T>(sessionID: string, firstCatalog: boolean, tools: Record<string, T>): void {
  if (!isEnabled() || isServe()) return
  const engine = Object.fromEntries(Object.entries(tools).filter(([key]) => key.startsWith(TOOL_PREFIX)))
  if (firstCatalog) {
    turnTools.delete(sessionID)
    turnTools.set(sessionID, engine)
    while (turnTools.size > MAX_TRACKED_SESSIONS) {
      const oldest = turnTools.keys().next().value
      if (oldest === undefined) break
      turnTools.delete(oldest)
    }
    return
  }
  const pinned = turnTools.get(sessionID)
  if (!pinned) return
  for (const key of Object.keys(engine)) delete tools[key]
  for (const [key, tool] of Object.entries(pinned)) tools[key] = tool as T
}

async function reconcile(sessionID: string, directory: string, state: DirectoryState): Promise<void> {
  // The overlay runs inside config load; make sure it has run at least once.
  await config().get()
  // First turn boundary: MCP bootstrapped from the config as loaded, i.e. from
  // the overlay as it stands now.
  if (state.applied === undefined) state.applied = state.current

  // Organisation-managed config owns the key: the feature is off for this
  // directory, whatever the binding says. Nothing to reload per turn.
  if (state.managed) {
    if (state.applied?.entry) await releaseKey(await config().get(), true)
    state.applied = null
    record(sessionID, { kind: "disabled" })
    return
  }

  const read = await resolveBinding(directory)
  if (read.kind === "failed") return refuseUnreadableLink(sessionID, state, read.error)
  const binding = read.kind === "bound" ? read.binding : null
  if (!binding) {
    // Unlinked (or never linked): the key is not ours to fill.
    let loaded: { mcp?: Record<string, unknown> } | undefined
    if (state.current || state.applied || state.droppedForeign) {
      await config().invalidate()
      loaded = await config().get()
    }
    // Whether the overlay had an engine running or had refused one (and so had
    // removed the key from the config it shadowed), the key is handed back —
    // as is a foreign entry dropped while the link could not be read.
    if (state.applied) await releaseKey(loaded, !!state.applied.entry)
    else if (state.droppedForeign) await releaseKey(loaded, false)
    state.droppedForeign = false
    state.applied = null
    record(sessionID, { kind: "unbound" })
    return
  }
  const boundKey = workspaceKey(binding)

  // Reload the overlay when the binding moved — to another workspace, or the
  // same id under another account — when the last load could not read the
  // binding at all, or when a refused engine may have appeared since (the
  // probe memo bounds how often that is asked).
  let reload = state.current
    ? state.current.workspace.key !== boundKey
    : state.linkUnreadable !== undefined || state.failedAt === undefined || now() - state.failedAt >= FAILED_PROBE_TTL_MS
  if (!reload && state.current && !state.current.entry) {
    const probe = await probeEngine()
    reload = probe.kind === "ok"
  }
  let loaded: { mcp?: Record<string, unknown> } | undefined
  if (reload) {
    await config().invalidate()
    loaded = await config().get()
  }
  // The boundary read the binding but the reload could not: the link is
  // flapping, and the reload's verdict is the one the config now reflects.
  if (!state.current && state.linkUnreadable !== undefined) return refuseUnreadableLink(sessionID, state, state.linkUnreadable)

  // A transient overlay failure (its retry is throttled above) keeps what was
  // last applied for this same workspace: a running engine is not released
  // over a fault in the probe. After a relink nothing is kept — workspace A's
  // engine must not serve a directory now bound to B.
  const retained = state.failedAt !== undefined && state.applied?.workspace.key === boundKey ? state.applied : null
  const overlayNow = state.current ?? retained
  if (!overlayNow) {
    if (state.failedAt === undefined) {
      if (state.applied) await releaseKey(loaded, !!state.applied.entry)
      state.applied = null
      record(sessionID, { kind: "unbound" })
      return
    }
    // Bound, but the overlay could not be derived. Whatever runs under the key
    // is dropped and nothing is handed back: the reloaded config may carry a
    // raw IDE or hosted entry, and that must not answer for this workspace.
    if (state.applied?.entry || DATAMATE_KEY in (await mcp().status())) await mcp().remove(DATAMATE_KEY)
    state.applied = null
    // Say so, once, rather than settling a bound directory as unbound in silence.
    const outcome: Outcome = { kind: "connect-failed", error: "the workspace engine could not be checked" }
    record(sessionID, outcome)
    await announceRefusal(sessionID, outcome, {
      title: `Workspace "${binding.datamateName}": engine unavailable`,
      message: `${outcome.error}; it is checked again shortly.`,
      variant: "warning",
    })
    return
  }
  const workspace = overlayNow.workspace

  // Bring MCP in line with the overlay: start or replace the engine when the
  // derived entry changed, drop it when there is none any more.
  if (overlayNow.entry) {
    // The argv is the same for the same id in another tenant; the engine
    // reads its credentials when it starts, so it is replaced on identity, not
    // only on argv.
    const replaced =
      !sameEntry(state.applied?.entry ?? null, overlayNow.entry) || state.applied?.workspace.key !== workspace.key
    if (replaced) await mcp().add(DATAMATE_KEY, overlayNow.entry)
  } else if (state.applied?.entry || DATAMATE_KEY in (await mcp().status())) {
    // Ours to drop — or a client that predates the link, which MCP bootstrapped
    // from an IDE or hosted entry while the directory was unbound. With the
    // overlay refusing, nothing may serve the workspace under the key.
    await mcp().remove(DATAMATE_KEY)
  }
  state.applied = overlayNow
  state.droppedForeign = false

  if (!overlayNow.entry) {
    const refusal = overlayNow.refusal ?? { kind: "engine-missing" as const }
    if (refusal.kind === "engine-missing") {
      const declared = await declaredFor(workspace)
      const count = declared?.keys.length
      const outcome: Outcome =
        count === undefined ? { kind: "engine-missing" } : { kind: "engine-missing", declared: count }
      record(sessionID, outcome)
      const what =
        count === undefined
          ? `Workspace "${workspace.name}" has integration tools that run on the local engine, which is not installed.`
          : `Workspace "${workspace.name}" declares ${count} integration tool${count === 1 ? "" : "s"}. They run on the local engine, which is not installed.`
      await announceRefusal(
        sessionID,
        outcome,
        {
          title: `Workspace "${workspace.name}" needs the local engine`,
          message: `${what} Install it with: ${installCommand()}`,
          variant: "warning",
        },
        {
          reason: "engine-missing",
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          declared: count ?? 0,
          command: installCommand(),
        },
      )
      return
    }
    record(sessionID, refusal)
    const declared = (await declaredFor(workspace.id))?.keys.length ?? 0
    await announceRefusal(
      sessionID,
      refusal,
      {
        title: `Workspace "${workspace.name}": engine not usable`,
        message: describeRefusal(refusal.found, workspace.name),
        variant: "warning",
      },
      {
        reason: "engine-too-old",
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        declared,
        found: refusal.found ?? "unknown",
        command: installCommand(),
      },
    )
    return
  }

  // The engine is configured. The first status call boots MCP, which awaits
  // the engine's handshake; the allowlist lookup overlaps with it.
  const [statusMap, declared] = await Promise.all([mcp().status(), declaredFor(workspace)])
  let status = statusMap[DATAMATE_KEY]
  const session = sessions.get(sessionID)
  if (status?.status !== "connected" && !session?.retried) {
    ;(session ?? record(sessionID, { kind: "connect-failed", error: "retrying" })).retried = true
    log.info("workspace engine not connected; retrying once for this session", {
      workspaceId: workspace.id,
      sessionID,
      status: status?.status,
    })
    await mcp().add(DATAMATE_KEY, overlayNow.entry)
    status = (await mcp().status())[DATAMATE_KEY]
  }
  if (status?.status !== "connected") {
    const outcome: Outcome = {
      kind: "connect-failed",
      error: status?.error ?? `engine status: ${status?.status ?? "unknown"}`,
    }
    record(sessionID, outcome)
    await announceRefusal(sessionID, outcome, {
      title: `Workspace "${workspace.name}": engine failed to start`,
      message: `${outcome.error}. Start a new session to try again.`,
      variant: "error",
    })
    return
  }

  const present = engineToolKeys(await mcp().tools())
  const missing = declared ? declared.keys.filter((k) => !present.has(k)) : undefined
  // `available` is everything the engine serves under the key. The engine adds
  // tools beyond the allowlist (knowledge, memory) when the workspace enables
  // them, so the "N of M declared" line counts only the declared ones present.
  const served = declared ? declared.keys.length - (missing?.length ?? 0) : present.size
  const outcome: Outcome = {
    kind: "attached",
    available: present.size,
    ...(declared ? { declared: declared.keys.length, missing } : {}),
  }
  const rec = record(sessionID, outcome)
  // Keyed on the workspace too: a re-link with an identical inventory is still
  // a new verdict the user should hear.
  const signature = `attached:${workspace.key}:${outcome.available}:${outcome.declared ?? "?"}:${(missing ?? []).join(",")}`
  if (rec.announced === signature) return
  rec.announced = signature
  log.info("workspace engine attached", {
    workspaceId: workspace.id,
    available: outcome.available,
    declared: outcome.declared,
    missing,
  })
  if (isHeadless()) return
  await notify({
    title: `Workspace "${workspace.name}"`,
    message: declared
      ? `${served} of ${declared.keys.length} declared integration tools available.${describeMissing(missing ?? [])}`
      : `${outcome.available} integration tools available.`,
    variant: missing && missing.length > 0 ? "warning" : "info",
  })
}

/** Tell the session about a refusal, once per unchanged verdict.
 *
 * The substitution point for the install offer: when installing would help
 * and an `offer` is supplied, the offer surface (dialog, headless line, or
 * toast fallback) replaces the toast — never adds to it. Otherwise headless
 * `run` prints one stderr line and the TUI gets the toast. */
export async function announceRefusal(
  sessionID: string,
  outcome: Outcome,
  toast: Toast,
  offer?: EngineOffer,
): Promise<void> {
  const rec = sessions.get(sessionID) ?? record(sessionID, outcome)
  const detail = "error" in outcome ? outcome.error : "found" in outcome ? String(outcome.found) : ""
  const declared = "declared" in outcome ? String(outcome.declared ?? "?") : ""
  const signature = `${outcome.kind}:${detail}:${declared}:${toast.title}`
  if (rec.announced === signature) return
  rec.announced = signature
  if (offer && INSTALL_HELPS[outcome.kind]) {
    await offerOrNotify(offer, toast)
    return
  }
  if (isHeadless()) {
    printLine(`${toast.title}: ${toast.message}`)
    return
  }
  await notify(toast)
}

/** Is a re-probe worth asking for on the next turn? Exposed for the install
 * offer, which schedules nothing itself: it installs, invalidates the probe,
 * and the next turn boundary attaches. */
export function isRepairable(outcome: Outcome | undefined): boolean {
  return !!outcome && REPAIRABLE[outcome.kind]
}

/** Test-only: forget everything this process learned. */
export function resetForTests(): void {
  directories.clear()
  probeMemo = null
  sessions.clear()
  turnTools.clear()
  declaredCache.clear()
}

/** Test-only views. */
export function overlayForTests(directory?: string): Overlay | null {
  const dir = directory ?? currentDirectory()
  return dir ? (directories.get(dir)?.current ?? null) : null
}
export function trackedSessionsForTests(): number {
  return sessions.size
}
