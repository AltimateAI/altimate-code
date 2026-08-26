// altimate_change - new file
//
// Attach the bound workspace's integration engine to an altimate-code session.
//
// Integrations are served by the local datamate engine — the same process the
// VS Code extension spawns as `datamate start-stdio`. altimate-code can reuse an
// entry an IDE already wrote, but until now it could not acquire an engine on
// its own: with no entry present it fell to the hosted SSE endpoint, which runs
// in multi-user mode and serves a DIFFERENT tool set (no connection validation,
// no extension-bridge tools, server-side cwd). This module closes that gap.
//
// Rules, in order:
//  1. Reuse, but only what is ATTRIBUTABLE. An entry already registered under
//     DATAMATE_KEY is reused only when it is live AND its command pins the
//     engine to this workspace (`--datamate <id>`) AND that binary clears the
//     version floor. Being connected proves none of that: an unpinned engine
//     serves whichever teammate its owner has active, and that changes at
//     runtime from a UI this client does not control — the extension writes
//     exactly such an entry. Reusing one would report "workspace X: N tools"
//     about a process serving Y.
//     Anything live but not attributable — unpinned, pinned elsewhere, below the
//     floor, or a URL — is replaced by a pinned local spawn, and what it was is
//     reported. That costs the other client nothing: a stdio entry is a
//     per-client child process, so the IDE keeps its own engine and only our
//     registration changes. A connected URL entry is replaced for the same
//     reason rule 4 exists — the hosted endpoint serves a different tool set.
//     If the entry is DOWN, what it is decides what happens first:
//       - a URL entry is an IDE's in-process engine (normally localhost) or the
//         hosted endpoint. Neither can be revived from here — only the IDE can
//         bring its port back — so with a binding and a usable engine on PATH we
//         spawn locally and say what was replaced. The IDE's own config file is
//         never touched; when the IDE returns, its sync overwrites ours.
//       - a command entry that failed is retried once, then reported. Spawning a
//         second engine beside a failing one is the duplicate-process problem the
//         single-gateway design exists to avoid. A retry that succeeds is then
//         gated for attribution exactly like an entry that never dropped.
//  2. Opportunistic use. If a `datamate` binary is on PATH and its `--version`
//     clears the floor, spawn it for this workspace. A lookup, never an install.
//  3. Offer, never silently install. No engine → tell the user exactly which
//     workspace tools are unavailable and how to install. The CLI ships as a
//     self-contained binary with no Node runtime, so it must not pull one in.
//  4. NEVER fall back to hosted on failure. The local and hosted tool sets
//     diverge in both directions, so a silent fallback would change the
//     workspace's declared contract. A failed engine is reported, not routed
//     around.
//  5. Report what was declared but not delivered. The engine intersects the
//     workspace allowlist with what it managed to build and says nothing about
//     the difference; this module diffs declared keys against the tools that
//     actually arrived and surfaces the gap.
//
// Attaching runs beside the turn, not inside it: `ensure` is started before the
// turn's tools are resolved, and `whenAttached` gives a fresh spawn a bounded
// window to land so the engine's tools make the first tool list rather than
// arriving a turn late. Past the cap the turn proceeds and `tools/list_changed`
// delivers them.
//
// Gated on the workspace pilot flag; inert without a local binding.

import { execFile } from "node:child_process"
import { Flag as CoreFlag } from "@opencode-ai/core/flag/flag"
import { which as whichBinary } from "@opencode-ai/core/util/which"
import { Instance } from "@/project/instance"
import { Log } from "@/altimate/util/log"
import { MCP } from "@/mcp"
import { addMcpToConfig, resolveConfigPath } from "@/mcp/config"
import { Config } from "@/config/config"
import { AltimateApi } from "@/altimate/api/client"
import { DATAMATE_KEY } from "@/altimate/datamate-transport"
import { AppRuntime } from "@/effect/app-runtime"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TuiEvent } from "@/server/tui-event"
import { readLocalBinding, type CachedBinding } from "./state"

const log = Log.create({ service: "workspace-engine" })

