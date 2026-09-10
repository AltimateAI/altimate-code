// altimate_change start — first-run health telemetry: startup_ready, event_loop_stall, anchor flush.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Telemetry } from "../../../src/altimate/telemetry"
import { Config } from "@/config/config"

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

// altimate_change start — config opt-out recheck: the TUI server worker's init() runs before this
// thread has Instance context, so Config.get() throws and doInit() proceeds enabled, flagging
// configOptOutUnverified. A later init() call made inside Instance context (the prompt loop's) must
// re-read config and retroactively honor a config-file opt-out instead of never checking again.
describe("first-run health telemetry — config opt-out recheck", () => {
  let origDisabledEnv: string | undefined
  let origDisableAlt: string | undefined
  let origCs: string | undefined

  beforeEach(() => {
    origDisabledEnv = process.env.ALTIMATE_TELEMETRY_DISABLED
    origDisableAlt = process.env.OPENCODE_DISABLE_TELEMETRY
    origCs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
    delete process.env.ALTIMATE_TELEMETRY_DISABLED
    delete process.env.OPENCODE_DISABLE_TELEMETRY
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
      "InstrumentationKey=recheck-key;IngestionEndpoint=https://example.com"
  })

  afterEach(async () => {
    await Telemetry.shutdown()
    Telemetry.resetFirstRunStateForTest()
    if (origDisabledEnv === undefined) delete process.env.ALTIMATE_TELEMETRY_DISABLED
    else process.env.ALTIMATE_TELEMETRY_DISABLED = origDisabledEnv
    if (origDisableAlt === undefined) delete process.env.OPENCODE_DISABLE_TELEMETRY
    else process.env.OPENCODE_DISABLE_TELEMETRY = origDisableAlt
    if (origCs === undefined) delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
    else process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = origCs
  })

  // is_upgrade: true so this never flips the freshInstall latch — irrelevant to these tests and
  // would otherwise leak across them via module state.
  function anchorEvent(): Telemetry.Event {
    return {
      type: "first_launch",
      timestamp: Date.now(),
      session_id: "recheck-session",
      version: "0.0.0-test",
      is_upgrade: true,
      install_method: "unknown",
    }
  }

  test("config unreadable at first init enables telemetry; config-disable on recheck stops flushing and the loop monitor", async () => {
    let configCalls = 0
    const configSpy = spyOn(Config as any, "get").mockImplementation(() => {
      configCalls++
      if (configCalls === 1) return Promise.reject(new Error("no Instance context yet"))
      return Promise.resolve({ telemetry: { disabled: true } })
    })
    const fetchMock = spyOn(global, "fetch").mockImplementation(
      (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
    )
    try {
      // First init: Config.get() throws (simulating the worker, pre-Instance-context) — proceeds enabled.
      await Telemetry.init()
      expect(configCalls).toBe(1)

      Telemetry.track(anchorEvent())
      await Telemetry.flush()
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1)

      // Second init (e.g. the prompt loop's, inside Instance context): config now readable and disabled.
      await Telemetry.init()
      expect(configCalls).toBe(2)

      fetchMock.mockClear()
      Telemetry.track(anchorEvent())
      await Telemetry.flush()
      expect(fetchMock).not.toHaveBeenCalled()

      // The loop monitor must actually be stopped, not merely have its events dropped by track():
      // spyOn without mockImplementation still calls through to the real track(), so a live timer
      // would still reach this spy even though track() itself now drops the event.
      const trackSpy = spyOn(Telemetry, "track")
      const until = performance.now() + 150
      while (performance.now() < until) {
        // Deliberately synchronous block.
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
      const stalls = trackSpy.mock.calls.filter(([e]) => e.type === "event_loop_stall")
      expect(stalls).toHaveLength(0)
      trackSpy.mockRestore()
    } finally {
      configSpy.mockRestore()
      fetchMock.mockRestore()
    }
  })

  test("config unreadable at first init, then readable and not disabled: stays enabled and does not re-check again", async () => {
    let configCalls = 0
    const configSpy = spyOn(Config as any, "get").mockImplementation(() => {
      configCalls++
      if (configCalls === 1) return Promise.reject(new Error("no Instance context yet"))
      return Promise.resolve({ telemetry: { disabled: false } })
    })
    const fetchMock = spyOn(global, "fetch").mockImplementation(
      (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
    )
    try {
      await Telemetry.init()
      expect(configCalls).toBe(1)

      await Telemetry.init() // recheck: config readable, not disabled
      expect(configCalls).toBe(2)

      await Telemetry.init() // configOptOutUnverified is now false — must not call Config.get again
      expect(configCalls).toBe(2)

      fetchMock.mockClear()
      Telemetry.track(anchorEvent())
      await Telemetry.flush()
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1)
    } finally {
      configSpy.mockRestore()
      fetchMock.mockRestore()
    }
  })

  test("config readable and disabled at first init: existing behavior unchanged, no recheck needed", async () => {
    const configSpy = spyOn(Config as any, "get").mockImplementation(() =>
      Promise.resolve({ telemetry: { disabled: true } }),
    )
    const fetchMock = spyOn(global, "fetch").mockImplementation(
      (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
    )
    try {
      // Pre-init event is buffered, then cleared by doInit()'s disabled branch.
      Telemetry.track(anchorEvent())
      await Telemetry.init()
      expect(configSpy.mock.calls.length).toBe(1)

      Telemetry.track(anchorEvent())
      await Telemetry.flush()
      expect(fetchMock).not.toHaveBeenCalled()

      // configOptOutUnverified was never set (config was readable on the first try), so a second
      // init() must not trigger a recheck.
      await Telemetry.init()
      expect(configSpy.mock.calls.length).toBe(1)
    } finally {
      configSpy.mockRestore()
      fetchMock.mockRestore()
    }
  })
})
// altimate_change end
