import { describe, test, expect } from "bun:test"
import { Session } from "../../src/session"

/**
 * Tests for Session.getUsage — pins the cross-provider token normalization.
 *
 * Background: telemetry-2026-05-21 flagged "Anthropic tokens_input=0 broken"
 * across 54k Sonnet generations. Investigation showed it was a measurement
 * artifact: `tokens_input` is uncached-only by design (normalized across
 * providers), and full cache hits legitimately produce `tokens_input=0`. The
 * dashboard query should use `tokens_input_total` for inclusive volume.
 *
 * To make that semantics unambiguous, this PR (a) always emits
 * `tokens_input_total` and (b) tightens its type to `number` (was optional).
 * These tests pin the contract so future regressions are caught early.
 */

function fakeModel(npm = "@ai-sdk/anthropic"): any {
  return {
    id: "test-model",
    providerID: "test",
    api: { npm },
    cost: {},
  }
}

describe("Session.getUsage — Anthropic-style (uncached input)", () => {
  test("full cache hit produces tokens.input=0 and matching tokens.inputTotal", () => {
    const result = Session.getUsage({
      model: fakeModel("@ai-sdk/anthropic"),
      usage: {
        inputTokens: 0,
        outputTokens: 200,
        cachedInputTokens: 8000,
      } as any,
      metadata: { anthropic: { cacheCreationInputTokens: 0 } } as any,
    })

    expect(result.tokens.input).toBe(0)
    // inputTotal must include the cached read so dashboard queries are accurate.
    expect(result.tokens.inputTotal).toBe(8000)
    expect(result.tokens.cache.read).toBe(8000)
    expect(result.tokens.output).toBe(200)
  })

  test("partial cache hit sums uncached + cached for inputTotal", () => {
    const result = Session.getUsage({
      model: fakeModel("@ai-sdk/anthropic"),
      usage: {
        inputTokens: 1500, // uncached
        outputTokens: 100,
        cachedInputTokens: 6000, // cache read
      } as any,
      metadata: { anthropic: { cacheCreationInputTokens: 2000 } } as any, // cache write
    })

    expect(result.tokens.input).toBe(1500)
    expect(result.tokens.inputTotal).toBe(1500 + 6000 + 2000)
    expect(result.tokens.cache.read).toBe(6000)
    expect(result.tokens.cache.write).toBe(2000)
  })

  test("no cache at all leaves inputTotal === input", () => {
    const result = Session.getUsage({
      model: fakeModel("@ai-sdk/anthropic"),
      usage: { inputTokens: 5000, outputTokens: 50 } as any,
      metadata: { anthropic: {} } as any,
    })

    expect(result.tokens.input).toBe(5000)
    expect(result.tokens.inputTotal).toBe(5000)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
  })
})

describe("Session.getUsage — OpenAI-style (inclusive input)", () => {
  test("subtracts cached tokens from inputTokens to derive uncached input", () => {
    // OpenAI/OpenRouter return inputTokens as the inclusive total.
    // tokens.input should be uncached only (parity with Anthropic).
    const result = Session.getUsage({
      model: fakeModel("@ai-sdk/openai"),
      usage: {
        inputTokens: 7500, // inclusive total
        outputTokens: 100,
        cachedInputTokens: 6000, // subset
      } as any,
      metadata: {} as any,
    })

    expect(result.tokens.input).toBe(1500) // 7500 - 6000
    expect(result.tokens.inputTotal).toBe(7500)
    expect(result.tokens.cache.read).toBe(6000)
  })

  test("no cache: input === inputTokens === inputTotal", () => {
    const result = Session.getUsage({
      model: fakeModel("@ai-sdk/openai"),
      usage: { inputTokens: 4000, outputTokens: 200 } as any,
      metadata: {} as any,
    })

    expect(result.tokens.input).toBe(4000)
    expect(result.tokens.inputTotal).toBe(4000)
  })

  test("OpenAI cache_write is always 0 (provider doesn't expose the concept)", () => {
    // Doc-block claim: "OpenAI / OpenRouter don't surface a cache_write concept".
    // Verify the subtraction is a no-op rather than producing wrong numbers.
    const result = Session.getUsage({
      model: fakeModel("@ai-sdk/openai"),
      usage: {
        inputTokens: 5000,
        outputTokens: 100,
        cachedInputTokens: 2000,
      } as any,
      metadata: {} as any, // no anthropic / bedrock / venice metadata
    })

    expect(result.tokens.cache.write).toBe(0)
    expect(result.tokens.input).toBe(3000) // 5000 - 2000 - 0
    expect(result.tokens.inputTotal).toBe(5000)
  })
})