/** Oldest engine this client is known to work against.
 *
 * 0.7.0 is the first engine that LOCKS the `--datamate` pin, so a settings
 * change cannot swap the workspace out from under a running engine. Everything
 * below it can drift, which is precisely what the attribution check in rule 1
 * exists to exclude — so the floor and that check are one mechanism, not two.
 *
 * SEQUENCING: this must not ship before `@altimateai/datamate` 0.7.0 is on npm,
 * or every bound user gets `engine-too-old` for a version they cannot install. */
export const MIN_ENGINE_VERSION = "0.7.0"
export const INSTALL_HINT = "npm i -g @altimateai/datamate"
export const ENGINE_BINARY = "datamate"

/** Engine tools arrive under the MCP server key as `<key>_<tool>`. */
const TOOL_PREFIX = `${DATAMATE_KEY}_`

export type Outcome =
  | { kind: "disabled" }
  | { kind: "unbound" }
  | { kind: "reused"; available: number }
  | { kind: "attached"; available: number; declared: number; missing: string[]; replaced?: string }
  | { kind: "engine-missing"; declared: number }
  | { kind: "engine-too-old"; found: string }
  | { kind: "connect-failed"; error: string }

export type LocalMcpConfig = { type: "local"; command: string[]; enabled: boolean }

/** A configured MCP entry, in either shape it can reach us: opencode's own
 * `command: string[]` argv, or the `{ command, args }` split an IDE writes and
 * `datamate-transport` normalises. Read defensively — this is merged config
 * written by other clients. */
export type ExistingEntry = { type?: string; url?: string; command?: string[] | string; args?: string[] }

type Toast = { title: string; message: string; variant: "info" | "success" | "warning" | "error" }

type McpStatus = Record<string, { status: string; error?: string } | undefined>

/** Declared allowlist for a workspace, split by whether the CLI can serve it.
 * Extension-type integrations are RPC into a live VS Code host and have no
 * meaning on the CLI surface, so they are excluded from the reported gap. */
export type Declared = { keys: string[]; extensionKeys: string[] }

/** Test seams. Production leaves every field unset. */
export const syncInternals: {
  resolveBinding?: () => Promise<CachedBinding | null>
  which?: (cmd: string) => string | null
  versionOf?: (bin: string) => Promise<string | null>
  mcp?: {
    status: () => Promise<McpStatus>
    add: (name: string, cfg: LocalMcpConfig) => Promise<unknown>
    connect: (name: string) => Promise<unknown>
    remove: (name: string) => Promise<unknown>
    tools: () => Promise<Record<string, unknown>>
  }
  persist?: (name: string, cfg: LocalMcpConfig) => Promise<void>
  /** The configured (merged) MCP entry under `name`, or null if none. */
  existingEntry?: (name: string) => Promise<ExistingEntry | null>
  declared?: (datamateId: string) => Promise<Declared | null>
  notify?: (toast: Toast) => Promise<void>
} = {}

export function isEnabled(): boolean {
  return CoreFlag.ALTIMATE_WORKSPACE
}

/** SemVer precedence compare. Returns <0, 0, >0.
 *
 * Build metadata is ignored, and a NON-numeric core component compares as older
 * so unreadable `--version` output can never clear a floor.
 *
 * Pre-release ordering is honoured rather than stripped: `0.7.0-beta.1` is
 * BELOW `0.7.0`. That matters here — the floor exists to require behaviour that
 * shipped in a specific release (the locked `--datamate` pin), and a pre-release
 * of that version predates it. Treating them as equal let a beta clear the floor
 * and be trusted for reuse. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const bare = v.trim().replace(/^v/, "")
    const plus = bare.indexOf("+")
    const noBuild = plus >= 0 ? bare.slice(0, plus) : bare
    const dash = noBuild.indexOf("-")
    return {
      core: (dash >= 0 ? noBuild.slice(0, dash) : noBuild).split(".").map((n) => Number.parseInt(n, 10)),
      pre: dash >= 0 ? noBuild.slice(dash + 1) : "",
    }
  }
  const pa = split(a)
  const pb = split(b)
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(pa.core[i]) ? pa.core[i] : -1
    const y = Number.isFinite(pb.core[i]) ? pb.core[i] : -1
    if (x !== y) return x - y
  }
  // Same core: a release outranks every pre-release of it (SemVer §11.3).
  if (!pa.pre && !pb.pre) return 0
  if (!pa.pre) return 1
  if (!pb.pre) return -1
  const ia = pa.pre.split(".")
  const ib = pb.pre.split(".")
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const x = ia[i]
    const y = ib[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d
    } else if (nx !== ny) {
      return nx ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/** Strip the server prefix from the engine tools present in the catalog. */
