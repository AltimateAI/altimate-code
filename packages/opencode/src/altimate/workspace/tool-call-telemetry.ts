// altimate_change — tool_call rows for the bound workspace's integration calls.
import { Telemetry } from "@/altimate/telemetry"
import { DATAMATE_KEY } from "@/altimate/datamate-transport"
import { redact } from "@/altimate/debug/report"

/** True when the MCP client serving a tool is the engine the workspace overlay manages. */
export function isWorkspaceClient(clientName: string): boolean {
  return clientName === DATAMATE_KEY
}

/**
 * Track one MCP call that went through the bound workspace's engine. MCP tools never pass through
 * the `Tool.define` wrapper that tracks registry tools, so this is where a workspace integration
 * call becomes a `tool_call` row; a successful one also counts as an integration use for the
 * session. Only the managed engine client (`datamate`) in a session whose turn is bound counts:
 * a standalone `datamate-<name>` server, or the key in an unbound session, is not the workspace's.
 * Returns whether the call was tracked.
 */
export function trackWorkspaceToolCall(input: {
  key: string
  clientName: string
  sessionID: string
  messageID: string
  startedAt: number
  outcome: "success" | "error"
  error?: unknown
}): boolean {
  if (!isWorkspaceClient(input.clientName)) return false
  if (Telemetry.workspaceOf(input.sessionID) === undefined) return false
  try {
    if (input.outcome === "success") Telemetry.noteWorkspaceUse(input.sessionID, "integrations")
    const message = input.error instanceof Error ? input.error.message : String(input.error)
    Telemetry.track({
      type: "tool_call",
      timestamp: Date.now(),
      session_id: input.sessionID,
      message_id: input.messageID,
      tool_name: input.key,
      tool_type: "mcp",
      tool_category: Telemetry.categorizeToolName(input.key, "mcp"),
      status: input.outcome,
      via_workspace: true,
      duration_ms: Date.now() - input.startedAt,
      sequence_index: 0,
      previous_tool: null,
      ...(input.error !== undefined && { error: redact(Telemetry.maskString(message)).slice(0, 500) }),
    })
  } catch {
    // telemetry never surfaces into the tool call
  }
  return true
}
