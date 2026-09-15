// altimate_change - new file
//
// The sync toast's wording. Split out because the message is the only place a
// user learns what a sweep did, and two earlier versions of it lied: one
// reported a sweep in which the service refused EVERY block as "Everything is
// already in the workspace", and one folded deferrals into "already present" so
// a sweep that sent nothing read as a clean all-clear.
import { describe, expect, test } from "bun:test"
import { syncMessageForTests as message } from "../../../src/plugin/tui/altimate/workspace"

const report = (over: Partial<Parameters<typeof message>[0]> = {}) => ({
  gated: false,
  sent: 0,
  failed: 0,
  skipped: 0,
  declined: 0,
  deferred: 0,
  ...over,
})

describe("the sync toast", () => {
  test("does not report a fully refused sweep as success", () => {
    const out = message(report({ declined: 19 }))
    expect(out).not.toContain("already in the workspace")
    expect(out).toContain("19")
    expect(out).toContain("refused")
  })

  test("does not report a fully deferred sweep as success", () => {
    // Deferred = the workspace holds a newer copy, or its record set could not
    // be read. Nothing was sent; a later save retries. That is not "already
    // there".
    const out = message(report({ deferred: 4 }))
    expect(out).not.toContain("already in the workspace")
    expect(out).toContain("4 deferred")
  })

  test("still says nothing was needed when a sweep genuinely had nothing to do", () => {
    // `skipped` = blocks already present at their current payload — the
    // healthy case for a sweep that had nothing to send. Its count is
    // deliberately not surfaced as a number.
    const out = message(report({ skipped: 12 }))
    expect(out).toContain("Everything is already in the workspace")
    expect(out).not.toContain("12")
  })

  test("distinguishes memory being off from an empty sweep", () => {
    expect(message(report({ gated: true }))).toContain("memory is off")
  })

  test("names the actual reason a sweep never ran", () => {
    // Four things gate a sweep and only one is the workspace's memory toggle.
    // Told "memory is off" for a failed local read, the user went to a setting
    // that was fine.
    expect(message(report({ gated: true, gatedBecause: "read-failed" }))).toContain("Could not read")
    expect(message(report({ gated: true, gatedBecause: "read-failed" }))).not.toContain("memory is off")
    expect(message(report({ gated: true, gatedBecause: "no-binding" }))).toContain("not linked")
    expect(message(report({ gated: true, gatedBecause: "memory-off" }))).toContain("memory is off")
  })

  test("reports a partial refusal alongside what did go", () => {
    const out = message(report({ sent: 3, declined: 2 }))
    expect(out).toContain("Sent 3")
    expect(out).toContain("2 refused")
  })

  test("names every not-sent count when a sweep is mixed", () => {
    const out = message(report({ sent: 0, failed: 1, declined: 2, deferred: 3 }))
    expect(out).toContain("Nothing was sent")
    expect(out).toContain("1 failed")
    expect(out).toContain("2 refused")
    expect(out).toContain("3 deferred")
    expect(out).not.toContain("all")
  })
})
