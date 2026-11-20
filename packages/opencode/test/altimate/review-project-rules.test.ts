import { describe, test, expect } from "bun:test"
import {
  dbtProjectFindings,
  dispatchKwargFindings,
  dispatchVariants,
  docRefFindings,
  jinjaBalance,
  jinjaFindings,
  joinTargets,
  literalNullColumns,
  missingRefFindings,
  modelConfigFindings,
  packageLockFindings,
  packagesFindings,
  quickstartModelFindings,
  testWindowFindings,
  testsOnNullColumns,
  yamlParseFindings,
} from "../../src/altimate/review/project-rules"
import { CATALOG, ruleMatches, leftJoinNullifiedByWhere, evaluateCatalog } from "../../src/altimate/review/rule-catalog"
import { inlineConfigSplats, isSuppressiblePortability, runReview, type ReviewRunner } from "../../src/altimate/review/orchestrate"
import { DEFAULT_REVIEW_CONFIG } from "../../src/altimate/review/config"
import { detectMacroPatterns } from "../../src/altimate/review/dbt-patterns"
import { DEFAULT_RUBRIC } from "../../src/altimate/review/rubric"
import type { ChangedFile } from "../../src/altimate/review/diff-filter"

/**
 * Rules written from defects human reviewers found on public dbt PRs that a
 * deterministic check can catch. Each test pairs the defect's shape with the
 * nearby shape that must stay silent.
 */

const plus = (s: string) => s.split("\n").map((l) => "+" + l).join("\n")
const file = (path: string, added: string, status: ChangedFile["status"] = "modified"): ChangedFile => ({ path, status, diff: plus(added) })
const titles = (fs: { title: string }[]) => fs.map((f) => f.title)
const rule = (id: string) => CATALOG.find((r) => r.id === id)!
const fires = (id: string, sql: string, added = sql.split("\n"), removed: string[] = []) =>
  ruleMatches(rule(id), { file: { path: "models/m.sql", status: "modified" }, newSql: sql, added, removed })

describe("packages.yml", () => {
  const yml = (rev: string) => `packages:\n  - git: https://github.com/fivetran/dbt_stripe_source.git\n    revision: ${rev}\n`
  test("a git branch pin this PR touched is reported", () => {
    expect(titles(packagesFindings(file("packages.yml", "    revision: feature/new-cols"), yml("feature/new-cols")))).toEqual([
      "packages: package installed from a git branch",
    ])
  })
  test("a release tag, a commit sha, a hub package, or an untouched pin: silent", () => {
    expect(packagesFindings(file("packages.yml", "    revision: v0.15.1"), yml("v0.15.1"))).toHaveLength(0)
    expect(packagesFindings(file("packages.yml", "    revision: 1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c"), yml("1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c"))).toHaveLength(0)
    expect(packagesFindings(file("packages.yml", '    version: [">=0.15.0", "<0.16.0"]'), 'packages:\n  - package: fivetran/stripe_source\n    version: [">=0.15.0", "<0.16.0"]\n')).toHaveLength(0)
    expect(packagesFindings(file("packages.yml", "  - package: dbt-labs/dbt_utils"), yml("main"))).toHaveLength(0)
  })
})

describe("dbt_project.yml", () => {
  const f = (added: string) => file("dbt_project.yml", added)
  test("version going down, a duplicate grantee, a newly disabled resource", () => {
    expect(titles(dbtProjectFindings(f("version: '1.0.0'"), "name: x\nversion: '1.3.0'\n", "name: x\nversion: '1.0.0'\n"))).toContain("dbt_project: project version goes down")
    const grants = "models:\n  shop:\n    +grants:\n      select: ['bi', 'reverse_etl', 'bi']\n"
    expect(titles(dbtProjectFindings(f("      select: ['bi', 'reverse_etl', 'bi']"), "models:\n  shop:\n    +grants:\n      select: ['bi']\n", grants))[0]).toContain("duplicate grantee")
    expect(titles(dbtProjectFindings(f("      +enabled: false"), "models:\n  shop: {}\n", "models:\n  shop:\n    legacy:\n      +enabled: false\n"))).toContain("dbt_project: resources disabled in dbt_project.yml")
  })
  test("version going up, distinct grantees: silent", () => {
    expect(dbtProjectFindings(f("version: '2.0.0'"), "version: '1.3.0'\n", "version: '2.0.0'\n")).toHaveLength(0)
    expect(dbtProjectFindings(f("      select: ['bi', 'reverse_etl']"), "models: {}\n", "models:\n  shop:\n    +grants:\n      select: ['bi', 'reverse_etl']\n")).toHaveLength(0)
  })
})

