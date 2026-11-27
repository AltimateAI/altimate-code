import { describe, test, expect } from "bun:test"
import {
  CATALOG,
  ruleMatches,
  inputFromExample,
  finalOutputs,
  rawColumnExposures,
  refCovered,
  selectItemColumns,
  selectItems,
  ROOT_SCOPE,
} from "../../src/altimate/review/rule-catalog"

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
  test("reads the alias as the select-list parser does: implicit, quoted, after a call", () => {
    expect(selectItemColumns("c.ssn tax_ref,", PII)).toEqual([{ column: "ssn", alias: "tax_ref", line: "c.ssn tax_ref," }])
    expect(selectItemColumns('c.ssn as "Tax Ref"', PII)).toEqual([{ column: "ssn", alias: "tax ref", line: 'c.ssn as "Tax Ref"' }])
    expect(selectItemColumns("cast(c.ssn as varchar) as tax_ref", PII)[0].alias).toBe("tax_ref")
    expect(selectItemColumns("case when x then ssn end,", PII)[0].alias).toBeUndefined()
  })
  test("collects no tokens from clause text after the select list", () => {
    expect(selectItemColumns("email from ssn", PII)).toEqual([{ column: "email", alias: undefined, line: "email from ssn" }])
    expect(selectItemColumns("email from t where ssn is not null", PII).map((c) => c.column)).toEqual(["email"])
    // A keyword inside a call is not a clause; a later `select` resumes the list.
    expect(selectItemColumns("extract(year from passport) as y", PII).map((c) => c.column)).toEqual(["passport"])
    expect(selectItemColumns("email from a union all select ssn from b", PII).map((c) => c.column)).toEqual(["email", "ssn"])
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
      email: ["schema1.employees.email"],
    })
  })
  test("keeps the database and schema in the source identity", () => {
    expect(asObject(rawColumnExposures("select ssn from restricted.customers"))).toEqual({ ssn: ["restricted.customers.ssn"] })
    expect(asObject(rawColumnExposures("select ssn from public.customers"))).toEqual({ ssn: ["public.customers.ssn"] })
    expect(asObject(rawColumnExposures('select c.ssn, customers.email from "DB"."Public"."Customers" c, raw.customers'))).toEqual({
      ssn: ["db.public.customers.ssn"],
      email: ["raw.customers.email"],
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
  test("only a plain `*` passes columns through; `* except (…)` does not", () => {
    expect(finalOutputs("select * from customers").passthrough).toBe(true)
    expect(finalOutputs("select c.* from customers c").passthrough).toBe(true)
    expect(finalOutputs("select * except (ssn) from customers").passthrough).toBe(false)
  })
  test("a CTE with a column list is still a CTE: a renamed column resolves to nothing known", () => {
    const sql = "with m (id, tax) as (select customer_id, ssn from customers)\nselect tax as ssn from m"
    expect([...(rawColumnExposures(sql).get("ssn") ?? [])][0]).toMatch(/^\?\d+\.tax$/)
  })
  test("a CTE named `final` is a CTE, not the model's output", () => {
    // The outer `b` is the output; the CTE outputs no `b`, so it resolves to nothing known.
    const lost = finalOutputs("with final as (select a from t) select b from final")
    expect([...lost.names]).toEqual(["b"])
    expect([...lost.raw.keys()]).toEqual(["b"])
    expect([...lost.raw.get("b")!][0]).toMatch(/^\?\d+\.b$/)
    // Masked in the CTE, selected by name or through `*`: nothing raw.
    const masked = "with final as (select id, md5(email) as email from customers) select id, email from final"
    expect(asObject(rawColumnExposures(masked))).toEqual({ id: ["customers.id"] })
    expect(asObject(rawColumnExposures(masked.replace("select id, email from final", "select * from final")))).toEqual({
      id: ["customers.id"],
    })
    // Masked in the outer list: nothing raw, and the outer names are the outputs.
    const outer = "with final as (select id, email from customers) select id, md5(email) as email_hash from final"
    expect(asObject(rawColumnExposures(outer))).toEqual({ id: ["customers.id"] })
    expect([...finalOutputs(outer).names].sort()).toEqual(["email_hash", "id"])
  })
  test("`reads` lists the source columns a computed output is built from", () => {
    const sql = [
      "with k as (select customer_id, sha2(ssn) as ssn from customers)",
      "select lower(s.ssn) as a,",
      "  case when c.active is not null then cast(c.email as varchar(20)) else 'n/a' end as b,",
      "  first_value(c.phone) over (partition by c.customer_id order by c.updated_at) as d,",
      "  upper(k.ssn) as e, 'x' as f",
      "from customers c join spouses s on true join k on true",
    ].join("\n")
    const reads = Object.fromEntries([...finalOutputs(sql).reads].map(([k, v]) => [k, [...v].sort()]))
    expect(reads).toEqual({
      a: ["spouses.ssn"],
      b: ["customers.active", "customers.email"],
      d: ["customers.phone"],
      e: ["customers.ssn"],
      f: [],
    })
  })
  test("`reads` keeps columns named like soft keywords and array `filter(…)` arguments", () => {
    const sql = [
      "select first_value(c.last) over (order by c.ts nulls last) as a,",
      "  concat(time, ' ', zone) as b,",
      "  filter(c.phone_list, p -> p <> '') as d,",
      "  count(*) filter (where c.active) as e,",
      "  cast('n/a' as varchar) as f",
      "from customers c",
    ].join("\n")
    const reads = Object.fromEntries([...finalOutputs(sql).reads].map(([k, v]) => [k, [...v].sort()]))
    expect(reads.a).toEqual(["customers.last"])
    expect(reads.b).toEqual(["customers.time", "customers.zone"])
    expect(reads.d).toEqual(["customers.p", "customers.phone_list"])
    expect(reads.f).toEqual([])
    // `count(*)` reads no column but is not a constant: never "reads nothing".
    expect(reads.e).toHaveLength(1)
    expect(reads.e[0]).toMatch(/^\?\d+\.e$/)
  })
  test("`starRaw` resolves a column a plain `*` passes through", () => {
    expect([...finalOutputs("select * from customers").starRaw("ssn")]).toEqual(["customers.ssn"])
    expect([...finalOutputs("select c.* from customers c join orders o on true").starRaw("ssn")]).toEqual(["customers.ssn"])
    // A CTE that masks it exposes nothing raw through `*`.
    const masked = "with m as (select customer_id, sha2(ssn) as ssn from customers) select * from m"
    expect([...finalOutputs(masked).starRaw("ssn")]).toEqual([])
  })
  test("`refCovered` matches an unqualified column over a join to its single-table ref", () => {
    expect(refCovered("customers|orders.email", new Set(["customers.email"]))).toBe(true)
    // The reverse is not covered: the base never said which table it read.
    expect(refCovered("customers.email", new Set(["customers|orders.email"]))).toBe(false)
    expect(refCovered("customers|orders.email", new Set(["spouses.email"]))).toBe(false)
    expect(refCovered("customers|orders.email", new Set(["customers.ssn"]))).toBe(false)
    expect(refCovered("a|b.email", new Set(["b|c.email"]))).toBe(false)
  })
  test("`refCovered` compares database/schema only within one environment", () => {
    const prod = new Set(["analytics.dbt_prod.customers.ssn"])
    // Different environments: the prefixes appear on one side only.
    const envs = { head: new Set(["analytics.dbt_ci_pr_42"]), base: new Set(["analytics.dbt_prod"]) }
    expect(refCovered("analytics.dbt_ci_pr_42.customers.ssn", prod, envs)).toBe(true)
    expect(refCovered("analytics.dbt_ci_pr_42.spouses.ssn", prod, envs)).toBe(false)
    // An unqualified side matches a qualified one.
    expect(refCovered("customers.ssn", prod, envs)).toBe(true)
    // Both schemas read on both sides: the prefix is compared.
    const both = { head: new Set(["restricted", "public"]), base: new Set(["restricted", "public"]) }
    expect(refCovered("public.customers.ssn", new Set(["restricted.customers.ssn"]), both)).toBe(false)
    // The base already read `public`: moving `customers` there is a swap.
    const swap = { head: new Set(["public"]), base: new Set(["restricted", "public"]) }
    expect(refCovered("public.customers.ssn", new Set(["restricted.customers.ssn"]), swap)).toBe(false)
    // A single-table swap to a schema the base never read looks like an environment change.
    const alone = { head: new Set(["public"]), base: new Set(["restricted"]) }
    expect(refCovered("public.customers.ssn", new Set(["restricted.customers.ssn"]), alone)).toBe(true)
    // Without an environment, names must be equal.
    expect(refCovered("analytics.dbt_ci_pr_42.customers.ssn", prod)).toBe(false)
  })
  test("`distinct on (…)` is a select prefix, not part of the first item", () => {
    expect(asObject(rawColumnExposures("select distinct on (id) ssn, id from customers"))).toEqual({
      ssn: ["customers.ssn"],
      id: ["customers.id"],
    })
    expect(asObject(rawColumnExposures("select distinct on (date_trunc('day', ts), id) c.ssn from customers c"))).toEqual({
      ssn: ["customers.ssn"],
    })
  })
  test("every nested query gets its own scope, even when a numbered key meets an aliased one", () => {
    // Two union branches alias their subquery `s`; the first holds an unaliased subquery.
    const sql = "select a from (select a from t where a in (select a from u)) s\nunion all\nselect a from (select a from v) s"
    const scopes = selectItems(sql).filter((i) => i.scope !== ROOT_SCOPE).map((i) => i.scope)
    expect(new Set(scopes).size).toBe(scopes.length)
  })
  test("ignores commas and keywords inside literals and comments", () => {
    const sql = "select ssn as a, -- , email as a\n  'x, from y' as b, email as c from t"
    expect(asObject(rawColumnExposures(sql))).toEqual({ a: ["t.ssn"], c: ["t.email"] })
  })
})