export function engineToolKeys(tools: Record<string, unknown>): Set<string> {
  const out = new Set<string>()
  for (const key of Object.keys(tools)) {
    if (key.startsWith(TOOL_PREFIX)) out.add(key.slice(TOOL_PREFIX.length))
  }
  return out
}

// ---------------------------------------------------------------------------
// Production implementations behind the seams
// ---------------------------------------------------------------------------

function currentDirectory(): string | null {
  try {
    return Instance.directory
  } catch {
    return null
  }
}

function projectRoot(): string {
  const wt = Instance.worktree
  return wt === "/" ? Instance.directory : wt
}

async function resolveBinding(): Promise<CachedBinding | null> {
  if (syncInternals.resolveBinding) return syncInternals.resolveBinding()
  const directory = currentDirectory()
  if (!directory) return null
  try {
    return await readLocalBinding(directory)
  } catch (err) {
    log.warn("could not resolve binding for engine attach", { err: String(err) })
    return null
  }
}

function which(cmd: string): string | null {
  return syncInternals.which ? syncInternals.which(cmd) : whichBinary(cmd)
}

/** `datamate --version` — the engine inlines its real package version here,
 * unlike its MCP `serverInfo`, which is a hard-coded placeholder. A version
 * string proves output, not identity; it is a compatibility floor only. */
function versionOf(bin: string): Promise<string | null> {
  if (syncInternals.versionOf) return syncInternals.versionOf(bin)
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null)
      const line = String(stdout).trim().split(/\r?\n/)[0] ?? ""
      resolve(line || null)
    })
  })
}

function mcp() {
  return (
    syncInternals.mcp ?? {
      status: () => MCP.status() as Promise<McpStatus>,
      add: (name: string, cfg: LocalMcpConfig) => MCP.add(name, cfg),
      connect: (name: string) => MCP.connect(name),
      remove: (name: string) => MCP.remove(name),
      tools: () => MCP.tools() as Promise<Record<string, unknown>>,
    }
  )
}

async function persist(name: string, cfg: LocalMcpConfig): Promise<void> {
  if (syncInternals.persist) return syncInternals.persist(name, cfg)
  const configPath = await resolveConfigPath(projectRoot())
  await addMcpToConfig(name, cfg, configPath)
}

async function existingEntry(name: string): Promise<ExistingEntry | null> {
  if (syncInternals.existingEntry) return syncInternals.existingEntry(name)
  try {
    const cfg = (await Config.get()) as { mcp?: Record<string, ExistingEntry | undefined> }
    return cfg.mcp?.[name] ?? null
  } catch (err) {
    log.warn("could not read merged MCP config", { name, err: String(err) })
    return null
  }
}

/** URL-based entries (`type: "remote"`, or any `url`) point at a process this
 * client does not own: an IDE's in-process engine, or the hosted endpoint. */
function isUrlEntry(entry: ExistingEntry | null): entry is ExistingEntry & { url: string } {
  return !!entry && (entry.type === "remote" || typeof entry.url === "string")
}

const PIN_FLAG = "--datamate"

/** The entry's full argv, flattening both config shapes. */
function commandArgv(entry: ExistingEntry | null): string[] {
  if (!entry) return []
  const head = typeof entry.command === "string" ? [entry.command] : (entry.command ?? [])
  return [...head, ...(entry.args ?? [])]
}

