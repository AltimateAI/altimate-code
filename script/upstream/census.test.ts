import { describe, test, expect } from "bun:test"
import { execSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import {
  cleanDescription,
  contentHashOf,
  parseMarkerBlocks,
  ratchetCheck,
  loadExemptions,
  isScannablePath,
  assembleCensus,
  assertCensusCompatible,
  findStaleExemptions,
  parseNumstatZ,
  computeDiffBudget,
  type CensusEnvelope,
  type Block,
  type Exemption,
  type CensusProvenance,
} from "./census"
import type { Bucket } from "./taxonomy"

describe("cleanDescription", () => {
  test("strips trailing */ comment closer", () => {
    expect(cleanDescription("branding fix */")).toBe("branding fix")
  })

  test("strips trailing }", () => {
    expect(cleanDescription("wiring change}")).toBe("wiring change")
  })

  test("strips trailing )", () => {
    expect(cleanDescription("some description)")).toBe("some description")
  })

  test("strips trailing backtick/comma", () => {
    expect(cleanDescription("template literal thing`,")).toBe("template literal thing")
  })

  test("empty/undefined description yields empty string", () => {
    expect(cleanDescription(undefined)).toBe("")
    expect(cleanDescription("")).toBe("")
    expect(cleanDescription("   ")).toBe("")
  })
})

describe("contentHashOf", () => {
  const lines = ["a", "b", "c", "d", "e"]

  test("returns null when endLine is null (unclosed block)", () => {
    expect(contentHashOf(lines, 1, null)).toBeNull()
  })

  test("is deterministic for the same line range", () => {
    const h1 = contentHashOf(lines, 2, 4)
    const h2 = contentHashOf(lines, 2, 4)
    expect(h1).toBe(h2)
    expect(h1).not.toBeNull()
  })

  test("differs for different line ranges", () => {
    const h1 = contentHashOf(lines, 1, 2)
    const h2 = contentHashOf(lines, 2, 3)
    expect(h1).not.toBe(h2)
  })

  test("CRLF vs LF line endings hash identically (finding: CRLF normalization)", () => {
    const lf = ["a", "b", "c"]
    const crlf = ["a\r", "b\r", "c\r"]
    expect(contentHashOf(lf, 1, 3)).toBe(contentHashOf(crlf, 1, 3))
  })
})

describe("parseMarkerBlocks", () => {
  test("no markers present returns empty result without scanning", () => {
    const { blocks, unclosed } = parseMarkerBlocks("some/file.ts", "just some code\nwith no markers\n", new Set())
    expect(blocks).toHaveLength(0)
    expect(unclosed).toBe(0)
  })

  test("single simple block", () => {
    const content = ["line0", "// altimate_change start — branding: app name", "line1", "line2", "// altimate_change end", "line3"].join("\n")
    const { blocks, unclosed } = parseMarkerBlocks("packages/opencode/src/foo.ts", content, new Set())
    expect(unclosed).toBe(0)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].startLine).toBe(2)
    expect(blocks[0].endLine).toBe(5)
    expect(blocks[0].lineCount).toBe(4)
    expect(blocks[0].description).toBe("branding: app name")
    expect(blocks[0].isUpstreamFix).toBe(false)
    expect(blocks[0].contentHash).not.toBeNull()
  })

  test("nested blocks are matched via a stack (innermost end closes innermost start)", () => {
    const content = [
      "// altimate_change start — outer wiring",
      "outer line",
      "// altimate_change start — upstream_fix: inner null check",
      "inner line",
      "// altimate_change end",
      "outer line 2",
      "// altimate_change end",
    ].join("\n")
    const { blocks, unclosed } = parseMarkerBlocks("packages/opencode/src/foo.ts", content, new Set())
    expect(unclosed).toBe(0)
    expect(blocks).toHaveLength(2)
    // Inner block closes first (line 5), so it's pushed to `blocks` before the outer.
    const inner = blocks.find((b) => b.description.includes("inner"))!
    const outer = blocks.find((b) => b.description.includes("outer"))!
    expect(inner.startLine).toBe(3)
    expect(inner.endLine).toBe(5)
    expect(inner.isUpstreamFix).toBe(true)
    expect(outer.startLine).toBe(1)
    expect(outer.endLine).toBe(7)
    expect(outer.isUpstreamFix).toBe(false)
  })

  test("unclosed block (start with no matching end) is reported with null endLine/contentHash", () => {
    const content = ["// altimate_change start — dangling", "line1", "line2"].join("\n")
    const { blocks, unclosed } = parseMarkerBlocks("packages/opencode/src/foo.ts", content, new Set())
    expect(unclosed).toBe(1)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].endLine).toBeNull()
    expect(blocks[0].lineCount).toBeNull()
    expect(blocks[0].contentHash).toBeNull()
  })

  test("bucket is classified per-file via the injected upstreamPaths set", () => {
    const content = ["// altimate_change start — test", "x", "// altimate_change end"].join("\n")
    const { blocks: sharedBlocks } = parseMarkerBlocks("packages/opencode/src/foo.ts", content, new Set(["packages/opencode/src/foo.ts"]))
    expect(sharedBlocks[0].bucket).toBe("upstream_shared")

    const { blocks: ownedBlocks } = parseMarkerBlocks("script/upstream/foo.ts", content, new Set())
    expect(ownedBlocks[0].bucket).toBe("fork_owned")
  })

  test("empty description falls back to '(no description)'", () => {
    const content = ["// altimate_change start", "x", "// altimate_change end"].join("\n")
    const { blocks } = parseMarkerBlocks("packages/opencode/src/foo.ts", content, new Set())
    expect(blocks[0].description).toBe("(no description)")
  })
})

