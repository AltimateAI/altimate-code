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
// task that ends on an error or without a final text answer (see tool/task.ts emptyTaskStatus)
export async function lastTaskText(sessionID: SessionID, parentID?: MessageID): Promise<string | undefined> {
  for await (const message of MessageV2.stream(sessionID)) {
    if (message.info.role === "user") break
    if (message.info.role !== "assistant") continue
    if (parentID && message.info.parentID !== parentID) continue
    const text = message.parts
      .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.ignored && !part.synthetic)
      .map((part) => part.text)
      .join("\n")
      .trim()
    if (text) return text
  }
}
// altimate_change end
