#!/usr/bin/env bun
/**
 * Verify restructured branch completeness.
 *
 * Compares custom code between the old branch (prep/revert-at-main) and the
 * restructured branch (restructure/main) to ensure nothing was lost during
 * the restructure. All comparisons use `git show` — no checkout needed.
 *
 * Usage:
 *   bun run script/upstream/verify-restructure.ts
 *   bun run script/upstream/verify-restructure.ts --base v1.2.18 --source prep/revert-at-main --target restructure/main
 *   bun run script/upstream/verify-restructure.ts --json
 */

import { parseArgs } from "util"
import { git, gitSafe, tagExists, branchExists } from "./utils/git"
import { loadConfig, repoRoot } from "./utils/config"

const { values: args } = parseArgs({
  options: {
    base: { type: "string", default: "v1.2.18" },
    source: { type: "string", default: "prep/revert-at-main" },
    target: { type: "string", default: "restructure/main" },
    json: { type: "boolean", default: false },
    strict: { type: "boolean", default: true },
    "no-strict": { type: "boolean", default: false },
  },
  strict: false,
}) as any

// ─── Types ───────────────────────────────────────────────────────────────────

type FileStatus = "A" | "M" | "D" | "R"

interface DiffEntry {
  status: FileStatus
  path: string
  /** For renames, the destination path */
  renamedTo?: string
}

type VerifyResult = "MATCH" | "MOVED" | "MODIFIED" | "MISSING"

interface FileVerification {
  sourcePath: string
  targetPath: string
  result: VerifyResult
  category: string
  diff?: string
}

interface MarkerBlock {
  file: string
  startLine: number
  endLine: number | null
  content: string
}

interface MarkerVerification {
  file: string
  totalBlocks: number
  closedBlocks: number
  unclosedBlocks: number
  blocks: MarkerBlock[]
}

interface VerificationReport {
  summary: {
    totalExamined: number
    match: number
    moved: number
    modified: number
    missing: number
  }
  categories: Record<string, { expected: number; verified: number }>
  markers: {
    totalFiles: number
    totalBlocks: number
    allClosed: boolean
    unclosed: MarkerBlock[]
  }
  newFiles: string[]
  results: FileVerification[]
  exitCode: number
}

// ─── Path Mapping ────────────────────────────────────────────────────────────

const TOOL_PREFIXES = [
  "altimate-core-",
  "sql-",
  "warehouse-",
  "schema-",
  "finops-",
  "dbt-",
  "lineage-",
  "project-scan",
]

const CUSTOM_PROMPTS = new Set([
  "analyst.txt",
  "builder.txt",
])

/**
 * Explicit path overrides for files that moved to non-pattern locations.
 * Key = source path (prep/revert-at-main), Value = target path (restructure/main).
 */
const EXPLICIT_MOVES: Record<string, string> = {
  "packages/opencode/bin/altimate-code": "packages/opencode/bin/altimate",
  "packages/opencode/src/cli/cmd/engine.ts": "packages/opencode/src/altimate/cli/engine.ts",
  "packages/opencode/src/cli/cmd/tui/context/theme/altimate-code.json": "packages/opencode/src/altimate/cli/theme/altimate-code.json",
  "packages/opencode/src/plugin/anthropic.ts": "packages/opencode/src/altimate/plugin/anthropic.ts",
  "packages/opencode/src/session/PAID_CONTEXT_FEATURES.md": "packages/opencode/src/altimate/session/PAID_CONTEXT_FEATURES.md",
  ".github/PULL_REQUEST_TEMPLATE.md": ".github/pull_request_template.md",
}

/**
 * Files intentionally excluded from the restructured branch.
 */
const INTENTIONALLY_EXCLUDED = new Set([
  "PROGRESS.md", // Progress tracking doc, not part of final restructure
])

/**
 * Map a source path (prep/revert-at-main) to its expected target path (restructure/main).
 */