describe("isScannablePath", () => {
  test("accepts a .ts file under an approved scan root", () => {
    expect(isScannablePath("packages/opencode/src/index.ts")).toBe(true)
  })

  test("rejects a file with a non-scannable extension", () => {
    expect(isScannablePath("packages/opencode/src/image.png")).toBe(false)
  })

  test("rejects a path not under any scan root", () => {
    expect(isScannablePath("random-top-level-file.ts")).toBe(false)
  })

  test("rejects a path passing through a skipped directory name (e.g. node_modules, dist)", () => {
    expect(isScannablePath("packages/opencode/node_modules/foo/index.ts")).toBe(false)
    expect(isScannablePath("packages/opencode/dist/index.ts")).toBe(false)
  })

  test("accepts .yaml/.yml (finding: SCAN_EXTS gap)", () => {
    expect(isScannablePath("script/foo.yaml")).toBe(true)
    expect(isScannablePath("script/foo.yml")).toBe(true)
  })

  test("accepts a path under .github (finding: SCAN_ROOTS typo 'github' -> '.github')", () => {
    expect(isScannablePath(".github/meta/foo.md")).toBe(true)
  })
})

describe("loadExemptions", () => {
  test("returns empty array when file does not exist", () => {
    expect(loadExemptions("/nonexistent/path/defork-exemptions.jsonc")).toEqual([])
  })

  test("parses a JSONC array with // and /* */ comments stripped", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "census-exemptions-"))
    const file = path.join(dir, "exemptions.jsonc")
    fs.writeFileSync(
      file,
      `// Schema: { blockRef: { file, contentHash }, allowedCount, reason, approvedBy, expires? }
      [
        /* an approved exemption */
        {
          "blockRef": { "file": "packages/opencode/src/foo.ts", "contentHash": "abc123" },
          "allowedCount": 1,
          "reason": "tracked in AI-9999",
          "approvedBy": "team-lead"
        }
      ]
      `,
    )
    const exemptions = loadExemptions(file)
    expect(exemptions).toHaveLength(1)
    expect(exemptions[0].blockRef.file).toBe("packages/opencode/src/foo.ts")
    expect(exemptions[0].allowedCount).toBe(1)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("throws a clear error when the top level is not an array", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "census-exemptions-"))
    const file = path.join(dir, "bad.jsonc")
    fs.writeFileSync(file, `{ "not": "an array" }`)
    expect(() => loadExemptions(file)).toThrow(/expected top-level JSON array/)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("throws when an exemption is missing a required field (finding: validateExemption)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "census-exemptions-"))
    const file = path.join(dir, "missing-reason.jsonc")
    fs.writeFileSync(
      file,
      JSON.stringify([
        {
          blockRef: { file: "packages/opencode/src/foo.ts", contentHash: "abc123" },
          allowedCount: 1,
          approvedBy: "team-lead",
          // reason omitted
        },
      ]),
    )
    expect(() => loadExemptions(file)).toThrow(/reason must be a non-empty string/)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("throws when allowedCount is not a positive integer", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "census-exemptions-"))
    const file = path.join(dir, "bad-count.jsonc")
    fs.writeFileSync(
      file,
      JSON.stringify([
        {
          blockRef: { file: "packages/opencode/src/foo.ts", contentHash: "abc123" },
          allowedCount: 0,
          reason: "tracked",
          approvedBy: "team-lead",
        },
      ]),
    )
    expect(() => loadExemptions(file)).toThrow(/allowedCount must be a positive integer/)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("throws when expires is not a valid date string", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "census-exemptions-"))
    const file = path.join(dir, "bad-expires.jsonc")
    fs.writeFileSync(
      file,
      JSON.stringify([
        {
          blockRef: { file: "packages/opencode/src/foo.ts", contentHash: "abc123" },
          allowedCount: 1,
          reason: "tracked",
          approvedBy: "team-lead",
          expires: "not-a-date",
        },
      ]),
    )
    expect(() => loadExemptions(file)).toThrow(/expires must be a valid ISO date string/)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

