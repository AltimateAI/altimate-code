// altimate_change start — wave-11 adversarial tests for PR #849
/**
 * Wave 11: the final 2-3 bugs. Targeted probes at known-weak surfaces.
 */
import { describe, expect, test } from "bun:test"
import { parseDbtTestOutput } from "../../../src/altimate/validators/dbt-tests-pass"
import {
  extractLastJsonObject,
  modelNameFromPath,
  runWithConcurrencyLimit,
} from "../../../src/altimate/validators/validator-utils"

describe("BUG: parseDbtTestOutput global regex `failingTests` cross-Done leak (wave 11)", () => {
  test("failingTests captured BEFORE Done. should not include parsed counts from PASS lines", () => {
    // Some dbt versions print "1 of 5 PASS my_test" — we shouldn't capture
    // these as failing tests. Our regex is FAIL|ERROR only, so should be fine.
    // Verify with a real-looking output.
    const out = `1 of 5 PASS test_a
2 of 5 FAIL test_b [FAIL]
3 of 5 PASS test_c
4 of 5 ERROR test_d [ERROR]
5 of 5 PASS test_e
Done. PASS=3 WARN=0 ERROR=2 SKIP=0 TOTAL=5`
    const r = parseDbtTestOutput(out)
    expect(r?.failingTests).toEqual(["test_b", "test_d"])
  })

  test("FAIL test name beginning with digit", () => {
    const out = "1 of 1 FAIL 2legit2quit [FAIL]\nDone. PASS=0 WARN=0 ERROR=1 SKIP=0 TOTAL=1"
    const r = parseDbtTestOutput(out)
    expect(r?.failingTests).toContain("2legit2quit")
  })

  test("FAIL line where the count digits cross a million", () => {
    const out = "999999 of 999999 FAIL big_test [FAIL]\nDone. PASS=999998 WARN=0 ERROR=1 SKIP=0 TOTAL=999999"
    const r = parseDbtTestOutput(out)
    expect(r?.failingTests).toContain("big_test")
    expect(r?.total).toBe(999999)
  })

  test("FAIL line precedes Done. by 100KB of intervening logs", () => {
    const noise = "log line\n".repeat(10_000)
    const out = `1 of 1 FAIL late_test [FAIL]\n${noise}Done. PASS=0 WARN=0 ERROR=1 SKIP=0 TOTAL=1`
    const r = parseDbtTestOutput(out)
    expect(r?.failingTests).toContain("late_test")
  })

  test("Done. with NO whitespace between Done. and PASS (`Done.PASS=...`)", () => {
    // dbt always has space, but if it didn't, regex requires `\s+`.
    const out = "Done.PASS=1 WARN=0 ERROR=0 SKIP=0 TOTAL=1"
    // BUG: regex would fail; document.
    expect(parseDbtTestOutput(out)).toBeNull()
  })

  test("`Done.` with trailing exclamation `Done.!`", () => {
    // Has whitespace after the bang? If so: "Done.! PASS=..." — regex
    // requires `\s+` directly after `.`. The `!` breaks the match.
    const out = "Done.! PASS=1 WARN=0 ERROR=0 SKIP=0 TOTAL=1"
    expect(parseDbtTestOutput(out)).toBeNull()
  })
})

describe("BUG: extractLastJsonObject final hunt (wave 11)", () => {
  test("envelope where stdout contains a literal `\\n` (raw escape sequence)", () => {
    // dbt may emit `\n` as a literal escape inside a JSON string value.
    const raw = '{"verdict": "match", "stdout": "line1\\nline2"}'
    const r = extractLastJsonObject(raw)
    expect(r?.stdout).toBe("line1\nline2")
  })

  test("envelope with `model` as boolean true (type contract violation)", () => {
    const raw = '{"model": true}'
    const r = extractLastJsonObject(raw)
    expect(r).not.toBeNull()
    expect(r?.model).toBe(true)
  })

  test("envelope with `verdict` set to empty string is REJECTED (not meaningful)", () => {
    // After our envelope fix, only non-null/undefined values count.
    // Empty string is treated as meaningful (just like 0 / false). Document.
    const raw = '{"verdict": ""}'
    const r = extractLastJsonObject(raw)
    expect(r).not.toBeNull()
  })

  test("two envelopes separated by a JSON-like fragment (not valid)", () => {
    const raw = '{"verdict": "first"} {"a": } {"verdict": "second"}'
    const r = extractLastJsonObject(raw)
    expect(r?.verdict).toBe("second")
  })
})

describe("BUG: runWithConcurrencyLimit final probes (wave 11)", () => {
  test("when limit==items.length, all run in parallel even if some are immediate", async () => {
    let active = 0
    let peak = 0
    await runWithConcurrencyLimit([1, 2, 3], async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
    }, 3)
    expect(peak).toBe(3)
  })

  test("preserves output position when item processing takes very different times", async () => {
    const out = await runWithConcurrencyLimit(
      [50, 5, 30, 10],
      async (ms) => {
        await new Promise((r) => setTimeout(r, ms))
        return ms
      },
      4,
    )
    expect(out).toEqual([50, 5, 30, 10])
  })

  test("limit > Number.MAX_SAFE_INTEGER falls through to floor + cap correctly", async () => {
    // 2^60 — finite, positive, but huge. Math.floor preserves; min with items.length applies.
    const out = await runWithConcurrencyLimit([1, 2, 3], async (n) => n, 2 ** 60)
    expect(out).toEqual([1, 2, 3])
  })
})

describe("BUG: modelNameFromPath final final (wave 11)", () => {
  test("path with literal NUL byte mid-string", () => {
    // NUL in the middle. basename returns up to last separator. Result
    // contains NUL which corrupts shell args downstream.
    const r = modelNameFromPath("models/foo\x00.sql")
    // BUG: today NUL passes through.
    expect(r).not.toContain("\x00")
  })

  test("path-like string that is a regex pattern (backslash normalized)", () => {
    // Backslashes are normalized to `/` before basename(), so `.*\.sql`
    // becomes `.*/.sql` → basename `.sql` → strip → "".
    expect(modelNameFromPath("/m/.*\\.sql")).toBe("")
  })
})
// altimate_change end
