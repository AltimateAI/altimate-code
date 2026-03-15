#!/usr/bin/env bun
/**
 * List Upstream Versions
 *
 * Shows available upstream OpenCode releases (from GitHub Releases API)
 * with merge status indicators. Only published releases are shown —
 * arbitrary tags and commits are excluded.
 *
 * Usage:
 *   bun run script/upstream/list-versions.ts
 *   bun run script/upstream/list-versions.ts --limit 20
 *   bun run script/upstream/list-versions.ts --all
 *   bun run script/upstream/list-versions.ts --json
 */

import { parseArgs } from "util"
import { $ } from "bun"
import * as git from "./utils/git"
import * as logger from "./utils/logger"
import { loadConfig, repoRoot } from "./utils/config"
import { fetchReleases, type GitHubRelease } from "./utils/github"

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    limit: { type: "string", default: "30" },
    all: { type: "boolean", default: false },
    "include-prerelease": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: false,
}) as any

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const CYAN = "\x1b[36m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"

function bold(s: string): string { return `${BOLD}${s}${RESET}` }

// ---------------------------------------------------------------------------
// Version info
// ---------------------------------------------------------------------------

interface VersionInfo {
  tag: string
  date: string
  isMerged: boolean
  isCurrent: boolean
  commitsBehind: number
}

/**
 * Parse a version string into comparable parts.
 * Handles: v1.2.21, v1.2.21-beta.1, 1.2.21, etc.
 */
function parseVersion(tag: string): { major: number; minor: number; patch: number; prerelease: string } {
  const cleaned = tag.replace(/^v/, "")
  const [mainPart, ...preParts] = cleaned.split("-")
  const [major, minor, patch] = (mainPart || "0.0.0").split(".").map(Number)
  return {
    major: major || 0,
    minor: minor || 0,
    patch: patch || 0,
    prerelease: preParts.join("-"),
  }
}

/**
 * Compare two version strings for sorting (descending — newest first).
 */
function compareVersions(a: string, b: string): number {
  const va = parseVersion(a)
  const vb = parseVersion(b)

  if (va.major !== vb.major) return vb.major - va.major
  if (va.minor !== vb.minor) return vb.minor - va.minor
  if (va.patch !== vb.patch) return vb.patch - va.patch

  // Stable releases sort before prereleases
  if (!va.prerelease && vb.prerelease) return -1
  if (va.prerelease && !vb.prerelease) return 1

  return va.prerelease.localeCompare(vb.prerelease)
}

/**
 * Check if a version tag has been merged into the current branch.
 * Uses git merge-base --is-ancestor to determine ancestry.
 */
async function isTagMerged(tag: string): Promise<boolean> {
  const root = repoRoot()
  try {
    await $`git merge-base --is-ancestor ${tag} HEAD`.cwd(root).quiet()
    return true
  } catch {
    return false
  }
}

/**
 * Get the commit date of a tag as an ISO date string (YYYY-MM-DD).
 */
async function getTagDate(tag: string): Promise<string> {
  const root = repoRoot()
  try {
    const date = await $`git log -1 --format=%ci ${tag}`.cwd(root).text()
    return date.trim().split(" ")[0] || "unknown"
  } catch {
    return "unknown"
  }
}

/**
 * Count commits between HEAD and a tag (how far ahead we are).
 */
async function commitsBehind(tag: string): Promise<number> {
  const root = repoRoot()
  try {
    const count = await $`git rev-list --count HEAD..${tag}`.cwd(root).text()
    return parseInt(count.trim(), 10) || 0
  } catch {
    return -1
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`
  ${bold("List Upstream Versions")} — Show available OpenCode releases

  ${bold("USAGE")}
    bun run script/upstream/list-versions.ts
    bun run script/upstream/list-versions.ts --limit 50
    bun run script/upstream/list-versions.ts --all --json

  ${bold("OPTIONS")}
    --limit <n>            Number of versions to show (default: 30)
    --all                  Show all versions (no limit)
    --include-prerelease   Include pre-release versions
    --json                 Output as JSON
    --help, -h             Show this help message

  ${bold("NOTE")}
    Only published GitHub releases are shown. Arbitrary tags and
    commits are not listed. This ensures you only merge stable releases.

  ${bold("LEGEND")}
    ${GREEN}merged${RESET}     Already merged into current branch
    ${YELLOW}available${RESET}  Not yet merged
    ${CYAN}latest${RESET}     Most recent upstream release
`)
}

