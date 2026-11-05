import { MessageV2 } from "./message-v2"
import type { MessageID, SessionID } from "./schema"
// altimate_change start — run-mode task report without the completion token
import { stripCompletionToken } from "./termination"
// altimate_change end

export async function interruptedTaskOutput(sessionID: SessionID, parentID?: MessageID): Promise<string | undefined> {
  for await (const message of MessageV2.stream(sessionID)) {
    if (message.info.role === "user") break
    if (message.info.role !== "assistant") continue
    if (parentID && message.info.parentID !== parentID) continue
    const text = message.parts
      .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.ignored && !part.synthetic)
      .map((part) => part.text)
      .join("\n")
      .trim()
    if (!text) continue
    return [
      `task_id: ${sessionID} (for resuming to continue this task if needed)`,
      "",
      "<task_result>",
      "Task interrupted. These are partial findings from before cancellation:",
      text,
      "</task_result>",
    ].join("\n")
  }
}

// altimate_change start — run-mode task report without the completion token
/**
 * Run-mode task report: the child's final text without the completion token. When the
 * child's last reply is a bare token (the post-compaction nudge's acknowledgement), the
 * report is its most recent earlier non-summary assistant text in this prompt.
 */
export async function runModeTaskReport(sessionID: SessionID, text: string, promptID?: MessageID): Promise<string> {
  const stripped = stripCompletionToken(text)
  if (stripped.trim() || !text.trim()) return stripped
  for await (const message of MessageV2.stream(sessionID)) {
    if (promptID && message.info.id === promptID) break
    if (message.info.role !== "assistant" || message.info.summary) continue
    const report = stripCompletionToken(
      message.parts
        .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.ignored && !part.synthetic)
        .map((part) => part.text)
        .join("\n"),
    ).trim()
    if (report) return report
  }
  return stripped
}
// altimate_change end
