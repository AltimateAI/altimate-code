// GitHub Releases API utilities for upstream merge tooling.
// Ensures we only merge from official published releases, not arbitrary
// tags or commits.

import { execSync } from "child_process"

export interface GitHubRelease {
  tag_name: string
  name: string
  prerelease: boolean
  draft: boolean
  published_at: string
  html_url: string
}

/**
 * Fetch published releases from a GitHub repository using the `gh` CLI.
 * Returns only non-draft releases, sorted by publish date (newest first).
 *
 * By default filters out pre-releases; pass `includePrerelease: true` to include them.
 */
export async function fetchReleases(
  repo: string,
  options: { limit?: number; includePrerelease?: boolean } = {},
): Promise<GitHubRelease[]> {
  const { limit, includePrerelease = false } = options

  // `gh api --paginate` with `--jq '.[]'` unpacks each page's array into
  // individual JSON objects (one per line). We then pipe to external `jq -s`
  // to slurp them into a single array for filtering and slicing.
  // Note: `gh api` does not support `--slurp` — that's a jq-only flag.
  const condition = includePrerelease
    ? "select(.draft == false)"
    : "select(.draft == false and .prerelease == false)"
  const slice = limit != null ? ` | .[0:${limit}]` : ""
  const jqFilter = `[.[] | ${condition}]${slice}`

  const cmd = `gh api repos/${repo}/releases --paginate --jq '.[]' | jq -s '${jqFilter}'`

  try {
    const output = execSync(cmd, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    }).trim()

    if (!output) return []
    return JSON.parse(output) as GitHubRelease[]
  } catch (e: any) {
    throw new Error(`Failed to fetch releases from ${repo}: ${e.message || e}`)
  }
}

/**
 * Check whether a specific version tag corresponds to a published GitHub release.
 * Returns the release info if found, or null if the tag is not a release.
 */
export async function getRelease(
  repo: string,
  tag: string,
): Promise<GitHubRelease | null> {
  const cmd = `gh api repos/${repo}/releases/tags/${tag} --jq '{tag_name, name, prerelease, draft, published_at, html_url}'`

  try {
    const output = execSync(cmd, {
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
      timeout: 15_000,
    }).trim()

    if (!output) return null
    const release = JSON.parse(output) as GitHubRelease
    if (release.draft) return null
    return release
  } catch {
    return null
  }
}

/**
 * Get all release tag names from a GitHub repository.
 * Returns only non-draft, non-prerelease tags by default.
 */
export async function getReleaseTags(
  repo: string,
  options: { includePrerelease?: boolean } = {},
): Promise<string[]> {
  const releases = await fetchReleases(repo, options)
  return releases.map((r) => r.tag_name)
}

/**
 * Validate that a version string corresponds to a published release.
 * Returns an object with the validation result and, on failure, a helpful message.
 */
export async function validateRelease(
  repo: string,
  version: string,
  options: { includePrerelease?: boolean } = {},
): Promise<{ valid: boolean; release?: GitHubRelease; reason?: string }> {
  const release = await getRelease(repo, version)

  if (!release) {
    return {
      valid: false,
      reason: `'${version}' is not a published GitHub release on ${repo}. Only released versions can be merged.`,
    }
  }

  if (release.prerelease && !options.includePrerelease) {
    return {
      valid: false,
      release,
      reason: `'${version}' is a pre-release, not a stable release. Use --include-prerelease to allow pre-releases.`,
    }
  }

  return { valid: true, release }
}
