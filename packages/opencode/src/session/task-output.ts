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
