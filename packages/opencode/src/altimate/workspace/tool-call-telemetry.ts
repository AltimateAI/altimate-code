// altimate_change — tool_call rows for the bound workspace's integration calls.
import { Telemetry } from "@/altimate/telemetry"
import { DATAMATE_KEY } from "@/altimate/datamate-transport"
import os from "os"
import { redact, type RedactContext } from "@/altimate/debug/report"

let redactCtx: RedactContext | undefined
/** The home folder, user name and host name to strip from error text; gathered once, never throws. */
function redactContext(): RedactContext {
  if (redactCtx) return redactCtx
  const tryGet = (f: () => string) => {
    try {
      return f()
    } catch {
      return undefined
    }
  }
  redactCtx = {
    home: tryGet(() => os.homedir()),
    username: tryGet(() => os.userInfo().username) ?? process.env["USER"] ?? process.env["USERNAME"],
    hostname: tryGet(() => os.hostname()),
  }
  return redactCtx
}

/** True when the MCP client serving a tool is the engine the workspace overlay manages. */
export function isWorkspaceClient(clientName: string): boolean {
  return clientName === DATAMATE_KEY
}

/**
 * Track one MCP call that went through the bound workspace's engine. MCP tools never pass through
 * the `Tool.define` wrapper that tracks registry tools, so this is where a workspace integration
 * call becomes a `tool_call` row; a successful one also counts as an integration use for the
 * session. Only the managed engine client (`datamate`) in a bound turn counts: a standalone
 * `datamate-<name>` server, or the key in an unbound turn, is not the workspace's. The turn's own
 * workspace is passed in and named on the row, so a call that finishes after the turn was
 * cancelled and replaced keeps the workspace it ran for. Returns whether the call was tracked.
 */
export function trackWorkspaceToolCall(input: {
  key: string
  clientName: string
  sessionID: string
  messageID: string
  /** The workspace the calling turn resolved; undefined for an unbound turn. */
  workspaceId: number | undefined
  /** The calling turn (from `setContext`); a success landing after it was replaced is not counted. */
  turn?: number
  startedAt: number
  outcome: "success" | "error"
  error?: unknown
}): boolean {
  if (!isWorkspaceClient(input.clientName)) return false
  if (input.workspaceId === undefined) return false
  try {
    if (input.outcome === "success") Telemetry.noteWorkspaceUse(input.sessionID, "integrations", 1, "add", input.turn)
    const error =
      input.error === undefined
        ? undefined
        : redact(
            Telemetry.maskString(input.error instanceof Error ? input.error.message : String(input.error)),
            redactContext(),
          ).slice(0, 500)
    Telemetry.track({
      type: "tool_call",
      timestamp: Date.now(),
      session_id: input.sessionID,
      message_id: input.messageID,
      tool_name: input.key,
      workspace_id: input.workspaceId,
      tool_type: "mcp",
      tool_category: Telemetry.categorizeToolName(input.key, "mcp"),
      status: input.outcome,
      via_workspace: true,
      duration_ms: Date.now() - input.startedAt,
      sequence_index: 0,
      previous_tool: null,
      ...(error !== undefined && { error }),
    })
  } catch {
    // telemetry never surfaces into the tool call
    return false
  }
  return true
}
