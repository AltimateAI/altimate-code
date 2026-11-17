import { expect, spyOn, test } from "bun:test"
import { MockLanguageModelV3 } from "ai/test"
import { simulateReadableStream } from "ai"
import { Auth } from "../../../../src/auth"
import { Config } from "../../../../src/config/config"
import { Plugin } from "../../../../src/plugin"
import { Instance } from "../../../../src/project/instance"
import { ProjectID } from "../../../../src/project/schema"
import { Provider } from "../../../../src/provider/provider"
import { ModelID, ProviderID } from "../../../../src/provider/schema"
import { LLM } from "../../../../src/session/llm"
import { MessageID, SessionID } from "../../../../src/session/schema"
import { SystemPrompt } from "../../../../src/session/system"
import { ClaudeAgentID } from "../../../../src/altimate/provider/claude-agent/id"
import { ClaudeSystemPrompt } from "../../../../src/altimate/provider/claude-agent/language-model/system-prompt"
import { tmpdir } from "../../../fixture/fixture"

// Streams one Claude Agent request through `LLM.stream` with a system-prompt plugin that edits the list
// it is given. Returns what the plugin saw and the call the model received.
async function streamWithPlugin(agent: string) {
  const model: Provider.Model = {
    id: ModelID.make("sonnet"),
    providerID: ProviderID.make(ClaudeAgentID.ID),
    api: { id: "sonnet", url: "", npm: ClaudeAgentID.PACKAGE },
    name: "Claude Sonnet",
    capabilities: {
      temperature: false,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 200_000, output: 4096 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  }
  const language = new MockLanguageModelV3({
    provider: ClaudeAgentID.ID,
    modelId: "sonnet",
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          {
            type: "finish" as const,
            finishReason: { unified: "stop" as const, raw: "stop" },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 0, text: 0, reasoning: 0 },
            },
          },
        ],
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    }),
  })
  const seen: string[][] = []
  const mocks = [
    spyOn(Provider, "getLanguage").mockResolvedValue(language),
    spyOn(Provider, "getProvider").mockResolvedValue({
      id: model.providerID,
      name: "Claude Agent",
      source: "config",
      env: [],
      options: {},
      models: {},
    }),
    spyOn(Config, "get").mockResolvedValue({}),
    spyOn(Auth, "get").mockResolvedValue(undefined),
    spyOn(Plugin, "trigger").mockImplementation(async (name, _input, output) => {
      if (name === "experimental.chat.system.transform") {
        const system = (output as { system: string[] }).system
        seen.push([...system])
        system.push("Plugin rules.")
        system[0] = system[0].replace("Project instructions.", "Edited project instructions.")
      }
      return output
    }),
  ]
  try {
    await using dir = await tmpdir()
    await Instance.restore(
      {
        directory: dir.path,
        worktree: dir.path,
        project: { id: ProjectID.global, worktree: dir.path, time: { created: 0, updated: 0 }, sandboxes: [] },
      },
      async () => {
        const sessionID = SessionID.make("ses_claude_transform")
        const result = await LLM.stream({
          sessionID,
          model,
          agent: { name: agent, mode: "primary", options: {}, permission: [] },
          user: {
            id: MessageID.make("msg_claude_transform"),
            sessionID,
            role: "user",
            agent,
            model: { providerID: model.providerID, modelID: model.id },
            time: { created: 0 },
            system: "Custom instructions.",
          },
          system: ["Project instructions."],
          environment: await SystemPrompt.environment(model),
          messages: [{ role: "user", content: "Inspect the project." }],
          tools: {},
          abort: new AbortController().signal,
        })
        await result.consumeStream({
          onError: (error) => {
            throw error
          },
        })
      },
    )
    return { seen, call: language.doStreamCalls[0]! }
  } finally {
    for (const mock of mocks) mock.mockRestore()
  }
}

// A plugin's `experimental.chat.system.transform` edits must reach Claude, which takes its instructions as an option.
test("system-prompt plugin edits reach a Claude Agent request, without the environment block", async () => {
  const { seen, call } = await streamWithPlugin("test")
  // The hook sees what Claude receives: the instruction sources, with no environment block.
  expect(seen).toEqual([["Project instructions.", "Custom instructions."]])
  const options = call.providerOptions?.[ClaudeAgentID.ID]
  const instructions = String(options?.[ClaudeSystemPrompt.INSTRUCTIONS_OPTION])
  expect(instructions).toBe("Edited project instructions.\n\nCustom instructions.\n\nPlugin rules.")
  expect(instructions).not.toContain("Working directory:")
})

// Titles and summaries send their system messages as Claude's prompt, so plugin edits must land there.
test("system-prompt plugin edits reach a Claude Agent title request, without the environment block", async () => {
  const { call } = await streamWithPlugin("title")
  const system = call.prompt
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n")
  expect(system).toContain("Edited project instructions.")
  expect(system).toContain("Plugin rules.")
  expect(system).not.toContain("Working directory:")
})
