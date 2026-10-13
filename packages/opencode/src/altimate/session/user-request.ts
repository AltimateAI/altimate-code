// altimate_change - new file
import type { MessageV2 } from "../../session/message-v2"

/**
 * The user request a message carries, or undefined when it carries none.
 *
 * This is the rule lesson retrieval set in the prompt loop: a user message is a request when it has a text part that
 * is neither synthetic nor ignored, or a file part. Auto-compaction can replay a user message under a fresh id. While
 * lessons are delivered for the session, the replay names the request it replays (`metadata.learnOriginalMessage` on
 * one of its text parts) and stays that request; otherwise it is a request of its own.
 *
 * The user messages the loop writes itself carry none: the summary after a subtask, the validator retry, the
 * compaction marker and the continue message after compaction.
 */
export function requestID(message: MessageV2.WithParts): string | undefined {
  if (message.info.role !== "user") return undefined
  const asked = message.parts.some(
    (part) => (part.type === "text" && !part.synthetic && !part.ignored) || part.type === "file",
  )
  if (!asked) return undefined
  const original = message.parts.find(
    (part): part is MessageV2.TextPart =>
      part.type === "text" && typeof part.metadata?.learnOriginalMessage === "string",
  )
  return String(original?.metadata?.learnOriginalMessage ?? message.info.id)
}
