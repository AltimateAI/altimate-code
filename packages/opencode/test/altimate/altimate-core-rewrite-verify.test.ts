/**
 * Tests for the verified-optimize tool: rewrite -> prove-equivalent -> gate.
 *
 * The load-bearing property is the GATE: a rewrite may be reported VERIFIED only
 * when the equivalence engine affirmatively returns `equivalent === true`. Any
 * other verdict (false, undefined, truthy-but-not-true, error, or no schema) MUST
 * land in the unverified bucket — otherwise the tool could promise "safe to apply"
 * on a rewrite that changes results. The adversarial block below pins that.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test"
import * as Dispatcher from "../../src/altimate/native/dispatcher"
// Import the native index so its setRegistrationHook() runs NOW (before beforeAll).
// Otherwise the lazy hook is armed only when the tool first imports ../native
// mid-test, then fires on the next call and overwrites our mocks with the real
// handlers. Arming it up front lets beforeAll's __trigger_hook__ fire+disarm it.
import "../../src/altimate/native"

beforeAll(async () => {
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
  try {
    await Dispatcher.call("__trigger_hook__" as any, {} as any)
  } catch {}
})
afterAll(() => {
  delete process.env.ALTIMATE_TELEMETRY_DISABLED
})

function stubCtx(): any {
  return {
    sessionID: "test",
    messageID: "test",
    agent: "test",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
  }
}

const SCHEMA = { customers: { customer_id: "INTEGER", first_name: "VARCHAR" } }
const ORIGINAL = "SELECT customer_id FROM (SELECT * FROM customers) s WHERE customer_id = 1"
const REWRITE = "SELECT customer_id FROM customers WHERE customer_id = 1"

// Exercise altimate_core_rewrite in VERIFY mode (verify_equivalence: true) — the
// verified-optimization path folded into the rewrite tool.
async function runTool(args: any) {
  const { AltimateCoreRewriteTool } = await import("../../src/altimate/tools/altimate-core-rewrite")
  const tool = await AltimateCoreRewriteTool.init()
  return tool.execute({ ...args, verify_equivalence: true }, stubCtx())
}

// Register a rewrite handler that returns one candidate rewrite, and an
// equivalence handler with the given verdict.
function mockRewriteAndEquivalence(rewrittenSql: string | undefined, equivalence: any) {
  Dispatcher.register("altimate_core.rewrite" as any, async () => ({
    success: true,
    data: rewrittenSql
      ? {
          original_sql: ORIGINAL,
          rewritten_sql: rewrittenSql,
          suggestions: [{ rule: "FLATTEN_SUBQUERY", rewritten_sql: rewrittenSql }],
        }
      : { original_sql: ORIGINAL, suggestions: [] },
  }))
  Dispatcher.register("altimate_core.equivalence" as any, async () => ({ success: true, data: equivalence }))
}

describe("verified-optimize — gate logic (mocked engine)", () => {
  beforeEach(() => Dispatcher.reset())

  test("proven-equivalent rewrite is VERIFIED", async () => {
    mockRewriteAndEquivalence(REWRITE, { equivalent: true, confidence: 1 })
    const r = await runTool({ sql: ORIGINAL, schema_context: SCHEMA })
    expect(r.metadata.verified_count).toBe(1)
    expect(r.metadata.unverified_count).toBe(0)
    expect(String(r.output)).toContain("VERIFIED-EQUIVALENT")
    expect(String(r.output)).toContain(REWRITE)
  })

  test("not-equivalent rewrite is UNVERIFIED with a reason", async () => {
    mockRewriteAndEquivalence(REWRITE, {
      equivalent: false,
      confidence: 0.5,
      differences: [{ description: "filters differ" }],
    })
    const r = await runTool({ sql: ORIGINAL, schema_context: SCHEMA })
    expect(r.metadata.verified_count).toBe(0)
    expect(r.metadata.unverified_count).toBe(1)
    expect(String(r.output)).toContain("UNVERIFIED")
    expect(String(r.output)).toContain("filters differ")
  })

  test("no schema -> rewrite returned but UNVERIFIED (equivalence not attempted)", async () => {
    let equivalenceCalled = false
    Dispatcher.register("altimate_core.rewrite" as any, async () => ({
      success: true,
      data: { rewritten_sql: REWRITE, suggestions: [] },
    }))
    Dispatcher.register("altimate_core.equivalence" as any, async () => {
      equivalenceCalled = true
      return { success: true, data: { equivalent: true } }
    })
    const r = await runTool({ sql: ORIGINAL }) // no schema
    expect(r.metadata.has_schema).toBe(false)
    expect(r.metadata.verified_count).toBe(0)
    expect(r.metadata.unverified_count).toBe(1)
    expect(equivalenceCalled).toBe(false) // never claim verified without a schema
    expect(String(r.output)).toContain("no schema")
  })

  test("no-op rewrite (identical to original) is filtered out", async () => {
    mockRewriteAndEquivalence(ORIGINAL, { equivalent: true })
    const r = await runTool({ sql: ORIGINAL, schema_context: SCHEMA })
    expect(r.metadata.verified_count).toBe(0)
    expect(r.metadata.unverified_count).toBe(0)
    expect(String(r.output)).toContain("No optimizations")
  })

  test("no suggestions -> no optimizations", async () => {
    mockRewriteAndEquivalence(undefined, { equivalent: true })
    const r = await runTool({ sql: ORIGINAL, schema_context: SCHEMA })
    expect(r.metadata.verified_count).toBe(0)
    expect(String(r.output)).toContain("No optimizations")
  })

  test("rewrite-engine error -> error result, never a false verified", async () => {
    Dispatcher.register("altimate_core.rewrite" as any, async () => ({ success: false, error: "engine down" }))
    const r = await runTool({ sql: ORIGINAL, schema_context: SCHEMA })
    expect(r.metadata.success).toBe(false)
    expect(r.metadata.verified_count).toBe(0)
    expect(String(r.output)).toContain("engine down")
  })

  test("success:false with EMPTY error -> still treated as failure (no fall-through)", async () => {
    // Regression: a `{ success: false, error: "" }` payload must not fall through
    // to the success path and misreport rewrites.
    Dispatcher.register("altimate_core.rewrite" as any, async () => ({ success: false, error: "" }))
    const r = await runTool({ sql: ORIGINAL, schema_context: SCHEMA })
    expect(r.metadata.success).toBe(false)
    expect(r.metadata.verified_count).toBe(0)
    expect(String(r.output)).toContain("Failed to generate rewrites")
  })

  test("dedup preserves case-sensitive literals (does NOT case-fold)", async () => {
    // Two rewrites differing only by a string-literal case are DISTINCT and must
    // both be verified — not collapsed into one by case-folding.
    const rwA = "SELECT id FROM t WHERE name = 'A'"
    const rwB = "SELECT id FROM t WHERE name = 'a'"
    Dispatcher.register("altimate_core.rewrite" as any, async () => ({
      success: true,
      data: { suggestions: [{ rewritten_sql: rwA }, { rewritten_sql: rwB }] },
    }))
    Dispatcher.register("altimate_core.equivalence" as any, async () => ({ success: true, data: { equivalent: true } }))
    const r = await runTool({ sql: "SELECT id FROM t", schema_context: SCHEMA })
    // Both candidates survive dedup and get verified (2, not 1).
    expect(r.metadata.verified_count).toBe(2)
  })

  test("duplicate candidates are de-duplicated", async () => {
    Dispatcher.register("altimate_core.rewrite" as any, async () => ({
      success: true,
      data: {
        rewritten_sql: REWRITE,
        suggestions: [{ rewritten_sql: REWRITE }, { rewritten_sql: "  " + REWRITE + "  " }],
      },
    }))
    Dispatcher.register("altimate_core.equivalence" as any, async () => ({ success: true, data: { equivalent: true } }))
    const r = await runTool({ sql: ORIGINAL, schema_context: SCHEMA })
    expect(r.metadata.verified_count).toBe(1) // not 3
  })

  test("mixed: one verified + one unverified", async () => {
    const r2 = "SELECT customer_id FROM customers WHERE customer_id = 2"
    Dispatcher.register("altimate_core.rewrite" as any, async () => ({
      success: true,
      data: { suggestions: [{ rewritten_sql: REWRITE }, { rewritten_sql: r2 }] },
    }))
    Dispatcher.register("altimate_core.equivalence" as any, async (p: any) => ({
      success: true,
      data: { equivalent: p.sql2 === REWRITE }, // only the first is equivalent
    }))
    const r = await runTool({ sql: ORIGINAL, schema_context: SCHEMA })
    expect(r.metadata.verified_count).toBe(1)
    expect(r.metadata.unverified_count).toBe(1)
  })

  test("partial success: one succeeds, one throws, remaining checked -> returns all results", async () => {
    const r2 = "SELECT customer_id FROM customers WHERE customer_id = 2"
    const r3 = "SELECT customer_id FROM customers WHERE customer_id = 3"
    Dispatcher.register("altimate_core.rewrite" as any, async () => ({
      success: true,
      data: { suggestions: [{ rewritten_sql: REWRITE }, { rewritten_sql: r2 }, { rewritten_sql: r3 }] },
    }))
    let callCount = 0
    Dispatcher.register("altimate_core.equivalence" as any, async () => {
      callCount++
      if (callCount === 1) return { success: true, data: { equivalent: true } }
      if (callCount === 2) throw new Error("equiv boom")
      return { success: true, data: { equivalent: false } }
    })
    const r = await runTool({ sql: ORIGINAL, schema_context: SCHEMA })
    expect(r.metadata.verified_count).toBe(1)
    expect(r.metadata.unverified_count).toBe(2)
    expect(r.metadata.success).toBe(true)
    expect(String(r.output)).toContain(REWRITE)
    expect(String(r.output)).toContain("equiv boom")
  })
})

describe("verified-optimize — ADVERSARIAL: gate only trusts strict equivalent===true", () => {
  beforeEach(() => Dispatcher.reset())
  // Anything other than the boolean true must NOT be reported as verified.
  for (const [label, verdict] of [
    ["string 'true'", "true"],
    ["number 1", 1],
    ["undefined", undefined],
    ["null", null],
    ["object truthy", {}],
  ] as [string, any][]) {
    test(`equivalent=${label} -> UNVERIFIED (never trusted)`, async () => {
      mockRewriteAndEquivalence(REWRITE, { equivalent: verdict })
      const r = await runTool({ sql: ORIGINAL, schema_context: SCHEMA })
      expect(r.metadata.verified_count).toBe(0)
      expect(r.metadata.unverified_count).toBe(1)
    })
  }

  test("equivalence handler throws -> tool fails safe (no verified), does not crash", async () => {
    Dispatcher.register("altimate_core.rewrite" as any, async () => ({
      success: true,
      data: { rewritten_sql: REWRITE, suggestions: [] },
    }))
    Dispatcher.register("altimate_core.equivalence" as any, async () => {
      throw new Error("equiv boom")
    })
    const r = await runTool({ sql: ORIGINAL, schema_context: SCHEMA })
    expect(r.metadata.verified_count).toBe(0)
    expect(typeof r.output).toBe("string")
  })

  test("missing 'equivalent' field -> UNVERIFIED with clear error", async () => {
    mockRewriteAndEquivalence(REWRITE, { differences: [] })
    const r = await runTool({ sql: ORIGINAL, schema_context: SCHEMA })
    expect(r.metadata.verified_count).toBe(0)
    expect(r.metadata.unverified_count).toBe(1)
    expect(String(r.output)).toContain("missing 'equivalent' field")
  })

  test("non-boolean 'equivalent' value -> UNVERIFIED with type error", async () => {
    mockRewriteAndEquivalence(REWRITE, { equivalent: "yes" })
    const r = await runTool({ sql: ORIGINAL, schema_context: SCHEMA })
    expect(r.metadata.verified_count).toBe(0)
    expect(r.metadata.unverified_count).toBe(1)
    expect(String(r.output)).toContain("non-boolean 'equivalent' value")
  })
})

// --- real engine integration (skips if altimate-core native binary absent) ----
let coreAvailable = false
try {
  require.resolve("@altimateai/altimate-core")
  coreAvailable = true
} catch {}
const describeIf = coreAvailable ? describe : describe.skip

describeIf("verified-optimize — real altimate-core integration", () => {
  beforeAll(async () => {
    process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
    const core = await import("../../src/altimate/native/altimate-core")
    const sql = await import("../../src/altimate/native/sql/register")
    core.registerAll()
    sql.registerAllSql()
  })

  test("runs end-to-end and returns a well-formed, internally-consistent result", async () => {
    const r = await runTool({
      sql: "SELECT customer_id, first_name FROM customers WHERE customer_id = 1",
      schema_context: SCHEMA,
    })
    expect(typeof r.output).toBe("string")
    expect(r.metadata.has_schema).toBe(true)
    expect(typeof r.metadata.verified_count).toBe("number")
    expect(typeof r.metadata.unverified_count).toBe("number")
    // Counts must be non-negative and the title must reflect them.
    expect(r.metadata.verified_count).toBeGreaterThanOrEqual(0)
    expect(r.metadata.unverified_count).toBeGreaterThanOrEqual(0)
    expect(r.title).toContain("Rewrite") // "Rewrite (verified): …" or "Rewrite: no rewrites"
  })
})
