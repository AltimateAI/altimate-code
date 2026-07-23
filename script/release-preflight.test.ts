import { describe, test, expect } from "bun:test"
import {
  normalizeVersion,
  parseSemver,
  compareSemver,
  isStableTagName,
  selectPrevTag,
  prereleaseLineTags,
} from "./release-preflight"

describe("normalizeVersion", () => {
  test("strips a leading lowercase v", () => {
    expect(normalizeVersion("v0.9.3")).toBe("0.9.3")
  })

  test("strips a leading uppercase V", () => {
    expect(normalizeVersion("V0.9.3")).toBe("0.9.3")
  })

  test("leaves a version with no leading v untouched", () => {
    expect(normalizeVersion("0.9.3")).toBe("0.9.3")
  })

  test("leaves a prerelease version untouched aside from the v", () => {
    expect(normalizeVersion("v0.9.3-beta.1")).toBe("0.9.3-beta.1")
  })
})

describe("parseSemver", () => {
  test("parses a stable version", () => {
    expect(parseSemver("0.9.3")).toEqual({ major: 0, minor: 9, patch: 3, prerelease: null })
  })

  test("parses a prerelease version", () => {
    expect(parseSemver("0.9.3-beta.1")).toEqual({ major: 0, minor: 9, patch: 3, prerelease: "beta.1" })
  })

  test("parses multi-digit components", () => {
    expect(parseSemver("12.34.567")).toEqual({ major: 12, minor: 34, patch: 567, prerelease: null })
  })

  test("rejects a version with a leading v (call normalizeVersion first)", () => {
    expect(parseSemver("v0.9.3")).toBeNull()
  })

  test("rejects a missing patch component", () => {
    expect(parseSemver("0.9")).toBeNull()
  })

  test("rejects non-numeric components", () => {
    expect(parseSemver("0.9.x")).toBeNull()
  })

  test("rejects garbage input", () => {
    expect(parseSemver("not-a-version")).toBeNull()
    expect(parseSemver("")).toBeNull()
  })
})

describe("compareSemver", () => {
  const v = (s: string) => parseSemver(s)!

  test("orders by major first", () => {
    expect(compareSemver(v("1.0.0"), v("0.9.9"))).toBeGreaterThan(0)
    expect(compareSemver(v("0.9.9"), v("1.0.0"))).toBeLessThan(0)
  })

  test("orders by minor when major is equal", () => {
    expect(compareSemver(v("0.10.0"), v("0.9.0"))).toBeGreaterThan(0)
  })

  test("orders by patch when major.minor is equal", () => {
    expect(compareSemver(v("0.9.2"), v("0.9.1"))).toBeGreaterThan(0)
  })

  test("equal versions compare equal", () => {
    expect(compareSemver(v("0.9.2"), v("0.9.2"))).toBe(0)
  })

  test("a stable version is greater than a prerelease of the same major.minor.patch", () => {
    expect(compareSemver(v("0.9.2"), v("0.9.2-beta.1"))).toBeGreaterThan(0)
    expect(compareSemver(v("0.9.2-beta.1"), v("0.9.2"))).toBeLessThan(0)
  })

  test("equal prerelease strings compare equal", () => {
    expect(compareSemver(v("0.9.2-beta.1"), v("0.9.2-beta.1"))).toBe(0)
  })

  test("prerelease identifiers compare numerically per SemVer (beta.10 > beta.2)", () => {
    expect(compareSemver(v("0.9.2-beta.10"), v("0.9.2-beta.2"))).toBeGreaterThan(0)
    expect(compareSemver(v("0.9.2-beta.2"), v("0.9.2-beta.10"))).toBeLessThan(0)
  })

  test("numeric prerelease identifiers rank below alphanumeric ones", () => {
    expect(compareSemver(v("0.9.2-1"), v("0.9.2-alpha"))).toBeLessThan(0)
  })

  test("a prerelease identifier prefix ranks below its longer form", () => {
    expect(compareSemver(v("0.9.2-beta"), v("0.9.2-beta.1"))).toBeLessThan(0)
  })

  test("major/minor/patch precedence beats prerelease presence", () => {
    // A higher patch prerelease still beats a lower patch stable.
    expect(compareSemver(v("0.9.3-beta.1"), v("0.9.2"))).toBeGreaterThan(0)
  })
})

