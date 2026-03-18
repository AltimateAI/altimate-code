import { describe, expect, test, beforeEach, beforeAll, afterAll, mock } from "bun:test"
import * as Dispatcher from "../../src/altimate/native/dispatcher"

// Disable telemetry via env var instead of mock.module
beforeAll(() => { process.env.ALTIMATE_TELEMETRY_DISABLED = "true" })
afterAll(() => { delete process.env.ALTIMATE_TELEMETRY_DISABLED })

describe("Dispatcher", () => {
  beforeEach(() => {
    Dispatcher.reset()
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
      await expect(Dispatcher.call("ping", {} as any)).rejects.toThrow(
        "No native handler for ping",
      )
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
      Dispatcher.register("ping", async () => { throw new Error("fail") })
      await expect(Dispatcher.call("ping", {} as any)).rejects.toThrow("fail")
      // Telemetry is disabled — just verify no crash
    })
  })
})
