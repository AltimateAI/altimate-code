import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { Agent } from "../../../src/agent/agent"
import { Delivery } from "../../../src/altimate/learn/delivery"
import { Plugin } from "../../../src/plugin"
import { Instance } from "../../../src/project/instance"
import { Provider } from "../../../src/provider/provider"
import { ModelID, ProviderID } from "../../../src/provider/schema"
import { Session } from "../../../src/session"
import { SessionCompaction } from "../../../src/session/compaction"
import { MessageV2 } from "../../../src/session/message-v2"
import { SessionPrompt } from "../../../src/session/prompt"
import { SessionProcessor } from "../../../src/session/processor"
import { MessageID, PartID } from "../../../src/session/schema"
import { tmpdir } from "../../fixture/fixture"

const model = { providerID: ProviderID.make("test"), modelID: ModelID.make("test") }

for (const learnDelivery of [true, false]) {
  test(`attachment-only compaction preserves request identity only with delivery ${learnDelivery}`, async () => {
    await using dir = await tmpdir({
      config: { compaction: { pin_task: false, state_ledger: false, summary_carry: false, tail_turns: 0 } },
    })
    const provider = spyOn(Provider, "getModel").mockResolvedValue({
      id: model.modelID,
      providerID: model.providerID,
      name: "Test",
      limit: { context: 100_000, output: 32_000 },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      capabilities: {
        toolcall: true, attachment: true, reasoning: false, temperature: false,
        input: { text: true, image: false, audio: false, video: false },
        output: { text: true, image: false, audio: false, video: false },
      },
      api: { id: "test", npm: "@ai-sdk/anthropic" },
      options: {},
    } as Provider.Model)
    const agent = spyOn(Agent, "get").mockResolvedValue({
      name: "compaction", mode: "primary", options: {}, permission: [],
    } as Awaited<ReturnType<typeof Agent.get>>)
    const plugin = spyOn(Plugin, "trigger").mockImplementation(async (_name, _input, output) => output)
    const unexpectedTool = () => { throw new Error("Unexpected tool execution during compaction") }
    const processor = spyOn(SessionProcessor, "create").mockImplementation((input) => ({
      message: input.assistantMessage,
      partFromToolCall: unexpectedTool,
      beginToolExecution: unexpectedTool,
      finishToolExecution: unexpectedTool,
      partFromToolExecution: unexpectedTool,
      async process(): Promise<"continue"> {
        await Session.updatePart({
          id: PartID.ascending(), sessionID: input.sessionID, messageID: input.assistantMessage.id,
          type: "text", text: "Summary of earlier context.",
        })
        return "continue"
      },
    }))
    try {
      await Instance.provide({ directory: dir.path, fn: async () => {
        const session = await Session.create({})
        async function user() {
          return await Session.updateMessage({
            id: MessageID.ascending(), sessionID: session.id, role: "user", time: { created: Date.now() },
            agent: "build", model,
          }) as MessageV2.User
        }
        const first = await user()
        await Session.updatePart({
          id: PartID.ascending(), messageID: first.id, sessionID: session.id, type: "text", text: "Inspect the data.",
        })
        const original = await user()
        await Session.updatePart({
          id: PartID.ascending(), messageID: original.id, sessionID: session.id,
          type: "file", mime: "text/csv", filename: "report.csv", url: "file:///tmp/report.csv",
        })
        const delivery = learnDelivery ? new Delivery(dir.path, { core_lessons: 0, retrieved_lessons: 0 }) : undefined
        let note = ""
        if (delivery) {
          await Bun.write(path.join(dir.path, ".altimate-code/learn/team/approved.json"), JSON.stringify([{
            id: "L-0001", text: "Keep amount_cents in integer monetary units.", tags: ["amount_cents"], scope: "project",
            helpful: 0, harmful: 0, applied: 0, created: "2026-09-30T00:00:00.000Z", updated: "2026-09-30T00:00:00.000Z",
          }]))
          await delivery.prepare(session.id, first.id, "Hello")
          note = (await delivery.prepare(session.id, original.id, "Review amount_cents")).requestNote
          expect(note).toContain("amount_cents")
          await SessionPrompt.attachTeamRules({ info: original, parts: [] }, note, delivery)
        }

        for (let attempt = 0; attempt < 2; attempt++) {
          const marker = await user()
          await Session.updatePart({
            id: PartID.ascending(), messageID: marker.id, sessionID: session.id,
            type: "compaction", auto: true, overflow: true,
          })
          expect(await SessionCompaction.process({
            sessionID: session.id, parentID: marker.id, messages: await Session.messages({ sessionID: session.id }),
            abort: new AbortController().signal, auto: true, overflow: true, learnDelivery: delivery,
          })).toBe("continue")
          const replay = (await Session.messages({ sessionID: session.id })).at(-1)!
          expect(replay.info.role).toBe("user")
          expect(replay.info.id).not.toBe(original.id)
          expect(replay.parts.filter((part) => part.type === "file")).toEqual([
            expect.objectContaining({ mime: "text/csv", filename: "report.csv", url: "file:///tmp/report.csv" }),
          ])
          const text = replay.parts.filter((part) => part.type === "text")
          expect(text).toEqual(learnDelivery ? [expect.objectContaining({
            text: "", synthetic: true, ignored: true, metadata: { learnOriginalMessage: original.id },
          })] : [])
          if (delivery) {
            await SessionPrompt.attachTeamRules(replay, note, delivery)
            expect(replay.parts.filter((part) => part.type === "text" && part.text === note)).toHaveLength(1)
          }
        }
      } })
    } finally {
      processor.mockRestore()
      plugin.mockRestore()
      agent.mockRestore()
      provider.mockRestore()
      await Instance.disposeAll()
    }
  })
}