describe("isStableTagName", () => {
  test("accepts vX.Y.Z", () => {
    expect(isStableTagName("v0.9.2")).toBe(true)
    expect(isStableTagName("v12.34.567")).toBe(true)
  })

  test("rejects prerelease tags", () => {
    expect(isStableTagName("v0.9.2-beta.1")).toBe(false)
  })

  test("rejects tags without a leading v", () => {
    expect(isStableTagName("0.9.2")).toBe(false)
  })

  test("rejects malformed tags", () => {
    expect(isStableTagName("v0.9")).toBe(false)
    expect(isStableTagName("v0.9.2.1")).toBe(false)
    expect(isStableTagName("release-0.9.2")).toBe(false)
  })
})

describe("selectPrevTag", () => {
  test("picks the highest stable tag below the current one", () => {
    const tags = ["v0.9.0", "v0.9.1", "v0.9.2", "v0.8.10"]
    expect(selectPrevTag(tags, "v0.9.2")).toBe("v0.9.1")
  })

  test("excludes the current tag even if present in the merged list", () => {
    const tags = ["v0.9.2", "v0.9.1"]
    expect(selectPrevTag(tags, "v0.9.2")).toBe("v0.9.1")
  })

  test("ignores prerelease tags — the v0.9.1 PREV_TAG bug", () => {
    // Without this filter, a stray/divergent prerelease tag with a
    // lexically-higher name could win a naive string sort.
    const tags = ["v0.9.0", "v0.9.1-beta.5", "v0.9.1-beta.9"]
    expect(selectPrevTag(tags, "v0.9.2")).toBe("v0.9.0")
  })

  test("ignores non-semver / malformed tag names", () => {
    const tags = ["v0.9.0", "not-a-tag", "v0.9"]
    expect(selectPrevTag(tags, "v0.9.1")).toBe("v0.9.0")
  })

  test("returns null when no eligible previous tag exists", () => {
    expect(selectPrevTag([], "v0.1.0")).toBeNull()
    expect(selectPrevTag(["v0.1.0"], "v0.1.0")).toBeNull()
  })

  test("sorts by semantic version, not lexical string order", () => {
    // Lexically, "v0.10.0" < "v0.9.0" is false as a string compare in the
    // wrong direction people expect — this asserts we sort numerically.
    const tags = ["v0.9.0", "v0.10.0", "v0.2.0"]
    expect(selectPrevTag(tags, "v0.11.0")).toBe("v0.10.0")
  })

  test("ignores merged tags HIGHER than the target (fork-inherited upstream tags)", () => {
    // If upstream history is ever merged, tags like v1.18.3 become ancestors
    // of HEAD. They must not become PREV_TAG for a v0.9.x release — the
    // compare range would silently omit history.
    const tags = ["v1.18.3", "v1.17.13", "v0.9.2", "v0.9.1"]
    expect(selectPrevTag(tags, "v0.9.3")).toBe("v0.9.2")
  })

  test("returns null when only higher tags are merged", () => {
    expect(selectPrevTag(["v1.18.3"], "v0.9.3")).toBeNull()
  })
})

describe("prereleaseLineTags", () => {
  test("matches prerelease tags for the given major.minor", () => {
    const tags = ["v0.9.0-beta.1", "v0.9.0-beta.2", "v0.9.1", "v0.8.5-beta.1"]
    expect(prereleaseLineTags(tags, 0, 9)).toEqual(["v0.9.0-beta.1", "v0.9.0-beta.2"])
  })

  test("does not match stable tags", () => {
    expect(prereleaseLineTags(["v0.9.1", "v0.9.2"], 0, 9)).toEqual([])
  })

  test("does not match a different major.minor line", () => {
    expect(prereleaseLineTags(["v0.8.5-beta.1", "v1.0.0-beta.1"], 0, 9)).toEqual([])
  })

  test("matches across different patch numbers within the same line", () => {
    const tags = ["v0.9.0-beta.1", "v0.9.3-beta.1", "v0.9.10-rc.1"]
    expect(prereleaseLineTags(tags, 0, 9)).toEqual(tags)
  })

  test("returns empty array for no matches", () => {
    expect(prereleaseLineTags([], 0, 9)).toEqual([])
    expect(prereleaseLineTags(["v1.0.0"], 0, 9)).toEqual([])
  })
})
