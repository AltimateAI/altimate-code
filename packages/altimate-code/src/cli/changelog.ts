declare const ALTIMATE_CLI_CHANGELOG: string | undefined

/** Parse a semver string into comparable numeric tuple. Returns null on failure. */
function parseSemver(v: string): [number, number, number] | null {
  const clean = v.replace(/^v/, "").split("-")[0]
  const parts = clean.split(".")
  if (parts.length !== 3) return null
  const nums = parts.map(Number) as [number, number, number]
  if (nums.some(isNaN)) return null
  return nums
}

/** Compare two semver tuples: -1 if a < b, 0 if equal, 1 if a > b */
function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return -1
    if (a[i] > b[i]) return 1
  }
  return 0
}

/**
 * Parse changelog content and extract entries for versions between
 * `fromVersion` (exclusive) and `toVersion` (inclusive).
 */
export function extractChangelogFromContent(content: string, fromVersion: string, toVersion: string): string {
  try {
    if (!content) return ""

    const from = parseSemver(fromVersion)
    const to = parseSemver(toVersion)
    if (!from || !to) return ""

    // Split on ## [x.y.z] headings
    const sectionRegex = /^## \[([^\]]+)\]/gm
    const sections: { version: string; start: number }[] = []
    let match: RegExpExecArray | null
    while ((match = sectionRegex.exec(content)) !== null) {
      sections.push({ version: match[1], start: match.index })
    }

    if (sections.length === 0) return ""

    const lines: string[] = []
    for (let i = 0; i < sections.length; i++) {
      const ver = parseSemver(sections[i].version)
      if (!ver) continue
      // Include versions where: from < ver <= to
      if (compareSemver(ver, from) > 0 && compareSemver(ver, to) <= 0) {
        const end = i + 1 < sections.length ? sections[i + 1].start : content.length
        lines.push(content.slice(sections[i].start, end).trimEnd())
      }
    }

    return lines.join("\n\n")
  } catch {
    return ""
  }
}

/**
 * Extract changelog entries using the build-time bundled CHANGELOG.md.
 */
export function extractChangelog(fromVersion: string, toVersion: string): string {
  const content = typeof ALTIMATE_CLI_CHANGELOG === "string" ? ALTIMATE_CLI_CHANGELOG : ""
  return extractChangelogFromContent(content, fromVersion, toVersion)
}
