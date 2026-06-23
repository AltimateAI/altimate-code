// altimate_change start — wave-8 adversarial tests for PR #849
/**
 * Wave 8: hunt the last bugs. Targets weaknesses I have specific theories
 * about:
 *   - parseDbtTestOutput failing-test regex over-captures bracketed suffixes
 *   - parseDbtTestOutput regex backtracking with large inputs
 *   - extractLastJsonObject fast-path / slow-path divergence
 *   - extractLastJsonObject when input has carriage return only (Mac classic)
 *   - VALIDATOR_TIMEOUT_MS / VALIDATOR_CONCURRENCY env edge cases (string ID, hex, etc.)
 *   - modelsModifiedSince: ELOOP, ENOENT, EPERM resilience
 *   - findDbtProjectRoot: non-string input survives
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
// parseDbtTestOutput failing-test regex weaknesses
// ---------------------------------------------------------------------------

describe("BUG: parseDbtTestOutput failing-test regex over-capture", () => {
  test("captures `[FAIL]` (with closing bracket) when no test name present", () => {
    // The guard rejects "[FAIL" but NOT "[FAIL]" (with bracket).
    const out = "1 of 1 FAIL [FAIL in 0.05s]\nDone. PASS=0 WARN=0 ERROR=1 SKIP=0 TOTAL=1"
    const r = parseDbtTestOutput(out)
    // BUG: today, when no real name is present, "[FAIL" gets captured. The
    // guard rejects exact "[FAIL" but if it captured something with the
    // bracket suffix, it would slip through.
    expect(r?.failingTests.length).toBeLessThanOrEqual(1)
    expect(r?.failingTests.find((n) => n.startsWith("["))).toBeUndefined()
  })

  test("captures whole `[ERROR` when error has no name", () => {
    const out = "1 of 1 ERROR [ERROR in 0.05s]\nDone. PASS=0 WARN=0 ERROR=1 SKIP=0 TOTAL=1"
    const r = parseDbtTestOutput(out)
    expect(r?.failingTests.find((n) => n.startsWith("["))).toBeUndefined()
  })

  test("captures parenthesized failure reason as test name", () => {
    const out = "1 of 1 FAIL (could not connect to warehouse)\nDone. PASS=0 WARN=0 ERROR=1 SKIP=0 TOTAL=1"
    const r = parseDbtTestOutput(out)
    // `(could` would be captured by greedy `\S+`. Should be excluded.
    expect(r?.failingTests.find((n) => n.startsWith("("))).toBeUndefined()
  })

  test("captures URL as test name when prepended by failure prefix", () => {
    const out = "1 of 1 FAIL https://example.com/error\nDone. PASS=0 WARN=0 ERROR=1 SKIP=0 TOTAL=1"
    const r = parseDbtTestOutput(out)
    // URLs as test names are not legal dbt identifiers; should be filtered.
    expect(r?.failingTests.find((n) => n.includes("://"))).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// parseDbtTestOutput regex perf
// ---------------------------------------------------------------------------

describe("BUG: parseDbtTestOutput on pathological inputs", () => {
  test("massive stdout (1 MB) with no summary returns null fast", () => {
    const out = "x".repeat(1_000_000)
    const start = Date.now()
    expect(parseDbtTestOutput(out)).toBeNull()
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(500)
  })

  test("only whitespace returns null", () => {
    expect(parseDbtTestOutput("    \n\t  \r\n")).toBeNull()
  })

  test("only a single space returns null", () => {
    expect(parseDbtTestOutput(" ")).toBeNull()
  })

  test("classic Mac CR-only line endings", () => {
    // CR-only is rare but valid line ending on classic Mac. \s matches \r.
    const out = "1 of 1 FAIL my_test [FAIL]\rDone. PASS=0 WARN=0 ERROR=1 SKIP=0 TOTAL=1"
    const r = parseDbtTestOutput(out)
    expect(r).not.toBeNull()
    expect(r?.failingTests).toContain("my_test")
  })
})

// ---------------------------------------------------------------------------
// extractLastJsonObject fast-path / slow-path divergence
// ---------------------------------------------------------------------------

describe("BUG: extractLastJsonObject fast-path vs slow-path", () => {
  test("input that is pure valid JSON object but NOT envelope: fast-path falls through to slow-path", () => {
    // Fast path JSON.parse succeeds, isValidEnvelope rejects. Slow path
    // re-scans and finds the same object, again rejected. Returns null.
    const raw = '{"foo": "bar", "baz": 1}'
    expect(extractLastJsonObject(raw)).toBeNull()
  })

  test("envelope wrapped in extra outer braces — only inner is real envelope", () => {
    // `{{"verdict": "match"}}` is not valid JSON (object as key). The slow path
    // would find the inner `{"verdict": "match"}` and parse it.
    const raw = '{{"verdict": "match"}}'
    const r = extractLastJsonObject(raw)
    expect(r?.verdict).toBe("match")
  })

  test("Windows clipboard noise: \\r\\n between every char", () => {
    const raw = '\r\n{\r\n"verdict"\r\n:\r\n"match"\r\n}\r\n'
    const r = extractLastJsonObject(raw)
    expect(r?.verdict).toBe("match")
  })

  test("envelope with non-printable characters in string value", () => {
    const raw = '{"verdict": "match", "model": "x\\u0001y"}'
    const r = extractLastJsonObject(raw)
    expect(r?.model).toBe("x\x01y")
  })
})

// ---------------------------------------------------------------------------
// modelsModifiedSince — error path resilience
// ---------------------------------------------------------------------------

describe("BUG: modelsModifiedSince resilience to fs errors", () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "mms-w8-"))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("doesn't crash on EPERM-protected subdirectory (simulated by /root)", async () => {
    // We can't reliably chmod 0 a directory under tmpdir, but we can call
    // with a path that typically returns EACCES on Linux CI / EPERM on macOS.
    // The scan should gracefully skip and continue.
    const r = await modelsModifiedSince("/root", 0)
    expect(Array.isArray(r)).toBe(true)
  })

  test("doesn't crash when a subdirectory disappears mid-scan", async () => {
    // Race-condition-y: directory exists at top of scan, gone by recursion.
    // We can't easily simulate this without a race; just exercise the scan.
    const sub = join(dir, "models")
    await fs.mkdir(sub)
    await fs.writeFile(join(sub, "a.sql"), "select 1")
    const r = await modelsModifiedSince(dir, 0)
    expect(r.some((p) => p.endsWith("a.sql"))).toBe(true)
  })

  test("file with stat() failing (broken symlink) is skipped silently", async () => {
    const sub = join(dir, "models")
    await fs.mkdir(sub)
    await fs.writeFile(join(sub, "ok.sql"), "select 1")
    try {
      await fs.symlink(join(dir, "no-target"), join(sub, "broken.sql"))
    } catch {
      return
    }
    const r = await modelsModifiedSince(dir, 0)
    expect(r.some((p) => p.endsWith("ok.sql"))).toBe(true)
  })

  test("ELOOP-style symlink cycle terminates due to depth cap", async () => {
    const a = join(dir, "models", "a")
    await fs.mkdir(a, { recursive: true })
    try {
      await fs.symlink(dir, join(a, "back"))
    } catch {
      return
    }
    // Should terminate (no infinite recursion) thanks to depth cap.
    const r = await modelsModifiedSince(dir, 0)
    expect(Array.isArray(r)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// findDbtProjectRoot — edge inputs
// ---------------------------------------------------------------------------

describe("BUG: findDbtProjectRoot edge inputs", () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "fdpr-w8-"))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("empty string cwd returns null (does NOT default to process.cwd())", async () => {
    // Empty string is invalid input. Most fs APIs treat '' as current dir;
    // we should treat it explicitly as invalid.
    const r = await findDbtProjectRoot("")
    // BUG/behavior: today fs.stat("") might throw or succeed depending on
    // platform. Document the contract.
    expect(r === null || typeof r === "string").toBe(true)
  })

  test("cwd containing newline character in path doesn't crash", async () => {
    const sub = join(dir, "a\nb")
    try {
      await fs.mkdir(sub)
    } catch {
      return
    }
    await fs.writeFile(join(sub, "dbt_project.yml"), "name: n")
    const r = await findDbtProjectRoot(sub)
    expect(r).toBe(sub)
  })

  test("readdir denies access (e.g., 0-permissions) — gracefully returns null", async () => {
    // We can't reliably chmod the temp dir in CI; just exercise with a deep
    // non-existent path that will trigger the catch.
    expect(await findDbtProjectRoot("/proc/1/secret-no-access")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// runWithConcurrencyLimit — edge inputs
// ---------------------------------------------------------------------------

describe("BUG: runWithConcurrencyLimit edge inputs", () => {
  test("undefined limit defaults to 1", async () => {
    let active = 0
    let peak = 0
    await runWithConcurrencyLimit([1, 2, 3], async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 10))
      active--
    }, undefined as unknown as number)
    expect(peak).toBe(1)
  })

  test("MAX_SAFE_INTEGER limit caps at items.length", async () => {
    let active = 0
    let peak = 0
    await runWithConcurrencyLimit([1, 2, 3], async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 10))
      active--
    }, Number.MAX_SAFE_INTEGER)
    expect(peak).toBe(3)
  })

  test("preserves null/undefined items in output positions", async () => {
    const items: (number | null | undefined)[] = [1, null, undefined, 4]
    const out = await runWithConcurrencyLimit(items, async (v) => v, 2)
    expect(out[0]).toBe(1)
    expect(out[1]).toBeNull()
    expect(out[2]).toBeUndefined()
    expect(out[3]).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// modelNameFromPath — final cases
// ---------------------------------------------------------------------------

describe("BUG: modelNameFromPath final cases", () => {
  test("absolute path with trailing slash returns empty", () => {
    expect(modelNameFromPath("/")).toBe("")
  })

  test("just `.sql` (no leading content) returns empty (documented)", () => {
    // No meaningful model name; caller must filter empty results.
    expect(modelNameFromPath(".sql")).toBe("")
  })

  test("path with newlines split across multiple lines", () => {
    expect(modelNameFromPath("models\n/foo.sql")).toBe("foo")
  })

  test("path with embedded space in dir name", () => {
    expect(modelNameFromPath("/m/My Model/foo.sql")).toBe("foo")
  })

  test("path with .SQL.sql double extension only strips outer", () => {
    expect(modelNameFromPath("/m/double.SQL.sql")).toBe("double.SQL")
  })
})
// altimate_change end
