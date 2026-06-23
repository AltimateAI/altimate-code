// altimate_change start — wave-7 adversarial tests for PR #849
/**
 * Seventh wave: yet more probes. Targets:
 *   - parseDbtTestOutput global-regex matching across lines
 *   - extractLastJsonObject: weird JSON shapes
 *   - modelsModifiedSince: deeply unusual filesystem layouts
 *   - findDbtProjectRoot: deeper edge cases
 *   - registry: ordering invariants
 *   - regex backtracking explosion checks
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
  findDbtProjectRoot,
  runWithConcurrencyLimit,
} from "../../../src/altimate/validators/validator-utils"

// ---------------------------------------------------------------------------
// parseDbtTestOutput: regex anchoring across newlines
// ---------------------------------------------------------------------------

describe("BUG: parseDbtTestOutput regex anchoring across newlines", () => {
  test("FAIL line followed by newline+Done — `Done.` NOT mis-captured as test name", () => {
    // "1 of 1 FAIL\nDone." — the failing-test regex `\s+(\S+)` would match
    // the newline as whitespace and capture "Done." (with trailing period)
    // as the test name. Real production bug.
    const out = "1 of 1 FAIL\nDone. PASS=0 WARN=0 ERROR=1 SKIP=0 TOTAL=1"
    const r = parseDbtTestOutput(out)
    expect(r).not.toBeNull()
    // BUG: today captures "Done." as the failing test name.
    expect(r?.failingTests).not.toContain("Done.")
  })

  test("ERROR line at the very end of stdout with no test name", () => {
    const out = "Done. PASS=0 WARN=0 ERROR=1 SKIP=0 TOTAL=1\n1 of 1 ERROR\n"
    const r = parseDbtTestOutput(out)
    expect(r).not.toBeNull()
    // BUG: captures "1" or empty string when no name follows.
    expect(r?.failingTests).toEqual([])
  })

  test("multiple FAIL lines separated only by whitespace lines", () => {
    const out = `1 of 3 FAIL a [FAIL]


2 of 3 FAIL b [FAIL]
3 of 3 FAIL c [FAIL]
Done. PASS=0 WARN=0 ERROR=3 SKIP=0 TOTAL=3`
    const r = parseDbtTestOutput(out)
    expect(r?.failingTests).toEqual(["a", "b", "c"])
  })

  test("test name that *is* the word 'FAIL' itself", () => {
    // Reserved-keyword-as-name case. dbt would let you name a test 'FAIL'.
    const out = "1 of 1 FAIL FAIL [FAIL in 0.1s]\nDone. PASS=0 WARN=0 ERROR=1 SKIP=0 TOTAL=1"
    const r = parseDbtTestOutput(out)
    expect(r?.failingTests).toContain("FAIL")
  })
})

// ---------------------------------------------------------------------------
// extractLastJsonObject: unusual JSON shapes
// ---------------------------------------------------------------------------

describe("BUG: extractLastJsonObject unusual shapes", () => {
  test("nested envelope inside a `stdout` string value is NOT mistaken for the outer", () => {
    // The outer object is the envelope. The inner JSON-like text is just a string.
    const inner = '{\\"verdict\\": \\"INNER\\"}'
    const raw = `{"verdict": "OUTER", "stdout": "fake nested: ${inner}"}`
    const r = extractLastJsonObject(raw)
    expect(r?.verdict).toBe("OUTER")
  })

  test("envelope with float that loses precision (1e308 + 1)", () => {
    // JSON.parse uses double precision; very large floats lose precision.
    const raw = '{"verdict": "match", "n": 1.7976931348623157e+308}'
    const r = extractLastJsonObject(raw)
    expect(r).not.toBeNull()
    expect(typeof r?.n).toBe("number")
  })

  test("envelope with Infinity (invalid JSON, returns null)", () => {
    const raw = '{"verdict": "match", "n": Infinity}'
    expect(extractLastJsonObject(raw)).toBeNull()
  })

  test("envelope with NaN (invalid JSON, returns null)", () => {
    const raw = '{"verdict": "match", "n": NaN}'
    expect(extractLastJsonObject(raw)).toBeNull()
  })

  test("envelope with empty array `columns_extra: []` is accepted", () => {
    const raw = '{"columns_extra": []}'
    const r = extractLastJsonObject(raw)
    expect(r).not.toBeNull()
    expect(Array.isArray(r?.columns_extra)).toBe(true)
  })

  test("envelope with `model` as integer (invalid type, but accepted by guard)", () => {
    const raw = '{"model": 42}'
    const r = extractLastJsonObject(raw)
    expect(r).not.toBeNull()
    expect(typeof r?.model).toBe("number")
  })

  test("envelope with `columns_extra: null` is rejected (null is sentinel-like)", () => {
    // We require meaningful (non-null) values for non-`error` keys.
    const raw = '{"columns_extra": null}'
    expect(extractLastJsonObject(raw)).toBeNull()
  })

  test("envelope where `error: null` is intentionally accepted", () => {
    const raw = '{"error": null}'
    const r = extractLastJsonObject(raw)
    // `error: null` IS a documented sentinel meaning "no error".
    expect(r).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// modelsModifiedSince: unusual filesystem layouts
// ---------------------------------------------------------------------------

describe("BUG: modelsModifiedSince unusual layouts", () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "mms-w7-"))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("models/ that is itself a symlink to a sibling directory", async () => {
    const real = join(dir, "real_models")
    await fs.mkdir(real)
    await fs.writeFile(join(real, "a.sql"), "select 1")
    try {
      await fs.symlink(real, join(dir, "models"))
    } catch {
      return
    }
    const result = await modelsModifiedSince(dir, 0)
    // BUG: today, symlinked-as-directory might not be entered. Test that
    // SQL files inside it are still found.
    expect(result.some((p) => p.endsWith("a.sql"))).toBe(true)
  })

  test("`models` file (not directory) at root level", async () => {
    await fs.writeFile(join(dir, "models"), "I am not a directory")
    expect(await modelsModifiedSince(dir, 0)).toEqual([])
  })

  test("path with `models` substring in a longer name should NOT match", async () => {
    // `submodels/foo.sql` should not match `models` as a path component.
    const sub = join(dir, "submodels")
    await fs.mkdir(sub)
    await fs.writeFile(join(sub, "x.sql"), "select 1")
    const result = await modelsModifiedSince(dir, 0)
    expect(result.some((p) => p.endsWith("x.sql"))).toBe(false)
  })

  test("path with `models_v2` (suffix variant) should NOT match `models`", async () => {
    const sub = join(dir, "models_v2")
    await fs.mkdir(sub)
    await fs.writeFile(join(sub, "x.sql"), "select 1")
    const result = await modelsModifiedSince(dir, 0)
    expect(result.some((p) => p.endsWith("x.sql"))).toBe(false)
  })

  test("path component `dbt_models` (compound name) should NOT match `models`", async () => {
    const sub = join(dir, "dbt_models")
    await fs.mkdir(sub)
    await fs.writeFile(join(sub, "x.sql"), "select 1")
    const result = await modelsModifiedSince(dir, 0)
    expect(result.some((p) => p.endsWith("x.sql"))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// findDbtProjectRoot: deep edge cases
// ---------------------------------------------------------------------------

describe("BUG: findDbtProjectRoot deep edge cases", () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "fdpr-w7-"))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("3 sibling projects — alphabetically first returned (deterministic)", async () => {
    await fs.mkdir(join(dir, "zeta"))
    await fs.mkdir(join(dir, "alpha"))
    await fs.mkdir(join(dir, "middle"))
    await fs.writeFile(join(dir, "zeta", "dbt_project.yml"), "name: z")
    await fs.writeFile(join(dir, "alpha", "dbt_project.yml"), "name: a")
    await fs.writeFile(join(dir, "middle", "dbt_project.yml"), "name: m")
    const r = await findDbtProjectRoot(dir)
    expect(r).toBe(join(dir, "alpha"))
  })

  test("subdirectory has BOTH dbt_project.yml as a file AND a dir — file should win semantically", async () => {
    const sub = join(dir, "weird")
    await fs.mkdir(sub)
    // Can't have both a file and dir with same name; skip if FS doesn't allow.
    await fs.writeFile(join(sub, "dbt_project.yml"), "name: weird")
    const r = await findDbtProjectRoot(dir)
    expect(r).toBe(sub)
  })

  test("project nested 2 levels deep (NOT supported by current contract)", async () => {
    const deep = join(dir, "a", "b")
    await fs.mkdir(deep, { recursive: true })
    await fs.writeFile(join(deep, "dbt_project.yml"), "name: deep")
    // Today, search depth = 1. Document that depth=2 is not found.
    expect(await findDbtProjectRoot(dir)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// runWithConcurrencyLimit — additional invariants
// ---------------------------------------------------------------------------

describe("BUG: runWithConcurrencyLimit invariants", () => {
  test("fn is called exactly once per item (no double-invocation)", async () => {
    const seen = new Map<number, number>()
    await runWithConcurrencyLimit(
      Array.from({ length: 50 }, (_, i) => i),
      async (n) => {
        seen.set(n, (seen.get(n) ?? 0) + 1)
        return n
      },
      8,
    )
    // Every item should be exactly once.
    for (let i = 0; i < 50; i++) {
      expect(seen.get(i)).toBe(1)
    }
  })

  test("items array containing `undefined`/`null` is not filtered", async () => {
    const items: (number | null | undefined)[] = [1, null, 2, undefined, 3]
    const out = await runWithConcurrencyLimit(items, async (v) => v, 2)
    expect(out).toEqual([1, null, 2, undefined, 3])
  })

  test("limit of 1 (serial mode) actually runs one at a time", async () => {
    let active = 0
    let peak = 0
    await runWithConcurrencyLimit([1, 2, 3, 4], async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
    }, 1)
    expect(peak).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// modelNameFromPath — Windows-style + URL paths
// ---------------------------------------------------------------------------

describe("BUG: modelNameFromPath cross-platform", () => {
  test("Windows path with mixed separators normalises correctly", () => {
    // After fix: backslashes are normalised to `/` before basename() so the
    // model name resolves to "foo" regardless of host OS.
    const r = modelNameFromPath("C:\\models/foo.sql")
    expect(r).toBe("foo")
  })

  test("URL-encoded path component", () => {
    expect(modelNameFromPath("/m/foo%2Ebar.sql")).toBe("foo%2Ebar")
  })

  test("path component with embedded newline + .sql", () => {
    expect(modelNameFromPath("/m/foo\nbar.sql")).toBe("foo\nbar")
  })
})
// altimate_change end
