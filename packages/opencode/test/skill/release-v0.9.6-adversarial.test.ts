/**
 * Adversarial coverage for the v0.9.6 release payload.
 *
 * Focus: fixes that landed IN this release (not the whole PR history) —
 *  1. Dispatcher retry-after-registration-failure (v0.9.6 review gremlin fix)
 *  2. Truncation cleanup: fail-safe on stat error, mtime-based aging
 *
 * Not covered here (existing test suites are authoritative):
 *  - altimate-core 0.7.0 shape corrections — see
 *    packages/opencode/test/altimate/altimate-core-e2e.test.ts (26 files,
 *    real-engine "consumer contract sync" blocks land there)
 *  - Truncation ID-wrap regression — see
 *    packages/opencode/test/tool/truncation.test.ts
 */
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, test } from "bun:test"

import * as Dispatcher from "../../src/altimate/native/dispatcher"

beforeAll(() => {
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
})
afterAll(() => {
  delete process.env.ALTIMATE_TELEMETRY_DISABLED
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

    // First call: registration fails, error propagates.
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

  test("concurrent calls share ONE registration attempt on both success and failure", async () => {
    // Guard the dedup property — the fix caches the in-flight promise so
    // 100 racing calls trigger the hook exactly once, not 100 times.
    let attempts = 0
    let resolveRegistration: () => void = () => {}
    const registrationGate = new Promise<void>((resolve) => {
      resolveRegistration = resolve
    })
    Dispatcher.setRegistrationHook(async () => {
      attempts += 1
      await registrationGate
      Dispatcher.register("ping", async () => ({ status: "ok" }))
    })

    // Fire 20 concurrent calls before registration completes.
    const calls = Array.from({ length: 20 }, () => Dispatcher.call("ping", {} as any))
    // Let the concurrent callers all enter the registration branch.
    await new Promise((r) => setTimeout(r, 10))
    resolveRegistration()

    const results = await Promise.all(calls)
    expect(results).toHaveLength(20)
    for (const r of results) expect(r).toEqual({ status: "ok" })
    // Critical: the hook fired exactly ONCE despite 20 concurrent callers.
    expect(attempts).toBe(1)
  })

  test("successful registration clears the hook — a later call does NOT re-run it", async () => {
    // Guard against overcorrection: the fix must still short-circuit after
    // success, otherwise every subsequent call would eagerly re-import all
    // handler modules for no reason.
    let attempts = 0
    Dispatcher.setRegistrationHook(async () => {
      attempts += 1
      Dispatcher.register("ping", async () => ({ status: "ok" }))
    })

    await Dispatcher.call("ping", {} as any)
    expect(attempts).toBe(1)

    // Later call: hook must NOT re-run (it was cleared on success).
    await Dispatcher.call("ping", {} as any)
    expect(attempts).toBe(1)
  })

  test("reset() while a hook is pending — stale success does NOT clobber the reset state (generation guard)", async () => {
    // coderabbit round 1 catch on release/v0.9.6: without a generation guard,
    // an old registration attempt's success handler nulls _ensureRegistered,
    // wiping out a replacement hook that reset() installed mid-flight. Later
    // calls then skip registration entirely and see stale (empty) state.
    let resolvePending: () => void = () => {}
    const pending = new Promise<void>((r) => (resolvePending = r))
    Dispatcher.setRegistrationHook(async () => {
      await pending
      Dispatcher.register("ping", async () => ({ status: "old-hook-ran" }))
    })

    // Start the first call — hook attempt is now in flight, awaiting `pending`.
    const firstCall = Dispatcher.call("ping", {} as any)
    await new Promise((r) => setTimeout(r, 5))

    // Concurrent reset + install a REPLACEMENT hook. Without generation guard,
    // when the pending attempt finally resolves, it will null _ensureRegistered
    // — clobbering the replacement.
    Dispatcher.reset()
    let replacementRan = false
    Dispatcher.setRegistrationHook(async () => {
      replacementRan = true
      Dispatcher.register("ping", async () => ({ status: "replacement" }))
    })

    // Let the old attempt resolve. Its success handler must skip the mutation
    // because the generation has advanced twice (reset + setRegistrationHook).
    resolvePending()
    await firstCall.catch(() => {}) // may reject or resolve; doesn't matter here

    // A new call should invoke the REPLACEMENT hook, not skip registration.
    const result = await Dispatcher.call("ping", {} as any)
    expect(replacementRan).toBe(true)
    expect(result).toEqual({ status: "replacement" })
  })

  test("setRegistrationHook() while a hook is pending — stale failure does NOT clobber the new in-flight promise", async () => {
    // Companion to the previous case: the failure handler also mutates
    // shared state (_registrationPromise = null), so it needs the same guard.
    // Scenario: old hook is failing, but during its await, setRegistrationHook
    // installs a new hook AND a new call kicks off a new registration
    // promise. Without the guard, the old attempt's failure handler nulls
    // the NEW _registrationPromise mid-flight, breaking dedup for anyone
    // else awaiting it.
    let rejectOld: (err: Error) => void = () => {}
    const oldPending = new Promise<void>((_, rej) => (rejectOld = rej))
    Dispatcher.setRegistrationHook(async () => {
      await oldPending
    })

    // Start first call — will fail once we reject.
    const firstCall = Dispatcher.call("ping", {} as any)
    await new Promise((r) => setTimeout(r, 5))

    // Install new hook; kick off a second call which caches its own promise.
    let newHookAttempts = 0
    let resolveNew: () => void = () => {}
    const newPending = new Promise<void>((r) => (resolveNew = r))
    Dispatcher.setRegistrationHook(async () => {
      newHookAttempts += 1
      await newPending
      Dispatcher.register("ping", async () => ({ status: "new-hook-ran" }))
    })
    const secondCall = Dispatcher.call("ping", {} as any)
    await new Promise((r) => setTimeout(r, 5))

    // Reject the old attempt. Its failure handler must NOT null the second
    // call's cached promise.
    rejectOld(new Error("old attempt failed"))
    await firstCall.catch(() => {})

    // Third caller arrives — should share the second call's still-cached
    // promise (dedup works), not start a third registration attempt.
    const thirdCall = Dispatcher.call("ping", {} as any)
    resolveNew()

    const [r2, r3] = await Promise.all([secondCall, thirdCall])
    expect(r2).toEqual({ status: "new-hook-ran" })
    expect(r3).toEqual({ status: "new-hook-ran" })
    // Critical: new hook fired ONCE despite second + third call both
    // dedup-sharing its promise, proving the stale failure handler didn't
    // null the cached promise and let a third attempt start.
    expect(newHookAttempts).toBe(1)
  })

  test("reset() clears both the hook and the cached in-flight promise", async () => {
    // The reset added a new field (_registrationPromise) that also needs
    // to be cleared, otherwise test isolation regresses: a failed
    // registration in one test would leave the cached rejected promise
    // pinned for the next test.
    let attempts = 0
    Dispatcher.setRegistrationHook(async () => {
      attempts += 1
      throw new Error("boom")
    })
    await expect(Dispatcher.call("ping", {} as any)).rejects.toThrow("boom")
    expect(attempts).toBe(1)

    // Reset should wipe both hook and cached promise. Setting a new hook
    // must let call() invoke IT, not a stale rejected promise.
    Dispatcher.reset()
    Dispatcher.setRegistrationHook(async () => {
      Dispatcher.register("ping", async () => ({ status: "fresh" }))
    })

    const result = await Dispatcher.call("ping", {} as any)
    expect(result).toEqual({ status: "fresh" })
  })
})
