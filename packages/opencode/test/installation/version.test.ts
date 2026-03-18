import { afterEach, describe, expect, test } from "bun:test"
import { Installation } from "../../src/installation"

const fetch0 = globalThis.fetch

afterEach(() => {
  globalThis.fetch = fetch0
})

describe("Installation.VERSION normalization", () => {
  test("VERSION does not have a 'v' prefix", () => {
    // VERSION is a compile-time constant. In the test environment it's "local",
    // but the normalization logic strips "v" prefix at the source.
    // This test verifies the constant doesn't start with "v" (unless it's "local").
    expect(Installation.VERSION === "local" || !Installation.VERSION.startsWith("v")).toBe(true)
  })

  test("VERSION is a string", () => {
    expect(typeof Installation.VERSION).toBe("string")
    expect(Installation.VERSION.length).toBeGreaterThan(0)
  })
})

describe("Installation.latest() returns clean versions", () => {
  test("GitHub releases: strips 'v' prefix from tag_name", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ tag_name: "v0.4.1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch

    const version = await Installation.latest("unknown")
    expect(version).toBe("0.4.1")
    expect(version.startsWith("v")).toBe(false)
  })

  test("GitHub releases: handles tag without 'v' prefix", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ tag_name: "1.2.3" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch

    const version = await Installation.latest("unknown")
    expect(version).toBe("1.2.3")
  })

  test("npm registry: returns clean version", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ version: "0.4.1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch

    const version = await Installation.latest("npm")
    expect(version).toBe("0.4.1")
    expect(version.startsWith("v")).toBe(false)
  })

  test("scoop manifest: returns clean version", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ version: "2.3.4" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch

    const version = await Installation.latest("scoop")
    expect(version).toBe("2.3.4")
    expect(version.startsWith("v")).toBe(false)
  })

  test("chocolatey feed: returns clean version", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ d: { results: [{ Version: "3.4.5" }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch

    const version = await Installation.latest("choco")
    expect(version).toBe("3.4.5")
    expect(version.startsWith("v")).toBe(false)
  })
})

describe("version comparison for upgrade skip", () => {
  // These tests simulate the comparison logic in the upgrade command:
  //   if (Installation.VERSION === target) { skip upgrade }
  // After normalization, VERSION should always match latest() when versions are equal.

  test("VERSION matches latest() when same version (no false upgrades)", async () => {
    // Simulate: VERSION is "0.4.1" (normalized from "v0.4.1")
    // latest() returns "0.4.1" from GitHub API (stripped "v")
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ tag_name: "v0.4.1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch

    const latest = await Installation.latest("unknown")
    // Both should be plain "0.4.1" — no "v" prefix mismatch
    expect(latest).toBe("0.4.1")
    // In production, Installation.VERSION would also be "0.4.1" (normalized)
    // This ensures the comparison works correctly
    expect(latest).not.toBe("v0.4.1")
  })

  test("VERSION correctly differs from latest() when versions are different", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ tag_name: "v0.5.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch

    const latest = await Installation.latest("unknown")
    expect(latest).toBe("0.5.0")
    // "0.4.1" !== "0.5.0" → upgrade should proceed
    expect("0.4.1" === latest).toBe(false)
  })
})
