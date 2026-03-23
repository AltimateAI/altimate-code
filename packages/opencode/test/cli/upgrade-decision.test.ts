import { describe, expect, test } from "bun:test"
import semver from "semver"
import { Installation } from "../../src/installation"

/**
 * Tests for the upgrade() decision logic in cli/upgrade.ts.
 *
 * These mirror the exact control flow in upgrade() so we can test every path
 * without needing to mock Config, Bus, and Installation.
 *
 * The upgrade path is the most critical code in the CLI — if it breaks,
 * users are permanently locked on old versions. These tests verify:
 * 1. Decision logic for every branch
 * 2. semver is importable and works correctly (bundling smoke test)
 * 3. The upgrade() module itself can be imported
 * 4. The silent .catch(() => {}) was replaced with logging
 */

// ─── Decision Logic ─────────────────────────────────────────────────────────

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
      expect(upgradeDecision({ latest: undefined, currentVersion: "0.5.2", autoupdate: undefined, disableAutoupdate: false, method: "npm" })).toBe("skip")
    })
    test("latest is empty string", () => {
      expect(upgradeDecision({ latest: "", currentVersion: "0.5.2", autoupdate: undefined, disableAutoupdate: false, method: "npm" })).toBe("skip")
    })
  })

  describe("skip: already up to date", () => {
    test("same version string", () => {
      expect(upgradeDecision({ latest: "0.5.7", currentVersion: "0.5.7", autoupdate: undefined, disableAutoupdate: false, method: "npm" })).toBe("skip")
    })
  })

  describe("skip: downgrade prevention", () => {
    test("current version is newer than latest", () => {
      expect(upgradeDecision({ latest: "0.5.7", currentVersion: "0.6.0", autoupdate: undefined, disableAutoupdate: false, method: "npm" })).toBe("skip")
    })
    test("current is prerelease of a newer version", () => {
      expect(upgradeDecision({ latest: "0.5.7", currentVersion: "0.6.0-beta.1", autoupdate: undefined, disableAutoupdate: false, method: "npm" })).toBe("skip")
    })
    test("local version bypasses downgrade check", () => {
      expect(upgradeDecision({ latest: "0.5.7", currentVersion: "local", autoupdate: undefined, disableAutoupdate: false, method: "npm" })).toBe("auto-upgrade")
    })
    test("invalid semver bypasses downgrade check", () => {
      expect(upgradeDecision({ latest: "0.5.7", currentVersion: "dev-build-123", autoupdate: undefined, disableAutoupdate: false, method: "npm" })).toBe("auto-upgrade")
    })
  })

  describe("notify: autoupdate disabled", () => {
    test("autoupdate is false", () => {
      expect(upgradeDecision({ latest: "0.5.7", currentVersion: "0.5.2", autoupdate: false, disableAutoupdate: false, method: "npm" })).toBe("notify")
    })
    test("DISABLE_AUTOUPDATE flag", () => {
      expect(upgradeDecision({ latest: "0.5.7", currentVersion: "0.5.2", autoupdate: undefined, disableAutoupdate: true, method: "npm" })).toBe("notify")
    })
    test("both disabled", () => {
      expect(upgradeDecision({ latest: "0.5.7", currentVersion: "0.5.2", autoupdate: false, disableAutoupdate: true, method: "npm" })).toBe("notify")
    })
    test("notify mode", () => {
      expect(upgradeDecision({ latest: "0.5.7", currentVersion: "0.5.2", autoupdate: "notify", disableAutoupdate: false, method: "npm" })).toBe("notify")
    })
  })

  describe("notify: unsupported method", () => {
    test("unknown", () => {
      expect(upgradeDecision({ latest: "0.5.7", currentVersion: "0.5.2", autoupdate: undefined, disableAutoupdate: false, method: "unknown" })).toBe("notify")
    })
    test("yarn", () => {
      expect(upgradeDecision({ latest: "0.5.7", currentVersion: "0.5.2", autoupdate: undefined, disableAutoupdate: false, method: "yarn" })).toBe("notify")
    })
    test("unknown method with autoupdate=false still notifies", () => {
      expect(upgradeDecision({ latest: "0.5.7", currentVersion: "0.5.2", autoupdate: false, disableAutoupdate: false, method: "unknown" })).toBe("notify")
    })
  })

  describe("auto-upgrade: supported methods", () => {
    for (const method of ["npm", "bun", "pnpm", "brew", "curl", "choco", "scoop"]) {
      test(`method: ${method}`, () => {
        expect(upgradeDecision({ latest: "0.5.7", currentVersion: "0.5.2", autoupdate: undefined, disableAutoupdate: false, method })).toBe("auto-upgrade")
      })
    }
    test("autoupdate=true explicitly", () => {
      expect(upgradeDecision({ latest: "0.5.7", currentVersion: "0.5.2", autoupdate: true, disableAutoupdate: false, method: "npm" })).toBe("auto-upgrade")
    })
  })

  describe("the reported bug scenario", () => {
    test("npm default config → auto-upgrade", () => {
      expect(upgradeDecision({ latest: "0.5.7", currentVersion: "0.5.2", autoupdate: undefined, disableAutoupdate: false, method: "npm" })).toBe("auto-upgrade")
    })
    test("unknown method → notify (was silently skipped before fix)", () => {
      expect(upgradeDecision({ latest: "0.5.7", currentVersion: "0.5.2", autoupdate: undefined, disableAutoupdate: false, method: "unknown" })).toBe("notify")
    })
    test("autoupdate=false → notify (was silently skipped before fix)", () => {
      expect(upgradeDecision({ latest: "0.5.7", currentVersion: "0.5.2", autoupdate: false, disableAutoupdate: false, method: "npm" })).toBe("notify")
    })
  })

  describe("version edge cases", () => {
    test("patch bump", () => {
      expect(upgradeDecision({ latest: "0.5.3", currentVersion: "0.5.2", autoupdate: undefined, disableAutoupdate: false, method: "npm" })).toBe("auto-upgrade")
    })
    test("major bump", () => {
      expect(upgradeDecision({ latest: "1.0.0", currentVersion: "0.5.2", autoupdate: undefined, disableAutoupdate: false, method: "npm" })).toBe("auto-upgrade")
    })
    test("prerelease latest > stable current", () => {
      expect(upgradeDecision({ latest: "1.0.0-beta.1", currentVersion: "0.5.2", autoupdate: undefined, disableAutoupdate: false, method: "npm" })).toBe("auto-upgrade")
    })
    test("prerelease latest < stable current → skip", () => {
      expect(upgradeDecision({ latest: "0.5.2-beta.1", currentVersion: "0.5.2", autoupdate: undefined, disableAutoupdate: false, method: "npm" })).toBe("skip")
    })
  })
})

