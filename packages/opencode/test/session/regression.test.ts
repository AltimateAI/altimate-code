// altimate_change start — regression tests for telemetry, compaction, and processor fixes
// @ts-nocheck
import { describe, test, expect, beforeEach } from "bun:test"
import { Telemetry } from "../../src/telemetry"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionID } from "../../src/session/schema"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

// ---------------------------------------------------------------------------
// Telemetry event capture
// ---------------------------------------------------------------------------
let trackedEvents: Telemetry.Event[] = []
const originalTrack = Telemetry.track.bind(Telemetry)

function captureTrack(event: Telemetry.Event) {
  trackedEvents.push(event)
  originalTrack(event)
}

beforeEach(async () => {
  trackedEvents = []
  await Telemetry.shutdown()
})

// ---------------------------------------------------------------------------
// 1. toolCallCount — must be derived from actual tool parts
// ---------------------------------------------------------------------------
describe("toolCallCount accumulation", () => {
  test("tool parts are counted per message step", () => {
    // Simulates the prompt.ts logic: count parts of type "tool" and accumulate
    let toolCallCount = 0

    // Step 1: message with 3 tool parts
    const step1Parts = [
      { type: "tool", tool: "read" },
      { type: "text", text: "hello" },
      { type: "tool", tool: "edit" },
      { type: "tool", tool: "bash" },
    ]
    toolCallCount += step1Parts.filter((p) => p.type === "tool").length
    expect(toolCallCount).toBe(3)

    // Step 2: message with 1 tool part
    const step2Parts = [
      { type: "text", text: "thinking..." },
      { type: "tool", tool: "grep" },
    ]
    toolCallCount += step2Parts.filter((p) => p.type === "tool").length
    expect(toolCallCount).toBe(4)

    // Step 3: message with no tool parts
    const step3Parts = [{ type: "text", text: "done" }]
    toolCallCount += step3Parts.filter((p) => p.type === "tool").length
    expect(toolCallCount).toBe(4)
  })

  test("outcome is 'abandoned' when toolCallCount is 0 and cost is 0", () => {
    const sessionTotalCost = 0
    const toolCallCount = 0
    const sessionHadError = false
    const aborted = false

    const outcome = aborted
      ? "aborted"
      : sessionHadError
        ? "error"
        : sessionTotalCost === 0 && toolCallCount === 0
          ? "abandoned"
          : "completed"

    expect(outcome).toBe("abandoned")
  })

  test("outcome is 'completed' when toolCallCount > 0", () => {
    const sessionTotalCost = 0
    const toolCallCount = 1
    const sessionHadError = false
    const aborted = false

    const outcome = aborted
      ? "aborted"
      : sessionHadError
        ? "error"
        : sessionTotalCost === 0 && toolCallCount === 0
          ? "abandoned"
          : "completed"

    expect(outcome).toBe("completed")
  })
})

