import { describe, test, expect } from "bun:test"
import { CATALOG, ruleMatches, inputFromExample, rawColumnExposures, selectItemColumns } from "../../src/altimate/review/rule-catalog"

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

describe("selectItemColumns", () => {
  const PII = /\b(email|ssn|phone_number|passport)\b/i
  test("ignores tokens inside string literals", () => {
    expect(selectItemColumns("email, 'passport' as kind", PII)).toEqual([
      { column: "email", alias: undefined, line: "email, 'passport' as kind" },
    ])
  })
  test("does not split a select item on a comma inside a literal", () => {
    const line = "email || ',' || phone_number as contact"
    expect(selectItemColumns(line, PII)).toEqual([
      { column: "email", alias: "contact", line },
      { column: "phone_number", alias: "contact", line },
    ])
  })
})

describe("rawColumnExposures", () => {
  const asObject = (m: Map<string, Set<string>>) => Object.fromEntries([...m].map(([k, v]) => [k, [...v].sort()]))
  test("reads the final projection only, not a CTE's own aliases", () => {
    const sql = "with h as (\n  select ssn as contact\n  from customers\n)\nselect c.email as contact from customers c"
    expect(asObject(rawColumnExposures(sql))).toEqual({ contact: ["email"] })
  })
  test("resolves a final column through the CTE it reads, and `*` over a CTE", () => {
    const sql = [
      "with src as (select * from {{ ref('customers') }}),",
      "final as (select id, sha2(phone) as phone, ssn, email as contact from src)",
      "select * from final",
    ].join("\n")
    expect(asObject(rawColumnExposures(sql))).toEqual({ id: ["id"], ssn: ["ssn"], contact: ["email"] })
    expect(asObject(rawColumnExposures("with b as (select email as contact from c) select contact from b"))).toEqual({
      contact: ["email"],
    })
  })
  test("parses a select item whose alias is on another line", () => {
    const sql = "select c.customer_id,\n  c.ssn\n    as tax_ref\nfrom customers c"
    expect(asObject(rawColumnExposures(sql))).toEqual({ customer_id: ["customer_id"], tax_ref: ["ssn"] })
  })
  test("accepts quoted identifiers", () => {
    expect(asObject(rawColumnExposures('select "c"."ssn" as "tax_ref" from customers "c"'))).toEqual({ tax_ref: ["ssn"] })
  })
  test("accepts an alias without AS, and not a trailing keyword", () => {
    const sql = "select c.ssn tax_ref, cast(c.dob as date) dob_day, case when x then y end, sha2(c.email) em from c"
    expect(asObject(rawColumnExposures(sql))).toEqual({ tax_ref: ["ssn"], dob_day: ["dob"] })
  })
  test("names a later set-operation branch by the first branch's position", () => {
    const sql = "select id, ssn as tax_ref from a\nunion all\nselect id, email from b"
    expect(asObject(rawColumnExposures(sql))).toEqual({ id: ["id"], tax_ref: ["email", "ssn"] })
  })
  test("ignores commas and keywords inside literals and comments", () => {
    const sql = "select ssn as a, -- , email as a\n  'x, from y' as b, email as c from t"
    expect(asObject(rawColumnExposures(sql))).toEqual({ a: ["ssn"], c: ["email"] })
  })
})
