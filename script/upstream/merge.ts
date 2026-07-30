#!/usr/bin/env bun
/**
 * Upstream Merge Orchestration
 *
 * Merges upstream OpenCode releases into the Altimate Code fork with
 * automatic conflict resolution and branding transforms.
 *
 * Only published GitHub releases can be merged — arbitrary commits or
 * non-release tags are rejected. This ensures we only pick up stable,
 * released changes from upstream.
 *
 * Usage:
 *   bun run script/upstream/merge.ts --version v1.2.21
 *   bun run script/upstream/merge.ts --version v1.2.21 --dry-run
 *   bun run script/upstream/merge.ts --version v1.2.21 --no-push
 *   bun run script/upstream/merge.ts --continue
 *
 * The --continue flag resumes after manual conflict resolution,
 * applying branding transforms and committing the merge.
 */

import { parseArgs } from "util"
import { $ } from "bun"
import fs from "fs"
import path from "path"
import * as git from "./utils/git"
import * as logger from "./utils/logger"
import { RESET, BOLD, DIM, CYAN, GREEN, RED, YELLOW, MAGENTA, bold, dim, cyan, green, red, yellow, banner } from "./utils/logger"
import { loadConfig, repoRoot, type MergeConfig, type StringReplacement } from "./utils/config"
import { createReport, addFileReport, printSummary, writeReport, type MergeReport, type FileReport, type Change } from "./utils/report"
import { validateRelease, getReleaseTags } from "./utils/github"

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    version: { type: "string", short: "v" },
    "include-prerelease": { type: "boolean", default: false },
    "base-branch": { type: "string", default: "main" },
    "dry-run": { type: "boolean", default: false },
    "no-push": { type: "boolean", default: false },
    continue: { type: "boolean", default: false },
    author: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: false,
}) as any

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOTAL_STEPS = 11
const STATE_FILE = ".upstream-merge-state.json"

interface MergeState {
  version: string
  mergeBranch: string
  backupBranch: string
  baseBranch: string
  step: number
  versionSnapshot?: Record<string, { name: string; version: string }>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`
  ${bold("Upstream Merge Tool")} — Merge OpenCode releases into Altimate Code

  ${bold("USAGE")}
    bun run script/upstream/merge.ts --version <tag>   Start a new merge
    bun run script/upstream/merge.ts --continue        Resume after conflict resolution

  ${bold("OPTIONS")}
    --version, -v <tag>      Upstream release tag to merge (e.g., v1.2.21)
    --include-prerelease     Allow merging pre-release versions
    --base-branch <name>     Branch to merge into (default: main)
    --dry-run                Analyze changes without modifying the repo
    --no-push                Skip pushing the merge branch to origin
    --continue               Resume after manual conflict resolution
    --author <name>          Override the merge commit author
    --help, -h               Show this help message

  ${bold("NOTE")}
    Only published GitHub releases can be merged. Arbitrary commits or
    non-release tags are rejected to ensure stability.

  ${bold("EXAMPLES")}
    ${dim("# Standard merge")}
    bun run script/upstream/merge.ts --version v1.2.21

    ${dim("# Preview what would change")}
    bun run script/upstream/merge.ts --version v1.2.21 --dry-run

    ${dim("# Merge without pushing")}
    bun run script/upstream/merge.ts --version v1.2.21 --no-push

    ${dim("# Resume after resolving conflicts")}
    bun run script/upstream/merge.ts --continue
`)
}

function saveState(state: MergeState): void {
  const stateFile = path.join(repoRoot(), STATE_FILE)
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2))
}

function loadState(): MergeState | null {
  const stateFile = path.join(repoRoot(), STATE_FILE)
  if (!fs.existsSync(stateFile)) return null
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf-8"))
  } catch {
    return null
  }
}

function clearState(): void {
  const stateFile = path.join(repoRoot(), STATE_FILE)
  if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile)
}

// ---------------------------------------------------------------------------
// Branding transform engine
// ---------------------------------------------------------------------------

/**
 * Check whether a line should be excluded from branding transforms.
 * Lines containing preserve patterns (npm package names, internal refs, etc.)
 * are left untouched.
 */
function shouldPreserveLine(line: string, preservePatterns: string[]): boolean {
  return preservePatterns.some((pattern) => line.includes(pattern))
}

/**
 * Apply branding rules to a single line of text.
 * Returns the transformed line and a list of changes made.
 */
function transformLine(
  line: string,
  lineNum: number,
  rules: StringReplacement[],
  preservePatterns: string[],
): { result: string; changes: Change[] } {
  if (shouldPreserveLine(line, preservePatterns)) {
    return { result: line, changes: [] }
  }

  const changes: Change[] = []
  let current = line

  for (const rule of rules) {
    // Reset lastIndex for global regex
    rule.pattern.lastIndex = 0
    if (rule.pattern.test(current)) {
      const before = current
      rule.pattern.lastIndex = 0
      current = current.replace(rule.pattern, rule.replacement)
      if (current !== before) {
        changes.push({
          line: lineNum,
          before,
          after: current,
          rule: rule.description,
        })
      }
    }
  }

  return { result: current, changes }
}

