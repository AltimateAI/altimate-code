export * as ToolAborted from "./aborted"

import { ClaudeAgentID } from "../id"

// Upstream's session `context` hook flags a stopped tool in the result's provider metadata, so
// `ToolResult.collect` interrupts the waiting Claude turn instead of handing it the cancelled result.
// The shipped history conversion sends a tool part's call metadata as the result's provider options,
// so stopped Claude Agent calls carry the same flag there. Other providers' metadata is left as is.
export function mark<T extends Record<string, any> | undefined>(metadata: T): T {
  const own = metadata?.[ClaudeAgentID.ID]
  if (!own || typeof own !== "object") return metadata
  return { ...metadata, [ClaudeAgentID.ID]: { ...own, toolAborted: true } } as T
}
