import { describe, expect, test } from "bun:test"
import { SessionPrompt } from "../../src/session/prompt"

describe("/mcps command status formatting", () => {
  test("needs_auth status includes the auth command hint", () => {
    expect(SessionPrompt.formatMcpStatusForDisplay("github", { status: "needs_auth" })).toBe(
      "\u25cb Needs authentication (run: altimate mcp auth github)",
    )
  })

  test("failed status keeps the runtime error detail", () => {
    expect(SessionPrompt.formatMcpStatusForDisplay("broken", { status: "failed", error: "boom" })).toBe(
      "\u25cb failed (boom)",
    )
  })
})

// altimate_change start — upstream_fix: unresolved env vars reach the user (#701).
// An unresolved `${SNOWFLAKE_PASSWORD}` silently became "" and the server launched with a
// blank credential; the only trace was a log line. These pin that /mcps says so instead.
describe("formatMcpStatusForDisplay — unresolved env vars", () => {
  test("names the variables on a failed server", () => {
    const out = SessionPrompt.formatMcpStatusForDisplay("snow", { status: "failed", error: "auth failed" }, [
      "SNOWFLAKE_PASSWORD",
    ])
    expect(out).toContain("auth failed")
    expect(out).toContain("SNOWFLAKE_PASSWORD")
  })

  test("warns even when the server looks connected", () => {
    // A blank credential frequently connects and only fails on first real use, so the
    // connected row is exactly where this needs saying.
    const out = SessionPrompt.formatMcpStatusForDisplay("snow", { status: "connected" }, ["TOKEN"])
    expect(out).toContain("connected")
    expect(out).toContain("TOKEN")
  })

  test("lists every unresolved variable, not just the first", () => {
    const out = SessionPrompt.formatMcpStatusForDisplay("s", { status: "connected" }, ["A_TOKEN", "B_SECRET"])
    expect(out).toContain("A_TOKEN")
    expect(out).toContain("B_SECRET")
  })

  test("says nothing extra when everything resolved", () => {
    expect(SessionPrompt.formatMcpStatusForDisplay("ok", { status: "connected" }, [])).toBe(
      SessionPrompt.formatMcpStatusForDisplay("ok", { status: "connected" }),
    )
  })
})
// altimate_change end
