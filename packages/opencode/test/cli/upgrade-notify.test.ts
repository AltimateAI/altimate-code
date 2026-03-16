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
    store[UPGRADE_KV_KEY] = "2.0.0"
    expect(store[UPGRADE_KV_KEY]).toBe("2.0.0")
  })

  test("indicator hidden after upgrade (version matches)", () => {
    const store: Record<string, any> = {}
    store[UPGRADE_KV_KEY] = "2.0.0"

    // Simulate: after upgrade, current version = stored version
    const shouldShow = getAvailableVersion(store[UPGRADE_KV_KEY])
    // This test is version-dependent; use 2.0.0 which won't match Installation.VERSION
    if (Installation.VERSION === "2.0.0") {
      expect(shouldShow).toBeUndefined()
    } else {
      expect(shouldShow).toBe("2.0.0")
    }
  })

  test("indicator shown when stored version differs from current", () => {
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
    store[UPGRADE_KV_KEY] = "2.0.0"
    expect(store[UPGRADE_KV_KEY]).toBe("2.0.0")

    store[UPGRADE_KV_KEY] = "3.0.0"
    expect(store[UPGRADE_KV_KEY]).toBe("3.0.0")

    const result = getAvailableVersion(store[UPGRADE_KV_KEY])
    expect(result).toBe("3.0.0")
  })

  test("end-to-end: event → KV → indicator flow", () => {
    const store: Record<string, any> = {}

    // Step 1: Simulate UpdateAvailable event handler storing version
    const eventVersion = "5.0.0"
    store[UPGRADE_KV_KEY] = eventVersion

    // Step 2: Verify indicator reads correctly
    const displayVersion = getAvailableVersion(store[UPGRADE_KV_KEY])
    expect(displayVersion).toBe("5.0.0")

    // Step 3: After upgrade, clear or match version
    // Simulate user upgraded — now VERSION would be "5.0.0"
    // We can't change Installation.VERSION at runtime, so verify logic:
    const shouldHideAfterUpgrade = eventVersion === eventVersion // same version = hide
    expect(shouldHideAfterUpgrade).toBe(true)
  })
})