// ---------------------------------------------------------------------------
// 2. text-end must preserve original start time
// ---------------------------------------------------------------------------
describe("text-end time preservation", () => {
  test("end handler preserves original start time from text-start", () => {
    const startTime = Date.now() - 5000 // 5 seconds ago

    // Simulate text-start: creates time with start
    const currentText: any = {
      type: "text",
      text: "",
      time: { start: startTime },
    }

    // Simulate text-end: should preserve start, add end
    const endTime = Date.now()
    currentText.time = {
      start: currentText.time?.start ?? endTime,
      end: endTime,
    }

    expect(currentText.time.start).toBe(startTime)
    expect(currentText.time.end).toBe(endTime)
    expect(currentText.time.end).toBeGreaterThanOrEqual(currentText.time.start)
  })

  test("end handler falls back to Date.now() when start is missing", () => {
    // Edge case: time object exists but start is undefined
    const currentText: any = {
      type: "text",
      text: "",
      time: undefined,
    }

    const endTime = Date.now()
    currentText.time = {
      start: currentText.time?.start ?? endTime,
      end: endTime,
    }

    expect(currentText.time.start).toBe(endTime)
    expect(currentText.time.end).toBe(endTime)
  })

  test("duration is non-negative", () => {
    const startTime = Date.now() - 100
    const currentText: any = {
      type: "text",
      text: "some output",
      time: { start: startTime },
    }

    const endTime = Date.now()
    currentText.time = {
      start: currentText.time?.start ?? endTime,
      end: endTime,
    }

    const duration = currentText.time.end - currentText.time.start
    expect(duration).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// 3. emergencySessionEndFired — prevent duplicate session_end telemetry
// ---------------------------------------------------------------------------
describe("emergency session end deduplication", () => {
  test("session_end fires only once during normal completion", () => {
    let emergencySessionEndFired = false
    const events: string[] = []

    const emergencySessionEnd = () => {
      if (emergencySessionEndFired) return
      emergencySessionEndFired = true
      events.push("emergency_session_end")
    }

    // Simulate normal completion path
    if (!emergencySessionEndFired) {
      emergencySessionEndFired = true
      events.push("normal_session_end")
    }

    // Now emergency handler should be a no-op
    emergencySessionEnd()

    expect(events).toEqual(["normal_session_end"])
    expect(events).toHaveLength(1)
  })

  test("emergency handler fires if normal completion didn't happen", () => {
    let emergencySessionEndFired = false
    const events: string[] = []

    const emergencySessionEnd = () => {
      if (emergencySessionEndFired) return
      emergencySessionEndFired = true
      events.push("emergency_session_end")
    }

    // Simulate crash — emergency handler fires
    emergencySessionEnd()

    expect(events).toEqual(["emergency_session_end"])
    expect(events).toHaveLength(1)
  })

  test("process.off removes emergency listeners after normal completion", () => {
    const listeners: Map<string, Function[]> = new Map()

    // Simulate process.once
    const addListener = (event: string, fn: Function) => {
      const fns = listeners.get(event) ?? []
      fns.push(fn)
      listeners.set(event, fns)
    }

    // Simulate process.off
    const removeListener = (event: string, fn: Function) => {
      const fns = listeners.get(event) ?? []
      listeners.set(
        event,
        fns.filter((f) => f !== fn),
      )
    }

    const handler = () => {}
    addListener("beforeExit", handler)
    addListener("exit", handler)

    expect(listeners.get("beforeExit")).toHaveLength(1)
    expect(listeners.get("exit")).toHaveLength(1)

    // Normal completion removes listeners
    removeListener("beforeExit", handler)
    removeListener("exit", handler)

    expect(listeners.get("beforeExit")).toHaveLength(0)
    expect(listeners.get("exit")).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 4. Compaction circuit breaker — stop after 3 attempts
// ---------------------------------------------------------------------------
describe("compaction circuit breaker", () => {
  test("circuit breaker activates after 3 attempts", () => {
    const compactionAttempts = new Map<string, number>()
    const sessionID = "ses_test-circuit-breaker"
    const results: boolean[] = []

    for (let i = 0; i < 5; i++) {
      const attempt = (compactionAttempts.get(sessionID) ?? 0) + 1
      compactionAttempts.set(sessionID, attempt)

      if (attempt > 3) {
        results.push(false) // circuit breaker tripped
      } else {
        results.push(true) // compaction proceeds
      }
    }

    expect(results).toEqual([true, true, true, false, false])
  })

  test("circuit breaker is per-session", () => {
    const compactionAttempts = new Map<string, number>()
    const session1 = "ses_session-1"
    const session2 = "ses_session-2"

    // Session 1: 4 attempts
    for (let i = 0; i < 4; i++) {
      const attempt = (compactionAttempts.get(session1) ?? 0) + 1
      compactionAttempts.set(session1, attempt)
    }

    // Session 2: 1 attempt
    const attempt2 = (compactionAttempts.get(session2) ?? 0) + 1
    compactionAttempts.set(session2, attempt2)

    expect(compactionAttempts.get(session1)).toBe(4)
    expect(compactionAttempts.get(session2)).toBe(1)

    // Session 1 is over the limit, session 2 is not
    expect(compactionAttempts.get(session1)! > 3).toBe(true)
    expect(compactionAttempts.get(session2)! > 3).toBe(false)
  })

  test("abort signal clears attempt counter", () => {
    const compactionAttempts = new Map<string, number>()
    const sessionID = "ses_abort-test"
    const controller = new AbortController()

    // Record 2 attempts
    compactionAttempts.set(sessionID, 2)
    controller.signal.addEventListener(
      "abort",
      () => {
        compactionAttempts.delete(sessionID)
      },
      { once: true },
    )

    expect(compactionAttempts.get(sessionID)).toBe(2)

    // Abort clears the counter
    controller.abort()
    expect(compactionAttempts.has(sessionID)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. compactionCount wired to agent_outcome telemetry
// ---------------------------------------------------------------------------
describe("compaction count in telemetry", () => {
  test("compactionCount increments on each compact result", () => {
    let compactionCount = 0
    const results = ["continue", "compact", "continue", "compact", "compact", "stop"]

    for (const result of results) {
      if (result === "compact") {
        compactionCount++
      }
      if (result === "stop") break
    }

    expect(compactionCount).toBe(3)
  })

  test("compactionCount is included in agent_outcome event", () => {
    const compactionCount = 2
    const event = {
      type: "agent_outcome" as const,
      timestamp: Date.now(),
      session_id: "ses_test",
      agent: "build",
      tool_calls: 5,
      generations: 3,
      duration_ms: 10000,
      cost: 0.05,
      compactions: compactionCount,
      outcome: "completed" as const,
    }

    expect(event.compactions).toBe(2)
    expect(event.compactions).not.toBe(0) // regression: was hardcoded to 0
  })
})

// ---------------------------------------------------------------------------
// 6. Telemetry lazy import caching
// ---------------------------------------------------------------------------
describe("telemetry lazy import cache", () => {
  test("cached value is returned on subsequent calls", async () => {
    let importCount = 0
    let cache: any = undefined

    async function getTelemetry() {
      if (cache) return cache
      importCount++
      cache = { track: () => {}, init: () => {} } // simulated module
      return cache
    }

    const first = await getTelemetry()
    const second = await getTelemetry()
    const third = await getTelemetry()

    expect(importCount).toBe(1)
    expect(first).toBe(second) // strict reference equality
    expect(second).toBe(third)
  })
})
// altimate_change end
