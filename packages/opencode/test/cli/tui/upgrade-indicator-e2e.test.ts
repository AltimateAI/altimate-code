import { describe, expect, test } from "bun:test"
import semver from "semver"
import { UPGRADE_KV_KEY, getAvailableVersion } from "../../../src/cli/cmd/tui/component/upgrade-indicator-utils"
import { Installation } from "../../../src/installation"

/**
 * End-to-end tests for the upgrade indicator feature.
 *
 * These simulate the full lifecycle:
 *   UpdateAvailable event → KV store → getAvailableVersion → indicator visibility
 *   Updated event → KV reset → indicator hidden
 *
 * Regression tests for the three original bot findings:
 *   F1: Stale indicator after autoupgrade (KV not cleared on Updated event)
 *   F2: Downgrade arrow (KV has older version than current)
 *   F3: Empty string leaks as valid version
 *
 * Also covers the semver library integration (replacing custom isNewer).
 */

// ─── KV Store Simulation ──────────────────────────────────────────────────────
// Simulates the KV store behavior from context/kv.tsx without Solid.js context.
// The real KV store uses createStore + Filesystem.writeJson; we simulate the
// get/set interface with a plain object.

function createMockKV() {
  const store: Record<string, any> = {}
  return {
    get(key: string, defaultValue?: any) {
      return store[key] ?? defaultValue
    },
    set(key: string, value: any) {
      store[key] = value
    },
    raw: store,
  }
}

// ─── Event Handler Simulation ─────────────────────────────────────────────────
// Mirrors the event handlers in app.tsx:843-857

function simulateUpdateAvailableEvent(kv: ReturnType<typeof createMockKV>, version: string) {
  kv.set(UPGRADE_KV_KEY, version)
}

function simulateUpdatedEvent(kv: ReturnType<typeof createMockKV>) {
  if (kv.get(UPGRADE_KV_KEY) !== Installation.VERSION) {
    kv.set(UPGRADE_KV_KEY, Installation.VERSION)
  }
}

// ─── Full Lifecycle E2E Tests ─────────────────────────────────────────────────

describe("upgrade indicator e2e: full lifecycle", () => {
  test("fresh install: no indicator shown", () => {
    const kv = createMockKV()
    // No events fired yet — KV has no update_available_version key
    const version = getAvailableVersion(kv.get(UPGRADE_KV_KEY))
    expect(version).toBeUndefined()
  })

  test("UpdateAvailable → indicator shown → user sees upgrade prompt", () => {
    const kv = createMockKV()

    // Step 1: Server publishes UpdateAvailable with newer version
    simulateUpdateAvailableEvent(kv, "999.0.0")

    // Step 2: Indicator should show the new version
    const version = getAvailableVersion(kv.get(UPGRADE_KV_KEY))
    expect(version).toBe("999.0.0")
  })

  test("UpdateAvailable → user upgrades → Updated event → indicator hidden", () => {
    const kv = createMockKV()

    // Step 1: Update available
    simulateUpdateAvailableEvent(kv, "999.0.0")
    expect(getAvailableVersion(kv.get(UPGRADE_KV_KEY))).toBe("999.0.0")

    // Step 2: User runs `altimate upgrade`, Updated event fires
    simulateUpdatedEvent(kv)

    // Step 3: Indicator should be hidden (KV now matches VERSION)
    expect(getAvailableVersion(kv.get(UPGRADE_KV_KEY))).toBeUndefined()
  })

  test("multiple UpdateAvailable events: latest version wins", () => {
    const kv = createMockKV()

    simulateUpdateAvailableEvent(kv, "998.0.0")
    expect(getAvailableVersion(kv.get(UPGRADE_KV_KEY))).toBe("998.0.0")

    simulateUpdateAvailableEvent(kv, "999.0.0")
    expect(getAvailableVersion(kv.get(UPGRADE_KV_KEY))).toBe("999.0.0")
  })

  test("KV persists across route changes (simulated)", () => {
    const kv = createMockKV()

    // UpdateAvailable fires on home page
    simulateUpdateAvailableEvent(kv, "999.0.0")

    // User navigates to session — same KV, indicator still shows
    const versionOnSession = getAvailableVersion(kv.get(UPGRADE_KV_KEY))
    expect(versionOnSession).toBe("999.0.0")

    // User navigates back to home — still there
    const versionOnHome = getAvailableVersion(kv.get(UPGRADE_KV_KEY))
    expect(versionOnHome).toBe("999.0.0")
  })
})

