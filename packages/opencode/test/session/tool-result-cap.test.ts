import { describe, expect, test } from "bun:test"
import { ToolResultCap } from "../../src/session/tool-result-cap"
import { TruncateCore } from "../../src/tool/truncate-core"
import { Token } from "../../src/util/token"

// ─── per-tool-result dispatch cap ────────────────────────────────
// A single tool result must never exceed a bounded token estimate at
// dispatch time. Production incident: one giant duckdb/query dump jumped a
// ~4K-token conversation past a 65K window in one step, bypassing the
// tool-level truncation service.

const MODEL_65K = { limit: { context: 65_536 } }

describe("ToolResultCap.resolve", () => {
  test("explicit config dispatch_max_tokens wins", () => {
    const cap = ToolResultCap.resolve({
      config: { tool_output: { dispatch_max_tokens: 1_234 } },
      model: MODEL_65K,
      safetyFraction: 0.65,
    })
    expect(cap).toBe(1_234)
  })

  test("default is min(max_bytes-derived estimate, 15% of effective limit)", () => {
    // existing cap: ceil(51,200 / 3.0) = 17,067 tokens
    // effective limit: floor(65,536 * 0.65) = 42,598 → 15% = 6,389 tokens
    const cap = ToolResultCap.resolve({ model: MODEL_65K, safetyFraction: 0.65 })
    expect(cap).toBe(6_389)
    expect(cap).toBeLessThan(Math.ceil(TruncateCore.MAX_BYTES / ToolResultCap.MIN_CHARS_PER_TOKEN))
  })

  test("large-context model: the byte-derived cap is the binding constraint", () => {
    // 15% of floor(1M * 0.65) = 97,500 → existing cap 17,067 wins
    const cap = ToolResultCap.resolve({ model: { limit: { context: 1_000_000 } }, safetyFraction: 0.65 })
    expect(cap).toBe(Math.ceil(TruncateCore.MAX_BYTES / ToolResultCap.MIN_CHARS_PER_TOKEN))
  })

  test("configured tool_output.max_bytes feeds the byte-derived cap", () => {
    const cap = ToolResultCap.resolve({
      config: { tool_output: { max_bytes: 9_000 } },
      model: { limit: { context: 1_000_000 } },
      safetyFraction: 0.65,
    })
    expect(cap).toBe(Math.ceil(9_000 / ToolResultCap.MIN_CHARS_PER_TOKEN))
  })

  test("unknown model limits fall back to the CONSERVATIVE small-window bound, not ~17K", () => {
    // The byte-derived cap (~17K tokens) can overwhelm a small window on its
    // own; unknown limits assume the smallest protected window instead.
    expect(ToolResultCap.UNKNOWN_MODEL_CAP_TOKENS).toBeLessThan(
      Math.ceil(TruncateCore.MAX_BYTES / ToolResultCap.MIN_CHARS_PER_TOKEN),
    )
    expect(ToolResultCap.resolve({})).toBe(ToolResultCap.UNKNOWN_MODEL_CAP_TOKENS)
    expect(ToolResultCap.resolve({ model: { limit: { context: 0 } } })).toBe(ToolResultCap.UNKNOWN_MODEL_CAP_TOKENS)
    // A configured max_bytes below the bound stays binding.
    expect(ToolResultCap.resolve({ config: { tool_output: { max_bytes: 3_000 } } })).toBe(
      Math.ceil(3_000 / ToolResultCap.MIN_CHARS_PER_TOKEN),
    )
  })

  test("limit.input takes precedence over limit.context", () => {
    const cap = ToolResultCap.resolve({
      model: { limit: { context: 1_000_000, input: 65_536 } },
      safetyFraction: 0.65,
    })
    expect(cap).toBe(6_389)
  })

  // altimate_change start — PR #1171 review: `config.compaction.context_safety_fraction`
  // was declared on the input type and never read.
  test("a configured context_safety_fraction is honoured when no explicit fraction is passed", () => {
    const withConfig = ToolResultCap.resolve({
      config: { compaction: { context_safety_fraction: 0.5 } },
      model: { limit: { input: 65_536 } },
    })
    const explicit = ToolResultCap.resolve({ model: { limit: { input: 65_536 } }, safetyFraction: 0.5 })
    expect(withConfig).toBe(explicit)
    // and it genuinely differs from the default fraction
    expect(withConfig).not.toBe(
      ToolResultCap.resolve({ model: { limit: { input: 65_536 } }, safetyFraction: ToolResultCap.DEFAULT_SAFETY_FRACTION }),
    )
  })

  test("an explicit safetyFraction still wins over the configured one", () => {
    const cap = ToolResultCap.resolve({
      config: { compaction: { context_safety_fraction: 0.2 } },
      model: { limit: { input: 65_536 } },
      safetyFraction: 0.65,
    })
    expect(cap).toBe(ToolResultCap.resolve({ model: { limit: { input: 65_536 } }, safetyFraction: 0.65 }))
  })

  test("a nonsensical configured fraction falls back to the default", () => {
    const cap = ToolResultCap.resolve({
      config: { compaction: { context_safety_fraction: 0 } },
      model: { limit: { input: 65_536 } },
    })
    expect(cap).toBe(
      ToolResultCap.resolve({ model: { limit: { input: 65_536 } }, safetyFraction: ToolResultCap.DEFAULT_SAFETY_FRACTION }),
    )
  })

  test("the unknown-model bound is derived from the shared default fraction", () => {
    expect(ToolResultCap.UNKNOWN_MODEL_CAP_TOKENS).toBe(
      Math.floor(Math.floor(65_536 * ToolResultCap.DEFAULT_SAFETY_FRACTION) * ToolResultCap.DEFAULT_LIMIT_FRACTION),
    )
  })

  // PR #1171 follow-up review: the fraction was resolved AFTER the unknown-model
  // branch returned, so a configured fraction never scaled that fallback.
  test("a configured fraction also scales the unknown-model fallback", () => {
    const tight = ToolResultCap.resolve({ config: { compaction: { context_safety_fraction: 0.2 } } })
    expect(tight).toBeLessThan(ToolResultCap.UNKNOWN_MODEL_CAP_TOKENS)
    expect(tight).toBe(
      Math.floor(Math.floor(ToolResultCap.UNKNOWN_MODEL_CONTEXT * 0.2) * ToolResultCap.DEFAULT_LIMIT_FRACTION),
    )
  })

  test("with no configured fraction the unknown-model fallback is unchanged", () => {
    expect(ToolResultCap.resolve({})).toBe(ToolResultCap.UNKNOWN_MODEL_CAP_TOKENS)
  })
  // altimate_change end
})

