import { describe, test, expect } from "bun:test"

/**
 * Tests for the non-blocking sync resilience pattern used in sync.tsx.
 *
 * The TUI loads commands and other data in a non-blocking Promise.all after
 * the initial "partial" status. Previously, if any single request failed,
 * the entire Promise.all rejected silently (fire-and-forget, no .catch).
 *
 * The fix wraps each request in a `safe()` helper that catches individual
 * failures, allowing other requests to succeed. These tests verify that
 * pattern works correctly.
 */
describe("safe() wrapper pattern (sync resilience)", () => {
  // Replicate the safe() pattern from sync.tsx
  const warnings: string[] = []
  const safe = <T,>(p: Promise<T>) =>
    p.catch((e: unknown) => {
      warnings.push(e instanceof Error ? e.message : String(e))
    })

  test("all promises succeed — all values resolved", async () => {
    warnings.length = 0
    const results: string[] = []

    await Promise.all([
      safe(Promise.resolve("commands").then((v) => results.push(v))),
      safe(Promise.resolve("lsp").then((v) => results.push(v))),
      safe(Promise.resolve("mcp").then((v) => results.push(v))),
    ])

    expect(results).toEqual(["commands", "lsp", "mcp"])
    expect(warnings.length).toBe(0)
  })

  test("one promise fails — others still succeed", async () => {
    warnings.length = 0
    const results: string[] = []

    await Promise.all([
      safe(Promise.resolve("commands").then((v) => results.push(v))),
      safe(Promise.reject(new Error("LSP server crashed"))),
      safe(Promise.resolve("mcp").then((v) => results.push(v))),
    ])

    expect(results).toEqual(["commands", "mcp"])
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toBe("LSP server crashed")
  })

  test("all promises fail — none throw, all warnings captured", async () => {
    warnings.length = 0
    const results: string[] = []

    await Promise.all([
      safe(Promise.reject(new Error("Command list failed"))),
      safe(Promise.reject(new Error("LSP failed"))),
      safe(Promise.reject(new Error("MCP failed"))),
    ])

    expect(results.length).toBe(0)
    expect(warnings.length).toBe(3)
    expect(warnings).toContain("Command list failed")
    expect(warnings).toContain("LSP failed")
    expect(warnings).toContain("MCP failed")
  })

  test("Promise.all resolves even when individual items fail", async () => {
    warnings.length = 0
    let statusSet = false

    await Promise.all([
      safe(Promise.reject(new Error("fail"))),
      safe(Promise.resolve("ok")),
    ]).then(() => {
      statusSet = true // This represents setStore("status", "complete")
    })

    expect(statusSet).toBe(true) // "complete" status is always reached
    expect(warnings.length).toBe(1)
  })

  test("without safe(), single failure prevents status from being set", async () => {
    let statusSet = false

    // This is the OLD behavior — Promise.all rejects if any item rejects
    try {
      await Promise.all([
        Promise.reject(new Error("fail")),
        Promise.resolve("ok"),
      ]).then(() => {
        statusSet = true
      })
    } catch {
      // swallowed
    }

    expect(statusSet).toBe(false) // status never reaches "complete"
  })

  test("safe() handles non-Error rejections", async () => {
    warnings.length = 0

    await Promise.all([
      safe(Promise.reject("string error")),
      safe(Promise.reject(42)),
      safe(Promise.reject(null)),
    ])

    expect(warnings.length).toBe(3)
    expect(warnings[0]).toBe("string error")
    expect(warnings[1]).toBe("42")
    expect(warnings[2]).toBe("null")
  })

  test("safe() preserves resolved value for chaining", async () => {
    warnings.length = 0
    const store: Record<string, any> = {}

    await Promise.all([
      safe(
        Promise.resolve({ data: [{ name: "discover" }] }).then((x) => {
          store["command"] = x.data
        }),
      ),
      safe(
        Promise.resolve({ data: { status: "healthy" } }).then((x) => {
          store["lsp"] = x.data
        }),
      ),
    ])

    expect(store["command"]).toEqual([{ name: "discover" }])
    expect(store["lsp"]).toEqual({ status: "healthy" })
    expect(warnings.length).toBe(0)
  })
})
