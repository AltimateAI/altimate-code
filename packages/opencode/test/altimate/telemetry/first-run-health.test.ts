// altimate_change start — first-run health telemetry: startup_ready, event_loop_stall, anchor flush.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Telemetry } from "../../../src/altimate/telemetry"

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function blockFor(ms: number) {
  const until = performance.now() + ms
  while (performance.now() < until) {
    // Deliberately synchronous: this is the condition the monitor exists to detect.
  }
}

describe("first-run health telemetry", () => {
  // setCommand publishes ALTIMATE_CLI_COMMAND for worker threads; restore it so later suites in the
  // same process (and resetFirstRunStateForTest, which reads it back) see the original value.
  let savedCommand: string | undefined
  beforeEach(() => {
    savedCommand = process.env.ALTIMATE_CLI_COMMAND
  })
  afterEach(() => {
    if (savedCommand === undefined) delete process.env.ALTIMATE_CLI_COMMAND
    else process.env.ALTIMATE_CLI_COMMAND = savedCommand
    Telemetry.resetFirstRunStateForTest()
  })

  test("startup_ready is emitted once per process with the command and process uptime", () => {
    const events: Telemetry.Event[] = []
    const spy = spyOn(Telemetry, "track").mockImplementation((event) => {
      events.push(event)
    })
    try {
      Telemetry.setCommand("serve")
      Telemetry.startupReady()
      Telemetry.startupReady("run")
      const ready = events.filter((e) => e.type === "startup_ready")
      expect(ready).toHaveLength(1)
      const event = ready[0] as Extract<Telemetry.Event, { type: "startup_ready" }>
      expect(event.command).toBe("serve")
      expect(event.duration_ms).toBeGreaterThan(0)
      expect(typeof event.fresh_install).toBe("boolean")
      expect(Telemetry.getCommand()).toBe("serve")
    } finally {
      spy.mockRestore()
    }
  })

  test("loopStallFor reports only lags beyond the threshold", () => {
    expect(Telemetry.loopStallFor(1_000, 900, 500, "main")).toBeUndefined()
    const stall = Telemetry.loopStallFor(2_000, 500, 1_000, "worker")
    expect(stall?.type).toBe("event_loop_stall")
    if (stall?.type !== "event_loop_stall") throw new Error("unreachable")
    expect(stall.blocked_ms).toBe(1_500)
    expect(stall.since_start_ms).toBe(2_000)
    expect(stall.thread).toBe("worker")
  })

  test("the loop monitor emits event_loop_stall after a synchronous block", async () => {
    const events: Telemetry.Event[] = []
    const spy = spyOn(Telemetry, "track").mockImplementation((event) => {
      events.push(event)
    })
    try {
      Telemetry.startLoopMonitor({ intervalMs: 10, thresholdMs: 100 })
      await sleep(40)
      // No "stays quiet" assertion here: a scheduler pause on a loaded CI runner is a real stall
      // and the monitor would be right to report it.
      blockFor(250)
      await sleep(60)
      const stalls = events.filter((e) => e.type === "event_loop_stall") as Extract<
        Telemetry.Event,
        { type: "event_loop_stall" }
      >[]
      expect(stalls.length).toBeGreaterThanOrEqual(1)
      expect(stalls[0].blocked_ms).toBeGreaterThanOrEqual(100)
      expect(stalls[0].thread).toBe("main")
      expect(stalls[0].since_start_ms).toBeGreaterThan(0)
    } finally {
      spy.mockRestore()
    }
  })

  test("startLoopMonitor is idempotent and stopLoopMonitor clears the timer", async () => {
    const events: Telemetry.Event[] = []
    const spy = spyOn(Telemetry, "track").mockImplementation((event) => {
      events.push(event)
    })
    try {
      Telemetry.startLoopMonitor({ intervalMs: 10, thresholdMs: 30 })
      Telemetry.startLoopMonitor({ intervalMs: 10, thresholdMs: 30 })
      Telemetry.stopLoopMonitor()
      blockFor(80)
      await sleep(40)
      expect(events.filter((e) => e.type === "event_loop_stall")).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })
})
// altimate_change end
