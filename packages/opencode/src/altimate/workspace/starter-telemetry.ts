// altimate_change - new file
//
// `starter_action_picked`: what the user chose from the workspace starter in the TUI. Kept apart from
// `starter.ts`, which the TUI imports for its type only: building a starter loads the skill module and
// the workspace service client, which the TUI's thread does not otherwise load.
import { Telemetry } from "@/altimate/telemetry"
import type { Starter } from "./starter"

export type StarterAction = "prompt" | "open" | "done"

export interface StarterPick {
  action: StarterAction
  /** Which suggested prompt, 0-based; only for `prompt`. */
  promptIndex?: number
}

/** A starter dialog option's value (`prompt:<i>`, `open`, `done`) as the action it picks; null for any
 * other value. Pure. */
export function starterPick(value: string): StarterPick | null {
  if (value === "open" || value === "done") return { action: value }
  const match = /^prompt:(\d+)$/.exec(value)
  if (!match) return null
  const index = Number(match[1])
  return Number.isSafeInteger(index) ? { action: "prompt", promptIndex: index } : null
}

/** The row for a pick: the action, the prompt's index for a prompt, and the workspace. Never the prompt's text. */
export function starterActionPickedEvent(workspaceId: number, pick: StarterPick, sessionID?: string): Telemetry.Event {
  return {
    type: "starter_action_picked",
    timestamp: Date.now(),
    session_id: sessionID ?? Telemetry.getContext().sessionId,
    workspace_id: workspaceId,
    action: pick.action,
    ...(pick.action === "prompt" && pick.promptIndex !== undefined ? { prompt_index: pick.promptIndex } : {}),
  }
}

/** Track one selection from a starter dialog. `starter` is what the dialog shows; null while it has not
 * arrived, when the dialog is the bare link confirmation and a selection is no starter outcome. The row names
 * the starter's own workspace, the one its `starter_shown` row named. Nothing for a value that is not a
 * starter action or a workspace id that is not a positive integer. Never throws. */
export function trackStarterActionPicked(starter: Pick<Starter, "workspaceId"> | null, value: string): boolean {
  try {
    const workspaceId = starter?.workspaceId
    const pick = starterPick(value)
    if (!pick || workspaceId === undefined || !Number.isInteger(workspaceId) || workspaceId <= 0) return false
    Telemetry.track(starterActionPickedEvent(workspaceId, pick))
    return true
  } catch {
    return false
  }
}
