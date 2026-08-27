import { describe, expect, test } from "bun:test"
import { ToolResultCap } from "../../src/session/tool-result-cap"
import { TruncateCore } from "../../src/tool/truncate-core"
import { Token } from "../../src/util/token"

// ─── W3.2 per-tool-result dispatch cap ────────────────────────────────
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

  test("unknown model limits fall back to the byte-derived cap", () => {
    expect(ToolResultCap.resolve({})).toBe(Math.ceil(TruncateCore.MAX_BYTES / ToolResultCap.MIN_CHARS_PER_TOKEN))
    expect(ToolResultCap.resolve({ model: { limit: { context: 0 } } })).toBe(
      Math.ceil(TruncateCore.MAX_BYTES / ToolResultCap.MIN_CHARS_PER_TOKEN),
    )
  })

  test("limit.input takes precedence over limit.context", () => {
    const cap = ToolResultCap.resolve({
      model: { limit: { context: 1_000_000, input: 65_536 } },
      safetyFraction: 0.65,
    })
    expect(cap).toBe(6_389)
  })
})

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
    expect(Token.estimate(result.content)).toBeLessThanOrEqual(cap + 200)
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
    expect(Token.estimate(result.content)).toBeLessThanOrEqual(cap + 200)
    expect(result.content.startsWith('{"rows":[')).toBe(true)
    expect(result.content.trimEnd().endsWith("]}")).toBe(true)
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