describe("Jinja structure", () => {
  test("a stray endif, a missing endmacro, a macro without a parameter list", () => {
    expect(jinjaBalance("{% if a %}x{% endif %}\n{% endif -%}")).toContain("closes no open")
    expect(jinjaBalance("{% macro redshift__type_string() %}varchar{% macro x() %}y{% endmacro %}")).toContain("never closed")
    expect(jinjaBalance("{% macro postgres__upload_dbt_invocation %}x{% endmacro %}")).toContain("no parameter list")
  })
  test("set blocks, inline sets, raw blocks and whitespace control are balanced", () => {
    expect(jinjaBalance("{%- set q -%}select 1{%- endset -%}{% set y = 2 %}{% raw %}{% endif %}{% endraw %}{%- for c in cols -%}{{ c }}{%- endfor %}")).toBeUndefined()
  })
  test("with/block/autoescape blocks, and a block set whose filter argument holds `=` in a string", () => {
    expect(jinjaBalance("{% with a = 1 %}{{ a }}{% endwith %}{% block b %}x{% endblock %}{% autoescape false %}y{% endautoescape %}")).toBeUndefined()
    expect(jinjaBalance(`{% set q | replace("x", "a=b") %}select x{% endset %}`)).toBeUndefined()
  })
  test("reported only when this change broke it", () => {
    const broken = "{% if a %}x{% endif %}{% endif %}"
    expect(jinjaFindings(file("macros/m.sql", "{% endif %}"), "{% if a %}x{% endif %}", broken).map((f) => f.title)).toContain("m: Jinja block structure is broken")
    expect(jinjaFindings(file("macros/m.sql", "x"), broken, broken + "x").some((f) => /Jinja/.test(f.title))).toBe(false)
  })
  test("a macro parameter inserted before existing ones; appended is fine", () => {
    const old = "{% macro ghost(datatype, col_name, alias=none) %}{% endmacro %}"
    const inserted = "{% macro ghost(datatype, col_name, precision=none, scale=none, alias=none) %}{% endmacro %}"
    const appended = "{% macro ghost(datatype, col_name, alias=none, precision=none) %}{% endmacro %}"
    expect(titles(jinjaFindings(file("macros/ghost.sql", inserted), old, inserted))).toContain("ghost: `ghost` parameters moved position")
    expect(jinjaFindings(file("macros/ghost.sql", appended), old, appended).some((f) => /moved/.test(f.title))).toBe(false)
  })
  describe("macro-param-shifted anchors on the changed signature", () => {
    const shifted = (diff: string, old: string, head: string) =>
      jinjaFindings({ path: "macros/m.sql", status: "modified", diff }, old, head).find((f) => /moved/.test(f.title))

    test("multi-line signature: the inserted parameter line, not the unchanged `{% macro` line", () => {
      const old = "{% macro stab(\n    model,\n    max_change_percent,\n    days_back\n) %}\nx\n{% endmacro %}"
      const head = "{% macro stab(\n    model,\n    max_change_percent,\n    max_change_absolute,\n    days_back\n) %}\nx\n{% endmacro %}"
      const diff = "@@ -2,3 +2,4 @@\n     model,\n     max_change_percent,\n+    max_change_absolute,\n     days_back\n"
      const f = shifted(diff, old, head)!
      expect(f.startLine).toBe(4)
      expect((f.evidence!.result as { line?: string }).line).toBe("    max_change_absolute,")
    })

    test("single-line signature: the changed `{% macro` line", () => {
      const old = "{% macro ghost(a, b) %}{% endmacro %}"
      const head = "-- header\n{% macro ghost(a, x, b) %}{% endmacro %}"
      const diff = "@@ -1 +1,2 @@\n+-- header\n-{% macro ghost(a, b) %}{% endmacro %}\n+{% macro ghost(a, x, b) %}{% endmacro %}\n"
      expect(shifted(diff, old, head)!.startLine).toBe(2)
    })

    test("two macros in one file: each finding anchors inside its own signature", () => {
      const old = "{% macro one(a, b) %}{% endmacro %}\n{% macro two(\n  c,\n  d\n) %}{% endmacro %}"
      const head = "{% macro one(a, b) %}{% endmacro %}\n{% macro two(\n  e,\n  c,\n  d\n) %}{% endmacro %}"
      const diff = "@@ -2,2 +2,3 @@\n {% macro two(\n+  e,\n   c,\n"
      const f = shifted(diff, old, head)!
      expect(f.title).toContain("`two`")
      expect(f.startLine).toBe(3)
    })

    test("no added line inside the signature: no line set here (left to the evidence text)", () => {
      const old = "{% macro ghost(a, b) %}{% endmacro %}"
      const head = "{% macro ghost(b, a) %}{% endmacro %}"
      const f = shifted("@@ -5 +5 @@\n-x\n+y\n", old, head)!
      expect(f.startLine).toBeUndefined()
    })
  })

  test("a var() key renamed without the old key as a fallback", () => {
    const old = "{%- set concat = var('concat_string', '||') -%}"
    const renamed = "{%- set concat = var('datavault4dbt.concat_string', '||') -%}"
    const fallback = "{%- set concat = var('datavault4dbt.concat_string', var('concat_string', '||')) -%}"
    expect(titles(jinjaFindings(file("macros/hash.sql", renamed), old, renamed))).toContain("hash: var() key renamed without a fallback")
    expect(jinjaFindings(file("macros/hash.sql", fallback), old, fallback).some((f) => /renamed/.test(f.title))).toBe(false)

    const old2 = "select * from {{ var('issue_merged') }}"
    const handedOn = "{{ github_union_connections(connection_dictionary=var('github_sources'), single_table_name='issue_merged') }}"
    expect(jinjaFindings(file("models/tmp/t.sql", handedOn), old2, handedOn).some((f) => /renamed/.test(f.title))).toBe(false)
  })
  test("an unrelated var() removed and another added is not a rename", () => {
    const old = "select * from t where region = '{{ var('region') }}'"
    const now = "select * from t\nwhere ds >= '{{ var('start_date') }}'"
    expect(jinjaFindings(file("models/t.sql", now), old, now).some((f) => /renamed/.test(f.title))).toBe(false)
  })
  test("code its own comment marks temporary", () => {
    const sql = "where mod(abs(xxhash64(address)), 1000) = 0 -- TEMP CI VALIDATION SAMPLE - remove before merge"
    expect(titles(jinjaFindings(file("models/m.sql", sql), "select 1", sql))).toContain("m: code marked temporary is part of the change")
    const ok = "where mod(abs(xxhash64(address)), 1000) = 0 -- one in a thousand, as a template example"
    expect(jinjaFindings(file("models/m.sql", ok), "select 1", ok).some((f) => /temporary/.test(f.title))).toBe(false)
  })
  test("temporary-code phrasing: take this out, while debugging, remove it before release", () => {
    const temp = (sql: string) => jinjaFindings(file("models/m.sql", sql), "select 1", sql).some((f) => /temporary/.test(f.title))
    expect(temp("    where order_id < 50  -- sample while debugging locally, take this out before release")).toBe(true)
    expect(temp("    limit 100  -- take it out once the backfill finishes")).toBe(true)
    expect(temp("    and region = 'eu'  {# remove this before deploying #}")).toBe(true)
    expect(temp("    where amount > 0  -- zero-amount rows are voided payments from the card processor")).toBe(false)
    expect(temp("    where released_at < current_date  -- orders placed before release are pre-orders")).toBe(false)
    expect(temp("    -- take this out before release")).toBe(true)
    // Only comments count: the phrase in code or a string literal is not a marker.
    expect(temp("    select 'take this out' as label")).toBe(false)
    // Without removal intent the phrases describe code meant to stay.
    expect(temp("    limit 10  -- handy while debugging: take this out of the CTE to see raw rows")).toBe(false)
    expect(temp("    and is_test = false  -- surfaced while debugging the refund mismatch")).toBe(false)
    expect(temp("    limit 10  -- added while debugging")).toBe(true)
  })
})

