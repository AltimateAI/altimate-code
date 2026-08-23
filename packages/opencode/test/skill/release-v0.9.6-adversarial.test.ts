/**
 * Adversarial coverage for the v0.9.6 release payload.
 *
 * Focus: fixes that landed IN this release (not the whole PR history) —
 *  1. Dispatcher retry-after-registration-failure (v0.9.6 review gremlin fix)
 *  2. Dispatcher generation guard on shared-state mutations from stale
 *     .then handlers (coderabbit round 1)
 *
 * Explicitly NOT covered (test-isolation contract, see dispatcher.ts):
 *  - Late ``register()`` from a stale hook body after a replacement hook
 *    has already run. That scenario requires calling ``reset()`` /
 *    ``setRegistrationHook()`` while a call is still in flight — a
 *    production impossibility (hook is set once at startup, reset is
 *    test-only) and a violation of the test-isolation contract. See
 *    ``dispatcher.ts`` for the design decision and the coderabbit/cubic
 *    round-2 exchange that arrived at it.
 *
 * Not covered here (existing test suites are authoritative):
 *  - altimate-core 0.7.0 shape corrections — see
 *    packages/opencode/test/altimate/altimate-core-e2e.test.ts
 *  - Truncation ID-wrap regression — see
 *    packages/opencode/test/tool/truncation.test.ts
 *
 * Scheduling discipline: these tests never use ``setTimeout``. Every
 * synchronisation point is a Promise gate that the test controls, so the
 * ordering is deterministic regardless of the underlying scheduler. Bun's
 * ``async`` function bodies run synchronously until the first ``await``, so
 * ``Dispatcher.call(...)`` has already registered its cached promise and
 * hit ``await _registrationPromise`` by the time control returns to us —
 * we can immediately act on shared state without racing the call's setup.
 */
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, test } from "bun:test"

import * as Dispatcher from "../../src/altimate/native/dispatcher"

let _priorTelemetryDisabled: string | undefined
beforeAll(() => {
  _priorTelemetryDisabled = process.env.ALTIMATE_TELEMETRY_DISABLED
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
})
afterAll(() => {
  // Restore any pre-existing value rather than unconditionally deleting —
  // an outer suite may have set it and expects to see its own value after
  // this file runs. (cubic P2 round 3.)
  if (_priorTelemetryDisabled === undefined) {
    delete process.env.ALTIMATE_TELEMETRY_DISABLED
  } else {
    process.env.ALTIMATE_TELEMETRY_DISABLED = _priorTelemetryDisabled
  }
})

