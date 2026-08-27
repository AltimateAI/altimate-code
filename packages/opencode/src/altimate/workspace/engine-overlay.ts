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
import { currentDirectory, isEnabled, isHeadless, isServe, log, syncInternals } from "./engine-seams"
import { declaredBounded, notify, printLine, resolveBinding, versionOf, which } from "./engine-probes"
import {
  ENGINE_BINARY,
  INSTALL_COMMAND,
  REPAIRABLE,
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
  if (probeMemo && (probeMemo.result.kind === "ok" || at - probeMemo.at < FAILED_PROBE_TTL_MS)) {
    return probeMemo.result
  }
  const bin = which(ENGINE_BINARY)
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
  workspace: { id: string; name: string }
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

function sameEntry(a: LocalMcpConfig | null, b: LocalMcpConfig | null): boolean {
  return !!a && !!b && a.command.join("\0") === b.command.join("\0")
}

/** Derive the `datamate` entry for a bound directory into `config.mcp`.
 *
 * Called from the config loader after external MCP discovery, so it has the
 * last word over every other source of the key. Mutates `config.mcp` only when
 * the directory is bound with the pilot on. Never throws. */
export async function overlay(directory: string, config: { mcp?: Record<string, unknown> }): Promise<void> {
  const state = stateFor(directory)
  try {
    if (!isEnabled() || isServe()) {
      state.current = null
      return
    }
    const binding = await resolveBinding(directory)
    if (!binding) {
      // Logged because "flag on, nothing happened" is the question every
      // first-run report asks; the directory is the usual answer.
      log.info("workspace engine overlay skipped: directory is not bound", { directory })
      state.current = null
      return
    }
    const workspace = { id: String(binding.datamateId), name: binding.datamateName }
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
  return directories.get(directory)?.current?.workspace ?? null
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

/** Hand the key back to whatever the reloaded config says now that the overlay
 * no longer fills it: the user's own hosted or IDE-written entry, if any. MCP
 * enumerates live clients only, so a restored config entry must be started or
 * the project's standalone datamate tools stay gone for the rest of the process. */
async function releaseKey(loaded: { mcp?: Record<string, unknown> } | undefined): Promise<void> {
  await mcp().remove(DATAMATE_KEY)
  const restored = loaded?.mcp?.[DATAMATE_KEY]
  if (isMcpEntry(restored) && restored.enabled !== false) {
    log.info("workspace engine released the datamate key; starting the configured entry", { type: restored.type })
    await mcp().add(DATAMATE_KEY, restored)
  }
}

async function declaredFor(workspaceId: string): Promise<Declared | null> {
  const cached = declaredCache.get(workspaceId)
  if (cached && (cached.value || now() - cached.at < DECLARED_RETRY_MS)) return cached.value
  const value = await declaredBounded(workspaceId)
  declaredCache.set(workspaceId, { value, at: now() })
  return value
}

/** Reconcile, settle and announce for one session. Runs at the start of every
 * user turn, before the tool list is resolved. Never throws. */
export async function beforeTurn(sessionID: string): Promise<void> {
  if (!isEnabled() || isServe()) {
    record(sessionID, { kind: "disabled" })
    return
  }
  const directory = currentDirectory()
  if (!directory) {
    record(sessionID, { kind: "unbound" })
    return
  }
  const state = stateFor(directory)
  const run = state.chain.then(() => reconcile(sessionID, directory, state))
  state.chain = run.catch(() => undefined)
  try {
    await run
  } catch (err) {
    log.warn("workspace engine turn hook failed", { sessionID, err: String(err) })
  }
}

async function reconcile(sessionID: string, directory: string, state: DirectoryState): Promise<void> {
  // The overlay runs inside config load; make sure it has run at least once.
  await config().get()
  // First turn boundary: MCP bootstrapped from the config as loaded, i.e. from
  // the overlay as it stands now.
  if (state.applied === undefined) state.applied = state.current

  const binding = await resolveBinding(directory)
  if (!binding) {
    // Unlinked (or never linked): the key is not ours to fill.
    let loaded: { mcp?: Record<string, unknown> } | undefined
    if (state.current || state.applied) {
      await config().invalidate()
      loaded = await config().get()
    }
    if (state.applied?.entry) await releaseKey(loaded)
    state.applied = null
    record(sessionID, { kind: "unbound" })
    return
  }
  const workspaceId = String(binding.datamateId)

  // Reload the overlay when the binding moved, or when a refused engine may
  // have appeared since (the probe memo bounds how often that is asked).
  let reload = !state.current || state.current.workspace.id !== workspaceId
  if (!reload && state.current && !state.current.entry) {
    const probe = await probeEngine()
    reload = probe.kind === "ok"
  }
  let loaded: { mcp?: Record<string, unknown> } | undefined
  if (reload) {
    await config().invalidate()
    loaded = await config().get()
  }

  const overlayNow = state.current
  if (!overlayNow) {
    if (state.applied?.entry) await releaseKey(loaded)
    state.applied = null
    record(sessionID, { kind: "unbound" })
    return
  }
  const workspace = overlayNow.workspace

  // Bring MCP in line with the overlay: start or replace the engine when the
  // derived entry changed, drop it when there is none any more.
  if (overlayNow.entry) {
    if (!sameEntry(state.applied?.entry ?? null, overlayNow.entry)) await mcp().add(DATAMATE_KEY, overlayNow.entry)
  } else if (state.applied?.entry) {
    await mcp().remove(DATAMATE_KEY)
  }
  state.applied = overlayNow

  if (!overlayNow.entry) {
    const refusal = overlayNow.refusal ?? { kind: "engine-missing" as const }
    if (refusal.kind === "engine-missing") {
      const declared = await declaredFor(workspace.id)
      const count = declared?.keys.length
      const outcome: Outcome =
        count === undefined ? { kind: "engine-missing" } : { kind: "engine-missing", declared: count }
      record(sessionID, outcome)
      const what =
        count === undefined
          ? `Workspace "${workspace.name}" has integration tools that run on the local engine, which is not installed.`
          : `Workspace "${workspace.name}" declares ${count} integration tool${count === 1 ? "" : "s"}. They run on the local engine, which is not installed.`
      await announceRefusal(sessionID, outcome, {
        title: `Workspace "${workspace.name}" needs the local engine`,
        message: `${what} Install it with: ${INSTALL_COMMAND}`,
        variant: "warning",
      })
      return
    }
    record(sessionID, refusal)
    await announceRefusal(sessionID, refusal, {
      title: `Workspace "${workspace.name}": engine not usable`,
      message: describeRefusal(refusal.found, workspace.name),
      variant: "warning",
    })
    return
  }

  // The engine is configured. The first status call boots MCP, which awaits
  // the engine's handshake; the allowlist lookup overlaps with it.
  const [statusMap, declared] = await Promise.all([mcp().status(), declaredFor(workspace.id)])
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
  const signature = `attached:${workspace.id}:${outcome.available}:${outcome.declared ?? "?"}:${(missing ?? []).join(",")}`
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
 * The substitution point for the install offer: when `installWouldHelp(outcome)`
 * a dialog replaces the toast here; it never adds a second message. Headless
 * `run` prints one stderr line instead. */
export async function announceRefusal(sessionID: string, outcome: Outcome, toast: Toast): Promise<void> {
  const rec = sessions.get(sessionID) ?? record(sessionID, outcome)
  const detail = "error" in outcome ? outcome.error : "found" in outcome ? String(outcome.found) : ""
  const signature = `${outcome.kind}:${detail}:${toast.title}`
  if (rec.announced === signature) return
  rec.announced = signature
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
