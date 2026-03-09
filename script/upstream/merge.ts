#!/usr/bin/env bun
/**
 * Upstream Merge Tool
 *
 * Merges upstream opencode releases into our fork with automatic conflict resolution.
 *
 * Usage:
 *   bun run script/upstream/merge.ts --version v1.2.19
 *   bun run script/upstream/merge.ts --version v1.2.19 --report-only
 *
 * Steps:
 *   1. Validate prerequisites (clean working tree, version tag exists)
 *   2. Create merge branch
 *   3. Start git merge (expect conflicts)
 *   4. Resolve keepOurs files (our custom code)
 *   5. Resolve skipFiles (accept upstream for packages we don't modify)
 *   6. Resolve lock files (accept ours, regenerate later)
 *   7. Report remaining conflicts for manual resolution
 *   8. After manual resolution: regenerate lock file, build, test
 */

import { parseArgs } from "util"
import { execSync } from "child_process"
import { git, gitSafe, tagExists, currentBranch, hasUncommittedChanges, conflictedFiles } from "./utils/git"
import { loadConfig, repoRoot } from "./utils/config"
import { resolveKeepOurs } from "./transforms/keep-ours"
import { resolveSkipFiles } from "./transforms/skip-files"
import { resolveLockFiles, regenerateLockFile } from "./transforms/lock-files"

const { values: args } = parseArgs({
  options: {
    version: { type: "string", short: "v" },
    "report-only": { type: "boolean", default: false },
    continue: { type: "boolean", default: false },
  },
})

async function main() {
  const config = loadConfig()

  if (args.continue) {
    await continueAfterManualResolution()
    return
  }

  const version = args.version
  if (!version) {
    console.error("Error: --version is required (e.g., --version v1.2.19)")
    process.exit(1)
  }

  // Step 1: Validate
  console.log("Step 1: Validating prerequisites...")

  // Fetch upstream tags
  console.log(`  Fetching ${config.upstreamRemote}...`)
  git(`fetch ${config.upstreamRemote} --tags`)

  if (!tagExists(version)) {
    console.error(`Error: Tag ${version} does not exist on ${config.upstreamRemote}`)
    console.error(`  Available tags: ${git("tag -l 'v1.2.*' --sort=-v:refname").split("\n").slice(0, 5).join(", ")}`)
    process.exit(1)
  }

  if (hasUncommittedChanges()) {
    console.error("Error: Working tree has uncommitted changes. Commit or stash first.")
    process.exit(1)
  }

  const branch = currentBranch()
  console.log(`  Current branch: ${branch}`)
  console.log(`  Target version: ${version}`)

  // Report-only mode: dry-run analysis
  if (args["report-only"]) {
    await reportOnly(version, config)
    return
  }

  // Step 2: Create merge branch
  const mergeBranch = `merge/upstream-${version}`
  console.log(`\nStep 2: Creating merge branch ${mergeBranch}...`)
  git(`checkout -b ${mergeBranch}`)

  // Step 3: Start merge
  console.log(`\nStep 3: Starting merge with ${version}...`)
  const mergeResult = gitSafe(`merge ${version} --no-edit`)

  if (mergeResult !== null) {
    console.log("  Merge completed without conflicts!")
    await postMerge()
    return
  }

  console.log("  Merge has conflicts (expected). Resolving...")

  // Step 4: Resolve keepOurs
  console.log("\nStep 4: Resolving keepOurs files...")
  const keepOursResult = resolveKeepOurs()
  console.log(`  Resolved ${keepOursResult.resolved.length} files (kept ours)`)
  for (const f of keepOursResult.resolved) console.log(`    ✓ ${f}`)

  // Step 5: Resolve skipFiles
  console.log("\nStep 5: Resolving skipFiles (accept upstream)...")
  const skipResult = resolveSkipFiles()
  console.log(`  Resolved ${skipResult.resolved.length} files (accepted upstream)`)

  // Step 6: Resolve lock files
  console.log("\nStep 6: Resolving lock files...")
  const lockResult = resolveLockFiles()
  console.log(`  Resolved ${lockResult.length} lock files`)

  // Step 7: Report remaining conflicts
  const remaining = conflictedFiles()
  if (remaining.length === 0) {
    console.log("\nAll conflicts resolved automatically!")
    git("commit --no-edit")
    await postMerge()
  } else {
    console.log(`\nStep 7: ${remaining.length} files need manual resolution:`)
    for (const f of remaining) {
      console.log(`  ⚠ ${f}`)
    }
    console.log("\nManual steps:")
    console.log("  1. Resolve the conflicts above")
    console.log("  2. git add <resolved files>")
    console.log("  3. bun run script/upstream/merge.ts --continue")
  }
}

