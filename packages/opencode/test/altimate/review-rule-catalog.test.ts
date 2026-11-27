import { describe, test, expect } from "bun:test"
import {
  CATALOG,
  ruleMatches,
  inputFromExample,
  finalOutputs,
  rawReach,
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

const rawOf = (sql: string) => finalOutputs(sql).raw

describe("finalOutputs().raw", () => {
  const asObject = (m: Map<string, Set<string>>) => Object.fromEntries([...m].map(([k, v]) => [k, [...v].sort()]))
  test("reads the final projection only, not a CTE's own aliases", () => {
    const sql = "with h as (\n  select ssn as contact\n  from customers\n)\nselect c.email as contact from customers c"
    expect(asObject(rawOf(sql))).toEqual({ contact: ["customers.email"] })
  })
  test("resolves a final column through the CTE it reads, and `*` over a CTE", () => {
    const sql = [
      "with src as (select * from {{ ref('customers') }}),",
      "final as (select id, sha2(phone) as phone, ssn, email as contact from src)",
      "select * from final",
    ].join("\n")
    expect(asObject(rawOf(sql))).toEqual({
      id: ["{{ref('customers')}}.id"],
      ssn: ["{{ref('customers')}}.ssn"],
      contact: ["{{ref('customers')}}.email"],
    })
    expect(asObject(rawOf("with b as (select email as contact from c) select contact from b"))).toEqual({
      contact: ["c.email"],
    })
  })
  test("parses a select item whose alias is on another line", () => {
    const sql = "select c.customer_id,\n  c.ssn\n    as tax_ref\nfrom customers c"
    expect(asObject(rawOf(sql))).toEqual({ customer_id: ["customers.customer_id"], tax_ref: ["customers.ssn"] })
  })
  test("accepts quoted identifiers", () => {
    expect(asObject(rawOf('select "c"."ssn" as "tax_ref" from customers "c"'))).toEqual({ tax_ref: ["customers.ssn"] })
  })
  test("accepts an alias without AS, and not a trailing keyword", () => {
    const sql = "select c.ssn tax_ref, cast(c.dob as date) dob_day, case when x then y end, sha2(c.email) em from c"
    expect(asObject(rawOf(sql))).toEqual({ tax_ref: ["c.ssn"], dob_day: ["c.dob"] })
  })
  test("names a later set-operation branch by the first branch's position", () => {
    const sql = "select id, ssn as tax_ref from a\nunion all\nselect id, email from b"
    expect(asObject(rawOf(sql))).toEqual({ id: ["a.id", "b.id"], tax_ref: ["a.ssn", "b.email"] })
  })
  test("keeps the source table, so a same-named column from another table is distinct", () => {
    const sql = "select c.ssn, s.ssn as spouse_ssn, schema1.employees.email from customers c, schema1.employees join spouses as s on true"
    expect(asObject(rawOf(sql))).toEqual({
      ssn: ["customers.ssn"],
      spouse_ssn: ["spouses.ssn"],
      email: ["schema1.employees.email"],
    })
  })
  test("keeps the database and schema in the source identity", () => {
    expect(asObject(rawOf("select ssn from restricted.customers"))).toEqual({ ssn: ["restricted.customers.ssn"] })
    expect(asObject(rawOf("select ssn from public.customers"))).toEqual({ ssn: ["public.customers.ssn"] })
    expect(asObject(rawOf('select c.ssn, customers.email from "DB"."Public"."Customers" c, raw.customers'))).toEqual({
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
    expect(asObject(rawOf(sql))).toEqual({ a: ["customers.ssn"], d: ["customers.ssn"] })
    // An unknown qualifier never matches anything: it resolves to a unique ref.
    expect([...(rawOf("select x.ssn from customers c").get("ssn") ?? [])][0]).toMatch(/^\?\d+\.ssn$/)
  })
  test("resolves through a FROM subquery under its alias", () => {
    expect(asObject(rawOf("select s.ssn, s.email from (select sha2(ssn) as ssn, email from customers) s"))).toEqual({
      email: ["customers.email"],
    })
    expect(asObject(rawOf("select ssn from (select * from customers) as s"))).toEqual({ ssn: ["customers.ssn"] })
  })
  test("only a plain `*` passes columns through; `* except (…)` does not", () => {
    expect(finalOutputs("select * from customers").passthrough).toBe(true)
    expect(finalOutputs("select c.* from customers c").passthrough).toBe(true)
    expect(finalOutputs("select * except (ssn) from customers").passthrough).toBe(false)
  })
  test("a CTE with a column list is still a CTE: a renamed column resolves to nothing known", () => {
    const sql = "with m (id, tax) as (select customer_id, ssn from customers)\nselect tax as ssn from m"
    expect([...(rawOf(sql).get("ssn") ?? [])][0]).toMatch(/^\?\d+\.tax$/)
  })
  test("a CTE named `final` is a CTE, not the model's output", () => {
    // The outer `b` is the output; the CTE outputs no `b`, so it resolves to nothing known.
    const lost = finalOutputs("with final as (select a from t) select b from final")
    expect([...lost.names]).toEqual(["b"])
    expect([...lost.raw.keys()]).toEqual(["b"])
    expect([...lost.raw.get("b")!][0]).toMatch(/^\?\d+\.b$/)
    // Masked in the CTE, selected by name or through `*`: nothing raw.
    const masked = "with final as (select id, md5(email) as email from customers) select id, email from final"
    expect(asObject(rawOf(masked))).toEqual({ id: ["customers.id"] })
    expect(asObject(rawOf(masked.replace("select id, email from final", "select * from final")))).toEqual({
      id: ["customers.id"],
    })
    // Masked in the outer list: nothing raw, and the outer names are the outputs.
    const outer = "with final as (select id, email from customers) select id, md5(email) as email_hash from final"
    expect(asObject(rawOf(outer))).toEqual({ id: ["customers.id"] })
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
  test("`starRaw` resolves a plain `*` over a join to each source on its own", () => {
    // A `*` passes every source's columns through; an unqualified column read does not.
    const join = "select * from customers c join spouses s using (customer_id)"
    expect([...finalOutputs(join).starRaw("ssn")].sort()).toEqual(["customers.ssn", "spouses.ssn"])
    const viaCte = `with j as (${join}) select * from j`
    expect([...finalOutputs(viaCte).starRaw("ssn")].sort()).toEqual(["customers.ssn", "spouses.ssn"])
    // A qualified `*` stays on its source; a CTE that names the column is used as named.
    expect([...finalOutputs("select s.* from customers c join spouses s on true").starRaw("ssn")]).toEqual(["spouses.ssn"])
    const named = "with k as (select customer_id, sha2(ssn) as ssn from customers) select * from k join spouses s using (customer_id)"
    expect([...finalOutputs(named).starRaw("ssn")]).toEqual(["spouses.ssn"])
    // The unqualified column read keeps its combined ref.
    expect(asObject(rawOf("select ssn from customers c join spouses s using (customer_id)"))).toEqual({
      ssn: ["customers|spouses.ssn"],
    })
  })
  test("`starRaw` stays fast over a chain of `*` CTEs that each join the previous one twice", () => {
    const ctes = ["c0 as (select * from customers)"]
    for (let i = 1; i <= 30; i++) ctes.push(`c${i} as (select * from c${i - 1} a join c${i - 1} b using (customer_id))`)
    const sql = `with ${ctes.join(",\n")}\nselect * from c30`
    const t0 = performance.now()
    expect([...finalOutputs(sql).starRaw("ssn")]).toEqual(["customers.ssn"])
    expect(performance.now() - t0).toBeLessThan(1000)
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
    // Different environments: the head reads under `analytics.dbt_ci_pr_42`, which the base never read.
    const envs = { base: new Set(["analytics.dbt_prod"]) }
    expect(refCovered("analytics.dbt_ci_pr_42.customers.ssn", prod, envs)).toBe(true)
    expect(refCovered("analytics.dbt_ci_pr_42.spouses.ssn", prod, envs)).toBe(false)
    // An unqualified side matches a qualified one.
    expect(refCovered("customers.ssn", prod, envs)).toBe(true)
    // Both schemas read on both sides: the prefix is compared.
    const both = { base: new Set(["restricted", "public"]) }
    expect(refCovered("public.customers.ssn", new Set(["restricted.customers.ssn"]), both)).toBe(false)
    // The base already read `public`: moving `customers` there is a swap.
    const swap = { base: new Set(["restricted", "public"]) }
    expect(refCovered("public.customers.ssn", new Set(["restricted.customers.ssn"]), swap)).toBe(false)
    // A single-table swap to a schema the base never read looks like an environment change.
    const alone = { base: new Set(["restricted"]) }
    expect(refCovered("public.customers.ssn", new Set(["restricted.customers.ssn"]), alone)).toBe(true)
    // Without an environment, names must be equal.
    expect(refCovered("analytics.dbt_ci_pr_42.customers.ssn", prod)).toBe(false)
  })
  test("`distinct on (…)` is a select prefix, not part of the first item", () => {
    expect(asObject(rawOf("select distinct on (id) ssn, id from customers"))).toEqual({
      ssn: ["customers.ssn"],
      id: ["customers.id"],
    })
    expect(asObject(rawOf("select distinct on (date_trunc('day', ts), id) c.ssn from customers c"))).toEqual({
      ssn: ["customers.ssn"],
    })
  })
  test("every nested query gets its own scope, even when a numbered key meets an aliased one", () => {
    // Two union branches alias their subquery `s`; the first holds an unaliased subquery.
    const sql = "select a from (select a from t where a in (select a from u)) s\nunion all\nselect a from (select a from v) s"
    const scopes = selectItems(sql).filter((i) => i.scope !== ROOT_SCOPE).map((i) => i.scope)
    expect(new Set(scopes).size).toBe(scopes.length)
  })
  test("`null` / `true` / `false` items are constants, not raw columns", () => {
    const out = finalOutputs("select null as ssn, cast(null as varchar) as email, true as flag, c.id from customers c")
    expect(Object.fromEntries([...out.raw].map(([k, v]) => [k, [...v]]))).toEqual({ id: ["customers.id"] })
    expect([...out.reads.get("ssn")!]).toEqual([])
    expect([...out.reads.get("email")!]).toEqual([])
  })
  test("`within group (…)` does not end the select list", () => {
    const sql = "select listagg(c.ssn, ',') within group (order by c.id) as ssns, c.email from customers c"
    const out = finalOutputs(sql)
    expect([...out.names].sort()).toEqual(["email", "ssns"])
    expect(asObject(out.raw)).toEqual({ email: ["customers.email"] })
    expect([...out.reads.get("ssns")!]).toEqual(["customers.ssn"])
    expect(selectItemColumns("listagg(ssn, ',') within group (order by id) as ssns", /\b(ssn)\b/i)).toEqual([
      { column: "ssn", alias: "ssns", line: "listagg(ssn, ',') within group (order by id) as ssns" },
    ])
  })
  test("`within group` split by a long comment or whitespace run does not end the select list", () => {
    for (const gap of [" /* ordered-set aggregate, keep the order stable */ ", " ".repeat(30), "\n\n" + " ".repeat(24)]) {
      for (const sql of [
        `select listagg(c.ssn, ',') within${gap}group (order by c.id) as ssns, c.email from customers c`,
        `select listagg(c.ssn, ',') within group${gap}(order by c.id) as ssns, c.email from customers c`,
      ]) {
        const out = finalOutputs(sql)
        expect([...out.names].sort()).toEqual(["email", "ssns"])
        expect(asObject(out.raw)).toEqual({ email: ["customers.email"] })
      }
    }
    // `group by` is still a clause.
    expect([...finalOutputs("select c.email from customers c group  by c.email").names]).toEqual(["email"])
  })
  test("typed literals are constants and read no column", () => {
    const sql = [
      "select date '2024-01-01' as dob,",
      "  timestamp '2024-01-01 00:00:00' as signup_at,",
      "  interval '1 day' as gap,",
      "  interval 1 day as gap_bq,",
      "  interval '2' hour as gap_unit,",
      "  c.signup_at + interval 3 day as later,",
      "  date_trunc('day', c.signup_date) as d,",
      "  concat(time, ' ', zone) as t",
      "from customers c",
    ].join("\n")
    const out = finalOutputs(sql)
    expect([...out.reads.get("dob")!]).toEqual([])
    expect([...out.reads.get("signup_at")!]).toEqual([])
    expect([...out.reads.get("gap")!]).toEqual([])
    expect([...out.reads.get("gap_bq")!]).toEqual([])
    expect([...out.reads.get("gap_unit")!]).toEqual([])
    expect([...out.reads.get("later")!]).toEqual(["customers.signup_at"])
    expect([...out.reads.get("d")!]).toEqual(["customers.signup_date"])
    expect([...out.reads.get("t")!].sort()).toEqual(["customers.time", "customers.zone"])
    expect(selectItems(sql).filter((i) => i.constant).map((i) => i.name)).toEqual(["dob", "signup_at", "gap", "gap_bq", "gap_unit"])
  })
  test("ignores commas and keywords inside literals and comments", () => {
    const sql = "select ssn as a, -- , email as a\n  'x, from y' as b, email as c from t"
    expect(asObject(rawOf(sql))).toEqual({ a: ["t.ssn"], c: ["t.email"] })
  })
})

describe("rawReach", () => {
  const REF = "{{ ref('customers') }}"
  const OTHER = "{{ ref('spouses') }}"
  // `src` reads `ssn` raw under the output name `tax_ref`; `rest` is the SQL after it.
  const src = (rest: string, item = "ssn as tax_ref") => `with src as (\n  select customer_id,\n    ${item}\n  from ${REF}\n)${rest}`
  // Whether the item selecting `ssn` raw (the one on a line of its own) reaches the output.
  const reaches = (sql: string) => {
    const r = rawReach(sql)
    const hit = r.items.filter((i) => i.rawColumn === "ssn")
    expect({ sql, items: hit.length }).toEqual({ sql, items: 1 })
    return r.reaches(hit[0])
  }
  const check = (cases: Array<[string, string, boolean]>) => {
    for (const [name, sql, expected] of cases) expect({ name, reaches: reaches(sql) }).toEqual({ name, reaches: expected })
  }

  test("an item of the final select reaches the output; a CTE or FROM-subquery item follows its readers", () => {
    check([
      ["final select", `select customer_id, ssn from ${REF}`, true],
      ["later union branch of the final select", `select customer_id, region from ${OTHER}\nunion all\nselect ssn, customer_id from ${REF}`, true],
      ["carried by name", src("\nselect customer_id, tax_ref from src"), true],
      ["carried under a new alias, qualified", src("\nselect s.customer_id, s.tax_ref as t from src as s"), true],
      ["quoted and upper-case names", src('\nselect "CUSTOMER_ID", "TAX_REF" from "SRC"'), true],
      ["backtick names", "with `src` as (\n  select customer_id,\n    ssn as tax_ref\n  from " + REF + "\n)\nselect `tax_ref` from `src`", true],
      ["dropped by the final select", src("\nselect customer_id from src"), false],
      ["never read", src(`\nselect customer_id from ${OTHER}`), false],
      ["two CTEs, carried", src(", b as (\n  select customer_id, tax_ref as x from src\n)\nselect x from b"), true],
      ["two CTEs, dropped in the second", src(", b as (\n  select customer_id from src\n)\nselect customer_id from b"), false],
      ["FROM subquery, carried", `select s.customer_id, s.tax_ref\nfrom (\n  select customer_id,\n    ssn as tax_ref\n  from ${REF}\n) s`, true],
      ["FROM subquery, dropped", `select s.customer_id\nfrom (\n  select customer_id,\n    ssn as tax_ref\n  from ${REF}\n) s`, false],
      ["subquery inside a CTE", `with src as (\n  select q.customer_id, q.tax_ref\n  from (\n    select customer_id,\n      ssn as tax_ref\n    from ${REF}\n  ) q\n)\nselect tax_ref from src`, true],
      ["read by another qualifier's source only", src(`\nselect o.customer_id, o.tax_ref\nfrom ${OTHER} o\njoin src s on s.customer_id = o.customer_id`), false],
      ["a physical table named like the CTE is not the CTE", src("", "ssn").replace("with src", "with customers") + ", o as (\n  select * from analytics.customers\n)\nselect * from o", false],
    ])
  })

  test("a `*` carries the column unless it excludes or masks it", () => {
    check([
      ["plain star", src("\nselect * from src"), true],
      ["qualified star", src(`\nselect s.* from src s join ${OTHER} o using (customer_id)`), true],
      ["star of another source", src(`\nselect o.* from ${OTHER} o join src s using (customer_id)`), false],
      ["star chain through 35 import CTEs", "with " + Array.from({ length: 35 }, (_, i) => `c${i} as (select * from {{ ref('t${i}') }}),\n`).join("") + src(", mid as (\n  select customer_id, tax_ref as b from src\n)\nselect b from mid").slice(5), true],
      ["exclude another column", src("\nselect * exclude (customer_id) from src"), true],
      ["exclude the column", src("\nselect * exclude (tax_ref) from src"), false],
      ["exclude without parentheses, upper case", src("\nselect * EXCLUDE TAX_REF from src"), false],
      ["except with no space", src("\nselect *except(tax_ref) from src"), false],
      ["replace by a hash", src("\nselect * replace (sha2(tax_ref) as tax_ref) from src"), false],
      ["replace another column", src("\nselect * replace (upper(customer_id) as customer_id) from src"), true],
      ["replace that keeps the value", src("\nselect * replace (coalesce(tax_ref, '') as tax_ref) from src"), true],
      ["rename, then selected under the new name", src(", mid as (\n  select * exclude (customer_id) rename (tax_ref as t) from src\n)\nselect t from mid"), true],
      ["rename, old name no longer carried", src(", mid as (\n  select * rename (tax_ref as t) from src\n)\nselect tax_ref from mid"), false],
      ["a star that cannot be named", src("\nselect * ilike '%ref%' from src"), true],
      ["a star inside a call", src("\nselect object_construct(*) as payload from src"), true],
      ["count(*) reads no column", src("\nselect count(*) as n from src"), false],
      ["a product is not a star", src("\nselect customer_id * 2 as twice from src"), false],
      ["hashed in `final`, then `select * from final`", src(", final as (\n  select customer_id, sha2(tax_ref) as tax_ref from src\n)\nselect * from final"), false],
    ])
  })

  test("an expression keeps the value unless every read sits in a masking call", () => {
    const final = (item: string) => src(`\nselect customer_id, ${item} from src`)
    check([
      ["sha2", final("sha2(tax_ref) as h"), false],
      ["hash under the same name", src(", final as (\n  select sha2(tax_ref) as tax_ref from src\n)\nselect tax_ref from final"), false],
      ["last four", final("'***-**-' || right(tax_ref, 4) as masked"), false],
      ["a project's own masking macro or UDF", final("util.mask_ssn(tax_ref) as m"), false],
      ["hash inside coalesce", final("coalesce(md5(tax_ref), 'none') as h"), false],
      ["null test", final("case when tax_ref is null then 0 else 1 end as has_ref"), false],
      ["window partition", final("row_number() over (partition by tax_ref order by customer_id) as rn"), false],
      ["count", final("count(distinct tax_ref) as n"), false],
      ["coalesce", final("coalesce(tax_ref, '') as t"), true],
      ["max", final("max(tax_ref) as t"), true],
      ["case that returns it", final("case when customer_id > 0 then tax_ref end as t"), true],
      ["replace of a separator", final("replace(tax_ref, '-', '') as t"), true],
      ["double cast", final("tax_ref::varchar::text as t"), true],
      ["an undo of a mask", final("unmask(tax_ref) as t"), true],
      ["kept by an expression, then dropped", src(", b as (\n  select trim(tax_ref) as t from src\n)\nselect 1 as one from b"), false],
    ])
  })

  test("a later set-operation branch outputs under the first branch's name", () => {
    const u = (rest: string) => `with u as (\n  select customer_id, tax_id from ${OTHER}\n  union all\n  select customer_id,\n    ssn\n  from ${REF}\n)\n${rest}`
    check([
      ["selected under the first branch's name", u("select tax_id from u"), true],
      ["not selected", u("select customer_id from u"), false],
      ["its own name is not an output", u("select customer_id from u where tax_id is not null"), false],
    ])
  })

  test("a condition's operand reaches nothing; other nested queries count as reaching", () => {
    check([
      ["exists", src(`\nselect o.* from ${OTHER} o\nwhere exists (select * from src s where s.customer_id = o.customer_id)`), false],
      ["in", src(`\nselect * from ${OTHER} o\nwhere o.customer_id in (select tax_ref from src)`), false],
      ["any", src(`\nselect * from ${OTHER} o\nwhere o.customer_id = any (select tax_ref from src)`), false],
      ["nested in a condition", src(`\nselect * from ${OTHER} o\nwhere o.customer_id in (select x.tax_ref from (select tax_ref from src) x)`), false],
      ["scalar subquery in the select list", src(`\nselect o.customer_id, (select s.tax_ref from src s where s.customer_id = o.customer_id) as t\nfrom ${OTHER} o`), true],
      ["parenthesised union branch", src(`\n(select customer_id, region from ${OTHER})\nunion all\n(select customer_id, tax_ref from src)`), true],
      ["lateral subquery", src(`\nselect o.customer_id, l.x\nfrom ${OTHER} o, src s, lateral (select s.tax_ref as x) l`), true],
    ])
  })

  test("a reader whose columns cannot be named counts as reaching", () => {
    check([
      ["unpivot over the column", src("\nselect customer_id, v from src unpivot (v for k in (tax_ref))"), true],
      ["unnest of the column", src("\nselect s.customer_id, t from src s cross join unnest(s.tax_ref) as t"), true],
      ["a table function over another column", src("\nselect s.customer_id, f.value as tag from src s, lateral flatten(input => s.tags) f"), false],
      ["whole row", src("\nselect s from src s"), true],
      ["whole row in a call", src("\nselect to_json(s) as j from src s"), true],
      ["struct expansion of the column", src("\nselect tax_ref.* from src"), true],
      ["an alias the parser did not read", src("\nselect p.* from src pivot (max(v) for k in ('a')) p"), true],
      ["parenthesised join", src(`\nselect tax_ref from (src s join ${OTHER} o on o.customer_id = s.customer_id)`), true],
      ["CTE column list", src("\nselect t from src").replace("with src as", "with src (customer_id, t) as"), true],
      ["nested `with`", `select t.customer_id\nfrom (\n  with a as (\n    select customer_id,\n      ssn\n    from ${REF}\n  )\n  select * from a\n) t`, true],
    ])
  })

  test("Jinja: a column list or a variable may carry it, a macro call with an alias does not", () => {
    check([
      ["incremental filter", src("\nselect customer_id from src\n{% if is_incremental() %}\nwhere updated_at > (select max(updated_at) from {{ this }})\n{% endif %}"), false],
      ["incremental filter, carried", src("\nselect customer_id, tax_ref from src\n{% if is_incremental() %}\nwhere updated_at > (select max(updated_at) from {{ this }})\n{% endif %}"), true],
      ["a macro that emits columns", src("\nselect {{ dbt_utils.star(from=ref('customers')) }} from src"), true],
      ["a loop variable", src("\nselect customer_id, {% for c in cols %}{{ c }} as {{ c }}_v,{% endfor %} 1 as one from src"), true],
      ["a macro call with an alias", src("\nselect customer_id, {{ dbt_utils.generate_surrogate_key(['tax_ref']) }} as k from src"), false],
      ["a source named by a variable", src("\nselect tax_ref from {{ upstream }}"), true],
      ["a source named by a variable, column not selected", src("\nselect customer_id from {{ upstream }}"), false],
      ["a branch of a conditional FROM", src("\nselect tax_ref from {% if var('x') %} other {% else %} src {% endif %}"), true],
      ["a tag that can emit text", src("\nselect customer_id\n{% include 'more.sql' %}\nfrom src"), true],
    ])
  })

  test("carries: raw, or read outside a masking call", () => {
    const item = (text: string) => {
      const r = rawReach(`select ${text} from t`)
      return r.carries(r.items[0], "ssn")
    }
    expect(item("ssn")).toBe(true)
    expect(item("c.ssn as tax_ref")).toBe(true)
    expect(item("cast(ssn as varchar) as s")).toBe(true)
    expect(item("coalesce(\n  ssn,\n  '') as s")).toBe(true)
    expect(item("sha2(\n  ssn\n) as s")).toBe(false)
    expect(item("regexp_replace(ssn, '[0-9]', '*') as s")).toBe(false)
    expect(item("row_number() over (partition by\n ssn\n order by id) as rn")).toBe(false)
    expect(item("email")).toBe(false)
  })

  test("passes: a `*` item on the changed line passes the column unless it excludes or masks it", () => {
    const star = (item: string, rest = "\nselect * from src") => {
      const r = rawReach(`with src as (\n  select ${item}\n  from ${REF}\n)${rest}`)
      return r.passes(r.items[0], "ssn")
    }
    expect(star("* rename (\n    ssn as tax_ref\n  )")).toBe(true)
    expect(star("* rename (\n    ssn as tax_ref\n  )", "\nselect customer_id from src")).toBe(false)
    expect(star("* exclude (\n    ssn\n  )")).toBe(false)
    expect(star("* replace (\n    sha2(ssn) as ssn\n  )")).toBe(false)
    expect(star("* replace (\n    coalesce(ssn, '') as ssn\n  )")).toBe(true)
    expect(star("sha2(\n    ssn\n  ) as h")).toBe(false)
    expect(star("coalesce(\n    ssn,\n    '') as tax_ref", "\nselect tax_ref from src")).toBe(true)
    expect(star("coalesce(\n    ssn,\n    '') as tax_ref", "\nselect customer_id from src")).toBe(false)
  })

  test("mayExpose: a column no select item names is exposed only through a table's `*`", () => {
    expect(rawReach(`select customer_id from ${REF} order by ssn`).mayExpose("ssn")).toBe(false)
    expect(rawReach(`select sha2(ssn) as h, count(*) as n from ${REF} group by ssn`).mayExpose("ssn")).toBe(false)
    expect(rawReach(`select * from ${REF} order by ssn`).mayExpose("ssn")).toBe(true)
    expect(rawReach(`select * exclude (ssn) from ${REF}`).mayExpose("ssn")).toBe(false)
    expect(rawReach(`with a as (select * from ${REF}) select customer_id from a order by ssn`).mayExpose("ssn")).toBe(false)
    expect(rawReach(`with a as (select * from ${REF}) select * from a`).mayExpose("ssn")).toBe(true)
    expect(rawReach(src("\nselect customer_id from src order by tax_ref")).mayExpose("ssn")).toBe(false)
    expect(rawReach(src("\nselect * from src")).mayExpose("ssn")).toBe(true)
  })

  test("inClause: a line outside every select list is told apart only by the clause word before it", () => {
    const at = (sql: string, text: string) => rawReach(sql).inClause(sql.split("\n").findIndex((l) => l.trim() === text) + 1)
    expect(at(`select customer_id\nfrom ${REF}\norder by\n  ssn`, "ssn")).toBe(true)
    expect(at(`select customer_id, count(*) as n\nfrom ${REF}\ngroup by\n  customer_id,\n  ssn`, "ssn")).toBe(true)
    expect(at(`select customer_id\nfrom ${REF}\nqualify row_number() over (\n  partition by\n    ssn\n  order by updated_at) = 1`, "ssn")).toBe(true)
    expect(at(`select customer_id\nfrom ${REF}\nwhere region = 'x'\n  and\n  ssn is not null`, "ssn is not null")).toBe(true)
    // A keyword in a parenthesis that closed before the line says nothing about it.
    expect(at(`select topic, offset, (select max(x) from u where k = 1),\n  ssn\nfrom ${REF}`, "ssn")).toBe(false)
    // The select word itself is hidden (glued to Jinja), or there is none.
    expect(at(`{{ config(materialized='table') }}select\n  customer_id,\n  ssn\nfrom ${REF}`, "ssn")).toBe(false)
    expect(at("ssn", "ssn")).toBe(false)
  })

  test("select lists the parser cannot see whole count as reaching", () => {
    check([
      ["Jinja glued to `select`", `{{ config(materialized='table') }}with src as (\n  select customer_id,\n    ssn as tax_ref\n  from ${REF}\n){{ hook() }}select customer_id from src`, true],
      ["a clause word used as a column name", src("\nselect topic, offset, tax_ref from src"), true],
      ["`select as struct`", src("\nselect array(select as struct tax_ref from src) as rows"), true],
      ["a comma-joined source after a join condition", src(`\nselect o.customer_id, u.v\nfrom ${OTHER} o\njoin src s on s.customer_id = o.customer_id\n  , unnest([s.tax_ref]) as u(v)`), true],
      ["a comma-joined CTE after a join condition", `with a as (\n  select customer_id from ${OTHER}\n), ` + src(`\nselect s.tax_ref\nfrom ${OTHER} o\njoin a on a.customer_id = o.customer_id\n  , src s`).slice(5), true],
      ["a FROM hidden in Jinja", src("\nselect tax_ref {{ from_src() }}"), true],
    ])
  })

  test("shapes the parser does not model block: every `ssn` line counts as reaching", () => {
    // As the orchestrator asks it: the items on the line, else the clause it sits in.
    const lineReaches = (sql: string) => {
      const r = rawReach(sql)
      return sql.split("\n").flatMap((text, at) => {
        if (!/\bssn\b/i.test(text)) return []
        const items = r.items.filter((i) => i.startLine <= at + 1 && at + 1 <= i.endLine)
        return [items.length ? items.some((i) => r.passes(i, "ssn")) : !r.inClause(at + 1) || r.mayExpose("ssn")]
      })
    }
    const cases: Array<[string, string]> = [
      ["`select all (select \u2026)` is a scalar subquery, not a condition", "select all\n  (select\n    ssn\n  from customers limit 1) as x\nfrom t"],
      ["a column list on a subquery alias renames its columns", "select x\nfrom (\n  select\n    ssn\n  from customers\n) as t(x)"],
      ["a column list on a CTE alias renames its columns", "with c as (\n  select\n    ssn\n  from customers\n)\nselect tax\nfrom c as y(tax)"],
      ["`union all by name` pairs columns by name", "with u as (\n  select 1 as a, 2 as b from t\n  union all by name\n  select\n    ssn as b,\n    3 as a\n  from customers\n)\nselect b from u"],
      ["a `*` in a later union branch lands under the first branch's names", "with c as (\n  select\n    id,\n    ssn\n  from customers\n),\nu as (\n  select id, name as label from people\n  union all\n  select * from c\n)\nselect id, label from u"],
      ["a `*` in the first union branch shifts the positions after it", "with u as (\n  select *, 1 as k from a\n  union all\n  select 1,\n    ssn,\n    3\n  from customers\n)\nselect q from u"],
      ["an array join in FROM over the column", "select c.id, v\nfrom customers c, unnest([\n  c.ssn\n]) as v"],
      ["`unpivot` in FROM over the column", "select id, val\nfrom customers unpivot (val for col in (\n  ssn,\n  name\n))"],
      ["`pivot` in FROM over the column", "select id, a, b\nfrom customers pivot (max(\n  ssn\n) for k in ('a', 'b'))"],
      ["`lateral flatten` in FROM over the column", "select c.id, f.value as v\nfrom customers c,\nlateral flatten(input => array_construct(\n  c.ssn\n)) f"],
      ["a DDL wrapper is not one query", "create table out as (\n  select\n    ssn\n  from customers\n)"],
      ["a macro call that emits the column, on its own line", "select\n  {{ dbt.safe_cast(\"ssn\", api.Column.translate_type(\"string\")) }} as tax_id\nfrom customers"],
      ["`adapter.quote` of the column, on its own line", "select\n  {{ adapter.quote(\"ssn\") }} as tax_id\nfrom customers"],
      ["a reader's macro call that names the column", "with c as (\n  select\n    ssn\n  from customers\n)\nselect {{ dbt.safe_cast(\"ssn\", \"varchar\") }} as tax_id from c"],
      ["a `columns('\u2026')` pattern in the reader", "with c as (\n  select\n    id,\n    ssn\n  from customers\n)\nselect columns('id|ss.') from c"],
      ["a backslash-escaped quote before the line", "select\n  replace(name, '\\'', '') as n,\n  ssn\nfrom customers"],
      ["a `#` comment holding an apostrophe", "select\n  id, # don't\n  ssn\nfrom customers"],
      ["`match_recognize` measures over the column", "select id, s\nfrom customers match_recognize (\n  partition by id order by ts\n  measures last(\n    ssn\n  ) as s\n  pattern (a)\n  define a as true\n)"],
      ["a CTE named like the table it reads with `*`", "with customers as (\n  select * from customers\n  where\n    ssn is not null\n)\nselect * from customers"],
      ["a parenthesised first union branch", "with u as (\n  (select id, name from people)\n  union all\n  select\n    id,\n    ssn\n  from customers\n)\nselect id, name from u"],
      ["`select distinct top n`", "select distinct top 10\n  ssn\nfrom customers"],
      ["`select top n distinct`", "select top 10 distinct\n  ssn\nfrom customers"],
      ["an alias that is a Jinja call", "with c as (\n  select\n    ssn as {{ var('tax_col') }}\n  from customers\n)\nselect id, tax_ref from c"],
      ["an alias that is a Jinja variable", "with c as (\n  select\n    ssn as {{ tax_col }}\n  from customers\n)\nselect id, tax_ref from c"],
      ["a struct field of the CTE's column", "with c as (\n  select struct_pack(\n    v := ssn\n  ) as tax from customers\n)\nselect tax.v from c"],
      ["a struct field of the CTE's column (BigQuery)", "with c as (\n  select struct(\n    ssn as v\n  ) as tax from customers\n)\nselect tax.v from c"],
      ["an array join in a CTE's FROM, then `select *`", "with x as (\n  select c.id, v\n  from customers c, unnest([\n    c.ssn\n  ]) as v\n)\nselect * from x"],
      ["another column output under the PII name", "select\n  id,\n  tax_id_number as ssn\nfrom customers"],
      ["a backslash-escaped quote that swallows the line", "select\n  replace(name, '\\'', '') as n,\n  ssn\nfrom customers\nwhere status = 'active'"],
      ["a positional column in the reader", "with c as (\n  select\n    id,\n    ssn\n  from customers\n)\nselect $2 as tax_ref from c"],
      ["a later item of the same select reading the alias", "with c as (\n  select\n    id,\n    ssn as raw_ssn,\n    raw_ssn as tax_ref\n  from customers\n)\nselect id, tax_ref from c"],
    ]
    for (const [name, sql] of cases) {
      const lines = lineReaches(sql)
      expect({ name, lines: lines.length > 0, reaches: lines.every(Boolean) }).toEqual({ name, lines: true, reaches: true })
    }
  })

  test("deeply nested subqueries stay fast", () => {
    const depth = 800
    const sql = "select x from " + "(select x from ".repeat(depth) + `(select\n ssn as x\n from ${REF}) t` + ") t".repeat(depth)
    const t0 = performance.now()
    expect(reaches(sql)).toBe(true)
    expect(performance.now() - t0).toBeLessThan(3000)
  })

  test("malformed SQL and deep chains do not throw or stall", () => {
    for (const sql of ["ssn", "select\n  ssn\nfrom", `with src as (\n select ssn from ${REF}\nselect customer_id from src`, "select customer_id))\nfrom src)", "with a as (select * from a) select * from a"]) {
      const r = rawReach(sql)
      for (const i of r.items) r.reaches(i)
      r.mayExpose("ssn")
    }
    const n = 300
    const chain =
      `with c0 as (\n  select customer_id,\n    ssn as x0\n  from ${REF}\n)` +
      Array.from({ length: n }, (_, i) => `, c${i + 1} as (\n  select customer_id, x${i} as x${i + 1}, ${Array.from({ length: 30 }, (_, k) => `f${k}`).join(", ")} from c${i}\n)`).join("") +
      `\nselect x${n} from c${n}`
    const t0 = performance.now()
    expect(reaches(chain)).toBe(true)
    expect(reaches(chain.replace(`select x${n} from`, "select customer_id from"))).toBe(false)
    expect(performance.now() - t0).toBeLessThan(2000)
  })
})