/**
 * Apply branding transforms to a single file.
 * Returns a FileReport with all changes made (empty if no changes).
 */
function transformFile(filePath: string, config: MergeConfig): FileReport {
  const ext = path.extname(filePath).toLowerCase()
  const relPath = path.relative(repoRoot(), filePath)

  const report: FileReport = {
    file: relPath,
    transform: "branding",
    changes: [],
  }

  // Skip non-transformable extensions
  if (!config.transformableExtensions.includes(ext)) {
    return report
  }

  // Skip binary files
  try {
    const stat = fs.statSync(filePath)
    if (stat.size > 5 * 1024 * 1024) return report // Skip files > 5MB
  } catch {
    return report
  }

  let content: string
  try {
    content = fs.readFileSync(filePath, "utf-8")
  } catch {
    return report
  }

  const lines = content.split("\n")
  const transformedLines: string[] = []
  let hasChanges = false

  for (let i = 0; i < lines.length; i++) {
    const { result, changes } = transformLine(
      lines[i],
      i + 1,
      config.brandingRules,
      config.preservePatterns,
    )
    transformedLines.push(result)
    if (changes.length > 0) {
      report.changes.push(...changes)
      hasChanges = true
    }
  }

  if (hasChanges) {
    fs.writeFileSync(filePath, transformedLines.join("\n"))
  }

  return report
}

/**
 * Apply branding transforms to all tracked files that were changed in the merge.
 * Skips keepOurs files, binary files, and files matching preserve patterns.
 */
async function applyBrandingTransforms(config: MergeConfig, report: MergeReport): Promise<void> {
  const { minimatch } = await import("minimatch")
  const root = repoRoot()

  // Get list of all files that were modified in this merge
  const trackedFiles = await git.getTrackedFiles()

  let transformed = 0
  let skipped = 0

  for (const relFile of trackedFiles) {
    // Skip keepOurs files
    const isKeepOurs = config.keepOurs.some((p) => minimatch(relFile, p))
    if (isKeepOurs) {
      skipped++
      continue
    }

    const fullPath = path.join(root, relFile)
    if (!fs.existsSync(fullPath)) continue

    const fileReport = transformFile(fullPath, config)
    if (fileReport.changes.length > 0) {
      addFileReport(report, fileReport)
      transformed++
    }
  }

  logger.info(`Branding: ${transformed} files transformed, ${skipped} skipped (keepOurs)`)
}

// ---------------------------------------------------------------------------
// Conflict resolution
// ---------------------------------------------------------------------------

/**
 * Auto-resolve conflicts using keepOurs, skipFiles, and lock file strategies.
 * Returns the list of files that still need manual resolution.
 */
async function autoResolveConflicts(
  conflicts: string[],
  config: MergeConfig,
): Promise<{ resolved: string[]; remaining: string[] }> {
  const { minimatch } = await import("minimatch")
  const root = repoRoot()
  const resolved: string[] = []
  const remaining: string[] = []

  for (const file of conflicts) {
    try {
      // Strategy 1: keepOurs — files we own entirely
      const isKeepOurs = config.keepOurs.some((p) => minimatch(file, p))
      if (isKeepOurs) {
        await $`git checkout --ours -- ${file}`.cwd(root).quiet()
        await $`git add ${file}`.cwd(root).quiet()
        resolved.push(file)
        logger.success(`${file} ${dim("(kept ours)")}`)
        continue
      }

      // Strategy 2: skipFiles — upstream files we accept wholesale
      const isSkipFile = config.skipFiles.some((p) => minimatch(file, p))
      if (isSkipFile) {
        // File may have been deleted on one side; try --theirs first, fall back to removing
        try {
          await $`git checkout --theirs -- ${file}`.cwd(root).quiet()
        } catch {
          // File deleted on upstream side — accept the deletion
          await $`git rm --force --ignore-unmatch -- ${file}`.cwd(root).quiet()
        }
        await $`git add ${file}`.cwd(root).quiet()
        resolved.push(file)
        logger.success(`${file} ${dim("(accepted upstream)")}`)
        continue
      }

      // Strategy 3: Lock files — accept ours, will regenerate later
      if (file === "bun.lock" || file.endsWith("/bun.lock") ||
          file === "package-lock.json" || file.endsWith("/package-lock.json")) {
        await $`git checkout --ours -- ${file}`.cwd(root).quiet()
        await $`git add ${file}`.cwd(root).quiet()
        resolved.push(file)
        logger.success(`${file} ${dim("(kept ours, will regenerate)")}`)
        continue
      }

      // Strategy 4: Binary files — accept upstream
      const binaryExts = [".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2",
                          ".ttf", ".eot", ".pyc", ".whl", ".gz", ".zip", ".tar",
                          ".svg", ".webp", ".avif"]
      if (binaryExts.some((ext) => file.endsWith(ext))) {
        try {
          await $`git checkout --theirs -- ${file}`.cwd(root).quiet()
        } catch {
          await $`git rm --force --ignore-unmatch -- ${file}`.cwd(root).quiet()
        }
        await $`git add ${file}`.cwd(root).quiet()
        resolved.push(file)
        logger.success(`${file} ${dim("(binary, accepted upstream)")}`)
        continue
      }

      remaining.push(file)
    } catch (e: any) {
      logger.warn(`Could not auto-resolve ${file}: ${e.message || e}`)
      remaining.push(file)
    }
  }

  return { resolved, remaining }
}