// altimate_change start — PR #1171 follow-up review: the cap is now applied to
// FAILED tool results too, and the success wording would have told the model a
// real failure was a truncated success.
describe("ToolResultCap.apply — outcome-accurate truncation hint", () => {
  const giant = Array.from({ length: 4_000 }, (_, i) => `error line ${i}: something went wrong`).join("\n")

  test("a capped ERROR never claims the tool call succeeded", () => {
    const result = ToolResultCap.apply(giant, 500, { outcome: "error" })
    expect(result.truncated).toBe(true)
    expect(result.content).not.toContain("The tool call succeeded")
    expect(result.content).toContain("FAILED")
    expect(result.content).toContain("do not treat this as a successful result")
  })

  test("a capped SUCCESS keeps the original wording", () => {
    const result = ToolResultCap.apply(giant, 500, { outcome: "success" })
    expect(result.content).toContain("The tool call succeeded")
  })

  test("the outcome option is optional and defaults to the success wording", () => {
    expect(ToolResultCap.apply(giant, 500).content).toContain("The tool call succeeded")
  })

  test("the error hint still respects the cap", () => {
    for (const cap of [200, 500, 2_000]) {
      const result = ToolResultCap.apply(giant, cap, { outcome: "error" })
      expect(Token.estimate(result.content)).toBeLessThanOrEqual(cap)
    }
  })
})
// altimate_change end

