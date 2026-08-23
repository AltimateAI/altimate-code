import { describe, expect, test, beforeEach, mock } from "bun:test"
import * as Dispatcher from "../../src/altimate/native/dispatcher"

// No telemetry disable needed — Dispatcher.call already wraps every
// Telemetry.track call in try/catch that swallows all errors, so telemetry
// firing during a test cannot fail the test. The previous env-var
// mutation was defensive against nothing and wasn't parallel-safe (issue
// #1130 — https://github.com/AltimateAI/altimate-code/issues/1130).
//
// Concurrency contract: the ``Dispatcher`` module is a process-wide
// singleton (``nativeHandlers`` Map, ``_ensureRegistered`` hook). These
// tests intentionally mutate that singleton via ``Dispatcher.reset()``
// and ``Dispatcher.setRegistrationHook()``. This is safe under bun's
// DEFAULT behaviour of running test files sequentially in one process,
// but NOT parallel-safe if the runner is later flipped to ``--concurrency
// N``. Isolating the dispatcher would require an instance-per-test
// refactor across the whole module; deferred as a broader tech-debt
// task (issue #1130 tracks the parallel-safety cleanup for this + the
// sibling release-adversarial file). Same class of finding as the
// env-var mutation coderabbit flagged.

describe("Dispatcher", () => {
  beforeEach(() => {
    Dispatcher.reset()
    // Clear lazy registration hook to prevent other test files' imports
    // from triggering handler registration during these unit tests.
    // Without this, Bun's multi-file runner leaks the hook from files
    // that import native/index.ts, causing call() to resolve instead
    // of rejecting for unregistered methods.
    Dispatcher.setRegistrationHook(null as any)
  })

  describe("register and hasNativeHandler", () => {
    test("registers a handler and reports it exists", () => {
      expect(Dispatcher.hasNativeHandler("ping")).toBe(false)
      Dispatcher.register("ping", async () => ({ status: "ok" }))
      expect(Dispatcher.hasNativeHandler("ping")).toBe(true)
    })

    test("listNativeMethods returns registered methods", () => {
      expect(Dispatcher.listNativeMethods()).toEqual([])
      Dispatcher.register("ping", async () => ({ status: "ok" }))
      expect(Dispatcher.listNativeMethods()).toEqual(["ping"])
    })
  })

  describe("reset", () => {
    test("clears all registered handlers", () => {
      Dispatcher.register("ping", async () => ({ status: "ok" }))
      expect(Dispatcher.hasNativeHandler("ping")).toBe(true)
      Dispatcher.reset()
      expect(Dispatcher.hasNativeHandler("ping")).toBe(false)
      expect(Dispatcher.listNativeMethods()).toEqual([])
    })
  })

  describe("call — no handler", () => {
    test("throws when no native handler registered", async () => {
      await expect(Dispatcher.call("ping", {} as any)).rejects.toThrow("No native handler for ping")
    })
  })

  describe("call — native handler", () => {
    test("calls native handler when registered", async () => {
      const handler = mock(() => Promise.resolve({ status: "native" }))
      Dispatcher.register("ping", handler)
      const result = await Dispatcher.call("ping", {} as any)
      expect(result).toEqual({ status: "native" })
      expect(handler).toHaveBeenCalledTimes(1)
    })

    test("propagates native handler errors", async () => {
      Dispatcher.register("ping", async () => {
        throw new Error("native boom")
      })
      await expect(Dispatcher.call("ping", {} as any)).rejects.toThrow("native boom")
    })

    test("tracks telemetry on success", async () => {
      Dispatcher.register("ping", async () => ({ status: "ok" }))
      await Dispatcher.call("ping", {} as any)
      // Telemetry is disabled — just verify no crash
    })

    test("tracks telemetry on error", async () => {
      Dispatcher.register("ping", async () => {
        throw new Error("fail")
      })
      await expect(Dispatcher.call("ping", {} as any)).rejects.toThrow("fail")
      // Telemetry is disabled — just verify no crash
    })
  })
})
