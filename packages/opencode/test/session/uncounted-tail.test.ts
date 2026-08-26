import { describe, expect, test } from "bun:test"

import { SessionCompaction } from "../../src/session/compaction"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import type { MessageV2 } from "../../src/session/message-v2"
import type { Provider } from "../../src/provider/provider"

// The proactive overflow path (prompt.ts loop) adds
// SessionCompaction.uncountedTailTokens of parts appended after the last
// assistant usage reading to lastFinished.tokens before checking
// SessionCompaction.isOverflow. These tests exercise that estimator and its
// effect on the overflow decision directly, since the estimator is now an
// exported pure function rather than an inline IIFE in the prompt loop.

function textMessage(id: string, role: "user" | "assistant", text: string): MessageV2.WithParts {
  return {
    info: { id, sessionID: "s", role, time: { created: 1 }, model: { providerID: "p", modelID: "m" } },
    parts: [{ id: `${id}-p`, sessionID: "s", messageID: id, type: "text", text }],
  } as unknown as MessageV2.WithParts
}

function toolMessage(id: string, output: string): MessageV2.WithParts {
  return {
    info: { id, sessionID: "s", role: "assistant", time: { created: 1 }, model: { providerID: "p", modelID: "m" } },
    parts: [
      {
        id: `${id}-p`,
        sessionID: "s",
        messageID: id,
        type: "tool",
        callID: `${id}-call`,
        tool: "bash",
        state: {
          status: "completed",
          input: {},
          output,
          title: "Bash",
          metadata: {},
          time: { start: 0, end: 1 },
        },
      },
    ],
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

describe("SessionCompaction.uncountedTailTokens", () => {
  test("returns 0 when lastFinishedId is not set", () => {
    const messages = [textMessage("a", "assistant", "hello")]
    expect(SessionCompaction.uncountedTailTokens({ messages, lastFinishedId: undefined })).toBe(0)
  })

  test("returns 0 when lastFinishedId is not found in messages", () => {
    const messages = [textMessage("a", "assistant", "hello")]
    expect(SessionCompaction.uncountedTailTokens({ messages, lastFinishedId: "missing" as MessageV2.WithParts["info"]["id"] })).toBe(0)
  })

  test("sums text and completed-tool tokens after lastFinishedId, ignoring messages before/at it", () => {
    const messages = [
      textMessage("before", "user", "x".repeat(400)), // must not count
      textMessage("finished", "assistant", "y".repeat(400)), // the boundary itself must not count
      toolMessage("tool1", "z".repeat(400)),
      textMessage("text1", "assistant", "w".repeat(400)),
    ]
    const tail = SessionCompaction.uncountedTailTokens({ messages, lastFinishedId: "finished" as any })
    expect(tail).toBeGreaterThan(0)

    // Only the two post-boundary messages should be counted.
    const partial = SessionCompaction.uncountedTailTokens({
      messages: messages.slice(0, 3), // up through tool1, no text1
      lastFinishedId: "finished" as any,
    })
    expect(partial).toBeLessThan(tail)
    expect(partial).toBeGreaterThan(0)
  })

  test("mixed tool+text tail is content-aware, not a flat chars/4 estimate", () => {
    // Same length, different content shape: dense JSON should estimate to MORE
    // tokens than the same-length plain text once the 0.8 safety margin (which
    // divides through evenly on both) is factored out — chars/4 would give the
    // same count for both regardless of content.
    const jsonBody = JSON.stringify({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 }).repeat(20)
    const plainText = "the quick brown fox jumps over the lazy dog and keeps on going ".repeat(
      Math.ceil(jsonBody.length / 65),
    )

    const jsonMessages = [textMessage("finished", "assistant", "x"), toolMessage("tool1", jsonBody)]
    const textMessages = [textMessage("finished", "assistant", "x"), toolMessage("tool1", plainText.slice(0, jsonBody.length))]

    const jsonTokens = SessionCompaction.uncountedTailTokens({ messages: jsonMessages, lastFinishedId: "finished" as any })
    const textTokens = SessionCompaction.uncountedTailTokens({ messages: textMessages, lastFinishedId: "finished" as any })

    expect(jsonTokens).toBeGreaterThan(textTokens)
  })

  test("applies a safety margin so the estimate is inflated, not a raw sum", () => {
    const output = "a".repeat(4000)
    const messages = [textMessage("finished", "assistant", "x"), toolMessage("tool1", output)]
    const tail = SessionCompaction.uncountedTailTokens({ messages, lastFinishedId: "finished" as any })
    // Raw Token.estimate would land well under the margined figure.
    expect(tail).toBeGreaterThan(output.length / 4.0)
  })
})

describe("proactive overflow: isOverflow triggers on an oversized post-lastFinished tool result", () => {
  test("a huge tool result appended after lastFinished pushes isOverflow to true even though recorded usage alone would not", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const testModel = model(32_768)
        const lastFinishedTokens = {
          input: 1_000,
          output: 500,
          reasoning: 0,
          cache: { read: 0, write: 0 },
          total: 1_500,
        }

        // Recorded usage alone is nowhere near the window.
        const overflowFromRecordedOnly = await SessionCompaction.isOverflow({
          tokens: lastFinishedTokens,
          model: testModel,
        })
        expect(overflowFromRecordedOnly).toBe(false)

        // A huge tool result lands after lastFinished but before the next usage
        // reading — exactly the gap uncountedTailTokens exists to cover.
        const messages = [
          textMessage("finished", "assistant", "ok"),
          toolMessage("huge-tool", "x".repeat(200_000)),
        ]
        const uncountedTail = SessionCompaction.uncountedTailTokens({ messages, lastFinishedId: "finished" as any })
        expect(uncountedTail).toBeGreaterThan(0)

        const overflowIncludingTail = await SessionCompaction.isOverflow({
          tokens: {
            ...lastFinishedTokens,
            input: lastFinishedTokens.input + uncountedTail,
            total: lastFinishedTokens.total + uncountedTail,
          },
          model: testModel,
        })
        expect(overflowIncludingTail).toBe(true)
      },
    })
  })

  test("a small post-lastFinished tail does not falsely trigger overflow", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const testModel = model(32_768)
        const lastFinishedTokens = {
          input: 1_000,
          output: 500,
          reasoning: 0,
          cache: { read: 0, write: 0 },
          total: 1_500,
        }
        const messages = [textMessage("finished", "assistant", "ok"), toolMessage("small-tool", "done")]
        const uncountedTail = SessionCompaction.uncountedTailTokens({ messages, lastFinishedId: "finished" as any })

        const overflow = await SessionCompaction.isOverflow({
          tokens: {
            ...lastFinishedTokens,
            input: lastFinishedTokens.input + uncountedTail,
            total: lastFinishedTokens.total + uncountedTail,
          },
          model: testModel,
        })
        expect(overflow).toBe(false)
      },
    })
  })
})
