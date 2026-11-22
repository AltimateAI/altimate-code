// altimate_change — independent boundary coverage with raw synthetic credentials
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
import { Database, eq } from "@/storage/db"
import { PartTable } from "@opencode-ai/core/session/sql"
import { initTool } from "../altimate/tool-fixture"
import { provideTestInstance, tmpdir } from "../fixture/fixture"

const configuredKey = "fixture-provider-value"
const rawOutput = "prefix-" + configuredKey + "-suffix"
const safeOutput = "prefix-[REDACTED]-suffix"
const providerID = ProviderID.make("test")
const modelID = ModelID.make("fixture")
const config = {
  provider: {
    test: {
      name: "Test",
      npm: "@ai-sdk/openai-compatible",
      options: { apiKey: configuredKey },
      models: { fixture: { name: "Fixture" } },
    },
  },
}

async function inConfiguredInstance(fn: (directory: string) => Promise<void>) {
  await using tmp = await tmpdir({ git: true, config })
  await provideTestInstance({
    directory: tmp.path,
    fn: (instance) =>
      Instance.restore(instance, async () => {
        expect((await Config.get()).provider?.test?.options?.apiKey).toBe(configuredKey)
        await fn(tmp.path)
      }),
  })
}

// Construct raw historical input without calling any output or persistence sanitizer.
function rawHistory(directory: string, sessionID = SessionID.make("ses_fixture")): MessageV2.WithParts[] {
  const parentID = MessageID.ascending()
  const messageID = MessageID.ascending()
  return [
    {
      info: {
        id: parentID,
        sessionID,
        role: "user",
        agent: "build",
        model: { providerID, modelID },
        time: { created: 0 },
      },
      parts: [{ id: PartID.ascending(), sessionID, messageID: parentID, type: "text", text: "Print the fixture" }],
    },
    {
      info: {
        id: messageID,
        sessionID,
        role: "assistant",
        agent: "build",
        parentID,
        providerID,
        modelID,
        mode: "build",
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, completed: 2 },
      },
      parts: [
        {
          id: PartID.ascending(),
          sessionID,
          messageID,
          type: "tool",
          tool: "bash",
          callID: "call_fixture",
          state: {
            status: "completed",
            input: { command: "cat fixture.txt" },
            title: "Print fixture",
            output: rawOutput,
            metadata: { output: configuredKey },
            time: { start: 1, end: 2 },
          },
        },
      ],
    },
  ]
}

test("persistence redacts raw tool results before writing SQLite", async () => {
  await inConfiguredInstance(async (directory) => {
    const session = await Session.create({})
    const history = rawHistory(directory, session.id)
    for (const message of history) {
      await Session.updateMessage(message.info)
      for (const part of message.parts) await Session.updatePart(part)
    }
    const raw = history[1].parts[0] as MessageV2.ToolPart
    const stored = Database.use((db) => db.select().from(PartTable).where(eq(PartTable.id, raw.id)).get())!
    expect(JSON.stringify(stored)).not.toContain(configuredKey)
    expect(stored.data).toMatchObject({ state: { output: safeOutput, metadata: { output: "[REDACTED]" } } })
    expect(raw.state).toMatchObject({ output: rawOutput, metadata: { output: configuredKey } })
  })
})

test("model replay redacts raw historical tool output independently of persistence", async () => {
  await inConfiguredInstance(async (directory) => {
    const history = rawHistory(directory)
    const model = await Provider.getModel(providerID, modelID)
    const request = JSON.stringify(await MessageV2.toModelMessages(history, model))
    expect(request).not.toContain(configuredKey)
    expect(request).toContain(safeOutput)
    expect(history[1].parts[0]).toMatchObject({ state: { output: rawOutput } })
  })
})

test("bash progress holds a split credential until the next chunk and redacts final output", async () => {
  await inConfiguredInstance(async (directory) => {
    const split = Math.floor(configuredKey.length / 2)
    const head = configuredKey.slice(0, split)
    const tail = configuredKey.slice(split)
    await Bun.write(path.join(directory, "head.txt"), "prefix-" + head)
    await Bun.write(path.join(directory, "tail.txt"), tail + "-suffix")
    // The child waits for the first metadata callback, proving two distinct data
    // events without relying on a sleep to split stdout/stderr delivery.
    const bash = await initTool(BashTool)
    const previews: string[] = []
    const result = await bash.execute(
      {
        command: "cat head.txt; while [ ! -e release ]; do sleep 0.01; done; cat tail.txt >&2",
        description: "Print split fixture",
        timeout: 5000,
      },
      {
        sessionID: SessionID.make("ses_test"),
        messageID: MessageID.make("msg_test"),
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        ask: async () => {},
        metadata: (update: { metadata?: { output?: string } }) => {
          if (update.metadata?.output === undefined) return
          previews.push(update.metadata.output)
          if (previews.length === 2) return Bun.write(path.join(directory, "release"), "ready").then(() => {})
        },
      },
    )
    expect(previews.length).toBeGreaterThanOrEqual(3)
    expect(previews[1]).not.toContain(head)
    for (const preview of previews) expect(preview).not.toContain(configuredKey)
    expect(result.output).toBe(safeOutput)
    expect(result.metadata.output).toBe(safeOutput)
  })
})

test("model replay marks an omitted credential-bearing attachment", async () => {
  await inConfiguredInstance(async (directory) => {
    const history = rawHistory(directory)
    const part = history[1].parts[0] as MessageV2.ToolPart
    if (part.state.status !== "completed") throw new Error("expected completed fixture")
    const encoded = Buffer.from(configuredKey).toString("base64")
    part.state.output = "Attachment follows"
    part.state.attachments = [
      {
        id: PartID.ascending(),
        sessionID: part.sessionID,
        messageID: part.messageID,
        type: "file",
        mime: "image/png",
        filename: "fixture.png",
        url: "data:image/png;base64," + encoded,
      },
    ]
    const model = await Provider.getModel(providerID, modelID)
    const request = JSON.stringify(await MessageV2.toModelMessages(history, model))
    expect(request).toContain("Attachment follows\\n[REDACTED]")
    expect(request).not.toContain(encoded)
    expect(request).not.toContain(configuredKey)
    expect(part.state.attachments).toHaveLength(1)
  })
})
