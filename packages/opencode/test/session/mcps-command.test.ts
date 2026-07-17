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
