// altimate_change - new file
//
// The three lines the boot box shows under "What is Altimate Code" when the
// CLI runs in workspace mode: which mode and workspace, which slash commands
// the mode adds, and what the last session got from the workspace. Pure, so
// the plugin that renders them stays a thin view.
import type { AttachSnapshot } from "./attach-snapshot"
import { sanitize } from "@/mcp/catalog"
import type { CachedBinding } from "./state"
import { statusHeadline } from "./status-view"

export interface WelcomeLines {
  /** "Workspace mode · linked to …" or the unlinked variant. */
  mode: string
  /** The slash commands workspace mode adds, with what each does. */
  commands: string
  /** What the last session got, or what will happen on the first message. */
  integrations: string
}

/** The commands workspace mode registers in the palette. Kept here rather
 * than read from the palette so the line is stable and testable; the plugin
 * that registers them is the same one that renders this. */
export const WORKSPACE_COMMANDS = "/workspace — status, refresh, sync, unlink · /skills — the workspace's skills"

export function welcomeLines(input: {
  binding: CachedBinding | null
  snapshot: AttachSnapshot | undefined
}): WelcomeLines {
  const { binding, snapshot } = input
  if (!binding) {
    return {
      mode: "Workspace mode · this project is not linked",
      commands: "altimate-code link — bind this project to a workspace, then the commands below apply",
      integrations: "Integrations: none until the project is linked",
    }
  }
  const current = snapshot && snapshot.workspace.id === String(binding.datamateId) ? snapshot : undefined
  if (!current) {
    return {
      mode: `Workspace mode · linked to ${binding.datamateName}`,
      commands: WORKSPACE_COMMANDS,
      integrations: "Integrations: attach on your first message",
    }
  }
  const present = new Set(current.present)
  const declared = current.declared?.keys.length
  // Never a key the engine reports unfulfilled: two raw keys can sanitise to one catalog name.
  const reported = new Set((current.unfulfilled ?? []).map((u) => u.key))
  const served = current.declared
    ? current.declared.keys.filter((k) => present.has(sanitize(k)) && !reported.has(k)).length
    : present.size
  const gaps = (current.unfulfilled ?? []).filter((u) => u.reason !== "no-bridge").length
  return {
    mode: `Workspace mode · linked to ${binding.datamateName}`,
    commands: WORKSPACE_COMMANDS,
    integrations: `Integrations: ${statusHeadline({ served, declared, gaps, extServed: current.extServed, rows: [] })}${gaps > 0 ? " — /workspace for the reasons" : ""}`,
  }
}
