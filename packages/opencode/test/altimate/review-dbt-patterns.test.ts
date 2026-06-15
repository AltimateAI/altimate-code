import { describe, test, expect } from "bun:test"
import {
  detectModelPatterns,
  detectSchemaYmlPatterns,
  DEFAULT_RUBRIC,
  type ChangedFile,
} from "../../src/altimate/review"

// Build a modified-model ChangedFile from a new-SQL body + a synthetic diff
// where the given lines are "added" (prefixed with +).
function modelFile(path: string, newSql: string, addedLines: string[], removedLines: string[] = []): ChangedFile {
  const diff = [...addedLines.map((l) => "+" + l), ...removedLines.map((l) => "-" + l)].join("\n")
  return { path, status: "modified", diff }
}

const has = (fs: any[], category: string, sev?: string) =>
  fs.some((f) => f.category === category && (!sev || f.severity === sev))

describe("dbt-patterns detectors", () => {


  test("CROSS JOIN → critical join_risk", () => {
    const sql = `select * from a cross join b`
    const f = detectModelPatterns(
      modelFile("models/marts/m.sql", sql, ["cross join {{ ref('b') }} b"]),
      sql,
      DEFAULT_RUBRIC,
    )
    expect(has(f, "join_risk", "critical")).toBe(true)
  })



  test("current_timestamp() in transform → idempotency warning", () => {
    const sql = `select id, current_timestamp() as processed_at from {{ ref('x') }}`
    const f = detectModelPatterns(
      modelFile("models/staging/m.sql", sql, ["    , current_timestamp() as processed_at"]),
      sql,
      DEFAULT_RUBRIC,
    )
    expect(has(f, "idempotency", "warning")).toBe(true)
  })

  test("clock function on an audit column is NOT flagged", () => {
    const sql = `select id, current_timestamp() as _loaded_at from {{ ref('x') }}`
    const f = detectModelPatterns(
      modelFile("models/staging/m.sql", sql, ["    , current_timestamp() as _loaded_at"]),
      sql,
      DEFAULT_RUBRIC,
    )
    expect(has(f, "idempotency")).toBe(false)
  })

  test("clock in a microbatch config begin= kwarg is NOT flagged (Jinja, not transform)", () => {
    const line = "begin=(modules.datetime.datetime.now() - modules.datetime.timedelta(days=90)).isoformat()"
    const sql = `{{ config(materialized='incremental', incremental_strategy='microbatch', ${line}) }}\nselect id from {{ ref('x') }}`
    const f = detectModelPatterns(modelFile("models/intermediate/m.sql", sql, [line]), sql, DEFAULT_RUBRIC)
    expect(has(f, "idempotency")).toBe(false)
  })

  test("NOT IN (subquery) → sql_correctness warning", () => {
    const sql = `select * from a where id not in (select id from b)`
    const f = detectModelPatterns(
      modelFile("models/marts/m.sql", sql, ["where id not in (select id from {{ ref('b') }})"]),
      sql,
      DEFAULT_RUBRIC,
    )
    expect(has(f, "sql_correctness", "warning")).toBe(true)
  })

  test("SELECT * added → warehouse_cost suggestion; passthrough select * from {{ ref }} is NOT flagged", () => {
    const flagged = detectModelPatterns(
      modelFile("models/marts/m.sql", "select *, 1 from x", ["    select *, 1 from x"]),
      "x",
      DEFAULT_RUBRIC,
    )
    expect(has(flagged, "warehouse_cost")).toBe(true)
    const passthrough = detectModelPatterns(
      modelFile("models/staging/m.sql", "select * from {{ ref('x') }}", ["select * from {{ ref('x') }}"]),
      "x",
      DEFAULT_RUBRIC,
    )
    expect(has(passthrough, "warehouse_cost")).toBe(false)
  })

  test("ROW_NUMBER() dedup with NO order by → dedup warning; any order by → clean (tie-prone case is core L039)", () => {
    const bad = `qualify row_number() over (partition by id) = 1`
    const f1 = detectModelPatterns(modelFile("models/staging/m.sql", bad, [bad]), bad, DEFAULT_RUBRIC)
    expect(has(f1, "dedup", "warning")).toBe(true)
    // A present ORDER BY is the developer's deterministic choice; the "ordered only
    // by a non-unique key" sub-case is handled by the core AST rule L039, not here.
    const good = `qualify row_number() over (partition by id order by updated_at desc) = 1`
    const f2 = detectModelPatterns(modelFile("models/staging/m.sql", good, [good]), good, DEFAULT_RUBRIC)
    expect(has(f2, "dedup")).toBe(false)
  })

  test("PII column added to a marts model → pii_exposure; ssn → critical", () => {
    const sql = `select o.id, c.ssn from o join c using (id)`
    const f = detectModelPatterns(modelFile("models/marts/m.sql", sql, ["        c.ssn,"]), sql, DEFAULT_RUBRIC)
    expect(has(f, "pii_exposure", "critical")).toBe(true)
    // staging PII is flagged (catalog) but NOT as the marts-only critical exposure
    const stg = detectModelPatterns(modelFile("models/staging/m.sql", sql, ["        c.ssn,"]), sql, DEFAULT_RUBRIC)
    expect(has(stg, "pii_exposure", "critical")).toBe(false)
  })

  test("partition-pruning-defeating function in WHERE → warehouse_cost suggestion", () => {
    const sql = `select * from x where extract(year from event_date) = 2024`
    const f = detectModelPatterns(
      modelFile("models/marts/m.sql", sql, ["where extract(year from event_date) = 2024"]),
      sql,
      DEFAULT_RUBRIC,
    )
    expect(has(f, "warehouse_cost")).toBe(true)
  })

  test("COUNT(distinct) → COUNT downgrade → sql_correctness warning", () => {
    const sql = `select count(order_id) from x`
    const f = detectModelPatterns(
      modelFile(
        "models/marts/m.sql",
        sql,
        ["    count(oi.order_id) as orders,"],
        ["    count(distinct oi.order_id) as orders,"],
      ),
      sql,
      DEFAULT_RUBRIC,
    )
    expect(has(f, "sql_correctness", "warning")).toBe(true)
  })

  test("fanout: new join into an aggregating model → fanout warning", () => {
    const sql = `select customer_id, sum(amount) from o left join {{ ref('items') }} i on i.oid = o.id group by 1`
    const f = detectModelPatterns(
      modelFile("models/marts/m.sql", sql, ["left join {{ ref('items') }} i on i.oid = o.id"]),
      sql,
      DEFAULT_RUBRIC,
    )
    expect(has(f, "fanout", "warning")).toBe(true)
  })

  test("schema.yml: removed unique/not_null test → test_coverage finding", () => {
    const f = detectSchemaYmlPatterns(
      { path: "models/marts/_models.yml", status: "modified", diff: "-          - unique\n-          - not_null" },
      DEFAULT_RUBRIC,
    )
    expect(has(f, "test_coverage")).toBe(true)
  })

  test("workflow YAML is not treated as schema.yml", () => {
    const f = detectSchemaYmlPatterns(
      {
        path: ".github/workflows/dbt-pr-review.yml",
        status: "modified",
        diff: "-          - name: order_id\n-            description: One row per order",
      },
      DEFAULT_RUBRIC,
    )
    expect(f.length).toBe(0)
  })

  test("benign additive column produces NO dbt-pattern finding (precision)", () => {
    const sql = `select id, upper(status) as status_upper from {{ ref('x') }}`
    const f = detectModelPatterns(
      modelFile("models/staging/m.sql", sql, ["    upper(status) as status_upper,"]),
      sql,
      DEFAULT_RUBRIC,
    )
    expect(f.length).toBe(0)
  })
})

