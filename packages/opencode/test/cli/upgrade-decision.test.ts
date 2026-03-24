import { describe, expect, test } from "bun:test"
import { Installation } from "../../src/installation"
import { compareVersions, isValidVersion } from "../../src/cli/upgrade"

// ─── compareVersions: exhaustive tests ──────────────────────────────────────
// This function has ZERO external dependencies by design. If it breaks,
// users get locked on old versions. Every edge case must be covered.

describe("compareVersions", () => {
  describe("basic ordering", () => {
    test("equal versions", () => {
      expect(compareVersions("1.0.0", "1.0.0")).toBe(0)
    })

    test("patch bump", () => {
      expect(compareVersions("1.0.1", "1.0.0")).toBe(1)
      expect(compareVersions("1.0.0", "1.0.1")).toBe(-1)
    })

    test("minor bump", () => {
      expect(compareVersions("1.1.0", "1.0.0")).toBe(1)
      expect(compareVersions("1.0.0", "1.1.0")).toBe(-1)
    })

    test("major bump", () => {
      expect(compareVersions("2.0.0", "1.0.0")).toBe(1)
      expect(compareVersions("1.0.0", "2.0.0")).toBe(-1)
    })

    test("major > minor > patch precedence", () => {
      expect(compareVersions("2.0.0", "1.99.99")).toBe(1)
      expect(compareVersions("1.2.0", "1.1.99")).toBe(1)
    })
  })

  describe("v-prefix handling", () => {
    test("strips v prefix from both", () => {
      expect(compareVersions("v1.0.0", "v1.0.0")).toBe(0)
    })

    test("mixed v prefix", () => {
      expect(compareVersions("v1.0.1", "1.0.0")).toBe(1)
      expect(compareVersions("1.0.0", "v1.0.1")).toBe(-1)
    })
  })

  describe("prerelease handling", () => {
    test("release > prerelease of same version", () => {
      expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBe(1)
      expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(-1)
    })

    test("both prerelease, same core → equal (simplified)", () => {
      expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBe(0)
    })

    test("prerelease of higher version > release of lower", () => {
      expect(compareVersions("2.0.0-beta.1", "1.0.0")).toBe(1)
    })

    test("release of lower version < prerelease of higher", () => {
      expect(compareVersions("1.0.0", "2.0.0-beta.1")).toBe(-1)
    })
  })

  describe("missing parts", () => {
    test("missing patch treated as 0", () => {
      expect(compareVersions("1.0", "1.0.0")).toBe(0)
    })

    test("extra parts beyond 3 are compared (4-part versions)", () => {
      expect(compareVersions("1.0.0.1", "1.0.0")).toBe(1)
      expect(compareVersions("1.0.0", "1.0.0.1")).toBe(-1)
      expect(compareVersions("1.0.0.0", "1.0.0")).toBe(0)
    })
  })

  describe("unparseable versions", () => {
    test("non-numeric parts → 0 (safe default)", () => {
      expect(compareVersions("abc", "1.0.0")).toBe(0)
      expect(compareVersions("1.0.0", "xyz")).toBe(0)
    })
  })

  describe("real-world altimate-code versions", () => {
    test("0.5.7 < 0.5.8", () => {
      expect(compareVersions("0.5.7", "0.5.8")).toBe(-1)
    })

    test("0.5.8 > 0.5.7", () => {
      expect(compareVersions("0.5.8", "0.5.7")).toBe(1)
    })

    test("0.5.3 < 0.5.7", () => {
      expect(compareVersions("0.5.3", "0.5.7")).toBe(-1)
    })

    test("0.5.7 === 0.5.7", () => {
      expect(compareVersions("0.5.7", "0.5.7")).toBe(0)
    })

    test("0.6.0-beta.1 > 0.5.7", () => {
      expect(compareVersions("0.6.0-beta.1", "0.5.7")).toBe(1)
    })

    test("0.5.7 > 0.5.7-rc.1", () => {
      expect(compareVersions("0.5.7", "0.5.7-rc.1")).toBe(1)
    })
  })
})

// ─── isValidVersion ─────────────────────────────────────────────────────────

describe("isValidVersion", () => {
  test("standard semver", () => {
    expect(isValidVersion("1.0.0")).toBe(true)
    expect(isValidVersion("0.5.7")).toBe(true)
    expect(isValidVersion("10.20.30")).toBe(true)
  })

  test("with v prefix", () => {
    expect(isValidVersion("v1.0.0")).toBe(true)
  })

  test("with prerelease", () => {
    expect(isValidVersion("1.0.0-beta.1")).toBe(true)
  })

  test("rejects non-version strings", () => {
    expect(isValidVersion("local")).toBe(false)
    expect(isValidVersion("dev-build-123")).toBe(false)
    expect(isValidVersion("")).toBe(false)
    expect(isValidVersion("abc")).toBe(false)
  })

  test("rejects partial versions", () => {
    expect(isValidVersion("1.0")).toBe(false)
    expect(isValidVersion("1")).toBe(false)
  })
})

