// altimate_change - new file
//
// Everything that asks the outside world a question: the binary, its
// version, the workspace allowlist, and the user-facing surfaces.
import launch from "cross-spawn"
import { which as whichBinary } from "@opencode-ai/core/util/which"
import { AltimateApi } from "@/altimate/api/client"
import { AppRuntime } from "@/effect/app-runtime"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TuiEvent } from "@/server/tui-event"
import { readLocalBinding, type CachedBinding } from "./state"
import { log, syncInternals } from "./engine-seams"
import type { Declared, Toast } from "./engine-types"

/** How long the allowlist lookup may hold a turn. Once per workspace per process. */
export const DECLARED_TIMEOUT_MS = 4_000

export async function resolveBinding(directory: string): Promise<CachedBinding | null> {
  if (syncInternals.resolveBinding) return syncInternals.resolveBinding(directory)
  try {
    return await readLocalBinding(directory)
  } catch (err) {
    log.warn("could not resolve the workspace binding", { err: String(err) })
    return null
  }
}

export function which(cmd: string): string | null {
  return syncInternals.which ? syncInternals.which(cmd) : whichBinary(cmd)
}

/** `datamate --version`, stdout only. The engine prints its real package
 * version here; its MCP `serverInfo` was a hard-coded placeholder on the very
 * engines the floor excludes, so the handshake cannot be asked instead.
 *
 * cross-spawn, not execFile: an npm-installed engine on Windows resolves to a
 * `.cmd` shim that Node cannot execute without a shell. */
export function versionOf(bin: string): Promise<string | null> {
  if (syncInternals.versionOf) return syncInternals.versionOf(bin)
  return new Promise((resolve) => {
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

/** The workspace allowlist, split by whether the CLI can serve it. */
export async function declared(workspaceId: string): Promise<Declared | null> {
  if (syncInternals.declared) return syncInternals.declared(workspaceId)
  try {
    if (!(await AltimateApi.isConfigured())) return null
    const [workspace, catalog] = await Promise.all([
      AltimateApi.getDatamate(workspaceId),
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
    log.warn("could not read the declared workspace integrations", { workspaceId, err: String(err) })
    return null
  }
}

/** The allowlist, bounded. Reporting only; the losing timer is cancelled so a
 * lookup that succeeded in time is not later reported as timed out. */
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
    log.warn("could not show the workspace engine toast", { err: String(err) })
  }
}

/** stderr, deliberately: `run --format json` documents stdout as raw JSON
 * events, and this is a status notice, not run output. */
export function printLine(line: string): void {
  if (syncInternals.printLine) return syncInternals.printLine(line)
  try {
    process.stderr.write(line + "\n")
  } catch {
    // A closed stream must not take down the turn.
  }
}
