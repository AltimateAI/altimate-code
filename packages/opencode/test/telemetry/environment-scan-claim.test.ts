// v0.9.5 review — Tech Lead P1.
//
// project-scan.ts (packages/opencode/src/altimate/tools/project-scan.ts:952-964) emits
// `environment_scan_completed` guarded by:
//
//   if (OnboardingTelemetry.isOnboardingSession(ctx.sessionID)
//    && OnboardingTelemetry.claimEnvironmentScan(ctx.sessionID)) { void OnboardingTelemetry.emit(...) }
//
// The claim call is the only thing preventing double-fire of the funnel event
// (a second project_scan invocation inside the same onboarding session would
// otherwise push `scan_gate_shown → environment_scan_completed` above 100%,
// which is the exact metric the comment on that emission block calls out as
// worth protecting).
//
// End-to-end coverage through project-scan requires shelling to git/dbt/docker
// detection and is disproportionately expensive for the guarantee at stake.
// The load-bearing behavior is the once-per-session claim + the session-scope
// isolation of that claim, both of which live in onboarding.ts and are
// independently testable.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as OnboardingTelemetry from "../../src/altimate/telemetry/onboarding"

beforeEach(() => {
  OnboardingTelemetry.resetForTest()
})
afterEach(() => {
  OnboardingTelemetry.resetForTest()
})

describe("environment_scan_completed guard", () => {
  test("claimEnvironmentScan returns true on first call, false on subsequent calls", () => {
    const session = "sess-1"
    expect(OnboardingTelemetry.claimEnvironmentScan(session)).toBe(true)
    expect(OnboardingTelemetry.claimEnvironmentScan(session)).toBe(false)
    expect(OnboardingTelemetry.claimEnvironmentScan(session)).toBe(false)
  })

  test("claims are session-scoped — a second session claims independently", () => {
    expect(OnboardingTelemetry.claimEnvironmentScan("sess-A")).toBe(true)
    expect(OnboardingTelemetry.claimEnvironmentScan("sess-B")).toBe(true)
    // ...and each session's claim stays exhausted after its first success
    expect(OnboardingTelemetry.claimEnvironmentScan("sess-A")).toBe(false)
    expect(OnboardingTelemetry.claimEnvironmentScan("sess-B")).toBe(false)
  })

  test("isOnboardingSession is false for sessions that were never marked", () => {
    // The AND-guard on the emission means a non-onboarding session that runs
    // project_scan (via /discover, or a model-initiated call) will NOT emit
    // the onboarding-funnel event, even though the claim call would succeed
    // on its own. This is what stops the funnel-taxonomy event from firing
    // for routine `/discover` runs from returning users.
    expect(OnboardingTelemetry.isOnboardingSession("random-session")).toBe(false)
  })

  test("isOnboardingSession is true only after markOnboardingSession", () => {
    const s = "onboarding-sess"
    expect(OnboardingTelemetry.isOnboardingSession(s)).toBe(false)
    OnboardingTelemetry.markOnboardingSession(s)
    expect(OnboardingTelemetry.isOnboardingSession(s)).toBe(true)
  })

  test("the AND-guard (isOnboardingSession && claimEnvironmentScan) fires exactly once", () => {
    // Mirrors the exact shape at project-scan.ts:952. A single onboarding
    // session that runs project_scan twice must see the emission gate open
    // once and stay closed on the retry.
    const s = "funnel-sess"
    OnboardingTelemetry.markOnboardingSession(s)
    const fires: number[] = []
    for (let i = 0; i < 3; i++) {
      if (
        OnboardingTelemetry.isOnboardingSession(s) &&
        OnboardingTelemetry.claimEnvironmentScan(s)
      ) {
        fires.push(i)
      }
    }
    expect(fires).toEqual([0])
  })

  test("a non-onboarding session running the same guard chain never fires", () => {
    const s = "returning-user-sess"
    // Note: no markOnboardingSession call. Guard should short-circuit at
    // isOnboardingSession → false and never even reach the claim call, so
    // the claim stays unspent (verifiable below).
    const fires: number[] = []
    for (let i = 0; i < 3; i++) {
      if (
        OnboardingTelemetry.isOnboardingSession(s) &&
        OnboardingTelemetry.claimEnvironmentScan(s)
      ) {
        fires.push(i)
      }
    }
    expect(fires).toEqual([])
    // If the guard had short-circuited correctly, the claim is still available.
    // Prove it by explicitly calling claimEnvironmentScan and observing true.
    expect(OnboardingTelemetry.claimEnvironmentScan(s)).toBe(true)
  })
})
