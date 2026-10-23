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

describe("Session.getUsage — AI SDK v6 usage (inclusive input with inputTokenDetails)", () => {
  // Shape @ai-sdk/anthropic 3.x + ai 6 deliver for one cached agent step.
  const opusPricing = { input: 4, output: 20, cache: { read: 0.2, write: 5 } }
  const v6Step = {
    inputTokens: 31_767,
    inputTokenDetails: { noCacheTokens: 4, cacheReadTokens: 29_128, cacheWriteTokens: 2_635 },
    outputTokens: 256,
    cachedInputTokens: 29_128,
  }

  test("Anthropic: cached tokens are not also billed as uncached input", () => {
    const result = Session.getUsage({
      model: { ...fakeModel("@ai-sdk/anthropic"), cost: opusPricing },
      usage: v6Step as any,
      metadata: { anthropic: { cacheCreationInputTokens: 2_635 } } as any,
    })
    expect(result.tokens.input).toBe(4)
    expect(result.tokens.cache.read).toBe(29_128)
    expect(result.tokens.cache.write).toBe(2_635)
    expect(result.tokens.inputTotal).toBe(31_767)
    expect(result.tokens.total).toBe(31_767 + 256)
    // 4*4 + 256*20 + 29128*0.2 + 2635*5 per million; the old path charged all 31,767 at $4/M (≈ $0.151).
    expect(result.cost).toBeCloseTo(0.0241366, 7)
  })

  test("Bedrock: same inclusive shape is split the same way", () => {
    const result = Session.getUsage({
      model: fakeModel("@ai-sdk/amazon-bedrock"),
      usage: v6Step as any,
      metadata: { bedrock: { usage: { cacheWriteInputTokens: 2_635 } } } as any,
    })
    expect(result.tokens.input).toBe(4)
    expect(result.tokens.inputTotal).toBe(31_767)
  })

  test("cache writes count toward the over-200K price tier", () => {
    const tiered = { input: 1, output: 1, cache: { read: 0, write: 1 }, experimentalOver200K: { input: 2, output: 2, cache: { read: 0, write: 2 } } }
    const result = Session.getUsage({
      model: { ...fakeModel("@ai-sdk/anthropic"), cost: tiered },
      usage: { inputTokens: 210_000, inputTokenDetails: { noCacheTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 200_000 }, outputTokens: 0 } as any,
      metadata: { anthropic: { cacheCreationInputTokens: 200_000 } } as any,
    })
    // 10K uncached + 200K cache write at the over-200K rates of $2/M each.
    expect(result.cost).toBeCloseTo(0.42, 10)
  })

  test("full cache hit reports zero uncached input", () => {
    const result = Session.getUsage({
      model: fakeModel("@ai-sdk/anthropic"),
      usage: { inputTokens: 8_000, inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 8_000, cacheWriteTokens: 0 }, outputTokens: 10 } as any,
      metadata: { anthropic: { cacheCreationInputTokens: 0 } } as any,
    })
    expect(result.tokens.input).toBe(0)
    expect(result.tokens.inputTotal).toBe(8_000)
  })

  test("OpenAI v6 shape without cache write matches the legacy subtraction", () => {
    const result = Session.getUsage({
      model: fakeModel("@ai-sdk/openai"),
      usage: { inputTokens: 5_000, inputTokenDetails: { noCacheTokens: 3_000, cacheReadTokens: 2_000 }, outputTokens: 10, totalTokens: 5_010 } as any,
    })
    expect(result.tokens.input).toBe(3_000)
    expect(result.tokens.cache.write).toBe(0)
    expect(result.tokens.inputTotal).toBe(5_000)
  })

  test("cache write comes from inputTokenDetails when provider metadata lacks it", () => {
    const result = Session.getUsage({
      model: fakeModel("@ai-sdk/anthropic"),
      usage: v6Step as any,
      metadata: { anthropic: {} } as any,
    })
    expect(result.tokens.cache.write).toBe(2_635)
    expect(result.tokens.input).toBe(4)
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