describe("model config combinations", () => {
  const run = (sql: string, dialect = "bigquery") => titles(modelConfigFindings(file("models/m.sql", sql), sql, dialect))
  test("unique_key on a table", () => {
    expect(run("{{ config(materialized='table', unique_key='id') }}\nselect 1")).toContain("m: `unique_key` has no effect on a table")
    expect(run("{{ config(materialized='incremental', unique_key='id') }}\nselect 1")).not.toContain("m: `unique_key` has no effect on a table")
  })
  test("microbatch batch_size that can differ from the partition granularity", () => {
    const sql = `{{ config(materialized='incremental', incremental_strategy='microbatch', event_time='closed_at',\n  batch_size=('year' if flags.FULL_REFRESH else 'day'),\n  partition_by={'field': 'day', 'data_type': 'date', 'granularity': 'day'}) }}\nselect 1`
    expect(run(sql, "unknown")).toContain("m: microbatch `batch_size` differs from the partition granularity")
    expect(run(sql.replace("'year' if flags.FULL_REFRESH else 'day'", "'day'"))).not.toContain("m: microbatch `batch_size` differs from the partition granularity")
  })
  test("microbatch granularity mismatch is a BigQuery rule: silent on other known adapters", () => {
    const sql = `{{ config(materialized='incremental', incremental_strategy='microbatch', event_time='paid_at',\n  batch_size='hour',\n  partition_by={'field': 'paid_at', 'data_type': 'timestamp', 'granularity': 'day'}) }}\nselect 1`
    const title = "m: microbatch `batch_size` differs from the partition granularity"
    const at = (dialect: string, known = true) => titles(modelConfigFindings(file("models/m.sql", sql), sql, dialect, undefined, known))
    expect(at("bigquery")).toContain(title)
    for (const d of ["duckdb", "postgres", "snowflake", "databricks"]) expect(at(d)).not.toContain(title)
    // A guessed dialect: the BigQuery `granularity` dict still identifies the adapter.
    expect(at("snowflake", false)).toContain(title)
    expect(titles(modelConfigFindings(file("models/m.sql", sql), sql.replace("'hour'", "'day'"), "bigquery"))).not.toContain(title)
  })
  test("partition column missing from the merge key, and an incremental filter that doesn't prune", () => {
    const sql = `{{ config(materialized='incremental', incremental_strategy='merge', partition_by=['block_month'], unique_key=['tx_hash', 'evt_index']) }}\nselect * from t\n{% if is_incremental() %}\nwhere block_time >= now() - interval '1' day\n{% endif %}`
    const t = run(sql, "trino")
    expect(t).toContain("m: partition column is not in the merge `unique_key`")
    expect(t).toContain("m: incremental filter doesn't use the partition column")
    const ok = sql.replace("['tx_hash', 'evt_index']", "['block_month', 'tx_hash', 'evt_index']").replace("where block_time", "where block_month >= date_trunc('month', now()) and block_time")
    expect(run(ok, "trino")).toHaveLength(0)
  })
  test("merging on a key while filtering on the creation time misses updates", () => {
    const sql = `{{ config(materialized='incremental', unique_key='enrollment_key') }}\nselect * from e\n{% if is_incremental() %}\nwhere enrollment_created_on > (select max(enrollment_created_on) from {{ this }})\n{% endif %}`
    expect(run(sql, "trino")).toContain("m: incremental filter reads new rows only, not updated ones")
    expect(run(sql.replace(/enrollment_created_on/g, "enrollment_updated_on"), "trino")).not.toContain("m: incremental filter reads new rows only, not updated ones")
  })
  test("the creation-time filter finding quotes the added filter line", () => {
    const sql = `{{ config(materialized='incremental', unique_key='enrollment_key') }}\nselect * from e\n{% if is_incremental() %}\n  WHERE   Enrollment_Created_On > (select max(enrollment_created_on) from {{ this }})\n{% endif %}`
    const f = modelConfigFindings(file("models/m.sql", sql), sql, "trino").find((x) => x.rule === "dbt-project-rules:incremental-filter-created-only")
    expect((f?.evidence?.result as { line?: string } | undefined)?.line).toBe("  WHERE   Enrollment_Created_On > (select max(enrollment_created_on) from {{ this }})")
  })
})

describe("ref() targets", () => {
  const names = new Set(["stg_assets", "balancer_v3_avalanche_c_er4626_token_mapping", "dim_customer"])
  test("an unknown name is reported, with a near match when there is one", () => {
    const [f] = missingRefFindings(file("models/m.sql", "from {{ ref('recognized_assets') }}"), names)
    expect(f.title).toBe("m: `ref('recognized_assets')` points at no model")
    const [typo] = missingRefFindings(file("models/m.sql", "from {{ ref('balancer_v3_avalanche_c_erc4626_token_mapping') }}"), names)
    expect(typo.body).toContain("Did you mean `balancer_v3_avalanche_c_er4626_token_mapping`")
  })
  test("existing, versioned and package-qualified refs: silent", () => {
    expect(missingRefFindings(file("models/m.sql", "from {{ ref('stg_assets') }} join {{ ref('dim_customer', v=2) }}"), names)).toHaveLength(0)
    expect(missingRefFindings(file("models/m.sql", "from {{ ref('dbt_utils', 'some_model') }}"), names)).toHaveLength(0)
  })
  test("a versioned model defined only in `_v1`/`_v2` files resolves with and without a version", () => {
    const versioned = new Set(["dim_customers_v1", "dim_customers_v2"])
    expect(missingRefFindings(file("models/m.sql", "from {{ ref('dim_customers') }} join {{ ref('dim_customers', v=2) }}"), versioned)).toHaveLength(0)
  })
  test("two missing refs in one file keep distinct ids, so dedupe keeps both", () => {
    const fs = missingRefFindings(file("models/m.sql", "from {{ ref('x_missing') }} join {{ ref('y_missing') }}"), names)
    expect(fs).toHaveLength(2)
    expect(new Set(fs.map((f) => f.id)).size).toBe(2)
  })
})

describe("join keys", () => {
  test("a ref joined directly and through a pass-through CTE", () => {
    const sql = `with dim_course_run as (\n  select courserun_pk, courserun_readable_id from {{ ref('dim_course_run') }}\n)\nselect *\nfrom e\nleft join dim_course_run as cr\n  on e.courserun_readable_id = cr.courserun_readable_id\njoin {{ ref('orders') }} o on o.order_id = e.order_id`
    const t = joinTargets(sql, ["left join dim_course_run as cr", "join {{ ref('orders') }} o on o.order_id = e.order_id"])
    expect(t.map((x) => [x.model, x.keys, x.left])).toEqual([
      ["dim_course_run", ["courserun_readable_id"], true],
      ["orders", ["order_id"], false],
    ])
  })
  test("keys inside casts are read; range, OR and Jinja conditions skip the join", () => {
    const cast = `select * from o\nleft join {{ ref('dim_product') }} as p on cast(o.product_id as varchar) = cast(p.source_product_id as varchar) and o.platform = p.platform`
    expect(joinTargets(cast, ["left join {{ ref('dim_product') }} as p"]).map((x) => x.keys)).toEqual([["source_product_id", "platform"]])
    const skipped = [
      `select * from w\nleft join {{ ref('terms') }} as t on w.year = t.year and w.day between t.start_date and t.end_date`,
      `select * from w\nleft join {{ ref('terms') }} as t on w.year = t.year and w.day >= t.start_date`,
      `select * from w\nleft join {{ ref('terms') }} as t on w.id = t.id or w.alt_id = t.id`,
      `select * from w\nleft join {{ ref('terms') }} as t on w.id = t.id and {{ union_dataset_join_clause('w', 't') }}`,
    ]
    for (const sql of skipped) expect(joinTargets(sql, ["left join {{ ref('terms') }} as t"])).toHaveLength(0)
  })
  test("a CTE that aggregates changes the grain, and an unchanged join is not this PR's: skipped", () => {
    const sql = `with o as (\n  select order_id, count(*) n from {{ ref('orders') }} group by 1\n)\nselect * from e join o on o.order_id = e.order_id\njoin {{ ref('users') }} u on u.id = e.user_id`
    expect(joinTargets(sql, ["select * from e join o on o.order_id = e.order_id"])).toHaveLength(0)
  })
})

