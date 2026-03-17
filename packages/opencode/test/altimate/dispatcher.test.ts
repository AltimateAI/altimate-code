import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test"
import * as Dispatcher from "../../src/altimate/native/dispatcher"

// Mock Bridge.call to avoid spawning Python
const mockBridgeCall = mock(() => Promise.resolve({ status: "ok" }))
mock.module("../../src/altimate/bridge/client", () => ({
  Bridge: { call: mockBridgeCall },
}))

// Mock Telemetry to avoid side effects
mock.module("../../src/altimate/telemetry", () => ({
  Telemetry: {
    track: mock(() => {}),
    getContext: () => ({ sessionId: "test-session" }),
  },
}))

// Mock Log
mock.module("../../src/util/log", () => ({
  Log: {
    Default: {
      warn: mock(() => {}),
      error: mock(() => {}),
    },
  },
}))

describe("Dispatcher", () => {
  beforeEach(() => {
    Dispatcher.reset()
    mockBridgeCall.mockClear()
    delete process.env.ALTIMATE_NATIVE_ONLY
    delete process.env.ALTIMATE_SHADOW_MODE
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

  describe("call — fallback to bridge", () => {
    test("falls back to Bridge.call when no native handler registered", async () => {
      mockBridgeCall.mockResolvedValueOnce({ status: "ok" })
      const result = await Dispatcher.call("ping", {} as any)
      expect(result).toEqual({ status: "ok" })
      expect(mockBridgeCall).toHaveBeenCalledWith("ping", {})
    })
  })

  describe("call — native handler", () => {
    test("calls native handler when registered", async () => {
      const handler = mock(() => Promise.resolve({ status: "native" }))
      Dispatcher.register("ping", handler)
      const result = await Dispatcher.call("ping", {} as any)
      expect(result).toEqual({ status: "native" })
      expect(handler).toHaveBeenCalledTimes(1)
      // Should NOT call bridge
      expect(mockBridgeCall).not.toHaveBeenCalled()
    })

    test("propagates native handler errors", async () => {
      Dispatcher.register("ping", async () => {
        throw new Error("native boom")
      })
      await expect(Dispatcher.call("ping", {} as any)).rejects.toThrow("native boom")
    })
  })

  describe("ALTIMATE_NATIVE_ONLY mode", () => {
    test("throws when no native handler and ALTIMATE_NATIVE_ONLY=1", async () => {
      process.env.ALTIMATE_NATIVE_ONLY = "1"
      await expect(Dispatcher.call("ping", {} as any)).rejects.toThrow(
        "No native handler for ping (ALTIMATE_NATIVE_ONLY=1)",
      )
      expect(mockBridgeCall).not.toHaveBeenCalled()
    })

    test("does not throw when native handler exists", async () => {
      process.env.ALTIMATE_NATIVE_ONLY = "1"
      Dispatcher.register("ping", async () => ({ status: "ok" }))
      const result = await Dispatcher.call("ping", {} as any)
      expect(result).toEqual({ status: "ok" })
    })
  })

  describe("ALTIMATE_SHADOW_MODE", () => {
    test("returns native result immediately without waiting for bridge", async () => {
      process.env.ALTIMATE_SHADOW_MODE = "1"
      // Make bridge call slow
      mockBridgeCall.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ status: "bridge" }), 5000)),
      )
      Dispatcher.register("ping", async () => ({ status: "native" }))

      const start = Date.now()
      const result = await Dispatcher.call("ping", {} as any)
      const elapsed = Date.now() - start

      expect(result).toEqual({ status: "native" })
      // Should return in <100ms, not wait for 5s bridge
      expect(elapsed).toBeLessThan(500)
    })

    test("fires bridge comparison asynchronously", async () => {
      process.env.ALTIMATE_SHADOW_MODE = "1"
      mockBridgeCall.mockResolvedValue({ status: "native" })
      Dispatcher.register("ping", async () => ({ status: "native" }))

      await Dispatcher.call("ping", {} as any)
      // Give the fire-and-forget a tick to execute
      await new Promise((r) => setTimeout(r, 50))
      expect(mockBridgeCall).toHaveBeenCalledTimes(1)
    })
  })
})
