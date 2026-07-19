#!/usr/bin/env bun
/**
 * Divergence report: how far `ours` (default HEAD) has drifted from
 * `upstream-base` (default v1.17.9), broken down by taxonomy.ts bucket.
 *
 * This is a read-only report over `git diff`, never a merge — no working
 * tree or object-db mutation. Refs are resolved strictly locally (see
 * utils/refs.ts#resolveRefOrThrow); a missing ref fails with the exact
 * fetch command to run, never an automatic network fetch.
 *
 * Counting strategy (important for correctness): added/deleted line counts
 * and the file list come from `git diff --numstat -M -z` — git's own
 * plumbing, identical to what `--shortstat` aggregates. We do NOT count `+`
 * / `-` lines out of a unified diff by hand: that approach silently drops
 * real deleted content lines that begin `--` (rendered `---...` in the
 * diff) and added lines beginning `++` (`+++...`), because those collide
 * with the `--- a/…` / `+++ b/…` file-header markers. `--numstat` sidesteps
 * that entire class of bug and is binary-safe. Hunk counts come from a
 * separate `-U0 -M` pass counting `@@` headers (unambiguous at column 0).
 *
 * Usage:
 *   bun run divergence.ts                              # summary, v1.17.9 vs HEAD
 *   bun run divergence.ts --upstream-base v1.17.9 --ours HEAD
 *   bun run divergence.ts --json
 */
import { resolveRepoRoot } from "./utils/repo-root"
import { resolveRefOrThrow, loadPathsAtRef, runGitBufferOrThrow } from "./utils/refs"
import { classifyBucket, TAXONOMY_VERSION, type Bucket } from "./taxonomy"
import * as log from "./utils/logger"

export const GENERATOR_VERSION = "divergence.ts@2"
export const SCHEMA_VERSION = 2

// A repo-wide diff can exceed git's default rename-detection file-count cap,
// which silently disables `-M` for the whole run (git prints a warning and
// falls back to no rename detection). Raise diff.renameLimit so exhaustive
// detection actually runs instead of being skipped.
const RENAME_LIMIT = 20000

// Config that materially changes diff OUTPUT (line counts, hunk counts, path
// quoting) is inherited from the environment/repo unless pinned. A baseline
// computed here must reproduce byte-for-byte in CI regardless of the runner's
// git config, so we pin every knob that affects the numbers and record them.
//   - diff.algorithm=myers: patience/minimal produce DIFFERENT +/- counts.
//   - diff.interHunkContext=0 + -U0: pins hunk count.
//   - core.quotepath=false: emit raw UTF-8 paths (no \303\251 octal mangling).
//   - diff.noprefix/mnemonicprefix=false: keep the `a/`…`b/` prefixes our
//     header parser depends on (noprefix=true otherwise yields 0 attribution).
//   - --no-color / --no-ext-diff / --no-textconv: no ANSI in output, and do
//     NOT let git launch external diff/textconv programs (a read-only report
//     must not execute configured helpers).
const PINNED_DIFF_CONFIG = [
  "-c",
  `diff.renameLimit=${RENAME_LIMIT}`,
  "-c",
  "diff.algorithm=myers",
  "-c",
  "diff.interHunkContext=0",
  "-c",
  "core.quotepath=false",
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicprefix=false",
]
const PINNED_DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv"]

const DIFF_OPTIONS = {
  renameLimit: RENAME_LIMIT,
  renameDetection: "-M",
  algorithm: "myers",
  interHunkContext: 0,
  quotePath: false,
  whitespace: "default (whitespace changes counted; no -w/-b/--ignore-*)",
  locale: "LC_ALL=C",
  externalDiff: "disabled (--no-ext-diff --no-textconv)",
  color: "disabled (--no-color)",
} as const

// Env with diff-affecting overrides stripped, so an inherited GIT_DIFF_OPTS
// (`--unified=50`) or GIT_EXTERNAL_DIFF can't perturb the numbers.
function sanitizedGitEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { ...process.env, LC_ALL: "C" }
  delete env.GIT_DIFF_OPTS
  delete env.GIT_EXTERNAL_DIFF
  return env
}

