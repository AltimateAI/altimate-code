/**
 * Dispatcher — routes tool calls to either native TypeScript handlers or the
 * Python bridge (fallback). This is the Strangler Fig migration layer.
 *
 * Feature flags:
 *   ALTIMATE_NATIVE_ONLY=1   — throws if no native handler (CI gate)
 *   ALTIMATE_SHADOW_MODE=1   — runs native first, then fires bridge
 *                              comparison asynchronously (no latency cost)
 */

import { Bridge } from "../bridge/client"
import { BridgeMethods, type BridgeMethod } from "../bridge/protocol"
import { Log } from "../../util/log"
import { Telemetry } from "../telemetry"

type NativeHandler = (params: any) => Promise<any>

const nativeHandlers = new Map<string, NativeHandler>()

/** Register a native TypeScript handler for a bridge method. */
export function register(method: BridgeMethod, handler: NativeHandler): void {
  nativeHandlers.set(method, handler)
}

/** Clear all registered handlers (for test isolation). */
export function reset(): void {
  nativeHandlers.clear()
}

/** Dispatch a method call to native handler or bridge fallback. */
export async function call<M extends BridgeMethod>(
  method: M,
  params: (typeof BridgeMethods)[M] extends { params: infer P } ? P : never,
): Promise<(typeof BridgeMethods)[M] extends { result: infer R } ? R : never> {
  const native = nativeHandlers.get(method as string)

  if (native) {
    const startTime = Date.now()
    try {
      const result = await native(params)

      Telemetry.track({
        type: "bridge_call",
        timestamp: Date.now(),
        session_id: Telemetry.getContext().sessionId,
        method: method as string,
        status: "success",
        duration_ms: Date.now() - startTime,
      })

      // Shadow mode: fire-and-forget bridge comparison (no latency cost)
      if (process.env.ALTIMATE_SHADOW_MODE === "1") {
        compareShadow(method, params, result)
      }

      return result as any
    } catch (e) {
      Telemetry.track({
        type: "bridge_call",
        timestamp: Date.now(),
        session_id: Telemetry.getContext().sessionId,
        method: method as string,
        status: "error",
        duration_ms: Date.now() - startTime,
        error: String(e).slice(0, 500),
      })
      throw e
    }
  }

  if (process.env.ALTIMATE_NATIVE_ONLY === "1") {
    throw new Error(
      `No native handler for ${String(method)} (ALTIMATE_NATIVE_ONLY=1)`,
    )
  }

  return Bridge.call(method, params)
}

/** Check if a native handler is registered for a method. */
export function hasNativeHandler(method: BridgeMethod): boolean {
  return nativeHandlers.has(method)
}

/** List all methods that have native handlers registered. */
export function listNativeMethods(): string[] {
  return Array.from(nativeHandlers.keys())
}

/**
 * Fire-and-forget bridge comparison for shadow mode.
 * Runs the bridge call asynchronously after native returns —
 * does not block the user or add latency.
 */
function compareShadow(method: BridgeMethod, params: any, nativeValue: any): void {
  Bridge.call(method, params)
    .then((bridgeValue) => {
      try {
        const nativeJson = JSON.stringify(nativeValue, null, 0)
        const bridgeJson = JSON.stringify(bridgeValue, null, 0)
        if (nativeJson !== bridgeJson) {
          Log.Default.warn("shadow mode mismatch", {
            method: String(method),
            native: nativeJson.slice(0, 500),
            bridge: bridgeJson.slice(0, 500),
          })
        }
      } catch (serializeErr) {
        Log.Default.warn("shadow mode serialization error", {
          method: String(method),
          error: String(serializeErr).slice(0, 200),
        })
      }
    })
    .catch((bridgeErr) => {
      Log.Default.warn("shadow mode bridge error", {
        method: String(method),
        error: String(bridgeErr).slice(0, 200),
      })
    })
}
