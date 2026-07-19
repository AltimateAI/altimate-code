#!/usr/bin/env bun
/**
 * Merge replay: simulate merging an upstream release tag (`--target`, e.g.
 * v1.18.3) into `ours` (default HEAD), relative to the upstream base ref
 * (default v1.17.9) the fork last synced against — WITHOUT touching the
 * working tree, the index, or creating any branch/worktree/commit.
 *
 * Because the fork's history was rewritten, there is no merge-base between
 * `ours` and any upstream tag reachable via normal history. We therefore
 * never run `git merge`; instead we drive `git merge-tree --write-tree
 * --merge-base <upstream-base> <ours> <target>`, which computes a merge
 * purely against the object database using an EXPLICIT third-party merge
 * base (the upstream ref itself stands in for the "as if" common ancestor).
 * This is read-only: it writes a tree object but moves no refs and touches
 * no working-tree files.
 *
 * Output format of `git merge-tree --write-tree --merge-base <base> <a> <b>`
 * (git >= 2.38, pinned/verified against 2.42.0 — see MIN_GIT_VERSION below):
 *   line 1:            result tree OID
 *   0+ lines:           "<mode> <oid> <stage>\t<path>" for each conflicted path
 *                        (stage 1=base, 2=ours/<a>, 3=target/<b>; a stage is
 *                        omitted on that side deleted the file)
 *   blank line
 *   0+ lines:           "Auto-merging <path>" / "CONFLICT (<type>): <text>"
 * Exit code 0 = clean merge, 1 = conflicts present (still valid output).
 *
 * Usage:
 *   bun run replay.ts --target v1.18.3                       # human summary
 *   bun run replay.ts --target v1.18.3 --json
 *   bun run replay.ts --upstream-base v1.17.9 --ours HEAD --target v1.18.3
 *   bun run replay.ts --target v1.18.3 --census baselines/2026-07-18/census.json
 */
import { spawnSync } from "child_process"
import fs from "fs"
import { resolveRepoRoot } from "./utils/repo-root"
import { resolveRefOrThrow, gitVersion, compareVersions } from "./utils/refs"
import { classifyBucket, TAXONOMY_VERSION, type Bucket } from "./taxonomy"
import * as log from "./utils/logger"

export const GENERATOR_VERSION = "replay.ts@2"
export const SCHEMA_VERSION = 2

// `git merge-tree --write-tree --merge-base` (the explicit-base object-db-only
// merge this tool depends on) requires git 2.40.0: `--write-tree` landed in
// 2.38 but the `--merge-base` option we pass was added in 2.40. Anything older
// either lacks the flag or has a materially different output format.
export const MIN_GIT_VERSION: [number, number, number] = [2, 40, 0]

export type ConflictStage = 1 | 2 | 3

export interface ConflictedPathEntry {
  path: string
  stages: Partial<Record<ConflictStage, { mode: string; oid: string }>>
}

export interface ConflictMessage {
  path: string | null
  type: string | null // e.g. "modify/delete", "content", "rename/delete", "file location"; null for non-CONFLICT lines we still capture (none currently)
  text: string
}

export interface MergeTreeResult {
  resultTreeOid: string
  conflictedPaths: ConflictedPathEntry[]
  autoMergedPaths: string[]
  conflictMessages: ConflictMessage[]
  hasConflicts: boolean
}

// ── Pure output parser (string-fixture-testable) ────────────────────────────

const CONFLICT_PATH_LINE_RE = /^([0-7]{6}) ([0-9a-f]{4,64}) ([123])\t(.+)$/
const AUTO_MERGING_RE = /^Auto-merging (.+)$/
const CONFLICT_RE = /^CONFLICT \(([^)]+)\): (.*)$/

/**
 * Parse the stdout of `git merge-tree --write-tree --merge-base <base> <a> <b>`.
 * Pure function of the text — no git/filesystem I/O — directly testable
 * against small string fixtures and the mkdtemp-based real-repo fixture.
 */
