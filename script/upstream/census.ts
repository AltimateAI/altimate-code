#!/usr/bin/env bun
/**
 * Census of `altimate_change` marker blocks across the repository.
 *
 * Productionized version of docs/internal/census/census.ts (prototype):
 *  - repo root resolved via `git rev-parse --show-toplevel` (no hardcoded paths)
 *  - bucket/category classification imported from ./taxonomy.ts (single source
 *    of truth — never re-implemented here)
 *  - files are read from the git object database at `--ours` (default HEAD),
 *    not the working filesystem — untracked scratch files, .gitignore'd
 *    build output, and uncommitted edits never leak into the census
 *  - deterministic, sorted output with a versioned, provenance-pinned JSON
 *    envelope (schemaVersion, generatorVersion, oursSha/oursTree, upstream
 *    base ref/sha/tree used for classification)
 *  - unclosed `altimate_change start` markers (no matching end) THROW unless
 *    covered by an entry in unclosed-marker-allowlist.jsonc — a real
 *    unmatched marker is either a bug or a false positive that needs to be
 *    triaged, never silently counted and ignored
 *  - `--check` ratchet mode: a multiset ({file, contentHash}) comparison
 *    against a baseline census, so a file can gain/lose exactly the blocks it
 *    should without silently absorbing new drift
 *
 * Usage:
 *   bun run census.ts                          # human summary (default)
 *   bun run census.ts --summary                # same, explicit
 *   bun run census.ts --json                    # full envelope to stdout
 *   bun run census.ts --upstream-base <ref>      # default v1.17.9
 *   bun run census.ts --unclosed-allowlist <path> # default unclosed-marker-allowlist.jsonc
 *   bun run census.ts --check --baseline <path> [--exemptions <path>]
 *   bun run census.ts --diff-budget --base <ref> # S3 gate utility (counting only)
 */
import fs from "fs"
import path from "path"
import { createHash } from "crypto"
import { spawnSync } from "child_process"
import { resolveRepoRoot } from "./utils/repo-root"
import { loadPathsAtRef, resolveRefOrThrow, listTreeEntries, readBlobsBatch } from "./utils/refs"
import { parseJsonc } from "./utils/jsonc"
import { classifyBucket, classifyCategories, isUpstreamFixLine, TAXONOMY_VERSION, categoryRuleIds, FORK_OWNED_ROOTS, type Bucket, type CategoryLabel } from "./taxonomy"
import * as log from "./utils/logger"

export const GENERATOR_VERSION = "census.ts@1"
export const SCHEMA_VERSION = 1

const START_RE = /altimate_change start(?:\s*[—-]\s*(.*))?/
const END_RE = /altimate_change end/

const SCAN_EXTS = [".ts", ".tsx", ".js", ".jsx", ".json", ".jsonc", ".txt", ".md", ".yaml", ".yml"]
const SCAN_ROOTS = ["packages", "script", "sdks", ".opencode", ".claude", "docs", "experiments", ".github"]
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "dist", "build", ".turbo", ".next"])

export interface Block {
  file: string
  startLine: number
  endLine: number | null
  lineCount: number | null
  description: string
  isUpstreamFix: boolean
  bucket: Bucket
  categories: CategoryLabel[]
  /** sha256 of the exact source lines spanned by [startLine, endLine], for ratchet keying. */
  contentHash: string | null
}

export interface CensusEnvelope {
  schemaVersion: number
  generatorVersion: string
  generatedAt: string
  taxonomyVersion: number
  oursRef: string
  oursSha: string
  oursTree: string
  upstreamBaseRef: string
  upstreamBaseSha: string
  upstreamBaseTree: string
  rules: {
    forkOwnedRoots: string[]
    categoryRuleIds: string[]
  }
  totals: {
    blocks: number
    files: number
    unclosed: number
    byBucket: Record<Bucket, { blocks: number; files: number }>
    /**
     * Per-category-label breakdown (multi-label: a block with N category
     * labels contributes to N entries here, so summed block counts can
     * exceed `totals.blocks`). Includes UNATTRIBUTED. Previously this
     * breakdown existed only as an ad-hoc CLI computation over
     * `upstream_shared` blocks and was absent from the JSON envelope
     * entirely — finding #13.
     */
    byCategory: Record<string, { blocks: number; files: number }>
  }
  blocks: Block[]
  /**
   * Applied-exclusion report for the unclosed-marker allowlist: which
   * entries actually matched a real unclosed block this run, vs which are
   * stale (the marker got closed, the file was deleted/renamed, the line
   * moved, or the entry expired). A stale entry silently accumulates in the
   * allowlist forever unless something surfaces it — finding #1's
   * follow-up gap. Empty when no --unclosed-allowlist was supplied.
   */
  unclosedAllowlistApplication: UnclosedAllowlistApplication[]
}

// ── Pure helpers (unit-tested directly) ─────────────────────────────────────

