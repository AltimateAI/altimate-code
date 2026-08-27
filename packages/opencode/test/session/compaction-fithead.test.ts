import { describe, expect, test } from "bun:test"

import { SessionCompaction } from "../../src/session/compaction"
import type { MessageV2 } from "../../src/session/message-v2"
import type { Provider } from "../../src/provider/provider"

function userMessage(id: string, text: string): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID: "session-1",
      role: "user",
      time: { created: 1000 },
      model: { providerID: "local", modelID: "qwen3.8-27b" },
    },
    parts: [
      {
        id: `${id}-part`,
        sessionID: "session-1",
        messageID: id,
        type: "text",
        text,
      },
    ],
  } as unknown as MessageV2.WithParts
}

function model(context: number, output = 16384): Provider.Model {
  return {
    id: "qwen3.8-27b",
    providerID: "local",
    api: { npm: "@ai-sdk/openai-compatible" },
    limit: { context, output },
  } as unknown as Provider.Model
}

describe("SessionCompaction.fitHead", () => {
  test("leaves a small head untouched", async () => {
    const head = [userMessage("m1", "short"), userMessage("m2", "also short")]
    const result = await SessionCompaction.fitHead({ head, model: model(131072) })
    expect(result.dropped).toBe(0)
    expect(result.head.length).toBe(2)
  })

  test("drops oldest messages until an oversized head fits the window", async () => {
    // ~3.7-4 chars/token estimate baseline (Token.estimate): 40 messages x 20k
    // chars = 800k chars ≈ 200k tokens, far over a 32k window minus output reserve.
    const head = Array.from({ length: 40 }, (_, i) => userMessage(`m${i}`, "x".repeat(20_000)))
    const result = await SessionCompaction.fitHead({ head, model: model(32768, 8192) })
    expect(result.dropped).toBeGreaterThan(0)
    expect(result.head.length).toBeLessThan(40)
    expect(result.head.length).toBeGreaterThanOrEqual(1)
    // survivors are the NEWEST messages (front of head is oldest)
    expect(result.head.at(-1)).toBe(head.at(-1)!)
  })

  test("zero-context models pass through unchanged", async () => {
    const head = [userMessage("m1", "x".repeat(100_000))]
    const result = await SessionCompaction.fitHead({ head, model: model(0) })
    expect(result.dropped).toBe(0)
  })

  // A context limit at or below the output reservation leaves no positive
  // budget for any head at all. The old guard returned `input.head` unchanged
  // in this case, reproducing the exact overflow fitHead exists to recover
  // from — it must drop to an empty head instead (safe: the caller always
  // appends its own trailing user prompt after `head`).
  test("a degenerate budget (context <= maxOutput + margin) empties the head instead of returning it unchanged", async () => {
    const head = [userMessage("m1", "short"), userMessage("m2", "also short")]
    const result = await SessionCompaction.fitHead({ head, model: model(2000, 2000) })
    expect(result.head.length).toBe(0)
    expect(result.dropped).toBe(head.length)
  })
})

// altimate_change start — mixed-role/turn-shaped fixture: a raw array-offset cut
// (head.slice(step)) can land inside a turn, leaving the summarization request
// starting with a non-user message — providers 400 on that, which bypasses the
// "too large to compact" fallback entirely. fitHead rounds the cut forward to
// the next user-role message instead.
function assistantMessage(id: string, text: string): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID: "session-1",
      role: "assistant",
      time: { created: 1000 },
      model: { providerID: "local", modelID: "qwen3.8-27b" },
    },
    parts: [
      {
        id: `${id}-part`,
        sessionID: "session-1",
        messageID: id,
        type: "text",
        text,
      },
    ],
  } as unknown as MessageV2.WithParts
}

