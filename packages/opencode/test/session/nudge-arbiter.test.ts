// One-directive-per-turn contract unit gates: the nudge arbiter guarantees at
// most ONE system-authored directive block per injected turn, with precedence
// termination_challenge (item 1) > starvation_breaker (item 4) > budget_reminder
// (item 9). Items register candidates; the injection site takes the single winner.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { NudgeArbiter } from "../../src/session/nudge"

const SID = "ses_arbiter_test"

beforeEach(() => {
  NudgeArbiter.clear(SID)
})
afterEach(() => {
  NudgeArbiter.clear(SID)
  NudgeArbiter.clear("ses_arbiter_other")
})

describe("NudgeArbiter precedence (one-directive-per-turn contract)", () => {
  test("termination challenge beats starvation breaker and budget reminder", () => {
    NudgeArbiter.register(SID, { source: "budget_reminder", kind: "budget", text: "budget text" })
    NudgeArbiter.register(SID, { source: "starvation_breaker", kind: "starvation", text: "starvation text" })
    NudgeArbiter.register(SID, { source: "termination_challenge", kind: "completion_nudge", text: "termination text" })
    const winner = NudgeArbiter.take(SID)
    expect(winner?.source).toBe("termination_challenge")
    expect(winner?.text).toBe("termination text")
  })

  test("starvation breaker beats budget reminder", () => {
    NudgeArbiter.register(SID, { source: "budget_reminder", kind: "budget", text: "budget text" })
    NudgeArbiter.register(SID, { source: "starvation_breaker", kind: "starvation", text: "starvation text" })
    expect(NudgeArbiter.take(SID)?.source).toBe("starvation_breaker")
  })

  test("registration order does not matter, only precedence", () => {
    NudgeArbiter.register(SID, { source: "termination_challenge", kind: "confirm_done", text: "t" })
    NudgeArbiter.register(SID, { source: "budget_reminder", kind: "budget", text: "b" })
    expect(NudgeArbiter.take(SID)?.source).toBe("termination_challenge")
  })
})

// altimate_change start — PR #1171 review: within ONE source, take() picked the
// earliest registration, so a generation that crossed two rungs of the doom-loop
// ladder delivered the stale nudge and dropped the stronger status_check.
describe("NudgeArbiter escalation within a source", () => {
  test("the STRONGEST directive from a source wins, not the earliest", () => {
    NudgeArbiter.register(SID, { source: "starvation_breaker", kind: "doom_loop_nudge", text: "gentle nudge" })
    NudgeArbiter.register(SID, {
      source: "starvation_breaker",
      kind: "doom_loop_status_check",
      text: "forced status check",
    })
    const winner = NudgeArbiter.take(SID)
    expect(winner?.kind).toBe("doom_loop_status_check")
    expect(winner?.text).toBe("forced status check")
  })

  // Several INDEPENDENT detectors share the starvation_breaker source, and they
  // fire at different points in a step (doom-loop during tool-call processing,
  // write-starvation at step finish). Neither "earliest wins" nor "latest wins"
  // is correct — a later, weaker detector must not clobber a stronger one.
  test("a later WEAKER detector does not displace a stronger one from the same source", () => {
    NudgeArbiter.register(SID, {
      source: "starvation_breaker",
      kind: "doom_loop_status_check",
      text: "forced status check",
    })
    // registered later in the same step by the write-starvation detector
    NudgeArbiter.register(SID, { source: "starvation_breaker", kind: "starvation", text: "no writes lately" })
    expect(NudgeArbiter.take(SID)?.kind).toBe("doom_loop_status_check")
  })

  test("repeat_signature outranks write-starvation but not the doom-loop status check", () => {
    NudgeArbiter.register(SID, { source: "starvation_breaker", kind: "starvation", text: "s" })
    NudgeArbiter.register(SID, { source: "starvation_breaker", kind: "repeat_signature", text: "r" })
    expect(NudgeArbiter.take(SID)?.kind).toBe("repeat_signature")

    NudgeArbiter.clear(SID)
    NudgeArbiter.register(SID, { source: "starvation_breaker", kind: "repeat_signature", text: "r" })
    NudgeArbiter.register(SID, { source: "starvation_breaker", kind: "doom_loop_status_check", text: "sc" })
    expect(NudgeArbiter.take(SID)?.kind).toBe("doom_loop_status_check")
  })

  test("a re-fire of the same kind replaces the earlier one (current information wins)", () => {
    NudgeArbiter.register(SID, { source: "starvation_breaker", kind: "repeat_signature", text: "count 3" })
    NudgeArbiter.register(SID, { source: "starvation_breaker", kind: "repeat_signature", text: "count 6" })
    expect(NudgeArbiter.pending(SID)).toHaveLength(1)
    expect(NudgeArbiter.take(SID)?.text).toBe("count 6")
  })

  test("kind ranking does not disturb cross-source precedence", () => {
    NudgeArbiter.register(SID, { source: "starvation_breaker", kind: "doom_loop_status_check", text: "sc" })
    NudgeArbiter.register(SID, { source: "budget_reminder", kind: "budget", text: "b" })
    NudgeArbiter.register(SID, { source: "termination_challenge", kind: "confirm_done", text: "t" })
    expect(NudgeArbiter.take(SID)?.source).toBe("termination_challenge")
  })
})
// altimate_change end