describe("Session.getUsage — provider edge cases", () => {
  test("@ai-sdk/google-vertex/anthropic uses Anthropic-style accounting (per total branch)", () => {
    // The `total` computation at session/index.ts:828 includes this NPM as
    // Anthropic-shaped. If `metadata.anthropic` is present (which the Vertex
    // adapter does set for Claude calls), the excludesCachedTokens check
    // routes through the Anthropic branch.
    const result = Session.getUsage({
      model: fakeModel("@ai-sdk/google-vertex/anthropic"),
      usage: {
        inputTokens: 1000, // uncached only
        outputTokens: 50,
        cachedInputTokens: 4000,
      } as any,
      metadata: { anthropic: { cacheCreationInputTokens: 500 } } as any,
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.inputTotal).toBe(1000 + 4000 + 500)
    expect(result.tokens.cache.read).toBe(4000)
    expect(result.tokens.cache.write).toBe(500)
  })

  test("Venice surfaces cacheCreationInputTokens via metadata.venice.usage", () => {
    // Venice's cache_write lives at metadata.venice.usage.cacheCreationInputTokens —
    // the third metadata path the reader at session/index.ts:815 supports.
    // Venice uses OpenAI-style inclusive inputTokens (not the Anthropic
    // exclusive style), so the subtraction branch should run.
    const result = Session.getUsage({
      model: fakeModel("@ai-sdk/openai"), // Venice exposes an OpenAI-compatible surface
      usage: {
        inputTokens: 5000, // inclusive
        outputTokens: 80,
        cachedInputTokens: 1500,
      } as any,
      metadata: { venice: { usage: { cacheCreationInputTokens: 400 } } } as any,
    })

    expect(result.tokens.cache.write).toBe(400)
    expect(result.tokens.cache.read).toBe(1500)
    expect(result.tokens.input).toBe(5000 - 1500 - 400) // 3100
    expect(result.tokens.inputTotal).toBe(5000)
  })

  test("Bedrock surfaces cacheWriteInputTokens via metadata.bedrock.usage", () => {
    // Bedrock's cache_write lives at a different metadata path than Anthropic's.
    // Pin that the reader at session/index.ts:813 picks it up.
    const result = Session.getUsage({
      model: fakeModel("@ai-sdk/amazon-bedrock"),
      usage: {
        inputTokens: 800,
        outputTokens: 40,
        cachedInputTokens: 2000,
      } as any,
      metadata: { bedrock: { usage: { cacheWriteInputTokens: 600 } } } as any,
    })

    expect(result.tokens.input).toBe(800)
    expect(result.tokens.cache.read).toBe(2000)
    expect(result.tokens.cache.write).toBe(600)
    expect(result.tokens.inputTotal).toBe(800 + 2000 + 600)
  })

  test("tokens.input is clamped to zero on inconsistent provider counts (no negative cost)", () => {
    // Hypothetical: OpenAI returns inputTokens=1000 but cachedInputTokens=2000
    // (inconsistent — should never happen, but providers occasionally surface
    // weird numbers). Without clamping, tokens.input would be -1000 and
    // cost = tokens.input × costInfo.input would be negative, leaking a
    // negative-cost outlier into telemetry and session totals.
    //
    // The fix (Math.max(0, ...) around adjustedInputTokens) clamps input to
    // zero so cost stays non-negative. The invariant `input + cache.read +
    // cache.write === inputTotal` still holds — just at the clamped value
    // (0 + 2000 + 0 = 2000), not the algebraic value (-1000 + 2000 + 0 = 1000).
    const result = Session.getUsage({
      model: fakeModel("@ai-sdk/openai"),
      usage: {
        inputTokens: 1000,
        outputTokens: 50,
        cachedInputTokens: 2000,
      } as any,
      metadata: {} as any,
    })

    expect(result.tokens.input).toBe(0)
    expect(result.tokens.input + result.tokens.cache.read + result.tokens.cache.write).toBe(
      result.tokens.inputTotal,
    )
    expect(result.tokens.inputTotal).toBe(2000)
    // Cost must be non-negative — this is the actual user-facing concern.
    expect(result.cost).toBeGreaterThanOrEqual(0)
  })
})

describe("Session.getUsage — invariant", () => {
  test("input + cache.read + cache.write === inputTotal for cache-using calls", () => {
    for (const npm of ["@ai-sdk/anthropic", "@ai-sdk/openai", "@ai-sdk/amazon-bedrock"] as const) {
      const result = Session.getUsage({
        model: fakeModel(npm),
        usage: {
          inputTokens: npm === "@ai-sdk/openai" ? 5000 : 1000, // OpenAI: inclusive
          outputTokens: 100,
          cachedInputTokens: 3000,
        } as any,
        metadata: { anthropic: { cacheCreationInputTokens: 1000 } } as any,
      })

      expect(result.tokens.input + result.tokens.cache.read + result.tokens.cache.write).toBe(
        result.tokens.inputTotal,
      )
    }
  })

  test("inputTotal is always a finite non-negative number", () => {
    const result = Session.getUsage({
      model: fakeModel("@ai-sdk/anthropic"),
      usage: {} as any, // all fields missing
      metadata: undefined,
    })

    expect(Number.isFinite(result.tokens.inputTotal)).toBe(true)
    expect(result.tokens.inputTotal).toBeGreaterThanOrEqual(0)
  })
})
