import { describe, test, expect } from "bun:test"
import { abortAfter, abortAfterAny } from "../../src/util/abort"

describe("abortAfter: timeout-based abort", () => {
  test("signal is not aborted immediately", () => {
    const { signal, clearTimeout } = abortAfter(5000)
    expect(signal.aborted).toBe(false)
    clearTimeout()
  })

  test("signal aborts after timeout", async () => {
    const { signal } = abortAfter(10)
    // Event-driven: wait for the abort event instead of guessing a wall-clock delay
    await Promise.race([
      new Promise<void>((r) => signal.addEventListener("abort", () => r())),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("abort did not fire within 500ms")), 500)),
    ])
    expect(signal.aborted).toBe(true)
  })

  test("clearTimeout prevents abort", async () => {
    // Use a very short timeout so waiting longer than it proves clearTimeout worked
    const { signal, clearTimeout: clear } = abortAfter(10)
    clear()
    // Wait well beyond the original timeout
    await new Promise((r) => setTimeout(r, 200))
    expect(signal.aborted).toBe(false)
  })
})

describe("abortAfterAny: composite signal", () => {
  test("aborts when external signal fires before timeout", () => {
    const ext = new AbortController()
    const { signal, clearTimeout } = abortAfterAny(5000, ext.signal)
    expect(signal.aborted).toBe(false)
    ext.abort()
    expect(signal.aborted).toBe(true)
    clearTimeout()
  })

  test("aborts on timeout when external signal is silent", async () => {
    const ext = new AbortController()
    const { signal } = abortAfterAny(10, ext.signal)
    // Event-driven: wait for the abort event
    await Promise.race([
      new Promise<void>((r) => signal.addEventListener("abort", () => r())),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("abort did not fire within 500ms")), 500)),
    ])
    expect(signal.aborted).toBe(true)
  })

  test("combines multiple external signals", () => {
    const a = new AbortController()
    const b = new AbortController()
    const { signal, clearTimeout } = abortAfterAny(5000, a.signal, b.signal)
    b.abort()
    expect(signal.aborted).toBe(true)
    clearTimeout()
  })
})
