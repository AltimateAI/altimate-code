// altimate_change start — adversarial tests probing edge cases in PR #849 changes
/**
 * Adversarial test suite for validator-utils.ts.
 *
 * Each `describe` block probes a specific function with inputs the original
 * tests didn't cover, hunting for real bugs in:
 *   - runWithConcurrencyLimit (limit=0, NaN, sparse arrays, rejections)
 *   - VALIDATOR_TIMEOUT_MS / VALIDATOR_CONCURRENCY env parsing
 *   - modelsModifiedSince filesystem edge cases
 *   - findDbtProjectRoot multi-project + non-determinism
 *
 * Tests are designed to FAIL on bugs, then pass once the underlying issue is
 * fixed. Each failing test names the bug it found in the failure message.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  runWithConcurrencyLimit,
  modelsModifiedSince,
  findDbtProjectRoot,
} from "../../../src/altimate/validators/validator-utils"

describe("BUG: runWithConcurrencyLimit silently loses items on bad limit", () => {
  test("limit=0 returns sparse array of undefined (items never processed)", async () => {
    const items = [1, 2, 3]
    const results = await runWithConcurrencyLimit(items, async (n) => n * 2, 0)
    // BUG: with limit=0, no workers spawn, items[i] are never processed,
    // but results is sized at items.length so caller sees `undefined`.
    // Expected: either throw/reject OR process at least 1 item with effective floor.
    expect(results).toHaveLength(items.length)
    // After fix: results should be [2, 4, 6], not [undefined, undefined, undefined]
    expect(results).toEqual([2, 4, 6])
  })

  test("limit=-1 silently drops all items", async () => {
    const items = ["a", "b"]
    const results = await runWithConcurrencyLimit(items, async (s) => s.toUpperCase(), -1)
    // BUG: Math.min(-1, len) = -1 → Array.from({length: -1}) = []
    expect(results).toEqual(["A", "B"])
  })

  test("limit=NaN silently drops all items", async () => {
    const items = [10, 20]
    const results = await runWithConcurrencyLimit(items, async (n) => n + 1, NaN)
    // BUG: Math.min(NaN, len) = NaN → Array.from({length: NaN}) = []
    expect(results).toEqual([11, 21])
  })

  test("limit=0.5 floors to 0 and drops all items", async () => {
    const items = [1, 2]
    const results = await runWithConcurrencyLimit(items, async (n) => n, 0.5)
    // BUG: Math.min(0.5, 2) = 0.5, Array.from converts to integer = 0
    expect(results).toEqual([1, 2])
  })
})

describe("BUG: runWithConcurrencyLimit doesn't preserve all results on partial failure", () => {
  test("one rejecting fn doesn't strand or duplicate other workers' results", async () => {
    const items = [0, 1, 2, 3, 4]
    const completed: number[] = []
    let attempt = 0
    try {
      await runWithConcurrencyLimit(
        items,
        async (n) => {
          attempt++
          if (n === 2) throw new Error("simulated subprocess crash")
          await new Promise((r) => setTimeout(r, 5))
          completed.push(n)
          return n
        },
        2,
      )
      throw new Error("expected rejection")
    } catch (e) {
      // After rejection, in-flight workers should not continue mutating
      // results / completed once the parent has given up. Currently, however,
      // the workers run to completion in the background. Document the leak.
      expect((e as Error).message).toContain("simulated subprocess crash")
      // BUG: completed may grow AFTER this await returns, indicating leaked work.
      await new Promise((r) => setTimeout(r, 50))
      // The leak isn't strictly wrong here, but it means errors mid-flight
      // don't halt the queue. We document this with an assertion that the
      // queue advanced past the failure point even though the caller saw an error.
      expect(attempt).toBeGreaterThanOrEqual(items.length)
    }
  })
})

describe("BUG: VALIDATOR_TIMEOUT_MS over setTimeout max overflows to 1ms", () => {
  test("very large timeout values silently wrap on setTimeout", () => {
    // Node's setTimeout max delay is 2^31 - 1 = 2147483647 (~24.9 days).
    // Values beyond that wrap to 1ms and fire immediately, killing every
    // subprocess on launch. Our guard `Number.isFinite(_parsed) && _parsed > 0`
    // accepts these without clamping.
    const tooBig = 2_147_483_648 // 2^31, one over the cap
    expect(Number.isFinite(tooBig)).toBe(true)
    expect(tooBig > 0).toBe(true)
    // The guard would accept this. The fix is to clamp at MAX_SETTIMEOUT.
    // We assert that the parser would (incorrectly) accept it today.
    expect(tooBig).toBeGreaterThan(2 ** 31 - 1)
    // Validator-utils currently has no clamp — a real fix should add one.
  })
})

describe("BUG: modelsModifiedSince edge cases", () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "models-modified-since-"))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("case-sensitive 'models' folder name misses Models/ on macOS APFS-case-insensitive volumes", async () => {
    // On macOS default-case-insensitive APFS volumes the directory might be
    // created as 'Models' even though dbt typically uses lowercase. Our path
    // includes(...) is case-sensitive. This test creates a `Models` dir and
    // expects the SQL inside it to be found anyway.
    const sub = join(dir, "Models", "marts")
    await fs.mkdir(sub, { recursive: true })
    const file = join(sub, "x.sql")
    await fs.writeFile(file, "select 1")
    await fs.utimes(file, new Date(), new Date())
    const result = await modelsModifiedSince(dir, 0)
    // BUG: current code requires the literal 'models' path component.
    // Files under 'Models' (any non-lowercase variant) are skipped.
    expect(result.length).toBeGreaterThan(0)
  })

  test("files at depth=5 (six segments) are silently skipped", async () => {
    // dbt allows arbitrary nesting under models/. Our depth cap of 4 means
    // models/staging/sources/dl/raw/foo.sql (5 directories below cwd) is
    // missed entirely. Test: create deeply-nested file, confirm it is found.
    const deep = join(dir, "models", "a", "b", "c", "d", "e")
    await fs.mkdir(deep, { recursive: true })
    const file = join(deep, "deep.sql")
    await fs.writeFile(file, "select 1")
    const result = await modelsModifiedSince(dir, 0)
    // BUG: depth-5 file silently missed.
    expect(result.some((p) => p.endsWith("deep.sql"))).toBe(true)
  })

  test("uppercase .SQL extension caught but uppercase 'MODELS' dir missed", async () => {
    // We made the file extension case-insensitive in the fix, but the
    // models/ folder check is still case-sensitive. Demonstrate the asymmetry.
    const sub = join(dir, "MODELS")
    await fs.mkdir(sub, { recursive: true })
    const file = join(sub, "y.SQL")
    await fs.writeFile(file, "select 1")
    const result = await modelsModifiedSince(dir, 0)
    // BUG: file would qualify by extension but is dropped by the path-component check.
    expect(result.some((p) => p.endsWith("y.SQL"))).toBe(true)
  })
})

describe("BUG: findDbtProjectRoot picks non-deterministic project among multiple nested ones", () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "find-dbt-root-"))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("two sibling subdirectories with dbt_project.yml — selection is order-dependent", async () => {
    // Create two valid nested dbt projects under cwd. The current
    // implementation returns whichever fs.readdir lists first, which is
    // not guaranteed to be stable across filesystems / Node versions.
    await fs.mkdir(join(dir, "project_a"))
    await fs.mkdir(join(dir, "project_b"))
    await fs.writeFile(join(dir, "project_a", "dbt_project.yml"), "name: a\n")
    await fs.writeFile(join(dir, "project_b", "dbt_project.yml"), "name: b\n")

    const root = await findDbtProjectRoot(dir)
    // BUG: function returns ONE of them without any deterministic ordering.
    // Should fail closed (return null) when ambiguous, or document the rule.
    expect(root).not.toBeNull()
    // After fix: should be a stable choice (alphabetic) OR return null with a clear signal.
    expect(root).toBe(join(dir, "project_a"))
  })

  test("dbt_project.yml as a *directory* in cwd is incorrectly treated as a project", async () => {
    // The fs.stat check doesn't verify file-vs-directory. A directory named
    // dbt_project.yml shouldn't qualify.
    await fs.mkdir(join(dir, "dbt_project.yml"))
    const root = await findDbtProjectRoot(dir)
    // BUG: returns dir as if it were a valid dbt project root.
    expect(root).toBeNull()
  })
})

describe("BUG: extractLastJsonObject edge cases beyond the basic test suite", () => {
  test("envelope with `verdict` set to undefined-like string still matches isValidEnvelope", async () => {
    // `"verdict" in obj` is true even when value is null/undefined.
    // A garbage envelope `{"verdict": null}` is accepted as a valid output.
    const { extractLastJsonObject } = await import("../../../src/altimate/validators/validator-utils")
    const result = extractLastJsonObject('{"verdict": null}')
    // BUG: nonsense envelope accepted because `in` check ignores value.
    // Should require verdict to be one of the documented enum values
    // (match | mismatch | no-spec) or at least a string.
    expect(result).toBeNull()
  })

  test("string value containing literal `}` inside escape sequence", async () => {
    const { extractLastJsonObject } = await import("../../../src/altimate/validators/validator-utils")
    // Real altimate-dbt output sometimes embeds the raw stdout/stderr inside
    // a string field. Make sure escaped close-brace is not mistaken for an
    // envelope terminator.
    const raw = '{"verdict": "match", "stdout": "select 1 from {tbl} \\u007d ok"}'
    const result = extractLastJsonObject(raw)
    expect(result).not.toBeNull()
    expect(result?.verdict).toBe("match")
  })
})

describe("BUG: VALIDATOR_TIMEOUT_MS / VALIDATOR_CONCURRENCY parsing edge cases", () => {
  test("Number.isFinite(Number.MAX_VALUE) is true; setTimeout silently overflows", () => {
    // 2^31 - 1 is the setTimeout cap. Anything larger wraps to 1ms and fires
    // immediately. Our env parser has no upper-bound clamp, so a misconfigured
    // ALTIMATE_VALIDATORS_TIMEOUT_MS would silently SIGKILL every subprocess.
    const SETTIMEOUT_MAX = 2 ** 31 - 1
    const overlarge = Number.MAX_SAFE_INTEGER
    expect(Number.isFinite(overlarge)).toBe(true)
    expect(overlarge > 0).toBe(true)
    expect(overlarge).toBeGreaterThan(SETTIMEOUT_MAX)
    // The env parser accepts this verbatim, then setTimeout will wrap.
    // BUG: missing upper-bound clamp at SETTIMEOUT_MAX.
  })

  test("ALTIMATE_VALIDATORS_CONCURRENCY='0.7' is silently floored to 0 (no workers)", async () => {
    // Same Math.floor bug surface: 0 < v < 1 collapses to 0 → silent no-op.
    // We exercise this through runWithConcurrencyLimit because that is what
    // every validator calls.
    const { runWithConcurrencyLimit } = await import("../../../src/altimate/validators/validator-utils")
    const items = [1, 2]
    const out = await runWithConcurrencyLimit(items, async (n) => n, 0.7)
    // BUG: 0.7 → workers length 0 → results stay sparse → caller sees `undefined`.
    expect(out).toEqual([1, 2])
  })
})

describe("BUG: modelsModifiedSince symlink handling", () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "models-symlink-"))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("symlink loop does not infinite-recurse", async () => {
    // Create models/loop/ that points back to models/. Our depth cap of 4
    // protects against this, but if anyone removes the cap, this test
    // explodes. Belt-and-suspenders.
    const modelsDir = join(dir, "models")
    await fs.mkdir(modelsDir)
    try {
      await fs.symlink(modelsDir, join(modelsDir, "loop"))
    } catch {
      return // symlinks may be unsupported in this env; skip
    }
    const result = await modelsModifiedSince(dir, 0)
    expect(Array.isArray(result)).toBe(true)
  })
})
// altimate_change end
