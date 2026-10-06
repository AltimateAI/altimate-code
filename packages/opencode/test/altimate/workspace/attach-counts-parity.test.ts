// altimate_change - new file
//
// Every surface that describes an attach shows the same numbers: the toast,
// the status view, the `/workspace` menu row, the sidebar tile and the boot
// box. Run over the cases where a hand-copied count would drift: a key that
// sanitises, two raw keys that collide, and a key both served and reported.
import { describe, expect, test } from "bun:test"
import { snapshotCounts, workspaceIdentity, type AttachSnapshot } from "../../../src/altimate/workspace/attach-snapshot"
import { attachSummary } from "../../../src/altimate/workspace/engine-overlay"
import {
  buildStatusView,
  menuStatusLine,
  sidebarAttachLine,
  statusHeadline,
} from "../../../src/altimate/workspace/status-view"
import { welcomeLines } from "../../../src/altimate/workspace/welcome-lines"

const snapshot = (over: Pick<AttachSnapshot, "declared" | "present" | "unfulfilled">): AttachSnapshot => ({
  workspace: { id: "6", name: "w", key: workspaceIdentity("acme|https://api.example.com", 6) },
  engineVersion: "0.7.3",
  at: 0,
  ...over,
})
const binding = { datamateId: 6, datamateName: "w", repoRemote: null, projectPath: "/p", linkedAt: 0 }

const cases: Array<[string, AttachSnapshot, string]> = [
  [
    "a raw key served under its sanitised name",
    snapshot({ declared: { keys: ["jira.search"], extensionKeys: [] }, present: ["jira_search"], unfulfilled: [] }),
    "1 of 1 integration tools available",
  ],
  [
    "two raw keys that sanitise to one served name",
    snapshot({ declared: { keys: ["a.b", "a_b"], extensionKeys: [] }, present: ["a_b"], unfulfilled: [] }),
    "1 of 2 integration tools available",
  ],
  [
    "a key both served and reported",
    snapshot({
      declared: { keys: ["a", "b"], extensionKeys: [] },
      present: ["a", "b"],
      unfulfilled: [{ key: "b", integrationId: "x", reason: "exception" }],
    }),
    "1 of 2 integration tools available · 1 needs attention",
  ],
  [
    "no allowlist",
    snapshot({ declared: null, present: ["a", "knowledge"], unfulfilled: undefined }),
    "2 integration tools available",
  ],
]

describe("the same numbers on every surface", () => {
  test.each(cases)("%s", (_label, s, headline) => {
    expect(statusHeadline(snapshotCounts(s))).toBe(headline)
    expect(attachSummary(snapshotCounts(s))).toBe(`${headline}. Details: /workspace`)
    expect(statusHeadline(buildStatusView(s, null))).toBe(headline)
    expect(menuStatusLine(s)).toBe(headline)
    expect(sidebarAttachLine(s, 0)).toBe(`${headline} · last session just now`)
    expect(welcomeLines({ binding, snapshot: s, now: 0 }).integrations).toStartWith(
      `Integrations (last session, just now): ${headline}`,
    )
  })
})
