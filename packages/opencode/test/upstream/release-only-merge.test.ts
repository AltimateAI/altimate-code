import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

// ---------------------------------------------------------------------------
// These tests verify the upstream merge tooling is configured to only
// accept published GitHub releases, not arbitrary commits or tags.
// ---------------------------------------------------------------------------

const SCRIPT_DIR = path.resolve(__dirname, "..", "..", "..", "..", "script", "upstream")

describe("merge.ts release-only enforcement", () => {
  const mergeScript = fs.readFileSync(
    path.join(SCRIPT_DIR, "merge.ts"),
    "utf-8",
  )

  test("does not accept --commit flag", () => {
    // The --commit option should have been removed
    expect(mergeScript).not.toContain('"commit"')
    expect(mergeScript).not.toContain("'commit'")
  })

  test("imports validateRelease from github utils", () => {
    expect(mergeScript).toContain("validateRelease")
    expect(mergeScript).toContain("./utils/github")
  })

  test("validates version against GitHub releases", () => {
    expect(mergeScript).toContain("validateRelease(")
    expect(mergeScript).toContain("published release")
  })

  test("supports --include-prerelease flag", () => {
    expect(mergeScript).toContain("include-prerelease")
  })

  test("does not reference commitRef or commit SHA merging", () => {
    // No references to merging arbitrary commit SHAs
    expect(mergeScript).not.toContain("commitRef")
    expect(mergeScript).not.toContain("--commit")
  })

  test("shows recent releases on validation failure", () => {
    expect(mergeScript).toContain("getReleaseTags")
    expect(mergeScript).toContain("Recent releases")
  })

  test("displays published date on validation success", () => {
    expect(mergeScript).toContain("published release")
    expect(mergeScript).toContain("published_at")
  })

  test("help text mentions only releases, not commits", () => {
    // Extract help text (between printUsage function)
    const helpMatch = mergeScript.match(
      /function printUsage[\s\S]*?^}/m,
    )
    expect(helpMatch).not.toBeNull()
    const helpText = helpMatch![0]
    expect(helpText).not.toContain("--commit")
    expect(helpText).not.toContain("Merge a specific commit")
    expect(helpText).toContain("Only published GitHub releases")
  })
})

describe("list-versions.ts release-based listing", () => {
  const listScript = fs.readFileSync(
    path.join(SCRIPT_DIR, "list-versions.ts"),
    "utf-8",
  )

  test("imports fetchReleases from github utils", () => {
    expect(listScript).toContain("fetchReleases")
    expect(listScript).toContain("./utils/github")
  })

  test("fetches releases from GitHub API, not just git tags", () => {
    expect(listScript).toContain("fetchReleases(")
    expect(listScript).toContain("published releases")
  })

  test("supports --include-prerelease flag", () => {
    expect(listScript).toContain("include-prerelease")
  })

  test("header says Releases not Versions", () => {
    expect(listScript).toContain("Upstream OpenCode Releases")
  })

  test("help text mentions only releases", () => {
    expect(listScript).toContain("Only published GitHub releases are shown")
  })
})

describe("utils/github.ts module structure", () => {
  const githubModule = fs.readFileSync(
    path.join(SCRIPT_DIR, "utils", "github.ts"),
    "utf-8",
  )

  test("exports fetchReleases function", () => {
    expect(githubModule).toContain("export async function fetchReleases")
  })

  test("exports getRelease function", () => {
    expect(githubModule).toContain("export async function getRelease")
  })

  test("exports getReleaseTags function", () => {
    expect(githubModule).toContain("export async function getReleaseTags")
  })

  test("exports validateRelease function", () => {
    expect(githubModule).toContain("export async function validateRelease")
  })

  test("exports GitHubRelease interface", () => {
    expect(githubModule).toContain("export interface GitHubRelease")
  })

  test("filters out draft releases by default", () => {
    expect(githubModule).toContain("draft == false")
  })

  test("filters out pre-releases by default", () => {
    expect(githubModule).toContain("prerelease == false")
  })

  test("uses gh CLI for API calls", () => {
    expect(githubModule).toContain("gh api")
  })

  test("pipes to external jq for paginated output handling", () => {
    expect(githubModule).toContain("jq -s")
    expect(githubModule).toContain("--jq '.[]'")
  })

  test("getRelease returns null for draft releases", () => {
    expect(githubModule).toContain("if (release.draft) return null")
  })
})

describe("config.ts still references upstream repo correctly", () => {
  const configModule = fs.readFileSync(
    path.join(SCRIPT_DIR, "utils", "config.ts"),
    "utf-8",
  )

  test("upstreamRepo points to anomalyco/opencode", () => {
    expect(configModule).toContain('"anomalyco/opencode"')
  })

  test("originRepo points to AltimateAI/altimate-code", () => {
    expect(configModule).toContain('"AltimateAI/altimate-code"')
  })
})