function block(overrides: Partial<Block>): Block {
  return {
    file: "packages/opencode/src/foo.ts",
    startLine: 1,
    endLine: 3,
    lineCount: 3,
    description: "test",
    isUpstreamFix: false,
    bucket: "upstream_shared",
    categories: ["OTHER"],
    contentHash: "hash-a",
    ...overrides,
  }
}

/**
 * Mirrors assembleCensus()'s own byBucket/byCategory computation rather than
 * hardcoding zeros — a fixture whose totals don't actually reflect its
 * blocks array would (rightly) trip assertMultisetTotalsConsistent(), since
 * that's exactly the class of internal-accounting bug it exists to catch.
 */
function envelope(blocks: Block[]): CensusEnvelope {
  const byBucket: Record<Bucket, { blocks: number; files: number }> = {
    upstream_shared: { blocks: 0, files: 0 },
    fork_owned: { blocks: 0, files: 0 },
    fork_added_outside_boundary: { blocks: 0, files: 0 },
  }
  const filesByBucket: Record<Bucket, Set<string>> = {
    upstream_shared: new Set(),
    fork_owned: new Set(),
    fork_added_outside_boundary: new Set(),
  }
  for (const b of blocks) {
    byBucket[b.bucket].blocks++
    filesByBucket[b.bucket].add(b.file)
  }
  for (const bucket of Object.keys(byBucket) as Bucket[]) {
    byBucket[bucket].files = filesByBucket[bucket].size
  }

  const byCategory: Record<string, { blocks: number; files: number }> = {}
  const filesByCategory = new Map<string, Set<string>>()
  for (const b of blocks) {
    for (const c of b.categories) {
      byCategory[c] ??= { blocks: 0, files: 0 }
      byCategory[c].blocks++
      if (!filesByCategory.has(c)) filesByCategory.set(c, new Set())
      filesByCategory.get(c)!.add(b.file)
    }
  }
  for (const c of Object.keys(byCategory)) {
    byCategory[c].files = filesByCategory.get(c)!.size
  }

  return {
    schemaVersion: 1,
    generatorVersion: "test",
    generatedAt: new Date().toISOString(),
    taxonomyVersion: 1,
    oursRef: "HEAD",
    oursSha: "deadbeef",
    oursTree: "treebeef",
    upstreamBaseRef: "v1.17.9",
    upstreamBaseSha: "beefdead",
    upstreamBaseTree: "beeftree",
    rules: { forkOwnedRoots: [], categoryRuleIds: [] },
    totals: {
      blocks: blocks.length,
      files: new Set(blocks.map((b) => b.file)).size,
      unclosed: blocks.filter((b) => b.endLine === null).length,
      byBucket,
      byCategory,
    },
    blocks,
    unclosedAllowlistApplication: [],
  }
}

