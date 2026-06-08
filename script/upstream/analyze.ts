#!/usr/bin/env bun
/**
 * Upstream Merge Analysis & Verification
 *
 * Two modes of operation:
 *
 * 1. Version analysis — preview what would change for a specific upstream version
 *    bun run script/upstream/analyze.ts --version v1.2.21
 *
 * 2. Branding audit — scan the codebase for upstream branding that leaked through
 *    bun run script/upstream/analyze.ts --branding
 *    bun run script/upstream/analyze.ts --branding --verbose
 *
 * Exit codes:
 *   0 — No issues found
 *   1 — Branding leaks detected (useful for CI)
 *   2 — Error during analysis
 */

import { parseArgs } from "util"
import { $ } from "bun"
import fs from "fs"
import path from "path"
import * as git from "./utils/git"
import * as logger from "./utils/logger"
import { RESET, BOLD, DIM, CYAN, GREEN, RED, YELLOW, MAGENTA, bold, dim, cyan, banner } from "./utils/logger"
import { loadConfig, repoRoot, type MergeConfig } from "./utils/config"

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    version: { type: "string", short: "v" },
    branding: { type: "boolean", default: false },
    markers: { type: "boolean", default: false },
    "require-markers": { type: "boolean", default: false },
    "audit-fixes": { type: "boolean", default: false },
    strict: { type: "boolean", default: false },
    base: { type: "string" },
    verbose: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: false,
}) as any

// ---------------------------------------------------------------------------
// Branding leak detection
// ---------------------------------------------------------------------------

interface BrandingLeak {
  file: string
  line: number
  content: string
  pattern: string
}

interface BrandingReport {
  totalFiles: number
  scannedFiles: number
  leaks: BrandingLeak[]
  preservedLines: number
  timestamp: string
}

/**
 * Upstream branding patterns that should NOT appear in the codebase
 * (except in preserved contexts like npm package names).
 *
 * Two tiers:
 *   - "exact": always-fatal patterns (domains, social handles). Never legitimate.
 *   - "context": bare `opencode` patterns scoped to user-visible contexts (yargs
 *     describe text, console output, MCP client identity, workflow YAML, prompt
 *     placeholders). Caught the v1.4.0 bridge merge regressions in serve.ts,
 *     web.ts, uninstall.ts, error.ts, mcp.ts, github.ts, dialog-status.tsx,
 *     plugin/codex.ts UA strings, plugin/install.ts directory names, and 5+
 *     other sites where bare `opencode` strings shipped to production.
 */
