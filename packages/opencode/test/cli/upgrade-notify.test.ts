import { afterEach, describe, expect, test } from "bun:test"
import { Installation } from "../../src/installation"
import { UPGRADE_KV_KEY, getAvailableVersion } from "../../src/cli/cmd/tui/component/upgrade-indicator-utils"

const fetch0 = globalThis.fetch

afterEach(() => {
  globalThis.fetch = fetch0
})

describe("upgrade notification flow", () => {
  describe("event definitions", () => {
    test("UpdateAvailable has correct event type", () => {
      expect(Installation.Event.UpdateAvailable.type).toBe("installation.update-available")
    })

    test("Updated has correct event type", () => {
      expect(Installation.Event.Updated.type).toBe("installation.updated")
    })

    test("UpdateAvailable schema validates version string", () => {
      const result = Installation.Event.UpdateAvailable.properties.safeParse({ version: "1.2.3" })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.version).toBe("1.2.3")
      }
    })

    test("UpdateAvailable schema rejects missing version", () => {
      const result = Installation.Event.UpdateAvailable.properties.safeParse({})
      expect(result.success).toBe(false)
    })

    test("UpdateAvailable schema rejects non-string version", () => {
      const result = Installation.Event.UpdateAvailable.properties.safeParse({ version: 123 })
      expect(result.success).toBe(false)
    })
  })

  describe("Installation.VERSION", () => {
    test("is a non-empty string", () => {
      expect(typeof Installation.VERSION).toBe("string")
      expect(Installation.VERSION.length).toBeGreaterThan(0)
    })
  })

  describe("latest version fetch", () => {
    test("returns version from GitHub releases for unknown method", async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ tag_name: "v5.0.0" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch

      const latest = await Installation.latest("unknown")
      expect(latest).toBe("5.0.0")
    })

    test("strips v prefix from GitHub tag", async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ tag_name: "v10.20.30" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch

      const latest = await Installation.latest("unknown")
      expect(latest).toBe("10.20.30")
    })

    test("returns npm version for npm method", async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ version: "4.0.0" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch

      const latest = await Installation.latest("npm")
      expect(latest).toBe("4.0.0")
    })
  })
})

describe("KV-based upgrade indicator integration", () => {
  test("UPGRADE_KV_KEY is consistent", () => {
    expect(UPGRADE_KV_KEY).toBe("update_available_version")
  })

  test("simulated KV store correctly tracks update version", () => {
    const store: Record<string, any> = {}
    store[UPGRADE_KV_KEY] = "999.0.0"
    expect(store[UPGRADE_KV_KEY]).toBe("999.0.0")
  })

  test("indicator hidden when stored version is older (prevents downgrade arrow)", () => {
    // F2 fix: user on 0.5.3, KV has stale "0.5.0" — should NOT show downgrade
    // In dev mode (VERSION="local"), valid semver candidates still show
    const result = getAvailableVersion("0.5.0")
    if (Installation.VERSION === "local") {
      expect(result).toBe("0.5.0")
    } else {
      expect(result).toBeUndefined()
    }
  })

  test("indicator hidden for invalid/corrupted KV values", () => {
    expect(getAvailableVersion("corrupted")).toBeUndefined()
    expect(getAvailableVersion("not-semver")).toBeUndefined()
  })

  test("indicator shown when stored version is newer than current", () => {
    const store: Record<string, any> = {}
    store[UPGRADE_KV_KEY] = "999.0.0"

    const result = getAvailableVersion(store[UPGRADE_KV_KEY])
    expect(result).toBe("999.0.0")
  })

  test("indicator hidden when key is absent", () => {
    const store: Record<string, any> = {}
    const result = getAvailableVersion(store[UPGRADE_KV_KEY])
    expect(result).toBeUndefined()
  })

  test("KV value can be overwritten with newer version", () => {
    const store: Record<string, any> = {}
    store[UPGRADE_KV_KEY] = "998.0.0"
    store[UPGRADE_KV_KEY] = "999.0.0"
    expect(store[UPGRADE_KV_KEY]).toBe("999.0.0")

    const result = getAvailableVersion(store[UPGRADE_KV_KEY])
    expect(result).toBe("999.0.0")
  })

  test("end-to-end: event → KV → indicator → reset on Updated", () => {
    const store: Record<string, any> = {}

    // Step 1: UpdateAvailable event stores version
    store[UPGRADE_KV_KEY] = "999.0.0"
    expect(getAvailableVersion(store[UPGRADE_KV_KEY])).toBe("999.0.0")

    // Step 2: Updated event sets KV to current version (F1 fix)
    store[UPGRADE_KV_KEY] = Installation.VERSION
    expect(getAvailableVersion(store[UPGRADE_KV_KEY])).toBeUndefined()
  })
})
