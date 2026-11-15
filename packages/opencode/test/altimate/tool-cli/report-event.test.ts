import { describe, expect, test } from "bun:test"
import { REPORT_ACTIONS, reportEvent } from "../../../src/altimate/tool-cli/report-event"

describe("tool report-event", () => {
  test("an action and a Claude Code session make one event with nothing else in it", () => {
    expect(REPORT_ACTIONS).toEqual(["summary_shown", "open_pressed", "command_run", "built", "build_failed", "no_browser"])
    for (const action of REPORT_ACTIONS) {
      expect(reportEvent(action, "claude:3f6c2a10-7b2e-4c1d-9a55-0e1f2a3b4c5d", 1000)).toEqual({
        type: "lineage_report",
        timestamp: 1000,
        session_id: "claude:3f6c2a10-7b2e-4c1d-9a55-0e1f2a3b4c5d",
        action,
      })
    }
  })

  test("an action outside the list is refused", () => {
    for (const action of ["clicked_column", "", undefined, "built; rm -rf /"]) expect(reportEvent(action, "claude:abc")).toHaveProperty("error")
  })

  test("a session that is not claude:<id> is refused, so no path or name can ride along", () => {
    for (const session of ["abc", "codex:abc", "claude:", "claude:/home/someone/project", "claude:a b", `claude:${"x".repeat(129)}`, undefined])
      expect(reportEvent("built", session)).toHaveProperty("error")
  })
})
