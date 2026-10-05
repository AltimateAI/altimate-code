// altimate_change start — debug mode tracing
import { afterEach, describe, expect, test } from "bun:test"
import { isDebugMode, resetForTests, runningForTests, traceToolCall } from "../../../src/altimate/debug/mode"

afterEach(() => {
  delete process.env.ALTIMATE_DEBUG
  resetForTests()
})

describe("debug mode", () => {
  test("is off unless ALTIMATE_DEBUG is set to an on value", () => {
    expect(isDebugMode({})).toBe(false)
    expect(isDebugMode({ ALTIMATE_DEBUG: "0" })).toBe(false)
    expect(isDebugMode({ ALTIMATE_DEBUG: "1" })).toBe(true)
    expect(isDebugMode({ ALTIMATE_DEBUG: "true" })).toBe(true)
  })

  test("off: tracing records nothing", () => {
    traceToolCall("warehouse_test", "c1")
    expect(runningForTests().size).toBe(0)
  })

  test("on: a call is tracked while it runs and forgotten when it ends", () => {
    process.env.ALTIMATE_DEBUG = "1"
    const end = traceToolCall("warehouse_test", "c1")
    expect([...runningForTests().values()].map((r) => r.tool)).toEqual(["warehouse_test"])
    end("success")
    expect(runningForTests().size).toBe(0)
  })
})
// altimate_change end
