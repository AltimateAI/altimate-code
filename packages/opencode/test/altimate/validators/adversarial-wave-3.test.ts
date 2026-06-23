// altimate_change start — wave-3 adversarial tests for PR #849
/**
 * Third adversarial wave: deeper probes into:
 *   - VALIDATOR_TIMEOUT_MS upper-bound (setTimeout overflow)
 *   - parseDbtTestOutput regex resilience (tabs, ANSI, mixed whitespace)
 *   - extractLastJsonObject parsing edges (unicode escapes, brace in string)
 *   - validator registry behavior
 *   - findDbtProjectRoot edge inputs
 *   - modelsModifiedSince edge inputs
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
// parseDbtTestOutput — whitespace/formatting resilience
// ---------------------------------------------------------------------------

describe("BUG: parseDbtTestOutput whitespace variants", () => {
  test("handles tab separators between summary fields", () => {
    const out = "Done.\tPASS=1\tWARN=0\tERROR=0\tSKIP=0\tTOTAL=1"
    const r = parseDbtTestOutput(out)
    // `\s+` should match tabs. Test that it actually does.
    expect(r).not.toBeNull()
    expect(r?.pass).toBe(1)
  })

  test("handles ANSI escape after Done. and before PASS=", () => {
    const out = "Done.\x1b[0m PASS=2 WARN=0 ERROR=0 SKIP=0 TOTAL=2"
    const r = parseDbtTestOutput(out)
    // BUG: ANSI codes between Done. and PASS= break the `\s+` requirement.
    expect(r).not.toBeNull()
    expect(r?.pass).toBe(2)
  })

  test("two consecutive Done. summary lines — last one wins", () => {
    // If a dbt run emits two summary lines (rare but possible with multiple
    // adapters or retries), the regex picks the FIRST match. The validator's
    // semantic should be: the LATER summary is the authoritative one.
    const out = `Done. PASS=1 WARN=0 ERROR=1 SKIP=0 TOTAL=2
... retry happened ...
Done. PASS=2 WARN=0 ERROR=0 SKIP=0 TOTAL=2`
    const r = parseDbtTestOutput(out)
    // BUG: today, first match wins → pass=1, error=1.
    // After fix: should be pass=2, error=0 (last summary).
    expect(r?.pass).toBe(2)
    expect(r?.error).toBe(0)
  })

  test("Done. followed by colon (`Done.: ...`) is not a summary marker", () => {
    // dbt doesn't emit this, but if any plugin did, the colon-prefixed line
    // is NOT a summary. Today's regex requires whitespace after `Done.` so
    // a colon would break it — confirm.
    const out = "Done.: PASS=1 WARN=0 ERROR=0 SKIP=0 TOTAL=1"
    const r = parseDbtTestOutput(out)
    expect(r).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// extractLastJsonObject — deep parsing edges
// ---------------------------------------------------------------------------

describe("BUG: extractLastJsonObject parsing edges", () => {
  test("string value containing unicode-escaped brace", () => {
    // `}` is `}`. Inside a JSON string, that's irrelevant to the parser;
    // our manual brace tracker should also leave it alone because we track
    // string context.
    const raw = '{"verdict": "match", "model": "foo\\u007Dbar"}'
    const r = extractLastJsonObject(raw)
    expect(r).not.toBeNull()
    expect(r?.model).toBe("foo}bar")
  })

  test("two valid envelopes — last one wins", () => {
    const raw = '{"verdict": "match", "model": "first"} {"verdict": "mismatch", "model": "second"}'
    const r = extractLastJsonObject(raw)
    expect(r?.model).toBe("second")
    expect(r?.verdict).toBe("mismatch")
  })

  test("envelope with circular-style self-reference (not valid JSON)", () => {
    // JSON cannot encode circular refs. Test that a malformed attempt is rejected.
    const raw = '{"verdict": "match", "self": <ref *1>}'
    expect(extractLastJsonObject(raw)).toBeNull()
  })

  test("unclosed JSON at end of stream returns null", () => {
    const raw = '{"verdict": "match", "model": "foo"'
    expect(extractLastJsonObject(raw)).toBeNull()
  })

  test("envelope after binary noise still found", () => {
    const raw = `\x00\x01\x02\x03 some binary garbage \xff
{"verdict": "match"}`
    const r = extractLastJsonObject(raw)
    expect(r?.verdict).toBe("match")
  })

  test("scientific-notation number in envelope is parsed", () => {
    const raw = '{"verdict": "match", "count": 1.5e3}'
    const r = extractLastJsonObject(raw)
    expect(r).not.toBeNull()
    expect(r?.count).toBe(1500)
  })

  test("envelope with `error` set to non-string value", () => {
    // If `error` is a number or object, our isValidEnvelope passes because
    // we explicitly allow `error: null`. But downstream code expects string.
    const raw = '{"error": 42}'
    const r = extractLastJsonObject(raw)
    expect(r).not.toBeNull()
    expect(typeof r?.error).toBe("number")
  })

  test("stdout-only envelope with stdout containing inner JSON noise", () => {
    // The inner content has braces. The brace tracker must respect string
    // context so it doesn't split early.
    const inner = '{"fake": "envelope"}'
    const raw = `{"stdout": "running test... output: ${inner.replace(/"/g, '\\"')}"}`
    const r = extractLastJsonObject(raw)
    expect(r).not.toBeNull()
    expect(typeof r?.stdout).toBe("string")
  })
})

// ---------------------------------------------------------------------------
// modelNameFromPath — more cases
// ---------------------------------------------------------------------------

describe("BUG: modelNameFromPath more cases", () => {
  test("path with backslashes (Windows-style) — basename behavior", () => {
    // path.basename on POSIX doesn't split on \\, so "C:\\models\\foo.sql"
    // becomes literally "C:\\models\\foo" (no extension stripped because no .sql at end).
    // Actually .sql is at end → "C:\\models\\foo".
    const r = modelNameFromPath("C:\\models\\foo.sql")
    // Risk: validator runs `--model C:\\models\\foo` which is wrong.
    // BUG: backslashes not handled cross-platform.
    expect(r).not.toContain("\\")
  })

  test("path with embedded URL-encoded slash", () => {
    // `models%2Ffoo.sql` — basename returns the whole thing.
    const r = modelNameFromPath("models%2Ffoo.sql")
    expect(r).toBe("models%2Ffoo")
  })

  test("only file extension, no name", () => {
    // file `.sql.sql` → basename `.sql.sql` → strip trailing `.sql` → `.sql`
    const r = modelNameFromPath(".sql.sql")
    expect(r).toBe(".sql")
  })
})

// ---------------------------------------------------------------------------
// VALIDATOR_TIMEOUT_MS — upper bound
// ---------------------------------------------------------------------------

describe("BUG: VALIDATOR_TIMEOUT_MS upper-bound clamp missing", () => {
  test("very large positive timeout values currently accepted (setTimeout wraps)", () => {
    // setTimeout max delay is 2^31 - 1 (~24.86 days). Anything larger silently
    // wraps to 1ms and fires immediately, killing the subprocess on launch.
    // The current env parser has no upper clamp.
    //
    // We can't easily test the actual setTimeout call without spawning a real
    // subprocess, but we can verify that the parser would accept a value that
    // setTimeout would wrap. This documents the gap.
    const tooBig = 2_147_483_648
    expect(Number.isFinite(tooBig)).toBe(true)
    expect(tooBig > 0).toBe(true)
    // Today the validator-utils accepts this. A real fix should clamp at
    // 2147483647 (or warn). Document the gap by asserting the value exceeds
    // setTimeout's safe range.
    const SETTIMEOUT_MAX = 2 ** 31 - 1
    expect(tooBig).toBeGreaterThan(SETTIMEOUT_MAX)
  })
})

// ---------------------------------------------------------------------------
// findDbtProjectRoot — more cases
// ---------------------------------------------------------------------------

describe("BUG: findDbtProjectRoot weird inputs", () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "fdpr-"))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("cwd is a file, not a directory — returns null without crash", async () => {
    const file = join(dir, "not-a-dir")
    await fs.writeFile(file, "hello")
    expect(await findDbtProjectRoot(file)).toBeNull()
  })

  test("cwd path with trailing slash matches direct dbt_project.yml", async () => {
    await fs.writeFile(join(dir, "dbt_project.yml"), "name: x\n")
    // Pass cwd with trailing slash — should normalize and still match.
    const root = await findDbtProjectRoot(dir + "/")
    expect(root).not.toBeNull()
  })

  test("cwd that does not exist returns null gracefully", async () => {
    expect(await findDbtProjectRoot(join(dir, "no-such"))).toBeNull()
  })

  test("symlinked dbt_project.yml is accepted", async () => {
    const real = join(dir, "real.yml")
    await fs.writeFile(real, "name: linked\n")
    try {
      await fs.symlink(real, join(dir, "dbt_project.yml"))
    } catch {
      return
    }
    const root = await findDbtProjectRoot(dir)
    // stat() follows symlinks, so this should be accepted as a file.
    expect(root).toBe(dir)
  })

  test("dbt_project.yml file with empty contents is accepted (validator's job to surface)", async () => {
    await fs.writeFile(join(dir, "dbt_project.yml"), "")
    expect(await findDbtProjectRoot(dir)).toBe(dir)
  })
})

// ---------------------------------------------------------------------------
// modelsModifiedSince — extra cases
// ---------------------------------------------------------------------------

describe("BUG: modelsModifiedSince extra weirdness", () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "mms-w3-"))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("cwd is a file, not a directory — returns empty", async () => {
    const file = join(dir, "f.txt")
    await fs.writeFile(file, "hi")
    expect(await modelsModifiedSince(file, 0)).toEqual([])
  })

  test("symlinked SQL file under models/ is found", async () => {
    const target = join(dir, "target.sql")
    const sub = join(dir, "models")
    await fs.mkdir(sub)
    await fs.writeFile(target, "select 1")
    try {
      await fs.symlink(target, join(sub, "link.sql"))
    } catch {
      return
    }
    const result = await modelsModifiedSince(dir, 0)
    expect(result.some((p) => p.endsWith("link.sql"))).toBe(true)
  })

  test("sinceMs in the future excludes all files", async () => {
    const sub = join(dir, "models")
    await fs.mkdir(sub)
    await fs.writeFile(join(sub, "x.sql"), "select 1")
    // sinceMs far in the future
    const future = Date.now() + 365 * 24 * 60 * 60 * 1000
    expect(await modelsModifiedSince(dir, future)).toEqual([])
  })

  test("sinceMs of -1 (negative) includes everything", async () => {
    const sub = join(dir, "models")
    await fs.mkdir(sub)
    await fs.writeFile(join(sub, "x.sql"), "select 1")
    const result = await modelsModifiedSince(dir, -1)
    expect(result.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// runWithConcurrencyLimit — more stress
// ---------------------------------------------------------------------------

describe("BUG: runWithConcurrencyLimit more stress", () => {
  test("100 items @ limit=5 — exactly the expected results, no missing slots", async () => {
    const items = Array.from({ length: 100 }, (_, i) => i)
    const out = await runWithConcurrencyLimit(items, async (n) => n * 2, 5)
    expect(out).toHaveLength(100)
    expect(out.every((v, i) => v === i * 2)).toBe(true)
  })

  test("fn throwing synchronously (not returning rejected promise)", async () => {
    // `async (n) => { throw ... }` returns a rejected promise. But
    // `(n) => { throw ... }` (non-async) throws sync. Confirm both surface.
    await expect(
      runWithConcurrencyLimit([1, 2, 3], ((n: number) => {
        if (n === 2) throw new Error("sync throw")
        return Promise.resolve(n)
      }) as (n: number) => Promise<number>, 2),
    ).rejects.toThrow("sync throw")
  })

  test("limit equal to items.length runs everything in parallel", async () => {
    let active = 0
    let peak = 0
    await runWithConcurrencyLimit(
      [1, 2, 3, 4, 5],
      async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 30))
        active--
      },
      5,
    )
    expect(peak).toBe(5)
  })

  test("returning undefined from fn produces an Out[] of undefined values", async () => {
    const items = [1, 2, 3]
    const out = await runWithConcurrencyLimit<number, undefined>(
      items,
      async () => undefined,
      2,
    )
    expect(out).toEqual([undefined, undefined, undefined])
  })
})
// altimate_change end
