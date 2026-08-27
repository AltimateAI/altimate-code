import { describe, expect, test } from "bun:test"

import { SessionCompaction } from "../../src/session/compaction"
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
