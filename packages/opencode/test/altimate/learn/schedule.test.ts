// altimate_change - new file
import { describe, expect, test } from "bun:test"
import { IDLE_DEBOUNCE_MS, Scheduler, SIGNAL_THRESHOLD } from "../../../src/altimate/learn/schedule"
import type { Signal } from "../../../src/altimate/learn/signals"

type Options = ConstructorParameters<typeof Scheduler>[0]
type ReflectionOptions = Parameters<Options["reflect"]>[1]

function signal(sessionID: string, index = 1, status: Signal["status"] = "open"): Signal {
  return {
    id: `${sessionID}_${index}`,
    kind: "user_correction",
    sessionID,
    text: `Keep explicit columns ${index}.`,
    reason: "correction",
    at: "2026-09-30T12:00:00.000Z",
    status,
  }
}

function fakeClock() {
  let time = 1_000
  const timers = new Map<object, { at: number; callback: () => void; unreferenced: boolean }>()
  return {
    now: () => time,
    timers,
    setTimer(callback: () => void, delay: number) {
      const entry = { at: time + delay, callback, unreferenced: false }
      const handle = { unref: () => { entry.unreferenced = true } }
      timers.set(handle, entry)
      return handle
    },
    clearTimer(handle: object) { timers.delete(handle) },
    advance(ms: number) {
      const until = time + ms
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        time = next[1].at
        timers.delete(next[0])
        next[1].callback()
      }
      time = until
    },
  }
}