export function parseMergeTreeOutput(stdout: string): MergeTreeResult {
  const lines = stdout.split("\n")
  if (lines.length === 0 || lines[0].trim() === "") {
    throw new Error("parseMergeTreeOutput: empty output — expected a result tree OID on line 1")
  }
  const resultTreeOid = lines[0].trim()

  const conflictedByPath = new Map<string, ConflictedPathEntry>()
  const autoMergedPaths: string[] = []
  const conflictMessages: ConflictMessage[] = []

  let i = 1
  // Section 1: conflicted-path lines, until the first blank line (or the
  // first line that doesn't match the path-line shape, defensively).
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line === "") {
      i++ // consume the separator blank line
      break
    }
    const m = line.match(CONFLICT_PATH_LINE_RE)
    if (!m) {
      // Not a path line and not blank — treat the blank-separator as absent
      // (e.g. a clean merge with no conflicted paths at all) and fall through
      // to message parsing from this line onward.
      break
    }
    const [, mode, oid, stageStr, path] = m
    const stage = Number(stageStr) as ConflictStage
    let entry = conflictedByPath.get(path)
    if (!entry) {
      entry = { path, stages: {} }
      conflictedByPath.set(path, entry)
    }
    entry.stages[stage] = { mode, oid }
  }

  // Section 2: message lines (Auto-merging / CONFLICT), to end of output.
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === "") continue
    const autoMatch = line.match(AUTO_MERGING_RE)
    if (autoMatch) {
      autoMergedPaths.push(autoMatch[1])
      continue
    }
    const conflictMatch = line.match(CONFLICT_RE)
    if (conflictMatch) {
      const [, type, text] = conflictMatch
      // Best-effort path extraction, purely for convenience (e.g. census
      // attribution) — the (type, text) pair remains the authoritative,
      // unmodified signal per the binding instruction to never reimplement
      // git's own classification. Two observed message shapes:
      //   "content":   "Merge conflict in <path>"      (path is the tail)
      //   all others:  "<path> <rest of descriptive prose>" (path is the head)
      const path = type === "content" ? (text.match(/^Merge conflict in (.+)$/)?.[1] ?? null) : (text.match(/^(\S+)/)?.[1] ?? null)
      conflictMessages.push({ path, type, text })
      continue
    }
    // Unrecognized line (e.g. future git message formats) — capture verbatim
    // rather than silently dropping it.
    conflictMessages.push({ path: null, type: null, text: line })
  }

  const conflictedPaths = [...conflictedByPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  return {
    resultTreeOid,
    conflictedPaths,
    autoMergedPaths,
    conflictMessages,
    hasConflicts: conflictedPaths.length > 0 || conflictMessages.some((m) => m.type !== null),
  }
}

// ── git invocation ──────────────────────────────────────────────────────

function assertGitSupportsWriteTree(repoRoot: string): void {
  const version = gitVersion(repoRoot)
  if (compareVersions(version, MIN_GIT_VERSION) < 0) {
    throw new Error(
      `git ${version.join(".")} does not support 'merge-tree --write-tree' (requires >= ${MIN_GIT_VERSION.join(".")}). ` +
        `Upgrade git and re-run; replay.ts refuses to guess at an older, incompatible output format.`,
    )
  }
}

/**
 * Run `git merge-tree --write-tree --merge-base <base> <ours> <target>` via
 * spawnSync (not execSync): exit code 1 means "conflicts present," which is
 * a normal, expected outcome we need stdout for — execSync would throw and
 * discard stdout on a non-zero exit.
 */
