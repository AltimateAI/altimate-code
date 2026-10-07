import { describe, test, expect } from "bun:test"
import { Session } from "../../src/session"
import { accountUsage } from "../../src/altimate/learn/usage"

/**
 * Cost accounting for providers whose AI SDK adapter reports an INCLUSIVE `inputTokens`.
 *
 * AI SDK v6 (`ai` 6.x) normalizes `usage.inputTokens` to
 * `noCache + cacheRead + cacheWrite` for @ai-sdk/amazon-bedrock and
 * @ai-sdk/anthropic, and also exposes `usage.inputTokenDetails.noCacheTokens`.
 * The raw API counters (Bedrock Converse `inputTokens`, Anthropic `input_tokens`)
 * exclude cached tokens, which is what the `excludesCachedTokens` branch assumed.
 * Treating the inclusive number as uncached bills every cached token a second
 * time at the full input price.
 *
 * The field shapes below are taken from step-finish events recorded from a live
 * Bedrock Converse run (counts only, no content).
 */

const PRICE = { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }

function model(npm: string): any {
  return { id: "m", providerID: "p", api: { npm }, cost: PRICE }
}

/** Build the usage object the AI SDK hands to the processor for an Anthropic-family call. */
function inclusiveUsage(noCache: number, read: number, write: number, output: number) {
  const total = noCache + read + write
  return {
    inputTokens: total,
    outputTokens: output,
    totalTokens: total + output,
    cachedInputTokens: read,
    inputTokenDetails: { noCacheTokens: noCache, cacheReadTokens: read, cacheWriteTokens: write },
  } as any
}

describe("Session.getUsage - Bedrock Converse (inclusive inputTokens)", () => {
  const bedrock = (write: number) => ({ bedrock: { usage: { cacheWriteInputTokens: write } } }) as any

  test("no caching: input and output billed once", () => {
    const r = Session.getUsage({
      model: model("@ai-sdk/amazon-bedrock"),
      usage: inclusiveUsage(5000, 0, 0, 200),
      metadata: bedrock(0),
    })
    expect(r.tokens.input).toBe(5000)
    expect(r.tokens.inputTotal).toBe(5000)
    // (5000 * 3 + 200 * 15) / 1e6
    expect(r.cost).toBeCloseTo(0.018, 12)
  })

  test("cache write: written tokens are billed at the write price only", () => {
    // recorded: inputTokens 61363, cache write 61359, output 194
    const r = Session.getUsage({
      model: model("@ai-sdk/amazon-bedrock"),
      usage: inclusiveUsage(4, 0, 61359, 194),
      metadata: bedrock(61359),
    })
    expect(r.tokens.input).toBe(4)
    expect(r.tokens.cache.write).toBe(61359)
    expect(r.tokens.inputTotal).toBe(61363)
    expect(r.tokens.total).toBe(61363 + 194)
    // (4*3 + 194*15 + 61359*3.75) / 1e6
    expect(r.cost).toBeCloseTo(0.23301825, 12)
  })

  test("cache read: read tokens are billed at the read price only", () => {
    const r = Session.getUsage({
      model: model("@ai-sdk/amazon-bedrock"),
      usage: inclusiveUsage(4, 61359, 0, 352),
      metadata: bedrock(0),
    })
    expect(r.tokens.input).toBe(4)
    expect(r.tokens.cache.read).toBe(61359)
    // (4*3 + 352*15 + 61359*0.3) / 1e6
    expect(r.cost).toBeCloseTo((12 + 5280 + 18407.7) / 1e6, 12)
  })

  test("mix of uncached, cache read and cache write", () => {
    // recorded: inputTokens 63362, cache read 61359, cache write 2001, output 352
    const r = Session.getUsage({
      model: model("@ai-sdk/amazon-bedrock"),
      usage: inclusiveUsage(2, 61359, 2001, 352),
      metadata: bedrock(2001),
    })
    expect(r.tokens.input).toBe(2)
    expect(r.tokens.inputTotal).toBe(63362)
    expect(r.tokens.total).toBe(63362 + 352)
    // (2*3 + 352*15 + 61359*0.3 + 2001*3.75) / 1e6
    expect(r.cost).toBeCloseTo((6 + 5280 + 18407.7 + 7503.75) / 1e6, 12)
  })
})

