import { describe, test, expect } from "bun:test"
import {
  registryToolSource,
  mcpToolSource,
  humanizeMcpTitle,
  skillToolSource,
  stampRegistryToolSource,
  describeMcpTool,
} from "../../src/altimate/tool-source"

describe("registryToolSource", () => {
  test("native opencode tools → builtin (id fallback)", () => {
    for (const id of ["read", "write", "edit", "glob", "grep", "list", "bash", "task", "skill", "apply_patch"]) {
      expect(registryToolSource(id)).toBe("builtin")
    }
  })

  test("non-native registry tool with no declared origin → altimate (id fallback)", () => {
    for (const id of ["sql_analyze", "schema_inspect", "finops_query_history", "altimate_core_check", "data_diff"]) {
      expect(registryToolSource(id)).toBe("altimate")
    }
  })

  test("declared origin wins over the id fallback", () => {
    expect(registryToolSource("some_new_altimate_tool", "altimate")).toBe("altimate")
    expect(registryToolSource("read", "native")).toBe("builtin")
  })

  test("external (user custom / third-party plugin) tools → builtin, never altimate", () => {
    // Regression: a custom/plugin tool id looks non-native, so the id fallback would call it
    // "altimate". The declared "external" origin keeps it neutral.
    expect(registryToolSource("my_custom_tool", "external")).toBe("builtin")
    expect(registryToolSource("acme_plugin_deploy", "external")).toBe("builtin")
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
  test("Datamates MCP client → altimate", () => {
    expect(mcpToolSource("datamates")).toBe("altimate")
    expect(mcpToolSource("datamate")).toBe("altimate")
    expect(mcpToolSource("Datamates")).toBe("altimate")
  })

  test("a datamate-prefixed client variant is Altimate", () => {
    expect(mcpToolSource("datamate-prod")).toBe("altimate")
  })

  test("third-party MCP clients → mcp", () => {
    expect(mcpToolSource("github")).toBe("mcp")
    expect(mcpToolSource("linear")).toBe("mcp")
  })

  test("a third-party client that merely starts with 'datamate' is NOT Altimate", () => {
    expect(mcpToolSource("datamatex")).toBe("mcp")
    expect(mcpToolSource("datamateworks")).toBe("mcp")
  })

  test("regression: a third-party client that sanitizes into a datamate_ key is NOT Altimate", () => {
    // Client `datamate.ai` sanitizes to `datamate_ai`, producing key `datamate_ai_query` whose
    // first segment is `datamate`. Classifying from the real client name avoids the false positive.
    expect(mcpToolSource("datamate.ai")).toBe("mcp")
  })
})

describe("humanizeMcpTitle", () => {
  test("strips the client segment (via first '_') and Title-Cases the rest", () => {
    expect(humanizeMcpTitle("datamates_jira_get_issue")).toBe("Jira Get Issue")
    expect(humanizeMcpTitle("github_search_issues")).toBe("Search Issues")
  })

  test("strips the client segment by exact sanitized length when the client name is known", () => {
    // Client `datamate.ai` → sanitized prefix `datamate_ai_`. Without the known client name a
    // first-'_' split would wrongly yield "Ai Query".
    expect(humanizeMcpTitle("datamate_ai_query", "datamate.ai")).toBe("Query")
    expect(humanizeMcpTitle("github_search_issues", "github")).toBe("Search Issues")
  })

  test("falls back gracefully for single-segment keys", () => {
    expect(humanizeMcpTitle("ping")).toBe("Ping")
  })
})

describe("stampRegistryToolSource", () => {
  test("stamps altimate for a non-native tool with no declared origin", () => {
    const out = stampRegistryToolSource({ metadata: { foo: 1 } }, { id: "sql_analyze" })
    expect(out.metadata.source).toBe("altimate")
    expect(out.metadata.foo).toBe(1) // preserves existing metadata
  })

  test("stamps builtin (neutral) for an external tool", () => {
    const out = stampRegistryToolSource({ metadata: {} }, { id: "my_custom_tool", registrySource: "external" })
    expect(out.metadata.source).toBe("builtin")
  })

  test("classifies the skill tool from its loaded skill origin", () => {
    expect(stampRegistryToolSource({ metadata: { skillOrigin: "builtin" } }, { id: "skill" }).metadata.source).toBe(
      "altimate",
    )
    expect(stampRegistryToolSource({ metadata: { skillOrigin: "project" } }, { id: "skill" }).metadata.source).toBe(
      "builtin",
    )
  })

  test("tolerates missing metadata", () => {
    const out = stampRegistryToolSource({}, { id: "read" })
    expect(out.metadata.source).toBe("builtin")
  })
})

describe("describeMcpTool", () => {
  test("returns source + humanized title from the original client name", () => {
    expect(describeMcpTool("datamates_jira_get_issue", "datamates")).toEqual({
      source: "altimate",
      title: "Jira Get Issue",
    })
    expect(describeMcpTool("datamate_ai_query", "datamate.ai")).toEqual({ source: "mcp", title: "Query" })
  })
})
