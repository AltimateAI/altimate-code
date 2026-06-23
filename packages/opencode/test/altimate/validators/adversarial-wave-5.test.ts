// altimate_change start — wave-5 adversarial tests for PR #849
/**
 * Fifth wave. Targets:
 *   - parseDbtTestOutput realistic dbt-version outputs (1.4 / 1.5 / 1.7 / 1.8)
 *   - extractLastJsonObject with multiple-line envelopes
 *   - runWithConcurrencyLimit timing guarantees
 *   - ValidatorRegistry duplicate detection
 *   - modelNameFromPath with paths containing the separator literal
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { parseDbtTestOutput } from "../../../src/altimate/validators/dbt-tests-pass"
import {
  extractLastJsonObject,
  modelNameFromPath,
  modelsModifiedSince,
  runWithConcurrencyLimit,
} from "../../../src/altimate/validators/validator-utils"

// ---------------------------------------------------------------------------
// parseDbtTestOutput — realistic version-by-version outputs
// ---------------------------------------------------------------------------

describe("BUG: parseDbtTestOutput across dbt versions", () => {
  test("dbt 1.4 summary (no NO-OP field)", () => {
    const out = `Running with dbt=1.4.6
Found 3 tests, 2 models, 0 sources, 0 macros
Finished running 3 tests in 0:00:05.123
Done. PASS=2 WARN=0 ERROR=1 SKIP=0 TOTAL=3`
    const r = parseDbtTestOutput(out)
    expect(r?.pass).toBe(2)
    expect(r?.error).toBe(1)
    expect(r?.total).toBe(3)
  })

  test("dbt 1.5 summary (still no NO-OP)", () => {
    const out = `Running with dbt=1.5.8
Done. PASS=10 WARN=2 ERROR=0 SKIP=1 TOTAL=13`
    const r = parseDbtTestOutput(out)
    expect(r?.pass).toBe(10)
    expect(r?.total).toBe(13)
  })

  test("dbt 1.7 summary with NO-OP field", () => {
    const out = `Done. PASS=5 WARN=0 ERROR=0 SKIP=0 NO-OP=0 TOTAL=5`
    const r = parseDbtTestOutput(out)
    expect(r?.pass).toBe(5)
    expect(r?.total).toBe(5)
  })

  test("dbt 1.8 summary with new field order (hypothetical)", () => {
    // If dbt 1.8 ever puts ERROR before WARN, the named groups should still
    // resolve correctly. Our regex requires fixed order, so this fails today.
    const out = `Done. PASS=5 ERROR=1 WARN=0 SKIP=0 TOTAL=6`
    const r = parseDbtTestOutput(out)
    // BUG: regex requires WARN before ERROR; field reorder breaks parsing.
    expect(r).not.toBeNull()
  })

  test("dbt with timestamped lines preceding Done.", () => {
    const out = `17:04:12  1 of 3 PASS unique_user_id [PASS in 0.02s]
17:04:13  2 of 3 PASS not_null_user_id [PASS in 0.01s]
17:04:14  3 of 3 FAIL 5 accepted_values_role [FAIL 5 in 0.05s]
17:04:14
17:04:14  Finished running 3 tests in 0:00:00.50
17:04:14
17:04:14  Done. PASS=2 WARN=0 ERROR=1 SKIP=0 TOTAL=3`
    const r = parseDbtTestOutput(out)
    expect(r?.pass).toBe(2)
    expect(r?.error).toBe(1)
    expect(r!.failingTests).toContain("accepted_values_role")
  })
})

// ---------------------------------------------------------------------------
// extractLastJsonObject — multi-line, mixed-format
// ---------------------------------------------------------------------------

describe("BUG: extractLastJsonObject multi-line and mixed-format", () => {
  test("envelope spread across 5 lines with indentation", () => {
    const raw = `noise
{
  "verdict": "match",
  "model": "stg_orders",
  "columns_extra": [],
  "columns_missing": []
}
more noise`
    const r = extractLastJsonObject(raw)
    expect(r?.verdict).toBe("match")
    expect(r?.model).toBe("stg_orders")
  })

  test("envelope with internal `{` in string value (must not split scan)", () => {
    const raw = '{"verdict": "match", "stdout": "select { from }"}'
    const r = extractLastJsonObject(raw)
    expect(r).not.toBeNull()
    expect(r?.stdout).toBe("select { from }")
  })

  test("envelope at the very start of stdout", () => {
    const raw = '{"verdict": "match"}'
    expect(extractLastJsonObject(raw)?.verdict).toBe("match")
  })

  test("envelope at the very end after a massive prefix", () => {
    const noise = "x".repeat(100_000)
    const raw = `${noise}\n{"verdict": "match"}`
    expect(extractLastJsonObject(raw)?.verdict).toBe("match")
  })

  test("envelope with very long string value (~1MB)", () => {
    const big = "y".repeat(1_000_000)
    const raw = `{"verdict": "match", "stdout": "${big}"}`
    const r = extractLastJsonObject(raw)
    expect(r?.verdict).toBe("match")
    expect((r?.stdout as string).length).toBe(1_000_000)
  })

  test("two envelopes on same line", () => {
    const raw = '{"verdict": "match"}{"verdict": "mismatch"}'
    expect(extractLastJsonObject(raw)?.verdict).toBe("mismatch")
  })

  test("envelope on first line, garbage closing line", () => {
    const raw = '{"verdict": "match"}\nUnexpected closing brace }'
    expect(extractLastJsonObject(raw)?.verdict).toBe("match")
  })
})

// ---------------------------------------------------------------------------
// runWithConcurrencyLimit — timing
// ---------------------------------------------------------------------------

describe("BUG: runWithConcurrencyLimit timing guarantees", () => {
  test("strict cap: never more than `limit` concurrent operations", async () => {
    let active = 0
    let peak = 0
    await runWithConcurrencyLimit(
      Array.from({ length: 20 }, (_, i) => i),
      async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 5))
        active--
      },
      3,
    )
    expect(peak).toBeLessThanOrEqual(3)
  })

  test.skip("rejection mid-flight doesn't leave the queue advancing in background (DESIGN LIMITATION)", async () => {
    // After rejection propagates to caller, other workers should NOT continue
    // processing the queue — they should be cancelled / unwound. Today they DO
    // continue, which can leak side effects (e.g., extra subprocess spawns).
    const items = Array.from({ length: 20 }, (_, i) => i)
    const afterReject: number[] = []
    let rejectedAt = -1
    try {
      await runWithConcurrencyLimit(items, async (n) => {
        if (n === 3) {
          rejectedAt = Date.now()
          throw new Error("boom")
        }
        await new Promise((r) => setTimeout(r, 10))
        if (rejectedAt > 0) afterReject.push(n)
        return n
      }, 4)
    } catch {
      // expected
    }
    // wait for any leaked workers to finish before asserting
    await new Promise((r) => setTimeout(r, 200))
    // BUG: today some workers continue advancing the queue after rejection.
    // After fix: we'd expect afterReject.length === 0 (no further work done).
    expect(afterReject.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// modelNameFromPath — separator literals
// ---------------------------------------------------------------------------

describe("BUG: modelNameFromPath with weird path components", () => {
  test("path containing only the separator", () => {
    // basename("/") → ""
    expect(modelNameFromPath("/")).toBe("")
  })

  test("path containing just a dot file", () => {
    expect(modelNameFromPath(".")).toBe(".")
  })

  test("path containing `..`", () => {
    expect(modelNameFromPath("..")).toBe("..")
  })

  test("path with two trailing slashes resolves to last non-slash segment", () => {
    // POSIX basename("/m//") returns "m" — trailing slashes are collapsed.
    expect(modelNameFromPath("/m//")).toBe("m")
  })

  test("file with name ending in newline + .sql", () => {
    // basename returns "foo\n.sql" (trailing \n in name component).
    // Stripping `.sql$` leaves "foo\n".
    expect(modelNameFromPath("/m/foo\n.sql")).toBe("foo\n")
  })
})

// ---------------------------------------------------------------------------
// modelsModifiedSince — additional probes
// ---------------------------------------------------------------------------

describe("BUG: modelsModifiedSince — additional probes", () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "mms-w5-"))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("file at depth exactly equal to MODELS_MAX_DEPTH (=8) is included", async () => {
    // tmpDir/0/1/2/3/4/5/6/models  (depth 8 from tmpDir)
    const sub = join(dir, "0", "1", "2", "3", "4", "5", "6", "models")
    await fs.mkdir(sub, { recursive: true })
    await fs.writeFile(join(sub, "edge.sql"), "select 1")
    const result = await modelsModifiedSince(dir, 0)
    expect(result.some((p) => p.endsWith("edge.sql"))).toBe(true)
  })

  test("file at depth = MODELS_MAX_DEPTH + 1 is excluded", async () => {
    const sub = join(dir, "0", "1", "2", "3", "4", "5", "6", "7", "models")
    await fs.mkdir(sub, { recursive: true })
    await fs.writeFile(join(sub, "deep.sql"), "select 1")
    const result = await modelsModifiedSince(dir, 0)
    expect(result.some((p) => p.endsWith("deep.sql"))).toBe(false)
  })

  test("directory literally named `node_modules` is skipped (case-sensitive intentional)", async () => {
    const nm = join(dir, "models", "node_modules")
    await fs.mkdir(nm, { recursive: true })
    await fs.writeFile(join(nm, "x.sql"), "select 1")
    const result = await modelsModifiedSince(dir, 0)
    expect(result.some((p) => p.endsWith("x.sql"))).toBe(false)
  })

  test("directory named `Node_Modules` IS scanned (case-sensitive skip)", async () => {
    // Today we case-sensitive-skip `node_modules` (lowercase only). Document
    // this and assert it. If we ever want case-insensitive skip, change here.
    const nm = join(dir, "models", "Node_Modules")
    await fs.mkdir(nm, { recursive: true })
    await fs.writeFile(join(nm, "y.sql"), "select 1")
    const result = await modelsModifiedSince(dir, 0)
    expect(result.some((p) => p.endsWith("y.sql"))).toBe(true)
  })

  test.skip("file with .sql extension *and* trailing whitespace in name (pathological, skip)", async () => {
    // `foo.sql ` (with trailing space) is a real (if weird) file name. Our
    // `.endsWith(".sql")` check requires the extension to be at the very end,
    // so trailing whitespace breaks the match. Document.
    const sub = join(dir, "models")
    await fs.mkdir(sub, { recursive: true })
    try {
      await fs.writeFile(join(sub, "foo.sql "), "select 1")
    } catch {
      return
    }
    const result = await modelsModifiedSince(dir, 0)
    // BUG: trailing-whitespace filename is silently skipped.
    expect(result.some((p) => p.endsWith("foo.sql "))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// More parseDbtTestOutput probes — failing-test extraction
// ---------------------------------------------------------------------------

describe("BUG: parseDbtTestOutput failing-test extraction more cases", () => {
  test("test name immediately followed by `]` not space", () => {
    // Could happen with `dbt show --select test_name]`
    const out = "1 of 1 FAIL 5 test_name][FAIL 5 in 0.1s]\nDone. PASS=0 WARN=0 ERROR=1 SKIP=0 TOTAL=1"
    const r = parseDbtTestOutput(out)
    // The greedy \S+ captures "test_name][FAIL" — undesirable.
    expect(r?.failingTests[0]).toBe("test_name")
  })

  test("test name with embedded periods", () => {
    const out = "1 of 1 FAIL accepted_values_my_model.column_x [FAIL in 0.1s]\nDone. PASS=0 WARN=0 ERROR=1 SKIP=0 TOTAL=1"
    const r = parseDbtTestOutput(out)
    expect(r?.failingTests).toContain("accepted_values_my_model.column_x")
  })

  test("test name with embedded forward slash (schema.test syntax)", () => {
    const out = "1 of 1 FAIL my_project/staging.user_id [FAIL in 0.1s]\nDone. PASS=0 WARN=0 ERROR=1 SKIP=0 TOTAL=1"
    const r = parseDbtTestOutput(out)
    expect(r?.failingTests).toContain("my_project/staging.user_id")
  })

  test("repeated test names dedupe but preserve insertion order", () => {
    const out = `1 of 4 FAIL x [FAIL]
2 of 4 FAIL y [FAIL]
3 of 4 FAIL x [FAIL]
4 of 4 FAIL z [FAIL]
Done. PASS=0 WARN=0 ERROR=4 SKIP=0 TOTAL=4`
    const r = parseDbtTestOutput(out)
    expect(r?.failingTests).toEqual(["x", "y", "z"])
  })

  test("16+ failing test names: all captured (not truncated by parse)", () => {
    const lines: string[] = []
    for (let i = 0; i < 20; i++) lines.push(`${i + 1} of 20 FAIL test_${i} [FAIL in 0.01s]`)
    lines.push("Done. PASS=0 WARN=0 ERROR=20 SKIP=0 TOTAL=20")
    const r = parseDbtTestOutput(lines.join("\n"))
    expect(r?.failingTests.length).toBe(20)
  })
})
// altimate_change end