describe("ratchetCheck", () => {
  test("no violations when current matches baseline exactly", () => {
    const baseline = envelope([block({})])
    const current = envelope([block({})])
    expect(ratchetCheck(current, baseline, [])).toEqual([])
  })

  test("no violations when a block is removed (baseline count higher than current)", () => {
    const baseline = envelope([block({}), block({ contentHash: "hash-b" })])
    const current = envelope([block({})])
    expect(ratchetCheck(current, baseline, [])).toEqual([])
  })

  test("flags an uncovered net-new instance of an existing {file, contentHash} pair", () => {
    const baseline = envelope([block({})])
    const current = envelope([block({}), block({})]) // same file+contentHash appears twice now
    const violations = ratchetCheck(current, baseline, [])
    expect(violations).toHaveLength(1)
    expect(violations[0].netNew).toBe(1)
    expect(violations[0].uncoveredCount).toBe(1)
  })

  test("flags a brand new {file, contentHash} pair not in baseline at all", () => {
    const baseline = envelope([])
    const current = envelope([block({})])
    const violations = ratchetCheck(current, baseline, [])
    expect(violations).toHaveLength(1)
    expect(violations[0].baselineCount).toBe(0)
    expect(violations[0].currentCount).toBe(1)
  })

  test("an exemption with sufficient allowedCount covers the net-new instance", () => {
    const baseline = envelope([])
    const current = envelope([block({})])
    const exemptions: Exemption[] = [
      { blockRef: { file: "packages/opencode/src/foo.ts", contentHash: "hash-a" }, allowedCount: 1, reason: "tracked", approvedBy: "team-lead" },
    ]
    expect(ratchetCheck(current, baseline, exemptions)).toEqual([])
  })

  test("an expired exemption does not cover the net-new instance", () => {
    const baseline = envelope([])
    const current = envelope([block({})])
    const exemptions: Exemption[] = [
      {
        blockRef: { file: "packages/opencode/src/foo.ts", contentHash: "hash-a" },
        allowedCount: 1,
        reason: "tracked",
        approvedBy: "team-lead",
        expires: "2020-01-01",
      },
    ]
    const violations = ratchetCheck(current, baseline, exemptions, new Date("2026-07-18"))
    expect(violations).toHaveLength(1)
  })

  test("a partial exemption still leaves an uncovered remainder", () => {
    const baseline = envelope([])
    const current = envelope([block({}), block({}), block({})]) // 3 net-new instances
    const exemptions: Exemption[] = [
      { blockRef: { file: "packages/opencode/src/foo.ts", contentHash: "hash-a" }, allowedCount: 2, reason: "tracked", approvedBy: "team-lead" },
    ]
    const violations = ratchetCheck(current, baseline, exemptions)
    expect(violations).toHaveLength(1)
    expect(violations[0].uncoveredCount).toBe(1)
  })

  test("fork_owned bucket is excluded from the ratchet entirely", () => {
    const baseline = envelope([])
    const current = envelope([block({ bucket: "fork_owned" }), block({ bucket: "fork_owned" })])
    expect(ratchetCheck(current, baseline, [])).toEqual([])
  })

  test("fork_added_outside_boundary bucket IS ratcheted", () => {
    const baseline = envelope([])
    const current = envelope([block({ bucket: "fork_added_outside_boundary" })])
    const violations = ratchetCheck(current, baseline, [])
    expect(violations).toHaveLength(1)
  })

  test("blocks with null contentHash (unclosed) are excluded from the multiset entirely", () => {
    const baseline = envelope([])
    const current = envelope([block({ contentHash: null, endLine: null, lineCount: null })])
    expect(ratchetCheck(current, baseline, [])).toEqual([])
  })

  test("a file/contentHash pair containing characters that could confuse a naive delimiter still keys correctly (finding: NUL-byte multisetKey)", () => {
    // Regression for the old `${file} ${contentHash}` NUL-delimited key: a
    // path or hash containing a space (or any other single character that
    // could be mistaken for a delimiter) must still round-trip through the
    // multiset key uniquely rather than colliding with a different pair.
    const baseline = envelope([])
    const current = envelope([
      block({ file: "packages/opencode/src/some file.ts", contentHash: "hash-a" }),
      block({ file: "packages/opencode/src/some", contentHash: "file.ts hash-a" }),
    ])
    const violations = ratchetCheck(current, baseline, [])
    expect(violations).toHaveLength(2)
    const files = violations.map((v) => v.file).sort()
    expect(files).toEqual(["packages/opencode/src/some", "packages/opencode/src/some file.ts"])
  })
})

