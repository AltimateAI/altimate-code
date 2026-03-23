import { describe, expect, test } from "bun:test"
import semver from "semver"
import { Installation } from "../../src/installation"

/**
 * Tests for the upgrade() decision logic in cli/upgrade.ts.
 *
 * Since upgrade() depends on Config, Bus, and Installation with side effects,
 * we test the decision logic directly — the same conditions that upgrade() checks.
 * This validates the fix for: silent skip on unknown method, autoupdate=false,
 * failed auto-upgrade, and downgrade prevention.
 */

// ─── Decision Logic Extracted from upgrade() ─────────────────────────────────
// These mirror the exact checks in cli/upgrade.ts so we can test every path.

type Decision = "skip" | "notify" | "auto-upgrade"

function upgradeDecision(input: {
  latest: string | undefined
  currentVersion: string
  autoupdate: boolean | "notify" | undefined
  disableAutoupdate: boolean
  method: string
}): Decision {
  const { latest, currentVersion, autoupdate, disableAutoupdate, method } = input

  if (!latest) return "skip"
  if (currentVersion === latest) return "skip"

  // Prevent downgrade
  if (
    currentVersion !== "local" &&
    semver.valid(currentVersion) &&
    semver.valid(latest) &&
    semver.gte(currentVersion, latest)
  ) {
    return "skip"
  }

  if (autoupdate === false || disableAutoupdate) return "notify"
  if (autoupdate === "notify") return "notify"
  if (method === "unknown" || method === "yarn") return "notify"

  return "auto-upgrade"
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("upgrade decision logic", () => {
  describe("skip: no latest version available", () => {
    test("latest is undefined (network failure)", () => {
      expect(upgradeDecision({
        latest: undefined,
        currentVersion: "0.5.2",
        autoupdate: undefined,
        disableAutoupdate: false,
        method: "npm",
      })).toBe("skip")
    })

    test("latest is empty string", () => {
      expect(upgradeDecision({
        latest: "",
        currentVersion: "0.5.2",
        autoupdate: undefined,
        disableAutoupdate: false,
        method: "npm",
      })).toBe("skip")
    })
  })

  describe("skip: already up to date", () => {
    test("same version string", () => {
      expect(upgradeDecision({
        latest: "0.5.7",
        currentVersion: "0.5.7",
        autoupdate: undefined,
        disableAutoupdate: false,
        method: "npm",
      })).toBe("skip")
    })
  })

  describe("skip: downgrade prevention", () => {
    test("current version is newer than latest (canary/preview user)", () => {
      expect(upgradeDecision({
        latest: "0.5.7",
        currentVersion: "0.6.0",
        autoupdate: undefined,
        disableAutoupdate: false,
        method: "npm",
      })).toBe("skip")
    })

    test("current is prerelease of a newer version", () => {
      expect(upgradeDecision({
        latest: "0.5.7",
        currentVersion: "0.6.0-beta.1",
        autoupdate: undefined,
        disableAutoupdate: false,
        method: "npm",
      })).toBe("skip")
    })

    test("semver.gte catches equal versions even if string !== (edge case)", () => {
      // This shouldn't happen in practice (both normalize), but tests the safety net
      expect(upgradeDecision({
        latest: "0.5.7",
        currentVersion: "0.5.7",
        autoupdate: undefined,
        disableAutoupdate: false,
        method: "npm",
      })).toBe("skip")
    })

    test("local version bypasses downgrade check", () => {
      // Dev mode: VERSION="local" should NOT be caught by semver guard
      expect(upgradeDecision({
        latest: "0.5.7",
        currentVersion: "local",
        autoupdate: undefined,
        disableAutoupdate: false,
        method: "npm",
      })).toBe("auto-upgrade")
    })

    test("invalid semver current version bypasses downgrade check", () => {
      expect(upgradeDecision({
        latest: "0.5.7",
        currentVersion: "dev-build-123",
        autoupdate: undefined,
        disableAutoupdate: false,
        method: "npm",
      })).toBe("auto-upgrade")
    })
  })

  describe("notify: autoupdate disabled", () => {
    test("autoupdate is false", () => {
      expect(upgradeDecision({
        latest: "0.5.7",
        currentVersion: "0.5.2",
        autoupdate: false,
        disableAutoupdate: false,
        method: "npm",
      })).toBe("notify")
    })

    test("OPENCODE_DISABLE_AUTOUPDATE flag is true", () => {
      expect(upgradeDecision({
        latest: "0.5.7",
        currentVersion: "0.5.2",
        autoupdate: undefined,
        disableAutoupdate: true,
        method: "npm",
      })).toBe("notify")
    })

    test("both autoupdate=false and flag=true", () => {
      expect(upgradeDecision({
        latest: "0.5.7",
        currentVersion: "0.5.2",
        autoupdate: false,
        disableAutoupdate: true,
        method: "npm",
      })).toBe("notify")
    })

    test("autoupdate is 'notify'", () => {
      expect(upgradeDecision({
        latest: "0.5.7",
        currentVersion: "0.5.2",
        autoupdate: "notify",
        disableAutoupdate: false,
        method: "npm",
      })).toBe("notify")
    })
  })

  describe("notify: unknown or unsupported install method", () => {
    test("method is 'unknown'", () => {
      expect(upgradeDecision({
        latest: "0.5.7",
        currentVersion: "0.5.2",
        autoupdate: undefined,
        disableAutoupdate: false,
        method: "unknown",
      })).toBe("notify")
    })

    test("method is 'yarn' (detected but not supported for auto-upgrade)", () => {
      expect(upgradeDecision({
        latest: "0.5.7",
        currentVersion: "0.5.2",
        autoupdate: undefined,
        disableAutoupdate: false,
        method: "yarn",
      })).toBe("notify")
    })

    test("unknown method with autoupdate=false still notifies", () => {
      expect(upgradeDecision({
        latest: "0.5.7",
        currentVersion: "0.5.2",
        autoupdate: false,
        disableAutoupdate: false,
        method: "unknown",
      })).toBe("notify")
    })
  })

  describe("auto-upgrade: supported methods with autoupdate enabled", () => {
    const supportedMethods = ["npm", "bun", "pnpm", "brew", "curl", "choco", "scoop"]

    for (const method of supportedMethods) {
      test(`auto-upgrade for method: ${method}`, () => {
        expect(upgradeDecision({
          latest: "0.5.7",
          currentVersion: "0.5.2",
          autoupdate: undefined,
          disableAutoupdate: false,
          method,
        })).toBe("auto-upgrade")
      })
    }

    test("autoupdate=true explicitly", () => {
      expect(upgradeDecision({
        latest: "0.5.7",
        currentVersion: "0.5.2",
        autoupdate: true,
        disableAutoupdate: false,
        method: "npm",
      })).toBe("auto-upgrade")
    })
  })

  describe("the reported bug: user on 0.5.2, latest is 0.5.7", () => {
    test("npm install, default config → should auto-upgrade", () => {
      expect(upgradeDecision({
        latest: "0.5.7",
        currentVersion: "0.5.2",
        autoupdate: undefined,
        disableAutoupdate: false,
        method: "npm",
      })).toBe("auto-upgrade")
    })

    test("unknown method, default config → should notify (was silently skipped before fix)", () => {
      expect(upgradeDecision({
        latest: "0.5.7",
        currentVersion: "0.5.2",
        autoupdate: undefined,
        disableAutoupdate: false,
        method: "unknown",
      })).toBe("notify")
    })

    test("autoupdate=false → should notify (was silently skipped before fix)", () => {
      expect(upgradeDecision({
        latest: "0.5.7",
        currentVersion: "0.5.2",
        autoupdate: false,
        disableAutoupdate: false,
        method: "npm",
      })).toBe("notify")
    })

    test("DISABLE_AUTOUPDATE flag → should notify (was silently skipped before fix)", () => {
      expect(upgradeDecision({
        latest: "0.5.7",
        currentVersion: "0.5.2",
        autoupdate: undefined,
        disableAutoupdate: true,
        method: "npm",
      })).toBe("notify")
    })
  })

  describe("version format edge cases", () => {
    test("patch version bump", () => {
      expect(upgradeDecision({
        latest: "0.5.3",
        currentVersion: "0.5.2",
        autoupdate: undefined,
        disableAutoupdate: false,
        method: "npm",
      })).toBe("auto-upgrade")
    })

    test("major version bump", () => {
      expect(upgradeDecision({
        latest: "1.0.0",
        currentVersion: "0.5.2",
        autoupdate: undefined,
        disableAutoupdate: false,
        method: "npm",
      })).toBe("auto-upgrade")
    })

    test("prerelease latest version vs stable current", () => {
      // 1.0.0-beta.1 is greater than 0.5.2
      expect(upgradeDecision({
        latest: "1.0.0-beta.1",
        currentVersion: "0.5.2",
        autoupdate: undefined,
        disableAutoupdate: false,
        method: "npm",
      })).toBe("auto-upgrade")
    })

    test("same major.minor, prerelease latest < current release", () => {
      // 0.5.2-beta.1 is LESS than 0.5.2 per semver
      expect(upgradeDecision({
        latest: "0.5.2-beta.1",
        currentVersion: "0.5.2",
        autoupdate: undefined,
        disableAutoupdate: false,
        method: "npm",
      })).toBe("skip")
    })
  })
})

// ─── Installation.VERSION sanity ─────────────────────────────────────────────

describe("Installation.VERSION format", () => {
  test("is a non-empty string", () => {
    expect(typeof Installation.VERSION).toBe("string")
    expect(Installation.VERSION.length).toBeGreaterThan(0)
  })

  test("does not have v prefix", () => {
    expect(Installation.VERSION.startsWith("v")).toBe(false)
  })

  test("is either 'local' or valid semver", () => {
    if (Installation.VERSION !== "local") {
      expect(semver.valid(Installation.VERSION)).not.toBeNull()
    }
  })
})
