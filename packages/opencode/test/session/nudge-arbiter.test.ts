// FINAL harness plan — Global rule 5 unit gates: the nudge arbiter guarantees at
// most ONE system-authored directive block per injected turn, with precedence
// termination_challenge (item 1) > starvation_breaker (item 4) > budget_reminder
// (item 9). Items register candidates; the injection site takes the single winner.
import { beforeEach, describe, expect, test } from "bun:test"
import { NudgeArbiter } from "../../src/session/nudge"

const SID = "ses_arbiter_test"

beforeEach(() => {
  NudgeArbiter.clear(SID)
})

describe("NudgeArbiter precedence (Global rule 5)", () => {
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

describe("NudgeArbiter one-directive-per-turn (Global rule 5)", () => {
  test("take() returns exactly one directive and clears ALL pending — losers are dropped", () => {
    NudgeArbiter.register(SID, { source: "starvation_breaker", kind: "starvation", text: "s" })
    NudgeArbiter.register(SID, { source: "budget_reminder", kind: "budget", text: "b" })
    const winner = NudgeArbiter.take(SID)
    expect(winner).toBeDefined()
    // Nothing left for the same injected turn — a second take yields nothing.
    expect(NudgeArbiter.take(SID)).toBeUndefined()
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
    // Fill the table (the 128-session bound) with fresh sessions.
    for (let i = 0; i < 128; i++) NudgeArbiter.register(`${prefix}${i}`, directive)
    // Refresh the OLDEST-created session by using it again.
    NudgeArbiter.register(`${prefix}0`, { ...directive, text: "refreshed" })
    // A new session must evict the least-recently-used (#1), not #0.
    NudgeArbiter.register(`${prefix}new`, directive)
    expect(NudgeArbiter.pending(`${prefix}0`).length).toBeGreaterThan(0)
    expect(NudgeArbiter.pending(`${prefix}1`)).toHaveLength(0)
    expect(NudgeArbiter.pending(`${prefix}new`).length).toBeGreaterThan(0)
    // Cleanup so this suite leaves no global state behind.
    for (let i = 0; i < 128; i++) NudgeArbiter.clear(`${prefix}${i}`)
    NudgeArbiter.clear(`${prefix}new`)
  })
})
