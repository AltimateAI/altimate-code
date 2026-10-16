import { describe, expect, test } from "bun:test"
import { RunBudget } from "../../../src/altimate/run-budget"
import { RunTimeBudget } from "../../../src/cli/cmd/run-time-budget"

describe("query deadline within the run budget", () => {
  test("reserves answer time before the hard deadline", () => {
    expect(RunTimeBudget.queryDeadline(1_000, 600)).toBe(511_000)
    expect(RunTimeBudget.queryDeadline(1_000, 5)).toBe(5_000)
    expect(RunTimeBudget.queryDeadline(1_000, undefined)).toBeUndefined()
  })

  test("keeps very large finite budgets finite", () => {
    expect(Number.isFinite(RunTimeBudget.queryDeadline(1_000, Number.MAX_VALUE))).toBe(true)
  })

  test("keeps a newer run deadline when the previous run releases", () => {
    const first = RunBudget.registerQueryDeadline("session-query-budget", 10_000)
    const second = RunBudget.registerQueryDeadline("session-query-budget", 20_000)
    first()
    expect(RunBudget.queryDeadline("session-query-budget")).toBe(20_000)
    second()
    expect(RunBudget.queryDeadline("session-query-budget")).toBeUndefined()
  })
})