export interface FileDiffStat {
  path: string
  oldPath: string | null // set when renamed
  bucket: Bucket
  hunks: number
  added: number
  deleted: number
  isRename: boolean
  isBinary: boolean
  isTest: boolean
}

export interface DivergenceEnvelope {
  schemaVersion: number
  generatorVersion: string
  generatedAt: string
  taxonomyVersion: number
  upstreamBaseRef: string
  upstreamBaseSha: string
  upstreamBaseTree: string
  oursRef: string
  oursSha: string
  oursTree: string
  diffOptions: typeof DIFF_OPTIONS
  totals: {
    files: number
    hunks: number
    added: number
    deleted: number
    binaryFiles: number
    renameFiles: number
    testFiles: number
    byBucket: Record<Bucket, { files: number; hunks: number; added: number; deleted: number }>
  }
  files: FileDiffStat[]
}

// ── numstat parsing (authoritative added/deleted/file-list) ────────────────

export interface NumstatEntry {
  path: string
  oldPath: string | null
  added: number
  deleted: number
  isBinary: boolean
  isRename: boolean
}

/**
 * Parse `git diff --numstat -M -z` output. Each record is
 * `<added>\t<deleted>\t<path>\0` for a normal change, or — for a
 * rename/copy — `<added>\t<deleted>\t\0<oldpath>\0<newpath>\0`, i.e. the
 * third tab-field is empty and the following TWO NUL fields are the old and
 * new paths. Binary files report `-` for added and deleted. Pure function of
 * the buffer text, so it is directly unit-testable against fixtures.
 */
export function parseNumstatZ(text: string): NumstatEntry[] {
  const fields = text.split("\0")
  const out: NumstatEntry[] = []
  let i = 0
  while (i < fields.length) {
    const field = fields[i]
    if (field === "") {
      i++
      continue
    }
    const tab1 = field.indexOf("\t")
    const tab2 = field.indexOf("\t", tab1 + 1)
    if (tab1 === -1 || tab2 === -1) {
      // Not a numstat record head — skip defensively.
      i++
      continue
    }
    const addedRaw = field.slice(0, tab1)
    const deletedRaw = field.slice(tab1 + 1, tab2)
    const pathField = field.slice(tab2 + 1)
    const isBinary = addedRaw === "-" || deletedRaw === "-"
    const added = isBinary ? 0 : Number(addedRaw)
    const deleted = isBinary ? 0 : Number(deletedRaw)

    if (pathField === "") {
      // Rename/copy: next two NUL fields are oldpath, newpath.
      const oldPath = fields[i + 1] ?? ""
      const newPath = fields[i + 2] ?? ""
      out.push({ path: newPath, oldPath, added, deleted, isBinary, isRename: true })
      i += 3
    } else {
      out.push({ path: pathField, oldPath: null, added, deleted, isBinary, isRename: false })
      i++
    }
  }
  return out
}

// ── hunk counting (secondary metric) ───────────────────────────────────────

const DIFF_HEADER_RE = /^diff --git /
const HUNK_HEADER_RE = /^@@ /

/**
 * Count `@@` hunk headers per file from a `-U0 -M` unified diff, keyed by the
 * post-image path. A line beginning `@@ ` at column 0 is unambiguously a hunk
 * header (content lines always carry a `+`/`-`/space prefix), so this needs
 * no content-vs-marker disambiguation. Type-change entries emit two
 * `diff --git` blocks for one path; summing by post-image path folds them.
 * Returns a map path→hunkCount plus the global total (authoritative even if a
 * quoted path fails per-file attribution).
 */