function runMergeTree(repoRoot: string, baseSha: string, oursSha: string, targetSha: string): { stdout: string; exitCode: number } {
  const result = spawnSync("git", ["merge-tree", "--write-tree", "--merge-base", baseSha, oursSha, targetSha], {
    cwd: repoRoot,
    encoding: "utf-8",
    maxBuffer: 200 * 1024 * 1024,
    // Pin locale so CONFLICT/Auto-merging message text (which we parse) is
    // stable across environments.
    env: { ...process.env, LC_ALL: "C" },
  })
  if (result.error) {
    throw new Error(`Failed to spawn 'git merge-tree': ${result.error.message}`)
  }
  if (result.status === null) {
    throw new Error(`'git merge-tree' terminated by signal ${result.signal ?? "unknown"} (stderr: ${result.stderr})`)
  }
  // Any exit code other than 0 (clean) or 1 (conflicts) is a real failure
  // (bad refs, git internal error, etc.) — surface stderr, don't swallow it.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`'git merge-tree' exited ${result.status} unexpectedly.\nstderr:\n${result.stderr}`)
  }
  return { stdout: result.stdout, exitCode: result.status }
}

export interface ConflictTypeCount {
  type: string
  count: number
}

/**
 * Count textual conflict regions (each `<<<<<<<` … `=======` … `>>>>>>>`
 * block is one region) inside the merged blobs of content-conflicted paths,
 * read from the result tree via `git cat-file`. This is a finer measure of
 * manual-merge effort than the path/message counts: one file can carry many
 * regions. Structural conflicts (modify/delete, rename/delete, …) leave no
 * `<<<<<<<` markers and are correctly counted as zero regions here — they're
 * captured by the path/type totals instead.
 */
export function countConflictRegions(
  repoRoot: string,
  resultTreeOid: string,
  contentConflictPaths: string[],
): { byPath: Record<string, number>; total: number } {
  const byPath: Record<string, number> = {}
  let total = 0
  const CONFLICT_START_RE = /^<<<<<<< /
  for (const path of contentConflictPaths) {
    const res = spawnSync("git", ["cat-file", "-p", `${resultTreeOid}:${path}`], {
      cwd: repoRoot,
      encoding: "utf-8",
      maxBuffer: 100 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C" },
    })
    if (res.error) {
      throw new Error(`countConflictRegions: failed to spawn git cat-file for ${resultTreeOid}:${path}: ${res.error.message}`)
    }
    if (res.status !== 0 || typeof res.stdout !== "string") {
      // These paths are content-conflicted, so the merged blob MUST exist in
      // the result tree. A read failure here is a real error (bad path
      // quoting, corruption, oversized blob) — fail closed, never report an
      // honest-looking zero.
      throw new Error(
        `countConflictRegions: expected content-conflict blob ${resultTreeOid}:${path} to be readable but git cat-file exited ` +
          `${res.status} (stderr: ${res.stderr ?? ""}). Refusing to under-count conflict regions.`,
      )
    }
    let n = 0
    for (const line of res.stdout.split("\n")) if (CONFLICT_START_RE.test(line)) n++
    byPath[path] = n
    total += n
  }
  return { byPath, total }
}

export interface ConflictCategoryAttribution {
  bucket: Bucket
  count: number
}

export interface ReplayEnvelope {
  schemaVersion: number
  generatorVersion: string
  generatedAt: string
  taxonomyVersion: number
  gitVersion: string
  upstreamBaseRef: string
  upstreamBaseSha: string
  upstreamBaseTree: string
  oursRef: string
  oursSha: string
  oursTree: string
  targetRef: string
  targetSha: string
  targetTree: string
  resultTreeOid: string
  exitCode: number
  totals: {
    conflictedPaths: number
    conflictMessages: number
    /** `Auto-merging <p>` lines git emitted — an ATTEMPT, not proof of a clean result. */
    autoMergedAttempted: number
    /** Auto-merge attempts on paths that did NOT also end up conflicted — the honest "clean" count. */
    autoMergedClean: number
    /** Files with at least one textual (content) conflict. */
    contentConflictFiles: number
    /** Total `<<<<<<<` conflict regions across all content-conflicted files. */
    contentConflictRegions: number
    /** Conflicted paths whose merged/stage blob is binary (would otherwise hide under modify/delete etc). */
    binaryConflictPaths: number
    byType: ConflictTypeCount[]
  }
  /** Present only when --census was supplied and its oursSha matched. */
  byBucket?: ConflictCategoryAttribution[]
  conflictedPaths: ConflictedPathEntry[]
  conflictMessages: ConflictMessage[]
  autoMergedPaths: string[]
  /** Per-file textual conflict-region counts (content conflicts only). */
  conflictRegionsByPath: Record<string, number>
}

