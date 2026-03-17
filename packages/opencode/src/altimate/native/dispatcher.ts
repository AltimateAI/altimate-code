/**
 * Dispatcher — routes tool calls to either native TypeScript handlers or the
 * Python bridge (fallback). This is the Strangler Fig migration layer.
 *
 * Feature flags:
 *   ALTIMATE_NATIVE_ONLY=1   — throws if no native handler (CI gate)
 *   ALTIMATE_SHADOW_MODE=1   — runs both native + bridge, logs mismatches
 */

import { Bridge } from "../bridge/client"
import { BridgeMethods, type BridgeMethod } from "../bridge/protocol"
import { Log } from "../../util/log"

type NativeHandler = (params: any) => Promise<any>

const nativeHandlers = new Map<string, NativeHandler>()

/** Register a native TypeScript handler for a bridge method. */
export function register(method: string, handler: NativeHandler): void {
  nativeHandlers.set(method, handler)
}

/** Dispatch a method call to native handler or bridge fallback. */
export async function call<M extends BridgeMethod>(
  method: M,
  params: (typeof BridgeMethods)[M] extends { params: infer P } ? P : never,
): Promise<(typeof BridgeMethods)[M] extends { result: infer R } ? R : never> {
  const native = nativeHandlers.get(method as string)

  if (native) {
    if (process.env.ALTIMATE_SHADOW_MODE === "1") {
      // Parity testing: run both native and bridge, log mismatches
      try {
        const [nativeResult, bridgeResult] = await Promise.allSettled([
          native(params),
          Bridge.call(method, params),
        ])
        if (
          nativeResult.status === "fulfilled" &&
          bridgeResult.status === "fulfilled"
        ) {
          const nativeJson = JSON.stringify(nativeResult.value, null, 0)
          const bridgeJson = JSON.stringify(bridgeResult.value, null, 0)
          if (nativeJson !== bridgeJson) {
            Log.Default.warn("shadow mode mismatch", {
              method: String(method),
              native: nativeJson.slice(0, 500),
              bridge: bridgeJson.slice(0, 500),
            })
          }
        }
        if (nativeResult.status === "fulfilled") {
          return nativeResult.value as any
        }
        // Native failed — fall through to bridge result or throw
        if (bridgeResult.status === "fulfilled") {
          return bridgeResult.value as any
        }
        throw nativeResult.reason
      } catch (e) {
        // Shadow mode should not break the user — fall through to bridge
        return Bridge.call(method, params)
      }
    }
    return native(params) as any
  }

  if (process.env.ALTIMATE_NATIVE_ONLY === "1") {
    throw new Error(
      `No native handler for ${String(method)} (ALTIMATE_NATIVE_ONLY=1)`,
    )
  }

  return Bridge.call(method, params)
}

/** Check if a native handler is registered for a method. */
export function hasNativeHandler(method: string): boolean {
  return nativeHandlers.has(method)
}

/** List all methods that have native handlers registered. */
export function listNativeMethods(): string[] {
  return Array.from(nativeHandlers.keys())
}