/** Strip trailing comment-closer noise from a description and collapse whitespace. */
export function cleanDescription(raw: string | undefined): string {
  if (!raw) return ""
  let d = raw.trim()
  d = d.replace(/\*\/\s*$/, "").trim()
  d = d.replace(/\}\s*$/, "").trim()
  d = d.replace(/\)\s*$/, "").trim()
  d = d.replace(/`,?\s*$/, "").trim()
  d = d.replace(/",?\s*$/, "").trim()
  return d
}

export function contentHashOf(lines: string[], startLine: number, endLine: number | null): string | null {
  if (endLine === null) return null
  // Strip a trailing \r from each line before hashing, so a block that only
  // differs by CRLF-vs-LF line endings (e.g. a file checked out with
  // core.autocrlf on a contributor's machine) still produces the same
  // contentHash as its LF counterpart — the ratchet keys on *content*, and a
  // line-ending difference alone isn't a new block.
  const slice = lines.slice(startLine - 1, endLine).map((l) => l.replace(/\r$/, ""))
  return createHash("sha256").update(slice.join("\n")).digest("hex")
}

/** Deterministic, locale-independent string comparator (UTF-16 code-unit order). */
function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Stack-based marker parser: markers can nest (a block can contain sibling
 * sub-blocks with their own start/end), so a single open-block slot isn't
 * enough — mirrors the prototype's approach.
 */
export function parseMarkerBlocks(relPath: string, content: string, upstreamPaths: ReadonlySet<string>): { blocks: Block[]; unclosed: number } {
  if (!content.includes("altimate_change start")) return { blocks: [], unclosed: 0 }
  const lines = content.split("\n")
  const bucket = classifyBucket(relPath, upstreamPaths)

  const stack: { startLine: number; description: string; isUpstreamFix: boolean }[] = []
  const blocks: Block[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const startMatch = line.match(START_RE)
    if (startMatch) {
      stack.push({
        startLine: i + 1,
        description: startMatch[1] ?? "",
        isUpstreamFix: isUpstreamFixLine(line),
      })
      continue
    }
    if (END_RE.test(line) && stack.length > 0) {
      const open = stack.pop()!
      const endLine = i + 1
      const description = cleanDescription(open.description) || "(no description)"
      blocks.push({
        file: relPath,
        startLine: open.startLine,
        endLine,
        lineCount: endLine - open.startLine + 1,
        description,
        isUpstreamFix: open.isUpstreamFix,
        bucket,
        categories: classifyCategories(relPath, open.description),
        contentHash: contentHashOf(lines, open.startLine, endLine),
      })
    }
  }

  for (const open of stack) {
    const description = cleanDescription(open.description) || "(no description)"
    blocks.push({
      file: relPath,
      startLine: open.startLine,
      endLine: null,
      lineCount: null,
      description,
      isUpstreamFix: open.isUpstreamFix,
      bucket,
      categories: classifyCategories(relPath, open.description),
      contentHash: null,
    })
  }

  return { blocks, unclosed: stack.length }
}

// ── Tree-based file discovery (finding #2: read from the git object database
// at `--ours`, not the working filesystem, so untracked/.gitignore'd/dirty
// working-tree state never leaks into the census) ──────────────────────────

export function isScannablePath(relPath: string): boolean {
  const hasScannableExt = SCAN_EXTS.some((ext) => relPath.endsWith(ext))
  if (!hasScannableExt) return false
  const underScanRoot = SCAN_ROOTS.some((root) => relPath === root || relPath.startsWith(`${root}/`))
  if (!underScanRoot) return false
  const segments = relPath.split("/")
  if (segments.some((seg) => SKIP_DIR_NAMES.has(seg))) return false
  return true
}

/**
 * Read every scannable file's content as committed at `ref`, via
 * `git ls-tree` + a single batched `git cat-file --batch` — no working-tree
 * filesystem access. Returns a Map from repo-relative path to file content.
 */
export function scanFilesAtRef(ref: string, repoRoot: string): Map<string, string> {
  const entries = listTreeEntries(ref, repoRoot).filter((e) => e.type === "blob" && isScannablePath(e.path))
  // Blobs are content-addressed: many files (e.g. duplicate fixtures, empty
  // files) can share an oid. Dedupe before the batch read — readBlobsBatch
  // reads git's --batch output stream positionally and only advances its
  // buffer offset once per *distinct* oid it hasn't already cached, so
  // feeding it the same oid twice in a row without dedup would desync it.
  const uniqueOids = [...new Set(entries.map((e) => e.oid))]
  const blobsByOid = readBlobsBatch(uniqueOids, repoRoot)

  const out = new Map<string, string>()
  for (const entry of entries) {
    const content = blobsByOid.get(entry.oid)
    if (content === undefined) {
      throw new Error(`scanFilesAtRef: blob ${entry.oid} for '${entry.path}' was not returned by 'git cat-file --batch'`)
    }
    out.set(entry.path, content)
  }
  return out
}

// ── Unclosed-marker allowlist (finding #1) ──────────────────────────────────

export interface UnclosedMarkerAllowlistEntry {
  file: string
  startLine: number
  reason: string
  approvedBy: string
  /** Optional ISO date; after this date the entry no longer suppresses the throw. */
  expires?: string
}

export function loadUnclosedAllowlist(filePath: string): UnclosedMarkerAllowlistEntry[] {
  if (!fs.existsSync(filePath)) return []
  const raw = fs.readFileSync(filePath, "utf-8")
  const parsed = parseJsonc(raw)
  if (!Array.isArray(parsed)) throw new Error(`${filePath}: expected top-level JSON array`)
  return parsed as UnclosedMarkerAllowlistEntry[]
}

function isAllowlistedUnclosed(file: string, startLine: number, allowlist: readonly UnclosedMarkerAllowlistEntry[], now: Date): boolean {
  return allowlist.some((e) => {
    if (e.file !== file || e.startLine !== startLine) return false
    if (e.expires && new Date(e.expires).getTime() < now.getTime()) return false
    return true
  })
}

/**
 * Applied-exclusion report: which unclosed-marker allowlist entries actually
 * matched a real unclosed block in this run, vs which are stale (the marker
 * got closed, the file was deleted/renamed, or the line moved). A stale
 * entry silently accumulates in the allowlist forever unless something
 * surfaces it — finding #1's follow-up gap.
 */
export interface UnclosedAllowlistApplication {
  entry: UnclosedMarkerAllowlistEntry
  applied: boolean
}

export function findUnclosedAllowlistApplication(
  allowlist: readonly UnclosedMarkerAllowlistEntry[],
  unclosedBlocks: readonly Pick<Block, "file" | "startLine">[],
  now: Date,
): UnclosedAllowlistApplication[] {
  return allowlist.map((entry) => {
    if (entry.expires && new Date(entry.expires).getTime() < now.getTime()) {
      return { entry, applied: false }
    }
    const applied = unclosedBlocks.some((b) => b.file === entry.file && b.startLine === entry.startLine)
    return { entry, applied }
  })
}

// ── Envelope construction ───────────────────────────────────────────────────

export interface CensusProvenance {
  oursRef: string
  oursSha: string
  oursTree: string
  upstreamBaseRef: string
  upstreamBaseSha: string
  upstreamBaseTree: string
}

export interface AssembleCensusOptions {
  /** Injectable clock for the envelope's generatedAt field; defaults to new Date().toISOString(). */
  generatedAt?: string
  /** Entries that suppress the unclosed-marker throw for a known {file, startLine}. */
  unclosedAllowlist?: UnclosedMarkerAllowlistEntry[]
  /** Injectable "now" for allowlist expiry checks; defaults to new Date(). */
  now?: Date
}

/**
 * Pure envelope assembly: given already-read file contents (from
 * scanFilesAtRef, or a synthetic Map in tests), the ref/sha/tree provenance,
 * and the set of upstream paths for bucket classification, parses every
 * file's marker blocks, throws on any unclosed marker not covered by the
 * allowlist, and returns a fully populated CensusEnvelope.
 *
 * Does NOT re-apply isScannablePath filtering — the caller (scanFilesAtRef
 * for real use, or a test) is responsible for handing in exactly the files
 * that should be scanned.
 */
export function assembleCensus(
  filesAtRef: ReadonlyMap<string, string>,
  provenance: CensusProvenance,
  upstreamPaths: ReadonlySet<string>,
  opts: AssembleCensusOptions = {},
): CensusEnvelope {
  const allBlocks: Block[] = []
  let unclosedTotal = 0

  const sortedPaths = [...filesAtRef.keys()].sort(byteCompare)
  for (const relPath of sortedPaths) {
    const content = filesAtRef.get(relPath)!
    const { blocks, unclosed } = parseMarkerBlocks(relPath, content, upstreamPaths)
    allBlocks.push(...blocks)
    unclosedTotal += unclosed
  }

  // Deterministic ordering: file, then startLine.
  allBlocks.sort((a, b) => (a.file === b.file ? a.startLine - b.startLine : byteCompare(a.file, b.file)))

  const now = opts.now ?? new Date()
  const allowlist = opts.unclosedAllowlist ?? []
  const uncovered = allBlocks.filter((b) => b.endLine === null && !isAllowlistedUnclosed(b.file, b.startLine, allowlist, now))
  if (uncovered.length > 0) {
    const detail = uncovered.map((b) => `  ${b.file}:${b.startLine} "${b.description}"`).join("\n")
    throw new Error(
      `census: ${uncovered.length} unclosed 'altimate_change start' marker(s) with no matching end, not covered by the unclosed-marker allowlist:\n` +
        `${detail}\n\n` +
        `Each one is either a real bug (add the missing 'altimate_change end') or a false positive ` +
        `(a doc/string literal mentioning marker syntax) that needs an entry in the unclosed-marker allowlist.`,
    )
  }

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
  for (const b of allBlocks) {
    byBucket[b.bucket].blocks++
    filesByBucket[b.bucket].add(b.file)
  }
  for (const bucket of Object.keys(byBucket) as Bucket[]) {
    byBucket[bucket].files = filesByBucket[bucket].size
  }

  const byCategory: Record<string, { blocks: number; files: number }> = {}
  const filesByCategory = new Map<string, Set<string>>()
  for (const b of allBlocks) {
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

  const unclosedBlocks = allBlocks.filter((b) => b.endLine === null)
  const unclosedAllowlistApplication = findUnclosedAllowlistApplication(allowlist, unclosedBlocks, now)

  return {
    schemaVersion: SCHEMA_VERSION,
    generatorVersion: GENERATOR_VERSION,
    generatedAt: opts.generatedAt ?? now.toISOString(),
    taxonomyVersion: TAXONOMY_VERSION,
    ...provenance,
    rules: {
      forkOwnedRoots: [...FORK_OWNED_ROOTS],
      categoryRuleIds: categoryRuleIds(),
    },
    totals: {
      blocks: allBlocks.length,
      files: new Set(allBlocks.map((b) => b.file)).size,
      unclosed: unclosedTotal,
      byBucket,
      byCategory,
    },
    blocks: allBlocks,
    unclosedAllowlistApplication,
  }
}

export interface BuildCensusOptions extends AssembleCensusOptions {
  /** Path to the unclosed-marker allowlist JSONC file; ignored if opts.unclosedAllowlist is set directly. */
  unclosedAllowlistPath?: string
}

/** Thin wrapper: resolves refs, reads the tree at `oursRef`, and delegates to assembleCensus(). */
export function buildCensus(repoRoot: string, oursRef: string, upstreamBaseRef: string, opts: BuildCensusOptions = {}): CensusEnvelope {
  const ours = resolveRefOrThrow(oursRef, repoRoot)
  const upstreamBase = resolveRefOrThrow(upstreamBaseRef, repoRoot)
  const upstreamPaths = loadPathsAtRef(upstreamBaseRef, repoRoot)
  const filesAtRef = scanFilesAtRef(oursRef, repoRoot)

  const unclosedAllowlist =
    opts.unclosedAllowlist ??
    loadUnclosedAllowlist(opts.unclosedAllowlistPath ?? path.join(repoRoot, "script/upstream/unclosed-marker-allowlist.jsonc"))

  return assembleCensus(
    filesAtRef,
    {
      oursRef,
      oursSha: ours.sha,
      oursTree: ours.tree,
      upstreamBaseRef,
      upstreamBaseSha: upstreamBase.sha,
      upstreamBaseTree: upstreamBase.tree,
    },
    upstreamPaths,
    { ...opts, unclosedAllowlist },
  )
}

// ── Cross-envelope compatibility check (finding #3) ─────────────────────────

/**
 * Throws if `current` and `baseline` were produced by incompatible
 * schema/taxonomy versions — comparing their block sets in that case would
 * silently mix classification rules that mean different things.
 */
export function assertCensusCompatible(current: CensusEnvelope, baseline: CensusEnvelope): void {
  if (current.schemaVersion !== baseline.schemaVersion) {
    throw new Error(
      `census schema mismatch: current schemaVersion=${current.schemaVersion} vs baseline schemaVersion=${baseline.schemaVersion}. ` +
        `Regenerate the baseline with the current census.ts before running --check.`,
    )
  }
  if (current.taxonomyVersion !== baseline.taxonomyVersion) {
    throw new Error(
      `taxonomy version mismatch: current taxonomyVersion=${current.taxonomyVersion} vs baseline taxonomyVersion=${baseline.taxonomyVersion}. ` +
        `Bucket/category classification rules changed since the baseline was generated — regenerate the baseline before running --check.`,
    )
  }
  if (current.upstreamBaseRef !== baseline.upstreamBaseRef || current.upstreamBaseSha !== baseline.upstreamBaseSha) {
    throw new Error(
      `upstream base mismatch: current upstreamBaseRef=${current.upstreamBaseRef} (${current.upstreamBaseSha.slice(0, 12)}) vs ` +
        `baseline upstreamBaseRef=${baseline.upstreamBaseRef} (${baseline.upstreamBaseSha.slice(0, 12)}). ` +
        `Bucket classification (upstream_shared vs fork_owned vs fork_added_outside_boundary) is computed against the upstream base tree — ` +
        `a different base means the two envelopes' buckets aren't comparable. Regenerate the baseline against the same --upstream-base before running --check.`,
    )
  }
}

// ── Ratchet (multiset) check ────────────────────────────────────────────────

export interface Exemption {
  blockRef: { file: string; contentHash: string }
  allowedCount: number
  reason: string
  approvedBy: string
  expires?: string
}

function validateExemption(ex: unknown, filePath: string, index: number): asserts ex is Exemption {
  if (typeof ex !== "object" || ex === null) {
    throw new Error(`${filePath}: exemption[${index}] is not an object`)
  }
  const e = ex as Record<string, unknown>
  const blockRef = e.blockRef as Record<string, unknown> | undefined
  if (typeof blockRef !== "object" || blockRef === null) {
    throw new Error(`${filePath}: exemption[${index}].blockRef is missing or not an object`)
  }
  if (typeof blockRef.file !== "string" || blockRef.file.length === 0) {
    throw new Error(`${filePath}: exemption[${index}].blockRef.file must be a non-empty string`)
  }
  if (typeof blockRef.contentHash !== "string" || blockRef.contentHash.length === 0) {
    throw new Error(`${filePath}: exemption[${index}].blockRef.contentHash must be a non-empty string`)
  }
  if (typeof e.allowedCount !== "number" || !Number.isInteger(e.allowedCount) || e.allowedCount <= 0) {
    throw new Error(`${filePath}: exemption[${index}].allowedCount must be a positive integer`)
  }
  if (typeof e.reason !== "string" || e.reason.length === 0) {
    throw new Error(`${filePath}: exemption[${index}].reason must be a non-empty string`)
  }
  if (typeof e.approvedBy !== "string" || e.approvedBy.length === 0) {
    throw new Error(`${filePath}: exemption[${index}].approvedBy must be a non-empty string`)
  }
  if (e.expires !== undefined && (typeof e.expires !== "string" || Number.isNaN(new Date(e.expires).getTime()))) {
    throw new Error(`${filePath}: exemption[${index}].expires must be a valid ISO date string`)
  }
}

export function loadExemptions(filePath: string): Exemption[] {
  if (!fs.existsSync(filePath)) return []
  const raw = fs.readFileSync(filePath, "utf-8")
  const parsed = parseJsonc(raw)
  if (!Array.isArray(parsed)) throw new Error(`${filePath}: expected top-level JSON array`)
  parsed.forEach((ex, i) => validateExemption(ex, filePath, i))
  return parsed as Exemption[]
}

function isExpired(exemption: Exemption, now: Date): boolean {
  if (!exemption.expires) return false
  return new Date(exemption.expires).getTime() < now.getTime()
}

const RATCHET_BUCKETS: Bucket[] = ["upstream_shared", "fork_added_outside_boundary"]

/**
 * JSON-encode the {file, contentHash} pair as the multiset key. Previously
 * this was a raw template literal `${file} ${contentHash}` containing a
 * literal NUL byte as the separator — any path or hash containing a NUL (or,
 * short of that, any ambiguity from naively splitting on a byte that could
 * theoretically also appear in a hex digest) risked corrupting the key.
 * JSON.stringify/parse round-trips the pair unambiguously regardless of what
 * either field contains.
 */
function multisetKey(file: string, contentHash: string): string {
  return JSON.stringify({ file, contentHash })
}

function parseMultisetKey(key: string): { file: string; contentHash: string } {
  return JSON.parse(key) as { file: string; contentHash: string }
}

function buildMultiset(blocks: Block[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const b of blocks) {
    if (!RATCHET_BUCKETS.includes(b.bucket)) continue
    if (b.contentHash === null) continue // unclosed blocks can't be keyed; surfaced separately
    const key = multisetKey(b.file, b.contentHash)
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  return map
}

export interface RatchetViolation {
  file: string
  contentHash: string
  baselineCount: number
  currentCount: number
  netNew: number
  exemptedCount: number
  uncoveredCount: number
}

/**
 * Secondary/aggregate backstop (finding #3's follow-up): the per-{file,
 * contentHash}-key multiset comparison in ratchetCheck() is precise for
 * detecting net-new *instances* of a specific block, but it silently trusts
 * that `envelope.totals.byBucket[bucket].blocks` (computed independently,
 * during assembleCensus's byBucket loop) agrees with what the multiset
 * itself contains. If those two ever drift apart — a hash-collision
 * (two structurally different blocks landing on the same {file,
 * contentHash} key, which JSON.stringify-based keying makes astronomically
 * unlikely but not impossible) or an accounting bug in one of the two
 * independent counting passes — ratchetCheck() could report zero
 * violations while the envelope's own totals silently disagree. This
 * throws if that self-consistency ever breaks, since it indicates a bug in
 * census generation rather than a legitimate ratchet outcome.
 */
export function assertMultisetTotalsConsistent(label: string, envelope: CensusEnvelope): void {
  const multiset = buildMultiset(envelope.blocks)
  // bucket is a per-file property (classifyBucket depends only on relPath, not
  // block content), so every block sharing a file shares a bucket — one pass
  // is enough to build the lookup, avoiding an O(keys * blocks) rescan below.
  const bucketByFile = new Map<string, Bucket>()
  for (const b of envelope.blocks) bucketByFile.set(b.file, b.bucket)

  const multisetTotalByBucket: Record<Bucket, number> = {
    upstream_shared: 0,
    fork_owned: 0,
    fork_added_outside_boundary: 0,
  }
  for (const [key, count] of multiset) {
    const { file } = parseMultisetKey(key)
    const bucket = bucketByFile.get(file)
    if (bucket) multisetTotalByBucket[bucket] += count
  }

  for (const bucket of RATCHET_BUCKETS) {
    const unclosedInBucket = envelope.blocks.filter((b) => b.bucket === bucket && b.contentHash === null).length
    const expected = envelope.totals.byBucket[bucket].blocks - unclosedInBucket
    const actual = multisetTotalByBucket[bucket]
    if (expected !== actual) {
      throw new Error(
        `census internal consistency check failed for ${label}, bucket=${bucket}: ` +
          `totals.byBucket says ${expected} closed blocks (${envelope.totals.byBucket[bucket].blocks} total - ${unclosedInBucket} unclosed), ` +
          `but the ratchet multiset counts ${actual} block instances. This indicates a bug in census generation ` +
          `(e.g. a contentHash collision or a mismatch between the two independent counting passes), not a normal ratchet outcome.`,
      )
    }
  }
}

export function ratchetCheck(current: CensusEnvelope, baseline: CensusEnvelope, exemptions: Exemption[], now = new Date()): RatchetViolation[] {
  assertMultisetTotalsConsistent("current", current)
  assertMultisetTotalsConsistent("baseline", baseline)

  const currentMultiset = buildMultiset(current.blocks)
  const baselineMultiset = buildMultiset(baseline.blocks)

  const exemptionAllowance = new Map<string, number>()
  for (const ex of exemptions) {
    if (isExpired(ex, now)) continue
    const key = multisetKey(ex.blockRef.file, ex.blockRef.contentHash)
    exemptionAllowance.set(key, (exemptionAllowance.get(key) ?? 0) + ex.allowedCount)
  }

  const violations: RatchetViolation[] = []
  for (const [key, currentCount] of currentMultiset) {
    const baselineCount = baselineMultiset.get(key) ?? 0
    const netNew = currentCount - baselineCount
    if (netNew <= 0) continue
    const exempted = exemptionAllowance.get(key) ?? 0
    const uncovered = Math.max(0, netNew - exempted)
    if (uncovered > 0) {
      const { file, contentHash } = parseMultisetKey(key)
      violations.push({ file, contentHash, baselineCount, currentCount, netNew, exemptedCount: exempted, uncoveredCount: uncovered })
    }
  }
  violations.sort((a, b) => byteCompare(a.file, b.file) || byteCompare(a.contentHash, b.contentHash))
  return violations
}

/**
 * Non-blocking companion to ratchetCheck: exemptions whose {file,
 * contentHash} pair has no net-new instance vs baseline (current count <=
 * baseline count) are covering nothing right now and are worth flagging as
 * possibly stale/unused, without failing the check.
 */
export interface StaleExemptionWarning {
  exemption: Exemption
  index: number
  reason: string
}

export function findStaleExemptions(exemptions: Exemption[], current: CensusEnvelope, baseline: CensusEnvelope, now = new Date()): StaleExemptionWarning[] {
  const currentMultiset = buildMultiset(current.blocks)
  const baselineMultiset = buildMultiset(baseline.blocks)

  const warnings: StaleExemptionWarning[] = []
  exemptions.forEach((ex, index) => {
    if (isExpired(ex, now)) return // already expired; that's its own, expected end-of-life
    const key = multisetKey(ex.blockRef.file, ex.blockRef.contentHash)
    const currentCount = currentMultiset.get(key) ?? 0
    const baselineCount = baselineMultiset.get(key) ?? 0
    const netNew = currentCount - baselineCount
    if (netNew <= 0) {
      warnings.push({
        exemption: ex,
        index,
        reason: `no net-new instance of {file: ${ex.blockRef.file}, contentHash: ${ex.blockRef.contentHash.slice(0, 12)}…} vs baseline (current=${currentCount}, baseline=${baselineCount}) — this exemption may be unused`,
      })
    }
  })
  return warnings
}

// ── diff-budget (S3 gate utility — counting only, no enforcement here) ─────

export interface DiffBudgetResult {
  base: string
  head: string
  filesChanged: number
  upstreamSharedFilesChanged: number
  forkOwnedFilesChanged: number
  forkAddedOutsideBoundaryFilesChanged: number
  addedLinesInUpstreamShared: number
  addedLinesInUpstreamSharedNonTest: number
}

export interface NumstatRecord {
  added: number | null
  removed: number | null
  path: string
  oldPath?: string
}

/**
 * Parse `git diff --numstat -M -z` output. NUL-delimited records come in two
 * shapes:
 *   plain:  "<added>\t<removed>\t<path>\0"
 *   rename: "<added>\t<removed>\t\0<oldPath>\0<newPath>\0"
 * (a rename record's numeric fields are followed by an EMPTY path token —
 * the actual old/new paths are the next two NUL-delimited tokens, never
 * combined into a single `{old => new}` string the way non-`-z` output
 * does). `added`/`removed` are `null` for binary files (numstat prints `-`).
 */
export function parseNumstatZ(raw: Buffer | string): NumstatRecord[] {
  const text = typeof raw === "string" ? raw : raw.toString("utf-8")
  const tokens = text.split("\0")
  if (tokens.length > 0 && tokens[tokens.length - 1] === "") tokens.pop() // trailing empty token after the final \0

  const records: NumstatRecord[] = []
  let i = 0
  while (i < tokens.length) {
    const tok = tokens[i]
    const firstTab = tok.indexOf("\t")
    const secondTab = firstTab === -1 ? -1 : tok.indexOf("\t", firstTab + 1)
    if (firstTab === -1 || secondTab === -1) {
      throw new Error(`parseNumstatZ: malformed numstat token at index ${i}: '${tok}'`)
    }
    const addedStr = tok.slice(0, firstTab)
    const removedStr = tok.slice(firstTab + 1, secondTab)
    const rest = tok.slice(secondTab + 1)
    const added = addedStr === "-" ? null : Number(addedStr)
    const removed = removedStr === "-" ? null : Number(removedStr)

    if (rest.length > 0) {
      records.push({ added, removed, path: rest })
      i += 1
    } else {
      const oldPath = tokens[i + 1]
      const newPath = tokens[i + 2]
      if (oldPath === undefined || newPath === undefined) {
        throw new Error(`parseNumstatZ: rename record at token ${i} is missing its old/new path tokens (truncated -z stream?)`)
      }
      records.push({ added, removed, path: newPath, oldPath })
      i += 3
    }
  }
  return records
}

export function computeDiffBudget(repoRoot: string, base: string, headRef: string, upstreamPaths: ReadonlySet<string>): DiffBudgetResult {
  const head = resolveRefOrThrow(headRef, repoRoot)
  const baseResolved = resolveRefOrThrow(base, repoRoot)

  const result = spawnSync("git", ["diff", "--numstat", "-M", "-z", baseResolved.sha, head.sha], {
    cwd: repoRoot,
    maxBuffer: 50 * 1024 * 1024,
  })
  if (result.error) {
    throw new Error(`Failed to spawn 'git diff --numstat -M -z': ${result.error.message}`)
  }
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString("utf-8") : ""
    throw new Error(`'git diff --numstat -M -z ${baseResolved.sha} ${head.sha}' exited ${result.status}: ${stderr}`)
  }

  const records = parseNumstatZ(result.stdout as Buffer)

  let filesChanged = 0
  let upstreamSharedFilesChanged = 0
  let forkOwnedFilesChanged = 0
  let forkAddedOutsideBoundaryFilesChanged = 0
  let addedLinesInUpstreamShared = 0
  let addedLinesInUpstreamSharedNonTest = 0
  const isTestPath = (p: string) => /(^|\/)(test|tests)\//.test(p) || /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(p)

  for (const rec of records) {
    filesChanged++
    const added = rec.added ?? 0
    // Classify by the upstream SOURCE path for renames, not the destination
    // path — a file renamed FROM an upstream_shared path TO a fork-only path
    // (or vice versa) must still be counted against the bucket it actually
    // diverged from, mirroring divergence.ts's already-correct pattern.
    const bucket = classifyBucket(rec.oldPath ?? rec.path, upstreamPaths)
    if (bucket === "upstream_shared") {
      upstreamSharedFilesChanged++
      addedLinesInUpstreamShared += added
      if (!isTestPath(rec.path)) addedLinesInUpstreamSharedNonTest += added
    } else if (bucket === "fork_owned") {
      forkOwnedFilesChanged++
    } else {
      forkAddedOutsideBoundaryFilesChanged++
    }
  }

  return {
    base: baseResolved.sha,
    head: head.sha,
    filesChanged,
    upstreamSharedFilesChanged,
    forkOwnedFilesChanged,
    forkAddedOutsideBoundaryFilesChanged,
    addedLinesInUpstreamShared,
    addedLinesInUpstreamSharedNonTest,
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const args = { ...Object.fromEntries(argv.map((a, i) => [a, argv[i + 1]])) } as Record<string, string>
  const flag = (name: string) => argv.includes(name)
  const opt = (name: string, def?: string) => {
    const idx = argv.indexOf(name)
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : def
  }
  void args
  return { flag, opt }
}

async function main() {
  const argv = process.argv.slice(2)
  const { flag, opt } = parseArgs(argv)
  const repoRoot = resolveRepoRoot()

  const oursRef = opt("--ours", "HEAD")!
  const upstreamBaseRef = opt("--upstream-base", "v1.17.9")!
  const unclosedAllowlistPath = opt("--unclosed-allowlist", path.join(repoRoot, "script/upstream/unclosed-marker-allowlist.jsonc"))!
  const generatedAt = opt("--generated-at")

  if (flag("--diff-budget")) {
    const base = opt("--base")
    if (!base) {
      log.error("--diff-budget requires --base <ref>")
      process.exit(2)
    }
    const upstreamPaths = loadPathsAtRef(upstreamBaseRef, repoRoot)
    const result = computeDiffBudget(repoRoot, base, oursRef, upstreamPaths)
    if (flag("--json")) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      log.banner("DIFF BUDGET (counting only — no threshold enforced in S1, see S3)")
      console.log(`base:  ${result.base}`)
      console.log(`head:  ${result.head}`)
      console.log(`files changed:                              ${result.filesChanged}`)
      console.log(`upstream_shared files changed:               ${result.upstreamSharedFilesChanged}`)
      console.log(`fork_owned files changed:                    ${result.forkOwnedFilesChanged}`)
      console.log(`fork_added_outside_boundary files changed:   ${result.forkAddedOutsideBoundaryFilesChanged}`)
      console.log(`added lines in upstream_shared:               ${result.addedLinesInUpstreamShared}`)
      console.log(`added lines in upstream_shared (non-test):    ${result.addedLinesInUpstreamSharedNonTest}`)
    }
    return
  }

  const envelope = buildCensus(repoRoot, oursRef, upstreamBaseRef, { unclosedAllowlistPath, generatedAt })

  const staleUnclosedEntries = envelope.unclosedAllowlistApplication.filter((a) => !a.applied)
  for (const s of staleUnclosedEntries) {
    log.warn(
      `unclosed-marker allowlist entry ${s.entry.file}:${s.entry.startLine} (approvedBy=${s.entry.approvedBy}) ` +
        `did not match any unclosed block this run — the marker may have been closed, the file moved/deleted/renamed, ` +
        `the line moved, or the entry expired. Consider removing it from ${unclosedAllowlistPath}.`,
    )
  }

  if (flag("--check")) {
    const baselinePath = opt("--baseline")
    if (!baselinePath) {
      log.error("--check requires --baseline <path>")
      process.exit(2)
    }
    const baseline: CensusEnvelope = JSON.parse(fs.readFileSync(baselinePath, "utf-8"))
    assertCensusCompatible(envelope, baseline)
    if (baseline.oursSha && envelope.oursSha !== baseline.oursSha) {
      // Baseline is a point-in-time snapshot; ratchet compares CONTENT sets,
      // not commit identity, so a differing oursSha is expected in normal use
      // (baseline was generated at an earlier commit). We proceed, but this
      // check documents the assumption for anyone reading the CLI output.
      log.debug(`baseline.oursSha=${baseline.oursSha} differs from current oursSha=${envelope.oursSha} (expected — baseline is a fixed snapshot)`)
    }
    const exemptionsPath = opt("--exemptions", path.join(repoRoot, "script/upstream/defork-exemptions.jsonc"))!
    const exemptions = loadExemptions(exemptionsPath)
    const violations = ratchetCheck(envelope, baseline, exemptions)

    const staleWarnings = findStaleExemptions(exemptions, envelope, baseline)
    for (const w of staleWarnings) {
      log.warn(`exemption[${w.index}] in ${exemptionsPath} (approvedBy=${w.exemption.approvedBy}): ${w.reason}`)
    }

    if (violations.length === 0) {
      log.success(`census ratchet check passed — no uncovered new marker-block instances vs baseline (${baselinePath})`)
      return
    }

    log.error(`census ratchet check FAILED — ${violations.length} uncovered new marker-block instance(s):`)
    for (const v of violations) {
      console.log(`  ${v.file}  contentHash=${v.contentHash.slice(0, 12)}…  baseline=${v.baselineCount} current=${v.currentCount} uncovered=${v.uncoveredCount}`)
    }
    console.log(`\nTo accept intentionally, add a quantity-scoped entry to ${exemptionsPath}.`)
    process.exit(1)
  }

  if (flag("--json")) {
    console.log(JSON.stringify(envelope, null, 2))
    return
  }

  // --summary (default)
  log.banner("MARKER-BLOCK CENSUS")
  console.log(`ours:           ${envelope.oursRef} (${envelope.oursSha.slice(0, 12)})`)
  console.log(`upstream base:  ${envelope.upstreamBaseRef} (${envelope.upstreamBaseSha.slice(0, 12)})`)
  console.log(`generated:      ${envelope.generatedAt}`)
  console.log()
  console.log("=== TOTALS ===")
  console.log(`Total marker blocks: ${envelope.totals.blocks} across ${envelope.totals.files} files`)
  console.log(`Unclosed (no matching end): ${envelope.totals.unclosed}`)
  console.log()
  console.log("=== BY BUCKET ===")
  for (const bucket of Object.keys(envelope.totals.byBucket) as Bucket[]) {
    const stat = envelope.totals.byBucket[bucket]
    console.log(`  ${bucket.padEnd(30)} ${stat.blocks} blocks, ${stat.files} files`)
  }
  console.log()

  const upstreamSharedBlocks = envelope.blocks.filter((b) => b.bucket === "upstream_shared")
  const catMap = new Map<string, Block[]>()
  for (const b of upstreamSharedBlocks) {
    for (const c of b.categories) {
      if (!catMap.has(c)) catMap.set(c, [])
      catMap.get(c)!.push(b)
    }
  }
  const catRows = [...catMap.entries()].sort((a, b) => b[1].length - a[1].length)
  console.log("=== CATEGORY BREAKDOWN (upstream_shared only; multi-label so counts may overlap) ===")
  for (const [cat, bs] of catRows) {
    const files = new Set(bs.map((b) => b.file))
    console.log(`  ${cat.padEnd(20)} ${bs.length} blocks, ${files.size} files`)
  }

  const fixBlocks = upstreamSharedBlocks.filter((b) => b.isUpstreamFix)
  console.log(`\n=== UPSTREAM_FIX BLOCKS (upstream_shared) === ${fixBlocks.length} blocks in ${new Set(fixBlocks.map((b) => b.file)).size} files`)
}

if (import.meta.main) {
  main().catch((err) => {
    log.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
