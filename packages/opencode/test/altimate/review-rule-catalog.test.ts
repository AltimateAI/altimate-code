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
  // Walking every path would take 2^30 steps: a regression does not finish inside the test timeout.
  test("`starRaw` resolves a chain of `*` CTEs that each join the previous one twice", () => {
    const ctes = ["c0 as (select * from customers)"]
    for (let i = 1; i <= 30; i++) ctes.push(`c${i} as (select * from c${i - 1} a join c${i - 1} b using (customer_id))`)
    const sql = `with ${ctes.join(",\n")}\nselect * from c30`
    expect([...finalOutputs(sql).starRaw("ssn")]).toEqual(["customers.ssn"])
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
      ["parenthesised first branch only", src(`\n(select customer_id from ${OTHER})\nunion all\nselect customer_id from src`), true],
      ["parenthesised first branch, a long comment before the operator", src(`, u as (\n  (select region as label from ${OTHER})\n  -- the two sources never overlap, by construction of the loader (see its README)\n  union all\n  select tax_ref from src\n)\nselect label from u`), true],
      ["parenthesised later branch, a long comment inside the operator", src(`\nselect region from ${OTHER}\nunion /* keep duplicates: the two sources never overlap, checked by hand */ all (select tax_ref from src)`), true],
      ["parenthesised branches inside a CTE", src(`, u as (\n  (select customer_id from ${OTHER})\n  union all\n  (select customer_id from src)\n)\nselect customer_id from u`), true],
      ["a scalar subquery ends a union branch, column dropped", src("\nselect (select max(customer_id) from analytics.spouses)\nunion all\nselect customer_id from src"), false],
      ["a scalar subquery ends a union branch, column carried", src("\nselect (select max(customer_id) from analytics.spouses)\nunion all\nselect tax_ref from src"), true],
      ["a `where` subquery ends a union branch, column dropped", src(`\nselect customer_id from src\nwhere customer_id > (select max(customer_id) from ${OTHER})\nunion all\nselect customer_id from ${OTHER}`), false],
      ["an unaliased FROM subquery ends a union branch, column dropped", src(`\nselect customer_id from (select customer_id from src)\nunion all\nselect customer_id from ${OTHER}`), false],
      ["an unaliased FROM subquery ends a union branch, column carried", src(`\nselect tax_ref from (select tax_ref from src)\nunion all\nselect customer_id from ${OTHER}`), true],
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
      ["whole row, carried on by its reader", src(", b as (\n  select s as row_s, customer_id from src s\n)\nselect row_s from b"), true],
      ["whole row, dropped by its reader", src(", b as (\n  select s as row_s, customer_id from src s\n)\nselect customer_id from b"), false],
      ["whole row by the CTE's own name, in a reader with a source that did not parse", src(`\nselect o.customer_id, row_to_json(src) as payload from ${OTHER} o join ${OTHER} p on true, src`), true],
      ["whole row after `unnest(…) with offset`", src(`\nselect o.customer_id, to_json_string(src) as payload from ${OTHER} o, unnest(o.tags) with offset, src`), true],
      ["a name resolved at run time", src("\nselect identifier('tax_ref') as t from src"), true],
      ["a name resolved at run time, from a variable and behind a comment", src("\nselect IDENTIFIER /* by name */ ($col) as t from src"), true],
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
    // A test that answers true or false.
    expect(item("regexp_like(ssn, '^[0-9]+$') as ok")).toBe(false)
    expect(item("contains(ssn, '-') as dashed")).toBe(false)
    // A `case` keeps what it may return, whatever identifiers sit around it.
    expect(item("case when customer_id > 0 then ssn end as t")).toBe(true)
    expect(item('concat(e."when", ssn, case when customer_id > 1 then \'x\' else \'y\' end) as t')).toBe(true)
    // Another column under the name counts; a cast's type is not a column.
    const named = (text: string) => {
      const r = rawReach(`select ${text} from t`)
      return r.carries(r.items[0], "ssn")
    }
    expect(named("tax_id as ssn")).toBe(true)
    expect(named("cast(tax_id as varchar) as ssn")).toBe(true)
    expect(named("cast(null as varchar) as ssn")).toBe(false)
    expect(named("md5(tax_id)::varchar(32) as ssn")).toBe(false)
    // A method call on the column: masked by a hash, kept by anything else.
    expect(item("ssn.md5() as s")).toBe(false)
    expect(item("c.ssn.sha256() as s")).toBe(false)
    expect(item("ssn.trim() as s")).toBe(true)
    expect(item("ssn.replace('-', '').md5() as s")).toBe(true)
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
    // Each modifier list applies to the star's own columns, not to the list before it.
    const through = (modifiers: string, final: string) => reaches(src(`, mid as (\n  select * ${modifiers} from src\n)\nselect ${final} from mid`))
    expect(through("rename (tax_ref as x, x as y)", "x")).toBe(true)
    expect(through("rename (tax_ref as x, x as y)", "y")).toBe(false)
    expect(through("replace (md5(tax_ref) as tax_ref, tax_ref as customer_id)", "customer_id")).toBe(true)
    expect(through("replace (md5(tax_ref) as tax_ref, tax_ref as customer_id)", "tax_ref")).toBe(false)
    expect(through("exclude (tax_ref) replace (tax_ref as customer_id)", "customer_id")).toBe(true)
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

  test("mayExpose: an item anywhere in the model that keeps the column and reaches the output", () => {
    const exposes = (sql: string) => rawReach(sql).mayExpose("ssn")
    // `dead` reads the column and nothing reads `dead`.
    const dead = (rest: string) => `with dead as (\n  select customer_id,\n    ssn\n  from ${REF}\n)${rest}`
    expect(exposes(dead(`\nselect customer_id from ${OTHER}`))).toBe(false)
    expect(exposes(dead(`\nselect customer_id, ssn from ${REF}`))).toBe(true)
    expect(exposes(dead(`\nselect d.customer_id, c.ssn as tax_ref from dead d join ${REF} c on c.customer_id = d.customer_id`))).toBe(true)
    expect(exposes(dead(`\nselect customer_id, coalesce(ssn, '') as tax_ref from ${REF}`))).toBe(true)
    expect(exposes(dead(`\nselect customer_id, sha2(ssn) as tax_ref from ${REF}`))).toBe(false)
    expect(exposes(dead(`, b as (\n  select customer_id, ssn as tax_ref from ${REF}\n)\nselect tax_ref from b`))).toBe(true)
    expect(exposes(dead(`, b as (\n  select customer_id, ssn as tax_ref from ${REF}\n)\nselect customer_id from b`))).toBe(false)
    expect(exposes(dead(`\nselect o.customer_id, (select max(c.ssn) from ${REF} c where c.customer_id = o.customer_id) as t from ${OTHER} o`))).toBe(true)
    expect(exposes(dead(`\nselect o.customer_id, l.t from ${REF} o, lateral (select o.ssn as t) l`))).toBe(true)
    // Another value under the column's name, a field of that name, a hierarchy root.
    expect(exposes(dead(`, b as (\n  select customer_id, tax_id as ssn from ${REF}\n)\nselect * from b`))).toBe(true)
    expect(exposes(dead(`, b as (\n  select customer_id, payload from ${REF}\n)\nselect payload.ssn as tax_ref from b`))).toBe(true)
    expect(exposes(dead(`\nselect customer_id, connect_by_root ssn from ${REF} start with customer_id = 1 connect by prior customer_id = manager_id`))).toBe(true)
    // A macro call naming the column, unless the SQL around it masks what it emits.
    expect(exposes(dead(`\nselect customer_id, {{ dbt.safe_cast("ssn", "varchar") }} as t from ${REF}`))).toBe(true)
    // The table's column next to a CTE's hashed column of the same name.
    const hashed = (final: string) => `with h as (\n  select customer_id,\n    sha2(\n      ssn\n    ) as ssn\n  from ${REF}\n)\n${final}`
    expect(exposes(hashed("select * from h"))).toBe(false)
    expect(exposes(hashed("select customer_id from h"))).toBe(false)
    expect(exposes(hashed(`select ssn, c.customer_id from h right join ${REF} c using (ssn)`))).toBe(true)
    // Names are all it reads: the hashed column selected by its name counts.
    expect(exposes(hashed("select customer_id, ssn from h"))).toBe(true)
    // A CTE named like the table an earlier CTE reads.
    expect(exposes(`with raw_rows as (\n  select customer_id, ssn from customers\n), customers as (\n  select customer_id from raw_rows\n)\nselect r.customer_id, r.ssn from raw_rows r join customers c on c.customer_id = r.customer_id`)).toBe(true)
  })

  test("mayExpose: a table's columns that leave a select unnamed", () => {
    const exposes = (sql: string) => rawReach(sql).mayExpose("ssn")
    expect(exposes(`with a as (\n  select object_construct(*) as payload from ${REF}\n)\nselect payload from a`)).toBe(true)
    expect(exposes(`with a as (\n  select object_construct(*) as payload from ${REF}\n)\nselect customer_id from ${OTHER}`)).toBe(false)
    expect(exposes(`with a as (\n  select to_json(c) as payload from ${REF} c\n)\nselect payload from a`)).toBe(true)
    expect(exposes(`with a as (\n  select to_json(c) as payload, c.customer_id from ${REF} c\n)\nselect customer_id from a`)).toBe(false)
    // A `ref` read without an alias is also named by its model; with one, only by the alias.
    expect(exposes(`with a as (\n  select to_json(customers) as payload from ${REF}\n)\nselect payload from a`)).toBe(true)
    expect(exposes(`select d.day, cast(d.day as date) as day_date from {{ ref('date') }} d`)).toBe(false)
    // A date part spelled like the alias is not the row.
    expect(exposes(`select s.customer_id, dateadd(s, s.duration_s, s.started_at) as ended_at from ${REF} s`)).toBe(false)
    expect(exposes(`select s.customer_id, coalesce(s, null) as payload from ${REF} s`)).toBe(true)
    // The whole row of an outer table, inside a scalar subquery.
    expect(exposes(`select c.customer_id, (select to_json(c)) as payload from ${REF} c`)).toBe(true)
    expect(exposes(`with a as (\n  select * from ${REF} unpivot (v for k in (ssn, region))\n)\nselect v from a`)).toBe(true)
    expect(exposes(`with a as (\n  select c.customer_id, t from ${REF} c cross join unnest([c.ssn]) as u(t)\n)\nselect t from a`)).toBe(true)
    expect(exposes(`with a as (\n  select identifier('ssn') as t from ${REF}\n)\nselect t from a`)).toBe(true)
    // A masking call over the row reads no column; a product with a masked operand is a product.
    expect(exposes(`select customer_id, hash(*) as row_hash from ${REF}`)).toBe(false)
    expect(exposes(`select c.customer_id, count(o.*) as orders from ${REF} c left join ${OTHER} o on o.customer_id = c.customer_id group by 1`)).toBe(false)
    expect(exposes(`select c.customer_id, to_json(o.*) as payload from ${REF} c left join ${OTHER} o on o.customer_id = c.customer_id`)).toBe(true)
    expect(exposes(`select customer_id, datediff(day, created_at, updated_at) * 24 as hours from ${REF}`)).toBe(false)
    expect(exposes(`select customer_id, concat(to_json(c), case when customer_id > 1 then 'x' end) as payload from ${REF} c`)).toBe(true)
    // A Jinja call glued to a `*` may add the column.
    expect(exposes(`with a as (select customer_id from ${OTHER})\nselect a.* {{ extra('c.ssn') }} from a join ${REF} c on c.customer_id = a.customer_id`)).toBe(true)
    // A literal's prefix and a cast's type are not the row.
    expect(exposes(`select r.customer_id, regexp_extract(r.region, r'^[a-z]+') as zone from ${REF} r`)).toBe(false)
    expect(exposes(`select d.day, cast(d.day as date) as day_date from {{ ref('date') }} as date`)).toBe(false)
    // A Jinja column list may hold the column under any name.
    expect(exposes(`with a as (\n  select {{ dbt_utils.star(from=ref('customers')) }} from ${REF}\n)\nselect customer_id from a`)).toBe(true)
    // SQL the parser does not model may expose anything.
    expect(exposes(`select t.customer_id\nfrom (\n  with a as (select customer_id, sha2(ssn) as h from ${REF})\n  select * from a\n) t`)).toBe(true)
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
    // The line's own evidence, as the orchestrator asks it after `mayExpose`:
    // the items on the line, else the clause it sits in.
    const lineReaches = (sql: string) => {
      const r = rawReach(sql)
      return sql.split("\n").flatMap((text, at) => {
        // Lines the regex twin fires on: the column opens the line.
        if (!/^\s*[\w.]*\bssn\b/i.test(text)) return []
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
      ["a struct field of the CTE's column (BigQuery)", "with c as (\n  select struct(\n    ssn as v\n  ) as tax from customers\n)\nselect tax.v from c"],
      ["an array join in a CTE's FROM, then `select *`", "with x as (\n  select c.id, v\n  from customers c, unnest([\n    c.ssn\n  ]) as v\n)\nselect * from x"],
      ["a backslash-escaped quote that swallows the line", "select\n  replace(name, '\\'', '') as n,\n  ssn\nfrom customers\nwhere status = 'active'"],
      ["a positional column in the reader", "with c as (\n  select\n    id,\n    ssn\n  from customers\n)\nselect $2 as tax_ref from c"],
      ["a later item of the same select reading the alias", "with c as (\n  select\n    id,\n    ssn as raw_ssn,\n    raw_ssn as tax_ref\n  from customers\n)\nselect id, tax_ref from c"],
      ["`percentile_disc \u2026 within group (order by \u2026)` returns the ordered value", "with c as (\n  select id, ssn from customers\n)\nselect\n  percentile_disc(0.5) within group (\n    order by\n      ssn\n  ) as tax_ref\nfrom c"],
      ["`mode() within group (order by \u2026)` returns the ordered value", "select\n  mode() within group (order by\n    ssn\n  ) as tax_ref\nfrom customers"],
      ["a FROM-first final query", "with c as (\n  select\n    ssn as tax_ref\n  from customers\n)\nfrom c"],
      ["`from c select x`", "with c as (\n  from customers\n  select\n    ssn as tax_ref\n)\nfrom c select tax_ref"],
      ["`table c` as the final query", "with c as (\n  select\n    ssn as tax_ref\n  from customers\n)\ntable c"],
      ["`table c` as a CTE body", "with c as (\n  select\n    ssn as tax_ref\n  from customers\n),\nd as (table c)\nselect tax_ref from d"],
      ["a `pivot` statement", "pivot customers\non status\nusing count(*)\ngroup by\n  ssn"],
      ["a union of `select *` branches whose columns come in another order", "with a as (\n  select id, md5(name) as h from customers\n),\nb as (\n  select\n    ssn,\n    id\n  from customers\n),\nu as (\n  select * from a\n  union all\n  select * from b\n)\nselect id from u"],
      ["a field of a struct column named like the PII column", "select\n  ssn.number as tax_ref\nfrom customers"],
      ["a Jinja call glued to the column name", "select\n  ssn{{ var(\"ssn_suffix\", \"\") }} as tax_ref\nfrom customers"],
      ["a dynamic `pivot \u2026 in (select \u2026)`", "with c as (select id, ssn, v from customers)\nselect * from c\npivot (max(v) for id in (select\n  ssn\nfrom c))"],
      ["a `values` query", "with c as (\n  select\n    ssn as tax_ref\n  from customers\n)\nvalues ((select tax_ref from c limit 1))"],
      ["`union all table c`", "with c as (\n  select\n    ssn as tax_ref\n  from customers\n)\nselect 'x' as tax_ref from customers\nunion all\ntable c"],
      ["a quoted alias with a space", "with c as (\n  select\n    ssn as \"Tax Ref\"\n  from customers\n)\nselect \"Tax Ref\" from c"],
      ["a quoted alias with a dot", "with c as (\n  select\n    ssn as \"a.b\"\n  from customers\n)\nselect \"a.b\" from c"],
      ["two Jinja alternatives of one CTE", "with\n{% if target.name == 'prod' %}\nc as (select md5(ssn) as h, id from customers),\nf as (select id as out from c)\n{% else %}\nc as (\n  select\n    ssn as tax_ref,\n    id\n  from customers\n),\nf as (select tax_ref as out from c)\n{% endif %}\nselect out from f"],
      ["two Jinja alternatives of one CTE body", "with c as (\n  {% if target.name == 'prod' %}\n  select md5(ssn) as h, id from customers\n  {% else %}\n  select\n    ssn as tax_ref,\n    id\n  from customers\n  {% endif %}\n)\nselect {% if target.name == 'prod' %}id{% else %}tax_ref{% endif %} as out from c"],
      ["`union all corresponding`", "with u as (\n  select id, md5(ssn) as h from customers\n  union all corresponding\n  select\n    ssn as h,\n    id\n  from customers\n)\nselect h from u"],
      ["`collate` after the column", "with src as (\n  select\n    ssn collate nocase\n  from customers\n)\nselect ssn from src"],
      ["`collate \"C\"` read as an alias", "with src as (\n  select\n    ssn collate \"C\"\n  from customers\n)\nselect ssn from src"],
      ["pipe syntax", "with c as (\n  select\n    ssn as tax_ref\n  from customers\n)\nfrom c\n|> select tax_ref"],
      ["a quoted identifier holding a parenthesis", "select\n  md5(\"a(\") || \n  ssn as tax_ref\nfrom customers"],
      ["a CTE named through Jinja", "with\n{% for src in ['a', 'b'] %}\n{{ src }}_c as (\n  select\n    ssn as tax_ref\n  from {{ ref(src) }}\n),\n{% endfor %}\nf as (select tax_ref from a_c)\nselect tax_ref from f"],
      ["a CTE named with a Jinja prefix", "with\n{% for src in ['a'] %}\nstg_{{ src }} as (\n  select\n    ssn as tax_ref\n  from {{ ref(src) }}\n),\n{% endfor %}\nf as (select tax_ref from stg_a)\nselect tax_ref from f"],
      ["a quoted CTE name holding `>`", "with c as (select id from customers where id in (select id from customers)),\n\"c>sub1\" as (\n  select\n    ssn as tax_ref\n  from customers\n)\nselect tax_ref from \"c>sub1\""],
      ["a list literal split at its commas", "with c as (\n  select\n    id,\n    [\n      md5(name),\n      ssn,\n      'x'\n    ] as arr\n  from customers\n)\nselect arr from c"],
      ["an array constructor split at its commas", "with c as (\n  select\n    id,\n    array[\n      md5(name),\n      ssn\n    ] as arr\n  from customers\n)\nselect arr from c"],
      ["a struct literal split at its commas", "with c as (\n  select\n    id,\n    {\n      'h': md5(name),\n      ssn: ssn\n    } as s\n  from customers\n)\nselect s from c"],
      ["an alias chosen by a Jinja `if`", "with c as (\n  select\n    ssn as {% if target.name == 'dev' %}tax_ref{% else %}h{% endif %}\n  from customers\n)\nselect {% if target.name == 'dev' %}tax_ref{% else %}md5(h){% endif %} as out from c"],
      ["a mask applied only under a Jinja `if`", "select\n  {% if target.name == 'prod' %}md5({% endif %}\n  ssn\n  {% if target.name == 'prod' %}){% endif %} as tax_ref\nfrom customers"],
      ["a mask applied only under a Jinja `if`, in a CTE", "with c as (\n  select\n    {% if not var('expose_pii', false) %}sha2({% endif %}\n    ssn\n    {% if not var('expose_pii', false) %}, 256){% endif %} as tax_ref\n  from customers\n)\nselect tax_ref from c"],
      ["a CTE column named `filter`", "with c as (\n  select\n    ssn as filter\n  from customers\n)\nselect coalesce(filter, '') as p from c"],
      ["a CTE column named `partition`", "with c as (\n  select\n    ssn as partition\n  from customers\n)\nselect coalesce(partition, '') as p from c"],
      ["a CTE column named `separator`", "with c as (\n  select\n    ssn as separator\n  from customers\n)\nselect coalesce(separator, '') as p from c"],
      ["a CTE column named `escape`", "with c as (\n  select\n    ssn as escape\n  from customers\n)\nselect coalesce(escape, '') as p from c"],
      ["a CTE column named `within`", "with c as (\n  select\n    ssn as within\n  from customers\n)\nselect coalesce(within, '') as p from c"],
      ["a CTE column named `interval`", "with c as (\n  select\n    ssn as interval\n  from customers\n)\nselect coalesce(interval, '') as p from c"],
      ["a CTE column named `nulls`", "with c as (\n  select\n    ssn as nulls\n  from customers\n)\nselect coalesce(nulls, '') as p from c"],
      ["a CTE column named `over`", "with c as (\n  select\n    ssn as over\n  from customers\n)\nselect coalesce(over, '') as p from c"],
      ["a CTE column named `exists`", "with c as (\n  select\n    ssn as exists\n  from customers\n)\nselect coalesce(exists, '') as p from c"],
      ["a CTE column named `rlike`", "with c as (\n  select\n    ssn as rlike\n  from customers\n)\nselect coalesce(rlike, '') as p from c"],
      ["a CTE column named `regexp`", "with c as (\n  select\n    ssn as regexp\n  from customers\n)\nselect coalesce(regexp, '') as p from c"],
      ["a CTE column named `try_cast`", "with c as (\n  select\n    ssn as try_cast\n  from customers\n)\nselect coalesce(try_cast, '') as p from c"],
      ["a CTE column named `partition_raw`", "with c as (\n  select\n    ssn as partition\n  from customers\n)\nselect partition as p from c"],
      ["a method call on the column", "select\n  ssn.lower() as tax_ref\nfrom customers"],
      ["chained method calls on the column", "with c as (\n  select\n    ssn.trim().upper() as tax_ref\n  from customers\n)\nselect tax_ref from c"],
      ["a reader's method call on the column", "with c as (\n  select\n    ssn as tax_ref\n  from customers\n)\nselect tax_ref.lower() as out from c"],
      ["an `unpivot` statement", "unpivot customers\non\n  ssn\ninto name k value v"],
      ["a FROM-first CTE body", "with a as (\n  select\n    ssn as x\n  from customers\n),\nb as (from a select x as tax_ref)\nselect tax_ref from b"],
      ["a union whose first branch is a table's `select *`", "with b as (\n  select\n    ssn,\n    id\n  from customers\n),\nu as (\n  select * from {{ ref('stg_other') }}\n  union all\n  select * from b\n)\nselect id from u"],
      ["jinja comment in sql comment", "select\n  id,\n  -- {#\n  md5(\n  -- #}\n  ssn\n  -- {#\n  )\n  -- #}\n  as tax_ref\nfrom customers"],
      ["backslash escape hides paren", "select\n  id,\n  md5(concat(trim(name, '\\''), '\\'')) as name_key,\n  ssn,\n  email\nfrom customers"],
      ["snowflake slash comment", "select\n  id, // TODO hash( later\n  ssn,\n  email\nfrom customers"],
      ["nested block comment", "select\n  id,\n  /* note /* nested */ md5( -- */\n  ssn,\n  email\nfrom customers"],
      ["predicate alias collision", "select\n  id in (select customer_id from churned) as v,\n  v.*\nfrom (\n  select\n    id,\n    ssn\n  from customers\n) v"],
      ["rename swap", "with b as (\n  select\n    ssn as a,\n    id as x\n  from customers\n),\nc as (select * rename (a as x, x as y) from b)\nselect x from c"],
      ["dollar string dashes", "select\n  id,\n  md5(name || $$--$$) as name_key,\n  ssn,\n  email\nfrom customers"],
      ["multi item", "with h as (\n  select\n    id,\n    email\n  from customers\n)\nselect\n  id,\n  ssn,\n  md5(email) as e\nfrom h"],
      ["dollar in name", "select\n  id,\n  ssn$raw\nfrom customers"],
      ["struct star cte", "with a as (\n  select\n    ssn.*\n  from customers\n)\nselect number from a"],
      ["nested comment balanced", "select\n  id,\n  /* a /* b */ md5( -- */\n  ssn\n  /* a /* b */ ) -- */\n  as tax_ref\nfrom customers"],
      ["backslash balanced", "select\n  id,\n  md5(name || '\\'') || '\\'' ||\n  ssn\n  || '\\'' || upper('\\'') as tax_ref\nfrom customers"],
      ["jinja comment scalar subquery", "select\n  -- {#\n  id in\n  -- #}\n  (\n    select\n      ssn\n    from customers\n    limit 1\n  ) as tax_ref\nfrom customers"],
      ["jinja comment in literal", "select\n  id,\n  '{#' || md5('#}' ||\n  ssn\n  || '{#') || '#}' as tax_ref\nfrom customers"],
      ["replace parallel", "with a as (\n  select\n    id,\n    name,\n    ssn\n  from customers\n)\nselect * replace (md5(ssn) as ssn, ssn as name) from a"],
      ["exclude then replace", "with a as (\n  select\n    id,\n    name,\n    ssn\n  from customers\n)\nselect * exclude (ssn) replace (ssn as name) from a"],
      ["quoted jinja alias", "{% set tax_col = 'tax_ref' %}\nwith a as (\n  select\n    ssn as \"{{ tax_col }}\"\n  from customers\n)\nselect tax_ref from a"],
      ["nested from", "with a as (\n  select\n    ssn as x\n  from customers\n)\nselect x from (select x from (select x from a) s1) s2"],
      ["correlated3", "with a as (\n  select\n    id,\n    ssn as x\n  from customers\n)\nselect (select (select max(a.x) from orders o2) from orders o1 limit 1) as y from a"],
      ["if union", "with a as (\n  select\n    ssn as x\n  from customers\n),\nu as (\n  select md5(name) as x from customers\n  {% if var('full', true) %}\n  union all\n  select x from a\n  {% endif %}\n)\nselect x from u"],
      ["union3", "with a as (\n  select id, md5(name) as x from customers\n),\nb as (\n  select\n    id,\n    ssn as x\n  from customers\n),\nu as (\n  select id, x from a\n  union all\n  select id, x from a\n  union all\n  select * from b\n)\nselect x from u"],
      ["union in from", "with b as (\n  select\n    id,\n    ssn as x\n  from customers\n)\nselect t.x from (select id, md5(name) as x from customers union all select * from b) t"],
      ["intersect mix", "with b as (\n  select\n    ssn as x\n  from customers\n)\nselect x from b\nexcept\nselect md5(name) from customers"],
      ["lateral alias eq src", "with a as (\n  select\n    ssn as tax,\n    id\n  from customers\n)\nselect md5(tax) as tax, tax as t2 from a"],
      ["array agg order", "with a as (\n  select\n    id,\n    ssn\n  from customers\n)\nselect array_agg(id order by ssn) as f from a"],
      ["named arg", "with a as (\n  select\n    ssn\n  from customers\n)\nselect struct_pack(k := ssn) as rec from a"],
      ["lambda", "with a as (\n  select\n    id,\n    ssn\n  from customers\n)\nselect list_transform([1], x -> ssn) as l from a"],
      ["json path", "with a as (\n  select\n    ssn\n  from customers\n)\nselect ssn['a'] as l, ssn->>'b' as m from a"],
    ]
    for (const [name, sql] of cases) {
      const lines = lineReaches(sql)
      expect({ name, lines: lines.length > 0, reaches: lines.every(Boolean) }).toEqual({ name, lines: true, reaches: true })
    }
  })

  // No time is asserted in the next two: a walk that stalls fails on the test timeout.
  test("subqueries nested past any real model's depth count as reaching", () => {
    const depth = 800
    const sql = "select x from " + "(select x from ".repeat(depth) + `(select\n ssn as x\n from ${REF}) t` + ") t".repeat(depth)
    expect(reaches(sql)).toBe(true)
    // Nothing shows the column dropped either: the nesting is not followed.
    expect(reaches(sql.replace("select x from (", "select 1 as one from ("))).toBe(true)
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
    expect(reaches(chain)).toBe(true)
    expect(reaches(chain.replace(`select x${n} from`, "select customer_id from"))).toBe(false)
  })
})