/** Which workspace does this entry pin its engine to, if any?
 *
 * `--datamate <id>` is the whole of an engine's workspace identity: the engine
 * locks it, so a settings change cannot swap it out underneath. An entry
 * WITHOUT it is not neutral — it serves whichever teammate its owner currently
 * has active, and that changes at runtime from a UI this client does not
 * control. The extension writes exactly such an entry (`datamate start-stdio`,
 * no pin), so "connected" alone never proves an engine serves this workspace.
 *
 * Scanned from the end because a repeated flag resolves last-wins, and both the
 * `--datamate 5` and `--datamate=5` spellings are valid on the engine's CLI. */
export function pinnedWorkspace(entry: ExistingEntry | null): string | null {
  const argv = commandArgv(entry)
  for (let i = argv.length - 1; i >= 0; i--) {
    const arg = argv[i]
    if (arg === PIN_FLAG) return argv[i + 1] ?? null
    if (arg.startsWith(`${PIN_FLAG}=`)) return arg.slice(PIN_FLAG.length + 1) || null
  }
  return null
}

/** Short, printable identity of an entry, for saying what was replaced. */
function describeEntry(entry: ExistingEntry | null): string {
  if (isUrlEntry(entry)) return entry.url
  const argv = commandArgv(entry)
  return argv.length > 0 ? argv.join(" ") : "an engine entry with no command"
}

async function declared(datamateId: string): Promise<Declared | null> {
  if (syncInternals.declared) return syncInternals.declared(datamateId)
  try {
    if (!(await AltimateApi.isConfigured())) return null
    const [workspace, catalog] = await Promise.all([
      AltimateApi.getDatamate(datamateId),
      AltimateApi.listIntegrations(),
    ])
    const extensionIds = new Set(catalog.filter((i) => i.type === "extension").map((i) => i.id))
    const keys: string[] = []
    const extensionKeys: string[] = []
    for (const integration of workspace.integrations ?? []) {
      const target = extensionIds.has(integration.id) ? extensionKeys : keys
      for (const tool of integration.tools ?? []) target.push(tool.key)
    }
    return { keys, extensionKeys }
  } catch (err) {
    log.warn("could not read declared workspace integrations", { datamateId, err: String(err) })
    return null
  }
}

async function notify(toast: Toast): Promise<void> {
  if (syncInternals.notify) return syncInternals.notify(toast)
  try {
    await AppRuntime.runPromise(
      EventV2Bridge.Service.use((events) => events.publish(TuiEvent.ToastShow, { ...toast, duration: 10000 })),
    )
  } catch (err) {
    log.warn("could not show workspace engine toast", { err: String(err) })
  }
}

// ---------------------------------------------------------------------------
// The attach flow
// ---------------------------------------------------------------------------

function describeMissing(missing: string[]): string {
  if (missing.length === 0) return ""
  const shown = missing.slice(0, 5).join(", ")
  const more = missing.length > 5 ? ` (+${missing.length - 5} more)` : ""
  return ` Declared but not available: ${shown}${more}.`
}

