import { describe, expect, spyOn, test } from "bun:test"
import { MockLanguageModelV3 } from "ai/test"
import { jsonSchema, simulateReadableStream, tool } from "ai"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Plugin } from "../../src/plugin"
import { Instance } from "../../src/project/instance"
import { ProjectID } from "../../src/project/schema"
import { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { LLM } from "../../src/session/llm"
import { MessageID, SessionID } from "../../src/session/schema"
import { SystemPrompt } from "../../src/session/system"
import { tmpdir } from "../fixture/fixture"

describe("session system cache prefix", () => {
  for (const providerID of ["anthropic", "amazon-bedrock"]) {
    for (const pluginInstructions of [false, true]) {
      test(`${providerID} keeps a marked prefix across directories with plugin instructions ${pluginInstructions}`, async () => {
        const model: Provider.Model = {
          id: ModelID.make("claude-test"),
          providerID: ProviderID.make(providerID),
          api: {
            id: "claude-test",
            url: "https://example.invalid",
            npm: providerID === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/amazon-bedrock",
          },
          name: "Test model",
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
          provider: providerID,
          modelId: model.api.id,
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
        const mocks = [
          spyOn(Provider, "getLanguage").mockResolvedValue(language),
          spyOn(Provider, "getProvider").mockResolvedValue({
            id: model.providerID,
            name: "Test provider",
            source: "config",
            env: [],
            options: {},
            models: {},
          }),
          spyOn(Config, "get").mockResolvedValue({}),
          spyOn(Auth, "get").mockResolvedValue(undefined),
          spyOn(Plugin, "trigger").mockImplementation(async (name, _input, output) => {
            if (name === "experimental.chat.system.transform" && pluginInstructions) {
              ;(output as { system: string[] }).system.push("Plugin rules.", "Additional plugin rules.")
            }
            return output
          }),
        ]
        try {
          await using first = await tmpdir()
          await using second = await tmpdir()
          const directories = [first.path, second.path]
          for (const [index, directory] of directories.entries()) {
            await Instance.restore(
              {
                directory,
                worktree: directory,
                project: {
                  id: ProjectID.global,
                  worktree: directory,
                  time: { created: 0, updated: 0 },
                  sandboxes: [],
                },
              },
              async () => {
                const sessionID = SessionID.make(`ses_directory_${index}`)
                const result = await LLM.stream({
                  sessionID,
                  model,
                  agent: { name: "test", mode: "primary", options: {}, permission: [] },
                  user: {
                    id: MessageID.make(`msg_directory_${index}`),
                    sessionID,
                    role: "user",
                    agent: "test",
                    model: { providerID: model.providerID, modelID: model.id },
                    time: { created: 0 },
                    system: "Custom instructions.",
                  },
                  system: ["Project instructions.", "Skill instructions."],
                  environment: await SystemPrompt.environment(model),
                  messages: [{ role: "user", content: "Inspect the project." }],
                  tools: {
                    inspect: tool({ description: "Inspect the project", inputSchema: jsonSchema({ type: "object" }) }),
                  },
                  abort: new AbortController().signal,
                })
                await result.consumeStream({
                  onError: (error) => {
                    throw error
                  },
                })
              },
            )
          }

          expect(language.doStreamCalls).toHaveLength(2)
          const systems = language.doStreamCalls.map((call) =>
            call.prompt.filter((message) => message.role === "system"),
          )
          expect(systems[0]).toHaveLength(pluginInstructions ? 3 : 2)
          expect(JSON.stringify(systems[0].slice(0, -1))).toBe(JSON.stringify(systems[1].slice(0, -1)))
          expect(JSON.stringify(language.doStreamCalls[0].tools)).toBe(JSON.stringify(language.doStreamCalls[1].tools))
          for (const [index, system] of systems.entries()) {
            const prefix = system.slice(0, -1)
            expect(prefix[0].content).toContain("Project instructions.\nSkill instructions.\nCustom instructions.")
            expect(prefix[0].providerOptions?.[providerID === "anthropic" ? "anthropic" : "bedrock"]).toEqual(
              providerID === "anthropic"
                ? { cacheControl: { type: "ephemeral" } }
                : { cachePoint: { type: "default" } },
            )
            if (pluginInstructions) expect(prefix[1].content).toBe("Plugin rules.\nAdditional plugin rules.")
            expect(JSON.stringify(prefix)).not.toContain(directories[index])
            expect(JSON.stringify(prefix)).not.toContain("Today's date:")
            expect(system.at(-1)?.content).toContain(`Working directory: ${directories[index]}`)
            expect(system.at(-1)?.content).toContain(`Workspace root folder: ${directories[index]}`)
            expect(system.at(-1)?.content).toContain(`Today's date: ${new Date().toDateString()}`)
            const conversation = language.doStreamCalls[index].prompt.filter((message) => message.role !== "system")
            expect(JSON.stringify(conversation)).not.toContain("<env>")
          }
        } finally {
          for (const mock of mocks) mock.mockRestore()
        }
      })
    }
  }
})