describe("findStaleExemptions", () => {
  test("flags an exemption whose {file, contentHash} has no net-new instance vs baseline", () => {
    const baseline = envelope([block({})])
    const current = envelope([block({})]) // unchanged — exemption covers nothing
    const exemptions: Exemption[] = [
      { blockRef: { file: "packages/opencode/src/foo.ts", contentHash: "hash-a" }, allowedCount: 1, reason: "tracked", approvedBy: "team-lead" },
    ]
    const warnings = findStaleExemptions(exemptions, current, baseline)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].index).toBe(0)
  })

  test("does not flag an exemption actively covering a net-new instance", () => {
    const baseline = envelope([])
    const current = envelope([block({})])
    const exemptions: Exemption[] = [
      { blockRef: { file: "packages/opencode/src/foo.ts", contentHash: "hash-a" }, allowedCount: 1, reason: "tracked", approvedBy: "team-lead" },
    ]
    expect(findStaleExemptions(exemptions, current, baseline)).toEqual([])
  })

  test("does not flag an already-expired exemption as stale (it has its own, expected end-of-life)", () => {
    const baseline = envelope([block({})])
    const current = envelope([block({})])
    const exemptions: Exemption[] = [
      {
        blockRef: { file: "packages/opencode/src/foo.ts", contentHash: "hash-a" },
        allowedCount: 1,
        reason: "tracked",
        approvedBy: "team-lead",
        expires: "2020-01-01",
      },
    ]
    expect(findStaleExemptions(exemptions, current, baseline, new Date("2026-07-18"))).toEqual([])
  })
})

describe("assertCensusCompatible", () => {
  test("does not throw when schemaVersion and taxonomyVersion match", () => {
    const a = envelope([])
    const b = envelope([])
    expect(() => assertCensusCompatible(a, b)).not.toThrow()
  })

  test("throws on schemaVersion mismatch", () => {
    const a = envelope([])
    const b = { ...envelope([]), schemaVersion: 2 }
    expect(() => assertCensusCompatible(a, b)).toThrow(/census schema mismatch/)
  })

  test("throws on taxonomyVersion mismatch", () => {
    const a = envelope([])
    const b = { ...envelope([]), taxonomyVersion: 2 }
    expect(() => assertCensusCompatible(a, b)).toThrow(/taxonomy version mismatch/)
  })

  test("throws on upstreamBaseRef/upstreamBaseSha mismatch (finding #2 follow-up: refuse to ratchet across a rebased upstream base)", () => {
    const a = envelope([])
    const b = { ...envelope([]), upstreamBaseRef: "v1.18.0", upstreamBaseSha: "cafebabe" }
    expect(() => assertCensusCompatible(a, b)).toThrow(/upstream base mismatch/)
  })

  test("does not throw when upstreamBaseRef/upstreamBaseSha both match", () => {
    const a = envelope([])
    const b = envelope([])
    expect(a.upstreamBaseRef).toBe(b.upstreamBaseRef)
    expect(a.upstreamBaseSha).toBe(b.upstreamBaseSha)
    expect(() => assertCensusCompatible(a, b)).not.toThrow()
  })
})

