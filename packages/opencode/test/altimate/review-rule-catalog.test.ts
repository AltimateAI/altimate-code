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
    expect(asObject(rawColumnExposures(sql))).toEqual({ contact: ["customers.email"] })
  })
  test("resolves a final column through the CTE it reads, and `*` over a CTE", () => {
    const sql = [
      "with src as (select * from {{ ref('customers') }}),",
      "final as (select id, sha2(phone) as phone, ssn, email as contact from src)",
      "select * from final",
    ].join("\n")
    expect(asObject(rawColumnExposures(sql))).toEqual({
      id: ["{{ref('customers')}}.id"],
      ssn: ["{{ref('customers')}}.ssn"],
      contact: ["{{ref('customers')}}.email"],
    })
    expect(asObject(rawColumnExposures("with b as (select email as contact from c) select contact from b"))).toEqual({
      contact: ["c.email"],
    })
  })
  test("parses a select item whose alias is on another line", () => {
    const sql = "select c.customer_id,\n  c.ssn\n    as tax_ref\nfrom customers c"
    expect(asObject(rawColumnExposures(sql))).toEqual({ customer_id: ["customers.customer_id"], tax_ref: ["customers.ssn"] })
  })
  test("accepts quoted identifiers", () => {
    expect(asObject(rawColumnExposures('select "c"."ssn" as "tax_ref" from customers "c"'))).toEqual({ tax_ref: ["customers.ssn"] })
  })
  test("accepts an alias without AS, and not a trailing keyword", () => {
    const sql = "select c.ssn tax_ref, cast(c.dob as date) dob_day, case when x then y end, sha2(c.email) em from c"
    expect(asObject(rawColumnExposures(sql))).toEqual({ tax_ref: ["c.ssn"], dob_day: ["c.dob"] })
  })
  test("names a later set-operation branch by the first branch's position", () => {
    const sql = "select id, ssn as tax_ref from a\nunion all\nselect id, email from b"
    expect(asObject(rawColumnExposures(sql))).toEqual({ id: ["a.id", "b.id"], tax_ref: ["a.ssn", "b.email"] })
  })
  test("keeps the source table, so a same-named column from another table is distinct", () => {
    const sql = "select c.ssn, s.ssn as spouse_ssn, schema1.employees.email from customers c, schema1.employees join spouses as s on true"
    expect(asObject(rawColumnExposures(sql))).toEqual({
      ssn: ["customers.ssn"],
      spouse_ssn: ["spouses.ssn"],
      email: ["employees.email"],
    })
  })
  test("resolves a qualifier through its own source only", () => {
    const sql = [
      "with r as (select customer_id, ssn from customers),",
      "k as (select customer_id, sha2(ssn) as ssn from customers)",
      "select r.ssn as a, k.ssn as b, c.ssn as d from r join k on true join customers c on true",
    ].join("\n")
    expect(asObject(rawColumnExposures(sql))).toEqual({ a: ["customers.ssn"], d: ["customers.ssn"] })
    // An unknown qualifier never matches anything: it resolves to a unique ref.
    expect([...(rawColumnExposures("select x.ssn from customers c").get("ssn") ?? [])][0]).toMatch(/^\?\d+\.ssn$/)
  })
  test("resolves through a FROM subquery under its alias", () => {
    expect(asObject(rawColumnExposures("select s.ssn, s.email from (select sha2(ssn) as ssn, email from customers) s"))).toEqual({
      email: ["customers.email"],
    })
    expect(asObject(rawColumnExposures("select ssn from (select * from customers) as s"))).toEqual({ ssn: ["customers.ssn"] })
  })
  test("ignores commas and keywords inside literals and comments", () => {
    const sql = "select ssn as a, -- , email as a\n  'x, from y' as b, email as c from t"
    expect(asObject(rawColumnExposures(sql))).toEqual({ a: ["t.ssn"], c: ["t.email"] })
  })
})