export function buildReplay(
  repoRoot: string,
  upstreamBaseRef: string,
  oursRef: string,
  targetRef: string,
  opts: { now?: string } = {},
): ReplayEnvelope {
  assertGitSupportsWriteTree(repoRoot)

  const upstreamBase = resolveRefOrThrow(upstreamBaseRef, repoRoot)
  const ours = resolveRefOrThrow(oursRef, repoRoot)
  const target = resolveRefOrThrow(targetRef, repoRoot)

  const { stdout, exitCode } = runMergeTree(repoRoot, upstreamBase.sha, ours.sha, target.sha)
  const parsed = parseMergeTreeOutput(stdout)

  const typeCounts = new Map<string, number>()
  for (const m of parsed.conflictMessages) {
    if (m.type === null) continue
    typeCounts.set(m.type, (typeCounts.get(m.type) ?? 0) + 1)
  }
  const byType = [...typeCounts.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count)

  // Honest auto-merge count: git prints "Auto-merging <p>" when it ATTEMPTS a
  // three-way content merge on <p>; that same <p> can still end up conflicted.
  // The truly-clean set is the attempts that are NOT in the conflicted set.
  const conflictedPathSet = new Set(parsed.conflictedPaths.map((p) => p.path))
  const autoMergedClean = parsed.autoMergedPaths.filter((p) => !conflictedPathSet.has(p))

  // Textual conflict regions: read the merged blobs of content-conflicted
  // paths from the result tree and count `<<<<<<<` markers.
  const contentConflictPaths = parsed.conflictMessages
    .filter((m) => m.type === "content" && m.path)
    .map((m) => m.path as string)
  const regions = countConflictRegions(repoRoot, parsed.resultTreeOid, contentConflictPaths)

  // Binary conflicts otherwise hide under modify/delete / file location. Flag a
  // conflicted path as binary if ANY of its stage blobs is binary (NUL byte in
  // the first 8KB — git's own heuristic).
  const binaryConflictPaths = countBinaryConflictPaths(repoRoot, parsed.conflictedPaths)

  const versionParts = gitVersion(repoRoot)

  return {
    schemaVersion: SCHEMA_VERSION,
    generatorVersion: GENERATOR_VERSION,
    generatedAt: opts.now ?? new Date().toISOString(),
    taxonomyVersion: TAXONOMY_VERSION,
    gitVersion: versionParts.join("."),
    upstreamBaseRef,
    upstreamBaseSha: upstreamBase.sha,
    upstreamBaseTree: upstreamBase.tree,
    oursRef,
    oursSha: ours.sha,
    oursTree: ours.tree,
    targetRef,
    targetSha: target.sha,
    targetTree: target.tree,
    resultTreeOid: parsed.resultTreeOid,
    exitCode,
    totals: {
      conflictedPaths: parsed.conflictedPaths.length,
      conflictMessages: parsed.conflictMessages.length,
      autoMergedAttempted: parsed.autoMergedPaths.length,
      autoMergedClean: autoMergedClean.length,
      contentConflictFiles: contentConflictPaths.length,
      contentConflictRegions: regions.total,
      binaryConflictPaths,
      byType,
    },
    conflictedPaths: parsed.conflictedPaths,
    conflictMessages: parsed.conflictMessages,
    autoMergedPaths: parsed.autoMergedPaths,
    conflictRegionsByPath: regions.byPath,
  }
}

/**
 * Count conflicted paths that are binary. A path is binary if any of its stage
 * blobs (base/ours/target) has a NUL byte in its first 8 KiB — git's own
 * text/binary heuristic. Uses a single `git cat-file --batch` over all stage
 * OIDs (raw bytes, not UTF-8) so a multi-hundred-path merge stays fast.
 */