describe("assembleCensus", () => {
  const provenance: CensusProvenance = {
    oursRef: "HEAD",
    oursSha: "sha-ours",
    oursTree: "tree-ours",
    upstreamBaseRef: "v1.17.9",
    upstreamBaseSha: "sha-upstream",
    upstreamBaseTree: "tree-upstream",
  }

  test("parses marker blocks across a synthetic file map and computes bucket totals", () => {
    const files = new Map<string, string>([
      ["packages/opencode/src/foo.ts", ["// altimate_change start — branding", "x", "// altimate_change end"].join("\n")],
      ["script/upstream/bar.ts", ["// altimate_change start — helper", "y", "// altimate_change end"].join("\n")],
    ])
    const env = assembleCensus(files, provenance, new Set(["packages/opencode/src/foo.ts"]))
    expect(env.totals.blocks).toBe(2)
    expect(env.totals.unclosed).toBe(0)
    expect(env.totals.byBucket.upstream_shared.blocks).toBe(1)
    expect(env.totals.byBucket.fork_owned.blocks).toBe(1)
    expect(env.upstreamBaseTree).toBe("tree-upstream")
  })

  test("throws on an unclosed marker not covered by the allowlist (finding #1)", () => {
    const files = new Map<string, string>([["packages/opencode/src/foo.ts", ["// altimate_change start — dangling", "x"].join("\n")]])
    expect(() => assembleCensus(files, provenance, new Set())).toThrow(/unclosed 'altimate_change start' marker/)
  })

  test("does not throw when the unclosed marker is covered by an allowlist entry", () => {
    const files = new Map<string, string>([["packages/opencode/src/foo.ts", ["// altimate_change start — dangling", "x"].join("\n")]])
    const env = assembleCensus(files, provenance, new Set(), {
      unclosedAllowlist: [{ file: "packages/opencode/src/foo.ts", startLine: 1, reason: "doc example", approvedBy: "tester" }],
    })
    expect(env.totals.unclosed).toBe(1)
    expect(env.blocks).toHaveLength(1)
    expect(env.blocks[0].endLine).toBeNull()
  })

  test("an allowlist entry does not suppress an unclosed marker at a different line in the same file", () => {
    const files = new Map<string, string>([
      ["packages/opencode/src/foo.ts", ["// altimate_change start — dangling one", "x", "// altimate_change start — dangling two", "y"].join("\n")],
    ])
    expect(() =>
      assembleCensus(files, provenance, new Set(), {
        unclosedAllowlist: [{ file: "packages/opencode/src/foo.ts", startLine: 1, reason: "doc example", approvedBy: "tester" }],
      }),
    ).toThrow(/unclosed 'altimate_change start' marker/)
  })

  test("an expired allowlist entry no longer suppresses the throw", () => {
    const files = new Map<string, string>([["packages/opencode/src/foo.ts", ["// altimate_change start — dangling", "x"].join("\n")]])
    expect(() =>
      assembleCensus(files, provenance, new Set(), {
        unclosedAllowlist: [
          { file: "packages/opencode/src/foo.ts", startLine: 1, reason: "doc example", approvedBy: "tester", expires: "2020-01-01" },
        ],
        now: new Date("2026-07-18"),
      }),
    ).toThrow(/unclosed 'altimate_change start' marker/)
  })

  test("generatedAt is injectable via opts", () => {
    const files = new Map<string, string>()
    const env = assembleCensus(files, provenance, new Set(), { generatedAt: "2026-01-01T00:00:00.000Z" })
    expect(env.generatedAt).toBe("2026-01-01T00:00:00.000Z")
  })

  test("blocks are sorted deterministically by file (byte order) then startLine", () => {
    const files = new Map<string, string>([
      ["script/upstream/z.ts", ["// altimate_change start — z", "x", "// altimate_change end"].join("\n")],
      ["script/upstream/a.ts", ["// altimate_change start — a", "x", "// altimate_change end"].join("\n")],
    ])
    const env = assembleCensus(files, provenance, new Set())
    expect(env.blocks.map((b) => b.file)).toEqual(["script/upstream/a.ts", "script/upstream/z.ts"])
  })
})

