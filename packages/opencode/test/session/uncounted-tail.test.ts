import { describe, expect, test } from "bun:test"

import { SessionCompaction } from "../../src/session/compaction"
import { SessionPrompt } from "../../src/session/prompt"
import { Token } from "@/util/token"
import type { MessageV2 } from "../../src/session/message-v2"
import type { Provider } from "../../src/provider/provider"

// The proactive overflow path adds Token.estimate of parts appended after the
// last assistant usage reading. These tests pin the fitHead turn-boundary
// behavior that backs it (full prompt-loop testing lives in integration).

function msg(id: string, role: "user" | "assistant", text: string): MessageV2.WithParts {
  return {
    info: { id, sessionID: "s", role, time: { created: 1 }, model: { providerID: "p", modelID: "m" } },
    parts: [{ id: `${id}-p`, sessionID: "s", messageID: id, type: "text", text }],
  } as unknown as MessageV2.WithParts
}

function model(context: number): Provider.Model {
  return {
    id: "m",
    providerID: "p",
    api: { npm: "@ai-sdk/openai-compatible" },
    limit: { context, output: 4096 },
  } as unknown as Provider.Model
}

describe("fitHead turn boundaries", () => {
  test("truncation lands on a user message, never mid-turn", async () => {
    const head: MessageV2.WithParts[] = []
    for (let i = 0; i < 24; i++) {
      head.push(msg(`u${i}`, "user", "q".repeat(8_000)))
      head.push(msg(`a${i}`, "assistant", "r".repeat(8_000)))
    }
    const result = await SessionCompaction.fitHead({ head, model: model(16384) })
    expect(result.dropped).toBeGreaterThan(0)
    expect(result.head[0]!.info.role).toBe("user")
  })

  test("no truncation when the head already fits", async () => {
    const head = [msg("u", "user", "small"), msg("a", "assistant", "tiny")]
    const result = await SessionCompaction.fitHead({ head, model: model(131072) })
    expect(result.dropped).toBe(0)
  })
})

// altimate_change start — PR #1171 review (cubic P1): the estimate skipped tool
// results attached to the LAST FINISHED assistant message itself. Those land on
// that message after its usage was reported, so they were invisible to both the
// provider figure and the tail estimate — precisely the single oversized result
// this proactive check exists to catch. The computation was an inline IIFE with
// no coverage; it is now exported and pinned here.
function assistantWithTool(id: string, text: string, output: string): MessageV2.WithParts {
  return {
    info: { id, sessionID: "s", role: "assistant", time: { created: 1 }, model: { providerID: "p", modelID: "m" } },
    parts: [
      { id: `${id}-t`, sessionID: "s", messageID: id, type: "text", text },
      {
        id: `${id}-tool`,
        sessionID: "s",
        messageID: id,
        type: "tool",
        tool: "bash",
        callID: `${id}-call`,
        state: { status: "completed", input: {}, output, title: "t", metadata: {}, time: { start: 1, end: 2 } },
      },
    ],
  } as unknown as MessageV2.WithParts
}

describe("SessionPrompt.estimateUncountedTail", () => {
  test("counts a tool result attached to the last finished message itself", () => {
    const giant = "x".repeat(40_000)
    const msgs = [msg("m1", "user", "task"), assistantWithTool("m2", "working", giant)]
    const estimate = SessionPrompt.estimateUncountedTail(msgs, "m2" as any)
    expect(estimate).toBeGreaterThan(0)
    expect(estimate).toBe(Token.estimate(giant))
  })

  test("does not double-count the last finished message's own text", () => {
    // its text is already inside the provider-reported tokens.output
    const msgs = [msg("m1", "user", "task"), assistantWithTool("m2", "some assistant prose here", "")]
    expect(SessionPrompt.estimateUncountedTail(msgs, "m2" as any)).toBe(0)
  })

  test("still counts everything after the last finished message", () => {
    const later = "y".repeat(9_000)
    const msgs = [msg("m1", "user", "task"), assistantWithTool("m2", "working", ""), msg("m3", "user", later)]
    expect(SessionPrompt.estimateUncountedTail(msgs, "m2" as any)).toBe(Token.estimate(later))
  })

  test("selects newer messages by monotonic ID when compacted rendering reorders the array", () => {
    const newer = "n".repeat(9_000)
    const older = "o".repeat(4_000)
    const finished = assistantWithTool("m2", "working", "")
    // filterCompacted may render retained newer content before the summary and
    // older content after it. Array slicing would miss `m3` and count `m1`.
    const reordered = [msg("m3", "user", newer), finished, msg("m1", "user", older)]
    expect(SessionPrompt.estimateUncountedTail(reordered, "m2" as any)).toBe(Token.estimate(newer))
  })

  test("counts failed and interrupted tool output exactly as replayed", () => {
    const failed = assistantWithTool("m2", "working", "")
    ;(failed.parts[1] as any).state = {
      status: "error",
      input: {},
      error: "validation failed with details",
      time: { start: 1, end: 2 },
    }
    expect(SessionPrompt.estimateUncountedTail([failed], "m2" as any)).toBe(
      Token.estimate("validation failed with details"),
    )
    ;(failed.parts[1] as any).state.metadata = { interrupted: true, output: "partial output preserved" }
    expect(SessionPrompt.estimateUncountedTail([failed], "m2" as any)).toBe(Token.estimate("partial output preserved"))
  })

  test("returns 0 for an unknown or absent id", () => {
    const msgs = [msg("u", "user", "task")]
    expect(SessionPrompt.estimateUncountedTail(msgs, undefined)).toBe(0)
    expect(SessionPrompt.estimateUncountedTail(msgs, "nope" as any)).toBe(0)
  })
})
// altimate_change end
