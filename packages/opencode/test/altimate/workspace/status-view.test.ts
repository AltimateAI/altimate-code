import { describe, expect, test } from "bun:test"
import type { AttachSnapshot } from "../../../src/altimate/workspace/attach-snapshot"
import { buildStatusView, rowLine, statusHeadline } from "../../../src/altimate/workspace/status-view"

const snapshot = (over: Partial<AttachSnapshot> = {}): AttachSnapshot => ({
  workspace: { id: "6", name: "e2e-demo-live" },
  engineVersion: "0.7.2",
  declared: {
    keys: ["altimate_a", "altimate_b", "jira_search", "jira_create", "demo_tool"],
    extensionKeys: ["get_projects"],
  },
  present: ["altimate_a", "altimate_b", "altimate_knowledge_search"],
  unfulfilled: [
    { key: "jira_search", integrationId: "jira", reason: "invalid-connection" },
    { key: "jira_create", integrationId: "jira", reason: "invalid-connection" },
    { key: "demo_tool", integrationId: "1", reason: "spawn-failed", detail: "altimate-demo-missing-mcp: ENOENT" },
    { key: "get_projects", integrationId: "power-user-for-dbt", reason: "no-bridge" },
  ],
  extServed: 0,
  at: 1,
  ...over,
})
const selection = [
  { id: "altimate", tools: [{ key: "altimate_a" }, { key: "altimate_b" }] },
  { id: "jira", tools: [{ key: "jira_search" }, { key: "jira_create" }] },
  { id: "power-user-for-dbt", tools: [{ key: "get_projects" }] },
  { id: "1", tools: [{ key: "demo_tool" }] },
]
const catalog = [
  { id: "altimate", name: "Altimate", type: "tool" },
  { id: "jira", name: "Jira", type: "tool" },
  { id: "power-user-for-dbt", name: "Power User for dbt", type: "extension" },
]

describe("buildStatusView", () => {
  test("one row per declared integration, attention first, named from the catalog with an id fallback", () => {
    const view = buildStatusView(snapshot(), selection, catalog)
    expect(view.rows.map((r) => [r.name, r.state])).toEqual([
      ["Integration 1", "missing"],
      ["Jira", "missing"],
      ["Altimate", "served"],
      ["Power User for dbt", "idle"],
    ])
    const jira = view.rows.find((r) => r.name === "Jira")!
    expect(jira.gaps.map((g) => g.phrase)).toEqual(["no usable connection", "no usable connection"])
    expect(rowLine(jira)).toBe("0 of 2 · no usable connection")
    expect(rowLine(view.rows[0]!)).toBe("0 of 1 · server could not be started or reached (altimate-demo-missing-mcp: ENOENT)")
    expect(rowLine(view.rows.find((r) => r.name === "Altimate")!)).toBe("2 of 2")
    expect(rowLine(view.rows.find((r) => r.name === "Power User for dbt")!)).toBe(
      "0 of 1 · needs a VS Code window open on this project",
    )
  })

  test("counts match the toast: declared keys present over declared, gaps without no-bridge, extras beyond the allowlist", () => {
    const view = buildStatusView(snapshot(), selection, catalog)
    expect(view.served).toBe(2)
    expect(view.declared).toBe(5)
    expect(view.gaps).toBe(3)
    expect(view.extras).toEqual(["altimate_knowledge_search"])
    expect(statusHeadline(view)).toBe("2 of 5 integration tools available · 3 need attention")
  })

  test("a partially served integration and a live bridge read as such", () => {
    const view = buildStatusView(
      snapshot({
        present: ["altimate_a", "get_projects"],
        unfulfilled: [{ key: "altimate_b", integrationId: "altimate", reason: "exception" }],
        extServed: 1,
      }),
      selection,
      catalog,
    )
    const altimate = view.rows.find((r) => r.name === "Altimate")!
    expect(altimate.state).toBe("partial")
    expect(rowLine(altimate)).toBe("1 of 2 · failed to load")
    expect(view.rows.find((r) => r.name === "Power User for dbt")!.state).toBe("served")
    expect(statusHeadline(view)).toBe("1 of 5 integration tools available · 1 needs attention · 1 more via VS Code")
  })

  test("a report for an integration the selection no longer lists still gets a row", () => {
    const view = buildStatusView(
      snapshot({ unfulfilled: [{ key: "old_tool", integrationId: "retired", reason: "catalog-missing" }] }),
      [{ id: "altimate", tools: [{ key: "altimate_a" }] }],
      catalog,
    )
    expect(view.rows.map((r) => [r.name, r.state])).toEqual([
      ["Integration retired", "missing"],
      ["Altimate", "served"],
    ])
  })

  test("without an allowlist the headline counts what the engine serves", () => {
    const view = buildStatusView(snapshot({ declared: null, unfulfilled: undefined }), [], [])
    expect(view.declared).toBeUndefined()
    expect(statusHeadline(view)).toBe("3 integration tools available")
    expect(view.rows).toEqual([])
  })
})
