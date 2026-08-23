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

/** Lazy registration hook — set by native/index.ts */
let _ensureRegistered: (() => Promise<void>) | null = null

/** In-flight registration promise (deduped across concurrent callers). */
let _registrationPromise: Promise<void> | null = null

/** Clear all registered handlers and lazy registration hook (for test isolation). */
export function reset(): void {
  nativeHandlers.clear()
  _ensureRegistered = null
  _registrationPromise = null
}

/** Called by native/index.ts to set the lazy registration function. */
export function setRegistrationHook(fn: () => Promise<void>): void {
  _ensureRegistered = fn
  _registrationPromise = null
}

/** Dispatch a method call to the registered native handler. */
export async function call<M extends BridgeMethod>(
  method: M,
  params: (typeof BridgeMethods)[M] extends { params: infer P } ? P : never,
): Promise<(typeof BridgeMethods)[M] extends { result: infer R } ? R : never> {
  // Lazy registration: load all handler modules on first call. Cache the
  // in-flight promise so concurrent callers share one attempt; on failure
  // clear the cached promise so a subsequent call can retry. Previously
  // ``_ensureRegistered`` was nulled BEFORE the await, so a transient NAPI
  // load failure poisoned the bridge for the process lifetime — every
  // subsequent ``call`` threw ``No native handler for X`` with no way to
  // recover without restarting the CLI.
  if (_ensureRegistered) {
    if (!_registrationPromise) {
      const fn = _ensureRegistered
      _registrationPromise = fn().then(
        () => {
          _ensureRegistered = null
        },
        (err) => {
          _registrationPromise = null
          throw err
        },
      )
    }
    await _registrationPromise
  }

  const native = nativeHandlers.get(method as string)

  if (!native) {
    throw new Error(`No native handler for ${String(method)}`)
  }

  const startTime = Date.now()
  try {
    const result = await native(params)

    try {
      Telemetry.track({
        type: "native_call",
        timestamp: Date.now(),
        session_id: Telemetry.getContext().sessionId,
        method: method as string,
        status: "success",
        duration_ms: Date.now() - startTime,
      })
    } catch {
      // Telemetry must never turn a successful operation into an error
    }

    return result as any
  } catch (e) {
    try {
      Telemetry.track({
        type: "native_call",
        timestamp: Date.now(),
        session_id: Telemetry.getContext().sessionId,
        method: method as string,
        status: "error",
        duration_ms: Date.now() - startTime,
        error: Telemetry.maskString(String(e)).slice(0, 500),
      })
    } catch {
      // Telemetry must never prevent error propagation
    }
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
