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
import os from "os"
import path from "path"
import { DATAMATE_KEY } from "@/altimate/datamate-transport"
import { MCP } from "@/mcp"
import { sanitize } from "@/mcp/catalog"
import { findAllConfigPaths, listMcpInConfig } from "@/mcp/config"
import { Config } from "@/config/config"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { defer } from "@/util/defer"
import { displayWorkspaceName } from "./workspace-name"
import {
  currentDirectory,
  isEnabled,
  isHeadless,
  isServe,
  log,
  syncInternals,
  type ScopedBinding,
} from "./engine-seams"
import { declaredBounded, fingerprint, notify, printLine, resolveBinding, versionOf, which } from "./engine-probes"
import { OFFER_RECHECK_MS, OFFER_SKIP_TTL_MS, installCommand, offerOrNotify, type EngineOffer } from "./engine-offer"
import {
  ENGINE_BINARY,
  INSTALL_HELPS,
  REPAIRABLE,
  TOOL_PREFIX,
  clearsFloor,
  parseUnfulfilled,
  reportedMissing,
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
  UNFULFILLED_META_KEY,
} from "./engine-types"
import {
  snapshotCounts,
  statusHeadline,
  workspaceIdentity,
  writeAttachSnapshot,
  type AttachCounts,
  type AttachSnapshot,
} from "./attach-snapshot"

export * from "./engine-types"
export * from "./engine-offer"
export { isEnabled, isHeadless, isServe, syncInternals } from "./engine-seams"

/** Sessions remembered per process. It is a memo; an evicted session just re-settles. */
export const MAX_TRACKED_SESSIONS = 256
/** A failed probe is repeated at most this often, so a missing engine does not
 * cost a process spawn on every turn while still being noticed once installed. */
export const FAILED_PROBE_TTL_MS = 30_000
/** A failed allowlist lookup is retried at most this often. */
export const DECLARED_RETRY_MS = 60_000

// ── the engine on PATH ──────────────────────────────────────────────────────

type Probe = { kind: "ok"; version: string } | { kind: "missing" } | { kind: "too-old"; found: string | null }

let probeMemo: { result: Probe; at: number; fingerprint: string | null } | null = null

function now(): number {
  return syncInternals.now ? syncInternals.now() : Date.now()
}

async function probeEngine(): Promise<Probe> {
  const at = now()
  // A usable engine is remembered for the process — before the PATH scan, so
  // the healthy path costs nothing per turn. A missing one is asked
  // about on every call — `which` is a PATH scan, no process spawn — so an
  // install made from the offer dialog (which runs in another module realm and
  // cannot reach this memo) is seen on the next turn. A too-old or broken one
  // costs a spawn to re-check, so that is rate-limited by the TTL — but only
  // while the file on PATH is the same one: an update written over it (the
  // offer's `npm i -g` on an old engine) changes the fingerprint and is
  // re-probed on the next turn, just as an install is.
  if (probeMemo && probeMemo.result.kind === "ok") return probeMemo.result
  const bin = which(ENGINE_BINARY)
  const seen = bin ? fingerprint(bin) : null
  if (
    probeMemo &&
    probeMemo.result.kind === "too-old" &&
    bin &&
    probeMemo.fingerprint === seen &&
    at - probeMemo.at < FAILED_PROBE_TTL_MS
  ) {
    return probeMemo.result
  }
  let result: Probe
  if (!bin) {
    result = { kind: "missing" }
  } else {
    const version = await versionOf(bin)
    result = clearsFloor(version) ? { kind: "ok", version: version! } : { kind: "too-old", found: version }
  }
  // A `missing` result is recorded too but never honoured: the guards above
  // match only `ok` and `too-old`, so an install is noticed on the next call.
  probeMemo = { result, at, fingerprint: seen }
  return result
}