describe("SessionCompaction.fitHead turn boundaries (mixed-role heads)", () => {
  test("truncation lands on a user message, never mid-turn", async () => {
    const head: MessageV2.WithParts[] = []
    for (let i = 0; i < 24; i++) {
      head.push(userMessage(`u${i}`, "q".repeat(8_000)))
      head.push(assistantMessage(`a${i}`, "r".repeat(8_000)))
    }
    const result = await SessionCompaction.fitHead({ head, model: model(16384, 4096) })
    expect(result.dropped).toBeGreaterThan(0)
    // This is the assertion that fails without turn-boundary rounding: a raw
    // step offset lands on an odd index (an assistant message) roughly half
    // the time, which this fixture's alternating user/assistant shape exposes.
    expect(result.head[0]!.info.role).toBe("user")
  })

  test("no truncation when a mixed-role head already fits", async () => {
    const head = [userMessage("u", "small"), assistantMessage("a", "tiny")]
    const result = await SessionCompaction.fitHead({ head, model: model(131072) })
    expect(result.dropped).toBe(0)
  })

  test("repeated truncation passes stays on user boundaries across multiple iterations", async () => {
    // Enough turns that the while-loop in fitHead needs several passes to
    // shrink under budget, exercising the boundary-rounding logic more than once.
    const head: MessageV2.WithParts[] = []
    for (let i = 0; i < 80; i++) {
      head.push(userMessage(`u${i}`, "q".repeat(4_000)))
      head.push(assistantMessage(`a${i}`, "r".repeat(4_000)))
    }
    const result = await SessionCompaction.fitHead({ head, model: model(8192, 2048) })
    expect(result.dropped).toBeGreaterThan(0)
    expect(result.head[0]!.info.role).toBe("user")
  })
})
// altimate_change end

// altimate_change start — upstream_fix: a lone oversized message must not survive fitHead
describe("SessionCompaction.fitHead single-message overflow", () => {
  test("drops the last message entirely when even a single message exceeds budget", async () => {
    // One assistant message whose own size already blows the window — the old
    // `head.length > 1` guard exited the loop without ever re-checking this
    // message against budget, silently returning it still oversized.
    const head = [assistantMessage("a0", "z".repeat(200_000))]
    const result = await SessionCompaction.fitHead({ head, model: model(4096, 1024) })
    expect(result.head.length).toBe(0)
    expect(result.dropped).toBe(1)
  })

  test("shrinking down to a single oversized survivor still drops it, not just the earlier turns", async () => {
    const head: MessageV2.WithParts[] = []
    for (let i = 0; i < 7; i++) head.push(userMessage(`u${i}`, "q".repeat(200)))
    // The newest (last) message is itself larger than the whole budget.
    head.push(assistantMessage("huge", "z".repeat(200_000)))
    const result = await SessionCompaction.fitHead({ head, model: model(4096, 1024) })
    expect(result.head.length).toBe(0)
    expect(result.dropped).toBe(head.length)
  })

  test("a single message that DOES fit is still kept (no regression)", async () => {
    const head = [userMessage("u0", "short")]
    const result = await SessionCompaction.fitHead({ head, model: model(131072) })
    expect(result.head.length).toBe(1)
    expect(result.dropped).toBe(0)
  })
})
// altimate_change end

// altimate_change start — upstream_fix: no-later-user-boundary must not revert to a mid-turn cut
describe("SessionCompaction.fitHead no later user boundary", () => {
  test("empties the head instead of reverting to a mid-turn cut when no user boundary follows step", async () => {
    // A single leading user message followed by a long run of assistant
    // messages with no further user turn: the forward scan for a user
    // boundary after `step` never finds one. The old fallback reverted to
    // the raw `step` offset, which starts the resulting head on an
    // assistant message — the exact provider-400 shape this rounding exists
    // to prevent. The fix must empty the head instead (safe: the caller
    // always appends its own trailing user prompt).
    const head: MessageV2.WithParts[] = [userMessage("u0", "q".repeat(8_000))]
    for (let i = 0; i < 8; i++) head.push(assistantMessage(`a${i}`, "r".repeat(8_000)))
    const result = await SessionCompaction.fitHead({ head, model: model(16384, 4096) })
    expect(result.head.length).toBe(0)
    expect(result.dropped).toBe(head.length)
  })
})
// altimate_change end
