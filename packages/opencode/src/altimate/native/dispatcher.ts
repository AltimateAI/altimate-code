/**
 * Dispatcher — routes tool calls to native TypeScript handlers.
 *
 * All 73 bridge methods now have native handlers registered.
 * The Python bridge is no longer used.
 */

import { BridgeMethods, type BridgeMethod } from "./types"
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

/** Dispatch a method call to the registered native handler. */
export async function call<M extends BridgeMethod>(
  method: M,
  params: (typeof BridgeMethods)[M] extends { params: infer P } ? P : never,
): Promise<(typeof BridgeMethods)[M] extends { result: infer R } ? R : never> {
  const native = nativeHandlers.get(method as string)

  if (!native) {
    throw new Error(`No native handler for ${String(method)}`)
  }

  const startTime = Date.now()
  try {
    const result = await native(params)

    Telemetry.track({
      type: "native_call",
      timestamp: Date.now(),
      session_id: Telemetry.getContext().sessionId,
      method: method as string,
      status: "success",
      duration_ms: Date.now() - startTime,
    })

    return result as any
  } catch (e) {
    Telemetry.track({
      type: "native_call",
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

/** Check if a native handler is registered for a method. */
export function hasNativeHandler(method: BridgeMethod): boolean {
  return nativeHandlers.has(method)
}

/** List all methods that have native handlers registered. */
export function listNativeMethods(): string[] {
  return Array.from(nativeHandlers.keys())
}