// ---------------------------------------------------------------------------
// Version snapshot / restore
// ---------------------------------------------------------------------------

interface PackageVersionEntry {
  type: "package.json"
  name: string
  version: string
}

interface TextVersionEntry {
  type: "text"
  pattern: string
  version: string
}

type VersionEntry = PackageVersionEntry | TextVersionEntry

interface VersionSnapshot {
  [filePath: string]: VersionEntry
}

/**
 * Snapshot current package versions before merge so we can restore them after.
 * Upstream merges often bump versions; we want to keep our own versioning.
 *
 * Covers both package.json files and the Python engine version files.
 */
function snapshotVersions(): VersionSnapshot {
  const root = repoRoot()
  const snapshot: VersionSnapshot = {}

  // --- package.json files ---
  const packageJsonPaths = [
    "package.json",
    "packages/opencode/package.json",
    "packages/plugin/package.json",
    "packages/sdk/js/package.json",
    "packages/script/package.json",
    "packages/util/package.json",
  ]

  for (const relPath of packageJsonPaths) {
    const fullPath = path.join(root, relPath)
    if (!fs.existsSync(fullPath)) continue

    try {
      const pkg = JSON.parse(fs.readFileSync(fullPath, "utf-8"))
      snapshot[relPath] = {
        type: "package.json",
        name: pkg.name || "",
        version: pkg.version || "",
      }
    } catch {
      // Skip unreadable package.json files
    }
  }

  // --- Engine version files (Python) ---
  const pyprojectPath = "packages/altimate-engine/pyproject.toml"
  const pyprojectFull = path.join(root, pyprojectPath)
  if (fs.existsSync(pyprojectFull)) {
    const content = fs.readFileSync(pyprojectFull, "utf-8")
    const match = content.match(/^version\s*=\s*"([^"]+)"/m)
    if (match) {
      snapshot[pyprojectPath] = {
        type: "text",
        pattern: "version",
        version: match[1],
      }
    }
  }

  const initPath = "packages/altimate-engine/src/altimate_engine/__init__.py"
  const initFull = path.join(root, initPath)
  if (fs.existsSync(initFull)) {
    const content = fs.readFileSync(initFull, "utf-8")
    const match = content.match(/__version__\s*=\s*"([^"]+)"/)
    if (match) {
      snapshot[initPath] = {
        type: "text",
        pattern: "__version__",
        version: match[1],
      }
    }
  }

  return snapshot
}

/**
 * Restore package versions from a snapshot taken before the merge.
 */
function restoreVersions(snapshot: VersionSnapshot): number {
  const root = repoRoot()
  let restored = 0

  for (const [relPath, entry] of Object.entries(snapshot)) {
    const fullPath = path.join(root, relPath)
    if (!fs.existsSync(fullPath)) continue

    try {
      if (entry.type === "package.json") {
        const pkg = JSON.parse(fs.readFileSync(fullPath, "utf-8"))
        let changed = false

        if (entry.name && pkg.name !== entry.name) {
          pkg.name = entry.name
          changed = true
        }
        if (entry.version && pkg.version !== entry.version) {
          pkg.version = entry.version
          changed = true
        }

        if (changed) {
          fs.writeFileSync(fullPath, JSON.stringify(pkg, null, 2) + "\n")
          restored++
          logger.success(`Restored version in ${relPath}: ${entry.name}@${entry.version}`)
        }
      } else if (entry.type === "text") {
        let content = fs.readFileSync(fullPath, "utf-8")
        let changed = false

        if (entry.pattern === "version") {
          // pyproject.toml: version = "X.Y.Z"
          const re = /^(version\s*=\s*")([^"]+)(")/m
          const match = content.match(re)
          if (match && match[2] !== entry.version) {
            content = content.replace(re, `$1${entry.version}$3`)
            changed = true
          }
        } else if (entry.pattern === "__version__") {
          // __init__.py: __version__ = "X.Y.Z"
          const re = /(__version__\s*=\s*")([^"]+)(")/
          const match = content.match(re)
          if (match && match[2] !== entry.version) {
            content = content.replace(re, `$1${entry.version}$3`)
            changed = true
          }
        }

        if (changed) {
          fs.writeFileSync(fullPath, content)
          restored++
          logger.success(`Restored version in ${relPath}: ${entry.version}`)
        }
      }
    } catch {
      logger.warn(`Could not restore version in ${relPath}`)
    }
  }

  return restored
}

