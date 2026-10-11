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
    // spyOn without mockImplementation still calls through to the real track(), so this both
    // observes every event track() receives and leaves buffering/flush behavior untouched.
    const trackSpy = spyOn(Telemetry, "track")
    try {
      // First init: Config.get() throws (simulating the worker, pre-Instance-context) — proceeds enabled.
      await Telemetry.init()
      expect(configCalls).toBe(1)

      Telemetry.track(anchorEvent())
      await Telemetry.flush()
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1)

      // Restart the monitor with test-friendly timings and first prove it is actually live: this
      // makes the "stopped after disable" assertion below discriminate a real stop from a monitor
      // that was never running (or never would have fired) in the first place.
      Telemetry.stopLoopMonitor()
      Telemetry.startLoopMonitor({ intervalMs: 10, thresholdMs: 100 })
      blockFor(250)
      await new Promise((resolve) => setTimeout(resolve, 50))
      const liveStalls = trackSpy.mock.calls.filter(([e]) => e.type === "event_loop_stall")
      expect(liveStalls.length).toBeGreaterThanOrEqual(1)
      trackSpy.mockClear()

      // Second init (e.g. the prompt loop's, inside Instance context): config now readable and disabled.
      await Telemetry.init()
      expect(configCalls).toBe(2)

      fetchMock.mockClear()
      Telemetry.track(anchorEvent())
      await Telemetry.flush()
      expect(fetchMock).not.toHaveBeenCalled()

      // The loop monitor must actually be stopped, not merely have its events dropped by track():
      // a live timer would still reach this spy even though track() itself now drops the event.
      blockFor(250)
      await new Promise((resolve) => setTimeout(resolve, 50))
      const stalls = trackSpy.mock.calls.filter(([e]) => e.type === "event_loop_stall")
      expect(stalls).toHaveLength(0)
    } finally {
      trackSpy.mockRestore()
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

  test("config still unreadable on recheck keeps retrying", async () => {
    let configCalls = 0
    const configSpy = spyOn(Config as any, "get").mockImplementation(() => {
      configCalls++
      // Unreadable on the first two calls (initial doInit() and the first recheck); readable and
      // disabled on the third (the second recheck).
      if (configCalls <= 2) return Promise.reject(new Error("no Instance context yet"))
      return Promise.resolve({ telemetry: { disabled: true } })
    })
    const fetchMock = spyOn(global, "fetch").mockImplementation(
      (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
    )
    try {
      // First init: Config.get() throws — proceeds enabled, unverified.
      await Telemetry.init()
      expect(configCalls).toBe(1)

      // First recheck: still unreadable. configOptOutUnverified must stay true so a later init()
      // tries again instead of giving up after one failed recheck.
      await Telemetry.init()
      expect(configCalls).toBe(2)

      // Second recheck: now readable and disabled.
      await Telemetry.init()
      expect(configCalls).toBe(3)

      fetchMock.mockClear()
      Telemetry.track(anchorEvent())
      await Telemetry.flush()
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      configSpy.mockRestore()
      fetchMock.mockRestore()
    }
  })

  test("a stale recheck completing after shutdown + re-init does not clear the new generation's state", async () => {
    let configCalls = 0
    let resolveDeferred!: (value: unknown) => void
    const deferred = new Promise((resolve) => {
      resolveDeferred = resolve
    })
    const configSpy = spyOn(Config as any, "get").mockImplementation(() => {
      configCalls++
      // 1st call: generation 1's doInit() — unreadable, flags configOptOutUnverified.
      if (configCalls === 1) return Promise.reject(new Error("no Instance context yet"))
      // 2nd call: generation 1's recheck — held open under the test's control so it can be raced
      // against a shutdown + re-init below.
      if (configCalls === 2) return deferred
      // 3rd call: generation 2's own doInit() — readable and not disabled.
      return Promise.resolve({})
    })
    const fetchMock = spyOn(global, "fetch").mockImplementation(
      (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
    )
    try {
      // Generation 1: Config.get() throws — proceeds enabled, unverified.
      await Telemetry.init()
      expect(configCalls).toBe(1)

      // Starts generation 1's recheck. Its Config.get() is the controlled deferred above, so this
      // promise is intentionally left pending (not awaited) while generation 1 is torn down and
      // generation 2 spun up underneath it.
      const staleRecheck = Telemetry.init()
      // The recheck's Config.get() call happens inside a microtask chained off the already-settled
      // initPromise, not synchronously when init() is called — give it a tick to run.
      await Promise.resolve()
      await Promise.resolve()
      expect(configCalls).toBe(2)

      // Shut generation 1 down and bring generation 2 up while the stale recheck's Config.get() is
      // still pending. Generation 2's own Config.get() call resolves `{}` — readable, not disabled
      // — so generation 2 is enabled with a fresh buffer/timer/appInsights.
      await Telemetry.shutdown()
      await Telemetry.init()
      expect(configCalls).toBe(3)

      // Now let the stale recheck's Config.get() resolve with a disabling config. Without the
      // generation-token guard in recheckConfigOptOut(), this would go on to clear generation 2's
      // buffer/timer/appInsights/enabled flag as if it still described generation 1.
      resolveDeferred({ telemetry: { disabled: true } })
      await staleRecheck

      // Generation 2 must be unaffected: still enabled, with its buffer/timer/appInsights intact.
      fetchMock.mockClear()
      Telemetry.track(anchorEvent())
      await Telemetry.flush()
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1)
    } finally {
      configSpy.mockRestore()
      fetchMock.mockRestore()
    }
  })
})
// altimate_change end
