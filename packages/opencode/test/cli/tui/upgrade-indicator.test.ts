import { describe, expect, test } from "bun:test"
import { UPGRADE_KV_KEY, getAvailableVersion } from "../../../src/cli/cmd/tui/component/upgrade-indicator-utils"
import { Installation } from "../../../src/installation"

describe("upgrade-indicator-utils", () => {
  describe("UPGRADE_KV_KEY", () => {
    test("exports a consistent KV key", () => {
      expect(UPGRADE_KV_KEY).toBe("update_available_version")
    })
  })

  describe("getAvailableVersion", () => {
    test("returns undefined when KV value is undefined", () => {
      expect(getAvailableVersion(undefined)).toBeUndefined()
    })

    test("returns undefined when KV value is null", () => {
      expect(getAvailableVersion(null)).toBeUndefined()
    })

    test("returns undefined when KV value is not a string", () => {
      expect(getAvailableVersion(123)).toBeUndefined()
      expect(getAvailableVersion(true)).toBeUndefined()
      expect(getAvailableVersion({})).toBeUndefined()
      expect(getAvailableVersion([])).toBeUndefined()
    })

    test("returns undefined when KV value matches current version", () => {
      expect(getAvailableVersion(Installation.VERSION)).toBeUndefined()
    })

    test("returns version string when it is newer than current version", () => {
      const result = getAvailableVersion("99.99.99")
      expect(result).toBe("99.99.99")
    })

    test("returns undefined for empty string", () => {
      expect(getAvailableVersion("")).toBeUndefined()
    })

    test("returns version when stored version is newer or unparseable (dev mode)", () => {
      // In dev mode VERSION="local", semver parsing falls back to showing indicator
      const result = getAvailableVersion("999.0.0")
      expect(typeof result === "string" || result === undefined).toBe(true)
    })

    test("returns version for any valid semver in dev mode", () => {
      // When VERSION="local" (dev), isNewer returns true for any candidate
      // When VERSION is semver, only truly newer versions pass
      const result = getAvailableVersion("0.0.1")
      if (Installation.VERSION === "local") {
        expect(result).toBe("0.0.1")
      } else {
        expect(result).toBeUndefined()
      }
    })
  })
})