// ---------------------------------------------------------------------------
// Post-merge verification
// ---------------------------------------------------------------------------

/**
 * Scan for upstream branding that leaked through the transforms.
 * Returns the number of leaks found.
 */
async function verifyBranding(config: MergeConfig): Promise<number> {
  const { minimatch } = await import("minimatch")
  const root = repoRoot()
  const trackedFiles = await git.getTrackedFiles()
  let leaks = 0

  // Patterns to search for (upstream branding that should have been transformed)
  const leakPatterns = [
    { pattern: /opencode\.ai/g, label: "opencode.ai" },
    { pattern: /opncd\.ai/g, label: "opncd.ai" },
    { pattern: /anomalyco\//g, label: "anomalyco/" },
    { pattern: /\bOpenCode\b/g, label: "OpenCode (product name)" },
  ]

  for (const relFile of trackedFiles) {
    // Skip keepOurs files
    if (config.keepOurs.some((p) => minimatch(relFile, p))) continue

    // Skip non-text files
    const ext = path.extname(relFile).toLowerCase()
    if (!config.transformableExtensions.includes(ext)) continue

    const fullPath = path.join(root, relFile)
    if (!fs.existsSync(fullPath)) continue

    let content: string
    try {
      content = fs.readFileSync(fullPath, "utf-8")
    } catch {
      continue
    }

    const lines = content.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // Skip lines that contain preserve patterns
      if (shouldPreserveLine(line, config.preservePatterns)) continue

      for (const { pattern, label } of leakPatterns) {
        pattern.lastIndex = 0
        if (pattern.test(line)) {
          if (leaks < 20) {
            logger.warn(`Branding leak: ${relFile}:${i + 1} — ${label}`)
            console.log(`  ${DIM}${line.trim()}${RESET}`)
          }
          leaks++
        }
      }
    }
  }

  if (leaks > 20) {
    logger.warn(`... and ${leaks - 20} more leaks (showing first 20)`)
  }

  return leaks
}

