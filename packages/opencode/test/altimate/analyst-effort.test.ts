import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { createAnthropic } from "@ai-sdk/anthropic"
import { ANALYST_EFFORT_ENV, analystEffortOptions } from "@/altimate/session/analyst-effort"
import { begin, downgradeEffort } from "@/altimate/session/run-budget-effort"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { ProviderTransform } from "@/provider/transform"
import { Session } from "@/session"
import { LLM } from "@/session/llm"
import { MessageID, SessionID } from "@/session/schema"

function model(npm: string, id: string): Provider.Model {
  const result: Provider.Model = {
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
    release_date: "2026-01-01",
    options: {},
    headers: {},
    variants: {},
  }
  result.variants = ProviderTransform.variants(result)
  return result
}

const analyst = { name: "analyst", options: {} }
const opus = model("@ai-sdk/anthropic", "claude-opus-5-5")

afterEach(() => {
  delete process.env[ANALYST_EFFORT_ENV]
})

describe("analyst default reasoning effort", () => {
  test("adaptive Claude models get high effort with summarized adaptive thinking", () => {
    expect(analystEffortOptions({ agent: analyst, model: opus })).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      effort: "high",
    })
    expect(
      analystEffortOptions({ agent: analyst, model: model("@ai-sdk/amazon-bedrock", "anthropic.claude-opus-5-5") }),
    ).toMatchObject({ reasoningConfig: { type: "adaptive", maxReasoningEffort: "high" } })
  })

  test.each([
    ["an older Claude model", model("@ai-sdk/anthropic", "claude-sonnet-4-20250514")],
    ["an OpenAI model", model("@ai-sdk/openai", "gpt-5.2")],
    ["a Gemini model", model("@ai-sdk/google", "gemini-3-pro")],
  ])("adds nothing for %s", (_, other) => {
    expect(analystEffortOptions({ agent: analyst, model: other })).toEqual({})
  })

  test("other agents, small requests, explicit variants and agent options keep their settings", () => {
    expect(analystEffortOptions({ agent: { name: "builder", options: {} }, model: opus })).toEqual({})
    expect(analystEffortOptions({ agent: analyst, model: opus, small: true })).toEqual({})
    expect(analystEffortOptions({ agent: analyst, model: opus, variant: "low" })).toEqual({})
    expect(analystEffortOptions({ agent: { name: "analyst", options: { effort: "max" } }, model: opus })).toEqual({})
  })

  test("the environment selects another effort or disables the default", () => {
    process.env[ANALYST_EFFORT_ENV] = "XHIGH"
    expect(analystEffortOptions({ agent: analyst, model: opus })).toMatchObject({ effort: "xhigh" })
    process.env[ANALYST_EFFORT_ENV] = "off"
    expect(analystEffortOptions({ agent: analyst, model: opus })).toEqual({})
    process.env[ANALYST_EFFORT_ENV] = "unknown"
    expect(analystEffortOptions({ agent: analyst, model: opus })).toEqual({})
  })
})

describe("analyst effort in the outgoing request", () => {
  async function request(input: { agent: string; model: Provider.Model; downgrade?: boolean }) {
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
              model: input.model.api.id,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
          { type: "message_stop" },
        ]
        return new Response(chunks.map((chunk) => `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`).join(""), {
          headers: { "Content-Type": "text/event-stream" },
        })
      }) as typeof fetch,
    })(input.model.api.id)
    const spies = [
      spyOn(Provider, "getLanguage").mockResolvedValue(language),
      spyOn(Provider, "getProvider").mockResolvedValue({ id: input.model.providerID, options: {} } as Provider.Info),
      spyOn(Config, "get").mockResolvedValue({ tracing: { enabled: false } }),
      spyOn(Auth, "get").mockResolvedValue(undefined),
      spyOn(Session, "get").mockImplementation((async (id) => ({ id }) as Session.Info) as typeof Session.get),
      spyOn(Plugin, "trigger").mockImplementation(async (_name, _input, output) => output),
    ]
    const sessionID = SessionID.make(`ses_analyst_effort_${input.agent}_${input.downgrade ? "downgrade" : "default"}`)
    const end = input.downgrade ? begin(sessionID) : undefined
    if (input.downgrade) downgradeEffort(sessionID)
    try {
      const stream = await LLM.stream({
        sessionID,
        user: {
          id: MessageID.make("msg_analyst_effort_test"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: input.agent,
          model: { providerID: input.model.providerID, modelID: input.model.id },
        },
        model: input.model,
        agent: { name: input.agent, mode: "primary", options: {}, permission: [] },
        system: [],
        abort: new AbortController().signal,
        messages: [{ role: "user", content: "How many?" }],
        tools: {},
      })
      for await (const _event of stream.fullStream) {
        /* drain the SDK stream */
      }
      expect(requests).toHaveLength(1)
      return requests[0]!
    } finally {
      end?.()
      for (const spy of spies) spy.mockRestore()
    }
  }

  test("an Opus-5.5-style analyst request carries high effort and adaptive thinking", async () => {
    const body = await request({ agent: "analyst", model: opus })
    expect(body.output_config?.effort).toBe("high")
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" })
  })

  test("other agents and older models send no effort", async () => {
    expect((await request({ agent: "builder", model: opus })).output_config?.effort).toBeUndefined()
    const older = await request({ agent: "analyst", model: model("@ai-sdk/anthropic", "claude-sonnet-4-20250514") })
    expect(older.output_config?.effort).toBeUndefined()
    expect(older.thinking).toBeUndefined()
  })

  test("the time-budget downgrade still lowers the analyst effort", async () => {
    const body = await request({ agent: "analyst", model: opus, downgrade: true })
    expect(body.output_config?.effort).toBe("low")
  })
})
