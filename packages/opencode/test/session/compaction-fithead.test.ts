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
      model: { providerID: "local", modelID: "local-test-model" },
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
    id: "local-test-model",
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
    // ~64 chars/token estimate baseline: 40 messages x 20k chars ≈ 200k tokens,
    // far over a 32k window minus output reserve.
    const head = Array.from({ length: 40 }, (_, i) => userMessage(`m${i}`, "x".repeat(20_000)))
    const result = await SessionCompaction.fitHead({ head, model: model(32768, 8192) })
    expect(result.dropped).toBeGreaterThan(0)
    expect(result.head.length).toBeLessThan(40)
    expect(result.head.length).toBeGreaterThanOrEqual(1)
    // survivors are the NEWEST messages (front of head is oldest)
    expect(result.head.at(-1)).toBe(head.at(-1)!)
  })

  test("budget derives from the shared safety-fraction helper, not the raw limit", async () => {
    // A head sized to fit the RAW window (minus output + prompt allowance) but
    // NOT the safety-fraction-scaled window must still be trimmed — the
    // summarization request itself would otherwise overflow under estimator error.
    // 32k ctx, 8k out: raw budget ≈ 22.5k tokens; effective (0.65) ≈ 11.1k.
    const head = Array.from({ length: 30 }, (_, i) => userMessage(`m${i}`, "x".repeat(2_400)))
    const result = await SessionCompaction.fitHead({ head, model: model(32768, 8192), fraction: 0.65 })
    expect(result.dropped).toBeGreaterThan(0)
    // At fraction 1 the same head fits the raw window untrimmed.
    const raw = await SessionCompaction.fitHead({ head, model: model(32768, 8192), fraction: 1 })
    expect(raw.dropped).toBe(0)
  })

  test("zero-context models pass through unchanged", async () => {
    const head = [userMessage("m1", "x".repeat(100_000))]
    const result = await SessionCompaction.fitHead({ head, model: model(0) })
    expect(result.dropped).toBe(0)
  })
})