// ---------------------------------------------------------------------------
// Main merge orchestration
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (args.help) {
    printUsage()
    process.exit(0)
  }

  const config = loadConfig()
  const root = repoRoot()

  // --continue mode: resume after manual conflict resolution
  if (args.continue) {
    await continueAfterConflicts(config)
    return
  }

  // Determine merge target — only published releases are allowed
  const version = args.version

  if (!version) {
    logger.error("--version is required")
    logger.info("Usage: bun run script/upstream/merge.ts --version v1.2.21")
    logger.info("")
    logger.info("List available releases:")
    logger.info("  bun run script/upstream/list-versions.ts")
    process.exit(1)
  }

  const mergeRef = version

  const baseBranch = args["base-branch"] || config.baseBranch

  banner(`Upstream Merge: ${mergeRef}`)

  // ─── Step 1: Validate environment ───────────────────────────────────────────

  logger.step(1, TOTAL_STEPS, "Validating environment")

  // Check working directory is clean
  const clean = await git.isClean()
  if (!clean) {
    logger.error("Working tree has uncommitted changes")
    logger.info("Commit or stash your changes before merging")
    process.exit(1)
  }
  logger.success("Working tree is clean")

  // Check upstream remote exists, add if not
  const hasUpstream = await git.hasRemote(config.upstreamRemote)
  if (!hasUpstream) {
    logger.info(`Adding upstream remote: ${config.upstreamRepo}`)
    await git.addRemote(
      config.upstreamRemote,
      `https://github.com/${config.upstreamRepo}.git`,
    )
  }
  logger.success(`Remote '${config.upstreamRemote}' configured`)

  // Fetch upstream
  logger.info(`Fetching ${config.upstreamRemote}...`)
  await git.fetchRemote(config.upstreamRemote)
  logger.success("Upstream fetched")

  // Validate version is a published GitHub release (not just a tag)
  logger.info(`Validating '${version}' is a published release on ${config.upstreamRepo}...`)
  const validation = await validateRelease(config.upstreamRepo, version, {
    includePrerelease: Boolean(args["include-prerelease"]),
  })

  if (!validation.valid) {
    logger.error(validation.reason!)

    if (validation.reason?.includes("pre-release") && !args["include-prerelease"]) {
      logger.info("Pass --include-prerelease to allow merging pre-release versions")
    }

    // Show recent releases for reference
    try {
      const recentTags = await getReleaseTags(config.upstreamRepo)
      const recent = recentTags.slice(0, 10)
      if (recent.length > 0) {
        logger.info(`Recent releases: ${recent.join(", ")}`)
      }
    } catch {
      // Best effort
    }

    process.exit(1)
  }

  logger.success(`'${version}' is a published release (${validation.release!.published_at.split("T")[0]})`)

  const currentBranchName = await git.getCurrentBranch()
  logger.info(`Current branch: ${cyan(currentBranchName)}`)
  logger.info(`Target: ${cyan(mergeRef)}`)

  // ─── Step 2: Dry-run analysis ───────────────────────────────────────────────

  if (args["dry-run"]) {
    logger.step(2, TOTAL_STEPS, "Dry-run analysis")
    await dryRunAnalysis(mergeRef, config)
    return
  }

  // ─── Step 3: Snapshot versions ──────────────────────────────────────────────

  logger.step(2, TOTAL_STEPS, "Snapshotting package versions")
  const versionSnapshot = snapshotVersions()
  const snapshotCount = Object.keys(versionSnapshot).length
  logger.success(`Captured ${snapshotCount} package version(s)`)

  // ─── Step 4: Create branches ────────────────────────────────────────────────

  logger.step(3, TOTAL_STEPS, "Creating branches")

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const backupBranch = `backup/${currentBranchName}-${timestamp}`
  const versionSlug = version.replace(/[^a-zA-Z0-9.-]/g, "-")
  const mergeBranch = `upstream/merge-${versionSlug}`

  // Create backup branch at current position
  try {
    await $`git branch ${backupBranch}`.cwd(root).quiet()
    logger.success(`Backup branch: ${cyan(backupBranch)}`)
  } catch {
    logger.warn(`Could not create backup branch (may already exist)`)
  }

  // Create and switch to merge branch
  try {
    await git.createBranch(mergeBranch)
    logger.success(`Merge branch: ${cyan(mergeBranch)}`)
  } catch {
    logger.error(`Could not create merge branch '${mergeBranch}'`)
    logger.info("Branch may already exist. Delete it first or use a different name.")
    process.exit(1)
  }

  // Save state for --continue (include pre-merge version snapshot)
  saveState({
    version: mergeRef,
    mergeBranch,
    backupBranch,
    baseBranch,
    step: 4,
    versionSnapshot,
  })

  // ─── Step 5: Merge upstream ─────────────────────────────────────────────────

  logger.step(4, TOTAL_STEPS, `Merging ${mergeRef}`)

  // Merge the release tag directly
  const mergeTarget = version
  const mergeResult = await git.merge(mergeTarget)

  if (mergeResult.success) {
    logger.success("Merge completed without conflicts")
    // Even without conflicts, apply branding transforms
    await postMergeTransforms(config, mergeRef, versionSnapshot)
    return
  }

  logger.info(`Merge has ${mergeResult.conflicts.length} conflict(s) — resolving...`)

  // ─── Step 6: Auto-resolve conflicts ─────────────────────────────────────────

  logger.step(5, TOTAL_STEPS, "Auto-resolving conflicts")

  const { resolved, remaining } = await autoResolveConflicts(
    mergeResult.conflicts,
    config,
  )

  logger.info(`Auto-resolved: ${green(String(resolved.length))} files`)

  if (remaining.length === 0) {
    logger.success("All conflicts resolved automatically")

    // Commit the merge
    await $`git commit --no-edit`.cwd(root).quiet()
    await postMergeTransforms(config, mergeRef, versionSnapshot)
    return
  }

  // ─── Step 7: Report remaining conflicts ─────────────────────────────────────

  logger.step(6, TOTAL_STEPS, "Remaining conflicts")

  console.log()
  logger.warn(`${remaining.length} file(s) need manual resolution:`)
  console.log()
  for (const file of remaining) {
    console.log(`  ${RED}conflict${RESET}  ${file}`)
  }

  // Update state for --continue (preserve pre-merge version snapshot)
  saveState({
    version: mergeRef,
    mergeBranch,
    backupBranch,
    baseBranch,
    step: 7,
    versionSnapshot,
  })

  console.log()
  console.log(`${BOLD}Next steps:${RESET}`)
  console.log()
  console.log(`  1. Resolve the conflicts listed above`)
  console.log(`  2. Stage resolved files: ${cyan("git add <files>")}`)
  console.log(`  3. Continue the merge:  ${cyan("bun run script/upstream/merge.ts --continue")}`)
  console.log()
  console.log(`${DIM}Tip: Use 'git diff --name-only --diff-filter=U' to see remaining conflicts${RESET}`)

  process.exit(1)
}

// ---------------------------------------------------------------------------
// --continue handler
// ---------------------------------------------------------------------------