const LEAK_PATTERNS = [
  // Always-fatal: domains, emails, registries, social handles
  { regex: /opencode\.ai/g, label: "opencode.ai (domain)" },
  { regex: /opncd\.ai/g, label: "opncd.ai (short domain)" },
  { regex: /anomalyco\//g, label: "anomalyco/ (GitHub org)" },
  { regex: /\bOpenCode\b/g, label: "OpenCode (product name)" },
  { regex: /bot@opencode/g, label: "bot@opencode (email)" },
  { regex: /opencode@sst\.dev/g, label: "opencode@sst.dev (email)" },
  { regex: /ai\.opencode\./g, label: "ai.opencode.* (app ID)" },
  { regex: /x\.com\/altaborodin/g, label: "altaborodin (social handle)" },
  { regex: /ghcr\.io\/anomalyco/g, label: "ghcr.io/anomalyco (container registry)" },

  // Context-scoped: bare `opencode` inside user-visible string literals.
  // These caught 13 of the 16 v1.4.0 bridge merge regressions.
  {
    regex: /describe:\s*["'`][^"'`]*\bopencode\b[^"'`]*["'`]/gi,
    label: "yargs describe: bare 'opencode' (shown in --help)",
  },
  {
    regex: /\b(?:console\.(?:log|warn|error|info)|UI\.println|prompts\.(?:log|outro)\.[a-zA-Z]+)\s*\(\s*[`"'][^`"']*\bopencode\b[^`"']*[`"']/gi,
    label: "console/UI output: bare 'opencode' (visible at runtime)",
  },
  {
    regex: /\bplaceholder:\s*["'`][^"'`]*\bopencode\s+[a-z]/gi,
    label: "input placeholder: bare 'opencode <cmd>' (TUI prompt example)",
  },
  {
    regex: /clientInfo\s*[:=]\s*\{[^}]*name:\s*["'`]opencode[-_]?[a-z]*["'`]/gi,
    label: "MCP clientInfo.name: 'opencode-...' (sent to remote MCP servers)",
  },
  {
    regex: /\b(?:User-Agent|user-agent)["'`]?\s*[:=]\s*[`"'][^`"']*\bopencode\/\$\{/g,
    label: "User-Agent header: 'opencode/${VERSION}' (sent to API providers)",
  },
  {
    regex: /["'`]opencode-(?:agent|debug|github-action|share|web-ui)\b/g,
    label: "opencode-{agent,debug,github-action,share,web-ui} (infrastructure identifier)",
  },
  {
    regex: /\bgetIDToken\s*\(\s*["'`]opencode-/g,
    label: "OIDC audience: 'opencode-...' (auth identity)",
  },
  {
    regex: /["'`]\.opencode\/opencode\.json/g,
    label: ".opencode/opencode.json hardcoded (new installs should land in .altimate-code/)",
  },
  {
    regex: /\bspawn\s*\(\s*\[?\s*["'`]opencode["'`]/g,
    label: "Process.spawn(\"opencode\"): wrong binary (we ship altimate-code)",
  },
  {
    regex: /^\s*name:\s*opencode\s*$/gm,
    label: "GitHub workflow YAML name: opencode (committed to user repos)",
  },
  {
    regex: /\bopencode-agent\[bot\]/g,
    label: "opencode-agent[bot]: GitHub App identity",
  },
]

/**
 * Check whether a line should be excluded from branding leak detection.
 */
function isPreservedLine(line: string, preservePatterns: string[]): boolean {
  return preservePatterns.some((pattern) => line.includes(pattern))
}

/**
 * Scan all tracked files for upstream branding patterns that should
 * have been transformed during the merge process.
 */
async function auditBranding(config: MergeConfig): Promise<BrandingReport> {
  const { minimatch } = await import("minimatch")
  const root = repoRoot()
  const trackedFiles = await git.getTrackedFiles()

  const report: BrandingReport = {
    totalFiles: trackedFiles.length,
    scannedFiles: 0,
    leaks: [],
    preservedLines: 0,
    timestamp: new Date().toISOString(),
  }

  for (const relFile of trackedFiles) {
    // Skip keepOurs files — they contain our own branding
    if (config.keepOurs.some((p) => minimatch(relFile, p))) continue

    // Skip non-text files
    const ext = path.extname(relFile).toLowerCase()
    if (!config.transformableExtensions.includes(ext)) continue

    const fullPath = path.join(root, relFile)
    if (!fs.existsSync(fullPath)) continue

    // Skip large files
    try {
      const stat = fs.statSync(fullPath)
      if (stat.size > 5 * 1024 * 1024) continue
    } catch {
      continue
    }

    let content: string
    try {
      content = fs.readFileSync(fullPath, "utf-8")
    } catch {
      continue
    }

    report.scannedFiles++

    const lines = content.split("\n")
    // Track whether we're inside an `altimate_change start ... altimate_change end`
    // block. Code inside markers is intentional altimate customization — referencing
    // upstream identifiers there (e.g. for upstream_fix comments, dual-config
    // fallback paths, dead-import explanations) is acknowledged, not a leak.
    let insideMarker = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      if (line.includes("altimate_change start")) {
        insideMarker = true
      }

      // Skip lines inside altimate_change blocks (counted as preserved for stats).
      if (insideMarker) {
        report.preservedLines++
        if (line.includes("altimate_change end")) insideMarker = false
        continue
      }

      // Skip preserved lines (npm package refs, internal identifiers, etc.)
      if (isPreservedLine(line, config.preservePatterns)) {
        report.preservedLines++
        continue
      }

      for (const { regex, label } of LEAK_PATTERNS) {
        regex.lastIndex = 0
        if (regex.test(line)) {
          report.leaks.push({
            file: relFile,
            line: i + 1,
            content: line.trim(),
            pattern: label,
          })
        }
      }
    }
  }

  return report
}

/**
 * Print a human-readable branding audit report.
 */
function printBrandingReport(report: BrandingReport, verbose: boolean): void {
  banner("Branding Audit Report")

  console.log(`  Files in repository:  ${report.totalFiles}`)
  console.log(`  Files scanned:        ${report.scannedFiles}`)
  console.log(`  Preserved lines:      ${report.preservedLines} ${dim("(skipped, contain internal refs)")}`)
  console.log(`  Leaks found:          ${report.leaks.length > 0 ? RED : GREEN}${report.leaks.length}${RESET}`)
  console.log()

  if (report.leaks.length === 0) {
    logger.success("No branding leaks detected — codebase is clean")
    return
  }

  // Group leaks by file
  const byFile = new Map<string, BrandingLeak[]>()
  for (const leak of report.leaks) {
    const existing = byFile.get(leak.file) || []
    existing.push(leak)
    byFile.set(leak.file, existing)
  }

  // Group leaks by pattern
  const byPattern = new Map<string, number>()
  for (const leak of report.leaks) {
    byPattern.set(leak.pattern, (byPattern.get(leak.pattern) || 0) + 1)
  }

  // Pattern summary
  console.log(`  ${bold("By pattern:")}`)
  for (const [pattern, count] of [...byPattern.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${YELLOW}${String(count).padStart(4)}${RESET}  ${pattern}`)
  }
  console.log()

  // File-by-file detail
  console.log(`  ${bold("By file:")} (${byFile.size} file(s))`)

  const maxFilesToShow = verbose ? byFile.size : 20
  let fileCount = 0

  for (const [file, leaks] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (fileCount >= maxFilesToShow) {
      console.log(`\n  ${DIM}... and ${byFile.size - maxFilesToShow} more file(s). Use --verbose to see all.${RESET}`)
      break
    }

    console.log(`\n  ${MAGENTA}${file}${RESET} (${leaks.length} leak(s))`)

    const maxLeaksToShow = verbose ? leaks.length : 5
    for (let i = 0; i < Math.min(leaks.length, maxLeaksToShow); i++) {
      const leak = leaks[i]
      const truncated = leak.content.length > 80 ? leak.content.slice(0, 77) + "..." : leak.content
      console.log(`    ${DIM}L${String(leak.line).padStart(4)}${RESET}  ${YELLOW}${leak.pattern}${RESET}`)
      console.log(`          ${DIM}${truncated}${RESET}`)
    }

    if (leaks.length > maxLeaksToShow) {
      console.log(`    ${DIM}... and ${leaks.length - maxLeaksToShow} more${RESET}`)
    }

    fileCount++
  }
}

// ---------------------------------------------------------------------------
// Version analysis
// ---------------------------------------------------------------------------

interface VersionAnalysis {
  version: string
  totalChanges: number
  categories: {
    keepOurs: string[]
    skipFiles: string[]
    lockFiles: string[]
    transformable: string[]
    passThrough: string[]
  }
  markerFiles: string[]
  potentialConflicts: string[]
}

async function analyzeVersion(version: string, config: MergeConfig): Promise<VersionAnalysis> {
  const { minimatch } = await import("minimatch")
  const root = repoRoot()

  // Ensure upstream is fetched
  const hasUpstream = await git.hasRemote(config.upstreamRemote)
  if (!hasUpstream) {
    logger.error(`Remote '${config.upstreamRemote}' not found`)
    logger.info(`Add it: git remote add ${config.upstreamRemote} https://github.com/${config.upstreamRepo}.git`)
    process.exit(2)
  }

  await git.fetchRemote(config.upstreamRemote)

  // Get changed files
  const diffOutput = await $`git diff --name-only HEAD...${version}`.cwd(root).text()
  const files = diffOutput.trim().split("\n").filter(Boolean)

  const analysis: VersionAnalysis = {
    version,
    totalChanges: files.length,
    categories: {
      keepOurs: [],
      skipFiles: [],
      lockFiles: [],
      transformable: [],
      passThrough: [],
    },
    markerFiles: [],
    potentialConflicts: [],
  }

  for (const file of files) {
    if (config.keepOurs.some((p) => minimatch(file, p))) {
      analysis.categories.keepOurs.push(file)
    } else if (config.skipFiles.some((p) => minimatch(file, p))) {
      analysis.categories.skipFiles.push(file)
    } else if (file === "bun.lock" || file.endsWith("/bun.lock")) {
      analysis.categories.lockFiles.push(file)
    } else {
      const ext = path.extname(file).toLowerCase()
      if (config.transformableExtensions.includes(ext)) {
        analysis.categories.transformable.push(file)
      } else {
        analysis.categories.passThrough.push(file)
      }
    }
  }

  // Check for marker files and potential conflicts
  for (const file of analysis.categories.transformable) {
    try {
      const content = await $`git show HEAD:${file}`
        .cwd(root)
        .text()
        .catch(() => "")

      if (content.includes(config.changeMarker)) {
        analysis.markerFiles.push(file)
      }

      // Check if we've modified this file (potential conflict)
      const ourDiff = await $`git diff HEAD -- ${file}`
        .cwd(root)
        .text()
        .catch(() => "")
      if (ourDiff.trim().length > 0) {
        analysis.potentialConflicts.push(file)
      }
    } catch {
      // File may not exist on HEAD
    }
  }

  return analysis
}

function printVersionAnalysis(analysis: VersionAnalysis): void {
  banner(`Version Analysis: ${analysis.version}`)

  const { categories } = analysis

  console.log(`  ${bold("Total files changed upstream:")} ${analysis.totalChanges}`)
  console.log()

  const cats = [
    { label: "Keep ours (auto-resolve)", files: categories.keepOurs, color: GREEN },
    { label: "Skip files (accept upstream)", files: categories.skipFiles, color: CYAN },
    { label: "Lock files (regenerate)", files: categories.lockFiles, color: YELLOW },
    { label: "Need branding transform", files: categories.transformable, color: MAGENTA },
    { label: "Pass-through (no transform)", files: categories.passThrough, color: DIM },
  ]

  for (const { label, files, color } of cats) {
    console.log(`  ${color}${label}:${RESET} ${files.length}`)
  }

  // Files with altimate_change markers
  if (analysis.markerFiles.length > 0) {
    console.log()
    console.log(`  ${bold("Files with altimate_change markers")} ${dim("(need careful review):")}`)
    for (const f of analysis.markerFiles) {
      console.log(`    ${YELLOW}marked${RESET}  ${f}`)
    }
  }

  // Potential conflicts
  if (analysis.potentialConflicts.length > 0) {
    console.log()
    console.log(`  ${bold("Potential conflicts")} ${dim("(we modified + upstream modified):")}`)
    for (const f of analysis.potentialConflicts) {
      console.log(`    ${RED}conflict${RESET}  ${f}`)
    }
  }

  // Summary
  console.log()
  const line = "─".repeat(50)
  console.log(`  ${line}`)
  console.log(`  ${bold("Merge estimate:")}`)
  console.log(
    `    Auto-resolvable:  ${GREEN}${categories.keepOurs.length + categories.skipFiles.length + categories.lockFiles.length}${RESET}`,
  )
  console.log(`    Need transform:   ${categories.transformable.length}`)
  console.log(
    `    Likely conflicts: ${analysis.potentialConflicts.length > 0 ? RED : GREEN}${analysis.potentialConflicts.length}${RESET}`,
  )
  console.log(
    `    Marker files:     ${analysis.markerFiles.length > 0 ? YELLOW : GREEN}${analysis.markerFiles.length}${RESET}`,
  )
  console.log()
}

// ---------------------------------------------------------------------------
// Marker analysis (from original analyze.ts)
// ---------------------------------------------------------------------------

interface MarkerBlock {
  file: string
  line: number
  startComment: string
  endLine: number | null
}

function findFilesRecursive(dir: string, extensions: string[]): string[] {
  const files: string[] = []
  if (!fs.existsSync(dir)) return files

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...findFilesRecursive(fullPath, extensions))
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      files.push(fullPath)
    }
  }

  return files
}

function findMarkers(config: MergeConfig): MarkerBlock[] {
  const marker = config.changeMarker
  const root = repoRoot()
  const blocks: MarkerBlock[] = []

  const srcDir = path.join(root, "packages", "opencode", "src")
  const files = findFilesRecursive(srcDir, [".ts", ".tsx", ".json", ".txt"])

  for (const file of files) {
    const relPath = path.relative(root, file)
    // Skip our own code directory
    if (relPath.includes("src/altimate/")) continue

    const content = fs.readFileSync(file, "utf-8")
    const lines = content.split("\n")

    let openBlock: MarkerBlock | null = null

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      if (line.includes(`${marker} start`)) {
        openBlock = {
          file: relPath,
          line: i + 1,
          startComment: line.trim(),
          endLine: null,
        }
      } else if (line.includes(`${marker} end`) && openBlock) {
        openBlock.endLine = i + 1
        blocks.push(openBlock)
        openBlock = null
      }
    }

    // Unclosed marker block
    if (openBlock) {
      blocks.push(openBlock)
    }
  }

  return blocks
}

function printMarkerAnalysis(config: MergeConfig): void {
  console.log(`\n${bold("=== altimate_change Marker Analysis ===")}`)
  console.log()

  const markers = findMarkers(config)
  const complete = markers.filter((m) => m.endLine !== null)
  const incomplete = markers.filter((m) => m.endLine === null)

  console.log(
    `  Found ${bold(String(markers.length))} marker blocks in ${new Set(markers.map((m) => m.file)).size} files`,
  )
  console.log(`  ${GREEN}Complete (start + end):${RESET} ${complete.length}`)

  if (incomplete.length > 0) {
    console.log(`  ${RED}Incomplete (missing end):${RESET} ${incomplete.length}`)
    for (const m of incomplete) {
      console.log(`    ${RED}unclosed${RESET}  ${m.file}:${m.line}`)
      console.log(`              ${DIM}${m.startComment}${RESET}`)
    }
  }

  // List all marked files
  const fileSet = new Set(markers.map((m) => m.file))
  console.log()
  console.log(`  ${bold("Files with markers:")}`)
  for (const f of [...fileSet].sort()) {
    const count = markers.filter((m) => m.file === f).length
    console.log(`    ${f} (${count} block${count > 1 ? "s" : ""})`)
  }

  // Summary
  console.log()
  console.log(
    `  ${bold("Integrity:")} ${
      incomplete.length === 0
        ? `${GREEN}All blocks properly closed${RESET}`
        : `${RED}${incomplete.length} unclosed block(s)${RESET}`
    }`,
  )
}

// ---------------------------------------------------------------------------
// Upstream fix audit (--audit-fixes)
// ---------------------------------------------------------------------------

function auditUpstreamFixes(config: MergeConfig): void {
  const markers = findMarkers(config)
  const fixes = markers.filter((m) => m.startComment.includes("upstream_fix:"))

  console.log()
  console.log(bold("=== Upstream Bug Fixes We're Carrying ==="))
  console.log()

  if (fixes.length === 0) {
    console.log(`  ${GREEN}No upstream_fix: markers found.${RESET}`)
    console.log(`  All our markers are feature additions, not bug fixes.`)
    console.log()
    return
  }

  console.log(`  Found ${bold(String(fixes.length))} upstream bug fix(es) to review before merge:\n`)

  for (const fix of fixes) {
    // Extract description after "upstream_fix:"
    const desc = fix.startComment.replace(/.*upstream_fix:\s*/, "").replace(/\s*\*\/\s*$/, "")
    const lines = fix.endLine ? `${fix.line}-${fix.endLine}` : `${fix.line}`
    console.log(`  ${YELLOW}fix${RESET}  ${fix.file}:${lines}`)
    console.log(`        ${desc}`)
    console.log()
  }

  console.log(`  ${bold("Before each upstream merge:")}`)
  console.log(`    1. Check if upstream fixed each issue in their release`)
  console.log(`    2. If fixed upstream: accept their version, remove our marker`)
  console.log(`    3. If not fixed: keep our marker (it will survive the merge)`)
  console.log()
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`
  ${bold("Upstream Merge Analyzer")} — Analyze changes and verify branding

  ${bold("USAGE")}
    bun run script/upstream/analyze.ts --version <tag>    Analyze upstream version
    bun run script/upstream/analyze.ts --branding         Audit for branding leaks

  ${bold("OPTIONS")}
    --version, -v <tag>   Upstream version to analyze
    --branding            Scan codebase for upstream branding leaks
    --markers             Check changed files for missing altimate_change markers
    --audit-fixes         List all upstream_fix: markers (bug fixes we made to upstream code)
    --base <branch>       Base branch for --markers comparison (default: HEAD)
    --strict              Exit with code 1 on warnings (for CI)
    --verbose             Show all results (not just top 20)
    --json                Output results as JSON
    --help, -h            Show this help message

  ${bold("EXAMPLES")}
    ${dim("# Preview what would change in a merge")}
    bun run script/upstream/analyze.ts --version v1.2.21

    ${dim("# Check for branding leaks after a merge")}
    bun run script/upstream/analyze.ts --branding

    ${dim("# Full branding audit with all details")}
    bun run script/upstream/analyze.ts --branding --verbose

    ${dim("# Check PR for missing markers (CI)")}
    bun run script/upstream/analyze.ts --markers --base main --strict

    ${dim("# List upstream bug fixes we're carrying (review before merge)")}
    bun run script/upstream/analyze.ts --audit-fixes

    ${dim("# Machine-readable output for CI")}
    bun run script/upstream/analyze.ts --branding --json
`)
}

// ---------------------------------------------------------------------------
// CI marker guard (--markers mode, formerly check-markers.ts)
// ---------------------------------------------------------------------------

interface MarkerWarning {
  file: string
  line: number
  context: string
  reason: string
}

function getChangedFiles(base?: string): string[] {
  const { execSync } = require("child_process")
  const root = repoRoot()
  // Only check Modified files (M), not Added (A). New files don't exist
  // upstream so they can't be overwritten by a merge — no markers needed.
  const cmd = base ? `git diff --name-only --diff-filter=M ${base}...HEAD` : `git diff --name-only --diff-filter=M HEAD`
  try {
    return execSync(cmd, { cwd: root, encoding: "utf-8" }).trim().split("\n").filter(Boolean)
  } catch {
    return []
  }
}

// Cache for upstream file existence checks (populated on first use)
let _upstreamFilesCache: Set<string> | null = null

function getUpstreamFiles(config: MergeConfig): Set<string> {
  if (_upstreamFilesCache) return _upstreamFilesCache
  const { execSync } = require("child_process")
  const root = repoRoot()
  const refs = [`${config.upstreamRemote}/dev`, `${config.upstreamRemote}/main`]
  for (const ref of refs) {
    try {
      const output = execSync(`git ls-tree -r --name-only ${ref}`, {
        cwd: root,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      })
      _upstreamFilesCache = new Set(output.trim().split("\n").filter(Boolean))
      return _upstreamFilesCache
    } catch {
      // ref not available, try next
    }
  }
  // Upstream not available — return empty set (all files treated as ours-only)
  _upstreamFilesCache = new Set()
  return _upstreamFilesCache
}

// altimate_change start — exclude test files, generated code, and config files from marker checks
const markerExcludePatterns = [
  "**/test/**",
  "**/tests/**",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.spec.ts",
  "**/tsconfig.json",
  "**/package.json",
  "packages/sdk/js/src/gen/**",
  "packages/sdk/js/src/v2/gen/**",
  "packages/sdk/openapi.json",
  "packages/script/**",
  "script/**",
]
// altimate_change end

function isUpstreamShared(file: string, config: MergeConfig): boolean {
  const { minimatch } = require("minimatch")
  if (config.keepOurs.some((p: string) => minimatch(file, p))) return false
  if (config.skipFiles.some((p: string) => minimatch(file, p))) return false
  // altimate_change start — skip files that don't need marker protection
  if (markerExcludePatterns.some((p) => minimatch(file, p))) return false
  // altimate_change end
  const ext = path.extname(file)
  if (!config.transformableExtensions.includes(ext)) return false

  // Only flag files that actually exist in upstream. Files we created
  // that don't exist upstream can't be overwritten by a merge.
  const upstreamFiles = getUpstreamFiles(config)
  if (upstreamFiles.size === 0) {
    // Fallback: if upstream isn't available, use directory heuristic
    return file.startsWith("packages/opencode/src/")
  }
  return upstreamFiles.has(file)
}

// altimate_change start — exported for unit testing
/**
 * Compute the set of 1-based line numbers in `content` that are covered by an
 * `altimate_change start … altimate_change end` block (the marker lines
 * themselves are covered too). A depth counter handles nested blocks, so an
 * inner start/end pair inside an outer one is tracked correctly.
 *
 * This is derived from the FULL file, independent of any diff context window —
 * which is the whole point. The diff-based tracker in
 * `parseDiffForMarkerWarnings` only sees ±N context lines around a change, so a
 * line modified deep inside a large pre-existing marked block (its `start`
 * marker outside the hunk) looks unmarked and false-positives. Passing the
 * full-file coverage in lets the parser suppress those false positives.
 */
export function computeMarkedLines(content: string): Set<number> {
  const marked = new Set<number>()
  const lines = content.split("\n")
  let depth = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.includes("altimate_change start")) {
      depth++
      marked.add(i + 1)
      continue
    }
    if (line.includes("altimate_change end")) {
      marked.add(i + 1)
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth > 0) marked.add(i + 1)
  }
  return marked
}

export function parseDiffForMarkerWarnings(
  file: string,
  diffOutput: string,
  markedLines?: Set<number>,
): MarkerWarning[] {
  const warnings: MarkerWarning[] = []
  if (!diffOutput.trim()) return warnings

  const lines = diffOutput.split("\n")
  let inMarkerBlock = false
  let currentLine = 0
  let hasNewCode = false
  let newCodeStart = 0
  let newCodeContext = ""

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/)
    if (hunkMatch) {
      currentLine = parseInt(hunkMatch[1]) - 1
      // Reset marker state at hunk boundaries — hunks are discontinuous
      // regions of the file, so marker blocks from one region don't apply
      // to another.
      inMarkerBlock = false
      continue
    }

    // altimate_change start — fix: track marker state from context lines, not just added lines
    if (line.startsWith("-") && !line.startsWith("---")) {
      // deleted line, don't increment
      continue
    }

    // Both added (+) and context ( ) lines appear in the final file,
    // so both must update marker state. Without this, existing markers
    // on context lines are invisible and new code next to them looks
    // unmarked — causing false positives.
    const isAdded = line.startsWith("+") && !line.startsWith("+++")
    const isContext = !line.startsWith("+") && !line.startsWith("-") && !line.startsWith("\\")

    if (isAdded || isContext) {
      currentLine++
      const content = line.slice(1).trim()

      if (content.includes("altimate_change start")) {
        inMarkerBlock = true
        continue
      }
      if (content.includes("altimate_change end")) {
        inMarkerBlock = false
        continue
      }
      if (content.includes("altimate_change")) continue

      // Only flag added lines as violations — context lines are pre-existing
      if (!isAdded) continue

      if (!content) continue
      if (content.startsWith("//") && !content.includes("TODO")) continue
      if (content.startsWith("import ")) continue
      if (content.startsWith("export ")) continue

      // A line is covered if either the in-hunk tracker saw its enclosing
      // `start` marker, OR the full-file coverage map (when provided) says this
      // line sits inside a marked block. The full-file map is what rescues
      // changes whose `start` marker lives outside the diff's context window.
      const coveredByFullFile = markedLines?.has(currentLine) ?? false
      if (!inMarkerBlock && !coveredByFullFile) {
        if (!hasNewCode) {
          hasNewCode = true
          newCodeStart = currentLine
          newCodeContext = content
        }
      }
    }
    // altimate_change end
  }

  if (hasNewCode) {
    warnings.push({
      file,
      line: newCodeStart,
      context: newCodeContext.slice(0, 80),
      reason: "New code added to upstream-shared file without altimate_change markers",
    })
  }

  return warnings
}
// altimate_change end

function checkFileForMarkers(file: string, base?: string): MarkerWarning[] {
  const { execSync } = require("child_process")
  const root = repoRoot()

  const diffCmd = base ? `git diff -U5 ${base}...HEAD -- "${file}"` : `git diff -U5 HEAD -- "${file}"`

  let diffOutput: string
  try {
    diffOutput = execSync(diffCmd, { cwd: root, encoding: "utf-8" })
  } catch {
    return []
  }

  // Coverage from the FULL post-change file, so a change deep inside a
  // pre-existing marked block isn't false-flagged just because its `start`
  // marker fell outside the diff's ±5-line context window. The "new" side is
  // HEAD when diffing against a base, or the working tree otherwise — matching
  // the side the `+`/context line numbers in the diff refer to.
  let markedLines: Set<number> | undefined
  try {
    const newContent = base
      ? execSync(`git show HEAD:"${file}"`, { cwd: root, encoding: "utf-8" })
      : require("fs").readFileSync(require("path").join(root, file), "utf-8")
    markedLines = computeMarkedLines(newContent)
  } catch {
    markedLines = undefined
  }

  return parseDiffForMarkerWarnings(file, diffOutput, markedLines)
}

function runMarkerCheck(config: MergeConfig, base?: string, strict?: boolean): number {
  const { execSync } = require("child_process")
  const root = repoRoot()

  // Ensure upstream remote exists and is fetched so we can check file existence
  try {
    execSync(`git remote get-url ${config.upstreamRemote}`, { cwd: root, stdio: "ignore" })
    execSync(`git fetch ${config.upstreamRemote} --quiet`, { cwd: root, stdio: "ignore" })
  } catch {
    // If upstream remote doesn't exist, fall back to pattern-only checks
    logger.warn(`Could not fetch '${config.upstreamRemote}' remote — falling back to pattern-based detection`)
  }

  const changedFiles = getChangedFiles(base)
  const sharedFiles = changedFiles.filter((f) => isUpstreamShared(f, config))

  if (sharedFiles.length === 0) {
    logger.success("No upstream-shared files modified — no markers needed")
    return 0
  }

  console.log(`Checking ${sharedFiles.length} upstream-shared file(s) for altimate_change markers...\n`)

  const allWarnings: MarkerWarning[] = []
  for (const file of sharedFiles) {
    const warnings = checkFileForMarkers(file, base)
    allWarnings.push(...warnings)
  }

  if (allWarnings.length === 0) {
    logger.success("All custom code in upstream-shared files is properly marked")
    return 0
  }

  console.log(`\n${YELLOW}⚠ Found ${allWarnings.length} file(s) with unmarked custom code:${RESET}\n`)
  for (const w of allWarnings) {
    console.log(`  ${w.file}:${w.line}`)
    console.log(`    ${w.reason}`)
    console.log(`    Context: ${DIM}${w.context}${RESET}`)
    console.log()
  }
  console.log("Wrap custom code with markers to protect from upstream overwrites:")
  console.log(`  ${DIM}// altimate_change start — description${RESET}`)
  console.log(`  ${DIM}... your code ...${RESET}`)
  console.log(`  ${DIM}// altimate_change end${RESET}`)
  console.log()

  if (strict) {
    logger.error("--strict mode — failing CI")
    return 1
  }
  logger.warn("Run with --strict to enforce in CI")
  return 0
}

// ---------------------------------------------------------------------------
// Require-markers check
// ---------------------------------------------------------------------------

/**
 * Verify that every file in `requireMarkers` has at least one
 * `altimate_change` block. These files are known to hold altimate
 * customizations and the bridge merge tool relies on the markers to
 * preserve them. If a marker block is dropped (e.g., during a manual
 * merge or refactor) the next bridge merge would silently overwrite
 * the patch — the v1.4.0 regression mode.
 *
 * Returns 0 if all files have markers, 1 if any file is missing markers
 * (in --strict mode), 0 otherwise (warning only).
 */
function runRequireMarkersCheck(config: MergeConfig, strict?: boolean): number {
  banner("Require-Markers Check")

  const root = repoRoot()
  const missing: { file: string; reason: string }[] = []

  for (const rel of config.requireMarkers) {
    const abs = path.join(root, rel)
    if (!fs.existsSync(abs)) {
      missing.push({ file: rel, reason: "file not found" })
      continue
    }
    let content: string
    try {
      content = fs.readFileSync(abs, "utf-8")
    } catch (e) {
      missing.push({ file: rel, reason: `read failed: ${e instanceof Error ? e.message : String(e)}` })
      continue
    }
    const startCount = (content.match(/altimate_change start/g) ?? []).length
    const endCount = (content.match(/altimate_change end/g) ?? []).length
    if (startCount === 0) {
      missing.push({ file: rel, reason: "no altimate_change blocks" })
    } else if (startCount !== endCount) {
      missing.push({ file: rel, reason: `unbalanced markers (${startCount} starts, ${endCount} ends)` })
    }
  }

  console.log(`  Files in requireMarkers list: ${config.requireMarkers.length}`)
  console.log(`  Files with valid markers:     ${config.requireMarkers.length - missing.length}`)
  console.log(`  Files missing markers:        ${missing.length > 0 ? RED : GREEN}${missing.length}${RESET}`)
  console.log()

  if (missing.length === 0) {
    logger.success("All behavior-patched files have markers")
    return 0
  }

  console.log(`${BOLD}Files that lost their altimate_change markers:${RESET}`)
  for (const { file, reason } of missing) {
    console.log(`  ${RED}${file}${RESET}  ${dim(`(${reason})`)}`)
  }
  console.log()
  console.log(`${dim("These files are listed in `requireMarkers` (script/upstream/utils/config.ts)")}`)
  console.log(`${dim("because they hold altimate behavioral patches that must be preserved on every")}`)
  console.log(`${dim("upstream merge. Restore the missing markers or add the patches back.")}`)
  console.log()

  if (strict) {
    logger.error("--strict mode — failing CI")
    return 1
  }
  logger.warn("Run with --strict to enforce in CI")
  return 0
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (args.help) {
    printUsage()
    process.exit(0)
  }

  const config = loadConfig()

  const hasVersion = Boolean(args.version)
  const hasBranding = Boolean(args.branding)
  const hasMarkers = Boolean(args.markers)
  const hasRequireMarkers = Boolean(args["require-markers"])
  const hasAuditFixes = Boolean(args["audit-fixes"])

  if (!hasVersion && !hasBranding && !hasMarkers && !hasRequireMarkers && !hasAuditFixes) {
    // Default: run marker analysis
    printMarkerAnalysis(config)

    console.log()
    logger.info("Use --version <tag> to analyze an upstream version")
    logger.info("Use --branding to audit for branding leaks")
    logger.info("Use --markers --base main to check for missing markers")
    logger.info("Use --require-markers to verify behavior-patched files keep their markers")
    logger.info("Use --audit-fixes to list upstream bug fixes we're carrying")
    return
  }

  // ─── Upstream fix audit ──────────────────────────────────────────────────
  if (hasAuditFixes) {
    auditUpstreamFixes(config)
    if (!hasVersion && !hasBranding && !hasMarkers) return
  }

  // ─── Version analysis ──────────────────────────────────────────────────────

  if (hasVersion) {
    const analysis = await analyzeVersion(args.version!, config)

    if (args.json) {
      console.log(JSON.stringify(analysis, null, 2))
    } else {
      printVersionAnalysis(analysis)
    }
  }

  // ─── Branding audit ────────────────────────────────────────────────────────

  if (hasBranding) {
    logger.info("Scanning codebase for upstream branding leaks...")
    const report = await auditBranding(config)

    if (args.json) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      printBrandingReport(report, Boolean(args.verbose))
    }

    // Also run marker analysis when doing branding audit
    if (!args.json) {
      printMarkerAnalysis(config)
    }

    // Exit with code 1 if leaks found (useful for CI)
    if (report.leaks.length > 0) {
      process.exit(1)
    }
  }

  // ─── Marker guard (CI mode) ───────────────────────────────────────────────

  if (hasMarkers) {
    const exitCode = runMarkerCheck(config, args.base, Boolean(args.strict))
    if (exitCode !== 0) {
      process.exit(exitCode)
    }
  }

  // ─── Require-markers (regression backstop) ────────────────────────────────

  if (hasRequireMarkers) {
    const exitCode = runRequireMarkersCheck(config, Boolean(args.strict))
    if (exitCode !== 0) {
      process.exit(exitCode)
    }
  }
}

// altimate_change start — guard CLI execution when imported as a module (e.g., by tests)
if (import.meta.main) {
  main().catch((e) => {
    logger.error(`Analysis failed: ${e.message || e}`)
    process.exit(2)
  })
}
// altimate_change end