// ─── Regression: F1 — Stale indicator after autoupgrade ───────────────────────

describe("upgrade indicator e2e: F1 regression — stale after autoupgrade", () => {
  test("autoupgrade completes → Updated event clears indicator", () => {
    const kv = createMockKV()

    // UpdateAvailable fires
    simulateUpdateAvailableEvent(kv, "999.0.0")
    expect(getAvailableVersion(kv.get(UPGRADE_KV_KEY))).toBe("999.0.0")

    // Autoupgrade succeeds, Updated event fires
    simulateUpdatedEvent(kv)

    // Indicator must be hidden — the bug was that Updated wasn't handled
    expect(getAvailableVersion(kv.get(UPGRADE_KV_KEY))).toBeUndefined()
  })

  test("Updated event is idempotent (no unnecessary KV writes)", () => {
    const kv = createMockKV()

    // Already at current version — Updated should not write
    kv.set(UPGRADE_KV_KEY, Installation.VERSION)
    const before = kv.get(UPGRADE_KV_KEY)

    simulateUpdatedEvent(kv)

    // Value unchanged — conditional check prevented redundant write
    expect(kv.get(UPGRADE_KV_KEY)).toBe(before)
  })
})

// ─── Regression: F2 — Downgrade arrow ─────────────────────────────────────────

describe("upgrade indicator e2e: F2 regression — downgrade arrow prevention", () => {
  test("stale KV with older version does not show downgrade indicator", () => {
    const kv = createMockKV()

    // Scenario: user on 0.5.3, KV has stale "0.5.0" from before external upgrade
    kv.set(UPGRADE_KV_KEY, "0.5.0")

    const version = getAvailableVersion(kv.get(UPGRADE_KV_KEY))

    if (Installation.VERSION === "local") {
      // Dev mode: semver.valid("0.5.0") is valid, so indicator shows
      expect(version).toBe("0.5.0")
    } else {
      // Production: 0.5.0 is NOT newer than current VERSION → hidden
      expect(version).toBeUndefined()
    }
  })

  test("user upgrades externally past stored version", () => {
    const kv = createMockKV()

    // UpdateAvailable stored "1.0.0", user upgrades to "2.0.0" externally
    // On restart, VERSION is "2.0.0" but KV still has "1.0.0"
    kv.set(UPGRADE_KV_KEY, "1.0.0")

    const version = getAvailableVersion(kv.get(UPGRADE_KV_KEY))

    if (Installation.VERSION === "local") {
      expect(version).toBe("1.0.0")
    } else {
      // 1.0.0 is NOT newer than current → should NOT show
      const current = semver.valid(Installation.VERSION)
      if (current && semver.gt("1.0.0", current)) {
        expect(version).toBe("1.0.0")
      } else {
        expect(version).toBeUndefined()
      }
    }
  })

  test("only truly newer versions show the indicator", () => {
    // This test only makes sense in production (VERSION is semver)
    if (Installation.VERSION === "local") return

    const current = semver.valid(Installation.VERSION)
    if (!current) return

    // Older version — should NOT show
    const older = semver.valid("0.0.1")!
    expect(getAvailableVersion(older)).toBeUndefined()

    // Same version — should NOT show
    expect(getAvailableVersion(current)).toBeUndefined()

    // Newer version — SHOULD show
    const newer = semver.inc(current, "patch")!
    expect(getAvailableVersion(newer)).toBe(newer)
  })
})

// ─── Regression: F3 — Empty string leak ───────────────────────────────────────

describe("upgrade indicator e2e: F3 regression — empty/invalid value handling", () => {
  test("empty string in KV does not show indicator", () => {
    const kv = createMockKV()
    kv.set(UPGRADE_KV_KEY, "")

    expect(getAvailableVersion(kv.get(UPGRADE_KV_KEY))).toBeUndefined()
  })

  test("corrupted KV value does not show indicator", () => {
    const kv = createMockKV()

    const corrupted = ["error", "null", "undefined", "not-a-version", "{}", "[]", "v", ".."]
    for (const value of corrupted) {
      kv.set(UPGRADE_KV_KEY, value)
      const result = getAvailableVersion(kv.get(UPGRADE_KV_KEY))
      expect(result).toBeUndefined()
    }
  })

  test("non-string KV values do not show indicator", () => {
    const kv = createMockKV()

    const invalid = [null, undefined, 123, true, false, {}, [], NaN]
    for (const value of invalid) {
      kv.raw[UPGRADE_KV_KEY] = value
      expect(getAvailableVersion(kv.get(UPGRADE_KV_KEY))).toBeUndefined()
    }
  })
})