describe("NudgeArbiter one-directive-per-turn contract", () => {
  test("take() returns exactly one directive and clears ALL pending — losers are dropped", () => {
    NudgeArbiter.register(SID, { source: "starvation_breaker", kind: "starvation", text: "s" })
    NudgeArbiter.register(SID, { source: "budget_reminder", kind: "budget", text: "b" })
    const winner = NudgeArbiter.take(SID)
    expect(winner).toBeDefined()
    // Nothing left for the same injected turn — a second take yields nothing.
    expect(NudgeArbiter.take(SID)).toBeUndefined()
    expect(NudgeArbiter.pending(SID)).toHaveLength(0)
  })

  test("stale callbacks cannot register or clear a newer loop generation", () => {
    const oldGeneration = NudgeArbiter.begin(SID)
    NudgeArbiter.register(SID, { source: "starvation_breaker", kind: "starvation", text: "old" }, oldGeneration)

    const currentGeneration = NudgeArbiter.begin(SID)
    NudgeArbiter.register(SID, { source: "budget_reminder", kind: "budget", text: "current" }, currentGeneration)
    NudgeArbiter.register(SID, { source: "termination_challenge", kind: "confirm_done", text: "stale" }, oldGeneration)
    NudgeArbiter.clear(SID, oldGeneration)

    expect(NudgeArbiter.take(SID, currentGeneration)?.text).toBe("current")
    expect(NudgeArbiter.pending(SID)).toHaveLength(0)
  })

  test("take() on an empty registry returns undefined", () => {
    expect(NudgeArbiter.take(SID)).toBeUndefined()
  })

  test("same source+kind re-registration replaces, not stacks", () => {
    NudgeArbiter.register(SID, { source: "budget_reminder", kind: "budget", text: "old" })
    NudgeArbiter.register(SID, { source: "budget_reminder", kind: "budget", text: "new" })
    expect(NudgeArbiter.pending(SID)).toHaveLength(1)
    expect(NudgeArbiter.take(SID)?.text).toBe("new")
  })

  test("sessions are isolated", () => {
    const other = "ses_arbiter_other"
    NudgeArbiter.clear(other)
    NudgeArbiter.register(SID, { source: "budget_reminder", kind: "budget", text: "mine" })
    expect(NudgeArbiter.take(other)).toBeUndefined()
    expect(NudgeArbiter.take(SID)?.text).toBe("mine")
  })
})

describe("NudgeArbiter injection-site contract (item 1 usage)", () => {
  test("register-then-take at an injection point consumes pending lower-precedence directives", () => {
    // A starvation directive is pending from a previous step; the compaction
    // continue-message injection point registers its termination nudge and takes
    // the winner — the injected turn carries ONE directive and the starvation
    // candidate is consumed, not deferred into the same turn.
    NudgeArbiter.register(SID, { source: "starvation_breaker", kind: "starvation", text: "produce the edit or DONE" })
    NudgeArbiter.register(SID, { source: "termination_challenge", kind: "completion_nudge", text: "three options" })
    const winner = NudgeArbiter.take(SID)
    expect(winner?.kind).toBe("completion_nudge")
    expect(NudgeArbiter.pending(SID)).toHaveLength(0)
  })
})

describe("NudgeArbiter LRU eviction", () => {
  test("eviction removes the least-recently-USED session, not the oldest-created", () => {
    const prefix = "ses_lru_nudge_"
    const directive = { source: "budget_reminder" as const, kind: "budget", text: "d" }
    // Cleanup runs even when an assertion throws — otherwise a failure here
    // leaves 129 sessions in the module-global table and the 128-session bound
    // starts evicting other suites' pending directives.
    try {
      // Fill the table (the 128-session bound) with fresh sessions.
      for (let i = 0; i < 128; i++) NudgeArbiter.register(`${prefix}${i}`, directive)
      // Refresh the OLDEST-created session by using it again.
      NudgeArbiter.register(`${prefix}0`, { ...directive, text: "refreshed" })
      // A new session must evict the least-recently-used (#1), not #0.
      NudgeArbiter.register(`${prefix}new`, directive)
      expect(NudgeArbiter.pending(`${prefix}0`).length).toBeGreaterThan(0)
      expect(NudgeArbiter.pending(`${prefix}1`)).toHaveLength(0)
      expect(NudgeArbiter.pending(`${prefix}new`).length).toBeGreaterThan(0)
    } finally {
      for (let i = 0; i < 128; i++) NudgeArbiter.clear(`${prefix}${i}`)
      NudgeArbiter.clear(`${prefix}new`)
    }
  })
})
