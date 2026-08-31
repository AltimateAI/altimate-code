// W1.8 — tool-call id sanitation. Malformed (non-string) tool-call ids must be
// coerced/regenerated DETERMINISTICALLY at ingestion (processor.ts) with the
// mapping propagated atomically to the paired tool-result, and the replay path
// (message-v2.ts toModelMessages) must apply the same coercion so both halves of
// a persisted pair render identical toolCallId values. A regenerated call id with
// an un-regenerated result id 400s every subsequent provider request.
import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import type { Provider } from "@/provider/provider"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"

const sessionID = SessionID.make("session")
const providerID = ProviderID.make("test")
const model: Provider.Model = {
  id: ModelID.make("test-model"),
  providerID,
  api: {
    id: "test-model",
    url: "https://example.com",
    npm: "@ai-sdk/openai",
  },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: {
    input: 0,
    output: 0,
    cache: { read: 0, write: 0 },
  },
  limit: { context: 128000, output: 4096 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
} as unknown as Provider.Model

function basePart(messageID: string, id: string) {
  return {
    id: PartID.make(`prt_${id}`),
    sessionID,
    messageID: MessageID.make(`msg_${messageID}`),
  }
}

function userMsg(id: string): SessionV1.WithParts {
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: 0 },
      agent: "user",
      model: { providerID, modelID: ModelID.make("test") },
      tools: {},
      mode: "",
    },
    parts: [{ ...basePart(id, "u1"), type: "text", text: "run tool" }],
  } as unknown as SessionV1.WithParts
}

function assistantToolMsg(id: string, callID: unknown): SessionV1.WithParts {
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created: 0 },
      parentID: "m-user",
      modelID: model.api.id,
      providerID,
      mode: "",
      agent: "agent",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        ...basePart(id, "a1"),
        type: "tool",
        callID,
        tool: "bash",
        state: {
          status: "completed",
          input: { cmd: "ls" },
          output: "ok",
          title: "Bash",
          metadata: {},
          time: { start: 0, end: 1 },
        },
      },
    ],
  } as unknown as SessionV1.WithParts
}

/** Extract the tool-call and tool-result ids from replayed model messages. */
function pairIDs(messages: Awaited<ReturnType<typeof MessageV2.toModelMessages>>) {
  const callIDs: unknown[] = []
  const resultIDs: unknown[] = []
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const item of msg.content) {
      if (item.type === "tool-call") callIDs.push(item.toolCallId)
      if (item.type === "tool-result") resultIDs.push(item.toolCallId)
    }
  }
  return { callIDs, resultIDs }
}

describe("MessageV2.sanitizeToolCallID", () => {
  test("passes valid non-empty string ids through untouched", () => {
    expect(MessageV2.sanitizeToolCallID("call_abc123")).toBe("call_abc123")
  })

  test("regenerates non-string ids deterministically", () => {
    const a = MessageV2.sanitizeToolCallID(12345)
    const b = MessageV2.sanitizeToolCallID(12345)
    expect(a).toBe(b)
    expect(typeof a).toBe("string")
    expect(a.length).toBeGreaterThan(0)
  })

  test("distinct malformed ids map to distinct sanitized ids", () => {
    expect(MessageV2.sanitizeToolCallID(1)).not.toBe(MessageV2.sanitizeToolCallID(2))
  })

  test("uses a widened (64-bit) digest, not a 32-bit one, to keep collisions negligible", () => {
    // "call_" + 8 hex chars is a 32-bit digest with only ~4B buckets; regenerated
    // ids must use a wider digest so two distinct malformed ids are vanishingly
    // unlikely to collide onto the same toolCallId.
    const id = MessageV2.sanitizeToolCallID(12345)
    expect(id).toMatch(/^call_[0-9a-f]{16}$/)
  })

  test("handles empty string, null, undefined, and objects without throwing", () => {
    for (const raw of ["", null, undefined, { id: 1 }, []]) {
      const out = MessageV2.sanitizeToolCallID(raw)
      expect(typeof out).toBe("string")
      expect(out.length).toBeGreaterThan(0)
      expect(out).toBe(MessageV2.sanitizeToolCallID(raw))
    }
  })
})

describe("SessionProcessor.createToolCallIDCoercer (ingestion half)", () => {
  test("coerces a malformed call id and propagates the SAME id to the paired result", () => {
    const coerce = SessionProcessor.createToolCallIDCoercer()
    const callHalf = coerce(42) // tool-input-start / tool-call event
    const resultHalf = coerce(42) // tool-result event
    expect(callHalf).toBe(resultHalf)
    expect(typeof callHalf).toBe("string")
  })

  test("pairs survive a provider type flip (numeric call id, string result id)", () => {
    const coerce = SessionProcessor.createToolCallIDCoercer()
    const callHalf = coerce(42)
    const resultHalf = coerce("42") // some servers stringify the id on the result event
    expect(resultHalf).toBe(callHalf)
  })

  test("valid string ids are untouched so healthy providers see no behavior change", () => {
    const coerce = SessionProcessor.createToolCallIDCoercer()
    expect(coerce("call_ok")).toBe("call_ok")
  })

  test("reserved Object.prototype property names are not confused with cached aliases", () => {
    // A plain `{}` cache would read these back as inherited functions/objects
    // (Object.prototype.toString, .constructor, ...) instead of `undefined` on
    // first sight — corrupting the alias for a provider-supplied id that happens
    // to equal one of these names.
    const coerce = SessionProcessor.createToolCallIDCoercer()
    for (const reserved of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(coerce(reserved)).toBe(reserved)
    }
  })
})

describe("malformed-id round-trip: ingest → persist → replay", () => {
  test("ingested-then-persisted id replays with matching call/result ids", async () => {
    // Ingestion: the processor's coercer regenerates the malformed id; the
    // sanitized value is what gets persisted as the part's callID.
    const coerce = SessionProcessor.createToolCallIDCoercer()
    const persistedCallID = coerce(9876)
    expect(coerce("9876")).toBe(persistedCallID) // paired result resolves to the same part

    // Replay: the persisted transcript renders both halves with the same string id.
    const replayed = await MessageV2.toModelMessages(
      [userMsg("m-user"), assistantToolMsg("m-assistant", persistedCallID)] as unknown as MessageV2.WithParts[],
      model,
    )
    const { callIDs, resultIDs } = pairIDs(replayed)
    expect(callIDs).toEqual([persistedCallID])
    expect(resultIDs).toEqual([persistedCallID])
  })

  test("replay defensively coerces a malformed PERSISTED id identically on both halves", async () => {
    // Transcripts written before the ingestion fix may carry non-string callIDs.
    const replayed = await MessageV2.toModelMessages(
      [userMsg("m-user"), assistantToolMsg("m-assistant", 12345)] as unknown as MessageV2.WithParts[],
      model,
    )
    const { callIDs, resultIDs } = pairIDs(replayed)
    expect(callIDs).toHaveLength(1)
    expect(resultIDs).toHaveLength(1)
    const expected = MessageV2.sanitizeToolCallID(12345)
    expect(callIDs[0]).toBe(expected)
    expect(resultIDs[0]).toBe(expected)
    expect(typeof callIDs[0]).toBe("string")
  })

  test("ingestion and replay halves produce identical output for the same raw id", () => {
    // The contract that keeps a pair consistent across the two code paths.
    const coerce = SessionProcessor.createToolCallIDCoercer()
    for (const raw of [7, "7x", 0, { a: 1 }, ""]) {
      expect(coerce(raw)).toBe(MessageV2.sanitizeToolCallID(raw))
    }
  })
})
