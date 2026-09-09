// altimate_change - new file
//
// The sync toast's wording. Split out because the message is the only place a
// user learns what a sweep did, and one earlier version of it reported a sweep
// in which the service refused EVERY block as "Everything is already in the
// workspace." — found by watching a recording of the real TUI, not by a test.
import { describe, expect, test } from "bun:test"
import { syncMessageForTests as message } from "../../../src/plugin/tui/altimate/workspace"

const report = (over: Partial<Parameters<typeof message>[0]> = {}) => ({
  gated: false,
  sent: 0,
  failed: 0,
  skipped: 0,
  declined: 0,
  ...over,
})

describe("the sync toast", () => {
  test("does not report a fully refused sweep as success", () => {
    // The regression. `declined` means the service said no — quota, permissions,
    // a workspace setting — which is not the same as having nothing to send.
    const out = message(report({ declined: 19 }))
    expect(out).not.toContain("already in the workspace")
    expect(out).toContain("19")
    expect(out).toContain("refused")
  })

  test("still says nothing was needed when a sweep genuinely had nothing to do", () => {
    expect(message(report({ skipped: 12 }))).toContain("Everything is already in the workspace")
  })

  test("distinguishes memory being off from an empty sweep", () => {
    expect(message(report({ gated: true }))).toContain("memory is off")
  })

  test("reports a partial refusal alongside what did go", () => {
    const out = message(report({ sent: 3, declined: 2 }))
    expect(out).toContain("Sent 3")
    expect(out).toContain("2 refused")
  })

  test("counts failures separately from refusals", () => {
    const out = message(report({ sent: 1, failed: 4 }))
    expect(out).toContain("4 failed")
  })
})
