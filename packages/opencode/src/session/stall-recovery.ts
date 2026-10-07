import { Log } from "@/util/log"
import { MessageV2 } from "./message-v2"
import { Session } from "."
import type { MessageID, SessionID } from "./schema"

/**
 * Cleanup that makes it safe to re-issue a model request inside the same assistant message after the
 * previous attempt failed part-way (stalled, reset, or errored mid-stream).
 *
 * Rule: a retry may only replace what the failed attempt streamed, never what it already acted on.
 *  - text, reasoning and step-start parts written by the failed attempt are removed, and so are tool parts
 *    still `pending` (input was streaming, the tool never started). The retried request regenerates them.
 *  - if the failed attempt left any tool part that STARTED (running, completed or errored), the tool call was
 *    dispatched and may have had side effects. Re-requesting would make the model emit it again, so the attempt
 *    is NOT retried and nothing is removed: the error surfaces and the dispatched call keeps its record.
 */
export namespace StallRecovery {
  const log = Log.create({ service: "session.stall-recovery" })

  // A `tool` part reaching this set is necessarily still `pending` (started ones are rejected first).
  const DISCARDED_WHEN_RETRIED: ReadonlySet<MessageV2.Part["type"]> = new Set([
    "text",
    "reasoning",
    "step-start",
    "tool",
  ])

  export function partIDs(messageID: MessageID): Set<string> {
    return new Set(MessageV2.parts(messageID).map((part) => part.id))
  }

  export type Discard = { ok: true; removed: Set<string> } | { ok: false; dispatched: string[] }

  export async function discardAttempt(input: {
    sessionID: SessionID
    messageID: MessageID
    before: ReadonlySet<string>
  }): Promise<Discard> {
    const added = MessageV2.parts(input.messageID).filter((part) => !input.before.has(part.id))
    const dispatched = added.filter((part) => part.type === "tool" && part.state.status !== "pending")
    if (dispatched.length > 0) {
      return { ok: false, dispatched: dispatched.map((part) => (part.type === "tool" ? part.tool : part.type)) }
    }
    const removed = new Set<string>()
    for (const part of added) {
      if (!DISCARDED_WHEN_RETRIED.has(part.type)) continue
      await Session.removePart({ sessionID: input.sessionID, messageID: input.messageID, partID: part.id })
      removed.add(part.id)
    }
    if (removed.size > 0)
      log.info("discarded partial output before retry", { messageID: input.messageID, parts: removed.size })
    return { ok: true, removed }
  }
}
