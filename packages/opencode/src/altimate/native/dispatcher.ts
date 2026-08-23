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

/** Generation counter — bumped whenever the hook or in-flight promise is
 * replaced. An in-flight attempt captures its generation at start; if the
 * counter advanced by the time its settle handler fires, another caller
 * (reset / setRegistrationHook / a distinct new attempt after failure)
 * has already installed replacement state, and the stale attempt must NOT
 * mutate it. Prevents a stale success from clobbering a replacement hook,
 * and a stale failure from clobbering a newer in-flight promise. */
let _registrationGeneration = 0

/** Clear all registered handlers and lazy registration hook (for test isolation). */
export function reset(): void {
  nativeHandlers.clear()
  _ensureRegistered = null
  _registrationPromise = null
  _registrationGeneration++
}

/** Called by native/index.ts to set the lazy registration function. */
export function setRegistrationHook(fn: () => Promise<void>): void {
  _ensureRegistered = fn
  _registrationPromise = null
  _registrationGeneration++
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
  // recover without restarting the CLI. Generation guard prevents a stale
  // attempt from mutating state a concurrent ``reset()``/``setRegistrationHook()``
  // has since replaced. (coderabbit round 1 — release/v0.9.6 review.)
  // Concurrency contract:
  //   • ``reset()`` / ``setRegistrationHook()`` MAY be called while an
  //     older ``Dispatcher.call`` is in flight — the generation guard below
  //     blocks the stale attempt's ``.then`` handler from mutating shared
  //     state (``_ensureRegistered`` / ``_registrationPromise``) that the
  //     replacement installed. Adversarial tests below exercise both races.
  //   • What we DO NOT guarantee: if the stale hook body itself resumes
  //     after replacement and calls ``Dispatcher.register(...)`` late,
  //     that late write overwrites whatever the newer hook wrote — and
  //     no in-band signal lets us self-heal it without recreating the
  //     shared-state race the round-1 guard is meant to prevent (see the
  //     coderabbit + cubic round-2 exchange on release/v0.9.6). Callers
  //     that need late-write safety must serialise hook mutations
  //     against outstanding calls themselves.
  //   • Production never triggers late-write clobber: ``setRegistrationHook``
  //     is called exactly once at startup by ``native/index.ts``, and
  //     ``reset()`` is test-only.
  if (_ensureRegistered) {
    if (!_registrationPromise) {
      const fn = _ensureRegistered
      const generation = ++_registrationGeneration
      _registrationPromise = fn().then(
        () => {
          // Only clear _ensureRegistered if our generation is still current
          // — otherwise a concurrent reset()/setRegistrationHook() already
          // installed a replacement, and clearing would clobber it.
          if (generation === _registrationGeneration) _ensureRegistered = null
        },
        (err) => {
          // Same guard on the failure path: don't null a newer in-flight
          // promise from another attempt.
          if (generation === _registrationGeneration) _registrationPromise = null
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
