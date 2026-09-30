import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AttachSnapshot } from "../../../src/altimate/workspace/attach-snapshot"
import type { DeclaredIntegration } from "../../../src/altimate/workspace/engine-types"

const SANDBOX = mkdtempSync(path.join(tmpdir(), "status-view-"))
const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME
process.env.XDG_STATE_HOME = path.join(SANDBOX, "state")
afterAll(() => {
  if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME
  rmSync(SANDBOX, { recursive: true, force: true })
})

const { buildStatusView, loadStatusView, menuStatusLine, rowLine, sidebarAttachLine, statusHeadline } = await import(
  "../../../src/altimate/workspace/status-view"
)
const { snapshotDir, workspaceIdentity, writeAttachSnapshot } = await import(
  "../../../src/altimate/workspace/attach-snapshot"
)
const { AltimateApi } = await import("../../../src/altimate/api/client")

const SCOPE = "acme|https://api.example.com"
const integrations: DeclaredIntegration[] = [
  { id: "altimate", name: "Altimate", extension: false, keys: ["altimate_a", "altimate_b"] },
  { id: "jira", name: "Jira", extension: false, keys: ["jira_search", "jira_create"] },
  { id: "power-user-for-dbt", name: "Power User for dbt", extension: true, keys: ["get_projects"] },
  { id: "1", name: null, extension: false, keys: ["demo_tool"] },
]
const snapshot = (over: Partial<AttachSnapshot> = {}): AttachSnapshot => ({
  workspace: { id: "6", name: "e2e-demo-live", key: workspaceIdentity(SCOPE, 6) },
  engineVersion: "0.7.3",
  declared: {
    keys: ["altimate_a", "altimate_b", "jira_search", "jira_create", "demo_tool"],
    extensionKeys: ["get_projects"],
    integrations,
  },
  present: ["altimate_a", "altimate_b", "altimate_knowledge_search"],
  unfulfilled: [
    { key: "jira_search", integrationId: "jira", reason: "invalid-connection" },
    { key: "jira_create", integrationId: "jira", reason: "invalid-connection" },
    { key: "demo_tool", integrationId: "1", reason: "spawn-failed", detail: "altimate-demo-missing-mcp: ENOENT" },
    { key: "get_projects", integrationId: "power-user-for-dbt", reason: "no-bridge" },
  ],
  at: 1,
  ...over,
})
const selection = integrations.map((i) => ({ id: i.id, tools: i.keys.map((key) => ({ key })) }))
const catalog = [
  { id: "altimate", name: "Altimate", type: "tool" },
  { id: "jira", name: "Jira", type: "tool" },
  { id: "power-user-for-dbt", name: "Power User for dbt", type: "extension" },
]