async function continueAfterManualResolution() {
  const remaining = conflictedFiles()

  if (remaining.length > 0) {
    console.error(`Error: ${remaining.length} files still have conflicts:`)
    for (const f of remaining) console.error(`  ⚠ ${f}`)
    process.exit(1)
  }

  console.log("All conflicts resolved. Continuing merge...")
  git("commit --no-edit")
  await postMerge()
}

async function postMerge() {
  const root = repoRoot()
  const pkgDir = `${root}/packages/opencode`

  // Step 8: Regenerate lock file
  console.log("\nStep 8: Regenerating lock file...")
  regenerateLockFile()
  git('commit -m "chore: regenerate bun.lock after upstream merge"')

  // Step 9: Build
  console.log("\nStep 9: Building...")
  try {
    execSync("bun run build", { cwd: pkgDir, stdio: "inherit" })
    console.log("  ✓ Build passed")
  } catch {
    console.error("\n  ✗ Build failed!")
    console.error("  Fix build errors, then:")
    console.error("    git add -A && git commit -m 'fix: resolve build errors after upstream merge'")
    console.error("    bun run script/upstream/merge.ts --continue")
    process.exit(1)
  }

  // Step 10: Test
  console.log("\nStep 10: Running tests...")
  try {
    const testResult = execSync("bun test 2>&1", { cwd: pkgDir, encoding: "utf-8" })
    // Extract summary line
    const summary = testResult.split("\n").find((l) => l.includes("pass") && l.includes("fail"))
    if (summary) console.log(`  ${summary.trim()}`)
    console.log("  ✓ Tests passed")
  } catch (e: any) {
    // Tests may have failures — extract summary to show
    const output = e.stdout || e.stderr || ""
    const summary = output.split("\n").find((l: string) => l.includes("pass") && l.includes("fail"))
    if (summary) {
      console.log(`  ${summary.trim()}`)
    }
    console.warn("  ⚠ Some tests failed — review output above")
    console.warn("  If failures are pre-existing (same as main), this is OK")
  }

  // Step 11: Typecheck
  console.log("\nStep 11: Running typecheck...")
  try {
    execSync("bun run typecheck", { cwd: pkgDir, stdio: "inherit" })
    console.log("  ✓ Typecheck passed")
  } catch {
    console.warn("  ⚠ Typecheck has errors — review output above")
    console.warn("  If errors are pre-existing (same as main), this is OK")
  }

  console.log("\n═══════════════════════════════════════════════")
  console.log("  MERGE COMPLETE")
  console.log("═══════════════════════════════════════════════")
  console.log("\nReview:")
  console.log(`  git log --oneline HEAD~5..HEAD`)
  console.log(`  git diff main --stat`)
  console.log("\nWhen ready:")
  console.log(`  git push -u origin $(git branch --show-current)`)
  console.log(`  gh pr create --base main`)
}

async function reportOnly(version: string, config: ReturnType<typeof loadConfig>) {
  console.log(`\n--- Dry-run conflict analysis for ${version} ---\n`)

  // Get list of files that would change
  const diffFiles = git(`diff --name-only HEAD...${version}`).split("\n").filter(Boolean)
  console.log(`Total files changed in upstream: ${diffFiles.length}`)

  // Categorize
  const { minimatch } = await import("minimatch")
  const keepOurs: string[] = []
  const skipFiles: string[] = []
  const potentialConflicts: string[] = []
  const safeUpdates: string[] = []

  for (const file of diffFiles) {
    if (config.keepOurs.some((p) => minimatch(file, p))) {
      keepOurs.push(file)
    } else if (config.skipFiles.some((p) => minimatch(file, p))) {
      skipFiles.push(file)
    } else {
      // Check if we've modified this file
      const ourDiff = gitSafe(`diff HEAD -- ${file}`)
      if (ourDiff && ourDiff.length > 0) {
        potentialConflicts.push(file)
      } else {
        safeUpdates.push(file)
      }
    }
  }

  console.log(`\nKeepOurs (auto-resolved): ${keepOurs.length}`)
  console.log(`SkipFiles (accept upstream): ${skipFiles.length}`)
  console.log(`Safe updates (no conflict): ${safeUpdates.length}`)
  console.log(`Potential conflicts (manual review): ${potentialConflicts.length}`)

  if (potentialConflicts.length > 0) {
    console.log("\nFiles likely to conflict:")
    for (const f of potentialConflicts) {
      console.log(`  ⚠ ${f}`)
    }
  }

  // Check for altimate_change markers in potentially conflicted files
  const markerFiles: string[] = []
  for (const file of potentialConflicts) {
    const content = gitSafe(`show HEAD:${file}`)
    if (content && content.includes(config.changeMarker)) {
      markerFiles.push(file)
    }
  }

  if (markerFiles.length > 0) {
    console.log(`\nFiles with ${config.changeMarker} markers (need careful review):`)
    for (const f of markerFiles) console.log(`  📝 ${f}`)
  }
}

main().catch((e) => {
  console.error("Merge failed:", e)
  process.exit(1)
})
