import { describe, expect, test } from "bun:test"
import { RunTimeBudget } from "../../../src/cli/cmd/run-time-budget"

describe("run time budget", () => {
  test.each([0, -1, -0.1, NaN, Infinity, -Infinity, "2", "", null, undefined, true, {}])(
    "rejects invalid seconds: %p",
    (value) => {
      expect(RunTimeBudget.isValidTimeBudget(value)).toBe(false)
    },
  )

  test.each([0.001, 0.5, 1, 900, Number.MAX_VALUE])("accepts positive finite seconds: %p", (value) => {
    expect(RunTimeBudget.isValidTimeBudget(value)).toBe(true)
  })

  test("does not fire when no budget is configured", () => {
    expect(RunTimeBudget.deadline(900, undefined)).toBeUndefined()
  })

  test.each([
    [0, undefined],
    [7.999, undefined],
    [8, "soft"],
    [9.999, "soft"],
    [10, "hard"],
    [20, "hard"],
  ] as const)("selects the deadline at %p elapsed seconds", (elapsed, expected) => {
    expect(RunTimeBudget.deadline(elapsed, 10)).toBe(expected)
  })

  test("handles fractional seconds without rounding away the budget", () => {
    expect(RunTimeBudget.deadline(0.399, 0.5)).toBeUndefined()
    expect(RunTimeBudget.deadline(0.4, 0.5)).toBe("soft")
    expect(RunTimeBudget.deadline(0.5, 0.5)).toBe("hard")
  })

  test("handles a large finite budget without overflowing deadline arithmetic", () => {
    expect(RunTimeBudget.deadline(Number.MAX_VALUE * 0.5, Number.MAX_VALUE)).toBeUndefined()
    expect(RunTimeBudget.deadline(Number.MAX_VALUE * 0.8, Number.MAX_VALUE)).toBe("soft")
    expect(RunTimeBudget.deadline(Number.MAX_VALUE, Number.MAX_VALUE)).toBe("hard")
  })
})
