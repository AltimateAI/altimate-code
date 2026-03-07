import { describe, expect, test } from "bun:test"
import { SessionCompaction } from "../../src/session/compaction"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import type { Provider } from "../../src/provider/provider"

Log.init({ print: false })

// ─── Compaction Loop Protection State Machine ─────────────────────────
// These tests validate the compaction attempt counter logic from prompt.ts.
// The counter protects against infinite compact→overflow→compact loops.
//
// State machine rules (from prompt.ts):
//   1. On overflow detection (before processing):  compactionAttempts++
//   2. On processor returning "compact" (after):   compactionAttempts++
//   3. On processor returning "continue" (after):  compactionAttempts = 0
//   4. On compactionAttempts > MAX (3):            error + break
//
// The Sentry fix (rule 3) ensures the counter doesn't accumulate across
// unrelated turns that each happen to need compaction.

const MAX_COMPACTION_ATTEMPTS = 3

type LoopEvent =
  | { type: "overflow" }            // isOverflow() returned true
  | { type: "compact" }             // processor.process() returned "compact"
  | { type: "continue" }            // processor.process() returned "continue"
  | { type: "stop" }                // processor.process() returned "stop"
  | { type: "compaction_task" }     // pending compaction task in queue

type LoopOutcome =
  | { action: "compact"; attempts: number }
  | { action: "continue_reset"; attempts: 0 }
  | { action: "stop" }
  | { action: "max_exceeded"; attempts: number }

/**
 * Simulates the compaction counter state machine from prompt.ts loop().
 * This mirrors the exact control flow at lines 538-784.
 */
function simulateLoop(events: LoopEvent[]): {
  compactionAttempts: number
  outcomes: LoopOutcome[]
  terminated: boolean
  terminationReason?: "stop" | "max_exceeded"
} {
  let compactionAttempts = 0
  const outcomes: LoopOutcome[] = []
  let terminated = false
  let terminationReason: "stop" | "max_exceeded" | undefined

  for (const event of events) {
    if (terminated) break

    switch (event.type) {
      // Pending compaction task — processed but doesn't affect counter
      case "compaction_task":
        // In prompt.ts this does SessionCompaction.process() then continue
        // Does NOT touch compactionAttempts
        break

      // Overflow detected before normal processing (lines 551-582)
      case "overflow":
        compactionAttempts++
        if (compactionAttempts > MAX_COMPACTION_ATTEMPTS) {
          outcomes.push({ action: "max_exceeded", attempts: compactionAttempts })
          terminated = true
          terminationReason = "max_exceeded"
        } else {
          outcomes.push({ action: "compact", attempts: compactionAttempts })
        }
        break

      // Processor returned "compact" (lines 758-783)
      case "compact":
        compactionAttempts++
        if (compactionAttempts > MAX_COMPACTION_ATTEMPTS) {
          outcomes.push({ action: "max_exceeded", attempts: compactionAttempts })
          terminated = true
          terminationReason = "max_exceeded"
        } else {
          outcomes.push({ action: "compact", attempts: compactionAttempts })
        }
        break

      // Processor returned "continue" (lines 752-757)
      case "continue":
        compactionAttempts = 0
        outcomes.push({ action: "continue_reset", attempts: 0 })
        break

      // Processor returned "stop" (line 751)
      case "stop":
        outcomes.push({ action: "stop" })
        terminated = true
        terminationReason = "stop"
        break
    }
  }

  return { compactionAttempts, outcomes, terminated, terminationReason }
}