async function run(): Promise<Outcome> {
  if (!isEnabled()) return { kind: "disabled" }

  const binding = await resolveBinding()
  if (!binding) return { kind: "unbound" }
  const workspaceId = String(binding.datamateId)
  const client = mcp()

  // Rule 1 — reuse what already serves this session, but only if it can be shown
  // to serve THIS workspace, on an engine that still clears the floor.
  //
  // "Connected" is not that proof. An entry without `--datamate <id>` follows
  // its owner's active teammate, and that changes at runtime from a UI this
  // client does not control — the extension writes exactly such an entry. Reusing
  // one would let us report "workspace X: N tools" about a process serving Y,
  // and once precedence acts on that inventory it would route the model into
  // another workspace's credentials, with no fallback and nothing naming the
  // discrepancy. The floor is re-checked here for the same reason: a stale
  // persisted entry can be running an engine old enough that its pin is not
  // locked, which is the drift this attribution is meant to exclude.
  let replaced: string | undefined
  let replacedNote = ""
  /** Was the entry we are replacing still RUNNING? Then it must be closed before
   * we spawn, or `MCP.add` leaves its child process orphaned beside the new one —
   * the same duplicate-engine hazard this module refuses for a failing entry, and
   * in practice it wedges the session. */
  let replacedLive = false
  const before = await client.status()
  const existing = before[DATAMATE_KEY]
  if (existing) {
    const entry = await existingEntry(DATAMATE_KEY)
    let connected = existing.status === "connected"

    if (!connected) {
      if (isUrlEntry(entry)) {
        // Dead URL: nothing here can bring that process back — only the IDE can
        // restore its port. Fall through to a local spawn and report it below.
        replaced = entry.url
        replacedNote = ` Replaced the unreachable engine URL ${entry.url} for this session.`
        log.info("existing engine entry is a URL that is not reachable; will spawn locally", {
          workspaceId,
          url: entry.url,
          error: existing.error,
        })
      } else {
        // A command entry that failed: one retry, then report — never a second
        // spawn beside a failing one.
        await client.connect(DATAMATE_KEY).catch(() => undefined)
        const retried = (await client.status())[DATAMATE_KEY]
        connected = retried?.status === "connected"
        if (!connected) {
          const error = retried?.error ?? retried?.status ?? "not connected"
          await notify({
            title: "Workspace engine is not running",
            message: `The "${DATAMATE_KEY}" MCP entry for workspace "${binding.datamateName}" could not connect: ${error}. Integration tools are unavailable until it does.`,
            variant: "error",
          })
          return { kind: "connect-failed", error }
        }
      }
    }

    // Live — either it already was, or the single retry brought it back. A
    // recovered entry is gated exactly like one that never dropped.
    if (connected) {
      const pin = pinnedWorkspace(entry)
      if (pin !== workspaceId) {
        // Not attributable to this workspace. Replacing it costs the other
        // client nothing: a stdio entry is a per-client child process, so the
        // IDE keeps its own engine and only OUR registration changes. A
        // connected URL entry lands here too, which is the point — the hosted
        // endpoint serves a different tool set, and rule 4 forbids adopting it.
        replaced = describeEntry(entry)
        replacedLive = true
        replacedNote = pin
          ? ` Replaced an engine entry pinned to workspace ${pin} for this session.`
          : ` Replaced an engine entry that is not pinned to this workspace (${replaced}) for this session; it serves whichever workspace its owner has active.`
        log.info("existing engine entry is not attributable to this workspace; will spawn locally", {
          workspaceId,
          pinnedTo: pin,
          entry: replaced,
        })
      } else {
        const entryBin = commandArgv(entry)[0]
        const found = entryBin ? await versionOf(entryBin) : null
        if (found && compareVersions(found, MIN_ENGINE_VERSION) >= 0) {
          const available = engineToolKeys(await client.tools()).size
          log.info("reusing existing engine entry", { workspaceId, available, version: found })
          return { kind: "reused", available }
        }
        // Pinned to us, but below the floor or unreadable. Prefer a newer engine
        // on PATH over keeping one whose pin the engine does not lock; if PATH
        // cannot do better, say so rather than reuse it silently.
        const onPath = which(ENGINE_BINARY)
        const pathVersion = onPath ? await versionOf(onPath) : null
        if (!pathVersion || compareVersions(pathVersion, MIN_ENGINE_VERSION) < 0) {
          const label = found ?? "unknown"
          await notify({
            title: "Workspace engine is too old",
            message:
              `The engine serving workspace "${binding.datamateName}" reports ${label}; this client needs ` +
              `${MIN_ENGINE_VERSION} or newer. Update with: ${INSTALL_HINT}`,
            variant: "warning",
          })
          return { kind: "engine-too-old", found: label }
        }
        replaced = describeEntry(entry)
        replacedLive = true
        replacedNote = ` Replaced an engine entry running ${found ?? "an unreadable version"}, below the ${MIN_ENGINE_VERSION} floor, for this session.`
        log.info("existing engine entry is below the version floor; will spawn locally", {
          workspaceId,
          found,
          pathVersion,
        })
      }
    }
  }

  const declaredKeys = await declared(workspaceId)
  const declaredCount = declaredKeys?.keys.length ?? 0

  // Rule 2 / 3 — opportunistic use, or an offer. Never an install.
  const bin = which(ENGINE_BINARY)
  if (!bin) {
    await notify({
      title: "Workspace integrations unavailable",
      message:
        `Workspace "${binding.datamateName}" declares ${declaredCount} integration tool${declaredCount === 1 ? "" : "s"}. ` +
        `They run on the local engine, which is not installed. Install it with: ${INSTALL_HINT}`,
      variant: "warning",
    })
    return { kind: "engine-missing", declared: declaredCount }
  }

  const found = await versionOf(bin)
  if (!found || compareVersions(found, MIN_ENGINE_VERSION) < 0) {
    const label = found ?? "unknown"
    await notify({
      title: "Workspace engine is too old",
      message: `Found ${ENGINE_BINARY} ${label}; this client needs ${MIN_ENGINE_VERSION} or newer. Update with: ${INSTALL_HINT}`,
      variant: "warning",
    })
    return { kind: "engine-too-old", found: label }
  }

  // Spawn under the same server key the IDE uses, bound to THIS workspace.
  // `--datamate` is pinned engine-side so the settings watcher cannot swap it.
  const cfg: LocalMcpConfig = {
    type: "local",
    command: [ENGINE_BINARY, "start-stdio", "--datamate", workspaceId],
    enabled: true,
  }
  if (replacedLive) {
    // Close the live registration first: `MCP.add` does not close the client it
    // overwrites, so adding over a running stdio server starts a second engine
    // and abandons the first with its pipes still open.
    //
    // `remove`, NOT `disconnect`. `MCP.disconnect` persists `enabled: false` to
    // whichever config file actually holds the entry — which for an IDE-written
    // or user-global `datamate` is the GLOBAL config. Our replacement is written
    // project-locally, so disconnecting would leave the user's engine disabled in
    // every OTHER project. `remove` is runtime-only teardown: it closes the
    // client, drops it from state, and publishes ToolsChanged, touching no file.
    await client.remove(DATAMATE_KEY).catch((err) => {
      log.warn("could not close the engine entry being replaced", { err: String(err) })
    })
  }
  await persist(DATAMATE_KEY, cfg)
  await client.add(DATAMATE_KEY, cfg)

  // Rule 4 — a failed local engine is reported, never routed around.
  const after = (await client.status())[DATAMATE_KEY]
  if (after?.status !== "connected") {
    const error = after?.error ?? after?.status ?? "not connected"
    await notify({
      title: "Workspace engine failed to start",
      message: `Could not start ${ENGINE_BINARY} for workspace "${binding.datamateName}": ${error}. Integration tools are unavailable; not falling back to the hosted endpoint because it serves a different tool set.`,
      variant: "error",
    })
    return { kind: "connect-failed", error }
  }

  // Rule 5 — report declared-but-missing.
  const present = engineToolKeys(await client.tools())
  const missing = declaredKeys ? declaredKeys.keys.filter((k) => !present.has(k)) : []
  const available = present.size
  await notify({
    title: `Workspace "${binding.datamateName}" connected`,
    message:
      (declaredKeys
        ? `${available} of ${declaredCount} declared integration tools available.`
        : `${available} integration tools available.`) +
      describeMissing(missing) +
      replacedNote,
    variant: missing.length > 0 ? "warning" : "success",
  })
  log.info("attached workspace engine", { workspaceId, available, declared: declaredCount, missing, replaced })
  return { kind: "attached", available, declared: declaredCount, missing, ...(replaced ? { replaced } : {}) }
}

