import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import * as Dispatcher from "../../src/altimate/native/dispatcher"
import { registerAll } from "../../src/altimate/native/altimate-core"
import { formatSemantics } from "../../src/altimate/tools/altimate-core-semantics"

// Pins altimate-core 0.9.0: statements rewritten around table-valued functions have no
// logical plan, and the engine returns allowed:true / valid:true with no findings. The
// native handlers must report that as not evaluated, never as clean.

beforeAll(() => {
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
  registerAll()
})
afterAll(() => {
  delete process.env.ALTIMATE_TELEMETRY_DISABLED
})

const schema_context = {
  version: "1",
  dialect: "generic",
  database: null,
  schema_name: null,
  tables: { t: { columns: [{ name: "id", type: "INT" }, { name: "name", type: "VARCHAR" }] } },
}
const policy_json = JSON.stringify({ rules: [] })
const TVF_QUERIES = [
  "SELECT * FROM TABLE(my_fn())",
  "SELECT * FROM t, LATERAL FLATTEN(input => t.name)",
  "SELECT * FROM read_csv('x')",
]

describe("altimate_core.policy fails closed when no plan is available", () => {
  for (const sql of TVF_QUERIES) {
    test(`not allowed: ${sql}`, async () => {
      const r = await Dispatcher.call("altimate_core.policy", { sql, policy_json, schema_context })
      expect(r.data.allowed).toBe(false)
      expect(r.data.policy_skipped).toBe(true)
      const violations = r.data.violations as Array<{ rule: string; message: string }>
      expect(violations.some((v) => v.rule === "policy_not_evaluated")).toBe(true)
      expect(violations.find((v) => v.rule === "policy_not_evaluated")?.message).toContain("treated as blocked")
    })
  }

  test("a normal query is unaffected", async () => {
    const r = await Dispatcher.call("altimate_core.policy", { sql: "SELECT id FROM t", policy_json, schema_context })
    expect(r.data.allowed).toBe(true)
    expect(r.data.policy_skipped).toBeUndefined()
    expect(r.data.violations).toEqual([])
  })
})

describe("altimate_core.semantics reports skipped analysis", () => {
  for (const sql of TVF_QUERIES) {
    test(`skipped: ${sql}`, async () => {
      const r = await Dispatcher.call("altimate_core.semantics", { sql, schema_context })
      expect(r.data.skipped).toBe(true)
      expect(String(r.data.skip_reason)).toContain("semantic analysis skipped")
    })
  }

  test("a normal query is unaffected", async () => {
    const r = await Dispatcher.call("altimate_core.semantics", { sql: "SELECT id FROM t", schema_context })
    expect(r.data.skipped).toBeUndefined()
    expect(formatSemantics(r.data)).toBe("No semantic issues found.")
  })
})