describe("v0.9.6 release: Dispatcher registration retry", () => {
  beforeEach(() => {
    Dispatcher.reset()
    Dispatcher.setRegistrationHook(null as any)
  })
  afterEach(() => {
    Dispatcher.reset()
    Dispatcher.setRegistrationHook(null as any)
  })

  test("failed registration does NOT poison future calls — hook re-runs on next call", async () => {
    // Reproduces the gremlin finding: previously _ensureRegistered was
    // nulled BEFORE the await, so a transient failure permanently disabled
    // lazy registration for the rest of the process — every subsequent
    // call threw "No native handler for X" with no path to recovery.
    let attempts = 0
    Dispatcher.setRegistrationHook(async () => {
      attempts += 1
      if (attempts === 1) {
        throw new Error("simulated NAPI load failure")
      }
      Dispatcher.register("ping", async () => ({ status: "recovered" }))
    })

    await expect(Dispatcher.call("ping", {} as any)).rejects.toThrow(
      "simulated NAPI load failure",
    )
    expect(attempts).toBe(1)

    // Second call: registration hook MUST run again (this is the fix).
    // Before v0.9.6 this call threw "No native handler for ping" because
    // _ensureRegistered was permanently nulled after the first attempt.
    const result = await Dispatcher.call("ping", {} as any)
    expect(result).toEqual({ status: "recovered" })
    expect(attempts).toBe(2)
  })

  test("concurrent calls share ONE registration attempt", async () => {
    // Fires 20 concurrent calls before the hook completes; asserts the
    // hook body ran exactly once. All 20 Dispatcher.call invocations run
    // sync-then-yield in a row, so by the time the array is populated
    // every caller is already awaiting the shared _registrationPromise —
    // no external synchronisation needed.
    let attempts = 0
    let resolveRegistration: () => void = () => {}
    const registrationGate = new Promise<void>((r) => (resolveRegistration = r))
    Dispatcher.setRegistrationHook(async () => {
      attempts += 1
      await registrationGate
      Dispatcher.register("ping", async () => ({ status: "ok" }))
    })

    const calls = Array.from({ length: 20 }, () => Dispatcher.call("ping", {} as any))
    resolveRegistration()
    const results = await Promise.all(calls)

    expect(results).toHaveLength(20)
    for (const r of results) expect(r).toEqual({ status: "ok" })
    // Critical: the hook fired exactly ONCE despite 20 concurrent callers.
    expect(attempts).toBe(1)
  })

  test("concurrent calls share ONE registration attempt on failure — all reject with the SAME error", async () => {
    // Companion to the success case: assert dedup also holds when the
    // hook fails. All N concurrent callers must reject with the same
    // error object (proving they awaited the same in-flight promise),
    // and the hook body must have run exactly once. (cubic P2 round 3.)
    let attempts = 0
    let rejectGate: (err: Error) => void = () => {}
    const gate = new Promise<void>((_, rej) => (rejectGate = rej))
    Dispatcher.setRegistrationHook(async () => {
      attempts += 1
      await gate
    })

    const calls = Array.from({ length: 20 }, () => Dispatcher.call("ping", {} as any))
    const failure = new Error("shared-failure")
    rejectGate(failure)

    const results = await Promise.allSettled(calls)
    expect(results.length).toBe(20)
    for (const r of results) {
      expect(r.status).toBe("rejected")
      if (r.status === "rejected") {
        // Same error instance = same underlying promise = dedup held.
        expect(r.reason).toBe(failure)
      }
    }
    expect(attempts).toBe(1)
  })

  test("successful registration is memoized — a later call does NOT re-run the hook", async () => {
    // Guard against overcorrection: once the current-generation hook has
    // completed, the resolved _registrationPromise memoizes success so
    // subsequent calls fast-path through an already-settled await instead
    // of re-importing all handler modules for no reason.
    let attempts = 0
    Dispatcher.setRegistrationHook(async () => {
      attempts += 1
      Dispatcher.register("ping", async () => ({ status: "ok" }))
    })

    await Dispatcher.call("ping", {} as any)
    expect(attempts).toBe(1)
    await Dispatcher.call("ping", {} as any)
    expect(attempts).toBe(1)
  })

  test("reset() while a hook is pending — stale success does NOT clobber the replacement (generation guard)", async () => {
    // coderabbit round 1 on release/v0.9.6: without a generation guard,
    // an old attempt's success handler would null _ensureRegistered even
    // after reset() + setRegistrationHook() had installed a replacement,
    // wiping it out and causing later calls to skip registration.
    let resolvePending: () => void = () => {}
    const pending = new Promise<void>((r) => (resolvePending = r))
    Dispatcher.setRegistrationHook(async () => {
      await pending
      Dispatcher.register("ping", async () => ({ status: "old-hook-ran" }))
    })

    // Dispatcher.call runs sync until its first await, so by the time this
    // returns the call is already blocked on _registrationPromise and we
    // can safely mutate shared state without a race.
    const firstCall = Dispatcher.call("ping", {} as any)

    Dispatcher.reset()
    let replacementRan = false
    Dispatcher.setRegistrationHook(async () => {
      replacementRan = true
      Dispatcher.register("ping", async () => ({ status: "replacement" }))
    })

    resolvePending()
    await firstCall.catch(() => {})

    const result = await Dispatcher.call("ping", {} as any)
    expect(replacementRan).toBe(true)
    expect(result).toEqual({ status: "replacement" })
  })

  test("setRegistrationHook() while a hook is pending — stale failure does NOT clobber the new in-flight promise", async () => {
    // Failure handler also mutates shared state (_registrationPromise = null),
    // so it needs the same generation guard. Otherwise a stale failure
    // clears a newer in-flight promise, breaking dedup for anyone awaiting it.
    let rejectOld: (err: Error) => void = () => {}
    const oldPending = new Promise<void>((_, rej) => (rejectOld = rej))
    Dispatcher.setRegistrationHook(async () => {
      await oldPending
    })
    const firstCall = Dispatcher.call("ping", {} as any)

    let newHookAttempts = 0
    let resolveNew: () => void = () => {}
    const newPending = new Promise<void>((r) => (resolveNew = r))
    Dispatcher.setRegistrationHook(async () => {
      newHookAttempts += 1
      await newPending
      Dispatcher.register("ping", async () => ({ status: "new-hook-ran" }))
    })
    const secondCall = Dispatcher.call("ping", {} as any)

    rejectOld(new Error("old attempt failed"))
    await firstCall.catch(() => {})

    // Third caller arrives — must share the second call's still-cached
    // promise (dedup works), not start a third registration attempt.
    const thirdCall = Dispatcher.call("ping", {} as any)
    resolveNew()

    const [r2, r3] = await Promise.all([secondCall, thirdCall])
    expect(r2).toEqual({ status: "new-hook-ran" })
    expect(r3).toEqual({ status: "new-hook-ran" })
    // Critical: new hook fired ONCE despite second + third both dedup-sharing
    // its promise — proving the stale failure handler didn't null the cache.
    expect(newHookAttempts).toBe(1)
  })

  test("reset() clears both the hook and the cached in-flight promise", async () => {
    // reset() must wipe both _ensureRegistered AND _registrationPromise —
    // otherwise a failed registration in one test leaves the cached
    // rejected promise pinned for the next test.
    let attempts = 0
    Dispatcher.setRegistrationHook(async () => {
      attempts += 1
      throw new Error("boom")
    })
    await expect(Dispatcher.call("ping", {} as any)).rejects.toThrow("boom")
    expect(attempts).toBe(1)

    Dispatcher.reset()
    Dispatcher.setRegistrationHook(async () => {
      Dispatcher.register("ping", async () => ({ status: "fresh" }))
    })

    const result = await Dispatcher.call("ping", {} as any)
    expect(result).toEqual({ status: "fresh" })
  })
})
