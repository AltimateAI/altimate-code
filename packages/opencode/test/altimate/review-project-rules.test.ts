import { describe, test, expect } from "bun:test"
import {
  dbtProjectFindings,
  jinjaBalance,
  jinjaFindings,
  joinTargets,
  literalNullColumns,
  missingRefFindings,
  modelConfigFindings,
  packagesFindings,
  testsOnNullColumns,
} from "../../src/altimate/review/project-rules"
import { CATALOG, ruleMatches, leftJoinNullifiedByWhere } from "../../src/altimate/review/rule-catalog"
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
  test("code its own comment marks temporary", () => {
    const sql = "where mod(abs(xxhash64(address)), 1000) = 0 -- TEMP CI VALIDATION SAMPLE - remove before merge"
    expect(titles(jinjaFindings(file("models/m.sql", sql), "select 1", sql))).toContain("m: code marked temporary is part of the change")
    const ok = "where mod(abs(xxhash64(address)), 1000) = 0 -- one in a thousand, as a template example"
    expect(jinjaFindings(file("models/m.sql", ok), "select 1", ok).some((f) => /temporary/.test(f.title))).toBe(false)
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
  test("a not_null/relationships test added on such a column", () => {
    const yml = "models:\n  - name: tfact_order\n    columns:\n      - name: platform_fk\n        data_tests:\n          - not_null\n          - relationships:\n              to: ref('dim_platform')\n              field: platform_pk\n      - name: order_id\n        data_tests: [not_null]\n"
    const sql = new Map([["tfact_order", "select order_id, null as platform_fk from o"]])
    const fs = testsOnNullColumns(file("models/_fact_tables.yml", "          - not_null"), yml, sql)
    expect(fs.map((f) => f.title)).toEqual(["_fact_tables: `tfact_order.platform_fk` is tested but the model sets it to NULL"])
  })
})

describe("SQL shapes from the catalog", () => {
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
  })
  test("window ORDER BY repeating the partition key", () => {
    expect(fires("window-order-repeats-partition", "row_number() over (partition by tx_hash, evt_index order by tx_hash) as rn")).toBe(true)
    expect(fires("window-order-repeats-partition", "row_number() over (partition by tx_hash order by block_time desc) as rn")).toBe(false)
  })
  test("IGNORE NULLS inside the call, across lines", () => {
    const sql = "select\n  last_value(\n    content_title\n    ignore nulls\n  ) over (partition by k order by d) as t\nfrom x"
    expect(fires("ignore-nulls-inside-call", sql, ["    ignore nulls"])).toBe(true)
    expect(fires("ignore-nulls-inside-call", "select last_value(t) ignore nulls over (partition by k order by d) from x")).toBe(false)
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
