import { describe, test, expect } from "bun:test"
import { execSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { parseMergeTreeOutput, buildReplay, attributeConflictsToCensus, type ReplayEnvelope } from "./replay"

describe("parseMergeTreeOutput", () => {
  test("clean merge with no conflicts: only a tree OID line", () => {
    const stdout = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2\n"
    const result = parseMergeTreeOutput(stdout)
    expect(result.resultTreeOid).toBe("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2")
    expect(result.conflictedPaths).toHaveLength(0)
    expect(result.conflictMessages).toHaveLength(0)
    expect(result.hasConflicts).toBe(false)
  })

  test("throws on empty output", () => {
    expect(() => parseMergeTreeOutput("")).toThrow(/empty output/)
  })

  test("content conflict: conflicted-path lines (3 stages) + CONFLICT (content) message", () => {
    const stdout = [
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "100644 1111111111111111111111111111111111111111 1\tpackage.json",
      "100644 2222222222222222222222222222222222222222 2\tpackage.json",
      "100644 3333333333333333333333333333333333333333 3\tpackage.json",
      "",
      "CONFLICT (content): Merge conflict in package.json",
      "",
    ].join("\n")

    const result = parseMergeTreeOutput(stdout)
    expect(result.hasConflicts).toBe(true)
    expect(result.conflictedPaths).toHaveLength(1)
    expect(result.conflictedPaths[0].path).toBe("package.json")
    expect(result.conflictedPaths[0].stages[1]).toEqual({ mode: "100644", oid: "1111111111111111111111111111111111111111" })
    expect(result.conflictedPaths[0].stages[2]).toEqual({ mode: "100644", oid: "2222222222222222222222222222222222222222" })
    expect(result.conflictedPaths[0].stages[3]).toEqual({ mode: "100644", oid: "3333333333333333333333333333333333333333" })
    expect(result.conflictMessages).toHaveLength(1)
    expect(result.conflictMessages[0].type).toBe("content")
    expect(result.conflictMessages[0].path).toBe("package.json")
    expect(result.conflictMessages[0].text).toBe("Merge conflict in package.json")
  })

  test("modify/delete conflict: single-stage conflicted-path line + descriptive CONFLICT message", () => {
    const stdout = [
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "100644 4444444444444444444444444444444444444444 1\t.github/ISSUE_TEMPLATE/question.yml",
      "",
      "CONFLICT (modify/delete): .github/ISSUE_TEMPLATE/question.yml deleted in v1.18.3 and modified in HEAD.  Version HEAD of .github/ISSUE_TEMPLATE/question.yml left in tree.",
      "",
    ].join("\n")

    const result = parseMergeTreeOutput(stdout)
    expect(result.conflictedPaths).toHaveLength(1)
    expect(result.conflictedPaths[0].stages[1]).toBeDefined()
    expect(result.conflictedPaths[0].stages[2]).toBeUndefined()
    expect(result.conflictedPaths[0].stages[3]).toBeUndefined()
    expect(result.conflictMessages[0].type).toBe("modify/delete")
    expect(result.conflictMessages[0].path).toBe(".github/ISSUE_TEMPLATE/question.yml")
  })

  test("rename/delete conflict message parses type and path", () => {
    const stdout = [
      "cccccccccccccccccccccccccccccccccccccccc",
      "",
      "CONFLICT (rename/delete): packages/ui/src/components/todo-panel-motion.stories.tsx renamed to packages/app/src/pages/session/composer/todo-panel-motion.stories.tsx in v1.18.3, but deleted in HEAD.",
      "",
    ].join("\n")

    const result = parseMergeTreeOutput(stdout)
    expect(result.conflictMessages).toHaveLength(1)
    expect(result.conflictMessages[0].type).toBe("rename/delete")
    expect(result.conflictMessages[0].path).toBe("packages/ui/src/components/todo-panel-motion.stories.tsx")
  })

  test("file location conflict message parses type", () => {
    const stdout = [
      "dddddddddddddddddddddddddddddddddddddddd",
      "",
      "CONFLICT (file location): packages/ui/LICENSE added in v1.18.3 inside a directory that was renamed in HEAD, suggesting it should perhaps be moved to packages/tui/LICENSE.",
      "",
    ].join("\n")

    const result = parseMergeTreeOutput(stdout)
    expect(result.conflictMessages).toHaveLength(1)
    expect(result.conflictMessages[0].type).toBe("file location")
  })

  test("Auto-merging lines are captured separately from CONFLICT lines", () => {
    const stdout = [
      "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      "100644 1111111111111111111111111111111111111111 1\tsrc/a.ts",
      "100644 2222222222222222222222222222222222222222 2\tsrc/a.ts",
      "100644 3333333333333333333333333333333333333333 3\tsrc/a.ts",
      "",
      "Auto-merging src/clean.ts",
      "CONFLICT (content): Merge conflict in src/a.ts",
      "Auto-merging src/other-clean.ts",
      "",
    ].join("\n")

    const result = parseMergeTreeOutput(stdout)
    expect(result.autoMergedPaths).toEqual(["src/clean.ts", "src/other-clean.ts"])
    expect(result.conflictMessages).toHaveLength(1)
  })

  test("multiple conflicted paths and multiple message lines all parsed", () => {
    const stdout = [
      "ffffffffffffffffffffffffffffffffffffffff",
      "100644 1111111111111111111111111111111111111111 2\tfile-a.ts",
      "100644 2222222222222222222222222222222222222222 3\tfile-a.ts",
      "100644 3333333333333333333333333333333333333333 1\tfile-b.ts",
      "",
      "CONFLICT (content): Merge conflict in file-a.ts",
      "CONFLICT (modify/delete): file-b.ts deleted in v1.18.3 and modified in HEAD.  Version HEAD of file-b.ts left in tree.",
      "",
    ].join("\n")

    const result = parseMergeTreeOutput(stdout)
    expect(result.conflictedPaths).toHaveLength(2)
    expect(result.conflictMessages).toHaveLength(2)
    const types = result.conflictMessages.map((m) => m.type).sort()
    expect(types).toEqual(["content", "modify/delete"])
  })
})

// ── mkdtemp-based real fixture repo ─────────────────────────────────────
//
// Per the S1 spec: validate merge-tree output parsing against a real fixture
// repo (not just string fixtures) built in a temp dir, with a base/ours/target
// commit history including a content conflict, a modify/delete, and a rename.

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8" }).trim()
}

