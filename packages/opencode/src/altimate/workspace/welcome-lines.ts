// altimate_change - new file
//
// The three lines the boot box shows under "What is Altimate Code" when the
// CLI runs in workspace mode: which mode and workspace, which slash commands
// the mode adds, and what the last session got from the workspace. Pure, so
// the plugin that renders them stays a thin view.
import { describeAge, snapshotCounts, statusHeadline, type AttachSnapshot } from "./attach-snapshot"
import type { BindingOutcome, CachedBinding } from "./state"
import { displayWorkspaceName } from "./workspace-name"

export interface WelcomeLines {
  /** "Workspace mode · linked to …" or the unlinked variant. */
  mode: string
  /** The slash commands workspace mode adds, with what each does. */
  commands: string
  /** What the last session got, or what will happen on the first message. */
  integrations: string
}

/** The widest each line can get, in terminal columns. The boot box reserves rows for these lines by a
 * fixed count (`WELCOME_EXTRA_MAX_ROWS` in the tui package's welcome-panel-utils): at
 * the narrowest medium panel, 54 columns of text and about 45 after word-wrap slack,
 * these are 2, 2 and 4 rows, plus a spacer. The workspace name is what would
 * otherwise have no bound, so the mode line shortens it. */
export const WELCOME_LINE_MAX_CHARS = { mode: 70, commands: 90, integrations: 180 } as const
const MODE_NAME_COLUMNS = 40

/** The name shortened to at most 40 terminal columns: counted by display width,
 * since a CJK character or an emoji takes two columns. Bidi controls are
 * stripped, so a name cannot reorder the text around it. */
function modeName(name: string): string {
  const clean = displayWorkspaceName(name)
  if (!clean) return "(unnamed)"
  if (Bun.stringWidth(clean) <= MODE_NAME_COLUMNS) return clean
  let out = ""
  for (const point of clean) {
    if (Bun.stringWidth(out + point) > MODE_NAME_COLUMNS - 1) break
    out += point
  }
  return out + "…"
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
      mode: `Workspace mode · linked to ${modeName(binding.datamateName)}`,
      commands: WORKSPACE_COMMANDS,
      integrations: "Integrations: attach on your first message",
    }
  }
  const counts = snapshotCounts(snapshot)
  return {
    mode: `Workspace mode · linked to ${modeName(binding.datamateName)}`,
    commands: WORKSPACE_COMMANDS,
    integrations: `Integrations (last session, ${describeAge(snapshot.at, input.now)}): ${statusHeadline(counts)}${counts.gaps > 0 ? " — /workspace for the reasons" : ""}`,
  }
}

/** The lines for a resolved binding, or null to leave the box as it is. A
 * resolve that could not reach the server answers `unknown`, which must not
 * read as "not linked": that is the one state that tells the user to run a
 * command, and a cold cache or a network blip is no reason to. */
export function welcomeLinesFor(
  outcome: BindingOutcome,
  snapshot: AttachSnapshot | undefined,
  now?: number,
): WelcomeLines | null {
  if (outcome.status === "unknown") return null
  return welcomeLines({ binding: outcome.status === "bound" ? outcome.binding : null, snapshot, now })
}
