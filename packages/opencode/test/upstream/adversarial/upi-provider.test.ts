import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Session } from "../../../src/session"
import { LLM } from "../../../src/session/llm"
import { SystemPrompt } from "../../../src/session/system"
import { familyVendor } from "../../../src/provider/family"

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..", "..")
const providerSource = path.join(repoRoot, "packages", "opencode", "src", "provider", "provider.ts")

function model(overrides: Record<string, any> = {}) {
  return {
    providerID: "test-provider",
    id: "test-model",
    name: "Test Model",
    family: "openai",
    api: { id: "test-model", npm: "@ai-sdk/openai", url: "" },
    headers: {},
    options: {},
    cost: { input: 1, output: 2, cache: { read: 0.5, write: 0.25 } },
    limit: { context: 400000, output: 8192 },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    variants: {},
    ...overrides,
  } as any
}

function gatewayModel(family: string | undefined) {
  return model({
    providerID: "altimate-backend",
    id: "altimate-default",
    family,
    api: { id: "altimate-default", npm: "@ai-sdk/openai-compatible", url: "" },
  })
}

describe("UPI-20 historical tool stubs preserve provider invariants", () => {
  test("toolNamesFromMessages collects historical tool-call and tool-result names once", () => {
    const names = LLM.toolNamesFromMessages([
      { role: "user", content: "plain text" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "hi" },
          { type: "tool-call", toolName: "read_file" },
          { type: "tool-result", toolName: "read_file" },
          { type: "tool-result", toolName: "mcp_server_tool" },
        ],
      },
    ] as any)

    expect([...names].sort()).toEqual(["mcp_server_tool", "read_file"])
  })

  test("toolNamesFromMessages rejects tampered names outside provider-safe characters and length", () => {
    const max64 = "a".repeat(64)
    const tooLong = "b".repeat(65)
    const names = LLM.toolNamesFromMessages([
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolName: max64 },
          { type: "tool-call", toolName: tooLong },
          { type: "tool-call", toolName: "bad;rm -rf" },
          { type: "tool-result", toolName: "ansi\u001b[31m" },
          { type: "tool-call", toolName: "safe-name_1" },
        ],
      },
    ] as any)

    expect(names.has(max64)).toBe(true)
    expect(names.has("safe-name_1")).toBe(true)
    expect(names.has(tooLong)).toBe(false)
    expect(names.has("bad;rm -rf")).toBe(false)
    expect([...names].some((name) => name.includes("\u001b"))).toBe(false)
  })
})

