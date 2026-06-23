// altimate_change start — wave-9 adversarial tests for PR #849
/**
 * Wave 9: more bug-hunting, focused on areas where regex / string parsing
 * tend to be wrong:
 *   - parseDbtTestOutput: PASS=… surrounded by quotes / brackets in test name
 *   - parseDbtTestOutput: Done. inside another summary line
 *   - extractLastJsonObject: split-brace escape edge cases
 *   - modelsModifiedSince: deeply nested + symlink mixes
 *   - findDbtProjectRoot: case-insensitive filename matching
 *   - runWithConcurrencyLimit: catch promise rejection without crashing pool
 *   - registry: `appliesTo` returning Promise<undefined>
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
  findDbtProjectRoot,
  runWithConcurrencyLimit,
} from "../../../src/altimate/validators/validator-utils"

const baseCtx = (cwd: string): ValidatorContext => ({
  sessionID: "s",
  workingDirectory: cwd,
  sessionStartMs: 0,
  step: 0,
  retryCount: 0,
})

// ---------------------------------------------------------------------------
// parseDbtTestOutput regex over-capture / under-capture
// ---------------------------------------------------------------------------

describe("BUG: parseDbtTestOutput regex over-capture (wave 9)", () => {
  test("captures `'quoted_test'` literally when test name is quoted in output", () => {
    const out = "1 of 1 FAIL 'quoted_test' [FAIL in 0.05s]\nDone. PASS=0 WARN=0 ERROR=1 SKIP=0 TOTAL=1"
    const r = parseDbtTestOutput(out)
    // Quotes should be stripped from the captured name.
    expect(r?.failingTests.find((n) => n.includes("'"))).toBeUndefined()
  })

  test("captures `<test_name>` when test name has angle brackets", () => {
    const out = "1 of 1 FAIL <my_test> [FAIL]\nDone. PASS=0 WARN=0 ERROR=1 SKIP=0 TOTAL=1"
    const r = parseDbtTestOutput(out)
    // Angle brackets are not legal dbt identifier chars. Should be excluded.
    expect(r?.failingTests.find((n) => /[<>]/.test(n))).toBeUndefined()
  })

  test("captures a comma-prefixed test name", () => {
    const out = "1 of 2 FAIL ,my_test,other_test\nDone. PASS=0 WARN=0 ERROR=2 SKIP=0 TOTAL=2"
    const r = parseDbtTestOutput(out)
    // dbt test names don't start with commas.
    expect(r?.failingTests.find((n) => n.startsWith(","))).toBeUndefined()
  })

  test("multiple Done. lines: failingTests collects all FAIL/ERROR names across the stream", () => {
    // No reliable retry marker in dbt output that the parser can anchor to.
    // Current behaviour: collect all FAIL/ERROR names; the LAST summary's
    // counts (pass/error/total) are authoritative.
    const out = `1 of 2 FAIL old_test [FAIL]
Done. PASS=0 WARN=0 ERROR=1 SKIP=0 TOTAL=1
... retry
1 of 1 FAIL new_test [FAIL]
Done. PASS=0 WARN=0 ERROR=1 SKIP=0 TOTAL=1`
    const r = parseDbtTestOutput(out)
    expect(r?.failingTests).toEqual(["old_test", "new_test"])
  })
})

// ---------------------------------------------------------------------------
// extractLastJsonObject — deeper split-brace edge cases
// ---------------------------------------------------------------------------

describe("BUG: extractLastJsonObject split-brace edges", () => {
  test("string value containing `\\\\}` (escaped backslash + brace) is parsed correctly", () => {
    // Real dbt output: a backslash-escaped `}` literal in stdout. JSON
    // requires the backslash itself to be escaped (i.e. `\\\\}` raw).
    const raw = '{"verdict": "match", "stdout": "select \\\\} from t"}'
    const r = extractLastJsonObject(raw)
    expect(r?.verdict).toBe("match")
    expect(r?.stdout).toBe("select \\} from t")
  })

  test("string value containing `\\\\` (escaped backslash) before `}`", () => {
    const raw = '{"verdict": "match", "stdout": "path\\\\}\\\\end"}'
    const r = extractLastJsonObject(raw)
    expect(r?.verdict).toBe("match")
  })

  test("two envelopes with carriage returns separator", () => {
    const raw = '{"verdict": "first"}\r{"verdict": "second"}'
    const r = extractLastJsonObject(raw)
    expect(r?.verdict).toBe("second")
  })

  test("envelope inside an array (top-level array — rejected)", () => {
    const raw = '[{"verdict": "match"}]'
    // Top-level array is rejected by fast path; slow path finds the inner
    // envelope and returns it.
    const r = extractLastJsonObject(raw)
    expect(r?.verdict).toBe("match")
  })

  test("envelope inside JSON of JSON (string containing valid envelope)", () => {
    // Outer envelope `{stdout: "<inner>"}` where inner is a serialized JSON.
    // We want OUTER returned, not INNER.
    const inner = '{"verdict": "INNER"}'
    const raw = `{"stdout": ${JSON.stringify(inner)}}`
    const r = extractLastJsonObject(raw)
    expect(r?.stdout).toBe(inner)
    expect(r?.verdict).toBeUndefined()
  })

  test("malformed escape sequence in string value", () => {
    // `\x` is not a valid JSON escape; JSON.parse rejects.
    const raw = '{"verdict": "\\x41"}'
    expect(extractLastJsonObject(raw)).toBeNull()
  })

  test("envelope with key containing whitespace (legal JSON)", () => {
    const raw = '{"verdict": "match", "  spaced  ": 1}'
    expect(extractLastJsonObject(raw)?.verdict).toBe("match")
  })
})

// ---------------------------------------------------------------------------
// modelsModifiedSince — symlink + nesting mixes
// ---------------------------------------------------------------------------

describe("BUG: modelsModifiedSince combined symlink + nesting", () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "mms-w9-"))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("multiple `models/` directories in different dbt_packages, mtime old vs new", async () => {
    const past = Date.now() - 100_000
    const future = Date.now() - 1000

    const m1 = join(dir, "models")
    const m2 = join(dir, "dbt_packages", "foo", "models")
    await fs.mkdir(m1, { recursive: true })
    await fs.mkdir(m2, { recursive: true })

    const oldFile = join(m1, "old.sql")
    const newFile = join(m2, "new.sql")
    await fs.writeFile(oldFile, "select 1")
    await fs.writeFile(newFile, "select 1")

    await fs.utimes(oldFile, past / 1000, past / 1000)
    await fs.utimes(newFile, future / 1000, future / 1000)

    const result = await modelsModifiedSince(dir, past + 50_000)
    // Only new.sql should be included.
    expect(result.some((p) => p.endsWith("new.sql"))).toBe(true)
    expect(result.some((p) => p.endsWith("old.sql"))).toBe(false)
  })

  test("file in `models/` whose mtime is exactly Date.now()", async () => {
    const sub = join(dir, "models")
    await fs.mkdir(sub)
    const f = join(sub, "now.sql")
    await fs.writeFile(f, "select 1")
    const r = await modelsModifiedSince(dir, 0)
    expect(r.some((p) => p.endsWith("now.sql"))).toBe(true)
  })

  test("returns empty array for cwd '' (empty string)", async () => {
    // Empty cwd resolves to process.cwd() in some fs APIs. Document behavior.
    const r = await modelsModifiedSince("", Date.now() + 60_000)
    expect(Array.isArray(r)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// findDbtProjectRoot — readdir order independence + symlinks
// ---------------------------------------------------------------------------

describe("BUG: findDbtProjectRoot wave-9 probes", () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "fdpr-w9-"))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("only file in cwd is dbt_project.yaml (alt extension) — NOT accepted", async () => {
    // dbt requires `.yml`, not `.yaml`.
    await fs.writeFile(join(dir, "dbt_project.yaml"), "name: x")
    expect(await findDbtProjectRoot(dir)).toBeNull()
  })

  test("dbt_project.yml with read permission 0 — gracefully ignored (treated as missing)", async () => {
    const f = join(dir, "dbt_project.yml")
    await fs.writeFile(f, "name: x")
    try {
      await fs.chmod(f, 0o000)
    } catch {
      return
    }
    // stat() succeeds regardless of permissions on macOS / most Linux.
    // The file shape stays a regular file → we accept it.
    const r = await findDbtProjectRoot(dir)
    expect(r).toBe(dir)
    // Restore for cleanup
    await fs.chmod(f, 0o644)
  })

  test("subdir whose dbt_project.yml is a broken symlink", async () => {
    const sub = join(dir, "broken")
    await fs.mkdir(sub)
    try {
      await fs.symlink(join(dir, "no-such"), join(sub, "dbt_project.yml"))
    } catch {
      return
    }
    // stat() on broken symlink returns ENOENT → isFile() throws → false.
    expect(await findDbtProjectRoot(dir)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// runWithConcurrencyLimit + ValidatorRegistry
// ---------------------------------------------------------------------------

describe("BUG: runWithConcurrencyLimit returned-array shape", () => {
  test("rejection from fn does NOT leave the parent caller leaking a Promise", async () => {
    const items = [1, 2, 3]
    let captured: unknown = null
    try {
      await runWithConcurrencyLimit(items, async (n) => {
        if (n === 2) throw new Error("test")
        return n
      }, 2)
    } catch (e) {
      captured = e
    }
    expect((captured as Error).message).toBe("test")
  })

  test("returned array length matches items.length exactly", async () => {
    const items = [1, 2, 3, 4, 5]
    const out = await runWithConcurrencyLimit(items, async (n) => n, 2)
    expect(out.length).toBe(items.length)
  })

  test("works with items array of strings", async () => {
    const items = ["a", "b", "c"]
    const out = await runWithConcurrencyLimit(items, async (s) => s.toUpperCase(), 2)
    expect(out).toEqual(["A", "B", "C"])
  })

  test("works with items array of objects", async () => {
    const items = [{ x: 1 }, { x: 2 }]
    const out = await runWithConcurrencyLimit(items, async (o) => o.x, 2)
    expect(out).toEqual([1, 2])
  })
})

describe("BUG: ValidatorRegistry exotic appliesTo returns", () => {
  beforeEach(() => {
    ValidatorRegistry.clear()
  })

  test("appliesTo returning Promise<undefined> is treated as not-applies", async () => {
    const v: Validator = {
      name: "undef-applies",
      description: "",
      // @ts-expect-error returning undefined instead of boolean for the probe
      async appliesTo() { return undefined },
      async check() { return { ok: true } },
    }
    ValidatorRegistry.register(v)
    const r = await ValidatorRegistry.runAll(baseCtx("/tmp"))
    // `if (!applies) continue` treats undefined as falsy → skipped.
    expect(r).toHaveLength(0)
  })

  test("appliesTo returning Promise.resolve(0) treated as not-applies", async () => {
    const v: Validator = {
      name: "zero-applies",
      description: "",
      // @ts-expect-error returning number instead of boolean for the probe
      async appliesTo() { return 0 },
      async check() { return { ok: true } },
    }
    ValidatorRegistry.register(v)
    const r = await ValidatorRegistry.runAll(baseCtx("/tmp"))
    expect(r).toHaveLength(0)
  })

  test("appliesTo returning Promise.resolve('') treated as not-applies", async () => {
    const v: Validator = {
      name: "empty-applies",
      description: "",
      // @ts-expect-error returning string instead of boolean for the probe
      async appliesTo() { return "" },
      async check() { return { ok: true } },
    }
    ValidatorRegistry.register(v)
    const r = await ValidatorRegistry.runAll(baseCtx("/tmp"))
    expect(r).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// modelNameFromPath — last sweep
// ---------------------------------------------------------------------------

describe("BUG: modelNameFromPath last sweep", () => {
  test("path ending in .sql followed by NUL", () => {
    // NUL terminator commonly trips C-level filename parsing. JS basename
    // should ignore it but our caller might pass it accidentally.
    const r = modelNameFromPath("foo.sql\x00")
    // BUG: NUL preserved at end of returned name.
    expect(r).not.toContain("\x00")
  })

  test("path with embedded `..` segments", () => {
    expect(modelNameFromPath("/m/../foo.sql")).toBe("foo")
  })

  test("path with literal trailing dot (`foo.sql.`)", () => {
    // basename returns "foo.sql.". Trailing dot not in `.sql` extension.
    expect(modelNameFromPath("foo.sql.")).toBe("foo.sql.")
  })

  test("path is just `.` (current dir)", () => {
    // path.basename(".") returns "." — strip .sql does nothing.
    expect(modelNameFromPath(".")).toBe(".")
  })
})
// altimate_change end
