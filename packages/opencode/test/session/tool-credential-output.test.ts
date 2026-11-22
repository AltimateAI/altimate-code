// altimate_change — model and persistence coverage with synthetic credentials
import { expect, test } from "bun:test"
import path from "node:path"
import { Config } from "@/config/config"
import { BashTool } from "@/tool/bash"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { ModelID, ProviderID } from "@/provider/schema"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider/provider"
import { initTool } from "../altimate/tool-fixture"
import { provideTestInstance, tmpdir } from "../fixture/fixture"

const configuredKey = "fixture-provider-value"

test("known credential values are redacted in bash results", async () => {
  const marker = "prefix-[REDACTED]-suffix"
  await using tmp = await tmpdir({
    git: true,
    config: {
      provider: {
        test: {
          name: "Test",
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey: configuredKey },
          models: { fixture: { name: "Fixture" } },
        },
      },
    },
    init: (dir) => Bun.write(path.join(dir, "fixture.txt"), "prefix-" + configuredKey + "-suffix"),
  })
  await provideTestInstance({
    directory: tmp.path,
    fn: (instance) =>
      Instance.restore(instance, async () => {
        expect((await Config.get()).provider?.test?.options?.apiKey === configuredKey).toBe(true)
        const bash = await initTool(BashTool)
        const ctx = {
          sessionID: SessionID.make("ses_test"),
          messageID: MessageID.make("msg_test"),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => {},
          ask: async () => {},
        }
        const bashResult = await bash.execute({ command: "cat fixture.txt", description: "Print fixture" }, ctx)
        const session = await Session.create({})
        const parentID = MessageID.ascending()
        const messageID = MessageID.ascending()
        const providerID = ProviderID.make("test")
        const modelID = ModelID.make("fixture")
        await Session.updateMessage({
          id: parentID,
          sessionID: session.id,
          role: "user",
          agent: "build",
          model: { providerID, modelID },
          time: { created: 0 },
        })
        await Session.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: parentID,
          type: "text",
          text: "Print the fixture",
        })
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "assistant",
          agent: "build",
          parentID,
          providerID,
          modelID,
          mode: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, completed: 2 },
        })
        await Session.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID,
          type: "tool",
          tool: "bash",
          callID: "call_fixture",
          state: {
            status: "completed",
            input: { command: "cat fixture.txt" },
            title: bashResult.title,
            output: bashResult.output,
            metadata: bashResult.metadata,
            time: { start: 1, end: 2 },
          },
        })
        const persisted = await Session.messages({ sessionID: session.id })
        const stored = JSON.stringify(persisted)
        const model = await Provider.getModel(providerID, modelID)
        const request = JSON.stringify(await MessageV2.toModelMessages(persisted, model))
        expect({
          bashRaw: bashResult.output.includes(configuredKey),
          storedRaw: stored.includes(configuredKey),
          requestRaw: request.includes(configuredKey),
          bashRedacted: bashResult.output.includes(marker),
          storedRedacted: stored.includes(marker),
          requestRedacted: request.includes(marker),
        }).toEqual({
          bashRaw: false,
          storedRaw: false,
          requestRaw: false,
          bashRedacted: true,
          storedRedacted: true,
          requestRedacted: true,
        })
      }),
  })
})
