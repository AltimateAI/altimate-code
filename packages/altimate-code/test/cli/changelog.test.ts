import { test, expect } from "bun:test"
import { extractChangelogFromContent } from "../../src/cli/changelog"

const sampleChangelog = `# Changelog

## [0.3.0] - 2026-04-01

### Added

- New feature A

## [0.2.2] - 2026-03-05

### Fixed

- Bug fix B

## [0.2.1] - 2026-03-05

### Added

- Feature C

## [0.2.0] - 2026-03-04

### Added

- Feature D

## [0.1.0] - 2025-06-01

### Added

- Initial release
`

test("extracts changelog between two versions", () => {
  const result = extractChangelogFromContent(sampleChangelog, "0.2.0", "0.2.2")
  expect(result).toContain("## [0.2.2]")
  expect(result).toContain("Bug fix B")
  expect(result).toContain("## [0.2.1]")
  expect(result).toContain("Feature C")
  expect(result).not.toContain("## [0.2.0]")
  expect(result).not.toContain("## [0.3.0]")
  expect(result).not.toContain("## [0.1.0]")
})

test("extracts single version", () => {
  const result = extractChangelogFromContent(sampleChangelog, "0.2.1", "0.2.2")
  expect(result).toContain("## [0.2.2]")
  expect(result).toContain("Bug fix B")
  expect(result).not.toContain("## [0.2.1]")
})

test("returns empty string when no versions in range", () => {
  const result = extractChangelogFromContent(sampleChangelog, "0.3.0", "0.4.0")
  expect(result).toBe("")
})

test("returns empty string for empty content", () => {
  expect(extractChangelogFromContent("", "0.1.0", "0.2.0")).toBe("")
})

test("handles v-prefixed versions", () => {
  const result = extractChangelogFromContent(sampleChangelog, "v0.2.0", "v0.2.2")
  expect(result).toContain("## [0.2.2]")
  expect(result).toContain("## [0.2.1]")
})

test("returns empty string for invalid version strings", () => {
  expect(extractChangelogFromContent(sampleChangelog, "not-a-version", "0.2.0")).toBe("")
  expect(extractChangelogFromContent(sampleChangelog, "0.1.0", "bad")).toBe("")
})

test("works with the real CHANGELOG.md", async () => {
  const fs = await import("fs")
  const path = await import("path")
  const changelogPath = path.resolve(import.meta.dir, "../../../../CHANGELOG.md")
  if (!fs.existsSync(changelogPath)) return // skip if not available

  const content = fs.readFileSync(changelogPath, "utf-8")
  const result = extractChangelogFromContent(content, "0.1.0", "0.2.0")
  expect(result).toContain("## [0.2.0]")
  expect(result).toContain("Context management")
  expect(result).not.toContain("## [0.1.0]")
})
