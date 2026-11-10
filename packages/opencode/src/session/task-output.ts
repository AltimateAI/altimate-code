import { MessageV2 } from "./message-v2"
import type { MessageID, SessionID } from "./schema"

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

// altimate_change start — the newest model-written text of a child task's current prompt, for a
// task that ends on an error or without a final text answer (see tool/task.ts emptyTaskStatus).
// The prompt's own user message is the boundary: a compaction marker, its summary and the
// continuation turns it creates all come after it and belong to the same prompt. When that user
// message is not found, nothing is returned, so text from an earlier prompt is never used.
export async function lastTaskText(sessionID: SessionID, promptID: MessageID): Promise<string | undefined> {
  let latest: string | undefined
  for await (const message of MessageV2.stream(sessionID)) {
    if (message.info.id === promptID) return latest
    if (latest !== undefined || message.info.role !== "assistant" || message.info.summary) continue
    const text = message.parts
      .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.ignored && !part.synthetic)
      .map((part) => part.text)
      .join("\n")
      .trim()
    if (text) latest = text
  }
}
// altimate_change end
