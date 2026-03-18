import { describe, test, expect, beforeEach } from "bun:test"
import { bufferLog, getRecentDbtLogs, clearDbtLogs } from "../src/log-buffer"

describe("dbt log buffer", () => {
  beforeEach(() => {
    clearDbtLogs()
  })

  test("starts empty", () => {
    expect(getRecentDbtLogs()).toEqual([])
  })

  test("buffers log messages", () => {
    bufferLog("[dbt] compiling model")
    bufferLog("[dbt:warn] deprecation notice")
    expect(getRecentDbtLogs()).toEqual([
      "[dbt] compiling model",
      "[dbt:warn] deprecation notice",
    ])
  })

  test("returns a copy, not a reference", () => {
    bufferLog("test")
    const logs = getRecentDbtLogs()
    logs.push("injected")
    expect(getRecentDbtLogs()).toEqual(["test"])
  })

  test("caps at 100 entries (FIFO)", () => {
    for (let i = 0; i < 120; i++) {
      bufferLog(`msg-${i}`)
    }
    const logs = getRecentDbtLogs()
    expect(logs.length).toBe(100)
    expect(logs[0]).toBe("msg-20")
    expect(logs[99]).toBe("msg-119")
  })

  test("never exceeds buffer size", () => {
    for (let i = 0; i < 200; i++) {
      bufferLog(`msg-${i}`)
      // Buffer should never exceed 100 entries at any point
      expect(getRecentDbtLogs().length).toBeLessThanOrEqual(100)
    }
  })

  test("clearDbtLogs empties the buffer", () => {
    bufferLog("a")
    bufferLog("b")
    clearDbtLogs()
    expect(getRecentDbtLogs()).toEqual([])
  })

  test("can buffer again after clearing", () => {
    bufferLog("old")
    clearDbtLogs()
    bufferLog("new")
    expect(getRecentDbtLogs()).toEqual(["new"])
  })
})