describe("buildStatusView", () => {
  test("one row per integration declared at attach time, attention first", () => {
    const view = buildStatusView(snapshot(), { selection, catalog })
    expect(view.rows.map((r) => [r.name, r.state])).toEqual([
      ["Integration 1", "missing"],
      ["Jira", "missing"],
      ["Altimate", "served"],
      ["Power User for dbt", "idle"],
    ])
    const jira = view.rows.find((r) => r.name === "Jira")!
    expect(rowLine(jira)).toBe("0 of 2 · no usable connection")
    expect(rowLine(view.rows[0]!)).toBe("0 of 1 · server could not be started or reached (altimate-demo-missing-mcp: ENOENT)")
    expect(rowLine(view.rows.find((r) => r.name === "Altimate")!)).toBe("2 of 2")
    expect(rowLine(view.rows.find((r) => r.name === "Power User for dbt")!)).toBe(
      "0 of 1 · needs a VS Code window open on this project",
    )
    expect(view.selectionChanged).toBe(false)
  })

  test("names come from the live catalog when it answers, else from the attach", () => {
    const renamed = buildStatusView(snapshot(), { selection, catalog: [{ id: "jira", name: "Jira Cloud" }] })
    expect(renamed.rows.find((r) => r.id === "jira")!.name).toBe("Jira Cloud")
    expect(renamed.rows.find((r) => r.id === "altimate")!.name).toBe("Altimate")
  })

  test("with the API unreachable the view is still whole: rows, counts and names from the attach", () => {
    const offline = buildStatusView(snapshot(), null)
    const online = buildStatusView(snapshot(), { selection, catalog })
    expect(offline.rows).toEqual(online.rows)
    expect(statusHeadline(offline)).toBe(statusHeadline(online))
    expect(offline.selectionChanged).toBe(false)
  })

  test("a selection changed since the attach is flagged, and the rows still describe the attach", () => {
    const view = buildStatusView(snapshot(), {
      selection: [...selection, { id: "slack", tools: [{ key: "slack_post" }] }],
      catalog,
    })
    expect(view.selectionChanged).toBe(true)
    expect(view.rows.map((r) => r.id)).not.toContain("slack")
    expect(statusHeadline(view)).toBe("2 of 5 integration tools available · 3 need attention")
  })

  test("the same selection in another order is not a change", () => {
    const view = buildStatusView(snapshot(), { selection: [...selection].reverse(), catalog })
    expect(view.selectionChanged).toBe(false)
  })

  test("an integration with nothing served and nothing reported is unexplained, not waiting for VS Code", () => {
    // No report at all (an engine that sent none, or a malformed one).
    const view = buildStatusView(snapshot({ present: ["altimate_a", "altimate_b"], unfulfilled: undefined }), null)
    const jira = view.rows.find((r) => r.id === "jira")!
    expect(jira.state).toBe("unknown")
    expect(rowLine(jira)).toBe("0 of 2 · not reported by the engine")
    // The extension still reads as waiting for its window.
    expect(view.rows.find((r) => r.id === "power-user-for-dbt")!.state).toBe("idle")
  })

  test("a row shows every distinct error its gaps carry", () => {
    const view = buildStatusView(
      snapshot({
        unfulfilled: [
          { key: "jira_search", integrationId: "jira", reason: "spawn-failed", detail: "ENOENT" },
          { key: "jira_create", integrationId: "jira", reason: "spawn-failed", detail: "EACCES" },
        ],
      }),
      null,
    )
    expect(rowLine(view.rows.find((r) => r.id === "jira")!)).toBe(
      "0 of 2 · server could not be started or reached (ENOENT; EACCES)",
    )
  })

  test("a partially served integration and a live bridge read as such", () => {
    const view = buildStatusView(
      snapshot({
        present: ["altimate_a", "get_projects"],
        unfulfilled: [{ key: "altimate_b", integrationId: "altimate", reason: "exception" }],
      }),
      null,
    )
    const altimate = view.rows.find((r) => r.name === "Altimate")!
    expect(altimate.state).toBe("partial")
    expect(rowLine(altimate)).toBe("1 of 2 · failed to load")
    expect(view.rows.find((r) => r.name === "Power User for dbt")!.state).toBe("served")
    expect(statusHeadline(view)).toBe("1 of 5 integration tools available · 1 needs attention · 1 more via VS Code")
  })

  test("a report for an integration the declaration does not list still gets a row", () => {
    const view = buildStatusView(
      snapshot({ unfulfilled: [{ key: "old_tool", integrationId: "retired", reason: "catalog-missing" }] }),
      null,
    )
    expect(view.rows.map((r) => [r.name, r.state])).toContainEqual(["Integration retired", "missing"])
  })

  describe("workspace extras", () => {
    test("are what the engine serves beyond every declared key, compared by served name", () => {
      const view = buildStatusView(
        snapshot({
          declared: {
            keys: ["jira.search"],
            extensionKeys: ["get_projects"],
            integrations: [{ id: "jira", name: "Jira", extension: false, keys: ["jira.search"] }],
          },
          present: ["jira_search", "get_projects", "altimate_knowledge_search"],
          unfulfilled: [],
        }),
        null,
      )
      expect(view.extras).toEqual(["altimate_knowledge_search"])
    })

    test("are omitted without an allowlist, when nothing can be called extra", () => {
      const view = buildStatusView(snapshot({ declared: null, unfulfilled: undefined }), null)
      expect(view.declared).toBeUndefined()
      expect(statusHeadline(view)).toBe("3 integration tools available")
      expect(view.rows).toEqual([])
      expect(view.extras).toEqual([])
    })
  })
})

describe("the menu row and the sidebar line", () => {
  test("the menu row is the headline, or why there is none yet", () => {
    expect(menuStatusLine(snapshot())).toBe("2 of 5 integration tools available · 3 need attention")
    expect(menuStatusLine(undefined)).toBe("No session has attached yet — send a message first.")
  })

  test("the sidebar line says the numbers are the last session's, and how old they are", () => {
    expect(sidebarAttachLine(snapshot({ at: 0 }), 5 * 60_000)).toBe(
      "2 of 5 integration tools available · 3 need attention · last session 5m ago",
    )
  })
})

describe("loadStatusView", () => {
  const DIR = "/proj/status"
  const bound = { scope: SCOPE, datamateId: 6 }
  let getDatamate: ReturnType<typeof spyOn>
  let listIntegrations: ReturnType<typeof spyOn>

  beforeEach(() => {
    rmSync(snapshotDir(), { recursive: true, force: true })
    getDatamate = spyOn(AltimateApi, "getDatamate").mockResolvedValue({ integrations: selection } as never)
    listIntegrations = spyOn(AltimateApi, "listIntegrations").mockResolvedValue(catalog as never)
  })
  afterEach(() => {
    getDatamate.mockRestore()
    listIntegrations.mockRestore()
  })

  test("returns null before any request when no attach matches the bound workspace", async () => {
    writeAttachSnapshot(DIR, snapshot())
    expect(await loadStatusView(DIR, { scope: SCOPE, datamateId: 7 })).toBeNull()
    expect(await loadStatusView(DIR, { scope: "other|https://api.example.com", datamateId: 6 })).toBeNull()
    expect(getDatamate).not.toHaveBeenCalled()
    expect(listIntegrations).not.toHaveBeenCalled()
  })

  test("joins the live names when the API answers", async () => {
    writeAttachSnapshot(DIR, snapshot())
    const view = await loadStatusView(DIR, bound)
    expect(view?.rows).toHaveLength(4)
    expect(getDatamate).toHaveBeenCalledWith("6")
  })

  test("falls back to the attach alone when the API fails", async () => {
    getDatamate.mockRejectedValue(new Error("offline"))
    writeAttachSnapshot(DIR, snapshot())
    const view = await loadStatusView(DIR, bound)
    expect(view?.rows.map((r) => r.name)).toEqual(["Integration 1", "Jira", "Altimate", "Power User for dbt"])
    expect(view?.selectionChanged).toBe(false)
  })
})
