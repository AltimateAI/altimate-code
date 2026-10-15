import { describe, test, expect } from "bun:test"
import { assertSameMajor, compareVersionMajor, versionMajor } from "./utils/version"

describe("upstream version major", () => {
  test("allows minor and patch releases within the baseline's major", () => {
    expect(compareVersionMajor("v1.18.34", "v1.17.9")).toBe(0)
    expect(() => assertSameMajor("v1.18.34", "v1.17.9")).not.toThrow()
  })

  test("rejects cross-major merges with re-port guidance", () => {
    expect(compareVersionMajor("v2.0.29", "v1.17.9")).toBeGreaterThan(0)
    expect(compareVersionMajor("v1.17.9", "v2.0.29")).toBeLessThan(0)
    expect(() => assertSameMajor("v2.0.29", "v1.17.9")).toThrow("re-port, not a merge")
    expect(() => assertSameMajor("v2.0.29", "v1.17.9")).toThrow("re-port, not a merge")
    expect(() => assertSameMajor("v0.1.0", "v1.17.9")).toThrow("major differs")
  })

  test("accepts version tags with optional v, prerelease, and build metadata", () => {
    expect(versionMajor("1.18.34")).toBe(1)
    expect(versionMajor("v2.0.29-beta.1+build.42")).toBe(2)
    expect(compareVersionMajor("v1.18.34-rc.1", "v1.17.9")).toBe(0)
  })

  test("rejects malformed targets and baselines", () => {
    for (const version of ["", "dev", "upstream/main", "v2", "v1.2", "v1.x.3", "v01.2.3", "v1.2.3-", "v1.2.3-beta..1", "v1.2.3junk"]) {
      expect(() => versionMajor(version)).toThrow("Invalid upstream version")
      expect(() => compareVersionMajor(version, "v1.17.9")).toThrow("Invalid upstream version")
      expect(() => compareVersionMajor("v1.17.9", version)).toThrow("Invalid upstream version")
    }
  })
})
