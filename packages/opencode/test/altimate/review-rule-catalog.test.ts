import { describe, test, expect } from "bun:test"
import { CATALOG, ruleMatches, inputFromExample } from "../../src/altimate/review/rule-catalog"

describe("rule catalog (self-verifying scenario corpus)", () => {
  test("every rule fires on its example and stays clean on its counter", () => {
    const failures: string[] = []
    const seen = new Set<string>()
    for (const rule of CATALOG) {
      if (seen.has(rule.id)) failures.push(`duplicate id: ${rule.id}`)
      seen.add(rule.id)
      const pos = inputFromExample(rule.example, rule.kind ?? "model_sql")
      if (!ruleMatches(rule, pos)) failures.push(`${rule.id}: positive example did NOT fire`)
      if (rule.counter) {
        const neg = inputFromExample(rule.counter, rule.kind ?? "model_sql")
        if (ruleMatches(rule, neg)) failures.push(`${rule.id}: counter-example WRONGLY fired`)
      }
    }
    if (failures.length) throw new Error(`${failures.length} catalog issue(s):\n` + failures.join("\n"))
    expect(failures.length).toBe(0)
  })

  // The large generated families (dialect functions, reserved words, types,
  // operators) moved into the compiled core (L033/L035/review_lexical_scan);
  // this TS catalog now holds only the hand-written structural / dbt rules.
  test("catalog covers the hand-written structural/dbt rules", () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(150)
  })
})
