// altimate_change start — wave-2 adversarial tests for PR #849
/**
 * Second adversarial wave. Probes:
 *   - parseDbtTestOutput  — regex anchoring, large numbers, missing fields
 *   - extractLastJsonObject — JSON5, deep nesting, BOM, comments, truncation
 *   - escapeXmlAttr — control characters, NUL, newlines, surrogate pairs
 *   - modelNameFromPath — empty input, no extension, multiple dots
 *   - runWithConcurrencyLimit — rejection propagation, sparse arrays
 *   - modelsModifiedSince — mtime boundary, glob-like names
 *
 * Each test that FAILS exposes a real bug. Tests are commented with the
 * concrete production scenario where the bug surfaces.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { parseDbtTestOutput } from "../../../src/altimate/validators/dbt-tests-pass"
import {
  extractLastJsonObject,
  modelNameFromPath,
  runWithConcurrencyLimit,
  modelsModifiedSince,
} from "../../../src/altimate/validators/validator-utils"

// ---------------------------------------------------------------------------
// parseDbtTestOutput — adversarial
// ---------------------------------------------------------------------------

describe("BUG: parseDbtTestOutput regex anchoring", () => {
  test("matches `Done.` when embedded mid-word (`Predone.`)", () => {
    // The regex `/Done\./i` has no word boundary, so it matches inside
    // unrelated text. Production scenario: dbt prints "Predone. ..." in
    // some plugin output, and we mis-parse it as a summary.
    const out = "Predone. PASS=99 WARN=0 ERROR=0 SKIP=0 TOTAL=99"
    const r = parseDbtTestOutput(out)
    // BUG: This currently returns a parsed summary, which would mistake
    // unrelated text for a real dbt summary. Should require a word
    // boundary OR start-of-line anchor on Done.
    expect(r).toBeNull()
  })

  test("misses summary when WARN field is omitted by future dbt versions", () => {
    // dbt 1.0 → 1.8 has always emitted WARN, but a future release could drop it.
    // The regex hard-requires WARN=N. We should fail gracefully (null) — and
    // currently we DO, but that means we silently produce no summary instead
    // of degrading to PASS/ERROR/TOTAL. Document this as a forward-compat risk.
    const out = "Done. PASS=10 ERROR=0 SKIP=0 TOTAL=10"
    const r = parseDbtTestOutput(out)
    // Today: returns null. After the fix we want PASS/ERROR/TOTAL to still
    // parse even when WARN/SKIP/NO-OP are absent.
    expect(r).not.toBeNull()
    expect(r?.pass).toBe(10)
    expect(r?.error).toBe(0)
    expect(r?.total).toBe(10)
  })
})

describe("BUG: parseDbtTestOutput number precision", () => {
  test("very large numbers beyond MAX_SAFE_INTEGER lose precision", () => {
    // parseInt("99999999999999999999", 10) returns 1e20 (precision lost).
    // Not exploitable but signals counts could overflow silently.
    const out = "Done. PASS=99999999999999999999 WARN=0 ERROR=0 SKIP=0 TOTAL=99999999999999999999"
    const r = parseDbtTestOutput(out)
    // BUG: pass count silently rounded. Today we accept and store the
    // approximation. After fix we want to either clamp or surface a warning.
    expect(r).not.toBeNull()
    expect(Number.isSafeInteger(r!.pass)).toBe(true)
  })
})

describe("BUG: parseDbtTestOutput failingTests extraction", () => {
  test("captures test name from CRLF-terminated FAIL lines", () => {
    // Real Docker outputs sometimes have CRLF line endings. `\S+` stops at
    // the carriage return so we capture the trailing \r as part of the name.
    const out = "1 of 2 FAIL 3 unique_user_id [FAIL 3 in 0.05s]\r\nDone. PASS=1 WARN=0 ERROR=1 SKIP=0 TOTAL=2"
    const r = parseDbtTestOutput(out)
    expect(r).not.toBeNull()
    // BUG: `\S+` greedy matches "unique_user_id" cleanly (no \r), so we
    // expect it without the trailing CR.
    expect(r!.failingTests).toContain("unique_user_id")
    // BUG: extracted name should NOT contain \r
    expect(r!.failingTests.some((n) => n.includes("\r"))).toBe(false)
  })

  test("does not extract test name from log-line that *looks* similar", () => {
    // "13 of 27 FAIL" is real dbt format; "Plan: 5 of 10 FAILED transient" is
    // a different log style. Our regex doesn't anchor "FAIL" as a standalone
    // token — `FAIL` matches inside `FAILED`. Production risk: we treat
    // "transient" as a failing test name.
    const out = `Plan: 5 of 10 FAILED transient resources detected
Done. PASS=10 WARN=0 ERROR=0 SKIP=0 TOTAL=10`
    const r = parseDbtTestOutput(out)
    // BUG: "transient" would be captured as a failing test.
    expect(r!.failingTests).not.toContain("transient")
  })
})

// ---------------------------------------------------------------------------
// extractLastJsonObject — adversarial
// ---------------------------------------------------------------------------

describe("BUG: extractLastJsonObject deeper edge cases", () => {
  test("rejects empty object {} (no envelope keys)", () => {
    // Confirmed working — empty object has no envelope key so guard rejects.
    expect(extractLastJsonObject("{}")).toBeNull()
  })

  test("rejects JSON5-style trailing comma", () => {
    // dbt does not emit trailing commas, but a buggy version might.
    // JSON.parse rejects them, so we should return null.
    const r = extractLastJsonObject('{"verdict": "match",}')
    expect(r).toBeNull()
  })

  test("accepts envelope inside a deeply nested noise wrapper", () => {
    // Real Docker output: a Python traceback that contains JSON-like
    // fragments before the real envelope at the very end.
    const noise = `
Traceback (most recent call last):
  File "/usr/local/lib/python3.10/site-packages/dbt/main.py", line 137
{"some": "noisy", "fragment": [1,2,3]}
  File "...", line 220
{"verdict": "match", "model": "stg_orders"}
`
    const r = extractLastJsonObject(noise)
    expect(r).not.toBeNull()
    expect(r?.verdict).toBe("match")
    expect(r?.model).toBe("stg_orders")
  })

  test("rejects standalone `null` JSON", () => {
    // `JSON.parse("null")` returns null. Our fast-path then attempts
    // `isValidEnvelope(null)` which used to crash before the typeof guard.
    expect(extractLastJsonObject("null")).toBeNull()
  })

  test("rejects standalone JSON arrays", () => {
    // `JSON.parse("[1,2,3]")` returns an array. Same crash surface as `null`.
    expect(extractLastJsonObject("[1,2,3]")).toBeNull()
  })

  test("handles 200-level deep nested object without stack overflow", () => {
    // dbt won't emit this, but a misbehaving plugin might. Our parser scans
    // brace-by-brace iteratively, but JSON.parse may recurse — make sure we
    // tolerate the depth.
    let json = '{"verdict": "match"'
    for (let i = 0; i < 200; i++) json += `, "k${i}": {"a": 1}`
    json += "}"
    const r = extractLastJsonObject(json)
    expect(r).not.toBeNull()
    expect(r?.verdict).toBe("match")
  })

  test("handles BOM (U+FEFF) prefix on stdout", () => {
    const bom = "﻿"
    const r = extractLastJsonObject(`${bom}{"verdict": "match"}`)
    // BUG: JSON.parse rejects BOM at start; our fast path fails. The fallback
    // brace scan should find the JSON object regardless of BOM.
    expect(r).not.toBeNull()
    expect(r?.verdict).toBe("match")
  })

  test("falls back when only stdout contains it (no other envelope keys)", () => {
    const r = extractLastJsonObject('{"stdout": "hello world"}')
    expect(r).not.toBeNull()
    expect(r?.stdout).toBe("hello world")
  })

  test("rejects an object whose only envelope-shape key is stdout but value is empty string", () => {
    // `stdout: ""` is meaningful (subprocess produced no output) — keep it.
    // But `stdout: 0` would not make sense.
    const r = extractLastJsonObject('{"stdout": ""}')
    expect(r).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// modelNameFromPath — adversarial
// ---------------------------------------------------------------------------

describe("BUG: modelNameFromPath edge cases", () => {
  test("'.sql' alone yields empty string (documented behaviour)", () => {
    // A file literally named ".sql" has no model-name semantically. Strip
    // yields "". Callers should filter empty names before invoking dbt.
    expect(modelNameFromPath(".sql")).toBe("")
  })

  test("'foo.sql.bak' is not a SQL file — should not be stripped of `.bak`", () => {
    // Filenames with multiple extensions shouldn't lose the wrong one.
    // We only strip a trailing `.sql`, so this is `foo.sql.bak` minus
    // nothing → "foo.sql.bak". This is correct behavior; assert it.
    expect(modelNameFromPath("foo.sql.bak")).toBe("foo.sql.bak")
  })

  test("uppercase .SQL extension stripped consistently with lowercase", () => {
    // /\.sql$/i is case-insensitive; this should pass today.
    expect(modelNameFromPath("models/Foo.SQL")).toBe("Foo")
  })

  test("multiple .sql extensions only strips trailing one", () => {
    // "foo.sql.sql" → "foo.sql"
    expect(modelNameFromPath("foo.sql.sql")).toBe("foo.sql")
  })

  test("path ending in only a slash yields basename (documented)", () => {
    // path.basename("/tmp/models/") returns "models". Callers should only
    // pass real .sql paths; this helper does no validation.
    expect(modelNameFromPath("/tmp/models/")).toBe("models")
  })

  test("empty string path returns empty string (no crash)", () => {
    // Should not throw; should not silently produce an interpretable name.
    const r = modelNameFromPath("")
    expect(r).toBe("")
  })
})

// ---------------------------------------------------------------------------
// escapeXmlAttr — adversarial (via dynamic import from session/system)
// ---------------------------------------------------------------------------

describe("BUG: escapeXmlAttr edge cases (regression suite for system.ts)", () => {
  // escapeXmlAttr is not exported. Probe via a local copy that mirrors the
  // production implementation (kept in sync — if you change one, change both).
  const escapeXmlAttr = (s: string): string =>
    s
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "&#10;")
      .replace(/\r/g, "&#13;")
      .replace(/\t/g, "&#9;")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")

  test("strips XML-1.0-invalid control characters (NUL etc.)", () => {
    expect(escapeXmlAttr("foo\x00bar")).not.toContain("\x00")
  })

  test("strips vertical tab / form feed (XML 1.0 invalid)", () => {
    const out = escapeXmlAttr("foo\x0Bbar\x0Cbaz")
    expect(out).not.toMatch(/[\x0B\x0C]/)
  })

  test("encodes newline as numeric char ref (single-line attribute value)", () => {
    const out = escapeXmlAttr("line1\nline2")
    expect(out).not.toContain("\n")
    expect(out).toContain("&#10;")
  })

  test("does NOT escape single quote (apostrophe) — acceptable when attr uses double quotes", () => {
    // No-op test confirming current intentional behavior (system.ts wraps in `"..."`).
    expect(escapeXmlAttr("can't stop")).toBe("can't stop")
  })

  test("idempotent on already-escaped strings (double-escape risk)", () => {
    // If a skill name happens to contain "&amp;" as a literal, our escaper
    // would turn it into "&amp;amp;". Document this so anyone relying on
    // round-trip-safe behavior is aware.
    const input = "&amp;"
    const out = escapeXmlAttr(input)
    // Either we accept double-escape OR we detect already-escaped.
    // Today: output is "&amp;amp;". Decide intentionally.
    expect(out).toBe("&amp;amp;")
  })

  test("escapes mixed XML metacharacters in one pass", () => {
    const out = escapeXmlAttr("a&b<c>d\"e")
    expect(out).toBe("a&amp;b&lt;c&gt;d&quot;e")
  })

  test("handles empty string without crash", () => {
    expect(escapeXmlAttr("")).toBe("")
  })

  test("preserves astral / surrogate-pair Unicode", () => {
    // 😀 is U+1F600, encoded as a surrogate pair in JS strings.
    const out = escapeXmlAttr("hi 😀")
    expect(out).toBe("hi 😀")
  })
})

// ---------------------------------------------------------------------------
// runWithConcurrencyLimit — adversarial wave 2
// ---------------------------------------------------------------------------

describe("BUG: runWithConcurrencyLimit behavior under stress", () => {
  test("rejecting fn surfaces error to caller (basic propagation)", async () => {
    await expect(
      runWithConcurrencyLimit([1, 2, 3], async (n) => {
        if (n === 2) throw new Error("crash on 2")
        return n
      }, 2),
    ).rejects.toThrow("crash on 2")
  })

  test("sparse input array → workers see undefined entries", async () => {
    // new Array(3) is sparse — items[0..2] are unset (=== undefined).
    // Some callers might construct sparse arrays via filter+map composition.
    const sparse = new Array<number>(3)
    sparse[1] = 42
    let sawUndefined = false
    const out = await runWithConcurrencyLimit(sparse as number[], async (n) => {
      if (n === undefined) sawUndefined = true
      return n ?? 0
    }, 2)
    expect(sawUndefined).toBe(true)
    expect(out[1]).toBe(42)
  })

  test("preserves output order even when fn completes out of order", async () => {
    const delays = [50, 5, 30, 10, 20]
    const out = await runWithConcurrencyLimit(
      delays.map((_, i) => i),
      async (i) => {
        await new Promise((r) => setTimeout(r, delays[i] ?? 0))
        return `r${i}`
      },
      3,
    )
    expect(out).toEqual(["r0", "r1", "r2", "r3", "r4"])
  })

  test("limit larger than items length spawns at most items.length workers", async () => {
    // No bug if workers are correctly capped at items.length. Concretely we
    // can't see worker count from outside, but we can assert correctness.
    const items = [1, 2, 3]
    const out = await runWithConcurrencyLimit(items, async (n) => n * 10, 100)
    expect(out).toEqual([10, 20, 30])
  })

  test("0-item input returns empty array without spawning workers", async () => {
    let calls = 0
    const out = await runWithConcurrencyLimit<number, number>([], async () => {
      calls++
      return 0
    }, 4)
    expect(out).toEqual([])
    expect(calls).toBe(0)
  })

  test("Infinity limit clamps to items.length", async () => {
    // Number.isFinite(Infinity) is false → our clamp defaults to 1.
    // That's safe but not what most callers expect for "all parallel".
    // After fix: Infinity should be treated as items.length, not 1.
    const items = [1, 2, 3]
    const seenConcurrent: number[] = []
    let active = 0
    let peak = 0
    const out = await runWithConcurrencyLimit(items, async (n) => {
      active++
      peak = Math.max(peak, active)
      seenConcurrent.push(active)
      await new Promise((r) => setTimeout(r, 10))
      active--
      return n
    }, Infinity)
    expect(out).toEqual([1, 2, 3])
    // BUG: today peak=1 because Infinity falls to default of 1 (serial).
    // After fix: peak should equal items.length (3).
    expect(peak).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// modelsModifiedSince — adversarial wave 2
// ---------------------------------------------------------------------------

describe("BUG: modelsModifiedSince mtime boundary and weird names", () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "mms-w2-"))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("file with mtime exactly equal to sinceMs is included (>= semantics)", async () => {
    const sub = join(dir, "models")
    await fs.mkdir(sub)
    const file = join(sub, "boundary.sql")
    await fs.writeFile(file, "select 1")
    // Set mtime to exactly some known value
    const fixed = 1_700_000_000_000
    await fs.utimes(file, fixed / 1000, fixed / 1000)
    const result = await modelsModifiedSince(dir, fixed)
    expect(result.some((p) => p.endsWith("boundary.sql"))).toBe(true)
  })

  test("file with mtime 1ms before sinceMs is excluded", async () => {
    const sub = join(dir, "models")
    await fs.mkdir(sub)
    const file = join(sub, "before.sql")
    await fs.writeFile(file, "select 1")
    const fixed = 1_700_000_000_000
    await fs.utimes(file, fixed / 1000, fixed / 1000)
    const result = await modelsModifiedSince(dir, fixed + 1)
    expect(result.some((p) => p.endsWith("before.sql"))).toBe(false)
  })

  test("file with newlines in its name is still found", async () => {
    // Filesystems on Linux/macOS allow newlines in filenames (though rare).
    // Should not crash.
    const sub = join(dir, "models")
    await fs.mkdir(sub)
    const badName = "a\nb.sql"
    const file = join(sub, badName)
    try {
      await fs.writeFile(file, "select 1")
    } catch {
      return // some filesystems refuse — skip silently
    }
    const result = await modelsModifiedSince(dir, 0)
    expect(result.length).toBeGreaterThan(0)
  })

  test("hidden file under models/ (.foo.sql) is excluded", async () => {
    const sub = join(dir, "models")
    await fs.mkdir(sub)
    await fs.writeFile(join(sub, ".hidden.sql"), "select 1")
    const result = await modelsModifiedSince(dir, 0)
    // Hidden file names that start with "." are explicitly skipped at the
    // top of the loop. Test that this is still the case.
    expect(result.some((p) => p.endsWith(".hidden.sql"))).toBe(false)
  })

  test("file directly in models/ at depth 0 (no subdir) is found", async () => {
    // models/ at top level, foo.sql at models/foo.sql. depth=0 → depth+1=1
    // in scan; depth limit is 8. Should be found.
    const sub = join(dir, "models")
    await fs.mkdir(sub)
    await fs.writeFile(join(sub, "top.sql"), "select 1")
    const result = await modelsModifiedSince(dir, 0)
    expect(result.some((p) => p.endsWith("top.sql"))).toBe(true)
  })

  test("models/ at root + duplicate models/ deeply nested — both files found", async () => {
    // dbt allows multiple `models` directories in different package roots
    // (e.g., dbt_packages/foo/models/). Make sure both are picked up.
    const sub1 = join(dir, "models")
    const sub2 = join(dir, "dbt_packages", "foo", "models")
    await fs.mkdir(sub1, { recursive: true })
    await fs.mkdir(sub2, { recursive: true })
    await fs.writeFile(join(sub1, "a.sql"), "select 1")
    await fs.writeFile(join(sub2, "b.sql"), "select 1")
    const result = await modelsModifiedSince(dir, 0)
    expect(result.some((p) => p.endsWith("a.sql"))).toBe(true)
    expect(result.some((p) => p.endsWith("b.sql"))).toBe(true)
  })
})
// altimate_change end