describe("ToolResultCap.apply", () => {
  test("output within the cap passes through unchanged", () => {
    const output = "select 1;\n".repeat(50)
    const result = ToolResultCap.apply(output, 6_389)
    expect(result.truncated).toBe(false)
    expect(result.content).toBe(output)
  })

  test("cap of 0 disables enforcement", () => {
    const giant = "x".repeat(1_000_000)
    const result = ToolResultCap.apply(giant, 0)
    expect(result.truncated).toBe(false)
    expect(result.content).toBe(giant)
  })

  test("giant single-result case: dense multi-line dump is bounded below the cap", () => {
    // ~400KB of dense query rows — the shape that overflowed a 65K window.
    const rows: string[] = []
    for (let i = 0; i < 8_000; i++) {
      rows.push(`{"order_id":${i},"customer":"c-${i}","total":${i * 13.37},"status":"SHIPPED","ts":"2026-08-19"}`)
    }
    const output = rows.join("\n")
    const cap = 6_389
    expect(Token.estimate(output)).toBeGreaterThan(cap)

    const result = ToolResultCap.apply(output, cap)
    expect(result.truncated).toBe(true)
    // Bounded: kept bytes ≤ cap * 3 chars/token, plus the ~fixed-size notice.
    expect(Token.estimate(result.content)).toBeLessThanOrEqual(cap)
    // Middle truncation keeps head AND tail, with the standard marker + notice.
    expect(result.content.startsWith('{"order_id":0,')).toBe(true)
    expect(result.content).toContain('"order_id":7999')
    expect(result.content).toMatch(/\.\.\.\d+ (bytes|lines) truncated\.\.\./)
    expect(result.content).toContain("output exceeded the per-result context budget and was truncated")
  })

  test("giant SINGLE-LINE dump (minified JSON) still keeps head and tail", () => {
    const giant = '{"rows":["' + "abcdef".repeat(20_000) + '"]}'
    const cap = 2_000
    expect(giant.includes("\n")).toBe(false)
    expect(Token.estimate(giant)).toBeGreaterThan(cap)

    const result = ToolResultCap.apply(giant, cap)
    expect(result.truncated).toBe(true)
    expect(Token.estimate(result.content)).toBeLessThanOrEqual(cap)
    expect(result.content.startsWith('{"rows":[')).toBe(true)
    expect(result.content.trimEnd().endsWith("]}")).toBe(true)
  })

  test("framing is reserved INSIDE the cap: final output estimate <= cap", () => {
    const rows = Array.from({ length: 4_000 }, (_, i) => `{"id":${i},"value":"row-${i}"}`)
    const output = rows.join("\n")
    for (const cap of [200, 500, 2_000]) {
      const result = ToolResultCap.apply(output, cap)
      expect(result.truncated).toBe(true)
      expect(Token.estimate(result.content)).toBeLessThanOrEqual(cap)
      expect(result.content).toContain("per-result context budget")
    }
  })

  test("cap=1 edge: result is still bounded by the cap (framing dropped when it cannot fit)", () => {
    const giant = "x".repeat(100_000)
    const result = ToolResultCap.apply(giant, 1)
    expect(result.truncated).toBe(true)
    expect(Token.estimate(result.content)).toBeLessThanOrEqual(1)
    expect(result.content.length).toBeGreaterThan(0)
  })

  test("incident replay: 4K conversation + one giant result stays far below a 65K window", () => {
    const conversationTokens = 4_000
    const giant = "SELECT * FROM orders; -- " + "0123456789abcdef".repeat(20_000) // ~340KB dense
    const cap = ToolResultCap.resolve({ model: MODEL_65K, safetyFraction: 0.65 })
    const result = ToolResultCap.apply(giant, cap)
    expect(result.truncated).toBe(true)
    const after = conversationTokens + Token.estimate(result.content)
    // Even at the worst observed 1.55x estimator error, the real size fits.
    expect(Math.ceil(after * 1.55)).toBeLessThan(65_536)
  })
})