async function main(): Promise<void> {
  if (args.help) {
    printUsage()
    process.exit(0)
  }

  const config = loadConfig()
  const root = repoRoot()
  const limit = args.all ? Infinity : parseInt(args.limit || "30", 10)

  // Ensure upstream remote exists (for merge-base checks)
  const hasUpstream = await git.hasRemote(config.upstreamRemote)
  if (!hasUpstream) {
    logger.info(`Adding upstream remote: ${config.upstreamRepo}`)
    await git.addRemote(
      config.upstreamRemote,
      `https://github.com/${config.upstreamRepo}.git`,
    )
  }

  // Fetch upstream tags so merge-base checks work
  logger.info(`Fetching tags from ${config.upstreamRemote}...`)
  await git.fetchRemote(config.upstreamRemote)

  // Get published releases from GitHub API (not raw git tags)
  logger.info(`Fetching releases from GitHub (${config.upstreamRepo})...`)
  const releases = await fetchReleases(config.upstreamRepo, {
    includePrerelease: Boolean(args["include-prerelease"]),
    limit: limit === Infinity ? undefined : limit,
  })

  // Extract tags and sort by version
  const versionTags = releases
    .map((r) => r.tag_name)
    .sort(compareVersions)

  if (versionTags.length === 0) {
    logger.warn("No published releases found on upstream")
    process.exit(0)
  }

  const tagsToShow = versionTags.slice(0, Math.min(limit, versionTags.length))

  logger.info(`Found ${versionTags.length} published releases, showing ${tagsToShow.length}`)
  console.log()

  // Gather info for each tag (batch lookups for performance)
  const versions: VersionInfo[] = []
  const currentBranch = await git.getCurrentBranch()

  // Process in batches of 5 for reasonable parallelism
  for (let batch = 0; batch < tagsToShow.length; batch += 5) {
    const batchTags = tagsToShow.slice(batch, batch + 5)

    // Progress indicator
    if (tagsToShow.length > 10) {
      process.stdout.write(`  Checking ${Math.min(batch + 5, tagsToShow.length)}/${tagsToShow.length}...\r`)
    }

    const batchResults = await Promise.all(
      batchTags.map(async (tag, idx) => {
        const [merged, date, behind] = await Promise.all([
          isTagMerged(tag),
          getTagDate(tag),
          commitsBehind(tag),
        ])
        return {
          tag,
          date,
          isMerged: merged,
          isCurrent: batch + idx === 0, // First in sorted list is latest
          commitsBehind: behind,
        }
      }),
    )

    versions.push(...batchResults)
  }

  // Clear progress line
  if (tagsToShow.length > 10) {
    process.stdout.write(" ".repeat(50) + "\r")
  }

  // JSON output
  if (args.json) {
    console.log(JSON.stringify({
      remote: config.upstreamRemote,
      repo: config.upstreamRepo,
      currentBranch,
      totalVersions: versionTags.length,
      versions,
    }, null, 2))
    return
  }

  // Table output
  const latestTag = versions[0]?.tag || "unknown"
  const mergedCount = versions.filter((v) => v.isMerged).length
  const availableCount = versions.filter((v) => !v.isMerged).length

  // Header
  const line = "═".repeat(60)
  console.log(`${CYAN}${line}${RESET}`)
  console.log(`${CYAN}  ${BOLD}Upstream OpenCode Releases${RESET}`)
  console.log(`${CYAN}${line}${RESET}`)
  console.log()
  console.log(`  Remote:   ${config.upstreamRemote} (${config.upstreamRepo})`)
  console.log(`  Branch:   ${currentBranch}`)
  console.log(`  Latest:   ${CYAN}${BOLD}${latestTag}${RESET}`)
  console.log(`  Merged:   ${GREEN}${mergedCount}${RESET}  Available: ${YELLOW}${availableCount}${RESET}`)
  console.log()

  // Column headers
  const tagCol = "Version".padEnd(20)
  const dateCol = "Date".padEnd(12)
  const statusCol = "Status".padEnd(12)
  const behindCol = "Behind"
  console.log(`  ${BOLD}${tagCol}${dateCol}${statusCol}${behindCol}${RESET}`)
  console.log(`  ${"─".repeat(54)}`)

  // Rows
  for (const v of versions) {
    const tag = v.tag.padEnd(20)
    const date = v.date.padEnd(12)

    let status: string
    if (v.isCurrent && !v.isMerged) {
      status = `${CYAN}${BOLD}latest${RESET}`.padEnd(12 + CYAN.length + BOLD.length + RESET.length)
    } else if (v.isCurrent && v.isMerged) {
      status = `${GREEN}merged${RESET}`.padEnd(12 + GREEN.length + RESET.length)
    } else if (v.isMerged) {
      status = `${GREEN}merged${RESET}`.padEnd(12 + GREEN.length + RESET.length)
    } else {
      status = `${YELLOW}available${RESET}`.padEnd(12 + YELLOW.length + RESET.length)
    }

    const behind = v.commitsBehind > 0 && !v.isMerged
      ? `${DIM}${v.commitsBehind} commits${RESET}`
      : ""

    console.log(`  ${tag}${DIM}${date}${RESET}${status}${behind}`)
  }

  if (versionTags.length > tagsToShow.length) {
    console.log()
    console.log(`  ${DIM}Showing ${tagsToShow.length} of ${versionTags.length} versions. Use --all to see all.${RESET}`)
  }

  // Suggest next merge
  if (availableCount > 0) {
    const nextVersion = versions.find((v) => !v.isMerged)
    if (nextVersion) {
      console.log()
      console.log(`  ${bold("Next merge:")}`)
      console.log(`    bun run script/upstream/merge.ts --version ${nextVersion.tag}`)
      console.log()
      console.log(`  ${bold("Analyze first:")}`)
      console.log(`    bun run script/upstream/analyze.ts --version ${nextVersion.tag}`)
    }
  }

  console.log()
}

main().catch((e) => {
  logger.error(`Failed to list versions: ${e.message || e}`)
  process.exit(1)
})
