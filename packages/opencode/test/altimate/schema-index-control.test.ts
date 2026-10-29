import { describe, expect, test } from "bun:test"
import { DEFAULT_INDEX_TIMEOUT_MS, awaitIndex, withIndexSignal } from "../../src/altimate/native/schema/index-control"

const never = () => new Promise<never>(() => {})

describe("withIndexSignal", () => {
  test("defaults to a 30 second deadline", () => {
    expect(DEFAULT_INDEX_TIMEOUT_MS).toBe(30_000)
  })

  test("returns the work result and clears the deadline", async () => {
    let seen: AbortSignal | undefined
    const result = await withIndexSignal({ timeoutMs: 20 }, async (signal) => {
      seen = signal
      return "done"
    })
    expect(result).toBe("done")
    await Bun.sleep(40)
    expect(seen?.aborted).toBe(false)
  })

  test("aborts the signal with a TimeoutError after the deadline", async () => {
    let seen: AbortSignal | undefined
    const error = await withIndexSignal({ timeoutMs: 10 }, (signal) => {
      seen = signal
      return awaitIndex(signal, never)
    }).catch((e) => e)
    expect(seen?.aborted).toBe(true)
    expect(error).toBeInstanceOf(DOMException)
    expect(error.name).toBe("TimeoutError")
    expect(error.message).toBe("Schema indexing deadline exceeded.")
  })

  test("propagates a caller abort to the work signal", async () => {
    const parent = new AbortController()
    const reason = new Error("caller cancelled")
    const pending = withIndexSignal({ signal: parent.signal, timeoutMs: 10_000 }, (signal) => awaitIndex(signal, never))
    parent.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })

  test("does not abort the caller's signal on timeout", async () => {
    const parent = new AbortController()
    await withIndexSignal({ signal: parent.signal, timeoutMs: 10 }, (signal) => awaitIndex(signal, never)).catch(
      () => {},
    )
    expect(parent.signal.aborted).toBe(false)
  })
})

describe("awaitIndex", () => {
  test("returns the work result when not aborted", async () => {
    const controller = new AbortController()
    expect(await awaitIndex(controller.signal, async () => 42)).toBe(42)
  })

  test("rejects without starting work when the signal is already aborted", async () => {
    const controller = new AbortController()
    const reason = new Error("already aborted")
    controller.abort(reason)
    let started = false
    await expect(
      awaitIndex(controller.signal, async () => {
        started = true
        return 1
      }),
    ).rejects.toBe(reason)
    expect(started).toBe(false)
  })

  test("rejects with the abort reason while work is still running", async () => {
    const controller = new AbortController()
    const reason = new Error("stop")
    const pending = awaitIndex(controller.signal, never)
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })

  test("propagates work failures", async () => {
    const controller = new AbortController()
    const failure = new Error("index failed")
    await expect(
      awaitIndex(controller.signal, async () => {
        throw failure
      }),
    ).rejects.toBe(failure)
  })

  test("rejects when the signal aborts as the work resolves", async () => {
    const controller = new AbortController()
    const reason = new Error("late abort")
    await expect(
      awaitIndex(controller.signal, async () => {
        controller.abort(reason)
        return "late"
      }),
    ).rejects.toBe(reason)
  })
})