function fixture(signals: Signal[] = [], overrides: Partial<Options> = {}) {
  const clock = fakeClock()
  const calls: Array<{ sessionID: string; options: ReflectionOptions }> = []
  const operations: string[] = []
  const scheduler = new Scheduler({
    startupSignals: [],
    limits: { recovery_max_reflections: 3, recovery_max_seconds: 300 },
    listSignals: async () => {
      operations.push("list")
      return signals.filter((item) => item.status === "open")
    },
    flushCapture: async () => { operations.push("flush") },
    reflect: async (sessionID, options) => {
      calls.push({ sessionID, options })
      operations.push(`reflect:${sessionID}`)
      for (const item of signals) {
        if (item.sessionID === sessionID && (!options.signalIDs || options.signalIDs.includes(item.id)))
          item.status = "consumed"
      }
    },
    readState: async () => ({ recoveries: {} }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...overrides,
  })
  return { scheduler, clock, calls, operations, signals }
}

describe("reflection scheduler after a turn", () => {
  test("new activity resumes scheduling for a session drained by an earlier run", async () => {
    const f = fixture([signal("current", 1), signal("current", 2), signal("current", 3)])
    await f.scheduler.drainSession("current")
    f.scheduler.onActivity("current")
    f.scheduler.onIdle("current")
    await f.scheduler.settle()
    expect(f.calls.map((call) => call.sessionID)).toEqual(["current"])
    await f.scheduler.shutdown()
  })

  test("run exit waits only for its active reflection while queued startup recovery continues", async () => {
    const entered = Promise.withResolvers<ReflectionOptions>()
    const release = Promise.withResolvers<void>()
    const calls: string[] = []
    const startup = [signal("old")]
    const f = fixture([...startup, signal("current", 1), signal("current", 2), signal("current", 3)], {
      startupSignals: startup,
      reflect: async (sessionID, options) => {
        calls.push(sessionID)
        entered.resolve(options)
        await release.promise
      },
    })
    try {
      f.scheduler.onIdle("current")
      const options = await entered.promise
      const abort = new AbortController()
      const drained = f.scheduler.drainSession("current", abort.signal)
      expect(options.shouldContinue()).toBe(true)
      abort.abort()
      expect(options.abortSignal?.aborted).toBe(true)
      expect(options.shouldContinue()).toBe(false)
      release.resolve()
      await drained
      await f.scheduler.settle()
      expect(calls).toEqual(["current", "old"])
    } finally {
      release.resolve()
      await f.scheduler.shutdown()
    }
  })

  test("run exit leaves unrelated recovery running without waiting on its model", async () => {
    const entered = Promise.withResolvers<ReflectionOptions>()
    const release = Promise.withResolvers<void>()
    const startup = [signal("old"), signal("older")]
    const calls: string[] = []
    const f = fixture(startup, {
      startupSignals: startup,
      reflect: async (sessionID, options) => {
        calls.push(sessionID)
        entered.resolve(options)
        await release.promise
      },
    })
    try {
      f.scheduler.onIdle("current")
      const options = await entered.promise
      await f.scheduler.drainSession("current")
      expect(options.abortSignal?.aborted).toBe(false)
      expect(options.shouldContinue()).toBe(true)
      release.resolve()
      await f.scheduler.settle()
      expect(calls).toEqual(["old", "older"])
    } finally {
      release.resolve()
      await f.scheduler.shutdown()
    }
  })

  test("three open signals reflect only after idle and after capture drains", async () => {
    expect(SIGNAL_THRESHOLD).toBe(3)
    const f = fixture([signal("session", 1), signal("session", 2), signal("session", 3)])
    await f.scheduler.settle()
    expect(f.calls).toEqual([])
    expect(f.operations).toEqual([])

    f.scheduler.onIdle("session")
    await f.scheduler.settle()
    expect(f.calls.map((call) => call.sessionID)).toEqual(["session"])
    expect(f.operations.indexOf("flush")).toBeLessThan(f.operations.indexOf("list"))
    expect(f.operations.indexOf("list")).toBeLessThan(f.operations.indexOf("reflect:session"))
    await f.scheduler.shutdown()
  })

  test("awaits queued capture writes before counting the threshold", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const signals = [signal("session", 1), signal("session", 2)]
    const f = fixture(signals, {
      flushCapture: async () => {
        entered.resolve()
        await release.promise
        if (signals.length === 2) signals.push(signal("session", 3))
      },
    })
    try {
      f.scheduler.onIdle("session")
      await entered.promise
      expect(f.calls).toEqual([])
      release.resolve()
      await f.scheduler.settle()
      expect(f.calls.map((call) => call.sessionID)).toEqual(["session"])
    } finally {
      release.resolve()
      await f.scheduler.shutdown()
    }
  })

  test("counts only open signals for the session that became idle", async () => {
    const f = fixture([
      signal("session", 1), signal("session", 2, "consumed"), signal("session", 3, "consumed"),
      signal("other", 1), signal("other", 2), signal("other", 3),
    ])
    f.scheduler.onIdle("session")
    await f.scheduler.settle()
    expect(f.calls).toEqual([])
    f.clock.advance(IDLE_DEBOUNCE_MS)
    await f.scheduler.settle()
    expect(f.calls.map((call) => call.sessionID)).toEqual(["session"])
    await f.scheduler.shutdown()
  })

  test("debounces one signal for exactly ten minutes and unreferences its timer", async () => {
    expect(IDLE_DEBOUNCE_MS).toBe(10 * 60 * 1_000)
    const f = fixture([signal("session")])
    f.scheduler.onIdle("session")
    await f.scheduler.settle()
    expect(f.clock.timers.size).toBe(1)
    expect([...f.clock.timers.values()].every((timer) => timer.unreferenced)).toBe(true)
    f.clock.advance(IDLE_DEBOUNCE_MS - 1)
    await f.scheduler.settle()
    expect(f.calls).toEqual([])
    f.clock.advance(1)
    await f.scheduler.settle()
    expect(f.calls.map((call) => call.sessionID)).toEqual(["session"])
    await f.scheduler.shutdown()
  })

  test("threshold failure still gets an idle retry, while consumed signals never trigger another call", async () => {
    const signals = [signal("session", 1), signal("session", 2), signal("session", 3)]
    let calls = 0
    const f = fixture(signals, {
      reflect: async () => {
        calls++
        if (calls === 1) throw new Error("provider unavailable")
        for (const item of signals) item.status = "consumed"
      },
    })
    f.scheduler.onIdle("session")
    await f.scheduler.settle()
    expect(calls).toBe(1)
    f.clock.advance(IDLE_DEBOUNCE_MS)
    await f.scheduler.settle()
    expect(calls).toBe(2)
    f.scheduler.onIdle("session")
    await f.scheduler.settle()
    f.clock.advance(IDLE_DEBOUNCE_MS)
    await f.scheduler.settle()
    expect(calls).toBe(2)
    await f.scheduler.shutdown()
  })

  test("new activity cancels only that session's debounce until another idle", async () => {
    const f = fixture([signal("session"), signal("other")])
    f.scheduler.onIdle("session")
    f.scheduler.onIdle("other")
    await f.scheduler.settle()
    f.clock.advance(IDLE_DEBOUNCE_MS / 2)
    f.scheduler.onActivity("session")
    f.clock.advance(IDLE_DEBOUNCE_MS / 2)
    await f.scheduler.settle()
    expect(f.calls.map((call) => call.sessionID)).toEqual(["other"])
    f.scheduler.onIdle("session")
    await f.scheduler.settle()
    f.clock.advance(IDLE_DEBOUNCE_MS - 1)
    await f.scheduler.settle()
    expect(f.calls.map((call) => call.sessionID)).toEqual(["other"])
    f.clock.advance(1)
    await f.scheduler.settle()
    expect(f.calls.map((call) => call.sessionID)).toEqual(["other", "session"])
    await f.scheduler.shutdown()
  })

  test("activity during capture drain prevents a stale idle from starting a model call", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const f = fixture([signal("session", 1), signal("session", 2), signal("session", 3)], {
      flushCapture: async () => { entered.resolve(); await release.promise },
    })
    try {
      f.scheduler.onIdle("session")
      await entered.promise
      f.scheduler.onActivity("session")
      release.resolve()
      await f.scheduler.settle()
      expect(f.calls).toEqual([])
      expect(f.clock.timers.size).toBe(0)
    } finally {
      release.resolve()
      await f.scheduler.shutdown()
    }
  })

  test("queues independent sessions without blocking idle handlers or overlapping reflections", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const calls: string[] = []
    let running = 0
    let maximum = 0
    const f = fixture([
      signal("first", 1), signal("first", 2), signal("first", 3),
      signal("second", 1), signal("second", 2), signal("second", 3),
    ], {
      reflect: async (sessionID) => {
        calls.push(sessionID)
        maximum = Math.max(maximum, ++running)
        if (sessionID === "first") {
          entered.resolve()
          await release.promise
        }
        running--
      },
    })
    try {
      expect(f.scheduler.onIdle("first")).toBeUndefined()
      await entered.promise
      expect(f.scheduler.onIdle("second")).toBeUndefined()
      await Promise.resolve()
      expect(calls).toEqual(["first"])
      release.resolve()
      await f.scheduler.settle()
      expect(calls).toEqual(["first", "second"])
      expect(maximum).toBe(1)
    } finally {
      release.resolve()
      await f.scheduler.shutdown()
      await f.scheduler.settle()
    }
  })
})