export function countBinaryConflictPaths(repoRoot: string, conflictedPaths: ConflictedPathEntry[]): number {
  const SNIFF = 8192
  // Map each unique stage oid we care about; then one batch read.
  const oids: string[] = []
  const seen = new Set<string>()
  for (const entry of conflictedPaths) {
    for (const stage of [1, 2, 3] as ConflictStage[]) {
      const st = entry.stages[stage]
      if (st && !seen.has(st.oid)) {
        seen.add(st.oid)
        oids.push(st.oid)
      }
    }
  }
  if (oids.length === 0) return 0

  const res = spawnSync("git", ["cat-file", "--batch"], {
    cwd: repoRoot,
    input: oids.join("\n") + "\n",
    maxBuffer: 500 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  })
  if (res.error) throw new Error(`countBinaryConflictPaths: failed to spawn git cat-file --batch: ${res.error.message}`)
  if (res.status !== 0) throw new Error(`countBinaryConflictPaths: git cat-file --batch exited ${res.status}: ${res.stderr}`)

  const buf: Buffer = res.stdout
  const binaryOids = new Set<string>()
  let offset = 0
  const NL = 0x0a
  for (const oid of oids) {
    const nl = buf.indexOf(NL, offset)
    if (nl === -1) throw new Error(`countBinaryConflictPaths: truncated cat-file output reading header for ${oid}`)
    const header = buf.slice(offset, nl).toString("utf-8")
    offset = nl + 1
    const m = header.match(/^([0-9a-f]+) (\S+) (\d+)$/)
    if (!m) throw new Error(`countBinaryConflictPaths: bad cat-file header '${header}' for ${oid}`)
    const size = Number(m[3])
    const sniff = buf.slice(offset, offset + Math.min(size, SNIFF))
    if (sniff.includes(0x00)) binaryOids.add(oid)
    offset += size + 1 // trailing newline
  }

  let count = 0
  for (const entry of conflictedPaths) {
    const isBinary = ([1, 2, 3] as ConflictStage[]).some((s) => {
      const st = entry.stages[s]
      return st ? binaryOids.has(st.oid) : false
    })
    if (isBinary) count++
  }
  return count
}

// ── optional census attribution mode ────────────────────────────────────

interface CensusLike {
  oursSha: string
  blocks: { file: string; bucket: Bucket }[]
}

/**
 * Attribute each conflicted path to a taxonomy bucket using a previously
 * generated census envelope, so a reviewer can see "N conflicts touch
 * upstream_shared files with active fork customizations" vs. plain
 * unattributed upstream churn.
 *
 * Binding requirement: REJECT (throw) if the census's oursSha doesn't match
 * the replay's resolved ours — an attribution against a stale census is
 * worse than no attribution at all (silently wrong bucket counts).
 */
export function attributeConflictsToCensus(envelope: ReplayEnvelope, census: CensusLike, upstreamPaths: ReadonlySet<string>): ConflictCategoryAttribution[] {
  if (census.oursSha !== envelope.oursSha) {
    throw new Error(
      `Census attribution rejected: census.oursSha=${census.oursSha} does not match replay oursSha=${envelope.oursSha}. ` +
        `Regenerate the census at the same 'ours' ref before attributing conflicts to it (a stale census produces silently wrong bucket counts).`,
    )
  }
  // file → bucket, built once (O(1) lookup below instead of an O(n) .find()
  // per conflicted path). A file's blocks all share one bucket, so first wins.
  const bucketByFile = new Map<string, Bucket>()
  for (const b of census.blocks) if (!bucketByFile.has(b.file)) bucketByFile.set(b.file, b.bucket)
  const counts = new Map<Bucket, number>()
  // Authoritative conflicted-path set = the stage-line paths (one entry per
  // conflicted path). Do NOT union in conflictMessage paths: a rename message
  // names BOTH the old and new path, which double-counts (that was the
  // 750-vs-651 discrepancy). The stage lines are the ground truth for "which
  // paths conflicted."
  const conflictedFilePaths = new Set(envelope.conflictedPaths.map((p) => p.path))
  for (const path of conflictedFilePaths) {
    // A conflicted path only gets attributed if it's a file the census
    // actually scanned marker blocks in; otherwise fall back to plain
    // taxonomy classification against the upstream tree.
    const bucket = bucketByFile.get(path) ?? classifyBucket(path, upstreamPaths)
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
  }
  return [...counts.entries()].map(([bucket, count]) => ({ bucket, count })).sort((a, b) => b.count - a.count)
}

