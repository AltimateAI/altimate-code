// altimate_change - new file
//
// In a project linked to an Altimate workspace, the workspace's own engine is
// the only route to its integrations. The older route — `datamate_manager`
// connecting datamates as MCP servers of their own — is turned off there:
//
// - `hiddenToolIds()` keeps the tool out of the model's catalog
//   (`ToolRegistry.tools()` and `tool_lookup`), and the tool refuses with
//   `refusal()` when it is called anyway.
// - `engineNotice()` tells the model, in every engine state, that a request to
//   connect a datamate is about this link and that nothing here carries it out,
//   plus what the engine's state means (running, missing, too old, failed) — so
//   it points the user at the install offer instead of reaching for another route.
//
// "Linked" is `linkedWorkspaceLoaded()`: the binding as last read, whatever the
// engine's state (installed, missing, too old, or a probe that failed). Null for
// an unlinked project, an unreadable binding, workspaces disabled, `altimate
// serve`, and organisation-managed config that owns the `datamate` key.
import { linkedWorkspace, linkedWorkspaceLoaded, settledOutcome } from "./engine-overlay"
import { installCommand } from "./engine-offer"
import { log } from "./engine-seams"
import { ENGINE_BINARY, MIN_ENGINE_VERSION, TOOL_PREFIX, type Outcome } from "./engine-types"
import { workspaceLabel } from "./workspace-name"

export const DATAMATE_MANAGER_TOOL_ID = "datamate_manager"

const NONE: ReadonlySet<string> = new Set()
const LINKED: ReadonlySet<string> = new Set([DATAMATE_MANAGER_TOOL_ID])

/** Tool ids the model is not offered in the current instance's directory. A
 * failure to tell whether the project is linked keeps today's catalog: tool
 * resolution must not fail over it. */
export async function hiddenToolIds(): Promise<ReadonlySet<string>> {
  try {
    return (await linkedWorkspaceLoaded()) ? LINKED : NONE
  } catch (err) {
    log.warn("could not tell whether the project is linked; datamate_manager stays available", { err: String(err) })
    return NONE
  }
}

/** What `datamate_manager` answers in a linked project, whatever the operation.
 * Nothing is looked up or written before it. */
export function refusal(operation: string, workspace: { id: string; name: string }) {
  return {
    title: `Datamate ${operation}: off in a project linked to a workspace`,
    metadata: { operation, managedBy: workspace.id },
    output:
      `This project is linked to Altimate workspace ${workspaceLabel(workspace.name, workspace.id)}. Its ` +
      `integrations come only from the workspace's own engine, so datamate_manager is turned off here and ` +
      `nothing was changed. Use /workspace to see the workspace and its integrations. To manage datamates by ` +
      `hand, unlink the project, or restart with ALTIMATE_DISABLE_WORKSPACE=1.`,
  }
}

const HEADING = "## Workspace integration engine"

/** The system-prompt section for a session in a linked project, or "" when the
 * project is not linked or the session has not settled an outcome yet. Pure read
 * of this session's settled outcome, which the turn boundary records before the
 * system prompt is built.
 *
 * Said in every engine state, because the tool it replaces is gone in all of
 * them. Measured on the E2E rows: with the engine missing and only that said, a
 * model asked to "connect datamate 5" ran `datamate link 5` in the shell; with the
 * engine running and nothing said, it ran `altimate-code workspace link 5`. Users
 * say "datamate" where the prompt says "workspace", so the request itself is
 * named, and so is the fact that no command or tool here carries it out. */
export function engineNotice(sessionID: string): string {
  const outcome = settledOutcome(sessionID)
  if (!outcome || outcome.kind === "disabled" || outcome.kind === "unbound") return ""
  const workspace = linkedWorkspace()
  if (!workspace) return ""
  const intro =
    `This project is linked to Altimate workspace ${workspaceLabel(workspace.name, workspace.id)}, and its ` +
    `integrations reach this session only through the workspace's local integration engine. "Datamate" is the ` +
    `older name for a workspace: a request to connect, add or link a datamate is about this link. If it names ` +
    `this workspace there is nothing to do; if it names another, the user switches with /workspace → Switch ` +
    `workspace. No command or tool here does either, so do not attempt one.`
  return [HEADING, "", intro, "", engineState(outcome)].join("\n")
}

/** The notice for one turn: rendered once, from the outcome the turn's boundary
 * settled at its first catalog, and kept for every later step of that turn. The
 * overlay's session table is bounded, so re-reading it per step would drop the
 * notice for a session that other boundaries evicted mid-turn, while that turn
 * still runs on the tools its first catalog pinned. */
export function turnNotice(): { settle(sessionID: string): void; text(): string } {
  let rendered = ""
  return {
    settle(sessionID) {
      rendered = engineNotice(sessionID)
    },
    text: () => rendered,
  }
}

/** The second paragraph: what the engine's state means for the user's request. */
function engineState(outcome: Exclude<Outcome, { kind: "disabled" } | { kind: "unbound" }>): string {
  const fix =
    `Tell the user and point them to the install offer in this session, or to \`${installCommand()}\`; the ` +
    `tools attach on the next message after it finishes.`
  switch (outcome.kind) {
    case "attached":
      return `The engine is running: the workspace's integrations are its \`${TOOL_PREFIX}*\` tools in this catalog.`
    case "engine-missing":
      return `The engine is not installed on this machine, so none of the workspace's integration tools are available. ${fix}`
    case "engine-too-old":
      return outcome.found
        ? `The installed engine (\`${ENGINE_BINARY}\` ${outcome.found}) is older than this workspace needs ` +
            `(${MIN_ENGINE_VERSION} or newer), so none of the workspace's integration tools are available. ${fix}`
        : `The \`${ENGINE_BINARY}\` command on PATH did not run or report a version, so none of the workspace's ` +
            `integration tools are available. ${fix}`
    case "connect-failed":
      return (
        `The engine could not be started in this session, so none of the workspace's integration tools are ` +
        `available. Tell the user; /workspace → Status shows the state, and a new session tries again.`
      )
  }
}