async function continueAfterConflicts(config: MergeConfig): Promise<void> {
  const root = repoRoot()

  banner("Continuing Upstream Merge")

  // Load saved state
  const state = loadState()
  if (!state) {
    logger.error("No merge in progress")
    logger.info("Start a new merge with: bun run script/upstream/merge.ts --version <tag>")
    process.exit(1)
  }

  logger.info(`Resuming merge of ${cyan(state.version)}`)
  logger.info(`Merge branch: ${cyan(state.mergeBranch)}`)

  // Check for remaining conflicts
  const conflictOutput = await $`git diff --name-only --diff-filter=U`.cwd(root).text()
  const remaining = conflictOutput.trim().split("\n").filter((f) => f.length > 0)

  if (remaining.length > 0) {
    logger.error(`${remaining.length} file(s) still have conflicts:`)
    for (const file of remaining) {
      console.log(`  ${RED}conflict${RESET}  ${file}`)
    }
    console.log()
    logger.info("Resolve these conflicts, stage them with 'git add', then run --continue again")
    process.exit(1)
  }

  logger.success("All conflicts resolved")

  // Commit the merge (skip if already committed)
  logger.info("Committing merge...")
  try {
    await $`git commit --no-edit`.cwd(root).quiet()
    logger.success("Merge committed")
  } catch {
    logger.info("Merge already committed, continuing...")
  }

  // Use pre-merge version snapshot from saved state, fall back to current if not available
  const versionSnapshot = state.versionSnapshot ?? snapshotVersions()

  await postMergeTransforms(config, state.version, versionSnapshot)
}

// ---------------------------------------------------------------------------
// skipFiles cleanup
// ---------------------------------------------------------------------------

/**
 * Delete files/directories matching skipFiles patterns that exist in the repo.
 * These are upstream packages we don't need — the merge may have re-introduced them.
 */