describe("UPI-21 usage and cost accounting across AI SDK v6 shapes", () => {
  test("OpenAI-like cached input tokens subtract from billable input and never go negative", async () => {
    const usage = await Session.getUsage({
      model: model(),
      usage: { inputTokens: 100, cachedInputTokens: 150, outputTokens: 10, reasoningTokens: 5, totalTokens: 115 } as any,
      metadata: {},
    })

    expect(usage.tokens.input).toBe(0)
    expect(usage.tokens.inputTotal).toBe(150)
    expect(usage.tokens.cache.read).toBe(150)
    expect(usage.cost).toBeGreaterThanOrEqual(0)
  })

  test("Anthropic-style metadata does not subtract cached reads from inputTokens a second time", async () => {
    const usage = await Session.getUsage({
      model: model({ api: { id: "claude", npm: "@ai-sdk/anthropic", url: "" } }),
      usage: { inputTokens: 100, cachedInputTokens: 25, outputTokens: 10, reasoningTokens: 5 } as any,
      metadata: { anthropic: {} } as any,
    })

    expect(usage.tokens.input).toBe(100)
    expect(usage.tokens.inputTotal).toBe(125)
    expect(usage.tokens.total).toBe(135)
  })

  test("reasoning tokens are billed at the output rate", async () => {
    const usage = await Session.getUsage({
      model: model({ cost: { input: 0, output: 2, cache: { read: 0, write: 0 } } }),
      usage: { inputTokens: 0, outputTokens: 3, reasoningTokens: 7, totalTokens: 10 } as any,
      metadata: {},
    })

    expect(usage.cost).toBe((3 * 2 + 7 * 2) / 1_000_000)
  })

  test("over-200K pricing applies when billable input plus cache reads crosses the boundary", async () => {
    const usage = await Session.getUsage({
      model: model({
        cost: {
          input: 1,
          output: 2,
          cache: { read: 0.5, write: 0.25 },
          experimentalOver200K: { input: 10, output: 20, cache: { read: 5, write: 2.5 } },
        },
      }),
      usage: { inputTokens: 200_100, cachedInputTokens: 10, outputTokens: 1, totalTokens: 200_111 } as any,
      metadata: {},
    })

    expect(usage.tokens.input).toBe(200_090)
    expect(usage.cost).toBe((200_090 * 10 + 1 * 20 + 10 * 5) / 1_000_000)
  })

  // BUG: for non-Anthropic providers, getUsage returns usage.totalTokens directly.
  // Non-finite component counts are clamped, but a non-finite totalTokens still
  // leaks into tokens.total.
  test.todo("non-finite totalTokens is clamped consistently with component counts", async () => {
    const usage = await Session.getUsage({
      model: model(),
      usage: {
        inputTokens: Number.POSITIVE_INFINITY,
        cachedInputTokens: Number.NaN,
        outputTokens: Number.NEGATIVE_INFINITY,
        reasoningTokens: Number.NaN,
        totalTokens: Number.NaN,
      } as any,
      metadata: {},
    })

    expect(Number.isFinite(usage.tokens.total)).toBe(true)
    expect(usage.tokens.total).toBe(0)
  })
})

describe("UPI-16 and UPI-42 provider defaults and gateway prompt routing", () => {
  test("familyVendor maps specific gateway families to vendor prompt buckets", () => {
    expect(familyVendor("claude-sonnet")).toBe("anthropic")
    expect(familyVendor("claude-haiku")).toBe("anthropic")
    expect(familyVendor("gemini-pro")).toBe("gemini")
    expect(familyVendor("gpt-codex")).toBe("openai")
    expect(familyVendor("unknown-family")).toBeUndefined()
  })

  test("altimate-backend prompt routing matches canonical vendor routes by family", () => {
    expect(SystemPrompt.provider(gatewayModel("claude-sonnet"))[0]).toBe(
      SystemPrompt.provider(model({ providerID: "anthropic", api: { id: "claude-sonnet-4", npm: "@ai-sdk/anthropic", url: "" } }))[0],
    )
    expect(SystemPrompt.provider(gatewayModel("gemini-pro"))[0]).toBe(
      SystemPrompt.provider(model({ providerID: "google", api: { id: "gemini-3-pro", npm: "@ai-sdk/google", url: "" } }))[0],
    )
    expect(SystemPrompt.provider(gatewayModel("unknown-family"))[0]).toBe(
      SystemPrompt.provider(model({ providerID: "openai", api: { id: "gpt-5", npm: "@ai-sdk/openai", url: "" } }))[0],
    )
  })

  test("defaultModel keeps explicit config and recent-model precedence before altimate-backend fallback", async () => {
    const source = await fs.readFile(providerSource, "utf-8")
    const body = source.slice(source.indexOf("export async function defaultModel()"), source.indexOf("export function parseModel"))

    expect(body.indexOf("if (cfg.model) return parseModel(cfg.model)")).toBeLessThan(
      body.indexOf("default to altimate-backend"),
    )
    expect(body.indexOf("for (const entry of recent)")).toBeLessThan(body.indexOf("default to altimate-backend"))
    expect(body).toContain('providers[altimateProviderID]')
    expect(body).toContain('ModelID.make("altimate-default")')
    // altimate_change start — the managed-consent-aware allowlist helper owns this check now
    expect(body).toContain("providerAllowed(String(altimateProviderID))")
    // altimate_change end
  })
})