export function parseHunksByPath(diffText: string): { byPath: Map<string, number>; total: number } {
  const byPath = new Map<string, number>()
  let total = 0
  let currentPath: string | null = null
  for (const line of diffText.split("\n")) {
    if (DIFF_HEADER_RE.test(line)) {
      currentPath = postImagePathFromHeader(line)
      if (currentPath && !byPath.has(currentPath)) byPath.set(currentPath, 0)
      continue
    }
    if (HUNK_HEADER_RE.test(line)) {
      total++
      if (currentPath) byPath.set(currentPath, (byPath.get(currentPath) ?? 0) + 1)
    }
  }
  return { byPath, total }
}

/**
 * Extract the post-image (`b/…`) path from a `diff --git a/x b/y` header,
 * handling git's C-quoted form (`"a/pa th" "b/pa th"`) for paths with spaces
 * or special bytes. Best-effort: used only for per-file hunk attribution; the
 * numstat pass owns the authoritative file identity.
 */
function postImagePathFromHeader(line: string): string | null {
  const rest = line.slice("diff --git ".length)
  // Quoted form: two C-quoted strings.
  if (rest.startsWith('"')) {
    const parts = rest.match(/^"((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"$/)
    if (parts) return unquoteC(parts[2]).replace(/^b\//, "")
  }
  // Unquoted: split on " b/" — the last occurrence separates a/ from b/.
  const idx = rest.lastIndexOf(" b/")
  if (idx !== -1) return rest.slice(idx + 3)
  return null
}

/** Decode git's C-style path quoting (\n, \t, \", \\, octal \NNN). */
function unquoteC(s: string): string {
  return s.replace(/\\(x[0-9a-fA-F]{2}|[0-7]{1,3}|.)/g, (_m, esc) => {
    if (esc === "n") return "\n"
    if (esc === "t") return "\t"
    if (esc === '"') return '"'
    if (esc === "\\") return "\\"
    if (/^[0-7]{1,3}$/.test(esc)) return String.fromCharCode(parseInt(esc, 8))
    return esc
  })
}

// ── test-path heuristic ────────────────────────────────────────────────────

const TEST_PATH_RE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[a-z]+$/i

export function isTestPath(path: string): boolean {
  return TEST_PATH_RE.test(path)
}

// ── git invocation ──────────────────────────────────────────────────────

function runNumstat(repoRoot: string, baseSha: string, oursSha: string): string {
  const buf = runGitBufferOrThrow(
    [...PINNED_DIFF_CONFIG, "diff", "--numstat", "-M", ...PINNED_DIFF_FLAGS, "-z", baseSha, oursSha],
    repoRoot,
    { env: sanitizedGitEnv() },
  )
  return buf.toString("utf-8")
}

function runHunkDiff(repoRoot: string, baseSha: string, oursSha: string): string {
  const buf = runGitBufferOrThrow(
    [...PINNED_DIFF_CONFIG, "diff", "-U0", "-M", ...PINNED_DIFF_FLAGS, baseSha, oursSha],
    repoRoot,
    { env: sanitizedGitEnv() },
  )
  return buf.toString("utf-8")
}

export function buildDivergence(
  repoRoot: string,
  upstreamBaseRef: string,
  oursRef: string,
  opts: { now?: string } = {},
): DivergenceEnvelope {
  const upstreamBase = resolveRefOrThrow(upstreamBaseRef, repoRoot)
  const ours = resolveRefOrThrow(oursRef, repoRoot)
  const upstreamPaths = loadPathsAtRef(upstreamBaseRef, repoRoot)

  const numstat = parseNumstatZ(runNumstat(repoRoot, upstreamBase.sha, ours.sha))
  const { byPath: hunksByPath, total: hunkTotalFromDiff } = parseHunksByPath(runHunkDiff(repoRoot, upstreamBase.sha, ours.sha))

  const files: FileDiffStat[] = numstat
    .map((f) => ({
      path: f.path,
      oldPath: f.oldPath,
      // Classify by the path's presence in the upstream-base tree — a file
      // renamed FROM an upstream path is still meaningfully "upstream_shared"
      // territory even though its new name may not exist upstream.
      bucket: classifyBucket(f.oldPath ?? f.path, upstreamPaths),
      hunks: hunksByPath.get(f.path) ?? 0,
      added: f.added,
      deleted: f.deleted,
      isRename: f.isRename,
      isBinary: f.isBinary,
      isTest: isTestPath(f.path),
    }))
    // Deterministic codepoint sort (NOT localeCompare, which is locale-sensitive).
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const emptyBucket = () => ({ files: 0, hunks: 0, added: 0, deleted: 0 })
  const byBucket: Record<Bucket, { files: number; hunks: number; added: number; deleted: number }> = {
    upstream_shared: emptyBucket(),
    fork_owned: emptyBucket(),
    fork_added_outside_boundary: emptyBucket(),
  }
  for (const f of files) {
    byBucket[f.bucket].files++
    byBucket[f.bucket].hunks += f.hunks
    byBucket[f.bucket].added += f.added
    byBucket[f.bucket].deleted += f.deleted
  }

  // Fail closed on hunk-attribution loss: the global `@@` count from the diff
  // is authoritative. If per-file attribution (which depends on header-path
  // parsing) sums to fewer hunks, a header failed to parse and totals would be
  // silently understated — refuse rather than publish a wrong number.
  const attributedHunks = files.reduce((n, f) => n + f.hunks, 0)
  if (attributedHunks !== hunkTotalFromDiff) {
    throw new Error(
      `divergence: hunk attribution mismatch — global @@ count ${hunkTotalFromDiff} != sum of per-file hunks ${attributedHunks}. ` +
        `A diff header path likely failed to parse (quoted/renamed path). Refusing to emit understated totals.`,
    )
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    generatorVersion: GENERATOR_VERSION,
    generatedAt: opts.now ?? new Date().toISOString(),
    taxonomyVersion: TAXONOMY_VERSION,
    upstreamBaseRef,
    upstreamBaseSha: upstreamBase.sha,
    upstreamBaseTree: upstreamBase.tree,
    oursRef,
    oursSha: ours.sha,
    oursTree: ours.tree,
    diffOptions: DIFF_OPTIONS,
    totals: {
      files: files.length,
      hunks: files.reduce((n, f) => n + f.hunks, 0),
      added: files.reduce((n, f) => n + f.added, 0),
      deleted: files.reduce((n, f) => n + f.deleted, 0),
      binaryFiles: files.filter((f) => f.isBinary).length,
      renameFiles: files.filter((f) => f.isRename).length,
      testFiles: files.filter((f) => f.isTest).length,
      byBucket,
    },
    files,
  }
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

  const envelope = buildDivergence(repoRoot, upstreamBaseRef, oursRef)

  if (flag("--json")) {
    console.log(JSON.stringify(envelope, null, 2))
    return
  }

  log.banner("UPSTREAM DIVERGENCE")
  console.log(`upstream base:  ${envelope.upstreamBaseRef} (${envelope.upstreamBaseSha.slice(0, 12)})`)
  console.log(`ours:           ${envelope.oursRef} (${envelope.oursSha.slice(0, 12)})`)
  console.log(`generated:      ${envelope.generatedAt}`)
  console.log()
  console.log("=== TOTALS ===")
  console.log(
    `files changed: ${envelope.totals.files}, hunks: ${envelope.totals.hunks}, +${envelope.totals.added}/-${envelope.totals.deleted}` +
      `  (binary: ${envelope.totals.binaryFiles}, renames: ${envelope.totals.renameFiles}, tests: ${envelope.totals.testFiles})`,
  )
  console.log()
  console.log("=== BY BUCKET ===")
  for (const bucket of Object.keys(envelope.totals.byBucket) as Bucket[]) {
    const s = envelope.totals.byBucket[bucket]
    console.log(`  ${bucket.padEnd(30)} ${s.files} files, ${s.hunks} hunks, +${s.added}/-${s.deleted}`)
  }
}

if (import.meta.main) {
  main().catch((err) => {
    log.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
