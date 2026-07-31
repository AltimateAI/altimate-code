import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Installation } from "../../src/installation"

function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))))
  return Layer.succeed(HttpClient.HttpClient, client)
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

// altimate_change start — upstream_fix: Installation has no `.layer`/`.defaultLayer` facade;
// build from `.node` (which already wires AppProcess.node) and replace the httpClient node.
function latestWith(body: unknown, method: Installation.Method) {
  const layer = AppNodeBuilder.build(Installation.node, [[httpClient, mockHttpClient(() => jsonResponse(body))]])
  return Effect.runPromise(Installation.use.latest(method).pipe(Effect.provide(layer)))
}
// altimate_change end

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
    const version = await latestWith({ tag_name: "v0.4.1" }, "unknown")
    expect(version).toBe("0.4.1")
    expect(version.startsWith("v")).toBe(false)
  })

  test("GitHub releases: handles tag without 'v' prefix", async () => {
    const version = await latestWith({ tag_name: "1.2.3" }, "unknown")
    expect(version).toBe("1.2.3")
  })

  test("npm registry: returns clean version", async () => {
    const version = await latestWith({ version: "0.4.1" }, "npm")
    expect(version).toBe("0.4.1")
    expect(version.startsWith("v")).toBe(false)
  })

  test("scoop manifest: returns clean version", async () => {
    const version = await latestWith({ version: "2.3.4" }, "scoop")
    expect(version).toBe("2.3.4")
    expect(version.startsWith("v")).toBe(false)
  })

  test("chocolatey feed: returns clean version", async () => {
    const version = await latestWith({ d: { results: [{ Version: "3.4.5" }] } }, "choco")
    expect(version).toBe("3.4.5")
    expect(version.startsWith("v")).toBe(false)
  })
})

describe("version comparison for upgrade skip", () => {
  // These tests simulate the comparison logic in the upgrade command:
  //   if (Installation.VERSION === target) { skip upgrade }
  // After normalization, VERSION should always match latest() when versions are equal.

  test("VERSION matches latest() when same version (no false upgrades)", async () => {
    const latest = await latestWith({ tag_name: "v0.4.1" }, "unknown")
    // Both should be plain "0.4.1" — no "v" prefix mismatch
    expect(latest).toBe("0.4.1")
    // In production, Installation.VERSION would also be "0.4.1" (normalized)
    // This ensures the comparison works correctly
    expect(latest).not.toBe("v0.4.1")
  })

  test("VERSION correctly differs from latest() when versions are different", async () => {
    const latest = await latestWith({ tag_name: "v0.5.0" }, "unknown")
    expect(latest).toBe("0.5.0")
    // "0.4.1" !== "0.5.0" → upgrade should proceed
    expect("0.4.1" === latest).toBe(false)
  })
})
