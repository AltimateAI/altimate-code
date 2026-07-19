import { describe, test, expect } from "bun:test"
import { parseNumstatZ, parseHunksByPath, isTestPath, buildDivergence } from "./divergence"
import { resolveRepoRoot } from "./utils/repo-root"

// The divergence tool counts added/deleted/files from `git diff --numstat -M
// -z` (git's own plumbing), NOT by hand-counting +/- lines out of a unified
// diff. These tests pin that contract, including the exact case that made the
// old hand-rolled parser wrong: content lines that begin `++` / `--`.

describe("parseNumstatZ", () => {
  // Build a NUL-delimited numstat record stream from tuples.
  const rec = (added: string, deleted: string, path: string) => `${added}\t${deleted}\t${path}\0`
  const renameRec = (added: string, deleted: string, oldPath: string, newPath: string) =>
    `${added}\t${deleted}\t\0${oldPath}\0${newPath}\0`

  test("simple modified file", () => {
    const result = parseNumstatZ(rec("2", "1", "packages/opencode/src/foo.ts"))
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      path: "packages/opencode/src/foo.ts",
      oldPath: null,
      added: 2,
      deleted: 1,
      isBinary: false,
      isRename: false,
    })
  })

  test("multiple files accumulate independently", () => {
    const result = parseNumstatZ(rec("2", "2", "a.ts") + rec("2", "0", "b.ts"))
    expect(result).toHaveLength(2)
    expect(result.find((f) => f.path === "a.ts")!.added).toBe(2)
    expect(result.find((f) => f.path === "b.ts")!.deleted).toBe(0)
  })

  test("rename record: empty third field, next two NUL fields are old/new path", () => {
    const result = parseNumstatZ(renameRec("1", "1", "old/path.ts", "new/path.ts"))
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      path: "new/path.ts",
      oldPath: "old/path.ts",
      added: 1,
      deleted: 1,
      isBinary: false,
      isRename: true,
    })
  })

  test("pure rename (0/0) followed by a normal file parses both correctly", () => {
    // This is the exact interleaving that a naive parser trips on: a rename's
    // two path fields must be consumed before the next record is read.
    const result = parseNumstatZ(renameRec("0", "0", "a/old.ts", "a/new.ts") + rec("5", "3", "b/other.ts"))
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ path: "a/new.ts", oldPath: "a/old.ts", isRename: true })
    expect(result[1]).toMatchObject({ path: "b/other.ts", added: 5, deleted: 3 })
  })

  test("binary file (- / -) is flagged and contributes zero added/deleted", () => {
    const result = parseNumstatZ(rec("-", "-", "img.png"))
    expect(result[0].isBinary).toBe(true)
    expect(result[0].added).toBe(0)
    expect(result[0].deleted).toBe(0)
  })

  test("paths with spaces survive (NUL-delimited, no quoting needed)", () => {
    const result = parseNumstatZ(rec("1", "0", "docs/a file with spaces.md"))
    expect(result[0].path).toBe("docs/a file with spaces.md")
  })

  test("empty input yields no entries", () => {
    expect(parseNumstatZ("")).toHaveLength(0)
  })

  test("fails closed on a malformed record head (truncated -z stream)", () => {
    // A field with fewer than two tabs is not a valid numstat record — throw
    // rather than silently drop it and understate totals.
    expect(() => parseNumstatZ("5\tnot-a-tab-record\0")).toThrow(/malformed numstat record/)
  })

  test("fails closed on a truncated rename record (missing new path)", () => {
    // Rename head present (empty 3rd field) but the following NUL fields cut off.
    expect(() => parseNumstatZ("1\t1\t\0only-old-path")).toThrow(/truncated rename record/)
  })

  test("fails closed on a non-numeric count field", () => {
    expect(() => parseNumstatZ("x\t3\tsome/path\0")).toThrow(/non-numeric/)
  })
})