// ─── Decision Logic ─────────────────────────────────────────────────────────
// These mirror the exact checks in cli/upgrade.ts so we can test every path.
// Uses our own compareVersions instead of semver.

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

  // Prevent downgrade — uses our zero-dependency compareVersions
  if (
    currentVersion !== "local" &&
    isValidVersion(currentVersion) &&
    isValidVersion(latest) &&
    compareVersions(currentVersion, latest) >= 0
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

    test("compareVersions catches equal versions", () => {
      expect(upgradeDecision({
        latest: "0.5.7",
        currentVersion: "0.5.7",
        autoupdate: undefined,
        disableAutoupdate: false,
        method: "npm",
      })).toBe("skip")
    })

    test("local version bypasses downgrade check", () => {
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

    test("method is 'yarn'", () => {
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

    test("unknown method → should notify (was silently skipped before fix)", () => {
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
      expect(upgradeDecision({
        latest: "1.0.0-beta.1",
        currentVersion: "0.5.2",
        autoupdate: undefined,
        disableAutoupdate: false,
        method: "npm",
      })).toBe("auto-upgrade")
    })

    test("same major.minor, prerelease latest < current release", () => {
      // 0.5.2-beta.1 is LESS than 0.5.2
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

  test("is either 'local' or valid version", () => {
    if (Installation.VERSION !== "local") {
      expect(isValidVersion(Installation.VERSION)).toBe(true)
    }
  })
})

// ─── upgrade() import smoke test ─────────────────────────────────────────────
// The most critical test: verify that upgrade() can be imported without
// throwing. If this fails, users on this version are permanently locked out.

describe("upgrade() module health", () => {
  test("upgrade function can be imported", async () => {
    const mod = await import("../../src/cli/upgrade")
    expect(typeof mod.upgrade).toBe("function")
  })

  test("compareVersions is exported and callable", async () => {
    const mod = await import("../../src/cli/upgrade")
    expect(typeof mod.compareVersions).toBe("function")
    expect(mod.compareVersions("1.0.0", "0.9.0")).toBe(1)
  })

  test("isValidVersion is exported and callable", async () => {
    const mod = await import("../../src/cli/upgrade")
    expect(typeof mod.isValidVersion).toBe("function")
    expect(mod.isValidVersion("1.0.0")).toBe(true)
  })

  test("upgrade module has no semver dependency", async () => {
    // Read the source and verify semver is not imported.
    // This is the guard against reintroducing the dependency.
    const fs = await import("fs")
    const path = await import("path")
    const src = fs.readFileSync(
      path.join(import.meta.dir, "../../src/cli/upgrade.ts"),
      "utf-8",
    )
    expect(src).not.toContain('from "semver"')
    expect(src).not.toContain("require(\"semver\")")
    expect(src).not.toContain("import semver")
  })
})

// ─── Behavioral parity: compareVersions vs semver ────────────────────────────
// Verify our zero-dep implementation matches semver for all cases that matter.

describe("compareVersions parity with semver", () => {
  // Import semver only in this test block — it's a dev dependency for validation
  const semver = require("semver")

  const cases: [string, string][] = [
    ["0.5.7", "0.5.8"],
    ["0.5.8", "0.5.7"],
    ["0.5.7", "0.5.7"],
    ["1.0.0", "0.99.99"],
    ["0.0.1", "0.0.2"],
    ["1.0.0", "1.0.0-beta.1"],
    ["1.0.0-beta.1", "1.0.0"],
    ["2.0.0-alpha", "1.99.99"],
    ["0.5.3", "0.5.7"],
    ["0.5.7", "0.6.0-beta.1"],
    ["10.0.0", "9.99.99"],
  ]

  for (const [a, b] of cases) {
    test(`${a} vs ${b}`, () => {
      const ours = compareVersions(a, b)
      const theirs = semver.compare(
        semver.valid(a) ? a : semver.coerce(a)?.version ?? a,
        semver.valid(b) ? b : semver.coerce(b)?.version ?? b,
      )
      // Both should agree on direction (positive/negative/zero)
      expect(Math.sign(ours)).toBe(Math.sign(theirs))
    })
  }
})
