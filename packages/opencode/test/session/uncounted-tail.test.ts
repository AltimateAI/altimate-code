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
    id: "m", providerID: "p",
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
    const msgs = [msg("u", "user", "task"), assistantWithTool("a", "working", giant)]
    const estimate = SessionPrompt.estimateUncountedTail(msgs, "a" as any)
    expect(estimate).toBeGreaterThan(0)
    expect(estimate).toBe(Token.estimate(giant))
  })

  test("does not double-count the last finished message's own text", () => {
    // its text is already inside the provider-reported tokens.output
    const msgs = [msg("u", "user", "task"), assistantWithTool("a", "some assistant prose here", "")]
    expect(SessionPrompt.estimateUncountedTail(msgs, "a" as any)).toBe(0)
  })

  test("still counts everything after the last finished message", () => {
    const later = "y".repeat(9_000)
    const msgs = [msg("u", "user", "task"), assistantWithTool("a", "working", ""), msg("u2", "user", later)]
    expect(SessionPrompt.estimateUncountedTail(msgs, "a" as any)).toBe(Token.estimate(later))
  })

  test("returns 0 for an unknown or absent id", () => {
    const msgs = [msg("u", "user", "task")]
    expect(SessionPrompt.estimateUncountedTail(msgs, undefined)).toBe(0)
    expect(SessionPrompt.estimateUncountedTail(msgs, "nope" as any)).toBe(0)
  })
})
// altimate_change end
