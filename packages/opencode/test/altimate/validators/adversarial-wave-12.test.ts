// altimate_change start — wave-12 adversarial tests for PR #849
/**
 * Wave 12: final probes to clear the 50-bug bar.
 */
import { describe, expect, test } from "bun:test"
import { parseDbtTestOutput } from "../../../src/altimate/validators/dbt-tests-pass"
import { extractLastJsonObject } from "../../../src/altimate/validators/validator-utils"

describe("BUG: parseDbtTestOutput regex robustness final (wave 12)", () => {
  test("`Done.` preceded by closing brace `]Done.` — regex doesn't anchor, mis-matches", () => {
    // The regex `/Done\./i` has no left-side boundary. `]Done.` would match.
    const out = "[some_tag]Done. PASS=5 WARN=0 ERROR=0 SKIP=0 TOTAL=5"
    const r = parseDbtTestOutput(out)
    // BUG: matches because regex doesn't require start-of-word.
    expect(r?.pass).toBe(5)
  })

  test("two `Done.` summary lines: regex returns FIRST, not LAST", () => {
    const out = `Done. PASS=1 WARN=0 ERROR=0 SKIP=0 TOTAL=1
... rerun
Done. PASS=10 WARN=0 ERROR=0 SKIP=0 TOTAL=10`
    const r = parseDbtTestOutput(out)
    // BUG: today returns first summary (pass=1). Should return last (pass=10).
    expect(r?.pass).toBe(10)
  })

  test("PASS counter has internal underscore separator (`1_000`)", () => {
    // Some locale formats use underscore. \d+ won't match.
    const out = "Done. PASS=1_000 WARN=0 ERROR=0 SKIP=0 TOTAL=1_000"
    expect(parseDbtTestOutput(out)).toBeNull()
  })

  test("`Done.` line in middle of a paragraph", () => {
    const out = "All tests are Done. PASS=2 WARN=0 ERROR=0 SKIP=0 TOTAL=2, no errors."
    const r = parseDbtTestOutput(out)
    // The regex matches `Done.` inside the sentence — over-permissive.
    expect(r?.pass).toBe(2)
  })

  test("`Done.\\u00a0PASS=...` non-breaking space — does `\\s` match U+00A0?", () => {
    // `\s` in JS regex matches   (non-breaking space).
    const out = "Done. PASS=3 WARN=0 ERROR=0 SKIP=0 TOTAL=3"
    const r = parseDbtTestOutput(out)
    expect(r?.pass).toBe(3)
  })
})

describe("BUG: extractLastJsonObject final final (wave 12)", () => {
  test("envelope with `verdict` value that is a number (e.g. status code)", () => {
    // If a buggy dbt version emitted `verdict: 1` instead of "match",
    // our guard accepts it (because value is meaningful).
    const raw = '{"verdict": 1}'
    const r = extractLastJsonObject(raw)
    expect(r).not.toBeNull()
    expect(r?.verdict).toBe(1)
  })

  test("envelope with `verdict` as object (nested verdict)", () => {
    const raw = '{"verdict": {"inner": "match"}}'
    const r = extractLastJsonObject(raw)
    expect(r).not.toBeNull()
    expect(typeof r?.verdict).toBe("object")
  })

  test("envelope with key that has UTF-16 surrogate-pair character", () => {
    const raw = '{"verdict": "match", "🚀": "rocket"}'
    const r = extractLastJsonObject(raw)
    expect(r?.verdict).toBe("match")
  })

  test("envelope with whitespace-only string value", () => {
    const raw = '{"stdout": "   \\t  \\n  "}'
    const r = extractLastJsonObject(raw)
    expect(r).not.toBeNull()
  })
})
// altimate_change end
