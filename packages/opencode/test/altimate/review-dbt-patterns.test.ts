import { describe, test, expect } from "bun:test"
import {
  detectModelPatterns,
  detectSchemaYmlPatterns,
  DEFAULT_RUBRIC,
  type ChangedFile,
} from "../../src/altimate/review"
import { dedupe } from "../../src/altimate/review/finding"

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

  // ------------------------------------------------------------------------
  // Post-R18 review follow-ups: structural YAML path + sibling-column edge case
  // + model-level tests + fallback shape. The rewritten detector prefers full
  // old/new file content; these tests validate both paths.
  // ------------------------------------------------------------------------

  test("schema.yml (structural): unique removed from one column while sibling keeps it → 1 finding on the affected column", () => {
    const oldContent = `version: 2
models:
  - name: customers
    columns:
      - name: customer_id
        tests: [unique, not_null]
      - name: email
        tests: [not_null]
  - name: orders
    columns:
      - name: order_id
        tests: [unique, not_null]
`
    const newContent = `version: 2
models:
  - name: customers
    columns:
      - name: customer_id
        tests: []
      - name: email
        tests: [not_null]
  - name: orders
    columns:
      - name: order_id
        tests: [unique, not_null]
`
    const f = detectSchemaYmlPatterns(
      { path: "models/marts/_models.yml", status: "modified", diff: undefined },
      DEFAULT_RUBRIC,
      { oldContent, newContent },
    )
    // 2 removals on customers.customer_id (unique + not_null), 0 on orders/email
    expect(f.length).toBe(2)
    expect(has(f, "test_coverage", "warning")).toBe(true)
    // At least one finding names customers.customer_id specifically
    expect(f.some((x) => (x.title || "").includes("customers.customer_id"))).toBe(true)
    // No finding attributed to orders.order_id (sibling still has `unique`)
    expect(f.some((x) => (x.title || "").includes("orders.order_id"))).toBe(false)
  })

  test("schema.yml (structural): model-level unique test removed → 1 finding with model-level attribution", () => {
    const oldContent = `version: 2
models:
  - name: customers
    tests:
      - unique
    columns:
      - name: customer_id
`
    const newContent = `version: 2
models:
  - name: customers
    columns:
      - name: customer_id
`
    const f = detectSchemaYmlPatterns(
      { path: "models/marts/_models.yml", status: "modified", diff: undefined },
      DEFAULT_RUBRIC,
      { oldContent, newContent },
    )
    expect(f.length).toBe(1)
    expect(f[0].category).toBe("test_coverage")
    expect(f[0].severity).toBe("warning")
    expect((f[0].title || "").includes("model-level")).toBe(true)
    // Attribution flag in evidence lets downstream see it wasn't column-scoped
    const evResult = (f[0].evidence?.result || {}) as Record<string, unknown>
    expect(evResult.attribution).toBe("model-level")
  })

  test("schema.yml (structural): block-form relationships removal is detected", () => {
    const oldContent = `version: 2
models:
  - name: orders
    columns:
      - name: customer_id
        tests:
          - relationships:
              to: ref('customers')
              field: customer_id
`
    const newContent = `version: 2
models:
  - name: orders
    columns:
      - name: customer_id
        tests: []
`
    const f = detectSchemaYmlPatterns(
      { path: "models/schema.yml", status: "modified", diff: undefined },
      DEFAULT_RUBRIC,
      { oldContent, newContent },
    )
    expect(f.length).toBe(1)
    expect((f[0].title || "").includes("relationships")).toBe(true)
  })

  test("schema.yml (structural): data_tests (dbt 1.8+ alias) is recognized", () => {
    const oldContent = `version: 2
models:
  - name: customers
    columns:
      - name: customer_id
        data_tests: [unique, not_null]
`
    const newContent = `version: 2
models:
  - name: customers
    columns:
      - name: customer_id
        data_tests: []
`
    const f = detectSchemaYmlPatterns(
      { path: "models/schema.yml", status: "modified", diff: undefined },
      DEFAULT_RUBRIC,
      { oldContent, newContent },
    )
    expect(f.length).toBe(2)
  })

  test("schema.yml (structural): source column test removal is detected", () => {
    const oldContent = `version: 2
sources:
  - name: raw
    tables:
      - name: users
        columns:
          - name: id
            tests: [unique, not_null]
`
    const newContent = `version: 2
sources:
  - name: raw
    tables:
      - name: users
        columns:
          - name: id
            tests: []
`
    const f = detectSchemaYmlPatterns(
      { path: "models/sources.yml", status: "modified", diff: undefined },
      DEFAULT_RUBRIC,
      { oldContent, newContent },
    )
    expect(f.length).toBe(2)
    // Source table gets qualified as `source.table` in the model field
    expect(f.some((x) => (x.title || "").includes("raw.users.id"))).toBe(true)
  })

  test("schema.yml (structural): added file (status=added, no oldContent) surfaces no removal findings", () => {
    const newContent = `version: 2
models:
  - name: customers
    columns:
      - name: customer_id
        tests: [unique, not_null]
`
    const f = detectSchemaYmlPatterns(
      { path: "models/schema.yml", status: "added", diff: undefined },
      DEFAULT_RUBRIC,
      { oldContent: undefined, newContent },
    )
    expect(f.length).toBe(0)
  })

  test("schema.yml (structural): renamed file with removed test still surfaces finding", () => {
    // Regression guard: earlier code only fetched oldContent when
    // status === "modified", so a rename that also dropped a guardrail test
    // silently bypassed the detector.
    const oldContent = `version: 2
models:
  - name: customers
    columns:
      - name: customer_id
        tests: [unique, not_null]
`
    const newContent = `version: 2
models:
  - name: customers
    columns:
      - name: customer_id
        tests: []
`
    const f = detectSchemaYmlPatterns(
      {
        path: "models/marts/_models.yml",
        status: "renamed",
        oldPath: "models/_models.yml",
        diff: undefined,
      },
      DEFAULT_RUBRIC,
      { oldContent, newContent },
    )
    expect(f.length).toBe(2)
    expect(has(f, "test_coverage", "warning")).toBe(true)
  })

  test("schema.yml (structural): modified file with oldContent=undefined falls back to diff detection", () => {
    // When the content resolver couldn't read the old side (e.g. transient
    // git failure) on a MODIFIED file, we must NOT treat the situation as
    // "added file, nothing removed" — the diff still contains real removed
    // lines. Fall back to line-based detection instead of silently dropping.
    const f = detectSchemaYmlPatterns(
      {
        path: "models/marts/_models.yml",
        status: "modified",
        diff: "-          - unique\n-          - not_null",
      },
      DEFAULT_RUBRIC,
      { oldContent: undefined, newContent: "version: 2\nmodels: []\n" },
    )
    expect(has(f, "test_coverage")).toBe(true)
  })

  test("schema.yml (fallback): diff-only path still surfaces removal (existing test's shape)", () => {
    // Exercises the fallback line-based detection when the orchestrator can't
    // supply file content (e.g. offline CI diffs).
    const f = detectSchemaYmlPatterns(
      {
        path: "models/marts/_models.yml",
        status: "modified",
        diff: "-          - unique\n-          - not_null",
      },
      DEFAULT_RUBRIC,
    )
    // At least one test_coverage finding surfaces so a customer isn't blind to
    // removed guardrails just because the content resolver wasn't wired.
    expect(has(f, "test_coverage")).toBe(true)
  })

  test("schema.yml (fallback): distinct removals of same test type on different columns each surface", () => {
    // Regression guard for the earlier dedup bug: (model="", column="", test)
    // key reduced to just `test` and silently collapsed distinct removals of
    // the same test type on different columns. The fallback path now emits
    // one finding per removed test-line.
    const f = detectSchemaYmlPatterns(
      {
        path: "models/marts/_models.yml",
        status: "modified",
        // Two `- unique` removed lines representing two different columns
        // losing the `unique` test in the same PR.
        diff: "-          - unique\n-          - not_null\n-          - unique\n-          - not_null",
      },
      DEFAULT_RUBRIC,
    )
    // 4 removed test-lines → 4 findings (fallback preserves per-line detail).
    expect(f.length).toBe(4)
    expect(has(f, "test_coverage", "warning")).toBe(true)
  })

  test("schema.yml (fallback): distinct removals survive the global fingerprint dedupe", () => {
    // Integration-shape guard: the detector-level test above returns 4
    // findings, but `runReview` runs a global `dedupe(findings)` step that
    // fingerprints by (category, file, model, column, ruleKey). If ruleKey
    // only varies by test-name for the fallback path, two `- unique`
    // removals share a fingerprint and get merged post-detector. This test
    // pipes the detector's output through `dedupe` to prove distinct
    // removals actually reach the user.
    const f = detectSchemaYmlPatterns(
      {
        path: "models/marts/_models.yml",
        status: "modified",
        diff: "-          - unique\n-          - not_null\n-          - unique\n-          - not_null",
      },
      DEFAULT_RUBRIC,
    )
    const deduped = dedupe(f)
    expect(deduped.length).toBe(4)
    // All 4 must be test_coverage findings; `unique` removals are `warning`,
    // and fallback `not_null` (no column attribution) is `suggestion` because
    // we can't tell if it was on an id/key column.
    expect(deduped.every((x) => x.category === "test_coverage")).toBe(true)
    // The 4 fingerprints must be distinct (was the exact regression: without
    // an occurrence-index discriminator in ruleKey, the two `- unique` and
    // two `- not_null` removals collapse to 2 findings after dedupe).
    expect(new Set(deduped.map((x) => x.id)).size).toBe(4)
    // 2 `- unique` (warning) + 2 `- not_null` (suggestion) — the exact split.
    expect(deduped.filter((x) => x.severity === "warning").length).toBe(2)
    expect(deduped.filter((x) => x.severity === "suggestion").length).toBe(2)
  })

  test("schema.yml (structural): distinct column removals also survive global dedupe", () => {
    // Structural attribution provides (model.column.test) uniqueness natively,
    // but the guard is worth codifying so future rule-key changes don't
    // silently regress into the fingerprint-collision failure mode.
    const oldContent = `version: 2
models:
  - name: customers
    columns:
      - name: customer_id
        tests: [unique]
      - name: email
        tests: [unique]
`
    const newContent = `version: 2
models:
  - name: customers
    columns:
      - name: customer_id
        tests: []
      - name: email
        tests: []
`
    const f = detectSchemaYmlPatterns(
      { path: "models/marts/_models.yml", status: "modified", diff: undefined },
      DEFAULT_RUBRIC,
      { oldContent, newContent },
    )
    const deduped = dedupe(f)
    expect(deduped.length).toBe(2)
    expect(new Set(deduped.map((x) => x.id)).size).toBe(2)
  })

  test("snapshot yml property file (structural): removed test surfaces finding", () => {
    // Regression: snapshot YAML property files were previously classified as
    // `snapshot` kind (blocking the `schema_yml` gate in the orchestrator).
    // Now `.yml` files under snapshots/ classify as `schema_yml` while `.sql`
    // snapshots stay `snapshot` (tier-forcing catalog rules unchanged).
    const oldContent = `version: 2
snapshots:
  - name: orders_snapshot
    columns:
      - name: order_id
        tests: [unique, not_null]
`
    const newContent = `version: 2
snapshots:
  - name: orders_snapshot
    columns:
      - name: order_id
        tests: []
`
    const f = detectSchemaYmlPatterns(
      { path: "snapshots/orders_snapshot.yml", status: "modified", diff: undefined },
      DEFAULT_RUBRIC,
      { oldContent, newContent },
    )
    expect(f.length).toBe(2)
    expect(has(f, "test_coverage", "warning")).toBe(true)
  })

  test("schema.yml summary: multi-model removals emit ONE aggregate summary line", () => {
    // Regression guard: the aggregate "This PR removes N tests total on
    // model(s) X, Y" summary was previously appended once per model, so a
    // diff touching two models produced two copies of the same summary in
    // separate findings. Now emitted once per FILE on the first finding.
    const oldContent = `version: 2
models:
  - name: customers
    columns:
      - name: customer_id
        tests: [unique]
  - name: orders
    columns:
      - name: order_id
        tests: [unique]
`
    const newContent = `version: 2
models:
  - name: customers
    columns:
      - name: customer_id
        tests: []
  - name: orders
    columns:
      - name: order_id
        tests: []
`
    const f = detectSchemaYmlPatterns(
      { path: "models/schema.yml", status: "modified", diff: undefined },
      DEFAULT_RUBRIC,
      { oldContent, newContent },
    )
    expect(f.length).toBe(2)
    // Only ONE finding body should contain the "removes N data tests in total"
    // aggregate summary line; the other should be plain.
    const summaryCount = f.filter((x) => (x.body || "").includes("data tests in total")).length
    expect(summaryCount).toBe(1)
    // And the mentioned model list should include BOTH models it touched.
    const withSummary = f.find((x) => (x.body || "").includes("data tests in total"))!
    expect(withSummary.body).toContain("`customers`")
    expect(withSummary.body).toContain("`orders`")
  })

  test("deleted schema.yml: every prior test surfaces as a removal finding (cubic-review P2)", () => {
    // Regression: deleting a whole schema.yml removes every test declared in
    // it — arguably a bigger removal than dropping a single test. Previously
    // the detector early-returned `[]` for `status === "deleted"`, so the
    // deletion went unnoticed. Now the detector diffs the old document against
    // an empty new document.
    const oldContent = `version: 2
models:
  - name: customers
    columns:
      - name: customer_id
        tests: [unique, not_null]
      - name: email
        tests: [not_null]
  - name: orders
    columns:
      - name: order_id
        tests: [unique]
`
    const f = detectSchemaYmlPatterns(
      { path: "models/marts/_models.yml", status: "deleted", diff: undefined },
      DEFAULT_RUBRIC,
      // Only oldContent is available for a deleted file; newContent is undefined
      // because git-show at HEAD would fail.
      { oldContent, newContent: undefined },
    )
    // 4 removals: customers.customer_id.unique, customers.customer_id.not_null,
    // customers.email.not_null, orders.order_id.unique
    expect(f.length).toBe(4)
    expect(has(f, "test_coverage", "warning")).toBe(true)
    // Structured attribution surfaces on the top-level Finding, not just in
    // evidence.result (cubic-review P3).
    const byModel = f.filter((x) => x.model === "customers")
    expect(byModel.length).toBe(3)
    const byColumn = f.filter((x) => x.column === "email")
    expect(byColumn.length).toBe(1)
  })

  test("deleted schema.yml without oldContent: no findings (safe degrade)", () => {
    // Without the old side, we can't know what tests to flag as removed.
    // The detector should degrade to `[]` rather than fabricating findings.
    const f = detectSchemaYmlPatterns(
      { path: "models/marts/_models.yml", status: "deleted", diff: undefined },
      DEFAULT_RUBRIC,
      { oldContent: undefined, newContent: undefined },
    )
    expect(f.length).toBe(0)
  })

  test("deleted schema.yml with unparsable oldContent + deletion diff → fallback surfaces removals", () => {
    // Structural path can't commit (old YAML fails to parse), so the diff-only
    // fallback runs. Confirms: unparsable-old → fallback, not silent drop.
    const oldContent = `version: 2
models:
  - name: customers
    columns:
      - name: customer_id
        tests:
          - not_null   # <-- unterminated block below causes parse failure
    tests: [
`
    // Diff uses the block-list shape the fallback regex targets
    // (`-      - unique` / `-      - not_null`).
    const diff = `--- a/models/marts/_models.yml
+++ /dev/null
@@ -1,8 +0,0 @@
-version: 2
-models:
-  - name: customers
-    columns:
-      - name: customer_id
-        tests:
-          - unique
-          - not_null
`
    const f = detectSchemaYmlPatterns(
      { path: "models/marts/_models.yml", status: "deleted", diff },
      DEFAULT_RUBRIC,
      { oldContent, newContent: undefined },
    )
    // Diff-only fallback picks up the removed `- unique` and `- not_null`
    // lines, so we still emit at least one removal finding rather than silently
    // dropping when the structural path couldn't commit.
    expect(f.length).toBeGreaterThan(0)
    expect(has(f, "test_coverage", "warning")).toBe(true)
  })

  test("deleted empty schema.yml: no fabricated findings (locks in precision)", () => {
    // Old side parses cleanly but declares no tests. Ensures the structural
    // loop doesn't fabricate findings when oldSet is empty.
    const oldContent = `version: 2
models: []
`
    const f = detectSchemaYmlPatterns(
      { path: "models/marts/_models.yml", status: "deleted", diff: undefined },
      DEFAULT_RUBRIC,
      { oldContent, newContent: undefined },
    )
    expect(f.length).toBe(0)
  })

  // R20 S1 — grain-key `not_null` completeness. Every column named in a
  // `unique_combination_of_columns` test's `combination_of_columns` must have
  // `not_null` coverage on the same model (constraint if contracted, data_test
  // if view). Directly targets PR D×2 + PR A×2 human findings in the R20
  // corpus study; explicit rule in DBT_GUIDELINES.md.
  test("R20 S1: unique_combination_of_columns with grain col missing not_null → warning finding", () => {
    // `price_start_time` is grain but has no not_null coverage → gap.
    // `metastore_id` / `sku_name` have not_null via constraints on the
    // contracted model → covered.
    const newContent = `version: 2
models:
  - name: mrt_billing_account_prices
    config:
      contract:
        enforced: true
    columns:
      - name: metastore_id
        constraints:
          - type: not_null
      - name: sku_name
        constraints:
          - type: not_null
      - name: price_start_time
    data_tests:
      - dbt_utils.unique_combination_of_columns:
          combination_of_columns:
            - metastore_id
            - sku_name
            - price_start_time
`
    const oldContent = newContent // steady-state (grain already present) — still fires
    const f = detectSchemaYmlPatterns(
      { path: "models/marts/mrt_billing_account_prices.yml", status: "modified", diff: undefined },
      DEFAULT_RUBRIC,
      { oldContent, newContent },
    )
    const gap = f.find((x) => (x.evidence?.result as any)?.rule === "grain_key_not_null_missing")
    expect(gap).toBeDefined()
    expect(gap!.severity).toBe("warning")
    expect(gap!.model).toBe("mrt_billing_account_prices")
    expect(gap!.column).toBe("price_start_time")
    // Contract is enforced → recommendation should point at `constraints:`.
    expect(gap!.body).toContain("constraints: [{type: not_null}]")
    // Non-gap columns must not appear as findings.
    expect(f.filter((x) => (x.evidence?.result as any)?.rule === "grain_key_not_null_missing").length).toBe(1)
  })

  test("R20 S1: non-contracted (view) model recommends data_tests: not_null", () => {
    const newContent = `version: 2
models:
  - name: stg_billing
    columns:
      - name: metastore_id
        data_tests:
          - not_null
      - name: sku_name
        data_tests:
          - not_null
      - name: price_start_time   # ← no not_null on this grain col
    data_tests:
      - dbt_utils.unique_combination_of_columns:
          combination_of_columns:
            - metastore_id
            - sku_name
            - price_start_time
`
    const f = detectSchemaYmlPatterns(
      { path: "models/staging/stg_billing.yml", status: "added", diff: undefined },
      DEFAULT_RUBRIC,
      { oldContent: undefined, newContent },
    )
    const gap = f.find((x) => (x.evidence?.result as any)?.rule === "grain_key_not_null_missing")
    expect(gap).toBeDefined()
    // Non-contracted model → recommendation should point at `data_tests:`.
    expect(gap!.body).toContain("data_tests:")
    expect(gap!.body).not.toContain("constraints: [{type: not_null}]")
  })

  test("R20 S1: grain col covered by column-level tests: [not_null] (dbt <1.8 alias) is not a gap", () => {
    const newContent = `version: 2
models:
  - name: mrt_x
    columns:
      - name: id
        tests:
          - not_null
    data_tests:
      - dbt_utils.unique_combination_of_columns:
          combination_of_columns: [id]
`
    const f = detectSchemaYmlPatterns(
      { path: "models/marts/mrt_x.yml", status: "added", diff: undefined },
      DEFAULT_RUBRIC,
      { oldContent: undefined, newContent },
    )
    expect(f.filter((x) => (x.evidence?.result as any)?.rule === "grain_key_not_null_missing").length).toBe(0)
  })

  test("R20 S1: SCD2-style grain (change_time) missing not_null flagged (PR D F4 shape)", () => {
    const newContent = `version: 2
models:
  - name: mrt_job_tasks_inventory
    config:
      contract:
        enforced: true
    columns:
      - name: metastore_id
        constraints: [{type: not_null}]
      - name: job_id
        constraints: [{type: not_null}]
      - name: task_key
        constraints: [{type: not_null}]
      - name: change_time   # ← temporal grain, no not_null
    data_tests:
      - dbt_utils.unique_combination_of_columns:
          combination_of_columns:
            - metastore_id
            - job_id
            - task_key
            - change_time
`
    const f = detectSchemaYmlPatterns(
      { path: "models/marts/mrt_job_tasks_inventory.yml", status: "added", diff: undefined },
      DEFAULT_RUBRIC,
      { oldContent: undefined, newContent },
    )
    const gaps = f.filter((x) => (x.evidence?.result as any)?.rule === "grain_key_not_null_missing")
    expect(gaps.length).toBe(1)
    expect(gaps[0].column).toBe("change_time")
  })

  test("R20 S1: no false positive when every grain col has not_null coverage", () => {
    const newContent = `version: 2
models:
  - name: mrt_x
    columns:
      - name: a
        data_tests: [not_null]
      - name: b
        data_tests: [not_null]
    data_tests:
      - dbt_utils.unique_combination_of_columns:
          combination_of_columns: [a, b]
`
    const f = detectSchemaYmlPatterns(
      { path: "models/marts/mrt_x.yml", status: "added", diff: undefined },
      DEFAULT_RUBRIC,
      { oldContent: undefined, newContent },
    )
    expect(f.filter((x) => (x.evidence?.result as any)?.rule === "grain_key_not_null_missing").length).toBe(0)
  })

  test("R20 S1: bare unique_combination_of_columns (no `dbt_utils.` prefix) also matches", () => {
    const newContent = `version: 2
models:
  - name: mrt_x
    columns:
      - name: id
    data_tests:
      - unique_combination_of_columns:
          combination_of_columns: [id]
`
    const f = detectSchemaYmlPatterns(
      { path: "models/marts/mrt_x.yml", status: "added", diff: undefined },
      DEFAULT_RUBRIC,
      { oldContent: undefined, newContent },
    )
    expect(f.filter((x) => (x.evidence?.result as any)?.rule === "grain_key_not_null_missing").length).toBe(1)
  })

  test("R20 S1: non-contracted model — `constraints: [not_null]` does NOT count as coverage", () => {
    // On a view / non-contracted model, `constraints:` is documentation
    // only (not enforced by the DB). Only column-level `not_null` data_tests
    // should count as coverage. Codex R20 S1 high #3.
    const newContent = `version: 2
models:
  - name: stg_x   # ← no config.contract.enforced
    columns:
      - name: id
        constraints:
          - type: not_null   # ← doesn't count on non-contracted model
    data_tests:
      - dbt_utils.unique_combination_of_columns:
          combination_of_columns: [id]
`
    const f = detectSchemaYmlPatterns(
      { path: "models/staging/stg_x.yml", status: "added", diff: undefined },
      DEFAULT_RUBRIC,
      { oldContent: undefined, newContent },
    )
    const gaps = f.filter((x) => (x.evidence?.result as any)?.rule === "grain_key_not_null_missing")
    expect(gaps.length).toBe(1)
    expect(gaps[0].body).toContain("data_tests:")
  })

  test("R20 S1: top-level `contract: {enforced: true}` (not nested under config:) is recognised", () => {
    // dbt supports declaring contract enforcement either at model.config.contract
    // or at model.contract directly. Both must count as contract-enforced so
    // the recommendation correctly suggests `constraints:`.
    const newContent = `version: 2
models:
  - name: mrt_x
    contract:
      enforced: true
    columns:
      - name: id
        constraints: [{type: not_null}]
      - name: change_time   # ← grain col, no not_null
    data_tests:
      - dbt_utils.unique_combination_of_columns:
          combination_of_columns: [id, change_time]
`
    const f = detectSchemaYmlPatterns(
      { path: "models/marts/mrt_x.yml", status: "added", diff: undefined },
      DEFAULT_RUBRIC,
      { oldContent: undefined, newContent },
    )
    const gaps = f.filter((x) => (x.evidence?.result as any)?.rule === "grain_key_not_null_missing")
    expect(gaps.length).toBe(1)
    expect(gaps[0].column).toBe("change_time")
    // Contract IS enforced (via top-level `contract:`) → recommendation should
    // point at `constraints:`, not data_tests.
    expect(gaps[0].body).toContain("constraints: [{type: not_null}]")
  })

  test("R20 S1: test-name match is exact, not endsWith (false-positive guard)", () => {
    // `not_unique_combination_of_columns` (fictional but plausible) or a
    // third-party macro ending in the same suffix must NOT trigger the rule.
    const newContent = `version: 2
models:
  - name: mrt_x
    columns:
      - name: id
    data_tests:
      - some_package.not_unique_combination_of_columns:
          combination_of_columns: [id]
`
    const f = detectSchemaYmlPatterns(
      { path: "models/marts/mrt_x.yml", status: "added", diff: undefined },
      DEFAULT_RUBRIC,
      { oldContent: undefined, newContent },
    )
    expect(f.filter((x) => (x.evidence?.result as any)?.rule === "grain_key_not_null_missing").length).toBe(0)
  })

  test("R20 S1: adapter case-folding — SNOWFLAKE_ID grain col matches snowflake_id column coverage", () => {
    // Snowflake folds unquoted identifiers to uppercase. If someone writes
    // `combination_of_columns: [WORKSPACE_ID]` while the column is declared
    // as `- name: workspace_id`, the coverage should still match.
    const newContent = `version: 2
models:
  - name: mrt_x
    columns:
      - name: workspace_id
        data_tests: [not_null]
    data_tests:
      - dbt_utils.unique_combination_of_columns:
          combination_of_columns: [WORKSPACE_ID]
`
    const f = detectSchemaYmlPatterns(
      { path: "models/marts/mrt_x.yml", status: "added", diff: undefined },
      DEFAULT_RUBRIC,
      { oldContent: undefined, newContent },
    )
    expect(f.filter((x) => (x.evidence?.result as any)?.rule === "grain_key_not_null_missing").length).toBe(0)
  })

  test("R20 S1: dbt 1.9+ `arguments:` nesting is recognised (real corpus shape)", () => {
    // The real internal corpus PRs use the dbt 1.9+ shape:
    // `- dbt_utils.unique_combination_of_columns: {arguments: {combination_of_columns: [...]}}`
    // Detector must recognise both nested (`arguments:`) and pre-1.9 flat forms.
    const newContent = `version: 2
models:
  - name: mrt_x
    config:
      contract:
        enforced: true
    columns:
      - name: a
        constraints: [{type: not_null}]
      - name: b   # ← missing not_null
    data_tests:
      - dbt_utils.unique_combination_of_columns:
          arguments:
            combination_of_columns: [a, b]
`
    const f = detectSchemaYmlPatterns(
      { path: "models/marts/mrt_x.yml", status: "added", diff: undefined },
      DEFAULT_RUBRIC,
      { oldContent: undefined, newContent },
    )
    const gaps = f.filter((x) => (x.evidence?.result as any)?.rule === "grain_key_not_null_missing")
    expect(gaps.length).toBe(1)
    expect(gaps[0].column).toBe("b")
  })

  test("R20 S1: does not fire when there's no unique_combination_of_columns test", () => {
    const newContent = `version: 2
models:
  - name: mrt_x
    columns:
      - name: a
      - name: b
`
    const f = detectSchemaYmlPatterns(
      { path: "models/marts/mrt_x.yml", status: "added", diff: undefined },
      DEFAULT_RUBRIC,
      { oldContent: undefined, newContent },
    )
    expect(f.filter((x) => (x.evidence?.result as any)?.rule === "grain_key_not_null_missing").length).toBe(0)
  })

  test("R20 S1: does not fire on deleted schema.yml (no current grain to guard)", () => {
    const oldContent = `version: 2
models:
  - name: mrt_x
    columns:
      - name: id
    data_tests:
      - dbt_utils.unique_combination_of_columns:
          combination_of_columns: [id]
`
    const f = detectSchemaYmlPatterns(
      { path: "models/marts/mrt_x.yml", status: "deleted", diff: undefined },
      DEFAULT_RUBRIC,
      { oldContent, newContent: undefined },
    )
    expect(f.filter((x) => (x.evidence?.result as any)?.rule === "grain_key_not_null_missing").length).toBe(0)
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