describe("reflection scheduler shutdown", () => {
  test("exit clears debounce and flushes capture without starting any reflection", async () => {
    const f = fixture([signal("session")], { startupSignals: [signal("old")] })
    await f.scheduler.shutdown()
    expect(f.operations).toEqual(["flush"])
    expect(f.calls).toEqual([])
    f.scheduler.onIdle("session")
    f.clock.advance(IDLE_DEBOUNCE_MS)
    await f.scheduler.settle()
    expect(f.calls).toEqual([])
    expect(f.clock.timers.size).toBe(0)
  })

  test("disposal cancels an already scheduled timer", async () => {
    const f = fixture([signal("session")])
    f.scheduler.onIdle("session")
    await f.scheduler.settle()
    expect(f.clock.timers.size).toBe(1)
    const flushes = f.operations.filter((operation) => operation === "flush").length
    await f.scheduler.shutdown()
    expect(f.operations.filter((operation) => operation === "flush")).toHaveLength(flushes + 1)
    expect(f.clock.timers.size).toBe(0)
    f.clock.advance(IDLE_DEBOUNCE_MS)
    await f.scheduler.settle()
    expect(f.calls).toEqual([])
  })

  test("does not wait for an in-flight model and invalidates its continuation", async () => {
    const entered = Promise.withResolvers<ReflectionOptions>()
    const release = Promise.withResolvers<void>()
    const f = fixture([signal("session", 1), signal("session", 2), signal("session", 3)], {
      reflect: async (_sessionID, options) => { entered.resolve(options); await release.promise },
    })
    try {
      f.scheduler.onIdle("session")
      const options = await entered.promise
      expect(options.shouldContinue()).toBe(true)
      await f.scheduler.shutdown()
      expect(options.shouldContinue()).toBe(false)
      expect(f.operations.filter((operation) => operation === "flush").length).toBeGreaterThanOrEqual(2)
    } finally {
      release.resolve()
      await f.scheduler.settle()
    }
  })

  test("shutdown while capture drains cannot launch a queued reflection", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const f = fixture([signal("session", 1), signal("session", 2), signal("session", 3)], {
      flushCapture: async () => { entered.resolve(); await release.promise },
    })
    f.scheduler.onIdle("session")
    await entered.promise
    const shutdown = f.scheduler.shutdown()
    release.resolve()
    await shutdown
    await f.scheduler.settle()
    expect(f.calls).toEqual([])
    expect(f.clock.timers.size).toBe(0)
  })
})

