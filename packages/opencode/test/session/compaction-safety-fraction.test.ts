import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { SessionCompaction } from "../../src/session/compaction"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import type { Provider } from "../../src/provider/provider"

Log.init({ print: false })

// ─── estimator safety margin ─────────────────────────────────────
// Token.estimate (chars-based) undercounts real tokenization of dense
// SQL/JSON by up to ~1.55x. Compaction must trigger against an effective
// limit (base * context_safety_fraction, default 0.65) so the worst
// observed underestimate still fits inside the raw window.

function createModel(opts: { context: number; output: number; input?: number }): Provider.Model {
  return {
    id: "test-model",
    providerID: "test" as any,
    name: "Test",
    limit: {
      context: opts.context,
      input: opts.input,
      output: opts.output,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

function tokens(input: number) {
  return { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

beforeEach(() => {
  delete process.env["ALTIMATE_CONTEXT_SAFETY_FRACTION"]
})
afterEach(() => {
  delete process.env["ALTIMATE_CONTEXT_SAFETY_FRACTION"]
})

describe("contextSafetyFraction resolution", () => {
  test("defaults to 0.65", () => {
    expect(SessionCompaction.contextSafetyFraction(undefined)).toBe(0.65)
    expect(SessionCompaction.contextSafetyFraction({})).toBe(0.65)
  })

  test("config key overrides the default", () => {
    expect(SessionCompaction.contextSafetyFraction({ compaction: { context_safety_fraction: 0.8 } })).toBe(0.8)
  })

  test("env var overrides config", () => {
    process.env["ALTIMATE_CONTEXT_SAFETY_FRACTION"] = "0.9"
    expect(SessionCompaction.contextSafetyFraction({ compaction: { context_safety_fraction: 0.5 } })).toBe(0.9)
  })

  test("non-numeric env var is ignored", () => {
    process.env["ALTIMATE_CONTEXT_SAFETY_FRACTION"] = "banana"
    expect(SessionCompaction.contextSafetyFraction(undefined)).toBe(0.65)
  })

  test("numeric-prefix garbage is ignored (Number over the full value, not parseFloat)", () => {
    process.env["ALTIMATE_CONTEXT_SAFETY_FRACTION"] = "0.9junk"
    expect(SessionCompaction.contextSafetyFraction(undefined)).toBe(0.65)
    expect(SessionCompaction.contextSafetyFraction({ compaction: { context_safety_fraction: 0.5 } })).toBe(0.5)
  })

  test("surrounding whitespace is tolerated", () => {
    process.env["ALTIMATE_CONTEXT_SAFETY_FRACTION"] = " 0.9 "
    expect(SessionCompaction.contextSafetyFraction(undefined)).toBe(0.9)
  })

  test("clamps to [0.1, 1]", () => {
    expect(SessionCompaction.contextSafetyFraction({ compaction: { context_safety_fraction: 2 } })).toBe(1)
    expect(SessionCompaction.contextSafetyFraction({ compaction: { context_safety_fraction: 0.01 } })).toBe(0.1)
    process.env["ALTIMATE_CONTEXT_SAFETY_FRACTION"] = "-3"
    expect(SessionCompaction.contextSafetyFraction(undefined)).toBe(0.1)
  })
})

describe("effectiveContextLimit", () => {
  test("floors base * fraction", () => {
    expect(SessionCompaction.effectiveContextLimit(65_536, 0.65)).toBe(42_598)
    expect(SessionCompaction.effectiveContextLimit(100_000, 0.65)).toBe(65_000)
    expect(SessionCompaction.effectiveContextLimit(100_000, 1)).toBe(100_000)
  })

  test("worst-observed 1.55x underestimate still fits inside the raw window", () => {
    // The 65K-context incident model: estimated 45.8K = real >65K → provider 400.
    // With the default fraction, the compaction trigger sits low enough that
    // 1.55x the trigger PLUS the 20K headroom stays inside the raw context.
    const context = 65_536
    const headroom = 20_000
    const effective = SessionCompaction.effectiveContextLimit(context, 0.65)
    const threshold = effective - headroom
    expect(Math.ceil(threshold * 1.55) + headroom).toBeLessThanOrEqual(context)
  })
})

describe("isOverflow triggers against the effective limit", () => {
  test("default margin: trigger at effectiveBase - headroom, not base - headroom", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // context=100K, output=32K → headroom = max(20K, 32K) = 32K
        // effectiveBase = floor(100K * 0.65) = 65K → threshold = 33K (raw was 68K)
        const model = createModel({ context: 100_000, output: 32_000 })
        expect(await SessionCompaction.isOverflow({ tokens: tokens(33_000), model })).toBe(true)
        expect(await SessionCompaction.isOverflow({ tokens: tokens(32_999), model })).toBe(false)
      },
    })
  })

  test("fraction 1 restores the raw-limit boundary", async () => {
    process.env["ALTIMATE_CONTEXT_SAFETY_FRACTION"] = "1"
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Raw boundary: usable = 100K - 32K = 68K
        const model = createModel({ context: 100_000, output: 32_000 })
        expect(await SessionCompaction.isOverflow({ tokens: tokens(68_000), model })).toBe(true)
        expect(await SessionCompaction.isOverflow({ tokens: tokens(67_999), model })).toBe(false)
      },
    })
  })

  test("config key context_safety_fraction is honored", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(`${dir}/opencode.json`, JSON.stringify({ compaction: { context_safety_fraction: 0.5 } }))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // effectiveBase = 50K → threshold = 50K - 32K = 18K
        const model = createModel({ context: 100_000, output: 32_000 })
        expect(await SessionCompaction.isOverflow({ tokens: tokens(18_000), model })).toBe(true)
        expect(await SessionCompaction.isOverflow({ tokens: tokens(17_999), model })).toBe(false)
      },
    })
  })

  test("small-context floor: threshold never collapses to ~0", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // context=32,768, output=5K → headroom = max(20K, 5K) = 20K
        // effectiveBase = floor(32,768 * 0.65) = 21,299 → margin threshold 1,299
        // floors to MIN_OVERFLOW_THRESHOLD = 4,000 (still below raw 12,768)
        const model = createModel({ context: 32_768, output: 5_000 })
        expect(await SessionCompaction.isOverflow({ tokens: tokens(4_000), model })).toBe(true)
        expect(await SessionCompaction.isOverflow({ tokens: tokens(3_999), model })).toBe(false)
      },
    })
  })

  test("base <= headroom still disables compaction entirely", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 16_000, output: 32_000 })
        expect(await SessionCompaction.isOverflow({ tokens: tokens(1_000_000), model })).toBe(false)
      },
    })
  })
})