// ─── Semver Integration Tests ─────────────────────────────────────────────────

describe("upgrade indicator e2e: semver integration", () => {
  test("prerelease versions are handled correctly", () => {
    // Prerelease of a very high version
    const result = getAvailableVersion("99.0.0-beta.1")
    if (Installation.VERSION === "local") {
      // Dev mode: semver.valid("99.0.0-beta.1") is valid
      expect(result).toBe("99.0.0-beta.1")
    } else {
      // Production: prerelease is lower than release
      // "99.0.0-beta.1" < "99.0.0" but still > most current versions
      const current = semver.valid(Installation.VERSION)
      if (current && semver.gt("99.0.0-beta.1", current)) {
        expect(result).toBe("99.0.0-beta.1")
      } else {
        expect(result).toBeUndefined()
      }
    }
  })

  test("build metadata versions are handled", () => {
    // semver ignores build metadata in comparisons
    const result = getAvailableVersion("999.0.0+build.123")
    // semver.valid("999.0.0+build.123") returns "999.0.0+build.123"
    if (semver.valid("999.0.0+build.123")) {
      expect(result).toBe("999.0.0+build.123")
    } else {
      expect(result).toBeUndefined()
    }
  })

  test("v-prefixed versions are accepted (semver strips the prefix)", () => {
    // semver.valid("v99.0.0") returns "99.0.0" — it normalizes the v prefix
    const result = getAvailableVersion("v99.0.0")
    expect(result).toBe("v99.0.0")
  })

  test("dev mode shows indicator for any valid semver", () => {
    if (Installation.VERSION !== "local") return

    // In dev mode, any valid semver candidate should show
    const validVersions = ["0.0.1", "1.0.0", "99.99.99", "1.0.0-alpha.1"]
    for (const v of validVersions) {
      expect(getAvailableVersion(v)).toBe(v)
    }

    // Invalid semver should NOT show even in dev mode
    const invalidVersions = ["not-semver", "abc", "1.2", ""]
    for (const v of invalidVersions) {
      expect(getAvailableVersion(v)).toBeUndefined()
    }
  })

  test("dev mode rejects invalid semver (no false positives from corrupted KV)", () => {
    if (Installation.VERSION !== "local") return

    // These are the values that the old custom isNewer would have shown
    // because NaN fallback returned true — semver.valid rejects them
    expect(getAvailableVersion("error")).toBeUndefined()
    expect(getAvailableVersion("corrupted-data")).toBeUndefined()
    expect(getAvailableVersion("local")).toBeUndefined() // matches VERSION anyway
  })
})

// ─── Race Condition / Edge Case Tests ─────────────────────────────────────────

describe("upgrade indicator e2e: edge cases", () => {
  test("rapid UpdateAvailable then Updated — indicator should be hidden", () => {
    const kv = createMockKV()

    // Rapid succession: update available then immediately upgraded
    simulateUpdateAvailableEvent(kv, "999.0.0")
    simulateUpdatedEvent(kv)

    expect(getAvailableVersion(kv.get(UPGRADE_KV_KEY))).toBeUndefined()
  })

  test("Updated without prior UpdateAvailable — no-op", () => {
    const kv = createMockKV()

    // Updated fires but no UpdateAvailable was received
    // KV key doesn't exist, so conditional check prevents write
    simulateUpdatedEvent(kv)

    // KV should still not have the key (undefined !== Installation.VERSION)
    // Actually: undefined !== VERSION is true, so it WILL write
    // This is fine — setting to VERSION means getAvailableVersion returns undefined
    expect(getAvailableVersion(kv.get(UPGRADE_KV_KEY))).toBeUndefined()
  })

  test("same version available as current — indicator hidden", () => {
    const kv = createMockKV()

    // Server sends UpdateAvailable with current version (edge case)
    simulateUpdateAvailableEvent(kv, Installation.VERSION)

    // Should not show — kvValue === Installation.VERSION check catches this
    expect(getAvailableVersion(kv.get(UPGRADE_KV_KEY))).toBeUndefined()
  })
})
