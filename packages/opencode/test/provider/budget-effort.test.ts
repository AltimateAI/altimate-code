// altimate_change start — run budgets must override configured reasoning options with provider-supported minima
import { describe, expect, spyOn, test } from "bun:test"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createAnthropic } from "@ai-sdk/anthropic"
import type { ModelMessage } from "ai"
import { applyBudgetEffort } from "@/altimate/session/budget-effort"
import { begin, downgradeEffort } from "@/altimate/session/run-budget-effort"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { ModelID, ProviderID } from "@/provider/schema"
import { LLM } from "@/session/llm"
import { SessionID, MessageID } from "@/session/schema"
import { Session } from "@/session"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"
import { Auth } from "@/auth"

function model(npm: string, id: string): Provider.Model {
  return {
    id: ModelID.make(id),
    providerID: ProviderID.make("test"),
    api: { npm, id, url: "https://example.invalid" },
    name: id,
    capabilities: {
      reasoning: true,
      temperature: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 200_000, output: 32_000 },
    status: "active",
    release_date: "2025-01-01",
    options: {},
    headers: {},
    variants: { high: { reasoningEffort: "high" }, low: { reasoningEffort: "high" } },
  }
}

describe("run budget reasoning effort", () => {
  test.each([
    ["@ai-sdk/openai", "o3", "low"],
    ["@ai-sdk/openai", "gpt-5", "minimal"],
    ["@ai-sdk/openai", "gpt-5.2", "low"],
    ["@ai-sdk/openai", "gpt-5.2-pro", "medium"],
    ["@ai-sdk/openai", "gpt-5-pro", "high"],
    ["@ai-sdk/azure", "o3", "low"],
    ["@ai-sdk/amazon-bedrock/mantle", "gpt-5", "minimal"],
  ])("%s / %s uses accepted effort %s independently of custom variants", (npm, id, effort) => {
    const configured = { reasoningEffort: "high", store: false }
    expect(applyBudgetEffort(model(npm, id), configured)).toMatchObject({ reasoningEffort: effort, store: false })
    expect(configured).toEqual({ reasoningEffort: "high", store: false })
  })

  test("OpenRouter replaces an existing token budget as well as high effort", () => {
    const resolved = model("@openrouter/ai-sdk-provider", "openai/gpt-5")
    const options = applyBudgetEffort(resolved, { reasoning: { effort: "high", max_tokens: 16_000 } })
    expect(ProviderTransform.providerOptions(resolved, options)).toEqual({
      openrouter: { reasoning: { effort: "minimal" } },
    })
  })

  test.each(["claude-sonnet-4-5", "claude-opus-4-6"])(
    "Anthropic %s disables thinking without retaining its old budget",
    (id) => {
      const resolved = model("@ai-sdk/anthropic", id)
      const options = applyBudgetEffort(resolved, {
        thinking: { type: "enabled", budgetTokens: 16_000 },
        effort: "high",
      })
      expect(options.thinking).toEqual({ type: "disabled" })
      expect(options.effort).toBe(id.includes("4-6") ? "low" : undefined)
    },
  )

  test("Bedrock Claude disables raw thinking overrides as well as reasoningConfig", () => {
    const resolved = model("@ai-sdk/amazon-bedrock", "us.anthropic.claude-opus-4-6-v1:0")
    expect(
      applyBudgetEffort(resolved, {
        reasoningConfig: { type: "adaptive", maxReasoningEffort: "high", budgetTokens: 16_000 },
        additionalModelRequestFields: {
          thinking: { type: "enabled", budget_tokens: 16_000 },
          output_config: { effort: "high" },
          keep: true,
        },
      }),
    ).toEqual({
      reasoningConfig: { type: "disabled", maxReasoningEffort: "low" },
      additionalModelRequestFields: { thinking: { type: "disabled" }, output_config: { effort: "low" }, keep: true },
    })
  })

  test("Bedrock Nova lowers effort and removes an old fixed budget", () => {
    expect(
      applyBudgetEffort(model("@ai-sdk/amazon-bedrock", "amazon.nova-2-lite-v1:0"), {
        reasoningConfig: { type: "enabled", maxReasoningEffort: "high", budgetTokens: 16_000 },
      }),
    ).toEqual({ reasoningConfig: { type: "enabled", maxReasoningEffort: "low" } })
  })

  test.each([
    ["gemini-2.5-pro", { thinkingBudget: 128 }],
    ["gemini-2.5-flash", { thinkingBudget: 0 }],
    ["gemini-3-pro", { includeThoughts: true, thinkingLevel: "low" }],
    ["gemini-3-flash", { includeThoughts: true, thinkingLevel: "minimal" }],
  ])("Google %s uses its lowest supported thinking setting", (id, expected) => {
    expect(
      applyBudgetEffort(model("@ai-sdk/google", id), {
        thinkingConfig: { thinkingBudget: 16_000, thinkingLevel: "high" },
      }).thinkingConfig,
    ).toEqual(expected)
  })

  test("models without a reasoning control preserve their options", () => {
    const resolved = model("@ai-sdk/cohere", "command-r")
    const options = { unrelated: true }
    expect(applyBudgetEffort(resolved, options)).toBe(options)
    resolved.capabilities.reasoning = false
    expect(applyBudgetEffort(resolved, options)).toBe(options)
  })

  test("Mistral adjustable reasoning can be disabled even though its only configured variant is high", () => {
    const resolved = model("@ai-sdk/mistral", "mistral-medium-3.5")
    expect(applyBudgetEffort(resolved, { reasoningEffort: "high" })).toEqual({ reasoningEffort: "none" })
  })

  test("the actual SDK request overrides the plugin effort until the run ends", async () => {
    const resolved = model("@ai-sdk/openai-compatible", "o3")
    const requests: Record<string, unknown>[] = []
    const language = createOpenAICompatible({
      name: "test",
      baseURL: "https://unused.invalid/v1",
      fetch: (async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)))
        const chunk = {
          id: "response",
          choices: [{ index: 0, delta: { content: "Final answer" }, finish_reason: "stop" }],
        }
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          headers: { "Content-Type": "text/event-stream" },
        })
      }) as typeof fetch,
    }).chatModel("o3")
    const sessionID = SessionID.make("ses_budget_effort_provider_test")
    const childID = SessionID.make("ses_budget_effort_provider_child_test")
    const spies = [
      spyOn(Provider, "getLanguage").mockResolvedValue(language),
      spyOn(Provider, "getProvider").mockResolvedValue({ id: resolved.providerID, options: {} } as Provider.Info),
      spyOn(Config, "get").mockResolvedValue({ tracing: { enabled: false } }),
      spyOn(Auth, "get").mockResolvedValue(undefined),
      spyOn(Session, "get").mockImplementation(
        (async (id) =>
          ({ id, parentID: id === childID ? sessionID : undefined }) as Session.Info) as typeof Session.get,
      ),
      spyOn(Plugin, "trigger").mockImplementation(async (name, _input, output) => {
        if (name === "chat.params") (output as { options: Record<string, unknown> }).options.reasoningEffort = "high"
        return output
      }),
    ]
    const end = begin(sessionID)
    const request = async (sessionID = SessionID.make("ses_budget_effort_provider_test")) => {
      const stream = await LLM.stream({
        sessionID,
        user: {
          id: MessageID.make("msg_budget_effort_provider_test"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: resolved.providerID, modelID: resolved.id },
          variant: "high",
        },
        model: resolved,
        agent: { name: "test", mode: "primary", options: {}, permission: [] },
        system: [],
        abort: new AbortController().signal,
        messages: [{ role: "user", content: "Answer now." }],
        tools: {},
      })
      for await (const _event of stream.fullStream) {
        /* drain the actual SDK stream */
      }
    }
    try {
      await request()
      downgradeEffort(sessionID)
      await request()
      await request() // finalization uses the same session override
      await request(childID)
      await request(SessionID.make("ses_budget_effort_unrelated_test"))
      end()
      await request()
      await request(childID)
      expect(requests.map((body) => body.reasoning_effort)).toEqual([
        "high",
        "low",
        "low",
        "low",
        "high",
        "high",
        "high",
      ])
      expect(resolved.variants?.high).toEqual({ reasoningEffort: "high" })
    } finally {
      end()
      for (const spy of spies) spy.mockRestore()
    }
  })

  test.each(["downgraded", "active", "none"] as const)(
    "Anthropic interrupted reasoning resumes without empty assistant content (%s budget)",
    async (budget) => {
      const downgrade = budget === "downgraded"
      const resolved = model("@ai-sdk/anthropic", "claude-opus-4-6")
      resolved.variants = ProviderTransform.variants(resolved)
      const requests: Record<string, any>[] = []
      const language = createAnthropic({
        apiKey: "test-key",
        fetch: (async (_url, init) => {
          requests.push(JSON.parse(String(init?.body)))
          const chunks = [
            {
              type: "message_start",
              message: {
                id: "msg_answer",
                type: "message",
                role: "assistant",
                model: resolved.api.id,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 0 },
              },
            },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Final answer" } },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 2 },
            },
            { type: "message_stop" },
          ]
          return new Response(
            chunks.map((chunk) => `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`).join(""),
            {
              headers: { "Content-Type": "text/event-stream" },
            },
          )
        }) as typeof fetch,
      })(resolved.api.id)
      const spies = [
        spyOn(Provider, "getLanguage").mockResolvedValue(language),
        spyOn(Provider, "getProvider").mockResolvedValue({ id: resolved.providerID, options: {} } as Provider.Info),
        spyOn(Config, "get").mockResolvedValue({ tracing: { enabled: false } }),
        spyOn(Auth, "get").mockResolvedValue(undefined),
        spyOn(Session, "get").mockImplementation((async (id) => ({ id }) as Session.Info) as typeof Session.get),
        spyOn(Plugin, "trigger").mockImplementation(async (_name, _input, output) => output),
      ]
      const sessionID = SessionID.make("ses_budget_effort_anthropic_test")
      const end = budget === "none" ? undefined : begin(sessionID)
      if (downgrade) downgradeEffort(sessionID)
      const messages: ModelMessage[] = [
        { role: "user", content: "Investigate." },
        { role: "assistant", content: [{ type: "reasoning", text: "An unfinished thought" }] },
        { role: "user", content: "Answer now." },
      ]
      try {
        const stream = await LLM.stream({
          sessionID,
          user: {
            id: MessageID.make("msg_budget_effort_anthropic_test"),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: "test",
            model: { providerID: resolved.providerID, modelID: resolved.id },
            variant: "high",
          },
          model: resolved,
          agent: { name: "test", mode: "primary", options: {}, permission: [] },
          system: [],
          abort: new AbortController().signal,
          messages,
          tools: {},
        })
        for await (const _event of stream.fullStream) {
          /* drain the actual SDK stream */
        }
        expect(requests).toHaveLength(1)
        if (downgrade) expect(requests[0]!.thinking).toBeUndefined()
        else expect(requests[0]!.thinking).toEqual({ type: "adaptive" })
        expect(requests[0]!.output_config.effort).toBe(downgrade ? "low" : "high")
        expect(
          requests[0]!.messages.some((message: any) => message.role === "assistant" && message.content.length === 0),
        ).toBe(false)
        expect(messages[1]!.content).toEqual([{ type: "reasoning", text: "An unfinished thought" }])
      } finally {
        end?.()
        for (const spy of spies) spy.mockRestore()
      }
    },
  )
})
// altimate_change end