describe("session.prompt compaction loop protection", () => {
  // ─── Basic counter behavior ──────────────────────────────────────────

  test("counter starts at 0", () => {
    const { compactionAttempts } = simulateLoop([])
    expect(compactionAttempts).toBe(0)
  })

  test("single compact increments counter to 1", () => {
    const { compactionAttempts, outcomes } = simulateLoop([
      { type: "compact" },
    ])
    expect(compactionAttempts).toBe(1)
    expect(outcomes[0]).toEqual({ action: "compact", attempts: 1 })
  })

  test("consecutive compacts increment counter", () => {
    const { compactionAttempts } = simulateLoop([
      { type: "compact" },
      { type: "compact" },
    ])
    expect(compactionAttempts).toBe(2)
  })

  test("3 consecutive compacts are allowed (counter = 3, which is <= MAX)", () => {
    const { compactionAttempts, terminated } = simulateLoop([
      { type: "compact" },
      { type: "compact" },
      { type: "compact" },
    ])
    expect(compactionAttempts).toBe(3)
    expect(terminated).toBe(false)
  })

  test("4th consecutive compact exceeds MAX and terminates", () => {
    const result = simulateLoop([
      { type: "compact" },
      { type: "compact" },
      { type: "compact" },
      { type: "compact" },
    ])
    expect(result.terminated).toBe(true)
    expect(result.terminationReason).toBe("max_exceeded")
    expect(result.compactionAttempts).toBe(4)
    expect(result.outcomes[3]).toEqual({ action: "max_exceeded", attempts: 4 })
  })

  // ─── Counter reset on "continue" (the Sentry fix) ───────────────────

  test("continue resets counter to 0", () => {
    const { compactionAttempts, outcomes } = simulateLoop([
      { type: "compact" },
      { type: "compact" },
      { type: "continue" },
    ])
    expect(compactionAttempts).toBe(0)
    expect(outcomes[2]).toEqual({ action: "continue_reset", attempts: 0 })
  })

  test("counter resets between successful turns — the Sentry bug fix", () => {
    // Scenario: user sends 4 messages, each triggering one compaction,
    // with a successful processing step between each.
    // Without the fix: counter reaches 4 and errors on the 4th turn.
    // With the fix: counter resets to 0 after each "continue".
    const result = simulateLoop([
      { type: "compact" },     // turn 1: compaction (attempts=1)
      { type: "continue" },    // turn 1: success (attempts=0)
      { type: "compact" },     // turn 2: compaction (attempts=1)
      { type: "continue" },    // turn 2: success (attempts=0)
      { type: "compact" },     // turn 3: compaction (attempts=1)
      { type: "continue" },    // turn 3: success (attempts=0)
      { type: "compact" },     // turn 4: compaction (attempts=1)
      { type: "continue" },    // turn 4: success (attempts=0)
    ])
    expect(result.terminated).toBe(false)
    expect(result.compactionAttempts).toBe(0)
  })

  test("counter resets allow many compactions across session lifetime", () => {
    // 10 turns, each needing compaction then succeeding
    const events: LoopEvent[] = []
    for (let i = 0; i < 10; i++) {
      events.push({ type: "compact" })
      events.push({ type: "continue" })
    }
    const result = simulateLoop(events)
    expect(result.terminated).toBe(false)
    expect(result.compactionAttempts).toBe(0)
  })

  // ─── Overflow detection path ─────────────────────────────────────────

  test("overflow events also increment counter", () => {
    const { compactionAttempts } = simulateLoop([
      { type: "overflow" },
    ])
    expect(compactionAttempts).toBe(1)
  })

  test("overflow and compact share the same counter", () => {
    const { compactionAttempts } = simulateLoop([
      { type: "overflow" },
      { type: "compact" },
    ])
    expect(compactionAttempts).toBe(2)
  })

  test("mixed overflow and compact exceeds MAX on 4th total", () => {
    const result = simulateLoop([
      { type: "overflow" },   // 1
      { type: "compact" },    // 2
      { type: "overflow" },   // 3
      { type: "compact" },    // 4 — exceeds
    ])
    expect(result.terminated).toBe(true)
    expect(result.terminationReason).toBe("max_exceeded")
    expect(result.compactionAttempts).toBe(4)
  })

  test("continue resets counter from overflow-incremented state", () => {
    const result = simulateLoop([
      { type: "overflow" },    // 1
      { type: "overflow" },    // 2
      { type: "continue" },   // reset to 0
      { type: "overflow" },    // 1
      { type: "overflow" },    // 2
      { type: "overflow" },    // 3
    ])
    expect(result.terminated).toBe(false)
    expect(result.compactionAttempts).toBe(3)
  })

  // ─── Stop behavior ──────────────────────────────────────────────────

  test("stop terminates loop regardless of counter", () => {
    const result = simulateLoop([
      { type: "compact" },
      { type: "stop" },
    ])
    expect(result.terminated).toBe(true)
    expect(result.terminationReason).toBe("stop")
    expect(result.compactionAttempts).toBe(1)
  })

  test("events after stop are ignored", () => {
    const result = simulateLoop([
      { type: "stop" },
      { type: "compact" },
      { type: "compact" },
      { type: "compact" },
      { type: "compact" },
    ])
    expect(result.terminated).toBe(true)
    expect(result.terminationReason).toBe("stop")
    expect(result.compactionAttempts).toBe(0)
  })

  test("events after max_exceeded are ignored", () => {
    const result = simulateLoop([
      { type: "compact" },
      { type: "compact" },
      { type: "compact" },
      { type: "compact" },  // exceeds
      { type: "continue" }, // should NOT reset — already terminated
    ])
    expect(result.terminated).toBe(true)
    expect(result.compactionAttempts).toBe(4)
  })

  // ─── Compaction task path (no counter effect) ─────────────────────────

  test("compaction_task does not affect counter", () => {
    const result = simulateLoop([
      { type: "compaction_task" },
      { type: "compaction_task" },
      { type: "compaction_task" },
    ])
    expect(result.compactionAttempts).toBe(0)
    expect(result.terminated).toBe(false)
  })

  test("compaction_task interspersed with compacts does not affect counter", () => {
    const result = simulateLoop([
      { type: "compact" },
      { type: "compaction_task" },
      { type: "compact" },
      { type: "compaction_task" },
    ])
    expect(result.compactionAttempts).toBe(2)
  })

  // ─── Complex realistic scenarios ──────────────────────────────────────

  test("realistic: long session with periodic compactions and processing", () => {
    // Simulates a real session: user sends messages, some trigger compaction,
    // processing succeeds, then user sends more messages
    const result = simulateLoop([
      // Turn 1: normal
      { type: "continue" },
      // Turn 2: overflow detected, compaction, then success
      { type: "overflow" },
      { type: "continue" },
      // Turn 3: normal
      { type: "continue" },
      // Turn 4: processor hit overflow mid-stream
      { type: "compact" },
      { type: "continue" },
      // Turn 5: normal
      { type: "continue" },
      // Turn 6: another overflow
      { type: "overflow" },
      { type: "continue" },
    ])
    expect(result.terminated).toBe(false)
    expect(result.compactionAttempts).toBe(0)
  })

  test("realistic: tight compact loop within single turn triggers protection", () => {
    // Same turn keeps compacting but context never shrinks enough
    const result = simulateLoop([
      { type: "compact" },    // 1
      { type: "compact" },    // 2
      { type: "compact" },    // 3
      { type: "compact" },    // 4 — triggers protection
    ])
    expect(result.terminated).toBe(true)
    expect(result.terminationReason).toBe("max_exceeded")
  })

  test("realistic: 2 compacts then success, then another 2 compacts then success — no error", () => {
    const result = simulateLoop([
      { type: "compact" },    // 1
      { type: "compact" },    // 2
      { type: "continue" },   // reset
      { type: "compact" },    // 1
      { type: "compact" },    // 2
      { type: "continue" },   // reset
    ])
    expect(result.terminated).toBe(false)
    expect(result.compactionAttempts).toBe(0)
  })

  test("realistic: 3 compacts (at max) then success — recovers", () => {
    const result = simulateLoop([
      { type: "compact" },    // 1
      { type: "compact" },    // 2
      { type: "compact" },    // 3 (at limit, but <= MAX so allowed)
      { type: "continue" },   // reset to 0
      { type: "compact" },    // 1 (fresh counter)
    ])
    expect(result.terminated).toBe(false)
    expect(result.compactionAttempts).toBe(1)
  })

  test("outcome log tracks all state transitions", () => {
    const result = simulateLoop([
      { type: "compact" },
      { type: "continue" },
      { type: "overflow" },
      { type: "stop" },
    ])
    expect(result.outcomes).toEqual([
      { action: "compact", attempts: 1 },
      { action: "continue_reset", attempts: 0 },
      { action: "compact", attempts: 1 },
      { action: "stop" },
    ])
  })
})

