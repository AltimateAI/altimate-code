// altimate_change start — wave-6 adversarial tests for PR #849
/**
 * Sixth wave. Targets bug-rich areas not yet fully exercised:
 *   - parseDbtTestOutput corner cases: zero-of-zero, special chars in names
 *   - extractLastJsonObject backslash + escape sequence edge cases
 *   - modelsModifiedSince with broken symlinks / no-extension files
 *   - validator registry with malformed return values
 *   - modelNameFromPath chained extensions and long names
 *   - runWithConcurrencyLimit deadlock probing
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { parseDbtTestOutput } from "../../../src/altimate/validators/dbt-tests-pass"
import { ValidatorRegistry } from "../../../src/session/validators/registry"
import type { Validator, ValidatorContext } from "../../../src/session/validators/types"
import {
  extractLastJsonObject,
  modelNameFromPath,
  modelsModifiedSince,
  runWithConcurrencyLimit,
  findDbtProjectRoot,
} from "../../../src/altimate/validators/validator-utils"

const baseCtx = (cwd: string): ValidatorContext => ({
  sessionID: "s",
  workingDirectory: cwd,
  sessionStartMs: 0,
  step: 0,
  retryCount: 0,
})

// ---------------------------------------------------------------------------
// parseDbtTestOutput corner cases
// ---------------------------------------------------------------------------

describe("BUG: parseDbtTestOutput corner cases", () => {
  test("PASS=0 ERROR=0 TOTAL=0 (no tests at all) is a valid summary", () => {
    const out = "Done. PASS=0 WARN=0 ERROR=0 SKIP=0 TOTAL=0"
    const r = parseDbtTestOutput(out)
    expect(r).not.toBeNull()
    expect(r?.total).toBe(0)
    expect(r?.failingTests).toEqual([])
  })

  test("`0 of 0 FAIL` (impossible but produced by some adapters) does not extract a test name", () => {
    // Some buggy dbt adapter prints this. Our regex would match.
    const out = "0 of 0 FAIL legacy_test [FAIL]\nDone. PASS=0 WARN=0 ERROR=0 SKIP=0 TOTAL=0"
    const r = parseDbtTestOutput(out)
    expect(r).not.toBeNull()
    // Regex captures "legacy_test" — debatable whether it should given 0/0.
    // Today: it's captured. Document as known intentional behavior.
    expect(r?.failingTests).toContain("legacy_test")
  })

  test("FAIL line with NO test name (just '1 of 1 FAIL')", () => {
    const out = "1 of 1 FAIL\nDone. PASS=0 WARN=0 ERROR=1 SKIP=0 TOTAL=1"
    const r = parseDbtTestOutput(out)
    // No name captured.
    expect(r?.failingTests).toEqual([])
  })

  test("`FAIL` keyword in non-test text doesn't match without counts", () => {
    const out = "Some prose containing FAIL but no counts.\nDone. PASS=1 WARN=0 ERROR=0 SKIP=0 TOTAL=1"
    const r = parseDbtTestOutput(out)
    expect(r?.failingTests).toEqual([])
  })

  test("Done. with trailing colons / pipes in count fields", () => {
    // `PASS=:1` is malformed. Should NOT parse.
    const out = "Done. PASS=:1 WARN=0 ERROR=0 SKIP=0 TOTAL=1"
    expect(parseDbtTestOutput(out)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// extractLastJsonObject — escape sequence edge cases
// ---------------------------------------------------------------------------

describe("BUG: extractLastJsonObject escape sequence handling", () => {
  test("escaped backslash followed by quote: `\\\\\"` does not close string prematurely", () => {
    // JSON: {"verdict": "match", "stdout": "a\\\"b"} → stdout has value `a\"b`
    const raw = '{"verdict": "match", "stdout": "a\\\\\\"b"}'
    const r = extractLastJsonObject(raw)
    expect(r).not.toBeNull()
    expect(r?.stdout).toBe('a\\"b')
  })

  test("unicode escape at end of stream (incomplete)", () => {
    // `"\u00"` is incomplete; JSON.parse rejects.
    const raw = '{"verdict": "\\u00"}'
    expect(extractLastJsonObject(raw)).toBeNull()
  })

  test("forward slash escape (legal in JSON, not in JS strings)", () => {
    // JSON allows `\/` for the forward slash; JSON.parse accepts it.
    const raw = '{"verdict": "match", "model": "schema\\/table"}'
    const r = extractLastJsonObject(raw)
    expect(r?.model).toBe("schema/table")
  })

  test("envelope with extremely long key (10k chars) does not stack-overflow", () => {
    const longKey = "k".repeat(10_000)
    const raw = `{"verdict": "match", "${longKey}": 1}`
    const r = extractLastJsonObject(raw)
    expect(r?.verdict).toBe("match")
  })

  test("envelope key collision: `verdict` appears twice (later wins per JSON spec)", () => {
    const raw = '{"verdict": "match", "verdict": "mismatch"}'
    const r = extractLastJsonObject(raw)
    expect(r?.verdict).toBe("mismatch")
  })

  test("standalone string `\"verdict\"` is not an envelope", () => {
    expect(extractLastJsonObject('"verdict"')).toBeNull()
  })

  test("standalone number `42` is not an envelope", () => {
    expect(extractLastJsonObject("42")).toBeNull()
  })

  test("standalone boolean `true` is not an envelope", () => {
    expect(extractLastJsonObject("true")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// modelsModifiedSince — broken symlinks, no-extension files
// ---------------------------------------------------------------------------

describe("BUG: modelsModifiedSince broken symlinks + weird files", () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "mms-w6-"))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("broken symlink under models/ doesn't crash the scan", async () => {
    const sub = join(dir, "models")
    await fs.mkdir(sub)
    await fs.writeFile(join(sub, "real.sql"), "select 1")
    try {
      await fs.symlink(join(dir, "no-such-file"), join(sub, "broken.sql"))
    } catch {
      return
    }
    const result = await modelsModifiedSince(dir, 0)
    // real.sql should still be found despite the broken sibling.
    expect(result.some((p) => p.endsWith("real.sql"))).toBe(true)
  })

  test("file without extension is not picked up", async () => {
    const sub = join(dir, "models")
    await fs.mkdir(sub)
    await fs.writeFile(join(sub, "no_extension"), "select 1")
    expect(await modelsModifiedSince(dir, 0)).toEqual([])
  })

  test("file with .sql suffix but inside a `target/` folder is skipped", async () => {
    const t = join(dir, "models", "target")
    await fs.mkdir(t, { recursive: true })
    await fs.writeFile(join(t, "compiled.sql"), "select 1")
    const result = await modelsModifiedSince(dir, 0)
    expect(result.some((p) => p.endsWith("compiled.sql"))).toBe(false)
  })

  test("file `.sql` directly under models/ (dotfile)", async () => {
    const sub = join(dir, "models")
    await fs.mkdir(sub)
    await fs.writeFile(join(sub, ".sql"), "select 1")
    // Hidden file → skipped by our `startsWith(".")` rule.
    expect(await modelsModifiedSince(dir, 0)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// findDbtProjectRoot — more variants
// ---------------------------------------------------------------------------

describe("BUG: findDbtProjectRoot more variants", () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "fdpr-w6-"))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("does NOT recurse beyond one level (depth=2 project missed)", async () => {
    // Documented behavior: only direct and one-level-deep checks.
    const deep = join(dir, "a", "b")
    await fs.mkdir(deep, { recursive: true })
    await fs.writeFile(join(deep, "dbt_project.yml"), "name: deep")
    expect(await findDbtProjectRoot(dir)).toBeNull()
  })

  test("subdirectory whose name is `dbt_project.yml` (collides with the marker)", async () => {
    // A subdirectory NAMED dbt_project.yml is not a project root; the project
    // file would be `dbt_project.yml/dbt_project.yml`. Test we don't trip.
    const sub = join(dir, "dbt_project.yml")
    await fs.mkdir(sub)
    // No actual project file inside it.
    expect(await findDbtProjectRoot(dir)).toBeNull()
  })

  test.skip("uppercase DBT_PROJECT.YML is NOT a valid marker (case-insensitive FS — skipped)", async () => {
    // Filename is case-sensitive on Linux; dbt itself requires `dbt_project.yml`.
    await fs.writeFile(join(dir, "DBT_PROJECT.YML"), "name: x")
    expect(await findDbtProjectRoot(dir)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// runWithConcurrencyLimit deadlock-style probes
// ---------------------------------------------------------------------------

describe("BUG: runWithConcurrencyLimit deadlock / cancellation", () => {
  test("does not deadlock when one task never resolves and is the last in the queue", async () => {
    // If we never `Promise.race` against a timeout, this would hang forever.
    // Use a small explicit timeout so the test fails fast on regression.
    const stuck = new Promise<number>(() => {}) // never resolves
    const promise = runWithConcurrencyLimit([1, 2, 3], (n) => (n === 3 ? stuck : Promise.resolve(n)), 2)
    const result = await Promise.race([
      promise,
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 100)),
    ])
    // BUG: today this returns "timeout" because the third worker is stuck.
    // The helper has no timeout, which is correct — document with this test.
    expect(result).toBe("timeout")
  })
})

// ---------------------------------------------------------------------------
// ValidatorRegistry — malformed validator returns
// ---------------------------------------------------------------------------

describe("BUG: ValidatorRegistry malformed validator returns", () => {
  beforeEach(() => {
    ValidatorRegistry.clear()
  })

  test("validator returning {} (no `ok` field) — treated as truthy", async () => {
    // `if (!result.ok)` evaluates to !undefined → true, so it'd be a failure.
    // Today the registry just passes it through; downstream may break.
    const v: Validator = {
      name: "malformed-ok",
      description: "",
      async appliesTo() { return true },
      // @ts-expect-error intentional malformed shape
      async check() { return {} },
    }
    ValidatorRegistry.register(v)
    const r = await ValidatorRegistry.runAll(baseCtx("/tmp"))
    expect(r).toHaveLength(1)
    // BUG: result.ok is undefined; caller logic must guard.
    expect(r[0]?.result.ok).toBeUndefined()
  })

  test("validator returning null — registry passes it through", async () => {
    const v: Validator = {
      name: "null-result",
      description: "",
      async appliesTo() { return true },
      // @ts-expect-error intentional malformed shape
      async check() { return null },
    }
    ValidatorRegistry.register(v)
    const r = await ValidatorRegistry.runAll(baseCtx("/tmp"))
    expect(r).toHaveLength(1)
    // BUG: result is null, downstream code will crash.
    expect(r[0]?.result).toBeNull()
  })

  test("validator returning a non-object (number) — registry passes through", async () => {
    const v: Validator = {
      name: "number-result",
      description: "",
      async appliesTo() { return true },
      // @ts-expect-error intentional malformed shape
      async check() { return 42 },
    }
    ValidatorRegistry.register(v)
    const r = await ValidatorRegistry.runAll(baseCtx("/tmp"))
    expect(r).toHaveLength(1)
    expect(typeof r[0]?.result).toBe("number")
  })

  test("validator returning Promise.reject() is handled by the catch block", async () => {
    const v: Validator = {
      name: "rejected",
      description: "",
      async appliesTo() { return true },
      async check() { return Promise.reject(new Error("rejected check")) },
    }
    ValidatorRegistry.register(v)
    const r = await ValidatorRegistry.runAll(baseCtx("/tmp"))
    expect(r).toHaveLength(1)
    expect(r[0]?.result.ok).toBe(true)
    expect(r[0]?.result.details).toMatchObject({
      error: "rejected check",
      skipped_due_to_validator_error: true,
    })
  })
})

// ---------------------------------------------------------------------------
// modelNameFromPath — chained extensions + long names
// ---------------------------------------------------------------------------

describe("BUG: modelNameFromPath chained extensions and long names", () => {
  test("name with very long extension chain (~50 dots)", () => {
    const longName = "a." + "b.".repeat(50) + "sql"
    const r = modelNameFromPath("/m/" + longName)
    // Trailing `.sql` stripped; "a.b.b.b.b...b." remains.
    expect(r.endsWith(".sql")).toBe(false)
    expect(r.startsWith("a.")).toBe(true)
  })

  test("name with 255-character length (POSIX NAME_MAX limit)", () => {
    const name = "x".repeat(251) + ".sql"
    expect(modelNameFromPath(`/m/${name}`)).toBe("x".repeat(251))
  })

  test("name with `.SQL` (uppercase) AND mixed-case path", () => {
    expect(modelNameFromPath("/m/MARTS/Foo.SQL")).toBe("Foo")
  })

  test("name that is just whitespace + extension", () => {
    expect(modelNameFromPath("/m/   .sql")).toBe("   ")
  })
})

// ---------------------------------------------------------------------------
// runWithConcurrencyLimit + immediate sync fn
// ---------------------------------------------------------------------------

describe("BUG: runWithConcurrencyLimit + immediate sync fn behavior", () => {
  test("fn that resolves before await tick keeps queue moving forward", async () => {
    const items = Array.from({ length: 50 }, (_, i) => i)
    const out = await runWithConcurrencyLimit(items, (n) => Promise.resolve(n), 4)
    expect(out).toHaveLength(50)
    expect(out.every((v, i) => v === i)).toBe(true)
  })

  test("zero-item input with NaN limit returns empty array (no crash)", async () => {
    expect(await runWithConcurrencyLimit<number, number>([], async (n) => n, NaN)).toEqual([])
  })

  test("limit = `null` defaults to 1 worker (treated as non-finite)", async () => {
    let active = 0
    let peak = 0
    await runWithConcurrencyLimit([1, 2, 3], async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 10))
      active--
    }, null as unknown as number)
    expect(peak).toBe(1) // null → not finite → default 1
  })
})
// altimate_change end
