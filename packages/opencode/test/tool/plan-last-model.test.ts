import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Project } from "@/project/project"
import { Session as SessionNs } from "@/session/session"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { getLastModel } from "../../src/tool/plan"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(SessionNs.defaultLayer, Project.defaultLayer, CrossSpawnSpawner.defaultLayer))

const addUser = Effect.fn("PlanLastModelTest.addUser")(function* (
  sessionID: SessionID,
  model: { providerID: string; modelID: string },
  part: { text: string; synthetic?: boolean; metadata?: Record<string, unknown> },
) {
  const session = yield* SessionNs.Service
  const id = MessageID.ascending()
  yield* session.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "plan",
    model,
    tools: {},
    mode: "",
  } as never)
  yield* session.updatePart({ id: PartID.ascending(), sessionID, messageID: id, type: "text", ...part } as never)
})

describe("plan_exit model selection", () => {
  it.instance(
    "skips shell and direct MCP rows recorded after the last real prompt",
    () =>
      Effect.gen(function* () {
        const created = yield* SessionNs.use.create({ title: "plan exit" })
        yield* addUser(created.id, { providerID: "test", modelID: "chat-model" }, { text: "make a plan" })
        yield* addUser(
          created.id,
          { providerID: "display", modelID: "shell" },
          { text: "The following tool was executed by the user", synthetic: true },
        )
        yield* addUser(created.id, { providerID: "", modelID: "" }, { text: "/mcps", metadata: { modelMetadataOnly: true } })
        const model = yield* Effect.promise(() => getLastModel(created.id))
        expect([String(model.providerID), String(model.modelID)]).toEqual(["test", "chat-model"])
      }),
    { git: true },
  )
})
