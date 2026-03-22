import { describe, test, expect } from "bun:test"
import { signal } from "../../src/util/signal"

describe("signal", () => {
  test("wait() resolves after trigger()", async () => {
    const s = signal()
    let resolved = false
    const waiting = s.wait().then(() => {
      resolved = true
    })
    expect(resolved).toBe(false)
    s.trigger()
    await waiting
    expect(resolved).toBe(true)
  })

  test("trigger() before wait() still resolves immediately", async () => {
    // Race condition guard: trigger fires before anyone awaits
    const s = signal()
    s.trigger()
    let resolved = false
    await s.wait().then(() => {
      resolved = true
    })
    expect(resolved).toBe(true)
  })

  test("multiple wait() calls on same signal all resolve", async () => {
    const s = signal()
    let count = 0
    const waiters = [
      s.wait().then(() => count++),
      s.wait().then(() => count++),
      s.wait().then(() => count++),
    ]
    s.trigger()
    await Promise.all(waiters)
    expect(count).toBe(3)
  })
})
