// The marked system prefix must be byte-identical across the requests of a
// session. Text that appears on some steps only (the post-compaction task pin, the plan
// switch reminder) is hoisted out of the user turn on non-Anthropic models; it has to land
// after the cache breakpoint, or every first request after a compaction re-creates the
// whole prefix at full input rate.
import { describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { MockLanguageModelV3 } from "ai/test"
import { jsonSchema, simulateReadableStream, tool } from "ai"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Plugin } from "../../src/plugin"
import { Instance } from "../../src/project/instance"
import { ProjectID } from "../../src/project/schema"
import { Provider } from "../../src/provider/provider"
import { ProviderTransform } from "../../src/provider/transform"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { LLM } from "../../src/session/llm"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, SessionID } from "../../src/session/schema"
import { SystemPrompt } from "../../src/session/system"
import { tmpdir } from "../fixture/fixture"

const PIN =
  "<system-reminder>\nOriginal task — authoritative over any summary. Optimise the marts.\n</system-reminder>"

const gatewayModel: Provider.Model = {
  id: ModelID.make("altimate-default"),
  providerID: ProviderID.make("altimate-backend"),
  api: { id: "altimate-default", url: "https://example.invalid", npm: "@ai-sdk/openai-compatible" },
  name: "Altimate LLM Gateway",
  family: "openai",
  capabilities: {
    temperature: true,
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

describe("system prefix stability", () => {
  test("precondition: the gateway model hoists reminders and uses explicit cache breakpoints", () => {
    expect(SessionPrompt.isAnthropicLikeModel(gatewayModel)).toBe(false)
    expect(ProviderTransform.usesExplicitCacheBreakpoints(gatewayModel)).toBe(true)
  })

  test("a hoisted task pin rides in the trailing system message; the marked prefix is unchanged", async () => {
    const language = new MockLanguageModelV3({
      provider: "altimate-backend",
      modelId: gatewayModel.api.id,
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
        id: gatewayModel.providerID,
        name: "Altimate AI",
        source: "custom",
        env: [],
        options: {},
        models: {},
      }),
      spyOn(Config, "get").mockResolvedValue({}),
      spyOn(Auth, "get").mockResolvedValue(undefined),
      spyOn(Plugin, "trigger").mockImplementation(async (_name, _input, output) => output),
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
          const sessionID = SessionID.make("ses_prefix_stability")
          const environment = await SystemPrompt.environment(gatewayModel)
          // Before compaction: no reminder. After: the loop passes the pin with the environment.
          for (const [index, hoisted] of [[], [PIN]].entries()) {
            const result = await LLM.stream({
              sessionID,
              model: gatewayModel,
              agent: { name: "test", mode: "primary", options: {}, permission: [] },
              user: {
                id: MessageID.make(`msg_prefix_${index}`),
                sessionID,
                role: "user",
                agent: "test",
                model: { providerID: gatewayModel.providerID, modelID: gatewayModel.id },
                time: { created: 0 },
              },
              system: ["Agent instructions.", "Skill catalogue."],
              environment: [...environment, ...hoisted],
              messages: [{ role: "user", content: "Continue." }],
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
          }
        },
      )

      expect(language.doStreamCalls).toHaveLength(2)
      const systems = language.doStreamCalls.map((call) => call.prompt.filter((message) => message.role === "system"))
      for (const system of systems) expect(system).toHaveLength(2)
      // The marked prefix (first system message) is byte-identical, cache marker included.
      expect(JSON.stringify(systems[1][0])).toBe(JSON.stringify(systems[0][0]))
      expect(JSON.stringify(systems[0][0].providerOptions)).toContain("ephemeral")
      expect(String(systems[1][0].content)).not.toContain("Original task")
      // The pin is in the trailing message only.
      expect(String(systems[0][1].content)).not.toContain("Original task")
      expect(String(systems[1][1].content)).toContain("Original task")
    } finally {
      for (const mock of mocks) mock.mockRestore()
    }
  })

  test("the loop passes hoisted reminders with the environment, never inside the system array", async () => {
    const src = await fs.readFile(path.join(__dirname, "../../src/session/prompt.ts"), "utf-8")
    const systemArray = src.slice(src.indexOf("const system = ["), src.indexOf("const completionInstruction"))
    expect(systemArray).not.toContain("...hoistedReminders")
    expect(src).toMatch(/environment: \[\.\.\.\(await SystemPrompt\.environment\(model\)\), \.\.\.hoistedReminders\]/)
  })
})