describe("tests on columns the SQL sets to NULL", () => {
  test("literal NULL projections", () => {
    expect([...literalNullColumns("select id, null as platform_fk, cast(null as varchar) as note, null::int as n, coalesce(x, null) as y")]).toEqual(["platform_fk", "note", "n"])
  })
  test("only the final SELECT counts: a UNION branch or a CTE that sets NULL is not an always-NULL column", () => {
    expect(literalNullColumns("select id, discount from a union all select id, null as discount from b").size).toBe(0)
    expect(literalNullColumns("with s as (select id, null as discount from a)\nselect id, coalesce(discount, 0) as discount from s").size).toBe(0)
    expect([...literalNullColumns("with s as (select id from a)\nselect id, null as discount from s")]).toEqual(["discount"])
  })
  test("a not_null/relationships test added on such a column", () => {
    const yml = "models:\n  - name: tfact_order\n    columns:\n      - name: platform_fk\n        data_tests:\n          - not_null\n          - relationships:\n              to: ref('dim_platform')\n              field: platform_pk\n      - name: order_id\n        data_tests: [not_null]\n"
    const sql = new Map([["tfact_order", "select order_id, null as platform_fk from o"]])
    const fs = testsOnNullColumns(file("models/_fact_tables.yml", "          - not_null"), yml, sql)
    expect(fs.map((f) => f.title)).toEqual(["_fact_tables: `tfact_order.platform_fk` is tested but the model sets it to NULL"])
  })
  test("only a test added on that column counts; relationships alone is not flagged", () => {
    const yml = "models:\n  - name: t\n    columns:\n      - name: platform_fk\n        data_tests:\n          - not_null\n      - name: order_id\n        data_tests:\n          - not_null\n      - name: other_fk\n        data_tests:\n          - relationships:\n              to: ref('d')\n              field: id\n"
    const sql = new Map([["t", "select order_id, null as platform_fk, null as other_fk from o"]])
    const hunk = (line: number, text: string): ChangedFile => ({ path: "models/_t.yml", status: "modified", diff: `@@ -${line},0 +${line},1 @@\n+${text}\n` })
    // `- not_null` added under order_id: the old test on platform_fk is not this PR's.
    expect(testsOnNullColumns(hunk(9, "          - not_null"), yml, sql)).toHaveLength(0)
    // `- not_null` added under platform_fk.
    expect(testsOnNullColumns(hunk(6, "          - not_null"), yml, sql)).toHaveLength(1)
    // A relationships test skips NULL keys.
    expect(testsOnNullColumns(hunk(12, "          - relationships:"), yml, sql)).toHaveLength(0)
  })
})

describe("SQL shapes from the catalog", () => {
  test("left-join-filtered-in-where fires only when the change touches the right side", () => {
    const sql = "select a.id, b.x\nfrom a\nleft join b on a.id = b.id\nwhere b.status = 'active'\n  and a.kind = 'x'"
    // An unrelated `and` on the left side: the old filter is not this PR's.
    expect(fires("left-join-filtered-in-where", sql, ["  and a.kind = 'x'"])).toBe(false)
    expect(fires("left-join-filtered-in-where", sql, ["where b.status = 'active'"])).toBe(true)
    expect(fires("left-join-filtered-in-where", sql, ["left join b on a.id = b.id"])).toBe(true)
  })
  test("LEFT JOIN filtered in WHERE; an IS NULL anti-join or a predicate in ON is fine", () => {
    expect(leftJoinNullifiedByWhere("select * from uc left join {{ ref('cd') }} as cd on uc.id = cd.id where cd.kind = ''")).toBe(true)
    expect(leftJoinNullifiedByWhere("select * from s left join g on s.id = g.id where g.id is not null")).toBe(true)
    expect(leftJoinNullifiedByWhere("select * from s left join g on s.id = g.id where g.id is null")).toBe(false)
    expect(leftJoinNullifiedByWhere("select * from s left join g on s.id = g.id and g.kind = '' where s.x = 1")).toBe(false)
    expect(leftJoinNullifiedByWhere("select * from s left join g on s.id = g.id where (g.kind = '' or g.kind is null)")).toBe(false)
  })
  test("case-folded on one side of a join only", () => {
    expect(fires("join-case-folded-one-side", "select * from c\njoin u\n  on lower(c.user_email) = u.email")).toBe(true)
    expect(fires("join-case-folded-one-side", "select * from c\njoin u\n  on lower(c.user_email) = lower(u.email)")).toBe(false)
  })
  test("null-safe comparison downgraded to =", () => {
    const sql = "select * from a join b on a.program_id = b.program_id"
    expect(fires("null-safe-join-removed", sql, ["  on a.program_id = b.program_id"], ["  on a.program_id is not distinct from b.program_id"])).toBe(true)
  })
  test("duplicate WHEN compares literal text, so different literals are distinct", () => {
    expect(fires("case-duplicate-when", "case\n when status = 'a' then 1\n when status = 'b' then 2\nend")).toBe(false)
    expect(fires("case-duplicate-when", "case\n when spend = 0 then 1\n when clicks = 0 then 2\n when spend = 0 then 3\nend")).toBe(true)
    expect(fires("case-duplicate-when", "case\n when grade = 'A' then 1\n when grade = 'a' then 2\nend")).toBe(false)
    expect(fires("case-duplicate-when", "case\n when Grade = 'A' then 1\n WHEN grade  =  'A' then 2\nend")).toBe(true)
  })
  test("duplicate WHEN ignores spacing and keyword case, but not literal case", () => {
    const tier = (third: string) =>
      `CASE\n    WHEN s.lifetime_spend >= 1000 THEN 'platinum'\n    WHEN s.lifetime_spend >= 500 THEN 'gold'\n    ${third}\n    ELSE 'standard'\nEND`
    expect(fires("case-duplicate-when", tier("WHEN s.lifetime_spend>=1000 THEN 'vip'"))).toBe(true)
    expect(fires("case-duplicate-when", tier("when S.Lifetime_Spend  >=  1000 then 'vip'"))).toBe(true)
    expect(fires("case-duplicate-when", tier("WHEN s.lifetime_spend>=100 THEN 'silver'"))).toBe(false)
    expect(fires("case-duplicate-when", "case\n when status = 'A' then 1\n when status = 'a' then 2\nend")).toBe(false)
  })
  test("window ORDER BY repeating the partition key", () => {
    expect(fires("window-order-repeats-partition", "row_number() over (partition by tx_hash, evt_index order by tx_hash) as rn")).toBe(true)
    expect(fires("window-order-repeats-partition", "row_number() over (partition by tx_hash order by block_time desc) as rn")).toBe(false)
    expect(fires("window-order-repeats-partition", "row_number() over (partition by a.id order by b.id) as rn")).toBe(false)
    expect(fires("window-order-repeats-partition", "row_number() over (partition by a.id order by a.id, ts) as rn")).toBe(true)
  })
  test("hardcoded year only in a filter, not in a CASE", () => {
    expect(fires("hardcoded-year-filter", "select * from t\nwhere academic_year = 2024")).toBe(true)
    expect(fires("hardcoded-year-filter", "select case when fiscal_year = 2024 then 'current' end as label from t")).toBe(false)
  })
  test("IGNORE NULLS inside the call, across lines", () => {
    const sql = "select\n  last_value(\n    content_title\n    ignore nulls\n  ) over (partition by k order by d) as t\nfrom x"
    expect(fires("ignore-nulls-inside-call", sql, ["    ignore nulls"])).toBe(true)
    expect(fires("ignore-nulls-inside-call", "select last_value(t) ignore nulls over (partition by k order by d) from x")).toBe(false)
    // DuckDB accepts IGNORE NULLS inside a navigation window call, so that form is portable there.
    const duck = rule("ignore-nulls-inside-call").portability?.alsoWorksOn
    expect(duck?.engines).toContain("duckdb")
    expect(duck?.check(sql)).toBe(true)
  })
  test("IGNORE NULLS inside an aggregate call followed by ORDER BY", () => {
    expect(fires("ignore-nulls-inside-call", "select ARRAY_AGG(status IGNORE NULLS ORDER BY order_date) as s from o")).toBe(true)
    expect(fires("ignore-nulls-inside-call", "select ARRAY_AGG(status IGNORE NULLS LIMIT 10) as s from o")).toBe(true)
    expect(fires("ignore-nulls-inside-call", "select ARRAY_AGG(status ORDER BY order_date) FILTER (WHERE status IS NOT NULL) as s from o")).toBe(false)
  })
  test("IGNORE NULLS inside the call: kept on Postgres/Snowflake; dropped on DuckDB for window functions only", () => {
    const ignoreNulls = (sql: string) =>
      evaluateCatalog({ path: "models/m.sql", status: "modified" }, sql, sql.split("\n"), [], DEFAULT_RUBRIC).find(
        (f) => (f.evidence?.result as { rule?: string }).rule === "ignore-nulls-inside-call",
      )!
    const win = ignoreNulls("select last_value(location_id ignore nulls) over (partition by c order by d) as l from o")
    const agg = ignoreNulls("select ARRAY_AGG(status IGNORE NULLS ORDER BY order_date) as s from o")
    expect(isSuppressiblePortability(win, "duckdb")).toBe(true)
    expect(isSuppressiblePortability(win, "bigquery")).toBe(true)
    expect(isSuppressiblePortability(win, "postgres")).toBe(false)
    expect(isSuppressiblePortability(win, "snowflake")).toBe(false)
    expect(isSuppressiblePortability(agg, "duckdb")).toBe(false)
    expect(isSuppressiblePortability(agg, "bigquery")).toBe(true)
  })
})