describe("parseNumstatZ", () => {
  test("parses a plain (non-rename) record", () => {
    const raw = "3\t1\tpackages/opencode/src/foo.ts\0"
    expect(parseNumstatZ(raw)).toEqual([{ added: 3, removed: 1, path: "packages/opencode/src/foo.ts" }])
  })

  test("parses multiple plain records", () => {
    // NOTE: "\0" immediately followed by a digit (e.g. "\010") is parsed by
    // JS as a legacy octal escape, not NUL + "10" — build the record with
    // explicit concatenation to avoid that ambiguous escape sequence.
    const raw = "3\t1\tpackages/opencode/src/foo.ts" + "\0" + "10\t0\tscript/upstream/bar.ts" + "\0"
    const records = parseNumstatZ(raw)
    expect(records).toHaveLength(2)
    expect(records[0]).toEqual({ added: 3, removed: 1, path: "packages/opencode/src/foo.ts" })
    expect(records[1]).toEqual({ added: 10, removed: 0, path: "script/upstream/bar.ts" })
  })

  test("parses a binary file record (added/removed are '-')", () => {
    const raw = "-\t-\tpackages/opencode/assets/logo.png\0"
    expect(parseNumstatZ(raw)).toEqual([{ added: null, removed: null, path: "packages/opencode/assets/logo.png" }])
  })

  test("parses a rename record (three NUL-delimited tokens: numbers+empty, oldPath, newPath)", () => {
    // git diff --numstat -M -z emits a rename as three tokens:
    //   "<added>\t<removed>\t"  (note: empty trailing path)
    //   "<oldPath>"
    //   "<newPath>"
    const raw = "5\t2\t\0script/upstream/old-name.ts\0script/upstream/new-name.ts\0"
    const records = parseNumstatZ(raw)
    expect(records).toHaveLength(1)
    expect(records[0]).toEqual({ added: 5, removed: 2, path: "script/upstream/new-name.ts", oldPath: "script/upstream/old-name.ts" })
  })

  test("parses a mix of plain and rename records in one stream", () => {
    const raw = ["1\t1\tpackages/opencode/src/foo.ts", "5\t2\t", "script/upstream/old.ts", "script/upstream/new.ts", "0\t3\tdocs/README.md"].join(
      "\0",
    ) + "\0"
    const records = parseNumstatZ(raw)
    expect(records).toHaveLength(3)
    expect(records[0].path).toBe("packages/opencode/src/foo.ts")
    expect(records[1]).toEqual({ added: 5, removed: 2, path: "script/upstream/new.ts", oldPath: "script/upstream/old.ts" })
    expect(records[2].path).toBe("docs/README.md")
  })

  test("throws on a malformed token with fewer than two tab separators", () => {
    expect(() => parseNumstatZ("not-a-valid-record\0")).toThrow(/malformed numstat token/)
  })

  test("throws on a truncated rename record missing its path tokens", () => {
    expect(() => parseNumstatZ("5\t2\t\0script/upstream/old-name.ts\0")).toThrow(/missing its old\/new path tokens/)
  })

  test("accepts a Buffer as well as a string", () => {
    const buf = Buffer.from("3\t1\tpackages/opencode/src/foo.ts\0", "utf-8")
    expect(parseNumstatZ(buf)).toEqual([{ added: 3, removed: 1, path: "packages/opencode/src/foo.ts" }])
  })
})

// ── computeDiffBudget (real fixture-repo, mkdtemp) ─────────────────────────
//
// computeDiffBudget shells out to `git diff --numstat -M -z` and resolves
// refs via resolveRefOrThrow, so — mirroring replay.test.ts's established
// pattern — it needs a real git repo rather than string fixtures.

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8" }).trim()
}

