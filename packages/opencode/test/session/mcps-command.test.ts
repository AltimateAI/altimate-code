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
    // Asserted against a literal, not against the same call with the argument omitted: that
    // defaults to [] too, so both sides were byte-identical and the test passed even when the
    // function appended an "unresolved: ..." suffix it should not have.
    const out = SessionPrompt.formatMcpStatusForDisplay("ok", { status: "connected" }, [])
    expect(out).not.toContain("unresolved")
    expect(out).toBe(SessionPrompt.formatMcpStatusForDisplay("ok", { status: "connected" }))
  })
})
// altimate_change end

// altimate_change start — upstream_fix (#701): `/mcps` must not show less than `mcp list`.
describe("/mcps file-scoped blank variables", () => {
  test("renders one line per config source", () => {
    // A server templated as `"url": "https://{env:MY_HOST}/mcp"` records against the config file,
    // not the server, so it never reached `/mcps` through unresolvedEnvVars.
    const out = SessionPrompt.formatBlankedEnvForDisplay([
      { source: "/home/u/.config/altimate-code/altimate-code.json", names: ["MY_HOST"] },
    ])
    expect(out).toContain("MY_HOST")
    expect(out).toContain("/home/u/.config/altimate-code/altimate-code.json")
    expect(out).toContain("set or remove")
  })

  test("names every variable in a source, not just the first", () => {
    const out = SessionPrompt.formatBlankedEnvForDisplay([{ source: "cfg.json", names: ["A", "B"] }])
    expect(out).toContain("A")
    expect(out).toContain("B")
  })

  test("one line per source", () => {
    const out = SessionPrompt.formatBlankedEnvForDisplay([
      { source: "a.json", names: ["A"] },
      { source: "b.json", names: ["B"] },
    ])
    expect(out.split("\n")).toHaveLength(2)
  })

  test("empty when nothing blanked, so the table gains no trailing noise", () => {
    expect(SessionPrompt.formatBlankedEnvForDisplay([])).toBe("")
  })
})
// altimate_change end

// altimate_change start — upstream_fix (#878): drift belongs in the session view too.
describe("/mcps config drift", () => {
  test("names the server, the file, and the fields", () => {
    const out = SessionPrompt.formatConfigDriftForDisplay([
      { server: "datamate", source: ".vscode/mcp.json", fields: ["environment.ALTIMATE_EXTENSION_RPC"] },
    ])
    expect(out).toContain("datamate")
    expect(out).toContain(".vscode/mcp.json")
    expect(out).toContain("environment.ALTIMATE_EXTENSION_RPC")
    // The user's config still wins; the message says so rather than implying an action was taken.
    expect(out).toContain("config wins")
  })

  test("one line per drifted server", () => {
    const out = SessionPrompt.formatConfigDriftForDisplay([
      { server: "a", source: "x.json", fields: ["command"] },
      { server: "b", source: "y.json", fields: ["command"] },
    ])
    expect(out.split("\n")).toHaveLength(2)
  })

  test("empty when nothing drifted", () => {
    expect(SessionPrompt.formatConfigDriftForDisplay([])).toBe("")
  })
})
// altimate_change end
