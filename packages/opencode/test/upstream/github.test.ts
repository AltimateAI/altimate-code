import { describe, expect, test, mock, beforeEach } from "bun:test"

// ---------------------------------------------------------------------------
// Mock execSync to avoid real GitHub API calls
// ---------------------------------------------------------------------------

let mockExecOutput: string | null = null
let mockExecShouldThrow = false
let lastExecCmd: string | null = null

// Spread the real child_process module so `spawn`, `exec`, etc. still work,
// and only override `execSync` for our tests.
import * as realChildProcess from "child_process"

mock.module("child_process", () => ({
  ...realChildProcess,
  execSync: (cmd: string, _opts?: any) => {
    lastExecCmd = cmd
    if (mockExecShouldThrow) throw new Error("exec failed")
    return mockExecOutput ?? ""
  },
}))

// Import after mocking
const { fetchReleases, getRelease, getReleaseTags, validateRelease } = await import(
  "../../../../script/upstream/utils/github"
)

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const MOCK_RELEASES = [
  {
    tag_name: "v1.2.26",
    name: "v1.2.26",
    prerelease: false,
    draft: false,
    published_at: "2026-03-13T16:33:18Z",
    html_url: "https://github.com/anomalyco/opencode/releases/tag/v1.2.26",
  },
  {
    tag_name: "v1.2.25",
    name: "v1.2.25",
    prerelease: false,
    draft: false,
    published_at: "2026-03-12T23:34:33Z",
    html_url: "https://github.com/anomalyco/opencode/releases/tag/v1.2.25",
  },
  {
    tag_name: "v1.2.24-beta.1",
    name: "v1.2.24-beta.1",
    prerelease: true,
    draft: false,
    published_at: "2026-03-08T10:00:00Z",
    html_url: "https://github.com/anomalyco/opencode/releases/tag/v1.2.24-beta.1",
  },
  {
    tag_name: "v1.2.24",
    name: "v1.2.24",
    prerelease: false,
    draft: false,
    published_at: "2026-03-09T16:10:00Z",
    html_url: "https://github.com/anomalyco/opencode/releases/tag/v1.2.24",
  },
]

const MOCK_DRAFT_RELEASE = {
  tag_name: "v1.3.0",
  name: "v1.3.0",
  prerelease: false,
  draft: true,
  published_at: "2026-03-15T00:00:00Z",
  html_url: "https://github.com/anomalyco/opencode/releases/tag/v1.3.0",
}

// ---------------------------------------------------------------------------
// fetchReleases
// ---------------------------------------------------------------------------

describe("fetchReleases()", () => {
  beforeEach(() => {
    mockExecOutput = null
    mockExecShouldThrow = false
    lastExecCmd = null
  })

  test("returns stable releases, excluding drafts and pre-releases", async () => {
    const stableOnly = MOCK_RELEASES.filter((r) => !r.prerelease && !r.draft)
    mockExecOutput = JSON.stringify(stableOnly)

    const releases = await fetchReleases("anomalyco/opencode")
    expect(releases).toHaveLength(3)
    expect(releases.every((r) => !r.prerelease && !r.draft)).toBe(true)
  })

  test("includes pre-releases when includePrerelease is true", async () => {
    const nonDraft = MOCK_RELEASES.filter((r) => !r.draft)
    mockExecOutput = JSON.stringify(nonDraft)

    const releases = await fetchReleases("anomalyco/opencode", {
      includePrerelease: true,
    })
    expect(releases).toHaveLength(4)
    expect(releases.some((r) => r.prerelease)).toBe(true)
  })

  test("excludes draft releases even with includePrerelease", async () => {
    const allWithDraft = [...MOCK_RELEASES, MOCK_DRAFT_RELEASE].filter((r) => !r.draft)
    mockExecOutput = JSON.stringify(allWithDraft)

    const releases = await fetchReleases("anomalyco/opencode", {
      includePrerelease: true,
    })
    expect(releases.every((r) => !r.draft)).toBe(true)
  })

  test("returns empty array when no releases exist", async () => {
    mockExecOutput = ""

    const releases = await fetchReleases("anomalyco/opencode")
    expect(releases).toEqual([])
  })

  test("throws on API failure", async () => {
    mockExecShouldThrow = true

    expect(fetchReleases("anomalyco/opencode")).rejects.toThrow(
      "Failed to fetch releases",
    )
  })

  test("calls gh API with correct repo", async () => {
    mockExecOutput = "[]"

    await fetchReleases("anomalyco/opencode")
    expect(lastExecCmd).toContain("repos/anomalyco/opencode/releases")
  })

  test("respects limit parameter", async () => {
    mockExecOutput = "[]"

    await fetchReleases("anomalyco/opencode", { limit: 5 })
    expect(lastExecCmd).toContain(".[0:5]")
  })

  test("pipes paginated output to external jq for slurping", async () => {
    mockExecOutput = "[]"

    await fetchReleases("anomalyco/opencode")
    // Uses --jq '.[]' to unpack pages, then pipes to jq -s for slurping
    expect(lastExecCmd).toContain("--jq '.[]'")
    expect(lastExecCmd).toContain("| jq -s")
  })

  test("filters before slicing (filter then limit)", async () => {
    mockExecOutput = "[]"

    await fetchReleases("anomalyco/opencode", { limit: 10 })
    expect(lastExecCmd).toContain("[.[] | select(")
    expect(lastExecCmd).toMatch(/select\(.*\)\] \| \.\[0:10\]/)
  })
})