function mapPath(sourcePath: string): string {
  // Check explicit overrides first
  if (EXPLICIT_MOVES[sourcePath]) {
    return EXPLICIT_MOVES[sourcePath]
  }

  // Custom tools: src/tool/<name>.ts → src/altimate/tools/<name>.ts
  const toolMatch = sourcePath.match(/^packages\/opencode\/src\/tool\/(.+)$/)
  if (toolMatch) {
    const filename = toolMatch[1]
    if (TOOL_PREFIXES.some((p) => filename.startsWith(p))) {
      return `packages/opencode/src/altimate/tools/${filename}`
    }
    // Non-custom tools stay at same path (verified via altimate_change markers)
    return sourcePath
  }

  // Bridge files: src/bridge/* → src/altimate/bridge/*
  const bridgeMatch = sourcePath.match(/^packages\/opencode\/src\/bridge\/(.+)$/)
  if (bridgeMatch) {
    return `packages/opencode/src/altimate/bridge/${bridgeMatch[1]}`
  }

  // Custom prompts (exactly 5 files): src/agent/prompt/<name> → src/altimate/prompts/<name>
  const promptMatch = sourcePath.match(/^packages\/opencode\/src\/agent\/prompt\/(.+)$/)
  if (promptMatch && CUSTOM_PROMPTS.has(promptMatch[1])) {
    return `packages/opencode/src/altimate/prompts/${promptMatch[1]}`
  }

  // Everything else: same path
  return sourcePath
}

/**
 * Categorize a source file path for reporting.
 */
