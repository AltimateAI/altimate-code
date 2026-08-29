import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { SessionCompaction } from "../../src/session/compaction"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import type { Provider } from "../../src/provider/provider"

Log.init({ print: false })

// ─── estimator safety margin ─────────────────────────────────────
// Token.estimate (chars-based) undercounts real tokenization of dense
// SQL/JSON by up to ~1.55x. The safety fraction corrects for that ONLY where
// estimates are involved: estimate-derived budgets use base * fraction, and
// the estimated component passed to isOverflow is inflated by 1/fraction.
// Provider-reported usage is exact and compares against the raw limit minus
// headroom.

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

// altimate_change start — save and RESTORE the value the surrounding
// environment had. Unconditionally deleting it wiped a fraction set by CI or a
// dev shell for the remainder of the run.
let priorSafetyFraction: string | undefined
beforeEach(() => {
  priorSafetyFraction = process.env["ALTIMATE_CONTEXT_SAFETY_FRACTION"]
  delete process.env["ALTIMATE_CONTEXT_SAFETY_FRACTION"]
})
afterEach(() => {
  if (priorSafetyFraction === undefined) delete process.env["ALTIMATE_CONTEXT_SAFETY_FRACTION"]
  else process.env["ALTIMATE_CONTEXT_SAFETY_FRACTION"] = priorSafetyFraction
})
// altimate_change end

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

describe("isOverflow two regimes: exact provider counts vs estimated components", () => {
  test("provider-reported usage compares against the RAW limit minus headroom", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // context=100K, output=32K → headroom = max(20K, 32K) = 32K → raw usable = 68K.
        // Exact counts must NOT be scaled by the default 0.65 fraction — that
        // forfeited ~35% of every window for estimate-free sessions.
        const model = createModel({ context: 100_000, output: 32_000 })
        expect(await SessionCompaction.isOverflow({ tokens: tokens(68_000), model })).toBe(true)
        expect(await SessionCompaction.isOverflow({ tokens: tokens(67_999), model })).toBe(false)
        // Well above the old fraction-scaled trigger (33K) but under the raw
        // boundary: still no overflow.
        expect(await SessionCompaction.isOverflow({ tokens: tokens(50_000), model })).toBe(false)
      },
    })
  })

  test("estimated component is inflated by 1/fraction (default 0.65)", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Raw usable = 68K. Provider count 60K + estimated tail 6K:
        // adjusted = 60K + ceil(6000 / 0.65) = 60K + 9,231 = 69,231 → overflow.
        const model = createModel({ context: 100_000, output: 32_000 })
        expect(
          await SessionCompaction.isOverflow({ tokens: tokens(60_000), estimatedTokens: 6_000, model }),
        ).toBe(true)
        // 60K + ceil(5000 / 0.65) = 67,693 < 68K → no overflow.
        expect(
          await SessionCompaction.isOverflow({ tokens: tokens(60_000), estimatedTokens: 5_000, model }),
        ).toBe(false)
      },
    })
  })

  test("fraction 1 disables estimate inflation", async () => {
    process.env["ALTIMATE_CONTEXT_SAFETY_FRACTION"] = "1"
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 100_000, output: 32_000 })
        expect(
          await SessionCompaction.isOverflow({ tokens: tokens(60_000), estimatedTokens: 8_000, model }),
        ).toBe(true)
        expect(
          await SessionCompaction.isOverflow({ tokens: tokens(60_000), estimatedTokens: 7_999, model }),
        ).toBe(false)
      },
    })
  })

  test("config key context_safety_fraction scales the estimated component only", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(`${dir}/opencode.json`, JSON.stringify({ compaction: { context_safety_fraction: 0.5 } }))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 100_000, output: 32_000 })
        // Exact counts still use the raw boundary despite fraction 0.5.
        expect(await SessionCompaction.isOverflow({ tokens: tokens(67_999), model })).toBe(false)
        // Estimated component doubles: 64K + 4000/0.5 = 72K → overflow;
        // 63.9K + 2000/0.5 = 67.9K → no overflow.
        expect(
          await SessionCompaction.isOverflow({ tokens: tokens(64_000), estimatedTokens: 4_000, model }),
        ).toBe(true)
        expect(
          await SessionCompaction.isOverflow({ tokens: tokens(63_900), estimatedTokens: 2_000, model }),
        ).toBe(false)
      },
    })
  })

  test("small-context models keep the full raw usable window for exact counts", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // context=32,768, output=5K → headroom = max(20K, 5K) = 20K → raw usable = 12,768.
        const model = createModel({ context: 32_768, output: 5_000 })
        expect(await SessionCompaction.isOverflow({ tokens: tokens(12_768), model })).toBe(true)
        expect(await SessionCompaction.isOverflow({ tokens: tokens(12_767), model })).toBe(false)
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
