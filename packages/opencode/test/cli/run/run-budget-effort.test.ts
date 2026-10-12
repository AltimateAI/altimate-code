// altimate_change start — budget effort is scoped to active run requests
import { describe, expect, test } from "bun:test"
import * as RunBudgetEffort from "../../../src/altimate/session/run-budget-effort"

describe("run budget effort lifetime", () => {
  test("a soft deadline affects only its active run and is cleared before session reuse", () => {
    const end = RunBudgetEffort.begin("run")
    const endOther = RunBudgetEffort.begin("other")
    try {
      expect(RunBudgetEffort.effortOverride("run")).toBe(false)
      expect(RunBudgetEffort.downgradeEffort("run")).toBeNumber()
      expect(RunBudgetEffort.effortOverride("run")).toBe(true)
      expect(RunBudgetEffort.effortOverride("other")).toBe(false)
    } finally {
      end()
      endOther()
    }
    expect(RunBudgetEffort.effortOverride("run")).toBe(false)
    expect(RunBudgetEffort.downgradeEffort("run")).toBeUndefined()
    expect(RunBudgetEffort.effortOverride("run")).toBe(false)
  })

  test("finalization can re-arm the downgrade without leaking to the next run", () => {
    const endWork = RunBudgetEffort.begin("run")
    RunBudgetEffort.downgradeEffort("run")
    endWork()
    const endFinalization = RunBudgetEffort.begin("run")
    RunBudgetEffort.downgradeEffort("run")
    expect(RunBudgetEffort.effortOverride("run")).toBe(true)
    endFinalization()
    const endNext = RunBudgetEffort.begin("run")
    expect(RunBudgetEffort.effortOverride("run")).toBe(false)
    endNext()
  })
})
// altimate_change end
