import { describe, expect, test } from "bun:test"
import { welcomeLines, WORKSPACE_COMMANDS } from "../../../src/altimate/workspace/welcome-lines"

const binding = {
  datamateId: 6,
  datamateName: "e2e-demo-live",
  repoRemote: null,
  projectPath: "/proj",
  linkedAt: 1,
}
const snapshot = (id = "6") => ({
  workspace: { id, name: "e2e-demo-live" },
  engineVersion: "0.7.2",
  declared: { keys: ["a", "b", "c"], extensionKeys: ["x"] },
  present: ["a", "x"],
  unfulfilled: [
    { key: "b", integrationId: "jira", reason: "invalid-connection" },
    { key: "c", integrationId: "jira", reason: "invalid-connection" },
  ],
  extServed: 1,
  at: 1,
})

describe("welcomeLines", () => {
  test("unlinked: says so, and points at the link command rather than the menu", () => {
    const lines = welcomeLines({ binding: null, snapshot: snapshot() })
    expect(lines.mode).toBe("Workspace mode · this project is not linked")
    expect(lines.commands).toContain("altimate-code link")
    expect(lines.integrations).toBe("Integrations: none until the project is linked")
  })

  test("linked before any session: names the workspace and promises the attach", () => {
    const lines = welcomeLines({ binding, snapshot: undefined })
    expect(lines.mode).toBe("Workspace mode · linked to e2e-demo-live")
    expect(lines.commands).toBe(WORKSPACE_COMMANDS)
    expect(lines.integrations).toBe("Integrations: attach on your first message")
  })

  test("after a session: the toast's numbers, with a pointer when something needs attention", () => {
    const lines = welcomeLines({ binding, snapshot: snapshot() })
    expect(lines.integrations).toBe(
      "Integrations: 1 of 3 integration tools available · 2 need attention · 1 more via VS Code — /workspace for the reasons",
    )
  })

  test("a snapshot from another workspace is ignored", () => {
    const lines = welcomeLines({ binding, snapshot: snapshot("9") })
    expect(lines.integrations).toBe("Integrations: attach on your first message")
  })
})
