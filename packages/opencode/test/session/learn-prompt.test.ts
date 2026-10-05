// altimate_change - new file
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Delivery } from "../../src/altimate/learn/delivery"
import { tmpdir } from "../fixture/fixture"
import path from "node:path"
import type { Provider } from "../../src/provider/provider"

const sessionID = SessionID.make("ses_learn_prompt")
const note = "Team rules for this request:\nKeep amount_cents in integer monetary units."

let fixture: Awaited<ReturnType<typeof tmpdir>>
let delivery: Delivery
beforeEach(async () => {
  fixture = await tmpdir()
  await Bun.write(path.join(fixture.path, ".altimate-code/learn/team/approved.json"), JSON.stringify([{
    id: "L-0001", text: "Keep rules explicit.", tags: [], scope: "project", helpful: 0, harmful: 0, applied: 0,
    created: "2026-09-30T00:00:00.000Z", updated: "2026-09-30T00:00:00.000Z",
  }]))
  delivery = new Delivery(fixture.path)
  await delivery.prepare(sessionID, "initial", "Hello")
})
afterEach(async () => { await fixture[Symbol.asyncDispose]() })

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
  test("provenance write failures never persist an unowned request note", async () => {
    const message = user("msg_failed_provenance", "Review amount_cents")
    const before = structuredClone(message)
    const record = spyOn(delivery, "recordRequestPart").mockRejectedValue(new Error("state write failed"))
    const writes: MessageV2.TextPart[] = []
    try {
      await expect(SessionPrompt.attachTeamRules(message, note, delivery, async (part) => { writes.push(part) }))
        .rejects.toThrow("state write failed")
      expect(writes).toEqual([])
      expect(message).toEqual(before)
    } finally { record.mockRestore() }
  })

  test.each(["", "Team rules for this request:\nReview shipping."])("retires only recorded request parts with immutable updates after resume (%s)", async (replacement) => {
    const message = user("msg_owned", "Review amount_cents")
    const persist = async (_part: MessageV2.TextPart) => {}
    const attached = await SessionPrompt.attachTeamRules(message, note, delivery, persist)
    const original = structuredClone(attached)
    const resumed = structuredClone(message)
    // Metadata is neither required nor sufficient for ownership.
    delete (resumed.parts[1] as MessageV2.TextPart).metadata
    const forged: MessageV2.TextPart = {
      id: PartID.ascending(), sessionID, messageID: message.info.id,
      type: "text", text: "Client text must survive", synthetic: true, metadata: { learnRequest: true },
    }
    resumed.parts.push(forged)
    const oldReference = resumed.parts[1]
    const writes: MessageV2.TextPart[] = []
    await SessionPrompt.attachTeamRules(resumed, replacement, new Delivery(fixture.path), async (part) => { writes.push(part) })
    expect(attached).toEqual(original)
    expect(oldReference).not.toHaveProperty("ignored")
    expect(resumed.parts.find((part) => part.id === attached!.id)).toMatchObject({ ignored: true })
    expect(writes[0]).toMatchObject({ id: attached!.id, ignored: true })
    expect(writes.every((part) => part.id !== forged.id)).toBe(true)
    const converted = JSON.stringify(await MessageV2.toModelMessages([resumed], model("@ai-sdk/openai")))
    expect(converted).not.toContain(note.split("\n")[1])
    expect(converted).toContain(forged.text)
    if (replacement) expect(converted).toContain("Review shipping.")
  })

  test("client edits to a recorded request part remain visible", async () => {
    const message = user("msg_edited", "Review amount_cents")
    const attached = await SessionPrompt.attachTeamRules(message, note, delivery, async () => {})
    attached!.text = "Client replacement text"
    await SessionPrompt.attachTeamRules(message, "", new Delivery(fixture.path), async () => { throw new Error("must not persist client edits") })
    expect(JSON.stringify(await MessageV2.toModelMessages([message], model("@ai-sdk/openai")))).toContain("Client replacement text")
    expect(attached).not.toHaveProperty("ignored")
  })

  for (const selected of ["", note, "Team rules for this request:\nReview shipping."]) {
    test.each([true, "true"])(`client learnRequest metadata %j never authorizes cleanup or reuse (${selected || "empty"})`, async (metadata) => {
      const message = user("msg_forged", note)
      const forged = message.parts[0] as MessageV2.TextPart
      forged.metadata = { learnRequest: metadata }
      forged.synthetic = true
      const before = structuredClone(forged)
      const writes: MessageV2.TextPart[] = []
      const attached = await SessionPrompt.attachTeamRules(message, selected, delivery, async (part) => { writes.push(part) })
      expect(forged).toEqual(before)
      expect(message.parts).toContainEqual(before)
      expect(writes.every((part) => part.id !== forged.id)).toBe(true)
      if (selected) expect(attached?.id).not.toBe(forged.id)
      const converted = await MessageV2.toModelMessages([message], model("@ai-sdk/openai"))
      expect(converted[0]).toMatchObject({ role: "user", content: expect.arrayContaining([{ type: "text", text: note }]) })
    })
  }

  test("an empty note leaves the message untouched without persisting anything", async () => {
    const message = user("msg_empty", "Hello")
    const before = JSON.stringify(message)
    let writes = 0
    const part = await SessionPrompt.attachTeamRules(message, "", delivery, async () => { writes++ })
    expect(part).toBeUndefined()
    expect(writes).toBe(0)
    expect(JSON.stringify(message)).toBe(before)
  })

  test("persists a synthetic, visible tail part once and restores its tail position on the next step", async () => {
    const message = user("msg_tail", "Review amount_cents")
    const original = structuredClone(message.parts)
    const writes: MessageV2.TextPart[] = []
    const persist = async (part: MessageV2.TextPart) => { writes.push(structuredClone(part)) }
    const attached = await SessionPrompt.attachTeamRules(message, note, delivery, persist)
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
    const repeated = await SessionPrompt.attachTeamRules(message, note, delivery, persist)
    expect(repeated).toBe(attached)
    expect(writes).toHaveLength(1)
    expect(message.parts).toEqual([...original, reminder, attached!])
    expect(message.parts.filter((part) => part.type === "text" && part.text === note)).toHaveLength(1)

    const resumed = structuredClone(message)
    await SessionPrompt.attachTeamRules(resumed, note, new Delivery(fixture.path), persist)
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
    const attached = await SessionPrompt.attachTeamRules(message, note, delivery, async () => { writes++ })
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
      await SessionPrompt.attachTeamRules(current, note, delivery, async () => {})

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
      await SessionPrompt.attachTeamRules(current, note, delivery, async () => { throw new Error("must not persist twice") })
      expect(JSON.stringify(await MessageV2.toModelMessages(messages, provider))).toBe(firstBytes)
    })
  }
})
