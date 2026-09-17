// altimate_change - new file
//
// The sync toast's wording. Split out because the message is the only place a
// user learns what a sweep did, and two earlier versions of it lied: one
// reported a sweep in which the service refused EVERY block as "Everything is
// already in the workspace", and one folded deferrals into "already present" so
// a sweep that sent nothing read as a clean all-clear.
import { describe, expect, test } from "bun:test"
import {
  syncMessageForTests as message,
  syncVariantForTests as variant,
} from "../../../src/plugin/tui/altimate/workspace"

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

  test("a gated sweep is never a green success", () => {
    // Every count is zero when a sweep never ran, and the count-based rule
    // rendered "Could not read this project's local memory" in the success
    // colour.
    expect(variant(report({ gated: true, gatedBecause: "read-failed" }))).toBe("warning")
    expect(variant(report({ gated: true, gatedBecause: "memory-off" }))).toBe("info")
    expect(variant(report({ gated: true, gatedBecause: "no-binding" }))).toBe("info")
    expect(variant(report({ skipped: 3 }))).toBe("success")
    expect(variant(report({ deferred: 1 }))).toBe("warning")
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
