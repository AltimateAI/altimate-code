// altimate_change - new file
//
// Ambient access and the single test seam. `syncInternals` stays ONE flat
// object on purpose: it is the override surface every consumer reaches for.
import { Flag as CoreFlag } from "@opencode-ai/core/flag/flag"
import { Instance } from "@/project/instance"
import { Log } from "@/altimate/util/log"
import type { CachedBinding } from "./state"
import type { Declared, LocalMcpConfig, McpStatus, Toast } from "./engine-types"

export const log = Log.create({ service: "workspace-engine" })

/** Test seams. Production leaves every field unset. */
export const syncInternals: {
  resolveBinding?: (directory: string) => Promise<CachedBinding | null>
  which?: (cmd: string) => string | null
  versionOf?: (bin: string) => Promise<string | null>
  declared?: (workspaceId: string) => Promise<Declared | null>
  notify?: (toast: Toast) => Promise<void>
  printLine?: (line: string) => void
  instanceDirectory?: () => string | null
  headless?: () => boolean
  serve?: () => boolean
  now?: () => number
  mcp?: {
    status: () => Promise<McpStatus>
    add: (name: string, cfg: LocalMcpConfig) => Promise<unknown>
    remove: (name: string) => Promise<unknown>
    tools: () => Promise<Record<string, unknown>>
  }
  config?: {
    invalidate: () => Promise<void>
    /** Loads config, which runs the overlay as a side effect. */
    get: () => Promise<void>
  }
} = {}

export function isEnabled(): boolean {
  return CoreFlag.ALTIMATE_WORKSPACE
}

/** Headless `run`: no TUI can render a toast, so refusals print one stderr
 * line. An env var because it must be readable from every module realm. */
export function isHeadless(): boolean {
  if (syncInternals.headless) return syncInternals.headless()
  return process.env["ALTIMATE_CODE_HEADLESS"] === "1"
}

/** `altimate serve` — the extension's host process. Workspace mode is
 * terminal-only: the extension runs its own engine and bridge under the same
 * key, and overriding it there would remove its extension-type tools. */
export function isServe(): boolean {
  if (syncInternals.serve) return syncInternals.serve()
  return process.env["ALTIMATE_CODE_SERVE"] === "1"
}

export function currentDirectory(): string | null {
  if (syncInternals.instanceDirectory) return syncInternals.instanceDirectory()
  try {
    return Instance.directory
  } catch {
    return null
  }
}
