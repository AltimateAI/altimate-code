// altimate_change — tool_call rows for the bound workspace's integration calls.
import { Telemetry } from "@/altimate/telemetry"
import { mcpToolSource } from "@/altimate/tool-source"

/** True when the MCP client serving a tool is the bound workspace's datamate server. */
export function isWorkspaceClient(clientName: string): boolean {
  return mcpToolSource(clientName) === "altimate"
}

/**
 * Track one MCP call that went through the bound workspace. MCP tools never pass through the
 * `Tool.define` wrapper that tracks registry tools, so this is where a workspace integration
 * call becomes a `tool_call` row; a successful one also counts as an integration use for the
 * session. Third-party MCP servers stay untracked and registry tools (`datamate_manager`
 * included) never reach here. Returns whether the call was tracked.
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
      ...(input.error !== undefined && { error: Telemetry.maskString(message).slice(0, 500) }),
    })
  } catch {
    // telemetry never surfaces into the tool call
  }
  return true
}