// ─── semver bundling smoke test ──────────────────────────────────────────────
// This is the critical guard: verify that semver is importable and works.
// If this test fails in CI, it means the build would ship a broken upgrade path.

describe("semver bundling health", () => {
  test("semver is importable", () => {
    expect(typeof semver).toBe("object")
    expect(typeof semver.valid).toBe("function")
    expect(typeof semver.gte).toBe("function")
    expect(typeof semver.compare).toBe("function")
  })

  test("semver.valid works", () => {
    expect(semver.valid("1.0.0")).toBe("1.0.0")
    expect(semver.valid("0.5.7")).toBe("0.5.7")
    expect(semver.valid("invalid")).toBeNull()
    expect(semver.valid("local")).toBeNull()
  })

  test("semver.gte works", () => {
    expect(semver.gte("0.5.8", "0.5.7")).toBe(true)
    expect(semver.gte("0.5.7", "0.5.7")).toBe(true)
    expect(semver.gte("0.5.7", "0.5.8")).toBe(false)
  })

  test("semver.compare works for all orderings", () => {
    expect(semver.compare("1.0.0", "2.0.0")).toBe(-1)
    expect(semver.compare("2.0.0", "1.0.0")).toBe(1)
    expect(semver.compare("1.0.0", "1.0.0")).toBe(0)
  })

  test("semver handles prerelease correctly", () => {
    expect(semver.gte("1.0.0", "1.0.0-beta.1")).toBe(true)
    expect(semver.gte("1.0.0-beta.1", "1.0.0")).toBe(false)
    expect(semver.compare("1.0.0-alpha", "1.0.0-beta")).toBe(-1)
    expect(semver.compare("1.0.0-alpha.1", "1.0.0-alpha.2")).toBe(-1)
  })

  test("semver is NOT in the build external list", () => {
    // If semver is externalized, it won't be bundled in the compiled binary.
    // This test reads build.ts to verify it's not listed.
    const fs = require("fs")
    const path = require("path")
    const buildScript = fs.readFileSync(
      path.join(import.meta.dir, "../../script/build.ts"),
      "utf-8",
    )
    // Extract the external array
    const externalMatch = buildScript.match(/external:\s*\[([\s\S]*?)\]/)
    if (externalMatch) {
      expect(externalMatch[1]).not.toContain('"semver"')
      expect(externalMatch[1]).not.toContain("'semver'")
    }
  })
})

// ─── upgrade() module health ─────────────────────────────────────────────────

describe("upgrade() module health", () => {
  test("upgrade function can be imported", async () => {
    const mod = await import("../../src/cli/upgrade")
    expect(typeof mod.upgrade).toBe("function")
  })

  test("upgrade module imports semver without error", async () => {
    // This catches the scenario where semver fails to resolve at import time.
    // The import must not throw.
    await expect(import("../../src/cli/upgrade")).resolves.toBeDefined()
  })

  test("worker.ts does not silently swallow upgrade errors", () => {
    const fs = require("fs")
    const path = require("path")
    const workerSource = fs.readFileSync(
      path.join(import.meta.dir, "../../src/cli/cmd/tui/worker.ts"),
      "utf-8",
    )
    // Find the checkUpgrade function and verify it logs errors
    const checkUpgradeMatch = workerSource.match(/async checkUpgrade[\s\S]*?upgrade\(\)\.catch\(([\s\S]*?)\)/)
    expect(checkUpgradeMatch).not.toBeNull()
    // The catch handler should reference the error (not be empty)
    const catchBody = checkUpgradeMatch![1]
    expect(catchBody).toContain("err")
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