describe("Session.getUsage - other providers are not changed", () => {
  test("direct Anthropic (inclusive inputTokens + inputTokenDetails) is billed once", () => {
    const r = Session.getUsage({
      model: model("@ai-sdk/anthropic"),
      usage: inclusiveUsage(10, 20000, 3000, 100),
      metadata: { anthropic: { cacheCreationInputTokens: 3000 } } as any,
    })
    expect(r.tokens.input).toBe(10)
    expect(r.cost).toBeCloseTo((10 * 3 + 100 * 15 + 20000 * 0.3 + 3000 * 3.75) / 1e6, 12)
  })

  test("OpenAI-style inclusive input without details still subtracts the cached part", () => {
    const r = Session.getUsage({
      model: model("@ai-sdk/openai"),
      usage: { inputTokens: 5000, outputTokens: 100, cachedInputTokens: 2000 } as any,
      metadata: {} as any,
    })
    expect(r.tokens.input).toBe(3000)
    expect(r.cost).toBeCloseTo((3000 * 3 + 100 * 15 + 2000 * 0.3) / 1e6, 12)
  })

  test("noCacheTokens is ignored off the Anthropic/Bedrock branch (arithmetic path wins)", () => {
    // Deliberately inconsistent noCacheTokens: only the existing subtraction may produce 3000.
    const r = Session.getUsage({
      model: model("@ai-sdk/openai"),
      usage: {
        inputTokens: 5000,
        outputTokens: 100,
        cachedInputTokens: 2000,
        inputTokenDetails: { noCacheTokens: 9999, cacheReadTokens: 2000, cacheWriteTokens: 0 },
      } as any,
      metadata: {} as any,
    })
    expect(r.tokens.input).toBe(3000)
  })

  test("learn accountUsage without inputTokenDetails keeps the raw-count arithmetic", async () => {
    const accounted = await accountUsage(
      model("@ai-sdk/amazon-bedrock"),
      { inputTokens: 800, outputTokens: 40, cachedInputTokens: 2000 },
      { bedrock: { usage: { cacheWriteInputTokens: 600 } } } as any,
    )
    expect(accounted.inputTokens).toBe(3400)
    expect(accounted.estimatedCost).toBeCloseTo((800 * 3 + 40 * 15 + 2000 * 0.3 + 600 * 3.75) / 1e6, 12)
  })
})

describe("Session.getUsage - details-only cache reads and the long-context tier", () => {
  test("cache reads present only in inputTokenDetails are counted", () => {
    const r = Session.getUsage({
      model: model("@ai-sdk/amazon-bedrock"),
      usage: {
        inputTokens: 61361,
        outputTokens: 10,
        inputTokenDetails: { noCacheTokens: 2, cacheReadTokens: 61359, cacheWriteTokens: 0 },
      } as any,
      metadata: { bedrock: { usage: { cacheWriteInputTokens: 0 } } } as any,
    })
    expect(r.tokens.cache.read).toBe(61359)
    expect(r.tokens.inputTotal).toBe(61361)
    expect(r.cost).toBeCloseTo((2 * 3 + 10 * 15 + 61359 * 0.3) / 1e6, 12)
  })

  test("a prompt over 200K made of cache writes selects the over-200K price", () => {
    const tiered: any = {
      ...model("@ai-sdk/anthropic"),
      cost: { ...PRICE, experimentalOver200K: { input: 6, output: 22.5, cache: { read: 0.6, write: 7.5 } } },
    }
    const r = Session.getUsage({
      model: tiered,
      usage: inclusiveUsage(1, 0, 210_000, 5),
      metadata: { anthropic: { cacheCreationInputTokens: 210_000 } } as any,
    })
    expect(r.cost).toBeCloseTo((1 * 6 + 5 * 22.5 + 210_000 * 7.5) / 1e6, 12)
  })

  test("a prompt at or under 200K keeps the base price", () => {
    const tiered: any = {
      ...model("@ai-sdk/anthropic"),
      cost: { ...PRICE, experimentalOver200K: { input: 6, output: 22.5, cache: { read: 0.6, write: 7.5 } } },
    }
    const r = Session.getUsage({
      model: tiered,
      usage: inclusiveUsage(0, 0, 200_000, 5),
      metadata: { anthropic: { cacheCreationInputTokens: 200_000 } } as any,
    })
    expect(r.cost).toBeCloseTo((5 * 15 + 200_000 * 3.75) / 1e6, 12)
  })
})

describe("learn accountUsage with an inclusive SDK usage (generateObject shape)", () => {
  test("bills Bedrock cache read and write once", async () => {
    // Same counts as the mixed Bedrock case above, as returned by generateObject().usage.
    const accounted = await accountUsage(
      { ...model("@ai-sdk/amazon-bedrock") },
      {
        inputTokens: 63362,
        outputTokens: 352,
        totalTokens: 63714,
        cachedInputTokens: 61359,
        inputTokenDetails: { noCacheTokens: 2, cacheReadTokens: 61359, cacheWriteTokens: 2001 },
      },
      { bedrock: { usage: { cacheWriteInputTokens: 2001 } } } as any,
    )
    expect(accounted.inputTokens).toBe(63362)
    expect(accounted.estimatedCost).toBeCloseTo((6 + 5280 + 18407.7 + 7503.75) / 1e6, 12)
  })
})