function categorize(sourcePath: string): string {
  if (sourcePath.match(/^packages\/opencode\/src\/tool\//) &&
      TOOL_PREFIXES.some((p) => sourcePath.includes(`/tool/${p}`) || sourcePath.endsWith(`/tool/project-scan.ts`))) {
    return "Altimate tools"
  }
  if (sourcePath.startsWith("packages/opencode/src/bridge/")) return "Bridge files"
  if (sourcePath.match(/^packages\/opencode\/src\/agent\/prompt\//) && CUSTOM_PROMPTS.has(sourcePath.split("/").pop()!)) {
    return "Prompts"
  }
  if (sourcePath.includes("altimate/telemetry/") || sourcePath.includes("src/telemetry/")) return "Telemetry"
  if (sourcePath.startsWith("packages/altimate-engine/")) return "Python engine"
  if (sourcePath.startsWith(".opencode/skills/")) return "Skills"
  if (sourcePath.startsWith("experiments/")) return "Experiments"
  if (sourcePath.startsWith(".github/workflows/")) return "CI/CD workflows"
  if (sourcePath.startsWith(".github/")) return "GitHub config"
  if (sourcePath.startsWith("docs/")) return "Docs"
  if (sourcePath.startsWith("packages/opencode/test/")) return "Tests"
  if (sourcePath.startsWith("script/upstream/")) return "Merge tooling"
  return "Other"
}

// ─── Git Helpers ─────────────────────────────────────────────────────────────

function getFileContent(branch: string, path: string): string | null {
  return gitSafe(`show ${branch}:${path}`)
}

function getBlobHash(branch: string, path: string): string | null {
  return gitSafe(`rev-parse ${branch}:${path}`)
}

function listTree(branch: string, path: string): string[] {
  const output = gitSafe(`ls-tree -r --name-only ${branch} -- ${path}`)
  if (!output) return []
  return output.split("\n").filter(Boolean)
}

function normalize(content: string): string {
  return content.replace(/\r\n/g, "\n")
}

function isBinaryPath(path: string): boolean {
  const binaryExts = [".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".pyc", ".whl", ".gz", ".zip", ".tar"]
  return binaryExts.some((ext) => path.endsWith(ext))
}

// ─── Custom File Inventory ───────────────────────────────────────────────────

function getCustomFiles(base: string, source: string): DiffEntry[] {
  const output = git(`diff --name-status --find-renames=100% ${base}..${source}`)
  const entries: DiffEntry[] = []

  for (const line of output.split("\n").filter(Boolean)) {
    const parts = line.split("\t")
    const status = parts[0]

    if (status === "D") continue // Deleted from upstream = not custom code

    if (status.startsWith("R")) {
      // Rename: R100\told-path\tnew-path
      entries.push({
        status: "R",
        path: parts[2], // The destination (current) path
        renamedTo: parts[2],
      })
    } else {
      entries.push({
        status: status as FileStatus,
        path: parts[1],
      })
    }
  }

  return entries
}

// ─── Verification Logic ──────────────────────────────────────────────────────

function verifyFile(entry: DiffEntry, source: string, target: string): FileVerification {
  const sourcePath = entry.path
  const targetPath = mapPath(sourcePath)
  const category = categorize(sourcePath)
  const moved = sourcePath !== targetPath

  // Binary files: compare blob hashes
  if (isBinaryPath(sourcePath)) {
    const sourceHash = getBlobHash(source, sourcePath)
    const targetHash = getBlobHash(target, targetPath)

    if (!targetHash) {
      return { sourcePath, targetPath, result: "MISSING", category }
    }
    if (sourceHash === targetHash) {
      return { sourcePath, targetPath, result: moved ? "MOVED" : "MATCH", category }
    }
    return { sourcePath, targetPath, result: "MODIFIED", category, diff: `blob hash: ${sourceHash} → ${targetHash}` }
  }

  // Text files: compare normalized content
  const sourceContent = getFileContent(source, sourcePath)
  const targetContent = getFileContent(target, targetPath)

  if (sourceContent === null) {
    // Source file doesn't exist (shouldn't happen for A/M entries)
    return { sourcePath, targetPath, result: "MISSING", category, diff: "Source file not found" }
  }

  if (targetContent === null) {
    return { sourcePath, targetPath, result: "MISSING", category }
  }

  if (normalize(sourceContent) === normalize(targetContent)) {
    return { sourcePath, targetPath, result: moved ? "MOVED" : "MATCH", category }
  }

  // Content differs — generate short diff summary
  const diffOutput = gitSafe(`diff ${source}:${sourcePath} ${target}:${targetPath}`)
  const diffLines = diffOutput?.split("\n") || []
  const added = diffLines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length
  const removed = diffLines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length

  return {
    sourcePath,
    targetPath,
    result: "MODIFIED",
    category,
    diff: `+${added}/-${removed} lines`,
  }
}

// ─── Marker Verification ────────────────────────────────────────────────────

function verifyMarkers(target: string): MarkerVerification[] {
  const config = loadConfig()
  const marker = config.changeMarker
  const results: MarkerVerification[] = []

  // Known files with markers
  const markerFiles = [
    "packages/opencode/src/tool/registry.ts",
    "packages/opencode/src/agent/agent.ts",
    "packages/opencode/src/config/config.ts",
    "packages/opencode/src/config/paths.ts",
    "packages/opencode/src/flag/flag.ts",
    "packages/opencode/src/global/index.ts",
    "packages/opencode/src/index.ts",
    "packages/opencode/src/installation/index.ts",
    "packages/opencode/src/telemetry/index.ts",
  ]

  // Also scan for any markers we might have missed
  const allSrcFiles = listTree(target, "packages/opencode/src/")
    .filter((f) => !f.includes("src/altimate/"))
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx") || f.endsWith(".json") || f.endsWith(".txt"))

  const filesToCheck = new Set([...markerFiles, ...allSrcFiles])

  for (const file of filesToCheck) {
    const content = getFileContent(target, file)
    if (!content || !content.includes(marker)) continue

    const lines = content.split("\n")
    const blocks: MarkerBlock[] = []
    let openBlock: { startLine: number; contentLines: string[] } | null = null

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      if (line.includes(`${marker} start`)) {
        openBlock = { startLine: i + 1, contentLines: [] }
      } else if (line.includes(`${marker} end`)) {
        if (openBlock) {
          blocks.push({
            file,
            startLine: openBlock.startLine,
            endLine: i + 1,
            content: openBlock.contentLines.join("\n"),
          })
          openBlock = null
        }
      } else if (openBlock) {
        openBlock.contentLines.push(line)
      }
    }

    // Unclosed block
    if (openBlock) {
      blocks.push({
        file,
        startLine: openBlock.startLine,
        endLine: null,
        content: openBlock.contentLines.join("\n"),
      })
    }

    const closedBlocks = blocks.filter((b) => b.endLine !== null).length
    const unclosedBlocks = blocks.filter((b) => b.endLine === null).length

    results.push({
      file,
      totalBlocks: blocks.length,
      closedBlocks,
      unclosedBlocks,
      blocks,
    })
  }

  return results
}

// ─── New Files Detection ─────────────────────────────────────────────────────

function findNewFiles(base: string, source: string, target: string): string[] {
  // Files on target that are NOT on source (intentional additions during restructure)
  const targetDiff = git(`diff --name-status --find-renames=100% ${base}..${target}`)
  const targetAdded = new Set<string>()
  for (const line of targetDiff.split("\n").filter(Boolean)) {
    const parts = line.split("\t")
    if (parts[0] === "A" || parts[0].startsWith("R")) {
      targetAdded.add(parts[0].startsWith("R") ? parts[2] : parts[1])
    }
  }

  const sourceDiff = git(`diff --name-status --find-renames=100% ${base}..${source}`)
  const sourceAdded = new Set<string>()
  for (const line of sourceDiff.split("\n").filter(Boolean)) {
    const parts = line.split("\t")
    if (parts[0] === "A" || parts[0].startsWith("R")) {
      sourceAdded.add(parts[0].startsWith("R") ? parts[2] : parts[1])
    }
  }

  // Also account for path mappings: a file "added" on target at altimate/tools/foo.ts
  // corresponds to tool/foo.ts on source via path mapping.
  // Build reverse map of all target paths that source files map to.
  const mappedTargetPaths = new Set<string>()
  for (const srcFile of sourceAdded) {
    mappedTargetPaths.add(mapPath(srcFile))
  }
  // Also add explicit move targets
  for (const t of Object.values(EXPLICIT_MOVES)) {
    mappedTargetPaths.add(t)
  }

  const newFiles: string[] = []
  for (const file of targetAdded) {
    if (sourceAdded.has(file)) continue
    if (mappedTargetPaths.has(file)) continue
    newFiles.push(file)
  }

  return newFiles.sort()
}

// ─── Python Engine Verification ──────────────────────────────────────────────

function verifyPythonEngine(source: string, target: string): FileVerification[] {
  const sourceFiles = listTree(source, "packages/altimate-engine")
  const targetFiles = listTree(target, "packages/altimate-engine")
  const results: FileVerification[] = []

  const targetSet = new Set(targetFiles)

  for (const file of sourceFiles) {
    if (!targetSet.has(file)) {
      results.push({
        sourcePath: file,
        targetPath: file,
        result: "MISSING",
        category: "Python engine",
      })
      continue
    }

    // Compare blob hashes for efficiency
    const sourceHash = getBlobHash(source, file)
    const targetHash = getBlobHash(target, file)

    if (sourceHash === targetHash) {
      results.push({
        sourcePath: file,
        targetPath: file,
        result: "MATCH",
        category: "Python engine",
      })
    } else {
      const diffOutput = gitSafe(`diff ${source}:${file} ${target}:${file}`)
      const diffLines = diffOutput?.split("\n") || []
      const added = diffLines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length
      const removed = diffLines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length

      results.push({
        sourcePath: file,
        targetPath: file,
        result: "MODIFIED",
        category: "Python engine",
        diff: `+${added}/-${removed} lines`,
      })
    }
  }

  return results
}

// ─── Report Generation ───────────────────────────────────────────────────────

function printReport(report: VerificationReport) {
  const W = 65

  console.log("═".repeat(W))
  console.log("  RESTRUCTURE VERIFICATION REPORT")
  console.log("═".repeat(W))

  console.log(`\nSummary:`)
  console.log(`  Total custom files examined: ${report.summary.totalExamined}`)
  console.log(`  MATCH: ${report.summary.match} | MOVED: ${report.summary.moved} | MODIFIED: ${report.summary.modified} | MISSING: ${report.summary.missing}`)

  console.log(`\nBy Category:`)
  const cats = Object.entries(report.categories)
  for (let i = 0; i < cats.length; i++) {
    const [name, { expected, verified }] = cats[i]
    const prefix = i < cats.length - 1 ? "├─" : "└─"
    const status = verified === expected ? "✓" : "✗"
    const pad = 22 - name.length
    console.log(`  ${prefix} ${name}:${" ".repeat(Math.max(1, pad))}${status} ${verified}/${expected}`)
  }

  // Markers
  console.log(`\naltimate_change markers: ${report.markers.totalBlocks} blocks in ${report.markers.totalFiles} files`)
  if (report.markers.allClosed) {
    console.log(`  ✓ All blocks properly closed`)
  } else {
    console.log(`  ✗ ${report.markers.unclosed.length} UNCLOSED blocks:`)
    for (const block of report.markers.unclosed) {
      console.log(`    ${block.file}:${block.startLine} — missing end marker`)
    }
  }

  // New files
  if (report.newFiles.length > 0) {
    console.log(`\nNew files on target (intentional): ${report.newFiles.length} files`)
    for (const f of report.newFiles) {
      console.log(`  + ${f}`)
    }
  }

  // Critical: Missing files
  const missing = report.results.filter((r) => r.result === "MISSING")
  if (missing.length > 0) {
    console.log(`\n${"!".repeat(W)}`)
    console.log(`  CRITICAL MISSING FILES: ${missing.length}`)
    console.log(`${"!".repeat(W)}`)
    for (const r of missing) {
      console.log(`  ✗ ${r.sourcePath}`)
      console.log(`    expected at: ${r.targetPath}`)
    }
  } else {
    console.log(`\nCRITICAL MISSING FILES: (none)`)
  }

  // Modified files
  const modified = report.results.filter((r) => r.result === "MODIFIED")
  if (modified.length > 0) {
    console.log(`\nMODIFIED FILES (review required): ${modified.length}`)
    for (const r of modified) {
      console.log(`  ~ ${r.sourcePath} → ${r.targetPath} (${r.diff})`)
    }
  } else {
    console.log(`\nMODIFIED FILES: (none)`)
  }

  // Final verdict
  console.log(`\n${"═".repeat(W)}`)
  if (report.exitCode === 0) {
    console.log(`  ✓ VERIFICATION PASSED`)
  } else if (report.exitCode === 1) {
    console.log(`  ⚠ VERIFICATION PASSED WITH WARNINGS`)
  } else {
    console.log(`  ✗ VERIFICATION FAILED`)
  }
  console.log("═".repeat(W))
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const base = args.base!
  const source = args.source!
  const target = args.target!
  const strict = args["no-strict"] ? false : args.strict !== false

  // Validate refs
  if (!tagExists(base) && !branchExists(base)) {
    console.error(`Error: Base ref '${base}' not found`)
    process.exit(1)
  }
  if (!branchExists(source)) {
    console.error(`Error: Source branch '${source}' not found`)
    process.exit(1)
  }
  if (!branchExists(target)) {
    console.error(`Error: Target branch '${target}' not found`)
    process.exit(1)
  }

  console.log(`Comparing: ${source} → ${target} (base: ${base})\n`)

  // Step 1: Get custom file inventory
  console.log("Step 1: Building custom file inventory...")
  const customFiles = getCustomFiles(base, source)
  console.log(`  Found ${customFiles.length} custom files (added/modified/renamed vs ${base})`)

  // Step 2: Verify each file
  console.log("\nStep 2: Verifying file-by-file content...")
  const results: FileVerification[] = []

  // Filter to files we actually want to verify (exclude upstream-only deletes etc.)
  const filesToVerify = customFiles.filter((f) => {
    // Skip files in upstream packages that were stripped
    if (f.path.startsWith("packages/app/")) return false
    if (f.path.startsWith("packages/console/")) return false
    if (f.path.startsWith("packages/containers/")) return false
    if (f.path.startsWith("packages/desktop/")) return false
    if (f.path.startsWith("packages/desktop-electron/")) return false
    if (f.path.startsWith("packages/docs/")) return false
    if (f.path.startsWith("packages/enterprise/")) return false
    if (f.path.startsWith("packages/extensions/")) return false
    if (f.path.startsWith("packages/function/")) return false
    if (f.path.startsWith("packages/identity/")) return false
    if (f.path.startsWith("packages/slack/")) return false
    if (f.path.startsWith("packages/storybook/")) return false
    if (f.path.startsWith("packages/ui/")) return false
    if (f.path.startsWith("packages/web/")) return false
    if (f.path.startsWith("infra/")) return false
    return true
  })

  let processed = 0
  for (const entry of filesToVerify) {
    // Python engine handled separately for efficiency
    if (entry.path.startsWith("packages/altimate-engine/")) continue

    // Skip intentionally excluded files
    if (INTENTIONALLY_EXCLUDED.has(entry.path)) {
      continue
    }

    const result = verifyFile(entry, source, target)
    results.push(result)
    processed++

    // Progress indicator for large runs
    if (processed % 50 === 0) {
      process.stdout.write(`  Verified ${processed} files...\r`)
    }
  }

  // Step 3: Python engine byte-for-byte
  console.log("\nStep 3: Verifying Python engine...")
  const engineResults = verifyPythonEngine(source, target)
  results.push(...engineResults)
  const engineMatch = engineResults.filter((r) => r.result === "MATCH").length
  const engineTotal = engineResults.length
  console.log(`  ${engineMatch}/${engineTotal} files byte-identical`)

  // Step 4: Marker verification
  console.log("\nStep 4: Verifying altimate_change markers...")
  const markerResults = verifyMarkers(target)
  const totalBlocks = markerResults.reduce((sum, r) => sum + r.totalBlocks, 0)
  const unclosedBlocks = markerResults.flatMap((r) => r.blocks.filter((b) => b.endLine === null))
  console.log(`  ${totalBlocks} blocks in ${markerResults.length} files, ${unclosedBlocks.length} unclosed`)

  // Step 5: New files
  console.log("\nStep 5: Checking for new files on target...")
  const newFiles = findNewFiles(base, source, target)
  console.log(`  ${newFiles.length} new files`)

  // Build category summary
  const categories: Record<string, { expected: number; verified: number }> = {}
  for (const r of results) {
    if (!categories[r.category]) {
      categories[r.category] = { expected: 0, verified: 0 }
    }
    categories[r.category].expected++
    if (r.result !== "MISSING") {
      categories[r.category].verified++
    }
  }

  // Build report
  const match = results.filter((r) => r.result === "MATCH").length
  const moved = results.filter((r) => r.result === "MOVED").length
  const modified = results.filter((r) => r.result === "MODIFIED").length
  const missing = results.filter((r) => r.result === "MISSING").length

  let exitCode = 0
  if (modified > 0) exitCode = 1
  if (missing > 0 || unclosedBlocks.length > 0) exitCode = 2

  const report: VerificationReport = {
    summary: {
      totalExamined: results.length,
      match,
      moved,
      modified,
      missing,
    },
    categories,
    markers: {
      totalFiles: markerResults.length,
      totalBlocks,
      allClosed: unclosedBlocks.length === 0,
      unclosed: unclosedBlocks,
    },
    newFiles,
    results,
    exitCode,
  }

  // Output
  console.log("")
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    printReport(report)
  }

  if (strict && exitCode > 0) {
    process.exit(exitCode)
  }
}

main().catch((e) => {
  console.error("Verification failed:", e)
  process.exit(2)
})
