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
//  1. Reuse. A connected MCP server already registered under DATAMATE_KEY wins —
//     that is an IDE-written or previously persisted entry, and attaching to it
//     is free. If that entry is DOWN, what it is decides what happens next:
//       - a URL entry is an IDE's in-process engine (normally localhost) or the
//         hosted endpoint. Neither can be revived from here — only the IDE can
//         bring its port back — so with a binding and a usable engine on PATH we
//         spawn locally and say what was replaced. The IDE's own config file is
//         never touched; when the IDE returns, its sync overwrites ours.
//       - a command entry that failed is retried once, then reported. Spawning a
//         second engine beside a failing one is the duplicate-process problem the
//         single-gateway design exists to avoid.
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

/** Oldest engine this client is known to work against. */
export const MIN_ENGINE_VERSION = "0.6.3"
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

export type ExistingEntry = { type?: string; url?: string; command?: string[] }

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

/** Numeric semver compare on the `major.minor.patch` core; pre-release tags
 * are ignored. Returns <0, 0, >0. Non-numeric input compares as older. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/, "")
      .split("-")[0]
      .split(".")
      .map((n) => Number.parseInt(n, 10))
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : -1
    const y = Number.isFinite(pb[i]) ? pb[i] : -1
    if (x !== y) return x - y
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

  // Rule 1 — reuse whatever already serves this session.
  let replaced: string | undefined
  const before = await client.status()
  const existing = before[DATAMATE_KEY]
  if (existing) {
    let connected = existing.status === "connected"
    if (!connected) {
      const entry = await existingEntry(DATAMATE_KEY)
      if (isUrlEntry(entry)) {
        // Dead URL: nothing here can bring that process back. Fall through to a
        // local spawn (if one is possible) and report the replacement below.
        replaced = entry.url
        log.info("existing engine entry is a URL that is not reachable; will spawn locally", {
          workspaceId,
          url: entry.url,
          error: existing.error,
        })
      } else {
        // A command entry that failed: one retry, then report — never a second spawn.
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
    if (connected) {
      const available = engineToolKeys(await client.tools()).size
      log.info("reusing existing engine entry", { workspaceId, available })
      return { kind: "reused", available }
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
  const replacedNote = replaced ? ` Replaced the unreachable engine URL ${replaced} for this session.` : ""
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

type SessionAttach = { task: Promise<Outcome>; waitTimedOut?: boolean }

const sessions = new Map<string, SessionAttach>()

export async function ensure(sessionID: string): Promise<Outcome> {
  const existing = sessions.get(sessionID)
  if (existing) return existing.task
  const task = run()
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
  sessions.set(sessionID, { task })
  return task
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
