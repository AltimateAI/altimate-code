import { Log } from "@/util/log"
import { MessageV2 } from "./message-v2"
import { Bus } from "@/bus"
import { Database, and, eq, inArray } from "@/storage/db"
import { PartTable } from "@opencode-ai/core/session/sql"
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
 *  - the same holds if the attempt already finished its step (a step-finish part exists): its cost and tokens
 *    are on the message, so a retry would count them twice and answer a second time.
 */
const log = Log.create({ service: "session.stall-recovery" })

// A `tool` part reaching this set is necessarily still `pending` (started ones are rejected first).
const DISCARDED_WHEN_RETRIED: ReadonlySet<MessageV2.Part["type"]> = new Set(["text", "reasoning", "step-start", "tool"])

export function partIDs(messageID: MessageID): Set<string> {
  return new Set(MessageV2.parts(messageID).map((part) => part.id))
}

export type Discard = { ok: true; removed: Set<string> } | { ok: false; dispatched: string[] }

export async function discardAttempt(input: {
  sessionID: SessionID
  messageID: MessageID
  before: ReadonlySet<string>
  /** A tool's execute() began during the attempt (tracked by the tool wrapper, not inferred from part status). */
  toolExecutionStarted?: boolean
}): Promise<Discard> {
  if (input.toolExecutionStarted) return { ok: false, dispatched: ["tool execution in flight"] }
  const added = MessageV2.parts(input.messageID).filter((part) => !input.before.has(part.id))
  const acted = added.filter(
    (part) => part.type === "step-finish" || (part.type === "tool" && part.state.status !== "pending"),
  )
  if (acted.length > 0) {
    return { ok: false, dispatched: acted.map((part) => (part.type === "tool" ? part.tool : part.type)) }
  }
  // One statement, so a failure leaves the attempt's output intact rather than half deleted.
  const stale = added.filter((part) => DISCARDED_WHEN_RETRIED.has(part.type))
  const removed = new Set<string>(stale.map((part) => part.id))
  if (stale.length > 0) {
    Database.use((db) => {
      db.delete(PartTable)
        .where(
          and(
            eq(PartTable.session_id, input.sessionID),
            inArray(
              PartTable.id,
              stale.map((part) => part.id),
            ),
          ),
        )
        .run()
      for (const part of stale)
        Database.effect(() =>
          Bus.publish(MessageV2.Event.PartRemoved, {
            sessionID: input.sessionID,
            messageID: input.messageID,
            partID: part.id,
          }),
        )
    })
  }
  if (removed.size > 0)
    log.info("discarded partial output before retry", { messageID: input.messageID, parts: removed.size })
  return { ok: true, removed }
}

export * as StallRecovery from "./stall-recovery"
