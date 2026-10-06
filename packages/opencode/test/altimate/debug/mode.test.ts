// altimate_change start — debug mode tracing
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { isDebugMode, resetForTests, runningForTests, traceToolCall } from "../../../src/altimate/debug/mode"

// The caller's own ALTIMATE_DEBUG is kept: each test sets what it needs and the original is restored afterwards.
const originalDebug = process.env.ALTIMATE_DEBUG
beforeEach(() => {
  delete process.env.ALTIMATE_DEBUG
})
afterEach(() => {
  if (originalDebug === undefined) delete process.env.ALTIMATE_DEBUG
  else process.env.ALTIMATE_DEBUG = originalDebug
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

  test("a repeated call id is two calls: ending one leaves the other running", () => {
    process.env.ALTIMATE_DEBUG = "1"
    const first = traceToolCall("bash", "dup")
    traceToolCall("bash", "dup")
    expect(runningForTests().size).toBe(2)
    first("success")
    expect(runningForTests().size).toBe(1)
  })

  test("a failed call's error text is redacted before it reaches the log, and the log is owner-only", () => {
    process.env.ALTIMATE_DEBUG = "1"
    const secret = ["hun", "ter", "42"].join("")
    traceToolCall("warehouse_test", "c9")("error", `login failed: ${"pass" + "word"}=${secret} for snowflake://u:${secret}@acct`)
    const file = path.join(Global.Path.log, "opencode.log")
    const tail = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.includes("call=c9")).join("\n")
    expect(tail).toContain("tool end")
    expect(tail).not.toContain(secret)
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o077).toBe(0)
  })
})
// altimate_change end