// ── CLI ──────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const flag = (name: string) => argv.includes(name)
  const opt = (name: string, def?: string) => {
    const idx = argv.indexOf(name)
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : def
  }
  return { flag, opt }
}

async function main() {
  const argv = process.argv.slice(2)
  const { flag, opt } = parseArgs(argv)
  const repoRoot = resolveRepoRoot()

  const upstreamBaseRef = opt("--upstream-base", "v1.17.9")!
  const oursRef = opt("--ours", "HEAD")!
  const targetRef = opt("--target")
  if (!targetRef) {
    log.error("--target <ref> is required, e.g. --target v1.18.3")
    process.exit(2)
  }

  const envelope = buildReplay(repoRoot, upstreamBaseRef, oursRef, targetRef)

  let byBucket: ConflictCategoryAttribution[] | undefined
  const censusPath = opt("--census")
  if (censusPath) {
    const census: CensusLike = JSON.parse(fs.readFileSync(censusPath, "utf-8"))
    const { loadPathsAtRef } = await import("./utils/refs")
    const upstreamPaths = loadPathsAtRef(upstreamBaseRef, repoRoot)
    byBucket = attributeConflictsToCensus(envelope, census, upstreamPaths)
    envelope.byBucket = byBucket
  }

  if (flag("--json")) {
    console.log(JSON.stringify(envelope, null, 2))
    return
  }

  log.banner("MERGE REPLAY")
  console.log(`upstream base:  ${envelope.upstreamBaseRef} (${envelope.upstreamBaseSha.slice(0, 12)})`)
  console.log(`ours:           ${envelope.oursRef} (${envelope.oursSha.slice(0, 12)})`)
  console.log(`target:         ${envelope.targetRef} (${envelope.targetSha.slice(0, 12)})`)
  console.log(`git version:    ${envelope.gitVersion}`)
  console.log(`generated:      ${envelope.generatedAt}`)
  console.log(`result tree:    ${envelope.resultTreeOid}`)
  console.log(`merge-tree exit code: ${envelope.exitCode} (${envelope.exitCode === 0 ? "clean" : "conflicts present"})`)
  console.log()
  console.log("=== TOTALS ===")
  console.log(`conflicted paths:        ${envelope.totals.conflictedPaths}`)
  console.log(`  content-conflict files:  ${envelope.totals.contentConflictFiles} (${envelope.totals.contentConflictRegions} textual <<<<<<< regions)`)
  console.log(`conflict messages:       ${envelope.totals.conflictMessages}`)
  console.log(`auto-merged (attempted): ${envelope.totals.autoMergedAttempted}`)
  console.log(`auto-merged (clean):     ${envelope.totals.autoMergedClean}`)
  console.log()
  console.log("=== BY CONFLICT TYPE ===")
  for (const { type, count } of envelope.totals.byType) {
    console.log(`  ${type.padEnd(20)} ${count}`)
  }
  if (byBucket) {
    console.log()
    console.log("=== CONFLICTED PATHS BY TAXONOMY BUCKET (census attribution) ===")
    for (const { bucket, count } of byBucket) {
      console.log(`  ${bucket.padEnd(30)} ${count}`)
    }
  }
}

if (import.meta.main) {
  main().catch((err) => {
    log.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