// ---------------------------------------------------------------------------
// Public entry — idempotent per session, never throws. `ensure` never blocks a
// turn; `whenAttached` is the one bounded wait, and only turn 1 pays it.
// ---------------------------------------------------------------------------

/** How long a turn may wait for a fresh attach before proceeding without it.
 *
 * A cold attach measured ~6.5s on a warm machine — ~1s to probe `--version`,
 * ~1s for the workspace's declared allowlist, and ~4.5s for the engine to boot,
 * handshake, and build its tools — and crossed 8s under the load of a real
 * turn. The cap is set well clear of that so the common case lands inside it,
 * and still far below MCP's own 30s connect timeout so an engine that never
 * answers costs the first turn a pause rather than the turn itself. */
export const ATTACH_WAIT_MS = 15_000

type SessionAttach = { key?: string; task: Promise<Outcome>; waitTimedOut?: boolean }

const sessions = new Map<string, SessionAttach>()

/** What a memoised attach is valid FOR.
 *
 * Memoising on the session id alone was wrong: the binding can change while a
 * session is open — `recordApprovedBinding` is reachable mid-session from the
 * TUI workspace panel as well as from `altimate-code link`. A session that
 * started unbound would then never attach, and one that was re-linked to another
 * workspace would keep serving the old workspace's tools, both silently and for
 * the rest of the session. Keying on the bound workspace makes a re-link produce
 * a fresh attach on the next turn and leaves everything else memoised as before. */