async function cleanupSkipFiles(config: MergeConfig): Promise<void> {
  const { minimatch } = await import("minimatch")
  const root = repoRoot()

  // Get all tracked files and find those matching skipFiles patterns.
  // Safety guard: only delete files the merge newly introduced — a file that
  // already exists on the base branch is live fork content, and deleting it
  // here would destroy it (skipFiles is meant for upstream-only surfaces the
  // merge re-introduces).
  const trackedFiles = await git.getTrackedFiles()
  const baselineOutput = await $`git ls-tree -r --name-only ${config.baseBranch}`
    .cwd(root)
    .text()
  const baselineFiles = new Set(baselineOutput.trim().split("\n"))
  const toRemove = trackedFiles.filter(
    (f) => !baselineFiles.has(f) && config.skipFiles.some((p) => minimatch(f, p)),
  )

  if (toRemove.length === 0) {
    logger.info("No skipFiles to clean up")
    return
  }

  logger.info(`Removing ${toRemove.length} file(s) matching skipFiles patterns...`)

  // Remove via git rm in batches
  const batchSize = 100
  for (let i = 0; i < toRemove.length; i += batchSize) {
    const batch = toRemove.slice(i, i + batchSize)
    try {
      await $`git rm -rf --ignore-unmatch -- ${batch}`.cwd(root).quiet()
    } catch (e: any) {
      logger.warn(`Some skipFiles could not be removed: ${e.message || e}`)
    }
  }

  // Also delete leftover empty directories for skipFiles directory patterns
  for (const pattern of config.skipFiles) {
    // Only handle directory-level patterns (ending with /**)
    if (!pattern.endsWith("/**")) continue
    const dirPath = path.join(root, pattern.replace("/**", ""))
    if (fs.existsSync(dirPath)) {
      try {
        fs.rmSync(dirPath, { recursive: true, force: true })
        logger.success(`Removed directory: ${pattern.replace("/**", "")}`)
      } catch {
        // Best effort
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Package.json sanitization
// ---------------------------------------------------------------------------

/**
 * Remove upstream junk from package.json that leaks through merges.
 * - Removes unknown top-level fields (e.g., "randomField")
 * - Removes junk scripts (echo-only stubs)
 * - Removes "opencode" bin entry
 * - Fixes "altimate" bin path to ./bin/altimate
 */
function sanitizePackageJson(pkgPath: string): void {
  if (!fs.existsSync(pkgPath)) return

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
  let changed = false

  // Known top-level keys to keep
  const allowedKeys = new Set([
    "$schema", "name", "version", "type", "license", "private", "description",
    "scripts", "bin", "exports", "imports", "dependencies", "devDependencies",
    "peerDependencies", "optionalDependencies", "overrides", "resolutions",
    "engines", "repository", "homepage", "bugs", "keywords", "author",
    "contributors", "files", "main", "module", "types", "typings",
    "sideEffects", "publishConfig", "workspaces",
  ])

  for (const key of Object.keys(pkg)) {
    if (!allowedKeys.has(key)) {
      logger.info(`Removing junk field from package.json: "${key}"`)
      delete pkg[key]
      changed = true
    }
  }

  // Remove junk scripts (echo-only stubs from upstream)
  if (pkg.scripts) {
    const junkScripts = ["random", "clean", "lint", "format", "docs", "deploy"]
    for (const name of junkScripts) {
      if (pkg.scripts[name] && pkg.scripts[name].startsWith("echo ")) {
        logger.info(`Removing junk script: "${name}"`)
        delete pkg.scripts[name]
        changed = true
      }
    }
  }

  // Remove "opencode" bin entry and fix "altimate" path
  if (pkg.bin) {
    if (pkg.bin.opencode) {
      logger.info('Removing "opencode" bin entry')
      delete pkg.bin.opencode
      changed = true
    }
    if (pkg.bin.altimate !== "./bin/altimate") {
      logger.info('Fixing "altimate" bin path to ./bin/altimate')
      pkg.bin.altimate = "./bin/altimate"
      changed = true
    }
    if (pkg.bin["altimate-code"] !== "./bin/altimate-code") {
      pkg.bin["altimate-code"] = "./bin/altimate-code"
      changed = true
    }
  }

  if (changed) {
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n")
    logger.success("Sanitized package.json")
  }
}

// ---------------------------------------------------------------------------
// Post-merge transforms (steps 7-11)
// ---------------------------------------------------------------------------

async function postMergeTransforms(
  config: MergeConfig,
  version: string,
  versionSnapshot: VersionSnapshot,
): Promise<void> {
  const root = repoRoot()
  const report = createReport(version)

  // ─── Step 7: Clean up skipFiles and apply branding transforms ─────────────

  logger.step(7, TOTAL_STEPS, "Cleaning up skipFiles and applying branding transforms")

  // Delete skipFiles directories/files that may have been introduced by the merge
  await cleanupSkipFiles(config)

  await applyBrandingTransforms(config, report)

  // ─── Step 7b: Sanitize package.json (remove upstream junk) ──────────────

  sanitizePackageJson(path.join(root, "packages/opencode/package.json"))

  // ─── Step 8: Restore package versions ─────────────────────────────────────

  logger.step(8, TOTAL_STEPS, "Restoring package versions")
  const restoredCount = restoreVersions(versionSnapshot)
  if (restoredCount > 0) {
    logger.success(`Restored ${restoredCount} package version(s)`)
  } else {
    logger.info("No version changes to restore")
  }

  // ─── Step 9: Commit branding changes ──────────────────────────────────────

  logger.step(9, TOTAL_STEPS, "Committing branding transforms")

  // Stage all branding changes
  await git.stageAll()

  // Check if there are actual changes to commit
  const hasChanges = !(await git.isClean())

  if (hasChanges) {
    const commitMsg = `chore: apply branding transforms for upstream ${version}`
    await git.commit(commitMsg)
    logger.success("Branding transforms committed")
  } else {
    logger.info("No branding changes to commit")
  }

  // ─── Step 10: Post-merge verification ─────────────────────────────────────

  logger.step(10, TOTAL_STEPS, "Verifying branding integrity")
  const leakCount = await verifyBranding(config)

  if (leakCount === 0) {
    logger.success("No branding leaks detected")
  } else {
    logger.warn(`${leakCount} potential branding leak(s) found`)
    logger.info("Review the leaks above. Some may be false positives (internal references).")
    logger.info("Run 'bun run script/upstream/analyze.ts --branding' for detailed analysis.")
  }

  // Print merge report summary
  if (report.totalChanges > 0) {
    printSummary(report)
  }

  // Write JSON report
  const reportPath = path.join(root, ".github", "meta", `merge-report-${version}.json`)
  const reportDir = path.dirname(reportPath)
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true })
  }
  await writeReport(report, reportPath)

  // ─── Step 11: Push ────────────────────────────────────────────────────────

  logger.step(11, TOTAL_STEPS, "Finalizing")

  // Clean up state file
  clearState()

  const currentBranchName = await git.getCurrentBranch()

  if (args["no-push"]) {
    logger.info("Skipping push (--no-push)")
  } else {
    logger.info(`Pushing ${cyan(currentBranchName)} to origin...`)
    try {
      await $`git push -u origin ${currentBranchName}`.cwd(root).quiet()
      logger.success("Pushed to origin")
    } catch (e: any) {
      logger.warn("Push failed — you may need to push manually")
      logger.info(`  git push -u origin ${currentBranchName}`)
    }
  }

  // ─── Done ─────────────────────────────────────────────────────────────────

  banner("Merge Complete")

  console.log(`  ${bold("Review:")}`)
  console.log(`    git log --oneline HEAD~5..HEAD`)
  console.log(`    git diff main --stat`)
  console.log()
  console.log(`  ${bold("Create PR:")}`)
  console.log(`    gh pr create --base main --head ${currentBranchName} \\`)
  console.log(`      --title "chore: merge upstream opencode ${version}" \\`)
  console.log(`      --body "Merged upstream OpenCode ${version} with branding transforms."`)
  console.log()
  console.log(`  ${bold("Report:")}`)
  console.log(`    ${reportPath}`)
  console.log()
}

// ---------------------------------------------------------------------------
// Dry-run analysis
// ---------------------------------------------------------------------------

async function dryRunAnalysis(mergeRef: string, config: MergeConfig): Promise<void> {
  const { minimatch } = await import("minimatch")
  const root = repoRoot()

  banner(`Dry-Run Analysis: ${mergeRef}`)

  // Get list of files that would change
  const diffStat = await $`git diff --stat HEAD...${mergeRef}`.cwd(root).text()
  const diffFiles = await $`git diff --name-only HEAD...${mergeRef}`.cwd(root).text()
  const files = diffFiles.trim().split("\n").filter(Boolean)

  console.log(`${bold("Files changed upstream:")} ${files.length}`)
  console.log()

  // Categorize files
  const keepOurs: string[] = []
  const skipFiles: string[] = []
  const lockFiles: string[] = []
  const binaryFiles: string[] = []
  const transformable: string[] = []
  const passThrough: string[] = []

  for (const file of files) {
    if (config.keepOurs.some((p) => minimatch(file, p))) {
      keepOurs.push(file)
    } else if (config.skipFiles.some((p) => minimatch(file, p))) {
      skipFiles.push(file)
    } else if (file === "bun.lock" || file.endsWith("/bun.lock")) {
      lockFiles.push(file)
    } else {
      const ext = path.extname(file).toLowerCase()
      if (config.transformableExtensions.includes(ext)) {
        transformable.push(file)
      } else {
        passThrough.push(file)
      }
    }
  }

  // Display categories
  const categories = [
    { label: "Keep ours (auto-resolve)", files: keepOurs, color: GREEN },
    { label: "Skip files (accept upstream)", files: skipFiles, color: CYAN },
    { label: "Lock files (regenerate)", files: lockFiles, color: YELLOW },
    { label: "Transformable (branding)", files: transformable, color: MAGENTA },
    { label: "Pass-through (no transform)", files: passThrough, color: DIM },
  ]

  for (const { label, files: catFiles, color } of categories) {
    console.log(`  ${color}${label}:${RESET} ${catFiles.length}`)
    if (catFiles.length <= 10) {
      for (const f of catFiles) {
        console.log(`    ${DIM}${f}${RESET}`)
      }
    } else {
      for (const f of catFiles.slice(0, 5)) {
        console.log(`    ${DIM}${f}${RESET}`)
      }
      console.log(`    ${DIM}... and ${catFiles.length - 5} more${RESET}`)
    }
  }

  // Check for files with altimate_change markers
  console.log()
  logger.info("Checking for altimate_change markers in potentially conflicting files...")

  let markerCount = 0
  for (const file of transformable) {
    try {
      const content = await $`git show HEAD:${file}`.cwd(root).text().catch(() => "")
      if (content.includes(config.changeMarker)) {
        markerCount++
        if (markerCount <= 10) {
          console.log(`  ${YELLOW}marked${RESET}  ${file}`)
        }
      }
    } catch {
      // File may not exist on HEAD
    }
  }
  if (markerCount > 10) {
    console.log(`  ${DIM}... and ${markerCount - 10} more files with markers${RESET}`)
  }

  // Summary
  console.log()
  banner("Dry-Run Summary")
  console.log(`  Total upstream changes:    ${bold(String(files.length))}`)
  console.log(`  Auto-resolved (ours):      ${green(String(keepOurs.length))}`)
  console.log(`  Auto-resolved (upstream):  ${cyan(String(skipFiles.length))}`)
  console.log(`  Lock files (regenerate):   ${yellow(String(lockFiles.length))}`)
  console.log(`  Branding transforms:       ${String(transformable.length)}`)
  console.log(`  Pass-through:              ${String(passThrough.length)}`)
  console.log(`  Files with markers:        ${yellow(String(markerCount))}`)
  console.log()
  console.log(`  ${DIM}Run without --dry-run to perform the actual merge.${RESET}`)
  console.log()
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main().catch((e) => {
  logger.error(`Merge failed: ${e.message || e}`)
  console.log()
  logger.info("Recovery options:")
  logger.info("  1. Fix the issue and run: bun run script/upstream/merge.ts --continue")
  logger.info("  2. Abort the merge:       git merge --abort && git checkout main")
  logger.info("  3. Restore from backup:   git checkout <backup-branch>")

  const state = loadState()
  if (state) {
    logger.info(`  Backup branch: ${state.backupBranch}`)
  }

  process.exit(1)
})