describe("portability in an adapter's own macro", () => {
  const macro = (path: string, body: string) => detectMacroPatterns({ path, status: "modified", diff: plus(body) }, body, DEFAULT_RUBRIC, new Set())
  test("QUALIFY in a BigQuery variant is valid there; in a generic macro it is reported", () => {
    const body = "{% macro default__sat(src) %}\nselect * from {{ src }}\nqualify row_number() over (partition by hk order by ldts) = 1\n{% endmacro %}"
    expect(macro("macros/tables/bigquery/sat_v0.sql", body).some((f) => /QUALIFY/.test(f.title))).toBe(false)
    expect(macro("macros/tables/sat_v0.sql", body).some((f) => /QUALIFY/.test(f.title))).toBe(true)
  })
  test("MIN_BY in a Postgres variant is still reported: Postgres lacks it", () => {
    const body = "{% macro postgres__latest(c) %}\nselect max_by(status, updated_at) from t\n{% endmacro %}"
    expect(macro("macros/latest.sql", body).some((f) => /MIN_BY/.test(f.title))).toBe(true)
  })
})

describe("config read from Jinja variables and project defaults", () => {
  test("batch_size set through a {% set %} variable", () => {
    const sql = `{% set batch_size = 'year' if flags.FULL_REFRESH else 'day' %}\n{{ config(materialized='incremental', incremental_strategy='microbatch', batch_size=batch_size, partition_by={'field': 'day', 'granularity': 'day'}) }}\nselect 1`
    expect(titles(modelConfigFindings(file("models/m.sql", sql), sql, "unknown"))).toContain("m: microbatch `batch_size` differs from the partition granularity")
  })
  test("materialization from the manifest when the file doesn't set it", () => {
    const sql = "{{ config(unique_key=['contract_id']) }}\nselect 1"
    expect(titles(modelConfigFindings(file("models/m.sql", sql), sql, "bigquery", { materialized: "table" }))).toContain("m: `unique_key` has no effect on a table")
    expect(titles(modelConfigFindings(file("models/m.sql", sql), sql, "bigquery", { materialized: "incremental" }))).not.toContain("m: `unique_key` has no effect on a table")
  })
})

describe("GROUP BY a single position in macro SQL", () => {
  const macro = (body: string, path = "macros/tables/hub.sql") =>
    detectMacroPatterns({ path, status: "modified", diff: plus(body) }, body, DEFAULT_RUBRIC, new Set())
  const ordinal = <T extends { rule?: string }>(fs: T[]) => fs.filter((f) => f.rule === "rule-catalog:macro-group-by-ordinal")
  const body = "{% macro hub(src_loaded_at) %}\nSELECT max(t.{{ src_loaded_at }}) AS {{ src_loaded_at }},\n'x' AS src_label\nFROM {{ this }} t\nGROUP BY 2\n{% endmacro %}"
  test("fires on the added GROUP BY line and records it", () => {
    const hits = ordinal(macro(body))
    expect(hits).toHaveLength(1)
    expect((hits[0].evidence?.result as { line?: string }).line).toBe("GROUP BY 2")
  })
  test("twin: grouping by the column name is silent", () => {
    expect(ordinal(macro(body.replace("GROUP BY 2", "GROUP BY src_label")))).toHaveLength(0)
  })
  test("two positions stay with group-by-positional; a model's GROUP BY 1 is not this rule", () => {
    expect(ordinal(macro(body.replace("GROUP BY 2", "GROUP BY 1, 2")))).toHaveLength(0)
    const sql = "select a, count(*) from t\ngroup by 1"
    const model = evaluateCatalog({ path: "models/m.sql", status: "modified" }, sql, sql.split("\n"), [], DEFAULT_RUBRIC)
    expect(ordinal(model)).toHaveLength(0)
  })
})

