import { describe, expect, test } from "bun:test"
import { isStopRequest, untilStopped } from "../src/stop"
import { QueryTimeoutError } from "../src/types"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const never = () => new Promise<never>(() => {})

describe("untilStopped", () => {
  test("work that settles first is returned and nothing is stopped", async () => {
    const stops: string[] = []
    const outcome = await untilStopped(Promise.resolve(7), { deadlineMs: 1_000, onStop: (why) => stops.push(why) })
    expect(outcome).toEqual({ value: 7 })
    expect(stops).toEqual([])
  })

  test("a deadline stops the wait and calls onStop once", async () => {
    const stops: string[] = []
    const outcome = await untilStopped(never(), { deadlineMs: 10, onStop: (why) => stops.push(why) })
    expect(outcome).toEqual({ stopped: "deadline" })
    expect(stops).toEqual(["deadline"])
  })

  test("an abort stops the wait, with no deadline at all", async () => {
    const controller = new AbortController()
    const pending = untilStopped(never(), { signal: controller.signal })
    await sleep(5)
    controller.abort(new Error("stop"))
    expect(await pending).toEqual({ stopped: "aborted" })
  })

  test("an already-aborted signal stops at once", async () => {
    const controller = new AbortController()
    controller.abort(new Error("stop"))
    expect(await untilStopped(never(), { deadlineMs: 1_000, signal: controller.signal })).toEqual({ stopped: "aborted" })
  })

  test("an abort that stopsOnAbort declines is not a stop: the work is waited on to its end", async () => {
    const controller = new AbortController()
    const stops: string[] = []
    const work = sleep(30).then(() => 7)
    const pending = untilStopped(work, { signal: controller.signal, stopsOnAbort: () => false, onStop: (why) => stops.push(why) })
    await sleep(5)
    controller.abort(new Error("ignored"))
    expect(await pending).toEqual({ value: 7 })
    expect(stops).toEqual([])
  })

  test("a client-side query timeout is not a stop request; any other abort is", () => {
    // As `executeQuery` builds it when its own deadline passes.
    expect(isStopRequest(new QueryTimeoutError({ engine: "snowflake", timeoutMs: 120_000, cancelled: false }))).toBe(false)
    expect(isStopRequest(new Error("session stopped"))).toBe(true)
    expect(isStopRequest(new DOMException("The operation was aborted.", "AbortError"))).toBe(true)
  })

  test("work that fails after the stop does not go unhandled", async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown) => unhandled.push(error)
    process.on("unhandledRejection", onUnhandled)
    try {
      const late = sleep(20).then(() => Promise.reject(new Error("late")))
      expect(await untilStopped(late, { deadlineMs: 5 })).toEqual({ stopped: "deadline" })
      await sleep(40)
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  test("work that fails before any stop rejects with its own error and leaves no listener", async () => {
    const controller = new AbortController()
    let listeners = 0
    const add = controller.signal.addEventListener.bind(controller.signal)
    const remove = controller.signal.removeEventListener.bind(controller.signal)
    controller.signal.addEventListener = ((type: string, fn: never, options: never) => (listeners++, add(type, fn, options))) as never
    controller.signal.removeEventListener = ((type: string, fn: never) => (listeners--, remove(type, fn))) as never
    const error = await untilStopped(Promise.reject(new Error("query failed")), { deadlineMs: 1_000, signal: controller.signal }).catch(
      (e) => e,
    )
    expect(error.message).toBe("query failed")
    expect(listeners).toBe(0)
  })
})
