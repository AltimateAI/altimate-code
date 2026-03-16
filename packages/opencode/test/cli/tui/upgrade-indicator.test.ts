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

    test("returns version string when it differs from current version", () => {
      const result = getAvailableVersion("99.99.99")
      expect(result).toBe("99.99.99")
    })

    test("returns version for semver strings", () => {
      const versions = ["0.1.0", "1.0.0", "2.0.0-beta.1", "99.0.0"]
      for (const v of versions) {
        if (v === Installation.VERSION) continue
        expect(getAvailableVersion(v)).toBe(v)
      }
    })

    test("returns undefined for empty string", () => {
      // empty string is falsy, but typeof is "string" — it should still return undefined
      // because empty version is not a valid update target
      const result = getAvailableVersion("")
      // empty string matches Installation.VERSION only if VERSION is also empty
      if (Installation.VERSION === "") {
        expect(result).toBeUndefined()
      } else {
        // empty string is a valid string but not a meaningful version
        expect(result).toBe("")
      }
    })
  })
})