// ---------------------------------------------------------------------------
// getRelease
// ---------------------------------------------------------------------------

describe("getRelease()", () => {
  beforeEach(() => {
    mockExecOutput = null
    mockExecShouldThrow = false
    lastExecCmd = null
  })

  test("returns release for a valid published tag", async () => {
    mockExecOutput = JSON.stringify(MOCK_RELEASES[0])

    const release = await getRelease("anomalyco/opencode", "v1.2.26")
    expect(release).not.toBeNull()
    expect(release!.tag_name).toBe("v1.2.26")
    expect(release!.draft).toBe(false)
  })

  test("returns null for a draft release", async () => {
    mockExecOutput = JSON.stringify(MOCK_DRAFT_RELEASE)

    const release = await getRelease("anomalyco/opencode", "v1.3.0")
    expect(release).toBeNull()
  })

  test("returns null when tag does not exist", async () => {
    mockExecShouldThrow = true

    const release = await getRelease("anomalyco/opencode", "v99.99.99")
    expect(release).toBeNull()
  })

  test("returns null for empty response", async () => {
    mockExecOutput = ""

    const release = await getRelease("anomalyco/opencode", "v1.2.26")
    expect(release).toBeNull()
  })

  test("queries the correct tag endpoint", async () => {
    mockExecOutput = JSON.stringify(MOCK_RELEASES[0])

    await getRelease("anomalyco/opencode", "v1.2.26")
    expect(lastExecCmd).toContain("releases/tags/v1.2.26")
  })
})

// ---------------------------------------------------------------------------
// getReleaseTags
// ---------------------------------------------------------------------------

describe("getReleaseTags()", () => {
  beforeEach(() => {
    mockExecOutput = null
    mockExecShouldThrow = false
  })

  test("returns only tag names from releases", async () => {
    const stableOnly = MOCK_RELEASES.filter((r) => !r.prerelease && !r.draft)
    mockExecOutput = JSON.stringify(stableOnly)

    const tags = await getReleaseTags("anomalyco/opencode")
    expect(tags).toEqual(["v1.2.26", "v1.2.25", "v1.2.24"])
  })

  test("includes pre-release tags when requested", async () => {
    const nonDraft = MOCK_RELEASES.filter((r) => !r.draft)
    mockExecOutput = JSON.stringify(nonDraft)

    const tags = await getReleaseTags("anomalyco/opencode", {
      includePrerelease: true,
    })
    expect(tags).toContain("v1.2.24-beta.1")
  })
})

// ---------------------------------------------------------------------------
// validateRelease
// ---------------------------------------------------------------------------

describe("validateRelease()", () => {
  beforeEach(() => {
    mockExecOutput = null
    mockExecShouldThrow = false
  })

  test("valid: true for a published stable release", async () => {
    mockExecOutput = JSON.stringify(MOCK_RELEASES[0])

    const result = await validateRelease("anomalyco/opencode", "v1.2.26")
    expect(result.valid).toBe(true)
    expect(result.release).toBeDefined()
    expect(result.release!.tag_name).toBe("v1.2.26")
  })

  test("valid: false for a non-existent tag", async () => {
    mockExecShouldThrow = true

    const result = await validateRelease("anomalyco/opencode", "v99.99.99")
    expect(result.valid).toBe(false)
    expect(result.reason).toContain("not a published GitHub release")
  })

  test("valid: false for a pre-release", async () => {
    mockExecOutput = JSON.stringify(MOCK_RELEASES[2]) // beta

    const result = await validateRelease("anomalyco/opencode", "v1.2.24-beta.1")
    expect(result.valid).toBe(false)
    expect(result.reason).toContain("pre-release")
  })

  test("valid: false for a draft release", async () => {
    mockExecOutput = JSON.stringify(MOCK_DRAFT_RELEASE)

    // getRelease returns null for drafts
    const result = await validateRelease("anomalyco/opencode", "v1.3.0")
    expect(result.valid).toBe(false)
  })

  test("reason includes --include-prerelease hint for pre-releases", async () => {
    mockExecOutput = JSON.stringify(MOCK_RELEASES[2])

    const result = await validateRelease("anomalyco/opencode", "v1.2.24-beta.1")
    expect(result.reason).toContain("--include-prerelease")
  })

  test("reason mentions the repo name for non-existent tags", async () => {
    mockExecShouldThrow = true

    const result = await validateRelease("anomalyco/opencode", "vscode-v0.0.5")
    expect(result.reason).toContain("anomalyco/opencode")
  })

  test("valid: true for a pre-release when includePrerelease is true", async () => {
    mockExecOutput = JSON.stringify(MOCK_RELEASES[2]) // beta

    const result = await validateRelease("anomalyco/opencode", "v1.2.24-beta.1", {
      includePrerelease: true,
    })
    expect(result.valid).toBe(true)
    expect(result.release).toBeDefined()
    expect(result.release!.prerelease).toBe(true)
  })

  test("valid: false for a pre-release when includePrerelease is false", async () => {
    mockExecOutput = JSON.stringify(MOCK_RELEASES[2])

    const result = await validateRelease("anomalyco/opencode", "v1.2.24-beta.1", {
      includePrerelease: false,
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toContain("pre-release")
  })
})
