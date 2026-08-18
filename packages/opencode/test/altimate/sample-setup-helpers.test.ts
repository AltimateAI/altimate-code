// v0.9.5 review — Tech Lead P1 (initial pass) + coderabbit / cubic follow-ups.
//
// sample-setup.ts::redactPaths has a docstring listing three specific bugs the
// implementation was written to fix (regex swallowing surrounding sentence,
// `/root/…` prefix leaking, José/O'Connor surnames leaking on the first pass).
// None of them had test coverage this release. This file asserts the fixes so a
// future edit to the regex or the known-value substitution loop can't silently
// re-introduce them.
//
// countSampleContents is a tiny counting helper — but it's called on every
// sample_setup invocation and its output feeds a telemetry event, so a
// silent-zero bug (typo in the extension filter, wrong subdirectory name)
// would misreport onboarding activity. The fixture below builds a real dir tree
// per test and asserts the count.
//
// Fixture ownership note (bot-review follow-up, coderabbit + cubic):
// countSampleContents originally shared one `mkdtempSync` at module scope with
// afterAll cleanup. That leaks if the suite is filtered (only redactPaths tests
// selected) or if a `beforeAll` throws before `afterAll` registers. Switched to
// the repo's `await using tmp = await tmpdir()` pattern so each test owns its
// fixture and cleanup is bound to the test scope.

import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

import { tmpdir } from "../fixture/fixture"
import { redactPaths, countSampleContents } from "../../src/altimate/tools/sample-setup"

describe("redactPaths", () => {
  test("redacts an absolute POSIX path", () => {
    const out = redactPaths("failed at /usr/local/bin/dbt")
    expect(out).toBe("failed at <path>")
  })

  test("redacts a Windows drive path", () => {
    const out = redactPaths("failed at C:\\Users\\alice\\dbt.exe")
    // Windows paths pattern matches `C:\` opener and consumes until whitespace/quote.
    expect(out).toBe("failed at <path>")
    expect(out).not.toContain("Users")
    expect(out).not.toContain("alice")
  })

  test("redacts a home-relative path (~/)", () => {
    // Note: `~/.altimate/…` is redacted by the POSIX-`/` pattern first, which
    // starts at the leading slash and leaves the `~` as a harmless prefix.
    // What the assertion cares about is that no path segment leaks — the exact
    // shape of the redaction marker is secondary.
    const out = redactPaths("cannot read ~/.altimate/machine-id")
    expect(out).not.toContain(".altimate")
    expect(out).not.toContain("machine-id")
    expect(out).toContain("<path>")
  })

  test("redacts a bare tilde-only path (~/x with no preceding slash)", () => {
    // The dedicated `~\/…` pattern is what catches this shape — the POSIX-`/`
    // one starts inside the path and can leave a `~` behind.
    const input = "opening ~/opt/dbt for read"
    const out = redactPaths(input)
    expect(out).not.toContain("opt/dbt")
    expect(out).toContain("<path>")
  })

  test("terminates at whitespace, does NOT swallow the surrounding sentence", () => {
    // The docstring calls out this exact class of bug: an early implementation
    // used a character class that included `.`, so the regex would consume the
    // rest of the sentence past the path. Reader ends up with just "<path>".
    const input = "Underlying error: /Users/alice/projects/dbt-demo failed to compile"
    const out = redactPaths(input)
    expect(out).toContain("failed to compile")
    expect(out).toContain("Underlying error:")
    expect(out).not.toContain("/Users")
  })

  test("terminates at a double-quote", () => {
    const out = redactPaths('opening "/Users/alice/dbt_project.yml" for read')
    expect(out).toContain("for read")
    expect(out).not.toContain("alice")
  })

  test("handles a path containing an apostrophe (O'Connor)", () => {
    // Docstring bug: an early character class excluded `'`, so the regex would
    // stop at the apostrophe and leak the substring after it. Now apostrophes
    // are permitted inside the redacted run.
    const out = redactPaths("failed at /Users/O'Connor/projects/x")
    expect(out).not.toContain("O'Connor")
    expect(out).not.toContain("Connor")
    expect(out).toBe("failed at <path>")
  })

  test("handles a path containing an accented character (José)", () => {
    const out = redactPaths("failed at /Users/José/dbt")
    expect(out).not.toContain("José")
    expect(out).toBe("failed at <path>")
  })

  test("path segment terminates at the first whitespace, so a path containing a space leaks the tail", () => {
    // codex-review gap: the greedy pattern stops at the first `\s`, so a real
    // CWD like `/Users/alice/My Documents/dbt` gets split — only `/Users/alice/My`
    // is redacted; `Documents/dbt` is left in the output.
    //
    // The `extra` list is what production callers use to close this gap (they
    // pass the exact CWD to `redactPaths(msg, [cwd])`), so this test also
    // asserts the compensating behavior — with the CWD known-value, the whole
    // path collapses cleanly.
    const cwd = "/Users/alice/My Documents/dbt"
    const raw = redactPaths(`failed at ${cwd}/models/foo.sql`)
    // Documented limitation of the pattern-only pass: the greedy path pattern
    // terminates at the first whitespace, so `/Users/alice/My` and
    // `/dbt/models/foo.sql` each redact cleanly but the middle segment
    // `Documents` sits between two `<path>` markers.
    expect(raw).toContain("Documents")
    expect(raw).not.toBe("failed at <path>")
    // With the CWD passed as a known value the whole path collapses cleanly:
    const guarded = redactPaths(`failed at ${cwd}/models/foo.sql`, [cwd])
    expect(guarded).toBe("failed at <path>")
    expect(guarded).not.toContain("Documents")
    expect(guarded).not.toContain("alice")
  })

  test("collapses adjacent <path> segments so double-redaction reads clean", () => {
    // The known-value pass replaces os.homedir() etc first; the greedy pattern
    // then may match the "<path>" tail and re-redact. The collapse rule keeps
    // the output from becoming "<path><path><path>".
    const home = require("os").homedir()
    const out = redactPaths(`failed at ${home}/dbt/models/foo.sql`)
    expect(out).toBe("failed at <path>")
    expect(out).not.toMatch(/<path><path>/)
  })

  test("passes short/empty known values without exploding", () => {
    // Guard for `known.length < 2` — empty string or single-char known values
    // used to `split("")` and shatter every character. The guard keeps them out
    // of the substitution loop.
    const out = redactPaths("hello world", ["", "a", undefined])
    expect(out).toBe("hello world")
  })

  test("substitutes user-supplied extras", () => {
    const out = redactPaths("clone failed at /tmp/checkout-xyz", ["/tmp/checkout-xyz"])
    expect(out).toBe("clone failed at <path>")
  })

  test("returns the message unchanged when nothing path-shaped is present", () => {
    expect(redactPaths("dbt run completed in 3s")).toBe("dbt run completed in 3s")
  })
})

