import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { getLastModel } from "../../src/tool/plan"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

async function addUser(
  sessionID: SessionID,
  model: { providerID: string; modelID: string },
  part: { text: string; synthetic?: boolean; metadata?: Record<string, unknown> },
) {
  const id = MessageID.ascending()
  await Session.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "plan",
    model,
    tools: {},
    mode: "",
  } as unknown as MessageV2.Info)
  await Session.updatePart({ id: PartID.ascending(), sessionID, messageID: id, type: "text", ...part })
}

describe("plan_exit model selection", () => {
  test("skips shell and direct MCP rows recorded after the last real prompt", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "plan exit" })
        await addUser(session.id, { providerID: "test", modelID: "chat-model" }, { text: "make a plan" })
        await addUser(
          session.id,
          { providerID: "display", modelID: "shell" },
          { text: "The following tool was executed by the user", synthetic: true },
        )
        await addUser(session.id, { providerID: "", modelID: "" }, { text: "/mcps", metadata: { modelMetadataOnly: true } })
        const model = await getLastModel(session.id)
        expect([String(model.providerID), String(model.modelID)]).toEqual(["test", "chat-model"])
      },
    })
  })
})