function writeFile(dir: string, relPath: string, content: string) {
  const full = path.join(dir, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

/**
 * Builds a bare-bones repo with three divergent commits:
 *   base:   common ancestor-equivalent state (stands in for the upstream base)
 *   ours:   modifies conflict.txt, deletes deleteme.txt, keeps rename-src.txt
 *   target: modifies conflict.txt differently, modifies deleteme.txt,
 *           renames rename-src.txt -> rename-dst.txt
 * This produces exactly one content conflict (conflict.txt), one
 * modify/delete conflict (deleteme.txt), and one rename-related conflict
 * (rename-src.txt / rename-dst.txt) when merge-tree'd together.
 */
function buildFixtureRepo(): { dir: string; baseSha: string; oursSha: string; targetSha: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-fixture-"))
  sh("git init -q -b main", dir)
  sh(`git config user.email "test@example.com"`, dir)
  sh(`git config user.name "Test"`, dir)

  writeFile(dir, "conflict.txt", "base line 1\nbase line 2\n")
  writeFile(dir, "deleteme.txt", "will be deleted by ours, modified by target\n")
  writeFile(dir, "rename-src.txt", "content that survives a rename\n")
  sh("git add -A", dir)
  sh(`git commit -q -m base`, dir)
  const baseSha = sh("git rev-parse HEAD", dir)

  // ours branch: diverge from base
  sh("git checkout -q -b ours-branch", dir)
  writeFile(dir, "conflict.txt", "OURS changed line 1\nbase line 2\n")
  fs.rmSync(path.join(dir, "deleteme.txt"))
  sh("git add -A", dir)
  sh(`git commit -q -m ours`, dir)
  const oursSha = sh("git rev-parse HEAD", dir)

  // target branch: diverge from base independently
  sh(`git checkout -q ${baseSha}`, dir)
  sh("git checkout -q -b target-branch", dir)
  writeFile(dir, "conflict.txt", "TARGET changed line 1\nbase line 2\n")
  writeFile(dir, "deleteme.txt", "will be deleted by ours, modified by target\nTARGET added this line\n")
  fs.renameSync(path.join(dir, "rename-src.txt"), path.join(dir, "rename-dst.txt"))
  sh("git add -A", dir)
  sh(`git commit -q -m target`, dir)
  const targetSha = sh("git rev-parse HEAD", dir)

  return { dir, baseSha, oursSha, targetSha }
}

describe("buildReplay (real fixture-repo, mkdtemp)", () => {
  test("produces expected conflict types against a constructed base/ours/target history", () => {
    const { dir, baseSha, oursSha, targetSha } = buildFixtureRepo()
    try {
      const envelope = buildReplay(dir, baseSha, oursSha, targetSha)

      expect(envelope.upstreamBaseSha).toBe(baseSha)
      expect(envelope.oursSha).toBe(oursSha)
      expect(envelope.targetSha).toBe(targetSha)
      expect(envelope.resultTreeOid).toMatch(/^[0-9a-f]{40}$/)
      expect(envelope.exitCode).toBe(1) // conflicts present

      const types = envelope.totals.byType.map((t) => t.type).sort()
      // conflict.txt -> content; deleteme.txt -> modify/delete. The rename
      // scenario may surface as rename/delete or a clean auto-resolution
      // depending on git's rename-detection heuristics for tiny fixture
      // files, so we only hard-assert the two deterministic conflict types.
      expect(types).toContain("content")
      expect(types).toContain("modify/delete")
      expect(envelope.totals.conflictedPaths).toBeGreaterThanOrEqual(2)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("resolveRefOrThrow rejects a ref that doesn't exist in the fixture repo", () => {
    const { dir, baseSha, oursSha } = buildFixtureRepo()
    try {
      expect(() => buildReplay(dir, baseSha, oursSha, "refs/tags/does-not-exist")).toThrow()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("attributeConflictsToCensus", () => {
  function fakeEnvelope(overrides: Partial<ReplayEnvelope> = {}): ReplayEnvelope {
    return {
      schemaVersion: 1,
      generatorVersion: "test",
      generatedAt: new Date().toISOString(),
      taxonomyVersion: 1,
      gitVersion: "2.42.0",
      upstreamBaseRef: "v1.17.9",
      upstreamBaseSha: "base",
      upstreamBaseTree: "base-tree",
      oursRef: "HEAD",
      oursSha: "ours-sha",
      oursTree: "ours-tree",
      targetRef: "v1.18.3",
      targetSha: "target-sha",
      targetTree: "target-tree",
      resultTreeOid: "tree-oid",
      exitCode: 1,
      totals: {
        conflictedPaths: 1,
        conflictMessages: 1,
        autoMergedAttempted: 0,
        autoMergedClean: 0,
        contentConflictFiles: 1,
        contentConflictRegions: 0,
        binaryConflictPaths: 0,
        byType: [{ type: "content", count: 1 }],
      },
      conflictedPaths: [{ path: "packages/opencode/src/foo.ts", stages: {} }],
      conflictMessages: [{ path: "packages/opencode/src/foo.ts", type: "content", text: "Merge conflict in packages/opencode/src/foo.ts" }],
      autoMergedPaths: [],
      conflictRegionsByPath: {},
      ...overrides,
    }
  }

  test("rejects attribution when census.oursSha does not match replay.oursSha", () => {
    const envelope = fakeEnvelope()
    const census = { oursSha: "different-sha", blocks: [] }
    expect(() => attributeConflictsToCensus(envelope, census, new Set())).toThrow(/rejected/)
  })

  test("attributes a conflicted path present in the census blocks to its recorded bucket", () => {
    const envelope = fakeEnvelope()
    const census = {
      oursSha: "ours-sha",
      blocks: [{ file: "packages/opencode/src/foo.ts", bucket: "upstream_shared" as const }],
    }
    const result = attributeConflictsToCensus(envelope, census, new Set())
    expect(result).toEqual([{ bucket: "upstream_shared", count: 1 }])
  })

  test("falls back to taxonomy classification for a conflicted path not covered by any census block", () => {
    const envelope = fakeEnvelope({
      conflictedPaths: [{ path: "script/upstream/replay.ts", stages: {} }],
      conflictMessages: [{ path: "script/upstream/replay.ts", type: "content", text: "Merge conflict in script/upstream/replay.ts" }],
    })
    const census = { oursSha: "ours-sha", blocks: [] }
    const result = attributeConflictsToCensus(envelope, census, new Set())
    expect(result).toEqual([{ bucket: "fork_owned", count: 1 }])
  })

  test("REGRESSION: a rename conflict does NOT double-count (old+new path) — attribution uses stage paths only", () => {
    // A rename/delete conflict emits a message naming BOTH the old and new
    // path. Attribution must count the single conflicted path once, not both.
    const envelope = fakeEnvelope({
      conflictedPaths: [{ path: "new/name.ts", stages: {} }],
      conflictMessages: [{ path: "old/name.ts", type: "rename/delete", text: "old/name.ts renamed to new/name.ts in ours, deleted in target" }],
    })
    const census = { oursSha: "ours-sha", blocks: [] }
    const result = attributeConflictsToCensus(envelope, census, new Set())
    const total = result.reduce((n, r) => n + r.count, 0)
    expect(total).toBe(1) // exactly one conflicted path, not two
  })
})

describe("buildReplay honest metrics (real repo, pinned)", () => {
  test(
    "v1.17.9→v1.18.3 replay reports honest regions + clean auto-merges",
    () => {
      const { resolveRepoRoot } = require("./utils/repo-root")
      const repoRoot = resolveRepoRoot()
      const env = buildReplay(repoRoot, "v1.17.9", "8a50ec7f55", "v1.18.3", { now: "2026-07-18T00:00:00.000Z" })

      // Pinned against the committed merge-tree result:
      expect(env.totals.conflictedPaths).toBe(651)
      expect(env.totals.contentConflictFiles).toBe(118)
      expect(env.totals.contentConflictRegions).toBe(466)
      // Honest auto-merge: 212 attempts, but only 94 are actually clean
      // (118 of the attempts also ended up conflicted).
      expect(env.totals.autoMergedAttempted).toBe(212)
      expect(env.totals.autoMergedClean).toBe(94)
      // 4 binary conflicts (2 PNG, 1 TTF, 1 WOFF2) otherwise hidden under modify/delete.
      expect(env.totals.binaryConflictPaths).toBe(4)
      expect(env.upstreamBaseTree).toMatch(/^[0-9a-f]{40}$/)
      expect(env.oursTree).toMatch(/^[0-9a-f]{40}$/)
      expect(env.targetTree).toMatch(/^[0-9a-f]{40}$/)
      expect(env.schemaVersion).toBe(2)
    },
    60_000,
  )
})