/** Forget the last probe, so the next turn boundary looks for the engine
 * again immediately. Nothing in production calls this — the offer dialog runs
 * in another module realm — which is why the probe itself notices an engine
 * that appeared or changed on PATH. Kept for tests and diagnostics. */
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
  /** The probed engine version when the engine ran; null when it is missing. */
  version: string | null
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
  /** The workspace the directory's binding last read as, while workspace routing
   * applies to it: set whenever the overlay or a turn boundary reads the binding,
   * whatever happens to the engine afterwards. Null when unlinked, when the read
   * failed, and when routing is off (disabled, `serve`, managed config). */
  linked?: { id: string; name: string; key: string } | null
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
  return workspaceIdentity(binding.scope, binding.datamateId)
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
  state.linked = null
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
    // Recorded before the probe: a probe that throws leaves no overlay, but the
    // directory is still linked.
    state.linked = workspace
    const probe = await probeEngine()
    if (probe.kind === "ok") {
      const entry = engineEntry(workspace.id)
      config.mcp ??= {}
      config.mcp[DATAMATE_KEY] = entry
      state.current = { directory, workspace, entry, refusal: null, version: probe.version }
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
      version: probe.kind === "missing" ? null : probe.found,
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

/** The workspace this directory is linked to, while workspace routing applies
 * to it, or null. Unlike `managedWorkspace` — which answers "who owns the key",
 * and so follows the overlay — this follows the binding read: a linked directory
 * whose engine probe failed has no overlay, but is still linked. */
export function linkedWorkspace(directory: string | null = currentDirectory()): { id: string; name: string } | null {
  if (!directory) return null
  const linked = directories.get(directory)?.linked
  return linked ? { id: linked.id, name: linked.name } : null
}

/** `linkedWorkspace` once the overlay has run for this instance. */
export async function linkedWorkspaceLoaded(
  directory: string | null = currentDirectory(),
): Promise<{ id: string; name: string } | null> {
  if (!directory) return null
  await config().get()
  return linkedWorkspace(directory)
}

// ── per-session outcome ─────────────────────────────────────────────────────

/** `retried`: this session already spent its one re-add on a failed handshake.
 * Per session, so "start a new session to try again" is true. */
type SessionRecord = {
  outcome: Outcome
  announced?: string
  announcedAt?: number
  retried?: boolean
  /** The last attach saw a report it had to drop as malformed. */
  reportMalformed?: boolean
  /** The workspace the directory was linked to when the boundary settled this
   * outcome. */
  linked?: { id: string; name: string } | null
}
const sessions = new Map<string, SessionRecord>()
const declaredCache = new Map<string, { value: Declared | null; at: number }>()
/** Verdict signatures a headless process has already printed to stderr. */
const headlessPrinted = new Set<string>()

function record(sessionID: string, outcome: Outcome): SessionRecord {
  const previous = sessions.get(sessionID)
  sessions.delete(sessionID)
  const next: SessionRecord = {
    outcome,
    announced: previous?.announced,
    announcedAt: previous?.announcedAt,
    retried: previous?.retried,
    // Only consecutive attached turns share it; anything in between resets it, so
    // the next malformed report is logged as a new transition. (bot review)
    reportMalformed: outcome.kind === "attached" ? previous?.reportMalformed : false,
  }
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

/** The workspace this session's settled outcome is about, as its boundary read
 * the link, or null. */
export function settledWorkspace(sessionID: string): { id: string; name: string } | null {
  return sessions.get(sessionID)?.linked ?? null
}

function mcp() {
  return (
    syncInternals.mcp ?? {
      status: () => MCP.status() as Promise<McpStatus>,
      add: (name: string, cfg: LocalMcpConfig | McpEntry) => MCP.add(name, cfg as Parameters<typeof MCP.add>[1]),
      remove: (name: string) => MCP.remove(name),
      tools: () => MCP.tools() as Promise<Record<string, unknown>>,
      listMeta: (name: string) => MCP.listMeta(name),
      snapshot: (name: string) =>
        MCP.snapshot(name) as Promise<{ tools: Record<string, unknown>; meta: Record<string, unknown> | undefined }>,
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
    // Kept with the outcome, under the lock: the directory's link moves with any
    // later config load, and a turn's notice must name the workspace its own
    // outcome is about.
    const settled = sessions.get(sessionID)
    if (settled) settled.linked = linkedWorkspace(directory)
    const catalogued = await body()
    // After the catalog, not before: the TUI shows one toast at a time, and the
    // routing summary precedence announces while the catalog is built would
    // replace this warning within half a second of it appearing (measured).
    await warnLegacyEntries(directory)
    return catalogued
  })
  state.chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** Hold the current directory's turn-boundary lock until the handle is
 * disposed: no boundary links the directory, or attaches, replaces or releases
 * its engine, meanwhile. For a writer of MCP config that must check it is
 * allowed and write as one step. */
export async function holdDirectoryLock(): Promise<Disposable> {
  const directory = currentDirectory()
  if (!directory) return defer(() => {})
  const state = stateFor(directory)
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  const previous = state.chain
  state.chain = previous.then(() => held)
  await previous
  return defer(release)
}

/** The engine tools a turn catalogued first, kept for its later catalogs.
 * `resolveTools` re-snapshots MCP on every step, so a re-link applied by
 * another session's boundary mid-turn would otherwise be re-catalogued here;
 * pinning keeps this turn on the engine its boundary read. A call through a
 * pinned wrapper after a replacement reaches the closed client and fails — it
 * never routes to the other workspace.
 *
 * The first catalog's key order is kept too. The provider receives tools in
 * record order, and a reorder between steps misses its prompt cache for the
 * whole request. */
const turnTools = new Map<string, { engine: Record<string, unknown>; order: string[] }>()

export function pinTurnTools<T>(sessionID: string, firstCatalog: boolean, tools: Record<string, T>): void {
  if (!isEnabled() || isServe()) return
  const engine = Object.fromEntries(Object.entries(tools).filter(([key]) => key.startsWith(TOOL_PREFIX)))
  if (firstCatalog) {
    turnTools.delete(sessionID)
    turnTools.set(sessionID, { engine, order: Object.keys(tools) })
    while (turnTools.size > MAX_TRACKED_SESSIONS) {
      const oldest = turnTools.keys().next().value
      if (oldest === undefined) break
      turnTools.delete(oldest)
    }
    return
  }
  const pinned = turnTools.get(sessionID)
  if (!pinned) return
  // Own-key checks only: a tool may be named `constructor` or `toString`.
  const next: Record<string, T> = Object.fromEntries(
    Object.entries(tools).filter(([key]) => !Object.hasOwn(engine, key)),
  )
  for (const [key, tool] of Object.entries(pinned.engine)) next[key] = tool as T
  // Rebuild in first-catalog order; keys new since then go last, in arrival order.
  const ordered = new Set([...pinned.order.filter((key) => Object.hasOwn(next, key)), ...Object.keys(next)])
  for (const key of Object.keys(tools)) delete tools[key]
  for (const key of ordered) tools[key] = next[key]
}

/** Sets of `datamate-<name>` entries already reported, per directory and
 * workspace, for the life of this process. */
const legacyWarned = new Set<string>()

/** In a linked project the workspace engine is the only route to the
 * workspace's integrations, and `datamate_manager` is off. A standalone
 * `datamate-<name>` MCP entry saved before that still loads, as a second route
 * outside the engine. Say so once per set of entries, naming the files they are
 * in; the config is never edited — the entries are the user's. Failures are
 * logged, never thrown: this must not hold up the turn. On the turn it fires,
 * it is the boundary's last toast, so it takes the TUI's single toast slot from
 * that turn's routing summary — the second route it reports is the thing that
 * summary cannot be trusted over. */
async function warnLegacyEntries(directory: string): Promise<void> {
  try {
    const loaded = await config().get()
    const workspace = directories.get(directory)?.linked
    if (!workspace) return
    const names = Object.entries(loaded.mcp ?? {})
      .filter(([key, entry]) => key.startsWith(`${DATAMATE_KEY}-`) && (entry as { enabled?: unknown } | null)?.enabled !== false)
      .map(([key]) => key)
      .sort()
    if (names.length === 0) return
    // The account-qualified key, not the id: ids are tenant-local, and a relink
    // to another tenant's workspace with the same id is another workspace.
    const signature = `${directory}\0${workspace.key}\0${names.join("\0")}`
    if (legacyWarned.has(signature)) return
    const where = await locateEntries(directory, names)
    const listed = names
      .map((name) => {
        const files = where.get(name)
        return files ? `${name} (${files.map((file) => displayPath(file, directory)).join(", ")})` : name
      })
      .join(", ")
    // The title is one line in the TUI's toast box (about 60 columns): it stays
    // fixed and short, and the workspace name goes in the message.
    const toast: Toast = {
      title: "Older datamate entries still configured",
      message:
        `This project is linked to workspace "${displayWorkspaceName(workspace.name)}", whose engine serves its ` +
        `integrations, but these older datamate MCP entries still load beside it: ${listed}. Remove them from ` +
        `that config to keep a single route to the workspace's integrations.`,
      variant: "warning",
    }
    log.info("linked project still configures datamate entries", { directory, names })
    // Marked only once delivered: a publication that fails (false, or a throw
    // caught below) is tried again at the next turn boundary.
    if (isHeadless()) printLine(`${toast.title}: ${toast.message}`)
    else if (!(await notify(toast))) return
    legacyWarned.add(signature)
  } catch (err) {
    log.warn("could not check for older datamate entries", { directory, err: String(err) })
  }
}

/** Every config file each entry is defined in, project files first: an entry
 * in two files still loads after it is removed from one. An entry found in none
 * of them (set by an environment or remote config) is left out. */
async function locateEntries(directory: string, names: string[]): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>()
  const projectDirs = new Set([directory, projectRoot(directory)])
  const paths = new Set<string>()
  for (const dir of projectDirs) for (const p of await findAllConfigPaths(dir, Global.Path.config)) paths.add(p)
  for (const p of paths) {
    const keys = new Set(
      await listMcpInConfig(p).catch((err) => {
        log.warn("could not read a config file for older datamate entries", { file: p, err: String(err) })
        return [] as string[]
      }),
    )
    for (const name of names) if (keys.has(name)) found.set(name, [...(found.get(name) ?? []), p])
  }
  return found
}

/** A config path as the warning shows it: relative to the project when inside
 * it, under `~` when inside the home directory, else as is. */
function displayPath(file: string, directory: string): string {
  const inProject = path.relative(directory, file)
  if (inProject && !inProject.startsWith("..") && !path.isAbsolute(inProject)) return inProject
  const home = os.homedir()
  const inHome = path.relative(home, file)
  if (inHome && !inHome.startsWith("..") && !path.isAbsolute(inHome)) return path.join("~", inHome)
  return file
}

/** The instance's worktree when it has one, else the directory itself. */
function projectRoot(directory: string): string {
  try {
    const wt = Instance.worktree
    return wt && wt !== "/" ? wt : directory
  } catch {
    return directory
  }
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
  state.linked =
    read.kind === "bound"
      ? { id: String(read.binding.datamateId), name: read.binding.datamateName, key: workspaceKey(read.binding) }
      : null
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
          ...(count === undefined ? {} : { declared: count }),
          command: installCommand(),
        },
      )
      return
    }
    record(sessionID, refusal)
    const declared = (await declaredFor(workspace))?.keys.length
    await announceRefusal(
      sessionID,
      refusal,
      {
        title: `Workspace "${workspace.name}": engine not usable`,
        message: describeRefusal(refusal.found, workspace.name, installCommand()),
        variant: "warning",
      },
      {
        reason: "engine-too-old",
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        ...(declared === undefined ? {} : { declared }),
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

  // One read for both: a tools/list refresh that completes between two separate
  // reads would pair one listing's tools with another's report. (multi-model review)
  const { tools, meta } = await mcp().snapshot(DATAMATE_KEY)
  const present = engineToolKeys(tools)
  // The gaps come from the engine's own report, with reasons; this client no
  // longer diffs the allowlist against what arrived. No report (nothing at or
  // above the floor omits it) means no gap is claimed, not that there is none.
  const unfulfilled = parseUnfulfilled(meta)
  const missingReport = unfulfilled === undefined ? undefined : reportedMissing(unfulfilled)
  const missing = missingReport?.map((u) => u.key)
  // `available` is everything the engine serves under the key; the engine adds
  // tools beyond the allowlist (knowledge, memory) when the workspace enables
  // them. The "N of M" numbers are counted once, in `snapshotCounts`, the same
  // way every surface that describes this attach counts them. (review)
  const outcome: Outcome = {
    kind: "attached",
    available: present.size,
    ...(declared ? { declared: declared.keys.length } : {}),
    ...(missing === undefined ? {} : { missing }),
    ...(unfulfilled === undefined ? {} : { unfulfilled }),
    ...(declared?.extensions?.length ? { extensions: declared.extensions } : {}),
  }
  const rec = record(sessionID, outcome)
  const snapshot: AttachSnapshot = {
    workspace: { id: workspace.id, name: workspace.name, key: workspace.key },
    engineVersion: overlayNow.version,
    declared,
    present: [...present],
    unfulfilled,
    at: now(),
  }
  ;(syncInternals.persistSnapshot ?? writeAttachSnapshot)(directory, snapshot)
  const counts = snapshotCounts(snapshot)
  // Keyed on the workspace too: a re-link with an identical inventory is still
  // a new verdict the user should hear.
  // extServed is part of what the user hears, so it is part of the signature:
  // an equal-count tool swap that changes only the extension share must still
  // re-announce. (bot review)
  // A gap whose reason changed (a connection fixed, a binary still absent)
  // is a new verdict too, so the reasons are in the signature — and so are the
  // integration and the error text, which the toast's remediation is built
  // from. (multi-model review)
  // No report and an empty report are different verdicts (the severity rule
  // differs), and so is a change in which declared tools are callable at an equal
  // total, so both are in the signature too: the catalog entries themselves, not
  // their count, or a swap at an equal count goes unheard. (bot review, codex)
  const gaps =
    unfulfilled === undefined
      ? "no-report"
      : JSON.stringify((missingReport ?? []).map((u) => [u.integrationId, u.key, u.reason, u.detail ?? ""]))
  const signature = `attached:${workspace.key}:${outcome.available}:${outcome.declared ?? "?"}:${counts.served}:${JSON.stringify(counts.callable)}:${gaps}:${counts.extServed}`
  // A report that is present but malformed is dropped whole (no gap is claimed);
  // say so in the log, or the missing reasons are a silent mystery. Checked before
  // the announcement is deduplicated, since a malformed report can share its
  // signature with an earlier empty or absent one, and logged once per transition
  // into that state rather than on every turn. (codex)
  const malformed = unfulfilled === undefined && meta?.[UNFULFILLED_META_KEY] !== undefined
  if (malformed && !rec.reportMalformed)
    log.warn("workspace engine report was malformed; showing no gaps", { workspaceId: workspace.id })
  rec.reportMalformed = malformed
  if (rec.announced === signature) return
  rec.announced = signature
  log.info("workspace engine attached", {
    workspaceId: workspace.id,
    available: outcome.available,
    declared: outcome.declared,
    unfulfilled,
  })
  if (isHeadless()) return
  // Numbers only. The keys and their reasons live in the `/workspace` status
  // view, which the toast points at; a toast that tried to carry them read as
  // noise (review of the first cut).
  await notify({
    title: `Workspace "${workspace.name}"`,
    message: attachSummary(counts),
    // Severity follows what is callable, not only what is reported: two raw
    // keys that sanitise to one catalog entry leave the headline short with an
    // empty report. With no report nothing is claimed, so that stays info.
    variant:
      counts.gaps > 0 || (unfulfilled !== undefined && !!declared && counts.served < declared.keys.length)
        ? "warning"
        : "info",
  })
}

/** The one line a settled attach is announced with: the headline every
 * surface shares, then where the detail is. */
export function attachSummary(counts: Pick<AttachCounts, "served" | "declared" | "gaps" | "extServed">): string {
  return `${statusHeadline(counts)}. Details: /workspace`
}

/** Tell the session about a refusal, once per unchanged verdict.
 *
 * The substitution point for the install offer: when installing would help
 * and an `offer` is supplied, the offer surface (dialog, headless line, or
 * toast fallback) replaces the toast — never adds to it. Otherwise headless
 * `run` prints one stderr line and the TUI gets the toast.
 *
 * The offer route's "once" expires with the "Not now" latch: a session that
 * stays open past `OFFER_SKIP_TTL_MS` is offered again, so the latch (which
 * the TUI checks on every offer) decides, not the age of the session. The
 * latch is measured from the user's "Not now", which can come well after the
 * offer was raised, so after the first expiry the offer is re-raised every
 * `OFFER_RECHECK_MS` rather than once per further window — the TUI keeps
 * suppressing it until its latch really ends. */
export async function announceRefusal(
  sessionID: string,
  outcome: Outcome,
  toast: Toast,
  offer?: EngineOffer,
): Promise<void> {
  const rec = sessions.get(sessionID) ?? record(sessionID, outcome)
  const detail = "error" in outcome ? outcome.error : "found" in outcome ? String(outcome.found) : ""
  // The declared count is not part of the verdict: a lookup that fails on one
  // turn and recovers on the next changes the number in the text, not what
  // the text has to say, so it must not re-announce (nor re-print). The
  // workspace is: the title carries its name, and two workspaces can share
  // one, so the id goes in as well.
  const signature = `${outcome.kind}:${detail}:${toast.title}:${offer?.workspaceId ?? ""}`
  const offering = !!offer && INSTALL_HELPS[outcome.kind]
  const at = now()
  let repeat = false
  if (rec.announced === signature) {
    // A clock that moved backwards (NTP correction, VM resume) reads as
    // expired, as the TUI's latch treats it — otherwise the overlay would stop
    // raising the offer until real time caught up plus the whole window.
    const elapsed = rec.announcedAt === undefined ? undefined : at - rec.announcedAt
    const expired = offering && elapsed !== undefined && (elapsed < 0 || elapsed >= OFFER_SKIP_TTL_MS)
    if (!expired) return
    repeat = true
  }
  rec.announced = signature
  rec.announcedAt = repeat ? at - OFFER_SKIP_TTL_MS + OFFER_RECHECK_MS : at
  if (isHeadless()) {
    // A headless `run` is one process with one stderr, whatever sessions it
    // creates along the way (a sub-agent's session settles the same verdict
    // and would print the same line). One line per verdict per process.
    if (headlessPrinted.has(signature)) return
    headlessPrinted.add(signature)
  }
  if (offering) {
    await offerOrNotify(offer, toast, sessionID)
    return
  }
  if (isHeadless()) {
    printLine(`${toast.title}: ${toast.message}`)
    return
  }
  await notify(toast)
}

/** Is a re-probe worth asking for on the next turn? Exposed for the install
 * offer, which schedules nothing itself: it installs, and the next turn
 * boundary sees the new or changed binary on PATH and attaches. */
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
  headlessPrinted.clear()
  legacyWarned.clear()
}

/** Test-only views. */
export function overlayForTests(directory?: string): Overlay | null {
  const dir = directory ?? currentDirectory()
  return dir ? (directories.get(dir)?.current ?? null) : null
}
export function trackedSessionsForTests(): number {
  return sessions.size
}