// Shared helper — each test uses its own tmp dir via `await using`, so cleanup
// is scoped to the test itself (bot-review follow-up).
async function seedSampleTree(dir: string) {
  fs.mkdirSync(path.join(dir, "models", "staging"), { recursive: true })
  fs.mkdirSync(path.join(dir, "models", "marts", "core"), { recursive: true })
  fs.mkdirSync(path.join(dir, "seeds"), { recursive: true })

  fs.writeFileSync(path.join(dir, "models", "top.sql"), "select 1")
  fs.writeFileSync(path.join(dir, "models", "staging", "stg_orders.sql"), "select 1")
  fs.writeFileSync(path.join(dir, "models", "staging", "stg_users.sql"), "select 1")
  fs.writeFileSync(path.join(dir, "models", "marts", "core", "dim_customers.sql"), "select 1")

  // Non-.sql alongside .sql, must NOT be counted.
  fs.writeFileSync(path.join(dir, "models", "readme.md"), "hi")
  fs.writeFileSync(path.join(dir, "models", "schema.yml"), "version: 2")

  fs.writeFileSync(path.join(dir, "seeds", "country_codes.csv"), "code,name\n")
  fs.writeFileSync(path.join(dir, "seeds", "regions.csv"), "id,name\n")
  // Non-.csv seed — not counted.
  fs.writeFileSync(path.join(dir, "seeds", "notes.md"), "hi")
}

describe("countSampleContents", () => {
  test("counts .sql files recursively under models/", async () => {
    await using tmp = await tmpdir()
    await seedSampleTree(tmp.path)
    expect(countSampleContents(tmp.path).models).toBe(4)
  })

  test("counts .csv files under seeds/ (top level; matches production sample layout)", async () => {
    await using tmp = await tmpdir()
    await seedSampleTree(tmp.path)
    expect(countSampleContents(tmp.path).tables).toBe(2)
  })

  test("returns zeros when the sample dir is missing the expected subdirs", async () => {
    await using tmp = await tmpdir()
    expect(countSampleContents(tmp.path)).toEqual({ models: 0, tables: 0 })
  })

  test("returns zeros when the sample dir does not exist at all", async () => {
    // countFilesWithExtension swallows the readdirSync error and returns 0 —
    // this is the graceful-degradation shape the telemetry event depends on.
    await using tmp = await tmpdir()
    expect(countSampleContents(path.join(tmp.path, "does-not-exist"))).toEqual({ models: 0, tables: 0 })
  })
})