describe("parameter added to an existing macro without a default", () => {
  const noDefault = (diff: string, old: string, head: string, path = "macros/tests/anomalies.sql") =>
    jinjaFindings({ path, status: "modified", diff }, old, head).filter((f) => f.rule === "dbt-project-rules:macro-param-no-default")
  const old = "{% test anomalies(\n    model,\n    days_back,\n    sensitivity=3\n) %}\nselect 1\n{% endtest %}"
  const head = (p: string) => `{% test anomalies(\n    model,\n    days_back,\n    ${p},\n    sensitivity=3\n) %}\nselect 1\n{% endtest %}`
  const diff = (p: string) => `@@ -2,3 +2,4 @@\n     model,\n     days_back,\n+    ${p},\n     sensitivity=3\n`
  test("fires on the added parameter line of a test block", () => {
    const fs = noDefault(diff("floor_value"), old, head("floor_value"))
    expect(fs).toHaveLength(1)
    expect(fs[0].startLine).toBe(4)
    expect((fs[0].evidence!.result as { line?: string }).line).toBe("    floor_value,")
  })
  test("twin: the same parameter with `=none` is silent", () => {
    expect(noDefault(diff("floor_value=none"), old, head("floor_value=none"))).toHaveLength(0)
  })
  test("a new macro, or a parameter that already existed, is not a new required parameter", () => {
    expect(jinjaFindings({ path: "macros/m.sql", status: "added", diff: plus(head("floor_value")) }, undefined, head("floor_value")).filter((f) => f.rule === "dbt-project-rules:macro-param-no-default")).toHaveLength(0)
    const renamedOnly = "@@ -1 +1 @@\n-{% macro m(a, b) %}\n+{% macro m(a, b) -%}\n"
    expect(noDefault(renamedOnly, "{% macro m(a, b) %}{% endmacro %}", "{% macro m(a, b) -%}{% endmacro %}", "macros/m.sql")).toHaveLength(0)
  })
  test("an adapter variant gets every argument from its dispatcher: silent", () => {
    const o = "{% macro snowflake__sat(a, b) %}{% endmacro %}"
    const h = "{% macro snowflake__sat(a, b, skip_hwm) %}{% endmacro %}"
    expect(noDefault(`@@ -1 +1 @@\n-${o}\n+${h}\n`, o, h, "macros/sat.sql")).toHaveLength(0)
    const g = "{% macro sat(a, b, skip_hwm) %}{% endmacro %}"
    expect(noDefault(`@@ -1 +1 @@\n-${o.replace("snowflake__", "")}\n+${g}\n`, o.replace("snowflake__", ""), g, "macros/sat.sql")).toHaveLength(1)
  })
  test("defaults holding calls and lists do not split the parameter list", () => {
    const o = "{% macro m(a, cols=['x', 'y'], ts=dbt.current_timestamp()) %}{% endmacro %}"
    const h = "{% macro m(a, cols=['x', 'y'], ts=dbt.current_timestamp(), b) %}{% endmacro %}"
    const fs = noDefault(`@@ -1 +1 @@\n-${o}\n+${h}\n`, o, h, "macros/m.sql")
    expect(fs.map((f) => f.title)).toEqual(["m: new parameter `b` of `m` has no default"])
  })
})

describe("adapter.dispatch keyword a variant does not take", () => {
  const head = (variantParams: string, body = "select 1") =>
    [
      "{%- macro ghost(col, dtype, size=none, scale=none) -%}",
      "{{ return(adapter.dispatch('ghost', 'pkg')(col=col,",
      "                                            dtype=dtype,",
      "                                            size=size,",
      "                                            scale=scale)) }}",
      "{%- endmacro -%}",
      "",
      "{%- macro default__ghost(col, dtype, size, scale=none) -%}select 1{%- endmacro -%}",
      `{%- macro snowflake__ghost(${variantParams}) -%}${body}{%- endmacro -%}`,
    ].join("\n")
  const diff = "@@ -3,2 +3,3 @@\n                                             dtype=dtype,\n                                             size=size,\n+                                            scale=scale)) }}\n"
  const run = (sql: string) => {
    const f: ChangedFile = { path: "macros/ghost.sql", status: "modified", diff }
    return dispatchKwargFindings(f, sql, (name) => dispatchVariants(sql, name))
  }
  test("a variant without the new keyword: fires on the added keyword line", () => {
    const fs = run(head("col, dtype, size"))
    expect(fs).toHaveLength(1)
    expect(fs[0].rule).toBe("dbt-project-rules:dispatch-kwarg-not-in-variant")
    expect(fs[0].startLine).toBe(5)
    expect(fs[0].body).toContain("`snowflake__ghost`")
    expect(fs[0].body).not.toContain("`default__ghost`")
  })
  test("twin: every variant takes the keyword", () => {
    expect(run(head("col, dtype, size, scale=none"))).toHaveLength(0)
  })
  test("a variant that reads `kwargs` accepts any keyword", () => {
    expect(run(head("col, dtype, size", "{{ kwargs.get('scale') }}"))).toHaveLength(0)
  })
  test("a `{% test %}` block named like a variant is skipped, not a crash", () => {
    const sql = head("col, dtype, size, scale=none") + "\n{% test bigquery__ghost(model) %}select 1{% endtest %}"
    expect(dispatchVariants(sql, "ghost").map((v) => v.macro)).toEqual(["default__ghost", "snowflake__ghost"])
  })
  test("keywords on unchanged lines are not this change", () => {
    const f: ChangedFile = { path: "macros/ghost.sql", status: "modified", diff: "@@ -9 +9 @@\n-x\n+y\n" }
    const sql = head("col, dtype, size")
    expect(dispatchKwargFindings(f, sql, (name) => dispatchVariants(sql, name))).toHaveLength(0)
  })
})

describe("singular test lookback window shortened", () => {
  const edit = (before: string, after: string) =>
    testWindowFindings({ path: "tests/recent_rows.sql", status: "modified", diff: `@@ -5,3 +5,3 @@\n from t\n-${before}\n+${after}\n group by 1\n` })
  test("1 day to 30 minutes: fires on the added line", () => {
    const fs = edit(
      "where event_at >= timestamp_sub(current_timestamp(), interval 1 day)",
      "where event_at >= timestamp_sub(current_timestamp(), interval 30 minute)",
    )
    expect(fs).toHaveLength(1)
    expect(fs[0].startLine).toBe(6)
    expect(fs[0].body).toContain("from 1 day to 30 minutes")
  })
  test("dbt.dateadd with a negative day count", () => {
    expect(edit("where d >= {{ dbt.dateadd('day', -7, 'current_date') }}", "where d >= {{ dbt.dateadd('day', -3, 'current_date') }}")).toHaveLength(1)
  })
  test("twin: the same window written another way, or a longer window, is silent", () => {
    expect(edit("where d >= current_date - interval 1 day", "where d >= current_date - interval 24 hour")).toHaveLength(0)
    expect(edit("where d >= current_date - interval 1 day", "where d >= current_date - interval 2 day")).toHaveLength(0)
  })
  test("a rewritten filter (window replaced by a var) is not a literal shrink", () => {
    expect(edit("where d >= timestamp_sub(ts, interval 1 hour)", "where d >= timestamp('{{ var(\"batch_start\") }}')")).toHaveLength(0)
  })
})

