// #1052 D12 — deterministic replacement for the deleted phase-label.tui-e2e.test.ts.
//
// The original test spawned a PTY, dispatched a real `session.phase` event through
// the SSE bridge, and polled the rendered output. It flaked because the poll cadence
// (50ms) raced against the phase-emit → store-set → render pipeline; a fast bootstrap
// phase could finish before the poll caught it. That test was `test.skip` under `CI=true`
// so PR #1053 deleted it rather than keeping deadweight.
//
// Deterministic coverage of the same chain now lives in three places:
//
//   1. Server-side publish + subscribe wiring — asserted by string-shape in
//      `packages/opencode/test/upstream/fork-feature-guards.test.ts`.
//   2. Store-mutation handler in `packages/tui/src/context/sync.tsx` (case
//      "session.phase") — covered by the fork-feature-guards test above.
//   3. THIS FILE — the last-mile lookup that renders the user-facing label from
//      the stored phase name. This is the part most likely to silently break if
//      someone edits `phase-label.ts` without updating the caller.
//
// A future extension of D12 would mount a full component + inject a Bus event
// synchronously and assert the rendered text. Deferred because the event-injection
// scaffolding does not yet exist as a reusable fixture; adding it is a separate
// piece of work that is not gated on this file.

import { describe, expect, test } from "bun:test"
import { phaseLabel } from "../../src/util/phase-label"

describe("phaseLabel", () => {
  test("returns the mapped label for every bootstrap phase the backend emits", () => {
    // These five span names are emitted by SessionPrompt.traceSpan on cold-start
    // (see packages/opencode/src/session/prompt.ts). If backend changes a name
    // without updating PHASE_LABELS, users see the "Thinking..." fallback instead
    // of the honest phase — silent regression this test catches.
    expect(phaseLabel("bootstrap.session-get")).toBe("Loading session...")
    expect(phaseLabel("bootstrap.config-get")).toBe("Loading config...")
    expect(phaseLabel("bootstrap.fingerprint-detect")).toBe("Detecting project shape...")
    expect(phaseLabel("bootstrap.telemetry-init")).toBe("Preparing telemetry...")
    expect(phaseLabel("bootstrap.resolve-tools")).toBe("Discovering tools...")
  })

  test("falls back to 'Thinking...' for an unknown phase name", () => {
    // Any span the backend emits without a matching entry should render the safe
    // default rather than the raw span name (which would leak internal shape).
    expect(phaseLabel("turn.resolve-tools")).toBe("Thinking...")
    expect(phaseLabel("bootstrap.some-future-phase")).toBe("Thinking...")
    expect(phaseLabel("literally-anything-else")).toBe("Thinking...")
  })

  test("falls back to 'Thinking...' when no phase is active", () => {
    // The store slot is `string | undefined` — undefined means no phase currently
    // set (bootstrap complete, no per-turn span in progress). Renderer receives
    // undefined and must show the neutral default.
    expect(phaseLabel(undefined)).toBe("Thinking...")
  })

  test("does not surface an empty string as a label", () => {
    // Defensive: if an empty string ever reaches the label function (e.g. from a
    // reset that stored "" instead of undefined), the fallback should still apply
    // rather than rendering an empty label next to the spinner.
    expect(phaseLabel("")).toBe("Thinking...")
  })
})
