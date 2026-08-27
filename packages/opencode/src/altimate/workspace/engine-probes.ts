// altimate_change - new file
//
// Everything that asks the outside world a question: the binary, its version,
// MCP, the workspace allowlist, and the user-facing toast. Moved verbatim — the
// state machine buys nothing here, and every touched line is new-bug surface.
import launch from "cross-spawn"
import { which as whichBinary } from "@opencode-ai/core/util/which"
import { MCP, ToolsChanged } from "@/mcp"
import { AltimateApi } from "@/altimate/api/client"
import { DATAMATE_KEY } from "@/altimate/datamate-transport"
import { AppRuntime } from "@/effect/app-runtime"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TuiEvent } from "@/server/tui-event"
import { readLocalBinding, type CachedBinding } from "./state"
import { log, syncInternals, currentDirectory } from "./engine-seams"
import {
  commandArgv,
  engineToolKeys,
  type Declared,
  type ExistingEntry,
  type LocalMcpConfig,
  type McpStatus,
  type Toast,
} from "./engine-types"

/** How long the optional allowlist lookup may delay a local spawn. */
export const DECLARED_TIMEOUT_MS = 4_000

export async function resolveBinding(): Promise<CachedBinding | null> {
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

export function which(cmd: string): string | null {
  return syncInternals.which ? syncInternals.which(cmd) : whichBinary(cmd)
}

/** `datamate --version` — the engine inlines its real package version here,
 * unlike its MCP `serverInfo`, which is a hard-coded placeholder. A version
 * string proves output, not identity; it is a compatibility floor only. */
export function versionOf(bin: string): Promise<string | null> {
  if (syncInternals.versionOf) return syncInternals.versionOf(bin)
  return new Promise((resolve) => {
    // cross-spawn, not execFile. An npm-installed engine on Windows is resolved
    // by `which` to a `.cmd` shim (it honours PATHEXT), and Node cannot execute
    // `.cmd` or `.bat` directly without a shell — the callback just errors. That
    // would report "not runnable" to every bound Windows user with an ordinary
    // global install, while MCP's own launcher started the same engine fine.
    // This is the launcher the rest of the repo already uses for that reason.
    let settled = false
    const done = (value: string | null) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      const child = launch(bin, ["--version"], { stdio: ["ignore", "pipe", "ignore"], timeout: 5000 })
      let out = ""
      child.stdout?.on("data", (chunk) => {
        out += String(chunk)
      })
      child.on("error", () => done(null))
      child.on("close", (code) => {
        if (code !== 0) return done(null)
        const line = out.trim().split(/\r?\n/)[0] ?? ""
        done(line || null)
      })
    } catch {
      done(null)
    }
  })
}

export function mcp() {
  return (
    syncInternals.mcp ?? {
      status: () => MCP.status() as Promise<McpStatus>,
      add: (name: string, cfg: LocalMcpConfig) => MCP.add(name, cfg),
      connect: (name: string) => MCP.connect(name),
      remove: (name: string) => MCP.remove(name),
      spawned: (name: string) => MCP.spawned(name) as Promise<ExistingEntry | undefined>,
      tools: () => MCP.tools() as Promise<Record<string, unknown>>,
    }
  )
}

export async function declared(datamateId: string): Promise<Declared | null> {
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

/** Tell the session its tool list changed.
 *
 * `MCP.add` stores the client but publishes nothing, so nothing downstream could
 * even observe a late attach. This restores that signal.
 *
 * What it does NOT do, stated plainly because this module claimed otherwise for
 * several revisions: it does not give tools to the invocation already running.
 * That turn's tool set was passed to the model before the attach finished and
 * cannot be rebuilt mid-call — the session's subscriber only logs, and the next
 * `resolveTools` is what picks the tools up. So exceeding the bounded wait costs
 * a turn, not a session. The event is worth publishing for traceability and for
 * any subscriber that can act between turns; it is not a live refresh. */
export async function announceToolsChanged(): Promise<void> {
  if (syncInternals.toolsChanged) return syncInternals.toolsChanged()
  try {
    await AppRuntime.runPromise(
      EventV2Bridge.Service.use((events) => events.publish(ToolsChanged, { server: DATAMATE_KEY })),
    )
  } catch (err) {
    log.warn("could not announce the workspace engine tool change", { err: String(err) })
  }
}

/** The workspace allowlist, bounded.
 *
 * Reporting only — the attach must never wait on it. The bound was previously
 * applied to the spawn path alone, leaving a reused engine awaiting it with no
 * limit. Both paths go through here now, so there is one answer rather than two.
 *
 * The underlying request is separately abortable (the API client attaches a
 * signal), so a stalled server releases its socket instead of accumulating
 * pending fetches across repair retries. */
export async function declaredBounded(workspaceId: string): Promise<Declared | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      declared(workspaceId),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          log.warn("workspace allowlist lookup timed out; continuing without the declared-vs-delivered report", {
            workspaceId,
            timeoutMs: DECLARED_TIMEOUT_MS,
          })
          resolve(null)
        }, DECLARED_TIMEOUT_MS)
        timer.unref?.()
      }),
    ])
  } finally {
    // Racing does not cancel the loser: left running, the timer fires later and
    // warns about a lookup that had already succeeded, on every normal attach.
    if (timer) clearTimeout(timer)
  }
}

export async function notify(toast: Toast): Promise<void> {
  if (syncInternals.notify) return syncInternals.notify(toast)
  try {
    await AppRuntime.runPromise(
      EventV2Bridge.Service.use((events) => events.publish(TuiEvent.ToastShow, { ...toast, duration: 10000 })),
    )
  } catch (err) {
    log.warn("could not show workspace engine toast", { err: String(err) })
  }
}

/** The version of the ENGINE an entry runs, not of whatever wraps it.
 *
 * `npx @altimateai/datamate@0.6.3 start-stdio --datamate 42` would otherwise
 * have us run `npx --version` and let a pre-floor engine clear the floor on the
 * wrapper's version. Asking the running server instead is not an option:
 * `serverInfo.version` is a hard-coded placeholder on the very engines this
 * floor excludes. An unidentifiable command yields null, which `clearsFloor`
 * treats as below the floor. */
export async function engineVersionOf(entry: ExistingEntry | null): Promise<string | null> {
  const bin = commandArgv(entry)[0]
  const direct = bin && /(^|[\\/])datamate(\.[a-z]+)?$/i.test(bin) ? bin : null
  return direct ? await versionOf(direct) : null
}