// ─── isOverflow edge cases for loop protection integration ────────────
// These test boundary conditions that would affect when compaction triggers.

function createModel(opts: {
  context: number
  output: number
  input?: number
}): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: {
      context: opts.context,
      input: opts.input,
      output: opts.output,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

describe("session.compaction.isOverflow boundary conditions", () => {
  test("tokens exactly at usable limit triggers overflow", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // context=100K, output=32K → headroom = max(20K, 32K) = 32K → usable = 68K
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 68_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(true)
      },
    })
  })

  test("tokens 1 below usable limit does not trigger overflow", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 100_000, output: 32_000 })
        // headroom = max(20K, 32K) = 32K → usable = 68K; count = 67999
        const tokens = { input: 67_999, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(false)
      },
    })
  })

  test("uses total when available instead of component sum", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 100_000, output: 32_000 })
        // headroom = max(20K, 32K) = 32K → usable = 68K
        // total=70K > usable=68K → overflow
        // component sum would be 10K (not overflow) — total should take precedence
        const tokens = {
          input: 5_000, output: 5_000, reasoning: 0,
          cache: { read: 0, write: 0 },
          total: 70_000,
        }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(true)
      },
    })
  })

  test("includes all token components in sum when total is absent", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 100_000, output: 32_000 })
        // headroom = max(20K, 32K) = 32K → usable = 68K
        // sum = 30K + 10K + 20K + 15K = 75K > usable 68K
        const tokens = {
          input: 30_000, output: 10_000, reasoning: 0,
          cache: { read: 20_000, write: 15_000 },
        }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(true)
      },
    })
  })

  test("with limit.input: reserved is max(buffer, maxOutput)", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // input=200K, output=32K → reserved=max(20K,32K)=32K → usable=200K-32K=168K
        const model = createModel({ context: 200_000, input: 200_000, output: 32_000 })
        const tokens = { input: 168_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(true)
      },
    })
  })

  test("with limit.input and small output: buffer takes precedence", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // input=100K, output=5K → reserved=max(20K,5K)=20K → usable=100K-20K=80K
        const model = createModel({ context: 200_000, input: 100_000, output: 5_000 })
        const tokens = { input: 80_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(true)
      },
    })
  })

  test("custom reserved config overrides default buffer", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          `${dir}/opencode.json`,
          JSON.stringify({ compaction: { reserved: 50_000 } }),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // context=200K, output=32K, reserved=50K → headroom=max(50K,32K)=50K → usable=150K
        const model = createModel({ context: 200_000, output: 32_000 })
        // 151K > 150K → overflow
        const tokens = { input: 151_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(true)
      },
    })
  })

  test("custom reserved config with limit.input", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          `${dir}/opencode.json`,
          JSON.stringify({ compaction: { reserved: 50_000 } }),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // input=200K, output=32K, reserved=50K → headroom=max(50K,32K)=50K → usable=150K
        const model = createModel({ context: 200_000, input: 200_000, output: 32_000 })
        // 151K > 150K → overflow
        const tokens = { input: 151_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(true)
      },
    })
  })

  test("returns false when headroom exceeds base (negative usable guard)", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Tiny model: input=32K, output=128K → headroom=128K > base=32K
        // Without guard this would produce negative usable and always trigger
        const model = createModel({ context: 200_000, input: 32_000, output: 128_000 })
        const tokens = { input: 1_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(false)
      },
    })
  })

  test("returns false when headroom equals base exactly", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // headroom = max(20K, 32K) = 32K, base = 32K → usable = 0
        const model = createModel({ context: 32_000, output: 32_000 })
        const tokens = { input: 1_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(false)
      },
    })
  })

  test("compaction disabled via prune config still allows isOverflow", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          `${dir}/opencode.json`,
          JSON.stringify({ compaction: { prune: false } }),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 75_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }
        // prune:false only disables prune(), not isOverflow()
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(true)
      },
    })
  })
})

describe("session.compaction.prune with disabled config", () => {
  test("prune does not throw when prune config is false", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          `${dir}/opencode.json`,
          JSON.stringify({ compaction: { prune: false } }),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Should return early without error
        await SessionCompaction.prune({ sessionID: "nonexistent" })
      },
    })
  })
})
