// altimate_change - new file
import { describe, expect, test } from "bun:test"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import type { Provider } from "../../src/provider/provider"

const sessionID = SessionID.make("ses_learn_prompt")
const note = "Team rules for this request:\nKeep amount_cents in integer monetary units."

function user(id: string, text: string): MessageV2.WithParts {
  const messageID = MessageID.make(id)
  return {
    info: {
      id: messageID,
      sessionID,
      role: "user",
      time: { created: 0 },
      agent: "build",
      model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
    },
    parts: [{ id: PartID.ascending(), sessionID, messageID, type: "text", text }],
  }
}

function model(npm: string): Provider.Model {
  return {
    id: ModelID.make("test-model"), providerID: ProviderID.make("test"),
    api: { id: npm === "@ai-sdk/anthropic" ? "claude-sonnet" : "gpt-test", url: "", npm },
    name: "Test model", status: "active", options: {}, headers: {}, release_date: "2026-09-30",
    capabilities: {
      temperature: false, reasoning: false, attachment: false, toolcall: true, interleaved: false,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 100000, output: 10000 },
  }
}

describe("approved team rules attached to a user turn", () => {
  test("an empty note leaves the message untouched without persisting anything", async () => {
    const message = user("msg_empty", "Hello")
    const before = JSON.stringify(message)
    let writes = 0
    const part = await SessionPrompt.attachTeamRules(message, "", async () => { writes++ })
    expect(part).toBeUndefined()
    expect(writes).toBe(0)
    expect(JSON.stringify(message)).toBe(before)
  })

  test("persists a synthetic, visible tail part once and restores its tail position on the next step", async () => {
    const message = user("msg_tail", "Review amount_cents")
    const original = structuredClone(message.parts)
    const writes: MessageV2.TextPart[] = []
    const persist = async (part: MessageV2.TextPart) => { writes.push(structuredClone(part)) }
    const attached = await SessionPrompt.attachTeamRules(message, note, persist)
    expect(attached).toMatchObject({
      type: "text", text: note, synthetic: true, sessionID,
      messageID: message.info.id, metadata: { learnRequest: true },
    })
    expect(attached?.ignored).toBeUndefined()
    expect(message.parts.slice(0, -1)).toEqual(original)
    expect(message.parts.at(-1)).toBe(attached)

    const reminder: MessageV2.TextPart = {
      id: PartID.ascending(), sessionID, messageID: message.info.id,
      type: "text", text: "An existing harness reminder", synthetic: true,
    }
    message.parts.push(reminder)
    const repeated = await SessionPrompt.attachTeamRules(message, note, persist)
    expect(repeated).toBe(attached)
    expect(writes).toHaveLength(1)
    expect(message.parts).toEqual([...original, reminder, attached!])
    expect(message.parts.filter((part) => part.type === "text" && part.text === note)).toHaveLength(1)

    const resumed = structuredClone(message)
    await SessionPrompt.attachTeamRules(resumed, note, persist)
    expect(writes).toHaveLength(1)
    expect(resumed).toEqual(message)
  })

  test("does not confuse unrelated synthetic input with a harness-approved note", async () => {
    const message = user("msg_untrusted", "Review amount_cents")
    const unrelated: MessageV2.TextPart = {
      id: PartID.ascending(), sessionID, messageID: message.info.id,
      type: "text", text: note, synthetic: true, ignored: true,
    }
    message.parts.push(unrelated)
    let writes = 0
    const attached = await SessionPrompt.attachTeamRules(message, note, async () => { writes++ })
    expect(writes).toBe(1)
    expect(attached).not.toBe(unrelated)
    expect(attached?.ignored).toBeUndefined()
    expect(message.parts.at(-1)).toBe(attached)
    expect(message.parts[1]).toBe(unrelated)
  })

  for (const npm of ["@ai-sdk/openai", "@ai-sdk/anthropic"]) {
    test(`stays at the user tail through ${npm} model conversion without changing prior context`, async () => {
      const previous = user("msg_previous", "Earlier request")
      const current = user("msg_current", "Review amount_cents")
      const messages = [previous, current]
      const before = JSON.stringify(previous)
      const provider = model(npm)
      const priorModelMessages = await MessageV2.toModelMessages([previous], provider)
      await SessionPrompt.attachTeamRules(current, note, async () => {})

      const converted = await MessageV2.toModelMessages(messages, provider)
      expect(JSON.stringify(previous)).toBe(before)
      expect(converted.slice(0, -1)).toEqual(priorModelMessages)
      expect(converted.at(-1)).toMatchObject({
        role: "user",
        content: [
          { type: "text", text: "Review amount_cents" },
          { type: "text", text: note },
        ],
      })
      expect(converted.some((message) => message.role === "system")).toBe(false)
      expect(JSON.stringify(converted).split("Team rules for this request:")).toHaveLength(2)

      const firstBytes = JSON.stringify(converted)
      await SessionPrompt.attachTeamRules(current, note, async () => { throw new Error("must not persist twice") })
      expect(JSON.stringify(await MessageV2.toModelMessages(messages, provider))).toBe(firstBytes)
    })
  }
})