/** A whole review over files given as head/base contents (diff = every head line added). */
async function prReview(
  files: { path: string; status?: ChangedFile["status"]; head?: string; base?: string; diff?: string }[],
  extra: Partial<Parameters<typeof runReview>[0]> & { tree?: Record<string, string> } = {},
) {
  const runner: ReviewRunner = {
    async impact() {
      return { hasManifest: true, severity: "SAFE", directCount: 0, transitiveCount: 0, testCount: 0 }
    },
    async grade() {
      return { grade: "A" }
    },
    async check() {
      return { issues: [], ran: true }
    },
    async equivalence() {
      return { decided: true, equivalent: true, differences: [], confidence: "high" } as any
    },
    async detectPii() {
      return { columns: [] }
    },
  }
  const byPath = new Map(files.map((f) => [f.path, f]))
  const { tree = {}, ...rest } = extra
  return runReview({
    changedFiles: files.map((f) => ({ path: f.path, status: f.status ?? "modified", diff: f.diff ?? plus(f.head ?? "") })),
    config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["dbt_patterns"] },
    rubric: DEFAULT_RUBRIC,
    mode: "comment",
    runner,
    forceTier: "full",
    getContent: async (p, side) => (side === "old" ? byPath.get(p)?.base : (byPath.get(p)?.head ?? tree[p])),
    ...rest,
  })
}
const ruleIds = (fs: { rule?: string }[]) => fs.map((f) => f.rule)

describe("YAML that stops parsing", () => {
  const base = "supported_vars:\n  order_metadata:\n    type: dictionary\n    display_name: Customer\n"
  const good = base + "\n  refund_metadata:\n    type: dictionary\n    display_name: Charge\n"
  const bad = base + "\n    refund_metadata:\n    type: dictionary\n    display_name: Charge\n"
  const f = (head: string): ChangedFile => ({ path: ".quickstart/quickstart.yml", status: "modified", diff: `@@ -4,0 +5,4 @@\n+\n+${head.split("\n").slice(5, 8).join("\n+")}\n` })
  test("a key indented under the previous entry duplicates its keys: fires on the error line", () => {
    const fs = yamlParseFindings(f(bad), base, bad)
    expect(fs).toHaveLength(1)
    expect(fs[0].rule).toBe("dbt-project-rules:yaml-parse-error")
    expect(fs[0].title).toContain("YAML key defined twice")
    expect(fs[0].startLine).toBe(6)
    expect((fs[0].evidence!.result as { line?: string }).line).toBe("    refund_metadata:")
  })
  test("twin: the same key at the right indentation is silent", () => {
    expect(yamlParseFindings(f(good), base, good)).toHaveLength(0)
  })
  test("a file that already failed at base is not this change", () => {
    expect(yamlParseFindings(f(bad), bad, bad)).toHaveLength(0)
  })
  test("runs on a quickstart file the review otherwise doesn't classify, and lists it as reviewed", async () => {
    const env = await prReview([{ path: ".quickstart/quickstart.yml", head: bad, base }])
    expect(ruleIds(env.findings)).toContain("dbt-project-rules:yaml-parse-error")
    expect((env.scope?.notReviewed ?? []).map((n) => n.path)).not.toContain(".quickstart/quickstart.yml")
  })
})

describe("new model missing from the quickstart public_models", () => {
  const qs = 'public_models: [\n  "crm__deals",\n  "crm__contacts",\n  "crm__companies"\n]\n'
  const model = "select 1 as id"
  test("a new crm__ model not listed: fires on the quickstart file", async () => {
    const env = await prReview([
      { path: ".quickstart/quickstart.yml", head: qs + "# touched\n", base: qs },
      { path: "models/history/crm__daily_deal_history.sql", status: "added", head: model },
      { path: "models/intermediate/int_crm__deal_spine.sql", status: "added", head: model },
    ])
    const f = env.findings.find((x) => x.rule === "dbt-project-rules:quickstart-public-model-missing")!
    expect(f.file).toBe(".quickstart/quickstart.yml")
    expect(f.body).toContain("`crm__daily_deal_history`")
    expect(f.body).not.toContain("int_crm__deal_spine")
  })
  test("twin: the new model is listed", async () => {
    const listed = qs.replace('"crm__companies"', '"crm__companies",\n  "crm__daily_deal_history"')
    const env = await prReview([
      { path: ".quickstart/quickstart.yml", head: listed, base: qs },
      { path: "models/history/crm__daily_deal_history.sql", status: "added", head: model },
    ])
    expect(ruleIds(env.findings)).not.toContain("dbt-project-rules:quickstart-public-model-missing")
  })
  test("an unrelated duplicate key elsewhere in the quickstart file doesn't hide the list", () => {
    const dup = qs + "table_variables:\n  crm_enabled:\n    - a\n  crm_enabled:\n    - b\n"
    const m: ChangedFile = { path: "models/crm__new.sql", status: "added" }
    expect(quickstartModelFindings(m, ".quickstart/quickstart.yml", dup, ["crm__new"])).toHaveLength(1)
    expect(quickstartModelFindings(m, ".quickstart/quickstart.yml", dup, ["crm__deals"])).toHaveLength(0)
  })
  test("quickstart unchanged: the finding goes on the new model", () => {
    const m: ChangedFile = { path: "models/crm__new.sql", status: "added" }
    expect(quickstartModelFindings(m, ".quickstart/quickstart.yml", qs, ["crm__new"])[0].file).toBe("models/crm__new.sql")
    expect(quickstartModelFindings(m, ".quickstart/quickstart.yml", qs, ["other__new"])).toHaveLength(0)
  })
})

describe("doc() reference with no docs block", () => {
  const base = "models:\n  - name: stg_ads\n    columns:\n      - name: campaign_id\n        description: \"{{ doc('campaign_id') }}\"\n"
  const head = (name: string) => base + `      - name: ${name}\n        description: "{{ doc('${name}') }}"\n`
  const yml = (name: string): ChangedFile => ({
    path: "models/staging/stg_ads.yml",
    status: "modified",
    diff: `@@ -5,0 +6,2 @@\n+      - name: ${name}\n+        description: "{{ doc('${name}') }}"\n`,
  })
  const defined = new Set(["campaign_id", "user_id"])
  const exists = async (n: string) => defined.has(n)
  test("a new doc() name no docs block defines: fires on its added line", async () => {
    const fs = await docRefFindings(yml("audience_id"), base, head("audience_id"), exists)
    expect(fs).toHaveLength(1)
    expect(fs[0].rule).toBe("dbt-project-rules:doc-block-missing")
    expect((fs[0].evidence!.result as { line?: string }).line).toBe(`        description: "{{ doc('audience_id') }}"`)
  })
  test("twin: a doc() name the project defines is silent", async () => {
    expect(await docRefFindings(yml("user_id"), base, head("user_id"), exists)).toHaveLength(0)
  })
  test("no other doc() in the file resolves locally (docs may come from a package): silent", async () => {
    expect(await docRefFindings(yml("audience_id"), base, head("audience_id"), async () => false)).toHaveLength(0)
  })
  test("end to end: the project's .md files are searched for the block", async () => {
    const searched: string[] = []
    const env = await prReview([{ path: "models/staging/stg_ads.yml", head: head("audience_id"), base, diff: yml("audience_id").diff }], {
      grepProject: async (pattern, glob) => {
        searched.push(`${pattern} ${glob}`)
        return pattern === "docs campaign_id" ? [{ path: "models/docs.md", line: 3, text: "{% docs campaign_id %}" }] : []
      },
    })
    expect(ruleIds(env.findings)).toContain("dbt-project-rules:doc-block-missing")
    expect(searched).toContain("docs audience_id *.md")
  })
})

