import { describe, test, expect } from "bun:test"
import { registryToolSource, mcpToolSource, humanizeMcpTitle, skillToolSource } from "../../src/altimate/tool-source"

describe("registryToolSource", () => {
  test("native opencode tools → builtin", () => {
    for (const id of ["read", "write", "edit", "glob", "grep", "list", "bash", "task", "skill", "apply_patch"]) {
      expect(registryToolSource(id)).toBe("builtin")
    }
  })

  test("any non-native registry tool → altimate (incl. tools not enumerated here)", () => {
    for (const id of ["sql_analyze", "schema_inspect", "finops_query_history", "altimate_core_check", "data_diff", "some_new_altimate_tool"]) {
      expect(registryToolSource(id)).toBe("altimate")
    }
  })
})

describe("skillToolSource", () => {
  test("Altimate-shipped (builtin origin) skills → altimate", () => {
    expect(skillToolSource("builtin")).toBe("altimate")
  })

  test("user-authored global/project skills → builtin (neutral)", () => {
    expect(skillToolSource("global")).toBe("builtin")
    expect(skillToolSource("project")).toBe("builtin")
  })

  test("missing or unexpected origin → builtin (neutral, never over-claims)", () => {
    expect(skillToolSource(undefined)).toBe("builtin")
    expect(skillToolSource(null)).toBe("builtin")
    expect(skillToolSource("")).toBe("builtin")
    expect(skillToolSource(42)).toBe("builtin")
  })
})

describe("mcpToolSource", () => {
  test("Datamates MCP tools → altimate", () => {
    expect(mcpToolSource("datamates_jira_get_issue")).toBe("altimate")
    expect(mcpToolSource("datamate_snowflake_query")).toBe("altimate")
  })

  test("third-party MCP tools → mcp", () => {
    expect(mcpToolSource("github_search_issues")).toBe("mcp")
    expect(mcpToolSource("linear_create_issue")).toBe("mcp")
  })
})

describe("humanizeMcpTitle", () => {
  test("strips the client segment and Title-Cases the rest", () => {
    expect(humanizeMcpTitle("datamates_jira_get_issue")).toBe("Jira Get Issue")
    expect(humanizeMcpTitle("github_search_issues")).toBe("Search Issues")
  })

  test("falls back gracefully for single-segment keys", () => {
    expect(humanizeMcpTitle("ping")).toBe("Ping")
  })
})
