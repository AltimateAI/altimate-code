// altimate_change start — wave-10 adversarial tests for PR #849
/**
 * Wave 10: final hunt. Targets known-weak regex / parsing surfaces:
 *   - parseDbtTestOutput: anchored counts via newline/start-of-line
 *   - extractLastJsonObject: weird-but-legal JSON values
 *   - modelsModifiedSince: case-sensitive node_modules skip
 *   - findDbtProjectRoot: project file with size 0 / weird names
 *   - escapeXmlAttr theoretical compliance
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
// parseDbtTestOutput — more regex weaknesses
// ---------------------------------------------------------------------------

describe("BUG: parseDbtTestOutput more regex weaknesses (wave 10)", () => {
  test("FAIL count line embedded inside `BUILD_FAILED`-style logs", () => {
    // Some CI tools print messages like:
    //   "5 of 10 BUILD_FAILED occurred during run"
    // The regex matches `\d+ of \d+ FAIL` but not within BUILD_FAILED.
    // Confirm we don't false-positive.
    const out = "5 of 10 BUILD_FAILED occurred during run\nDone. PASS=10 WARN=0 ERROR=0 SKIP=0 TOTAL=10"
    const r = parseDbtTestOutput(out)
    expect(r?.failingTests).toEqual([])
  })

  test("dbt prints summary using `Completed.` instead of `Done.`", () => {
    // Hypothetical future format change.
    const out = "Completed. PASS=1 WARN=0 ERROR=0 SKIP=0 TOTAL=1"
    expect(parseDbtTestOutput(out)).toBeNull()
  })

  test("locale-sensitive `Done.` (Spanish: `Hecho.`)", () => {
    const out = "Hecho. PASS=1 WARN=0 ERROR=0 SKIP=0 TOTAL=1"
    expect(parseDbtTestOutput(out)).toBeNull()
  })

  test("summary line with extra spaces between Done. and PASS", () => {
    const out = "Done.        PASS=2 WARN=0 ERROR=0 SKIP=0 TOTAL=2"
    const r = parseDbtTestOutput(out)
    expect(r?.pass).toBe(2)
  })

  test("FAIL line with very-long test name (1000 chars)", () => {
    const longName = "t".repeat(1000)
    const out = `1 of 1 FAIL ${longName} [FAIL]\nDone. PASS=0 WARN=0 ERROR=1 SKIP=0 TOTAL=1`
    const r = parseDbtTestOutput(out)
    expect(r?.failingTests[0]).toBe(longName)
  })

  test("FAIL line with test name containing colons (schema:model:test)", () => {
    const out = "1 of 1 FAIL public:my_model:unique [FAIL]\nDone. PASS=0 WARN=0 ERROR=1 SKIP=0 TOTAL=1"
    const r = parseDbtTestOutput(out)
    expect(r?.failingTests).toContain("public:my_model:unique")
  })

  test("Done. embedded inside a quote: \"Done. PASS=...\"", () => {
    // A logged string literal containing the summary format. The regex
    // doesn't care about quote context.
    const out = '"Done. PASS=99 WARN=0 ERROR=0 SKIP=0 TOTAL=99"'
    const r = parseDbtTestOutput(out)
    // BUG: it matches inside a literal string. Should ideally anchor on
    // start-of-line.
    expect(r?.pass).toBe(99)
  })
})

// ---------------------------------------------------------------------------
// extractLastJsonObject — additional weirdness
// ---------------------------------------------------------------------------

describe("BUG: extractLastJsonObject additional weirdness (wave 10)", () => {
  test("envelope where `stdout` is itself a number (type contract violation)", () => {
    const raw = '{"stdout": 12345}'
    const r = extractLastJsonObject(raw)
    expect(r).not.toBeNull()
    // BUG: stdout should be string-typed in practice; caller may crash.
    expect(typeof r?.stdout).toBe("number")
  })

  test("envelope with reserved-word-like key `__proto__`", () => {
    // `__proto__` as a JSON key is a known prototype-pollution vector.
    const raw = '{"verdict": "match", "__proto__": {"polluted": true}}'
    const r = extractLastJsonObject(raw)
    expect(r?.verdict).toBe("match")
    // After parse, accessing r.polluted should be undefined (Object.create-style).
    // Different JSON.parse implementations behave differently. Confirm safe.
    expect((r as unknown as { polluted?: boolean }).polluted).toBeUndefined()
  })

  test("envelope with very small floating point loses precision (0.1 + 0.2)", () => {
    const raw = '{"verdict": "match", "n": 0.30000000000000004}'
    const r = extractLastJsonObject(raw)
    expect(r?.n).toBe(0.30000000000000004)
  })

  test("envelope with deeply nested object (5 levels)", () => {
    const raw = '{"verdict": "match", "deep": {"a": {"b": {"c": {"d": 1}}}}}'
    const r = extractLastJsonObject(raw)
    const deep = r?.deep as Record<string, unknown>
    expect(((deep?.a as any)?.b?.c?.d)).toBe(1)
  })

  test("envelope with mixed-type array values", () => {
    const raw = '{"columns_extra": [1, "two", null, true, [{"x": 1}]]}'
    const r = extractLastJsonObject(raw)
    expect(Array.isArray(r?.columns_extra)).toBe(true)
    expect((r?.columns_extra as unknown[]).length).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// modelsModifiedSince — case-sensitivity probes
// ---------------------------------------------------------------------------

describe("BUG: modelsModifiedSince final probes", () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "mms-w10-"))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("NODE_MODULES (uppercase) is still SCANNED (case-sensitive skip)", async () => {
    // We skip "node_modules" exactly; NODE_MODULES is a different name.
    // Today, this dir would be scanned. Document.
    const nm = join(dir, "models", "NODE_MODULES")
    await fs.mkdir(nm, { recursive: true })
    await fs.writeFile(join(nm, "x.sql"), "select 1")
    const result = await modelsModifiedSince(dir, 0)
    // BUG/feature: today returns the file. Reviewers may want case-insensitive skip.
    expect(result.some((p) => p.endsWith("x.sql"))).toBe(true)
  })

  test("`TARGET` (uppercase) is scanned (we only skip lowercase `target`)", async () => {
    const t = join(dir, "models", "TARGET")
    await fs.mkdir(t, { recursive: true })
    await fs.writeFile(join(t, "x.sql"), "select 1")
    const result = await modelsModifiedSince(dir, 0)
    expect(result.some((p) => p.endsWith("x.sql"))).toBe(true)
  })

  test("directory named `target.bak` is NOT skipped (only exact `target` is)", async () => {
    const t = join(dir, "models", "target.bak")
    await fs.mkdir(t, { recursive: true })
    await fs.writeFile(join(t, "x.sql"), "select 1")
    const result = await modelsModifiedSince(dir, 0)
    expect(result.some((p) => p.endsWith("x.sql"))).toBe(true)
  })

  test("models/snapshots/foo.sql under `snapshots/` is found (path matches `models` ancestor)", async () => {
    const sub = join(dir, "models", "snapshots")
    await fs.mkdir(sub, { recursive: true })
    await fs.writeFile(join(sub, "foo.sql"), "select 1")
    const r = await modelsModifiedSince(dir, 0)
    expect(r.some((p) => p.endsWith("foo.sql"))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// findDbtProjectRoot — final variants
// ---------------------------------------------------------------------------

describe("BUG: findDbtProjectRoot final variants", () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "fdpr-w10-"))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("subdirectory named `.hidden` containing dbt_project.yml is SKIPPED", async () => {
    const hidden = join(dir, ".hidden_project")
    await fs.mkdir(hidden)
    await fs.writeFile(join(hidden, "dbt_project.yml"), "name: hidden")
    // findDbtProjectRoot skips dotfile directories like modelsModifiedSince does.
    expect(await findDbtProjectRoot(dir)).toBeNull()
  })

  test("subdirectory named `node_modules` containing dbt_project.yml is NOT skipped", async () => {
    // findDbtProjectRoot does NOT filter node_modules. This is intentional?
    // Probably not — npm packages might contain dbt project fixtures.
    const nm = join(dir, "node_modules")
    await fs.mkdir(nm)
    await fs.writeFile(join(nm, "dbt_project.yml"), "name: pkg")
    // BUG: today returns node_modules; should likely skip like modelsModifiedSince does.
    expect(await findDbtProjectRoot(dir)).toBeNull()
  })

  test("subdirectory named `target` containing dbt_project.yml is NOT skipped", async () => {
    const t = join(dir, "target")
    await fs.mkdir(t)
    await fs.writeFile(join(t, "dbt_project.yml"), "name: t")
    // BUG: today returns target; should likely skip like modelsModifiedSince.
    expect(await findDbtProjectRoot(dir)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// runWithConcurrencyLimit — final probes
// ---------------------------------------------------------------------------

describe("BUG: runWithConcurrencyLimit final probes (wave 10)", () => {
  test("VERY large items array (10_000) doesn't stack-overflow", async () => {
    const items = Array.from({ length: 10_000 }, (_, i) => i)
    const out = await runWithConcurrencyLimit(items, async (n) => n, 8)
    expect(out.length).toBe(10_000)
    expect(out[9999]).toBe(9999)
  })

  test("items containing Promises are awaited when fn returns them", async () => {
    const p = Promise.resolve(42)
    const out = await runWithConcurrencyLimit([p], async (v) => v, 1)
    // `async (v) => v` returns whatever fn returns; if it returns a Promise,
    // the outer await unwraps it. So we get 42, not the original Promise.
    expect(out[0]).toBe(42)
  })

  test("works correctly when fn returns same value type as input", async () => {
    const out = await runWithConcurrencyLimit([1, 2, 3], async (n) => n, 2)
    expect(out).toEqual([1, 2, 3])
  })
})

// ---------------------------------------------------------------------------
// modelNameFromPath — final probes
// ---------------------------------------------------------------------------

describe("BUG: modelNameFromPath final probes (wave 10)", () => {
  test("path with leading/trailing whitespace is preserved (not trimmed)", () => {
    expect(modelNameFromPath("  foo.sql  ")).toBe("  foo.sql  ")
  })

  test("path with multiple consecutive dots", () => {
    expect(modelNameFromPath("/m/foo...sql")).toBe("foo..")
  })

  test("path with mixed `.sql` and `.SQL` in same string", () => {
    expect(modelNameFromPath("/m/.sql.SQL")).toBe(".sql")
  })
})
// altimate_change end