describe("package-lock.yml added to a dbt package", () => {
  const lock = "packages:\n  - package: dbt-labs/dbt_utils\n    version: 1.3.0\nsha1_hash: abc\n"
  const run = (tree: Record<string, string>) =>
    prReview([{ path: "package-lock.yml", status: "added", head: lock }], { tree })
  test("a package (integration_tests project present): fires on the file's first line", async () => {
    const env = await run({ "dbt_project.yml": "name: pkg\nprofile: dev\n", "integration_tests/dbt_project.yml": "name: pkg_tests\nprofile: ci\n" })
    const f = env.findings.find((x) => x.rule === "dbt-project-rules:package-lock-in-package")!
    expect(f.file).toBe("package-lock.yml")
    expect((f.evidence!.result as { line?: string }).line).toBe("packages:")
    expect((env.scope?.notReviewed ?? []).map((n) => n.path)).not.toContain("package-lock.yml")
  })
  test("a package whose integration project is nested under integration_tests/<name>/", async () => {
    const env = await prReview([{ path: "package-lock.yml", status: "added", head: lock }], {
      tree: { "dbt_project.yml": "name: pkg\nprofile: dev\n" },
      grepProject: async (_p, glob) => (glob === "integration_tests/*dbt_project.yml" ? [{ path: "integration_tests/project/dbt_project.yml", line: 1, text: "name: pkg_tests" }] : []),
    })
    expect(ruleIds(env.findings)).toContain("dbt-project-rules:package-lock-in-package")
  })
  test("a package with no profile and no integration tests also counts", async () => {
    expect(ruleIds((await run({ "dbt_project.yml": "name: pkg\n" })).findings)).toContain("dbt-project-rules:package-lock-in-package")
  })
  test("twin: an application project (profile, no integration_tests) commits its lock file", async () => {
    expect(ruleIds((await run({ "dbt_project.yml": "name: app\nprofile: warehouse\n" })).findings)).not.toContain("dbt-project-rules:package-lock-in-package")
  })
  test("a lock file that was already committed (modified) is not this change", () => {
    expect(packageLockFindings({ path: "package-lock.yml", status: "modified", diff: plus(lock) }, true)).toHaveLength(0)
  })
})

describe("BigQuery incremental merge without incremental_predicates", () => {
  const sql = (extra = "") =>
    [
      "{% set meta_config = {",
      '    "materialized": "incremental",',
      '    "unique_key": ["event_id"],',
      '    "partition_by": {"field": "event_at", "data_type": "timestamp", "granularity": "month"}' + extra,
      "} %}",
      "{{ config(**meta_config) }}",
      "select * from {{ ref('ops') }}",
      "{% if is_incremental() %}",
      "where event_at >= timestamp('{{ var(\"batch_start\") }}')",
      "{% endif %}",
    ].join("\n")
  const predicates = (body: string, dialect = "bigquery") =>
    modelConfigFindings(
      { path: "models/marts/ops.sql", status: "modified", diff: "@@ -8,2 +8,3 @@\n+{% if is_incremental() %}\n+where event_at >= timestamp('{{ var(\"batch_start\") }}')\n" },
      inlineConfigSplats(body),
      dialect,
    ).filter((f) => f.rule === "dbt-project-rules:merge-no-incremental-predicates")
  test("partitioned merge with a unique_key and no predicates, incremental filter changed: fires", () => {
    const fs = predicates(sql())
    expect(fs).toHaveLength(1)
    expect(fs[0].body).toContain("`event_at`")
  })
  test("a strategy set in dbt_project.yml (manifest config) counts", () => {
    const run = (strategy: string) =>
      modelConfigFindings(
        { path: "models/marts/ops.sql", status: "modified", diff: "@@ -8,2 +8,3 @@\n+{% if is_incremental() %}\n+where event_at >= timestamp('{{ var(\"batch_start\") }}')\n" },
        inlineConfigSplats(sql()),
        "bigquery",
        { incremental_strategy: strategy },
      ).filter((f) => f.rule === "dbt-project-rules:merge-no-incremental-predicates")
    expect(run("insert_overwrite")).toHaveLength(0)
    expect(run("merge")).toHaveLength(1)
  })
  test("twin: incremental_predicates set", () => {
    expect(predicates(sql(',\n    "incremental_predicates": ["DBT_INTERNAL_DEST.event_at >= current_date - 3"]'))).toHaveLength(0)
  })
  test("another engine is left to partition-not-in-merge-key", () => {
    expect(predicates(sql(), "snowflake")).toHaveLength(0)
  })
})

describe("SQL text concatenated in Jinja without a space", () => {
  const seam = (line: string) => fires("jinja-concat-missing-space", line)
  test("a SQL literal ending in a word right at `~`", () => {
    expect(seam("{{ dbt.datediff('changed_at', 'coalesce(lead(changed_at) over (partition by ticket_id' ~ pkg.cols() ~ ' order by changed_at), now()', 'second') }}")).toBe(true)
    expect(seam("{{ 'select id from' ~ relation }}")).toBe(true)
  })
  test("twin: the space is inside the string", () => {
    expect(seam("{{ dbt.datediff('changed_at', 'coalesce(lead(changed_at) over (partition by ticket_id ' ~ pkg.cols() ~ ' order by changed_at), now()', 'second') }}")).toBe(false)
  })
  test("identifier building is not SQL text", () => {
    expect(seam("{{ ref('stg_' ~ source_name) }}")).toBe(false)
    expect(seam("{% set rel = target.schema ~ '_staging' %}")).toBe(false)
    expect(seam("{{ \"'\" ~ value ~ \"'\" }}")).toBe(false)
  })
  test("a Postgres regex match is not Jinja; messages are not SQL", () => {
    expect(seam("where name ~ 'acme corp'")).toBe(false)
    expect(seam("where {{ col }} ~ 'acme corp' and x = {{ var('y') }}")).toBe(false)
    expect(seam("{{ log('Running model' ~ model.name, info=true) }}")).toBe(false)
  })
})
