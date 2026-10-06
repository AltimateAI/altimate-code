import { describe, expect, test } from "bun:test"
import { workspaceIdentity, type AttachSnapshot } from "../../../src/altimate/workspace/attach-snapshot"
import { WELCOME_LINE_MAX_CHARS, welcomeLines, welcomeLinesFor, WORKSPACE_COMMANDS } from "../../../src/altimate/workspace/welcome-lines"

const binding = {
  datamateId: 6,
  datamateName: "e2e-demo-live",
  repoRemote: null,
  projectPath: "/proj",
  linkedAt: 1,
}
const snapshot = (over: Partial<AttachSnapshot> = {}): AttachSnapshot => ({
  workspace: { id: "6", name: "e2e-demo-live", key: workspaceIdentity("acme|https://api.example.com", 6) },
  engineVersion: "0.7.3",
  declared: { keys: ["a", "b", "c"], extensionKeys: ["x"] },
  present: ["a", "x"],
  unfulfilled: [
    { key: "b", integrationId: "jira", reason: "invalid-connection" },
    { key: "c", integrationId: "jira", reason: "invalid-connection" },
  ],
  at: 0,
  ...over,
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

  test("after a session: the last session's numbers, its age, and a pointer when something needs attention", () => {
    const lines = welcomeLines({ binding, snapshot: snapshot(), now: 2 * 3_600_000 })
    expect(lines.integrations).toBe(
      "Integrations (last session, 2h ago): 1 of 3 integration tools available · 2 need attention · 1 more via VS Code — /workspace for the reasons",
    )
  })

  test("no pointer when nothing needs attention", () => {
    const lines = welcomeLines({ binding, snapshot: snapshot({ present: ["a", "b", "c"], unfulfilled: [] }), now: 30_000 })
    expect(lines.integrations).toBe("Integrations (last session, just now): 3 of 3 integration tools available")
  })

  test("no line outgrows the length the boot box reserves rows for, whatever the name and counts", () => {
    const keys = Array.from({ length: 2000 }, (_, i) => `k${i}`)
    const ext = Array.from({ length: 1000 }, (_, i) => `e${i}`)
    const huge = snapshot({
      declared: { keys, extensionKeys: ext },
      present: [...keys.slice(0, 1000), ...ext],
      unfulfilled: keys.slice(1000).map((key) => ({ key, integrationId: "jira", reason: "invalid-connection" })),
      at: 0,
    })
    const name = "a very long workspace name ".repeat(20)
    const wide = "分析工作区数据平台团队".repeat(10) + "📊".repeat(20)
    for (const lines of [
      welcomeLines({ binding: { ...binding, datamateName: wide }, snapshot: huge, now: 99 * 86_400_000 }),
      welcomeLines({ binding: { ...binding, datamateName: name }, snapshot: huge, now: 99 * 86_400_000 }),
      welcomeLines({ binding: { ...binding, datamateName: name }, snapshot: undefined }),
      welcomeLines({ binding: null, snapshot: undefined }),
    ]) {
      expect(Bun.stringWidth(lines.mode)).toBeLessThanOrEqual(WELCOME_LINE_MAX_CHARS.mode)
      expect(Bun.stringWidth(lines.commands)).toBeLessThanOrEqual(WELCOME_LINE_MAX_CHARS.commands)
      expect(Bun.stringWidth(lines.integrations)).toBeLessThanOrEqual(WELCOME_LINE_MAX_CHARS.integrations)
    }
  })

  test("the mode line shortens a long name to 40 columns and keeps it on one line", () => {
    const lines = welcomeLines({ binding: { ...binding, datamateName: "x".repeat(100) + "\nnext" }, snapshot: undefined })
    expect(lines.mode).toBe(`Workspace mode · linked to ${"x".repeat(39)}…`)
    // Two columns a character: 19 of them, then the ellipsis.
    const wide = welcomeLines({ binding: { ...binding, datamateName: "分".repeat(60) }, snapshot: undefined })
    expect(wide.mode).toBe(`Workspace mode · linked to ${"分".repeat(19)}…`)
  })

  test("an unresolved binding leaves the box as it is instead of claiming the project is unlinked", () => {
    // A cold cache read as "not linked — run altimate-code link". (coderabbit, cubic)
    expect(welcomeLinesFor({ status: "unknown" }, undefined)).toBeNull()
    expect(welcomeLinesFor({ status: "unbound" }, undefined)?.mode).toBe(
      "Workspace mode · this project is not linked",
    )
    expect(welcomeLinesFor({ status: "bound", binding }, undefined)?.mode).toStartWith(
      "Workspace mode · linked to",
    )
  })

  test("the mode line strips bidi controls, so a name cannot reorder the text around it", () => {
    // A right-to-left override in the name would otherwise flip "linked to …". (cubic)
    const lines = welcomeLines({ binding: { ...binding, datamateName: "\u202eanalytics\u2066x\u2069" }, snapshot: undefined })
    expect(lines.mode).toBe("Workspace mode · linked to analyticsx")
  })
})

