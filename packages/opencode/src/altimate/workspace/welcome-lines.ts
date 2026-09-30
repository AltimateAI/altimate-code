// altimate_change - new file
//
// The three lines the boot box shows under "What is Altimate Code" when the
// CLI runs in workspace mode: which mode and workspace, which slash commands
// the mode adds, and what the last session got from the workspace. Pure, so
// the plugin that renders them stays a thin view.
import { describeAge, snapshotCounts, statusHeadline, type AttachSnapshot } from "./attach-snapshot"
import type { CachedBinding } from "./state"

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

/** `snapshot` is the bound workspace's, as `currentAttachSnapshot` returns it:
 * undefined when no session has attached to this workspace yet. It is always
 * a previous attach (the box renders before this session's first message), so
 * the line says so, with its age. */
export function welcomeLines(input: {
  binding: CachedBinding | null
  snapshot: AttachSnapshot | undefined
  now?: number
}): WelcomeLines {
  const { binding, snapshot } = input
  if (!binding) {
    return {
      mode: "Workspace mode · this project is not linked",
      commands: "altimate-code link — bind this project to a workspace, then the commands below apply",
      integrations: "Integrations: none until the project is linked",
    }
  }
  if (!snapshot) {
    return {
      mode: `Workspace mode · linked to ${binding.datamateName}`,
      commands: WORKSPACE_COMMANDS,
      integrations: "Integrations: attach on your first message",
    }
  }
  const counts = snapshotCounts(snapshot)
  return {
    mode: `Workspace mode · linked to ${binding.datamateName}`,
    commands: WORKSPACE_COMMANDS,
    integrations: `Integrations (last session, ${describeAge(snapshot.at, input.now)}): ${statusHeadline(counts)}${counts.gaps > 0 ? " — /workspace for the reasons" : ""}`,
  }
}
