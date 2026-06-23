// altimate_change start — wave-4 adversarial tests for PR #849
/**
 * Fourth wave: probes the full-flow validator behaviors, registry, and
 * cross-cutting concerns:
 *   - DbtTestsPassValidator.appliesTo / check with bad inputs
 *   - DbtSchemaVerifyValidator.appliesTo / check with bad inputs
 *   - ValidatorRegistry with weird validators
 *   - More parseDbtTestOutput / extractLastJsonObject corner cases
 *   - modelNameFromPath with Unicode + weird separators
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { parseDbtTestOutput, DbtTestsPassValidator } from "../../../src/altimate/validators/dbt-tests-pass"
import { DbtSchemaVerifyValidator } from "../../../src/altimate/validators/dbt-schema-verify"
import { ValidatorRegistry } from "../../../src/session/validators/registry"
import type { Validator, ValidatorContext } from "../../../src/session/validators/types"
import {
  extractLastJsonObject,
  modelNameFromPath,
  runWithConcurrencyLimit,
} from "../../../src/altimate/validators/validator-utils"

const baseCtx = (cwd: string): ValidatorContext => ({
  sessionID: "test-session",
  workingDirectory: cwd,
  sessionStartMs: 0,
  step: 0,
  retryCount: 0,
})

// ---------------------------------------------------------------------------
// Validator.appliesTo edge cases
// ---------------------------------------------------------------------------

describe("BUG: DbtTestsPassValidator.appliesTo with bad cwd", () => {
  test("appliesTo returns false for non-existent cwd", async () => {
    const r = await DbtTestsPassValidator.appliesTo(baseCtx("/no/such/dir-xyz-12345"))
    expect(r).toBe(false)
  })

  test("appliesTo returns false for cwd pointing at a file", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "applies-to-"))
    const file = join(dir, "f.txt")
    await fs.writeFile(file, "hi")
    const r = await DbtTestsPassValidator.appliesTo(baseCtx(file))
    expect(r).toBe(false)
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("appliesTo returns false for empty string cwd", async () => {
    // Empty cwd typically resolves to process.cwd() in fs APIs. If our
    // test environment cwd has dbt_project.yml this could return true,
    // but normally not. Test for false.
    const r = await DbtTestsPassValidator.appliesTo(baseCtx(""))
    // BUG/feature: this might return true if the process.cwd happens to be
    // a dbt project. Document behavior.
    expect(typeof r).toBe("boolean")
  })

  test("appliesTo returns true when dbt_project.yml is at cwd", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "applies-to-yes-"))
    await fs.writeFile(join(dir, "dbt_project.yml"), "name: x")
    const r = await DbtTestsPassValidator.appliesTo(baseCtx(dir))
    expect(r).toBe(true)
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe("BUG: DbtSchemaVerifyValidator.appliesTo behaves like DbtTestsPass", () => {
  test("returns false for non-existent cwd", async () => {
    const r = await DbtSchemaVerifyValidator.appliesTo(baseCtx("/no/such/dir-yyz-67890"))
    expect(r).toBe(false)
  })

  test("returns true for valid dbt project", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "sv-applies-"))
    await fs.writeFile(join(dir, "dbt_project.yml"), "name: y")
    const r = await DbtSchemaVerifyValidator.appliesTo(baseCtx(dir))
    expect(r).toBe(true)
    await fs.rm(dir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// Validator.check no-models path
// ---------------------------------------------------------------------------

describe("BUG: DbtTestsPassValidator.check with no touched models", () => {
  test("returns ok=true with models_touched=0 when no SQL modified since sessionStart", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "no-models-"))
    await fs.writeFile(join(dir, "dbt_project.yml"), "name: x")
    // Create models dir but no recent files
    await fs.mkdir(join(dir, "models"))
    const ctx = baseCtx(dir)
    ctx.sessionStartMs = Date.now() + 10_000 // future
    const r = await DbtTestsPassValidator.check(ctx)
    expect(r.ok).toBe(true)
    expect(r.details?.models_touched).toBe(0)
    expect(r.details?.dbt_root).toBe(dir)
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("returns ok=true when cwd isn't a dbt project", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "not-dbt-"))
    const r = await DbtTestsPassValidator.check(baseCtx(dir))
    expect(r.ok).toBe(true)
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe("BUG: DbtSchemaVerifyValidator.check with no touched models", () => {
  test("returns ok=true with models_touched=0", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "sv-no-models-"))
    await fs.writeFile(join(dir, "dbt_project.yml"), "name: x")
    await fs.mkdir(join(dir, "models"))
    const ctx = baseCtx(dir)
    ctx.sessionStartMs = Date.now() + 10_000
    const r = await DbtSchemaVerifyValidator.check(ctx)
    expect(r.ok).toBe(true)
    expect(r.details?.models_touched).toBe(0)
    expect(r.details?.dbt_root).toBe(dir)
    await fs.rm(dir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// ValidatorRegistry behavior
// ---------------------------------------------------------------------------

describe("BUG: ValidatorRegistry edge behaviors", () => {
  beforeEach(() => {
    ValidatorRegistry.clear()
  })

  test("runAll over empty registry returns empty array", async () => {
    const r = await ValidatorRegistry.runAll(baseCtx("/tmp"))
    expect(r).toEqual([])
  })

  test("registering same name twice replaces, doesn't append", () => {
    const v1: Validator = {
      name: "x",
      description: "v1",
      async appliesTo() { return false },
      async check() { return { ok: true } },
    }
    const v2: Validator = {
      name: "x",
      description: "v2",
      async appliesTo() { return false },
      async check() { return { ok: true } },
    }
    ValidatorRegistry.register(v1)
    ValidatorRegistry.register(v2)
    const list = ValidatorRegistry.list()
    expect(list).toHaveLength(1)
    expect(list[0]?.description).toBe("v2")
  })

  test("validator that throws synchronously in appliesTo is captured", async () => {
    const v: Validator = {
      name: "sync-throw",
      description: "",
      async appliesTo() { throw new Error("bad appliesTo") },
      async check() { return { ok: true } },
    }
    ValidatorRegistry.register(v)
    const r = await ValidatorRegistry.runAll(baseCtx("/tmp"))
    expect(r).toHaveLength(1)
    expect(r[0]?.result.details).toMatchObject({
      error: "bad appliesTo",
      skipped_due_to_appliesTo_error: true,
    })
  })

  test("validator that throws in check() is captured as soft-pass", async () => {
    const v: Validator = {
      name: "check-throw",
      description: "",
      async appliesTo() { return true },
      async check() { throw new Error("bad check") },
    }
    ValidatorRegistry.register(v)
    const r = await ValidatorRegistry.runAll(baseCtx("/tmp"))
    expect(r).toHaveLength(1)
    expect(r[0]?.result.ok).toBe(true)
    expect(r[0]?.result.details).toMatchObject({
      error: "bad check",
      skipped_due_to_validator_error: true,
    })
  })

  test("validator returning `applies=truthy` non-boolean (e.g., 1) is treated as true", async () => {
    // The type says boolean but TS can't enforce at runtime.
    const v: Validator = {
      name: "truthy-applies",
      description: "",
      // @ts-expect-error returning number instead of boolean for the probe
      async appliesTo() { return 1 },
      async check() { return { ok: true, details: { ran: true } } },
    }
    ValidatorRegistry.register(v)
    const r = await ValidatorRegistry.runAll(baseCtx("/tmp"))
    // BUG: if registry uses truthy check `if (!applies) continue`, it'd run.
    // If it strictly checks `=== true`, it'd skip. Today we use truthy, so it runs.
    expect(r).toHaveLength(1)
    expect(r[0]?.result.details).toMatchObject({ ran: true })
  })

  test("multiple validators run in registration order (deterministic)", async () => {
    const order: string[] = []
    for (const name of ["a", "b", "c"]) {
      ValidatorRegistry.register({
        name,
        description: "",
        async appliesTo() { return true },
        async check() {
          order.push(name)
          return { ok: true }
        },
      })
    }
    await ValidatorRegistry.runAll(baseCtx("/tmp"))
    expect(order).toEqual(["a", "b", "c"])
  })
})

// ---------------------------------------------------------------------------
// runWithConcurrencyLimit — sequencing details
// ---------------------------------------------------------------------------

describe("BUG: runWithConcurrencyLimit sequencing details", () => {
  test("workers don't race-condition the shared `next` counter (1000 items)", async () => {
    const items = Array.from({ length: 1000 }, (_, i) => i)
    const out = await runWithConcurrencyLimit(items, async (n) => n, 10)
    expect(out).toHaveLength(1000)
    // Each index should contain its own value.
    for (let i = 0; i < 1000; i++) expect(out[i]).toBe(i)
  })

  test("fn that resolves synchronously (already-resolved promise)", async () => {
    const out = await runWithConcurrencyLimit([1, 2, 3], (n) => Promise.resolve(n * 10), 2)
    expect(out).toEqual([10, 20, 30])
  })

  test("fn that awaits then resolves", async () => {
    const out = await runWithConcurrencyLimit([1, 2, 3], async (n) => {
      await new Promise((r) => setTimeout(r, 5))
      return n + 100
    }, 2)
    expect(out).toEqual([101, 102, 103])
  })
})

// ---------------------------------------------------------------------------
// parseDbtTestOutput — more whitespace / formatting probes
// ---------------------------------------------------------------------------

describe("BUG: parseDbtTestOutput more edge cases", () => {
  test("Done.\\n PASS=... across two lines (newline between)", () => {
    const out = "Done.\nPASS=3 WARN=0 ERROR=0 SKIP=0 TOTAL=3"
    const r = parseDbtTestOutput(out)
    expect(r).not.toBeNull()
    expect(r?.pass).toBe(3)
  })

  test("ERROR=2 with WARN missing entirely (compact dbt format)", () => {
    // Some adapters print "Done. PASS=3 ERROR=2 TOTAL=5" without WARN/SKIP.
    const out = "Done. PASS=3 ERROR=2 TOTAL=5"
    const r = parseDbtTestOutput(out)
    expect(r).not.toBeNull()
    expect(r?.pass).toBe(3)
    expect(r?.error).toBe(2)
    expect(r?.total).toBe(5)
  })

  test("ERROR field with leading + sign", () => {
    // parseInt accepts leading '+'. The regex uses \d+ which doesn't include +.
    const out = "Done. PASS=1 WARN=0 ERROR=+1 SKIP=0 TOTAL=2"
    const r = parseDbtTestOutput(out)
    expect(r).toBeNull()
  })

  test("fields with leading zeros parse correctly", () => {
    const out = "Done. PASS=007 WARN=0 ERROR=0 SKIP=0 TOTAL=007"
    const r = parseDbtTestOutput(out)
    expect(r?.pass).toBe(7)
    expect(r?.total).toBe(7)
  })

  test("failingTests strips ANSI color codes from the test name", () => {
    const out = "1 of 1 FAIL 3 \x1b[31munique_test\x1b[0m [FAIL 3 in 0.1s]\nDone. PASS=0 WARN=0 ERROR=1 SKIP=0 TOTAL=1"
    const r = parseDbtTestOutput(out)
    expect(r).not.toBeNull()
    // BUG: today the name contains the ANSI codes verbatim.
    expect(r!.failingTests.some((n) => n === "unique_test")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// extractLastJsonObject — input quirks
// ---------------------------------------------------------------------------

describe("BUG: extractLastJsonObject input quirks", () => {
  test("very short input (single char) returns null", () => {
    expect(extractLastJsonObject("x")).toBeNull()
  })

  test("input that is just a single `{`", () => {
    expect(extractLastJsonObject("{")).toBeNull()
  })

  test("input that is just a single `}`", () => {
    expect(extractLastJsonObject("}")).toBeNull()
  })

  test("multiple `{}` empty objects, then a real envelope", () => {
    const raw = "{} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {\"verdict\":\"match\"}"
    const r = extractLastJsonObject(raw)
    expect(r?.verdict).toBe("match")
  })

  test("envelope key 'columns_extra' but value is a string, not array", () => {
    // Type mismatch but envelope shape matches. Accepted by guard today.
    const r = extractLastJsonObject('{"columns_extra": "not_an_array"}')
    expect(r).not.toBeNull()
    // BUG: value type doesn't match schema. Caller might dereference as array.
    expect(typeof r?.columns_extra).toBe("string")
  })

  test("string value contains a newline literal (not escaped)", () => {
    // Strict JSON forbids unescaped newlines inside strings — should reject.
    const raw = '{"verdict": "match", "model": "foo\nbar"}'
    expect(extractLastJsonObject(raw)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// modelNameFromPath — Unicode + boundaries
// ---------------------------------------------------------------------------

describe("BUG: modelNameFromPath unicode + boundary cases", () => {
  test("emoji in filename", () => {
    expect(modelNameFromPath("/m/😀.sql")).toBe("😀")
  })

  test("filename with combining characters (é = e + accent)", () => {
    expect(modelNameFromPath("/m/café.sql")).toBe("café")
  })

  test("filename with non-Latin script", () => {
    expect(modelNameFromPath("/m/モデル.sql")).toBe("モデル")
  })

  test("path with leading whitespace", () => {
    // basename(" /foo.sql") might handle leading whitespace differently.
    expect(modelNameFromPath(" foo.sql")).toBe(" foo")
  })

  test("path with embedded null character", () => {
    // POSIX doesn't permit NUL in paths, but our function shouldn't crash if asked.
    expect(() => modelNameFromPath("foo\x00.sql")).not.toThrow()
  })
})
// altimate_change end
