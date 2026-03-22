import { describe, test, expect } from "bun:test"
import { signal } from "../../src/util/signal"

describe("signal: trigger/wait coordination", () => {
  test("wait() resolves after trigger() is called", async () => {
    const s = signal()
    let resolved = false
    const p = s.wait().then(() => {
      resolved = true
    })
    expect(resolved).toBe(false)
    s.trigger()
    await p
    expect(resolved).toBe(true)
  })

  test("trigger() before wait() — promise already resolved", async () => {
    const s = signal()
    s.trigger()
    // wait() returns the same already-resolved promise, so this should not hang
    const result = await Promise.race([
      s.wait().then(() => "ok"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 200)),
    ])
    expect(result).toBe("ok")
  })
})