describe("startup recovery", () => {
  test("waits for first idle, skips current and busy sessions, and uses only startup signal IDs", async () => {
    const startup = [signal("older"), signal("busy"), signal("current")]
    const f = fixture([...startup, signal("older", 2), signal("new")], { startupSignals: [...startup] })
    f.scheduler.onActivity("busy")
    await f.scheduler.settle()
    expect(f.calls).toEqual([])
    f.scheduler.onIdle("current")
    await f.scheduler.settle()
    expect(f.calls.map((call) => call.sessionID)).toEqual(["older"])
    expect(f.calls[0].options.signalIDs).toEqual(["older_1"])
    expect(f.signals.find((item) => item.id === "older_2")?.status).toBe("open")
    await f.scheduler.shutdown()
  })

  test("does not recover a signal consumed since startup", async () => {
    const startup = [signal("old")]
    const f = fixture([signal("old", 1, "consumed")], { startupSignals: startup })
    f.scheduler.onIdle("current")
    await f.scheduler.settle()
    expect(f.calls).toEqual([])
    await f.scheduler.shutdown()
  })

  test("bounds recovery reflections across later idle events", async () => {
    const startup = [signal("old1"), signal("old2"), signal("old3"), signal("old4")]
    const f = fixture(startup, {
      startupSignals: [...startup],
      limits: { recovery_max_reflections: 2, recovery_max_seconds: 300 },
    })
    f.scheduler.onIdle("current")
    await f.scheduler.settle()
    expect(f.calls.map((call) => call.sessionID)).toEqual(["old1", "old2"])
    f.scheduler.onIdle("current")
    await f.scheduler.settle()
    expect(f.calls).toHaveLength(2)
    await f.scheduler.shutdown()
  })

  test("starts the recovery time budget at first idle and stops at the deadline", async () => {
    const startup = [signal("old1"), signal("old2"), signal("old3")]
    const calls: Array<{ sessionID: string; options: ReflectionOptions }> = []
    const f = fixture(startup, {
      startupSignals: [...startup],
      limits: { recovery_max_reflections: 3, recovery_max_seconds: 5 },
      reflect: async (sessionID, options) => {
        calls.push({ sessionID, options })
        expect(options.shouldContinue()).toBe(true)
        f.clock.advance(5_000)
        expect(options.shouldContinue()).toBe(false)
      },
    })
    f.clock.advance(60_000)
    f.scheduler.onIdle("current")
    await f.scheduler.settle()
    expect(calls.map((call) => call.sessionID)).toEqual(["old1"])
    expect(calls[0].options.deadline).toBe(66_000)
    await f.scheduler.shutdown()
  })

  test("respects persisted failure backoff while recovering eligible sessions", async () => {
    const startup = [signal("backoff"), signal("ready"), signal("expired")]
    const f = fixture(startup, {
      startupSignals: [...startup],
      readState: async () => ({ recoveries: {
        backoff: { failures: 3, retryAt: 10_000 },
        expired: { failures: 1, retryAt: 1_000 },
      } }),
    })
    f.scheduler.onIdle("current")
    await f.scheduler.settle()
    expect(f.calls.map((call) => call.sessionID)).toEqual(["ready", "expired"])
    expect(f.signals.find((item) => item.sessionID === "backoff")?.status).toBe("open")
    await f.scheduler.shutdown()
  })

  test("a failed recovery does not block the next session or evade the attempt limit", async () => {
    const startup = [signal("fails"), signal("succeeds"), signal("later")]
    const calls: string[] = []
    const f = fixture(startup, {
      startupSignals: [...startup],
      limits: { recovery_max_reflections: 2, recovery_max_seconds: 300 },
      reflect: async (sessionID) => {
        calls.push(sessionID)
        if (sessionID === "fails") throw new Error("model unavailable")
      },
    })
    f.scheduler.onIdle("current")
    await f.scheduler.settle()
    expect(calls).toEqual(["fails", "succeeds"])
    await f.scheduler.shutdown()
  })
})