describe("dbt-patterns extended battery", () => {
  const M = "models/marts/m.sql"
  const fire = (newSql: string, added: string[], removed: string[] = []) =>
    detectModelPatterns(modelFile(M, newSql, added, removed), newSql, DEFAULT_RUBRIC)

  // NOTE: the base-vs-head `*_change` rules (COALESCE removed, DISTINCT/UNION flip,
  // GROUP BY change, type narrowing, removed predicate, surrogate-key change) moved to
  // the core AST `structural_diff` (tested in altimate-core + structuralChangeLane).
  test("DML in model → critical sql_correctness", () =>
    expect(has(fire("delete from t", ["delete from t where 1=1"]), "sql_correctness", "critical")).toBe(true))
  test("LIMIT in model → sql_correctness", () => expect(has(fire("x", ["limit 100"]), "sql_correctness")).toBe(true))
  test("random() → idempotency", () => expect(has(fire("x", ["select rand() as r"]), "idempotency")).toBe(true))
  test("= NULL → sql_correctness", () => expect(has(fire("x", ["where a = null"]), "sql_correctness")).toBe(true))
  test("full_refresh=true → materialization", () =>
    expect(has(fire("{{ config(full_refresh=true) }}", ["{{ config(full_refresh=true) }}"]), "materialization")).toBe(
      true,
    ))
  test("max() subquery boundary → warehouse_cost", () =>
    expect(has(fire("x", ["where ts >= (select max(ts) from {{ this }})"]), "warehouse_cost")).toBe(true))
  test("ORDER BY no LIMIT → warehouse_cost", () =>
    expect(has(fire("select a from t order by 1", ["order by 1"]), "warehouse_cost")).toBe(true))
  test("leading-wildcard LIKE → warehouse_cost", () =>
    expect(has(fire("x", ["where name like '%x'"]), "warehouse_cost")).toBe(true))
  test("constant join ON 1=1 → join_risk", () => expect(has(fire("x", ["join t on 1=1"]), "join_risk")).toBe(true))
  // hardcoded relation moved to core DBT006 (dbt_config_lint over raw Jinja).
  test("hardcoded date literal → freshness", () =>
    expect(has(fire("x", ["where created_at >= '2024-01-01'"]), "freshness")).toBe(true))
  test("timestamp→date cast → sql_correctness", () =>
    expect(has(fire("x", ["cast(order_at as date)"]), "sql_correctness")).toBe(true))
  test("HAVING without GROUP BY → sql_correctness", () =>
    expect(has(fire("select a from t having count(*) > 1", ["having count(*) > 1"]), "sql_correctness")).toBe(true))
  test("CASE without ELSE → sql_correctness", () =>
    expect(has(fire("x", ["case when a > 0 then 1 end"]), "sql_correctness")).toBe(true))
  test("comma join → join_risk", () => expect(has(fire("x", ["from a, b"]), "join_risk")).toBe(true))
  test("NATURAL JOIN → join_risk", () => expect(has(fire("x", ["natural join t"]), "join_risk")).toBe(true))
  test("self-join (same ref twice) → join_risk", () =>
    expect(
      has(
        fire("from {{ ref('o') }} a join {{ ref('o') }} b on a.id=b.id", ["join {{ ref('o') }} b on a.id=b.id"]),
        "join_risk",
      ),
    ).toBe(true))
  test("window without PARTITION BY → sql_correctness", () =>
    expect(has(fire("x", ["sum(a) over (order by b) as r"]), "sql_correctness")).toBe(true))
  test("BETWEEN on timestamp → sql_correctness", () =>
    expect(has(fire("x", ["where created_at between '2024-01-01' and '2024-12-31'"]), "sql_correctness")).toBe(true))
  test("float equality → sql_correctness", () =>
    expect(has(fire("x", ["where price = 9.99"]), "sql_correctness")).toBe(true))
  test("division no guard → sql_correctness", () =>
    expect(has(fire("x", ["select a / b as r"]), "sql_correctness")).toBe(true))
  test("AND/OR no parens → sql_correctness", () =>
    expect(has(fire("x", ["where a = 1 and b = 2 or c = 3"]), "sql_correctness")).toBe(true))
  test("OFFSET no ORDER BY → sql_correctness", () =>
    expect(has(fire("select a from t offset 5", ["offset 5"]), "sql_correctness")).toBe(true))
  test("multiple COUNT(DISTINCT) → warehouse_cost", () =>
    expect(has(fire("x", ["count(distinct a), count(distinct b)"]), "warehouse_cost")).toBe(true))

  // precision: a benign additive change fires NONE of the new detectors
  test("benign additive column → 0 findings (precision)", () =>
    expect(
      fire("select id, upper(name) as name_upper from {{ ref('x') }}", ["    upper(name) as name_upper,"]).length,
    ).toBe(0))
  test("division by literal is NOT flagged", () =>
    expect(has(fire("x", ["select amount / 100 as dollars"]), "sql_correctness")).toBe(false))
  test("safe_divide is NOT flagged", () =>
    expect(has(fire("x", ["select safe_divide(a, b) as r"]), "sql_correctness")).toBe(false))
})