function writeFile(dir: string, relPath: string, content: string) {
  const full = path.join(dir, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

/** 20 near-identical lines so git's -M rename detector (default 50% similarity) fires reliably. */
function boilerplateLines(n = 20): string {
  return Array.from({ length: n }, (_, i) => `line ${i}`).join("\n") + "\n"
}

describe("computeDiffBudget", () => {
  test("classifies a renamed file by its upstream SOURCE path, not its destination path (finding #5)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "census-diffbudget-"))
    try {
      sh("git init -q -b main", dir)
      sh(`git config user.email "test@example.com"`, dir)
      sh(`git config user.name "Test"`, dir)

      // base: an upstream_shared file at its original upstream path.
      writeFile(dir, "packages/opencode/src/foo.ts", boilerplateLines())
      sh("git add -A", dir)
      sh("git commit -q -m base", dir)
      const baseSha = sh("git rev-parse HEAD", dir)

      // head: the SAME file renamed into a fork_owned root (script/upstream/**),
      // with one line changed so it's a rename, not an exact copy.
      fs.rmSync(path.join(dir, "packages/opencode/src/foo.ts"))
      writeFile(dir, "script/upstream/foo.ts", boilerplateLines().replace("line 0", "line 0 modified"))
      sh("git add -A", dir)
      sh("git commit -q -m rename", dir)
      const headSha = sh("git rev-parse HEAD", dir)

      // upstreamPaths mirrors what loadPathsAtRef would return for the
      // upstream base tree: only the ORIGINAL (pre-rename) path is known to
      // upstream. If the bug from finding #5 regressed (classifying by
      // rec.path, the destination), this file would misclassify as
      // fork_owned since script/upstream/** matches FORK_OWNED_ROOTS.
      const upstreamPaths = new Set(["packages/opencode/src/foo.ts"])

      const result = computeDiffBudget(dir, baseSha, headSha, upstreamPaths)

      expect(result.filesChanged).toBe(1)
      expect(result.upstreamSharedFilesChanged).toBe(1)
      expect(result.forkOwnedFilesChanged).toBe(0)
      expect(result.forkAddedOutsideBoundaryFilesChanged).toBe(0)
      expect(result.addedLinesInUpstreamShared).toBeGreaterThan(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("classifies non-renamed files into all three buckets and excludes test paths from the non-test line count", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "census-diffbudget-"))
    try {
      sh("git init -q -b main", dir)
      sh(`git config user.email "test@example.com"`, dir)
      sh(`git config user.name "Test"`, dir)

      writeFile(dir, "packages/opencode/src/shared.ts", "x\n")
      writeFile(dir, "packages/opencode/test/shared.test.ts", "x\n")
      writeFile(dir, "script/upstream/owned.ts", "x\n")
      writeFile(dir, "misplaced/stray.ts", "x\n")
      sh("git add -A", dir)
      sh("git commit -q -m base", dir)
      const baseSha = sh("git rev-parse HEAD", dir)

      fs.appendFileSync(path.join(dir, "packages/opencode/src/shared.ts"), "y\nz\n")
      fs.appendFileSync(path.join(dir, "packages/opencode/test/shared.test.ts"), "y\n")
      fs.appendFileSync(path.join(dir, "script/upstream/owned.ts"), "y\n")
      fs.appendFileSync(path.join(dir, "misplaced/stray.ts"), "y\n")
      sh("git add -A", dir)
      sh("git commit -q -m changes", dir)
      const headSha = sh("git rev-parse HEAD", dir)

      const upstreamPaths = new Set(["packages/opencode/src/shared.ts", "packages/opencode/test/shared.test.ts"])
      const result = computeDiffBudget(dir, baseSha, headSha, upstreamPaths)

      expect(result.filesChanged).toBe(4)
      expect(result.upstreamSharedFilesChanged).toBe(2) // shared.ts + shared.test.ts
      expect(result.forkOwnedFilesChanged).toBe(1) // script/upstream/owned.ts
      expect(result.forkAddedOutsideBoundaryFilesChanged).toBe(1) // misplaced/stray.ts

      // 2 added lines in shared.ts + 1 in shared.test.ts = 3 total upstream_shared lines,
      // but only shared.ts's 2 lines count toward the non-test subtotal.
      expect(result.addedLinesInUpstreamShared).toBe(3)
      expect(result.addedLinesInUpstreamSharedNonTest).toBe(2)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("base/head fields resolve to the full commit SHAs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "census-diffbudget-"))
    try {
      sh("git init -q -b main", dir)
      sh(`git config user.email "test@example.com"`, dir)
      sh(`git config user.name "Test"`, dir)
      writeFile(dir, "a.txt", "1\n")
      sh("git add -A", dir)
      sh("git commit -q -m one", dir)
      const baseSha = sh("git rev-parse HEAD", dir)
      writeFile(dir, "a.txt", "1\n2\n")
      sh("git add -A", dir)
      sh("git commit -q -m two", dir)
      const headSha = sh("git rev-parse HEAD", dir)

      const result = computeDiffBudget(dir, baseSha, "HEAD", new Set<string>())
      expect(result.base).toBe(baseSha)
      expect(result.head).toBe(headSha)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
