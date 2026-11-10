import { describe, expect, test } from "bun:test"
import type { AccountInfo } from "@anthropic-ai/claude-agent-sdk"
import { ClaudeAgent } from "@/altimate/provider/claude-agent"
import { ClaudeAgentCatalog } from "@/altimate/provider/claude-agent/catalog"
import type { ClaudeProbe } from "@/altimate/provider/claude-agent/claude/probe"
import { RequestKind } from "@/altimate/provider/claude-agent/language-model/request-kind"
import { ClaudeSystemPrompt } from "@/altimate/provider/claude-agent/language-model/system-prompt"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"

const subscription: AccountInfo = { subscriptionType: "Claude Max", apiProvider: "firstParty" } as AccountInfo
const apiKey: AccountInfo = { apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" } as AccountInfo

function probe(account: AccountInfo, models?: ClaudeProbe.Model[]): ClaudeProbe.Result {
  return {
    version: "2.1.322",
    account,
    models: models ?? [
      { value: "default", displayName: "Default", description: "", resolvedModel: "claude-opus-5-5" },
      {
        value: "opus",
        displayName: "Opus 5.5",
        description: "",
        supportedEffortLevels: ["low", "high"],
        resolvedModel: "claude-opus-5-5",
        contextWindow: 1_000_000,
      },
      { value: "haiku", displayName: "Haiku 5.5", description: "", resolvedModel: "claude-haiku-5-5" },
    ],
  }
}

const anthropicPrices = {
  anthropic: {
    models: {
      "claude-opus-5-5": {
        cost: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
        limit: { context: 1_000_000, output: 128_000 },
      } as Provider.Model,
    },
  },
}

describe("Claude Agent catalog", () => {
  test("lists Claude Code's aliases before any probe", async () => {
    const provider = ClaudeAgentCatalog.provider({ models: [] }, {})
    expect(Object.keys(provider.models)).toEqual(["opus", "sonnet", "haiku"])
    expect(provider.models.opus.api.npm).toBe(ClaudeAgent.PACKAGE)
    expect(provider.models.opus.cost.input).toBe(0)
  })

  test("a subscription shows no cost and drops Claude's moving default", async () => {
    await ClaudeAgentCatalog.update(probe(subscription), undefined)
    const catalog = await ClaudeAgentCatalog.load()
    expect(catalog.priceSource).toBeUndefined()
    const provider = ClaudeAgentCatalog.provider(catalog, anthropicPrices)
    expect(Object.keys(provider.models)).toEqual(["opus", "haiku"])
    expect(provider.models.opus.cost.input).toBe(0)
    expect(provider.models.opus.limit.context).toBe(1_000_000)
    expect(provider.models.opus.variants).toEqual({ low: { effort: "low" }, high: { effort: "high" } })
    expect(provider.models.haiku.family).toBe("claude-haiku")
  })

  test("an API key login is priced from Anthropic's catalog", async () => {
    await ClaudeAgentCatalog.update(probe(apiKey), undefined)
    const provider = ClaudeAgentCatalog.provider(await ClaudeAgentCatalog.load(), anthropicPrices)
    expect(provider.models.opus.cost.input).toBe(5)
    expect(provider.models.opus.limit.output).toBe(128_000)
  })

  test("a custom base URL shows no cost", async () => {
    await ClaudeAgentCatalog.update(probe(apiKey), "https://gateway.example.com")
    const catalog = await ClaudeAgentCatalog.load()
    expect(catalog.priceSource).toBeUndefined()
  })

  test("a chat's startup report keeps the context windows the full probe found", async () => {
    await ClaudeAgentCatalog.update(probe(subscription), undefined)
    const changed = await ClaudeAgentCatalog.update(
      probe(subscription, [{ value: "opus", displayName: "Opus 5.5", description: "", resolvedModel: "claude-opus-5-5" }]),
      undefined,
    )
    expect(changed).toBe(true)
    const catalog = await ClaudeAgentCatalog.load()
    expect(catalog.models[0]?.contextWindow).toBe(1_000_000)
  })

  test("variants come from the catalog, not the reasoning defaults", () => {
    const provider = ClaudeAgentCatalog.provider(
      { models: [{ id: "opus", name: "Opus", efforts: ["medium", "max"] }] },
      {},
    )
    expect(ProviderTransform.variants(provider.models.opus)).toEqual({
      medium: { effort: "medium" },
      max: { effort: "max" },
    })
  })
})

describe("Claude Agent requests", () => {
  test("chat turns carry the session, the agent role and the instructions, without empty sources", () => {
    const request = ClaudeAgent.request({
      sessionID: "ses_1",
      agent: "builder",
      agentPrompt: "You are the builder.",
      instructions: ["AGENTS.md rules", undefined, "  ", "skills"],
    })
    expect(request.headers).toEqual({ [RequestKind.HEADER]: "primary", [RequestKind.SESSION_HEADER]: "ses_1" })
    expect(request.options[ClaudeSystemPrompt.AGENT_OPTION]).toBe("You are the builder.")
    expect(request.options[ClaudeSystemPrompt.INSTRUCTIONS_OPTION]).toBe("AGENTS.md rules\n\nskills")
  })

  test("titles, summaries, compaction and small calls run as side calls with no session", () => {
    for (const agent of ["title", "summary", "compaction"]) {
      const request = ClaudeAgent.request({ sessionID: "ses_1", agent, instructions: [] })
      expect(request.headers).toEqual({ [RequestKind.HEADER]: "utility" })
    }
    const small = ClaudeAgent.request({ sessionID: "ses_1", agent: "builder", small: true, instructions: [] })
    expect(small.headers).toEqual({ [RequestKind.HEADER]: "utility" })
  })

  test("routing headers are lower-case, as the request header merge produces them", () => {
    const request = ClaudeAgent.request({ sessionID: "ses_1", agent: "builder", instructions: [] })
    for (const name of Object.keys(request.headers)) expect(name).toBe(name.toLowerCase())
  })
})

describe("Claude Agent connection settings", () => {
  test("the /connect marker never becomes ANTHROPIC_API_KEY", () => {
    const env = ClaudeAgent.connectionEnv({ apiKey: ClaudeAgent.AUTH_KEY, name: "claude-agent" })
    expect(env).toEqual({})
  })

  test("configured settings map to Claude Code variables", () => {
    const env = ClaudeAgent.connectionEnv({
      apiKey: "sk-ant-test",
      baseURL: "https://gateway.example.com",
      headers: { "x-team": "data" },
      body: { metadata: { team: "data" } },
    })
    expect(env).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-test",
      ANTHROPIC_BASE_URL: "https://gateway.example.com",
      ANTHROPIC_CUSTOM_HEADERS: "x-team: data",
      CLAUDE_CODE_EXTRA_BODY: JSON.stringify({ metadata: { team: "data" } }),
    })
  })

  test("only a model from this provider matches", () => {
    expect(ClaudeAgent.matches({ api: { npm: ClaudeAgent.PACKAGE } })).toBe(true)
    expect(ClaudeAgent.matches({ api: { npm: "@ai-sdk/anthropic" } })).toBe(false)
  })
})
