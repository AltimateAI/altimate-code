// altimate_change - new file
//
// Ambient access and the single test seam. `syncInternals` stays ONE flat object
// on purpose: it is the override surface every other module reaches for, and
// splitting it per module would break every consumer that assigns to it.
import { Flag as CoreFlag } from "@opencode-ai/core/flag/flag"
import { Instance } from "@/project/instance"
import { Log } from "@/altimate/util/log"
import type { CachedBinding } from "./state"
import type { Declared, ExistingEntry, LocalMcpConfig, McpStatus, Toast } from "./engine-types"

export const log = Log.create({ service: "workspace-engine" })

/** Test seams. Production leaves every field unset. */
export const syncInternals: {
  resolveBinding?: () => Promise<CachedBinding | null>
  which?: (cmd: string) => string | null
  versionOf?: (bin: string) => Promise<string | null>
  mcp?: {
    status: () => Promise<McpStatus>
    add: (name: string, cfg: LocalMcpConfig) => Promise<unknown>
    remove: (name: string) => Promise<unknown>
    spawned?: (name: string) => Promise<ExistingEntry | undefined>
    tools: () => Promise<Record<string, unknown>>
  }
  persist?: (name: string, cfg: LocalMcpConfig) => Promise<void | "written" | "disabled">
  projectConfigPath?: () => Promise<string>
  persistRestore?: (
    name: string,
    previous: ExistingEntry | null,
    configPath?: string,
  ) => Promise<void | "restored" | "failed">
  projectEntry?: () => Promise<ExistingEntry | null>
  /** The configured (merged) MCP entry under `name`, or null if none. */
  existingEntry?: (name: string) => Promise<ExistingEntry | null>
  freshConfig?: () => Promise<{ mcp?: Record<string, ExistingEntry | undefined> }>
  toolsChanged?: () => Promise<void>
  declared?: (datamateId: string) => Promise<Declared | null>
  notify?: (toast: Toast) => Promise<void>
} = {}

export function isEnabled(): boolean {
  return CoreFlag.ALTIMATE_WORKSPACE
}

export function currentDirectory(): string | null {
  try {
    return Instance.directory
  } catch {
    return null
  }
}

export function projectRoot(): string {
  const wt = Instance.worktree
  return wt === "/" ? Instance.directory : wt
}