describe("parseHunksByPath", () => {
  test("counts @@ headers per post-image path", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "@@ -1 +1 @@",
      "-a1",
      "+a1new",
      "@@ -5 +5 @@",
      "-a2",
      "+a2new",
      "diff --git a/b.ts b/b.ts",
      "@@ -1 +1,2 @@",
      "+b1",
      "+b2",
    ].join("\n")
    const { byPath, total } = parseHunksByPath(diff)
    expect(byPath.get("a.ts")).toBe(2)
    expect(byPath.get("b.ts")).toBe(1)
    expect(total).toBe(3)
  })

  test("REGRESSION: content lines beginning ++ / -- are never mistaken for @@ headers", () => {
    // A deleted source line `--foo` renders `---foo`; an added `++bar` renders
    // `+++bar`. Neither is a hunk header. Only `@@ ` at column 0 is. (numstat
    // owns the +/- COUNTS; this just proves hunk counting isn't fooled.)
    const diff = [
      "diff --git a/x.md b/x.md",
      "--- a/x.md",
      "+++ b/x.md",
      "@@ -1,2 +1,2 @@",
      "----", // a deleted markdown horizontal rule `---`
      "+++new heading marker line", // an added line beginning `++`
    ].join("\n")
    const { byPath, total } = parseHunksByPath(diff)
    expect(total).toBe(1) // exactly one real @@ header
    expect(byPath.get("x.md")).toBe(1)
  })

  test("quoted-path header (spaces) attributes hunks to the unquoted post-image path", () => {
    const diff = ['diff --git "a/a b.ts" "b/a b.ts"', "@@ -1 +1 @@", "-x", "+y"].join("\n")
    const { byPath } = parseHunksByPath(diff)
    expect(byPath.get("a b.ts")).toBe(1)
  })

  test("type-change emits two diff --git blocks for one post-image path; hunks fold", () => {
    const diff = [
      "diff --git a/link b/link",
      "@@ -1 +0,0 @@",
      "-target",
      "diff --git a/link b/link",
      "@@ -0,0 +1 @@",
      "+contents",
    ].join("\n")
    const { byPath, total } = parseHunksByPath(diff)
    expect(byPath.get("link")).toBe(2)
    expect(total).toBe(2)
  })
})

describe("isTestPath", () => {
  test.each([
    ["packages/opencode/test/foo.test.ts", true],
    ["src/__tests__/bar.ts", true],
    ["a/tests/c.spec.ts", true],
    ["packages/opencode/src/foo.ts", false],
    ["docs/testing.md", false],
  ])("%s -> %s", (path, expected) => {
    expect(isTestPath(path)).toBe(expected)
  })
})

describe("buildDivergence (real-repo, pinned against git --shortstat ground truth)", () => {
  test(
    "v1.17.9 vs the fork HEAD matches git's own shortstat exactly",
    () => {
      const repoRoot = resolveRepoRoot()
      const envelope = buildDivergence(repoRoot, "v1.17.9", "8a50ec7f55", { now: "2026-07-18T00:00:00.000Z" })

      // Ground truth: `LC_ALL=C git -c diff.renameLimit=20000 diff --shortstat -M v1.17.9 8a50ec7f55`
      // => 5283 files changed, 499181 insertions(+), 740989 deletions(-).
      expect(envelope.totals.files).toBe(5283)
      expect(envelope.totals.added).toBe(499181)
      expect(envelope.totals.deleted).toBe(740989)

      expect(envelope.schemaVersion).toBe(2)
      expect(envelope.upstreamBaseTree).toMatch(/^[0-9a-f]{40}$/)
      expect(envelope.oursTree).toMatch(/^[0-9a-f]{40}$/)
      expect(envelope.diffOptions.renameLimit).toBe(20000)
      expect(envelope.files.length).toBe(envelope.totals.files)

      // Codepoint-sorted (NOT localeCompare).
      const paths = envelope.files.map((f) => f.path)
      expect(paths).toEqual([...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
    },
    30_000,
  )

  test(
    "generatedAt is injectable, so the envelope is byte-deterministic",
    () => {
      const repoRoot = resolveRepoRoot()
      const a = buildDivergence(repoRoot, "v1.17.9", "8a50ec7f55", { now: "2026-07-18T00:00:00.000Z" })
      const b = buildDivergence(repoRoot, "v1.17.9", "8a50ec7f55", { now: "2026-07-18T00:00:00.000Z" })
      expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    },
    30_000, // two full-repo diffs; the default 5s is too tight
  )
})