async function attachKey(): Promise<string> {
  if (!isEnabled()) return "disabled"
  const binding = await resolveBinding()
  return binding ? `workspace:${binding.datamateId}` : "unbound"
}

export function ensure(sessionID: string): Promise<Outcome> {
  // NOT async, and the entry is registered SYNCHRONOUSLY. `whenAttached` is
  // called on the line after this one and looks the session up by id; if the
  // registration happened after an await, that lookup would find nothing and the
  // turn would sail past without waiting — which is exactly the first-turn gap
  // this module exists to close. All the async work happens inside the task.
  const previous = sessions.get(sessionID)
  const entry = { key: previous?.key, waitTimedOut: previous?.waitTimedOut } as SessionAttach
  entry.task = (async (): Promise<Outcome> => {
    const key = await attachKey()
    // Same workspace as the attach we already did for this session: reuse it.
    if (previous && previous.key === key) return previous.task
    // First attach for this session, or the binding changed under it. A changed
    // binding gets a fresh attach AND a fresh wait budget: the previous budget
    // was spent on a different workspace's engine.
    entry.key = key
    entry.waitTimedOut = false
    return attachOnce(sessionID)
  })()
  sessions.set(sessionID, entry)
  return entry.task
}

/** One attach, with the outcome logged exactly once. */
function attachOnce(sessionID: string): Promise<Outcome> {
  return run()
    .catch((err): Outcome => {
      log.warn("workspace engine attach failed", { err: String(err) })
      return { kind: "connect-failed", error: String(err) }
    })
    .then((outcome) => {
      // One line per session, whatever happened — silence is the defect this
      // module exists to remove, so it must not be silent about itself.
      log.info("workspace engine outcome", { sessionID, ...outcome })
      return outcome
    })
}

/** Wait for a session's in-flight attach, capped.
 *
 * A turn resolves its tool list up front, before the per-turn block that starts
 * the attach runs. A session that spawns its own engine therefore listed the
 * engine's tools one turn late — the model saw `datamate_manager` alone on turn
 * 1 and the integration tools only from turn 2. The caller starts `ensure`
 * ahead of tool resolution and waits here to close that gap.
 *
 * Only a turn that actually spawns pays for it: `disabled` and `unbound` settle
 * with no I/O beyond a local cache read, and a reused entry settles as fast as
 * the status call it already makes. On timeout the turn proceeds without the
 * engine's tools and `tools/list_changed` delivers them when the attach lands. */
export async function whenAttached(sessionID: string, timeoutMs: number = ATTACH_WAIT_MS): Promise<void> {
  const state = sessions.get(sessionID)
  if (!state) return
  // A wait that already blew its budget must not be paid again: the caller's
  // block runs on every user turn, and a hung engine keeps this promise pending
  // for MCP's full connect timeout, so every later turn would pay the cap too.
  if (state.waitTimedOut) return
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  try {
    await Promise.race([
      state.task,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true
          resolve()
        }, timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (timedOut) {
      state.waitTimedOut = true
      log.info("workspace engine attach did not land in time for this turn", { sessionID, timeoutMs })
    }
  }
}

/** Test seam — drop memoised outcomes. */
export function resetForTests(): void {
  sessions.clear()
}
