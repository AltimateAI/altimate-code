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

  test("does not hide transport failures behind a refusal", () => {
    // Second regression, found the same way as the first: six blocks, five
    // refused and one failed, reported as "The workspace refused all 5
    // memories". The failure was dropped and "all" was false. A transport
    // failure is the retryable outcome — it is the one that must survive.
    const out = message(report({ sent: 0, failed: 1, declined: 5 }))
    expect(out).toContain("1 failed")
    expect(out).toContain("5 refused")
    expect(out).not.toContain("all 5")
  })

  test("still claims 'all' only when the refusal really was all of it", () => {
    expect(message(report({ declined: 4 }))).toContain("refused all 4")
  })

  test("leads with what happened, not a count of zero", () => {
    expect(message(report({ sent: 0, failed: 2, declined: 1 }))).toContain("Nothing was sent")
  })
})
