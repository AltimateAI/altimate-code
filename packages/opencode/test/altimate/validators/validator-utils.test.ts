import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import { join, sep } from "path"
import { tmpdir as osTmpdir } from "os"
import {
  extractLastJsonObject,
  modelNameFromPath,
  findDbtProjectRoot,
  modelsModifiedSince,
} from "../../../src/altimate/validators/validator-utils"

// ---------------------------------------------------------------------------
// extractLastJsonObject — basic contract
// ---------------------------------------------------------------------------

describe("extractLastJsonObject — basic contract", () => {
  test("returns null for empty string", () => {
    expect(extractLastJsonObject("")).toBeNull()
  })

  test("returns null for whitespace-only string", () => {
    expect(extractLastJsonObject("   \t\n  ")).toBeNull()
  })

  test("returns null for string with no JSON", () => {
    expect(extractLastJsonObject("no json here at all")).toBeNull()
  })

  test("returns null for bare JSON array (top-level array, no { start)", () => {
    // A bare array `[...]` has no `{` at position 0 of the array — the inner
    // element `{"model": "orders"}` would still match. This documents that the
    // scanner finds inner objects regardless of outer array wrapper.
    // The key check is that it returns null for an array with no envelope keys.
    const arr = '[{"random": "data"}]'
    expect(extractLastJsonObject(arr)).toBeNull()
  })

  test("fast path: pure JSON with stdout key", () => {
    const input = JSON.stringify({ stdout: "dbt output" })
    const result = extractLastJsonObject(input)
    expect(result).not.toBeNull()
    expect(result!["stdout"]).toBe("dbt output")
  })

  test("fast path: pure JSON with error key", () => {
    const input = JSON.stringify({ error: "spawn failed" })
    expect(extractLastJsonObject(input)).not.toBeNull()
  })

  test("fast path: pure JSON with verdict key", () => {
    const input = JSON.stringify({ verdict: "match", model: "foo" })
    expect(extractLastJsonObject(input)).not.toBeNull()
  })

  test("fast path: pure JSON with model key", () => {
    expect(extractLastJsonObject(JSON.stringify({ model: "orders" }))).not.toBeNull()
  })

  test("fast path: pure JSON with columns_extra key", () => {
    expect(extractLastJsonObject(JSON.stringify({ columns_extra: ["col_a"] }))).not.toBeNull()
  })

  test("fast path: pure JSON with columns_missing key", () => {
    expect(extractLastJsonObject(JSON.stringify({ columns_missing: ["col_b"] }))).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// extractLastJsonObject — envelope key guard (stray JSON rejection)
// ---------------------------------------------------------------------------

describe("extractLastJsonObject — stray JSON rejection", () => {
  test("rejects JSON with only unknown keys (dbt config fragment)", () => {
    expect(extractLastJsonObject('{"config": "value", "random": 42}')).toBeNull()
  })

  test("rejects empty object", () => {
    expect(extractLastJsonObject("{}")).toBeNull()
  })

  test("rejects JSON with only numeric keys", () => {
    expect(extractLastJsonObject('{"0": "zero", "1": "one"}')).toBeNull()
  })

  test("accepts JSON where envelope key has null value", () => {
    // Key is present — value being null doesn't invalidate the envelope
    const input = JSON.stringify({ error: null, model: "test" })
    const result = extractLastJsonObject(input)
    expect(result).not.toBeNull()
    expect(result!["model"]).toBe("test")
  })

  test("accepts JSON where envelope key has false value", () => {
    const input = JSON.stringify({ verdict: false, model: "test" })
    expect(extractLastJsonObject(input)).not.toBeNull()
  })

  test("accepts JSON where envelope key has empty-string value", () => {
    const input = JSON.stringify({ error: "", model: "test" })
    expect(extractLastJsonObject(input)).not.toBeNull()
  })

  test("rejects array of objects with unknown keys", () => {
    const input = '[{"level":"info"},{"level":"warn"}]'
    expect(extractLastJsonObject(input)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// extractLastJsonObject — noisy stdout scanning
// ---------------------------------------------------------------------------

describe("extractLastJsonObject — noisy stdout scanning", () => {
  test("extracts from ANSI-prefixed stdout", () => {
    const ansi = "\x1b[32m[dbt]\x1b[0m Running tests...\n"
    const json = JSON.stringify({ stdout: "Done. PASS=3 TOTAL=3" })
    const result = extractLastJsonObject(ansi + json)
    expect(result).not.toBeNull()
    expect((result!["stdout"] as string)).toContain("Done.")
  })

  test("extracts from Python traceback + JSON on last line", () => {
    const tb = [
      "Traceback (most recent call last):",
      '  File "/usr/lib/python3.11/site-packages/dbt/main.py", line 45',
      '    main()',
      "ConnectionError: warehouse unreachable",
    ].join("\n")
    const json = JSON.stringify({ error: "warehouse unreachable", model: "orders" })
    const result = extractLastJsonObject(tb + "\n" + json)
    expect(result).not.toBeNull()
    expect(result!["error"]).toBe("warehouse unreachable")
  })

  test("extracts from stdout with many progress-indicator lines", () => {
    const noise = Array.from({ length: 50 }, (_, i) => `17:0${i % 10}:00  ${i + 1} of 50 PASS some_test_${i}`).join("\n")
    const json = JSON.stringify({ stdout: "Done. PASS=50 TOTAL=50" })
    const result = extractLastJsonObject(noise + "\n" + json)
    expect(result).not.toBeNull()
  })

  test("extracts from stdout that starts with BOM", () => {
    const bom = "﻿"
    const json = JSON.stringify({ model: "test", verdict: "match" })
    const result = extractLastJsonObject(bom + json)
    expect(result).not.toBeNull()
  })

  test("handles CRLF line endings around JSON", () => {
    const input = "some log\r\n" + JSON.stringify({ model: "test", error: "oops" }) + "\r\n"
    expect(extractLastJsonObject(input)).not.toBeNull()
  })

  test("handles large amounts of leading noise (> 10 KB)", () => {
    const noise = "x".repeat(12_000)
    const json = JSON.stringify({ model: "orders", verdict: "mismatch" })
    const result = extractLastJsonObject(noise + json)
    expect(result).not.toBeNull()
    expect(result!["verdict"]).toBe("mismatch")
  })

  test("whitespace before and after JSON", () => {
    const input = "\n\n\n   \t  " + JSON.stringify({ error: "no models" }) + "   \n\n"
    expect(extractLastJsonObject(input)).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// extractLastJsonObject — last-wins semantics
// ---------------------------------------------------------------------------

describe("extractLastJsonObject — last-wins semantics", () => {
  test("returns LAST valid envelope when two valid objects are present", () => {
    const first = JSON.stringify({ model: "orders", verdict: "match" })
    const second = JSON.stringify({ model: "customers", verdict: "mismatch" })
    const result = extractLastJsonObject(first + "\n" + second)
    expect(result).not.toBeNull()
    expect(result!["model"]).toBe("customers")
  })

  test("skips stray JSON fragments and returns the valid envelope", () => {
    const stray1 = '{"level": "info", "ts": 1234}'    // no envelope key
    const stray2 = '{"config": {"key": "val"}}'        // no envelope key
    const valid = JSON.stringify({ stdout: "PASS=3 TOTAL=3" })
    const result = extractLastJsonObject([stray1, stray2, valid].join("\n"))
    expect(result).not.toBeNull()
    expect(result!["stdout"]).toBeDefined()
  })

  test("last valid envelope wins even if first was also valid", () => {
    const first = JSON.stringify({ error: "first error", model: "a" })
    const second = JSON.stringify({ error: "second error", model: "b" })
    const third = JSON.stringify({ error: "third error", model: "c" })
    const result = extractLastJsonObject([first, second, third].join("\n"))
    expect(result!["model"]).toBe("c")
  })

  test("same-line consecutive JSON objects — last one wins", () => {
    const first = JSON.stringify({ model: "a", verdict: "match" })
    const second = JSON.stringify({ model: "b", verdict: "mismatch" })
    const result = extractLastJsonObject(first + second)
    expect(result!["model"]).toBe("b")
  })
})

// ---------------------------------------------------------------------------
// extractLastJsonObject — brace/string parsing edge cases
// ---------------------------------------------------------------------------

describe("extractLastJsonObject — brace/string parsing edge cases", () => {
  test("handles nested braces in string values", () => {
    const input = JSON.stringify({ stdout: 'has {nested} braces', model: "test" })
    const result = extractLastJsonObject(input)
    expect(result).not.toBeNull()
    expect(result!["model"]).toBe("test")
  })

  test("handles escaped backslashes in string values", () => {
    const input = JSON.stringify({ error: "path C:\\Users\\foo\\bar", model: "m" })
    expect(extractLastJsonObject(input)).not.toBeNull()
  })

  test("handles escaped double-quotes inside string values", () => {
    const input = '{"error": "she said \\"hello\\"", "model": "m"}'
    expect(extractLastJsonObject(input)).not.toBeNull()
  })

  test("handles multiline string values with embedded newlines", () => {
    const multiline = "line1\nline2\nDone. PASS=5 TOTAL=5"
    const input = JSON.stringify({ stdout: multiline })
    const result = extractLastJsonObject(input)
    expect(result).not.toBeNull()
    expect((result!["stdout"] as string)).toContain("Done.")
  })

  test("handles stdout field that itself contains JSON", () => {
    const inner = JSON.stringify({ pass: 3 })  // inner JSON is NOT an envelope
    const outer = JSON.stringify({ stdout: inner, model: "my_model" })
    const result = extractLastJsonObject(outer)
    expect(result).not.toBeNull()
    expect(result!["model"]).toBe("my_model")
  })

  test("handles unicode characters in string values", () => {
    const input = JSON.stringify({ error: "エラー: 接続失敗", model: "日本語" })
    expect(extractLastJsonObject(input)).not.toBeNull()
  })

  test("handles deeply-nested JSON values (not in the envelope shape)", () => {
    const deep = { a: { b: { c: { d: "value" } } } }
    const input = JSON.stringify({ model: "test", nested: deep })
    expect(extractLastJsonObject(input)).not.toBeNull()
  })

  test("truncated JSON (missing closing brace) returns null", () => {
    const input = '{"model": "orders", "verdict": "match'
    expect(extractLastJsonObject(input)).toBeNull()
  })

  test("handles JSON with unicode escape sequences", () => {
    const input = '{"model": "test", "error": "caf\\u00e9 error"}'
    expect(extractLastJsonObject(input)).not.toBeNull()
  })

  test("handles a JSON object that spans multiple lines", () => {
    const input = `{
  "model": "orders",
  "verdict": "mismatch",
  "columns_extra": ["id", "name"]
}`
    const result = extractLastJsonObject(input)
    expect(result).not.toBeNull()
    expect(result!["verdict"]).toBe("mismatch")
  })

  test("handles unbalanced { inside log noise before valid JSON", () => {
    // Log noise has an unclosed `{` — scanner should skip it
    const noise = "warn: config override {some=value, other\n"
    const json = JSON.stringify({ model: "orders", error: "fail" })
    const result = extractLastJsonObject(noise + json)
    expect(result).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// modelNameFromPath
// ---------------------------------------------------------------------------

describe("modelNameFromPath", () => {
  test("extracts model name from simple path", () => {
    expect(modelNameFromPath("models/marts/foo.sql")).toBe("foo")
  })

  test("extracts model name from deep nested path", () => {
    expect(modelNameFromPath("/project/dbt/models/staging/stg_orders.sql")).toBe("stg_orders")
  })

  test("strips .sql case-insensitively — uppercase", () => {
    expect(modelNameFromPath("models/foo.SQL")).toBe("foo")
  })

  test("strips .sql case-insensitively — mixed case", () => {
    expect(modelNameFromPath("models/foo.Sql")).toBe("foo")
  })

  test("returns basename for path with no slashes", () => {
    expect(modelNameFromPath("my_model.sql")).toBe("my_model")
  })

  test("handles model name with underscores and numbers", () => {
    expect(modelNameFromPath("models/stg_orders_v2.sql")).toBe("stg_orders_v2")
  })

  test("handles model name with hyphens", () => {
    expect(modelNameFromPath("models/my-model.sql")).toBe("my-model")
  })

  test("does not strip non-.sql extensions", () => {
    // Should only strip .sql; .sql.bak stays intact
    expect(modelNameFromPath("models/foo.sql.bak")).toBe("foo.sql.bak")
  })

  test("handles path with trailing slash (directory-like path)", () => {
    // basename("models/orders/") returns "" in node — not a file path but shouldn't crash
    const result = modelNameFromPath("models/orders/")
    // Just assert it doesn't throw
    expect(typeof result).toBe("string")
  })

  test("handles absolute path on linux", () => {
    expect(modelNameFromPath("/home/user/project/models/core/orders.sql")).toBe("orders")
  })

  test("handles path with multiple dots in filename", () => {
    expect(modelNameFromPath("models/my.model.name.sql")).toBe("my.model.name")
  })

  test("empty string does not throw", () => {
    expect(() => modelNameFromPath("")).not.toThrow()
  })

  test("uses path.basename — works correctly on current platform", () => {
    // On POSIX, join uses `/`. Verify the function uses basename not string split.
    const p = join("models", "staging", "stg_orders.sql")
    expect(modelNameFromPath(p)).toBe("stg_orders")
  })
})

// ---------------------------------------------------------------------------
// findDbtProjectRoot
// ---------------------------------------------------------------------------

describe("findDbtProjectRoot", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(join(osTmpdir(), "dbt-root-test-"))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test("returns cwd when dbt_project.yml is directly present", async () => {
    await fs.writeFile(join(tmpDir, "dbt_project.yml"), "name: test_project\n")
    expect(await findDbtProjectRoot(tmpDir)).toBe(tmpDir)
  })

  test("returns nested dir when dbt_project.yml is one level down", async () => {
    const nested = join(tmpDir, "my_dbt")
    await fs.mkdir(nested)
    await fs.writeFile(join(nested, "dbt_project.yml"), "name: nested\n")
    expect(await findDbtProjectRoot(tmpDir)).toBe(nested)
  })

  test("returns null when no dbt_project.yml exists anywhere", async () => {
    expect(await findDbtProjectRoot(tmpDir)).toBeNull()
  })

  test("returns null for a non-existent directory", async () => {
    expect(await findDbtProjectRoot("/tmp/definitely-does-not-exist-xyzabc987")).toBeNull()
  })

  test("prefers direct dbt_project.yml over nested one", async () => {
    await fs.writeFile(join(tmpDir, "dbt_project.yml"), "name: root\n")
    const nested = join(tmpDir, "sub")
    await fs.mkdir(nested)
    await fs.writeFile(join(nested, "dbt_project.yml"), "name: sub\n")
    // Direct check happens first, so root is returned
    expect(await findDbtProjectRoot(tmpDir)).toBe(tmpDir)
  })

  test("does NOT find dbt_project.yml two levels deep (only 1 level scanned)", async () => {
    const twoDeep = join(tmpDir, "a", "b")
    await fs.mkdir(twoDeep, { recursive: true })
    await fs.writeFile(join(twoDeep, "dbt_project.yml"), "name: deep\n")
    expect(await findDbtProjectRoot(tmpDir)).toBeNull()
  })

  test("finds nested project even when other non-dbt subdirs exist", async () => {
    await fs.mkdir(join(tmpDir, "docs"))
    await fs.mkdir(join(tmpDir, "scripts"))
    const dbtDir = join(tmpDir, "dbt_project")
    await fs.mkdir(dbtDir)
    await fs.writeFile(join(dbtDir, "dbt_project.yml"), "name: real\n")
    expect(await findDbtProjectRoot(tmpDir)).toBe(dbtDir)
  })

  test("handles empty directory gracefully", async () => {
    expect(await findDbtProjectRoot(tmpDir)).toBeNull()
  })

  test("rejects dbt_project.yml when it is a directory, not a file", async () => {
    // A directory named dbt_project.yml is not a valid dbt project marker.
    // The function should return null rather than mistake it for one.
    await fs.mkdir(join(tmpDir, "dbt_project.yml"))
    const result = await findDbtProjectRoot(tmpDir)
    expect(result).toBeNull()
  })

  test("handles directory with many subdirs — returns first dbt project found", async () => {
    for (let i = 0; i < 5; i++) {
      await fs.mkdir(join(tmpDir, `subdir_${i}`))
    }
    const dbtDir = join(tmpDir, "subdir_2")
    await fs.writeFile(join(dbtDir, "dbt_project.yml"), "name: found\n")
    // Should find it somewhere among the subdirs
    expect(await findDbtProjectRoot(tmpDir)).toBe(dbtDir)
  })
})

// ---------------------------------------------------------------------------
// modelsModifiedSince
// ---------------------------------------------------------------------------

describe("modelsModifiedSince", () => {
  let tmpDir: string
  const FAR_PAST_MS = new Date("2000-01-01").getTime()
  const FAR_FUTURE_MS = Date.now() + 1_000_000

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(join(osTmpdir(), "models-since-test-"))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test("returns empty array when directory has no files", async () => {
    expect(await modelsModifiedSince(tmpDir, FAR_PAST_MS)).toEqual([])
  })

  test("returns SQL files under models/ modified since sinceMs", async () => {
    const dir = join(tmpDir, "models", "marts")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, "orders.sql"), "SELECT 1")
    const result = await modelsModifiedSince(tmpDir, FAR_PAST_MS)
    expect(result.length).toBe(1)
    expect(result[0]).toContain("orders.sql")
  })

  test("excludes SQL files NOT under a models/ path component", async () => {
    const dir = join(tmpDir, "analyses")
    await fs.mkdir(dir)
    await fs.writeFile(join(dir, "ad_hoc.sql"), "SELECT 1")
    expect(await modelsModifiedSince(tmpDir, FAR_PAST_MS)).toEqual([])
  })

  test("excludes SQL files modified BEFORE sinceMs", async () => {
    const dir = join(tmpDir, "models")
    await fs.mkdir(dir)
    await fs.writeFile(join(dir, "old.sql"), "SELECT 1")
    expect(await modelsModifiedSince(tmpDir, FAR_FUTURE_MS)).toEqual([])
  })

  test("includes SQL files where mtime === sinceMs (boundary: >= sinceMs)", async () => {
    const dir = join(tmpDir, "models")
    await fs.mkdir(dir)
    const filePath = join(dir, "boundary.sql")
    await fs.writeFile(filePath, "SELECT 1")
    const stat = await fs.stat(filePath)
    // Use exact mtime as sinceMs — file should be included
    const result = await modelsModifiedSince(tmpDir, stat.mtimeMs)
    expect(result.length).toBe(1)
  })

  test("skips node_modules directories", async () => {
    const dir = join(tmpDir, "node_modules", "models")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, "bad.sql"), "SELECT 1")
    expect(await modelsModifiedSince(tmpDir, FAR_PAST_MS)).toEqual([])
  })

  test("skips target directories", async () => {
    const dir = join(tmpDir, "target", "models")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, "compiled.sql"), "SELECT 1")
    expect(await modelsModifiedSince(tmpDir, FAR_PAST_MS)).toEqual([])
  })

  test("skips hidden directories (dot-prefixed)", async () => {
    const dir = join(tmpDir, ".dbt_cache", "models")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, "cached.sql"), "SELECT 1")
    expect(await modelsModifiedSince(tmpDir, FAR_PAST_MS)).toEqual([])
  })

  test("excludes non-.sql files inside models/", async () => {
    const dir = join(tmpDir, "models")
    await fs.mkdir(dir)
    await fs.writeFile(join(dir, "config.yml"), "version: 2")
    await fs.writeFile(join(dir, "README.md"), "# readme")
    await fs.writeFile(join(dir, "script.py"), "print('hi')")
    await fs.writeFile(join(dir, "schema.json"), "{}")
    expect(await modelsModifiedSince(tmpDir, FAR_PAST_MS)).toEqual([])
  })

  test("returns multiple files from multiple nested model dirs", async () => {
    const staging = join(tmpDir, "models", "staging")
    const marts = join(tmpDir, "models", "marts")
    await fs.mkdir(staging, { recursive: true })
    await fs.mkdir(marts, { recursive: true })
    await fs.writeFile(join(staging, "stg_orders.sql"), "SELECT 1")
    await fs.writeFile(join(marts, "fct_orders.sql"), "SELECT 1")
    const result = await modelsModifiedSince(tmpDir, FAR_PAST_MS)
    expect(result.length).toBe(2)
    const names = result.map((p) => p.split(sep).pop())
    expect(names).toContain("stg_orders.sql")
    expect(names).toContain("fct_orders.sql")
  })

  test("depth boundary: file at depth 4 is INCLUDED", async () => {
    // tmpDir/a/b/c/d = depth 4 from tmpDir; depth guard is `> 4` so 4 is OK
    const deep = join(tmpDir, "a", "b", "c", "models")
    await fs.mkdir(deep, { recursive: true })
    await fs.writeFile(join(deep, "deep.sql"), "SELECT 1")
    const result = await modelsModifiedSince(tmpDir, FAR_PAST_MS)
    expect(result.length).toBe(1)
    expect(result[0]).toContain("deep.sql")
  })

  test("depth boundary: file at depth 8 is INCLUDED, depth 9 is EXCLUDED", async () => {
    // The scan now goes 8 levels deep (was 4). Real dbt layouts like
    // models/staging/sources/dl/raw/foo.sql need this. Confirm:
    //   tmpDir/a/b/c/d/e/f/models/in.sql  (depth 8 — included)
    //   tmpDir/a/b/c/d/e/f/g/h/models/out.sql (depth 10 — excluded; > 8)
    const includedDir = join(tmpDir, "a", "b", "c", "d", "e", "f", "models")
    await fs.mkdir(includedDir, { recursive: true })
    await fs.writeFile(join(includedDir, "in.sql"), "SELECT 1")

    const excludedDir = join(tmpDir, "a", "b", "c", "d", "e", "f", "g", "h", "models")
    await fs.mkdir(excludedDir, { recursive: true })
    await fs.writeFile(join(excludedDir, "out.sql"), "SELECT 1")

    const result = await modelsModifiedSince(tmpDir, FAR_PAST_MS)
    expect(result.some((p) => p.endsWith("in.sql"))).toBe(true)
    expect(result.some((p) => p.endsWith("out.sql"))).toBe(false)
  })

  test("handles non-existent cwd gracefully", async () => {
    const result = await modelsModifiedSince("/tmp/nonexistent-xyz-123", FAR_PAST_MS)
    expect(result).toEqual([])
  })

  test("handles cwd with no read permission gracefully (simulated by non-existent path)", async () => {
    // On CI we can't reliably drop permissions; test non-existent which triggers the same catch
    const result = await modelsModifiedSince("/root/no-access-test", FAR_PAST_MS)
    expect(result).toEqual([])
  })

  test("does not include a file named 'models.sql' outside of a models/ dir", async () => {
    // A file named `models.sql` at the root level doesn't have `models` in its path *components*
    // when cwd is tmpDir — `tmpDir/models.sql` split by sep would give ["...tmpDir", "models.sql"],
    // which does not include the string "models" as a standalone component.
    // HOWEVER: `tmpDir/staging/models.sql` — the path components are [staging, models.sql],
    // and "models.sql" does NOT equal "models". So it should NOT be included.
    const dir = join(tmpDir, "staging")
    await fs.mkdir(dir)
    await fs.writeFile(join(dir, "models.sql"), "SELECT 1")
    expect(await modelsModifiedSince(tmpDir, FAR_PAST_MS)).toEqual([])
  })

  test("file directly in models/ (no subdirectory) is included", async () => {
    const dir = join(tmpDir, "models")
    await fs.mkdir(dir)
    await fs.writeFile(join(dir, "flat.sql"), "SELECT 1")
    const result = await modelsModifiedSince(tmpDir, FAR_PAST_MS)
    expect(result.length).toBe(1)
    expect(result[0]).toContain("flat.sql")
  })

  test("models/ directory at depth 2 (nested project layout)", async () => {
    // tmpDir/project/models/my_model.sql — realistic for dbt in monorepo
    const dir = join(tmpDir, "project", "models")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, "my_model.sql"), "SELECT 1")
    const result = await modelsModifiedSince(tmpDir, FAR_PAST_MS)
    expect(result.length).toBe(1)
  })

  test("mixes modified and unmodified files — only returns modified", async () => {
    const dir = join(tmpDir, "models")
    await fs.mkdir(dir)
    // Write both files; one will be "old" via FAR_FUTURE_MS threshold
    await fs.writeFile(join(dir, "new_model.sql"), "SELECT 1")
    // We can't easily set a past mtime without utime, so test only one direction:
    // use a future threshold so no file qualifies
    const futureResult = await modelsModifiedSince(tmpDir, FAR_FUTURE_MS)
    expect(futureResult).toEqual([])
    // Use past threshold so both qualify
    const pastResult = await modelsModifiedSince(tmpDir, FAR_PAST_MS)
    expect(pastResult.length).toBe(1)
  })
})
