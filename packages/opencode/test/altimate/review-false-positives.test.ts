import { describe, test, expect } from "bun:test"
import { runReview, definedVars, inlineConfigSplats, type ReviewRunner } from "../../src/altimate/review/orchestrate"
import { detectMacroPatterns, detectModelPatterns, detectSchemaYmlPatterns } from "../../src/altimate/review/dbt-patterns"
import { CATALOG, ruleMatches, subqueryDepth, caseDepth, finalSelectStarFromRelation } from "../../src/altimate/review/rule-catalog"
import { incrementalFilter } from "../../src/altimate/review/incremental-semantics"
import { DEFAULT_RUBRIC } from "../../src/altimate/review/rubric"
import { DEFAULT_REVIEW_CONFIG } from "../../src/altimate/review/config"

/**
 * False positives found by replaying real PRs from public dbt repos (generic shapes,
 * not tied to any one project). Each case checks both directions: the wrong finding
 * is gone, and the real one still fires.
 */

const rule = (id: string) => CATALOG.find((r) => r.id === id)!
const fires = (id: string, sql: string, added = sql.split("\n")) =>
  ruleMatches(rule(id), { file: { path: "models/m.sql", status: "modified" }, newSql: sql, added, removed: [] })

describe("var with no default", () => {
  test("vars defined in dbt_project.yml are collected, top level and project-scoped", () => {
    const vars = definedVars("name: shop\nvars:\n  start_date: '2020-01-01'\n  shop:\n    window_days: 3\n")
    expect([...vars].sort()).toEqual(["shop", "start_date", "window_days"])
    expect(definedVars(undefined).size).toBe(0)
    expect(definedVars("vars: [oops").size).toBe(0)
  })

  const runner = (rules: { rule: string; message: string }[]) =>
    ({
      async impact() {
        return { hasManifest: true, severity: "SAFE", directCount: 0, transitiveCount: 0, testCount: 0 }
      },
      async grade() {
        return { grade: "B" }
      },
      async check() {
        return { issues: [], ran: true }
      },
      async detectPii() {
        return { columns: [] }
      },
      async dbtConfigLint() {
        return rules.map((r) => ({ ...r, code: "DBT005", severity: "warning" }))
      },
    }) as unknown as ReviewRunner

  const review = async (projectYml: string, model: string) => {
    const env = await runReview({
      changedFiles: [{ path: "models/m.sql", status: "added", diff: model.split("\n").map((l) => "+" + l).join("\n") }],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["dbt_patterns"] },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner: runner([{ rule: "var_no_default", message: "`var('start_date')` has no default" }]),
      getContent: async (f) => (f === "dbt_project.yml" ? projectYml : model),
    })
    return env.findings.filter((f) => /var no default/.test(f.title))
  }

  test("defined in dbt_project.yml, or defaulted elsewhere in the model: silent", async () => {
    expect(await review("vars:\n  start_date: '2020-01-01'\n", "select * from t where d > '{{ var(\"start_date\") }}'")).toHaveLength(0)
    expect(await review("name: x\n", "{% if var('start_date', none) %}select '{{ var(\"start_date\") }}'{% endif %}")).toHaveLength(0)
  })

  test("not defined anywhere: still reported", async () => {
    expect(await review("name: x\n", "select * from t where d > '{{ var(\"start_date\") }}'")).toHaveLength(1)
  })
})

describe("structural catalog checks", () => {
  test("nested subqueries count real nesting, not sibling CTEs", () => {
    const ctes = "with a as (select 1), b as (select 2), c as (select 3)\nselect * from a join b on true join c on true"
    expect(subqueryDepth(ctes)).toBe(1)
    expect(fires("nested-subqueries-deep", ctes)).toBe(false)
    expect(fires("nested-subqueries-deep", "select (select (select (select 1)))")).toBe(true)
  })

  test("nested CASE means a CASE inside a CASE, not two CASEs in one model", () => {
    const two = "select\n  case when a then 1 end as x,\n  case when b then 2 end as y\nfrom t"
    expect(caseDepth(two)).toBe(1)
    expect(fires("nested-case", two)).toBe(false)
    expect(fires("nested-case", "select case when a then case when b then 1 end end from t")).toBe(true)
  })

  test("CASE without END checks the whole model, so a multi-line CASE is fine", () => {
    const multi = "select\n  case\n    when a > 0 then 'pos'\n    else 'neg'\n  end as sign\nfrom t"
    expect(fires("case-when-no-end", multi, ["  case", "    when a > 0 then 'pos'"])).toBe(false)
    expect(fires("case-when-no-end", "select case when a > 0 then 1 from t")).toBe(true)
    // Jinja branches can emit a CASE per branch with one shared END: abstain.
    const jinja = "select {% if x %}case when a then 1{% else %}case when b then 2{% endif %} end from t"
    expect(fires("case-when-no-end", jinja)).toBe(false)
  })

  test("SELECT * in final projection only when it reads straight from another relation", () => {
    const viaCte = "with final as (\n  select id, name from {{ ref('x') }}\n)\nselect * from final"
    expect(finalSelectStarFromRelation(viaCte)).toBe(false)
    expect(fires("select-star-in-cte-final", viaCte)).toBe(false)
    const importCte = "with src as (\n  select * from {{ source('s', 't') }}\n)\nselect id from src"
    expect(fires("select-star-in-cte-final", importCte)).toBe(false)
    expect(fires("select-star-in-cte-final", "select * from {{ ref('orders') }}")).toBe(true)
  })
})

describe("function on a column in WHERE", () => {
  const run = (line: string) =>
    detectModelPatterns({ path: "models/m.sql", status: "modified", diff: `+${line}` }, `select * from t\n${line}`, DEFAULT_RUBRIC).filter((f) =>
      /partition pruning/.test(f.title),
    )
  test("a function around a literal, a var or the clock: silent", () => {
    expect(run("where is_deleted = cast(0 as boolean)")).toHaveLength(0)
    expect(run("and event_date >= cast('{{ var(\"start\") }}' as date)")).toHaveLength(0)
    expect(run("and event_date >= date_trunc('day', current_date)")).toHaveLength(0)
  })
  test("a function around a column: still reported", () => {
    expect(run("where year(event_date) = 2024")).toHaveLength(1)
    expect(run("and date_trunc('day', created_at) = '2024-01-01'")).toHaveLength(1)
    expect(run("and cast(o.created_at as date) = current_date")).toHaveLength(1)
  })
})

describe("data test removed vs moved with a column rename", () => {
  const yml = (col: string) => `version: 2
models:
  - name: dim_ports
    columns:
      - name: ${col}
        data_tests:
          - unique
          - not_null
`
  const removed = (oldCol: string, newContent: string) =>
    detectSchemaYmlPatterns({ path: "models/marts/_dim.yml", status: "modified", diff: undefined }, DEFAULT_RUBRIC, {
      oldContent: yml(oldCol),
      newContent,
    }).filter((f) => /test removed/.test(f.title))

  test("tests that moved to the renamed column are not removals", () => {
    expect(removed("port_sk", yml("port_key"))).toHaveLength(0)
  })
  test("a test dropped for real is still reported", () => {
    const dropped = "version: 2\nmodels:\n  - name: dim_ports\n    columns:\n      - name: port_sk\n        data_tests:\n          - not_null\n"
    expect(removed("port_sk", dropped).map((f) => f.title)).toEqual(["_dim.yml: unique test removed from dim_ports.port_sk"])
  })
})

describe("incremental filter = predicates of the is_incremental() branch", () => {
  const model = (selectExpr: string, where: string) => `with src as (select * from {{ ref('raw') }})
{% if is_incremental() %}
, merged as (
  select n.id, ${selectExpr} as tags
  from src as n left join {{ this }} as b on n.id = b.id
  ${where}
)
{% else %}
, merged as (select id, tags from src)
{% endif %}
select * from merged`

  test("a select-list edit inside the block is not a filter change", () => {
    expect(incrementalFilter(model("array_distinct(n.tags)", "where n.ts > (select max(ts) from {{ this }})"))).toBe(
      incrementalFilter(model("{{ array_distinct('n.tags') }}", "where n.ts > (select max(ts) from {{ this }})")),
    )
  })
  test("a changed predicate is", () => {
    expect(incrementalFilter(model("n.tags", "where n.ts > (select max(ts) from {{ this }})"))).not.toBe(
      incrementalFilter(model("n.tags", "where n.ts >= (select max(ts) - interval 3 day from {{ this }})")),
    )
  })
  test("a bare predicate fragment and the else branch", () => {
    const frag = (op: string) => `select * from t\n{% if is_incremental() %}\n  where updated_at ${op} (select max(updated_at) from {{ this }})\n{% else %}\n  where true\n{% endif %}`
    expect(incrementalFilter(frag(">"))).not.toBe(incrementalFilter(frag(">=")))
    const elseOnly = (w: string) => `select * from t\n{% if is_incremental() %}\n  where u > 1\n{% else %}\n  ${w}\n{% endif %}`
    expect(incrementalFilter(elseOnly("where a"))).toBe(incrementalFilter(elseOnly("where b")))
  })
})

describe("config shared through a dict splat", () => {
  test("a flat literal dict is inlined into config(**dict)", () => {
    const sql = `{% set meta_config = {\n  "materialized": "incremental",\n  "unique_key": ["day", "code"],\n} %}\n{{ config(meta=meta_config, **meta_config) }}\nselect 1`
    const out = inlineConfigSplats(sql)
    expect(out).toContain(`materialized= "incremental"`)
    expect(out).toContain(`unique_key= ["day", "code"]`)
    expect(out).not.toContain("**meta_config")
  })
  test("no literal dict: untouched", () => {
    const sql = "{{ config(**get_config()) }}\nselect 1"
    expect(inlineConfigSplats(sql)).toBe(sql)
  })
})

describe("changed macros are reviewed", () => {
  const macro = (body: string) => ({ path: "macros/m.sql", status: "modified" as const, diff: body.split("\n").map((l) => "+" + l).join("\n") })
  const titles = (body: string, vars = new Set<string>()) =>
    detectMacroPatterns(macro(body), body, DEFAULT_RUBRIC, vars).map((f) => f.title)

  test("SQL shapes that hold in a template fire", () => {
    expect(titles("{% macro m(t) %}\nselect top 1 x from {{ t }}\n{% endmacro %}").some((t) => /TOP/i.test(t))).toBe(true)
    expect(titles("{% macro m(a, b) %}\nselect * from {{ a }} as a join {{ b }} as b\n  on a.id = b.id\n  or a.alt = b.alt\n{% endmacro %}").some((t) => /OR in a join/.test(t))).toBe(true)
  })
  test("var with no default: reported unless the project sets it or it is defaulted elsewhere", () => {
    const body = "{% macro m() %}\n{% if var('dbt_artifacts_exclude_all_results') %}x{% endif %}\n{% endmacro %}"
    expect(titles(body).some((t) => /dbt_artifacts_exclude_all_results/.test(t))).toBe(true)
    expect(titles(body, new Set(["dbt_artifacts_exclude_all_results"]))).toHaveLength(0)
    expect(titles(body + "\n{{ var('dbt_artifacts_exclude_all_results', false) }}")).toHaveLength(0)
  })
  test("model-only rules stay off macros", () => {
    expect(titles("{% macro m() %}\nselect * from {{ ref('x') }}\n{% endmacro %}")).toHaveLength(0)
  })
})

describe("incremental unique_key vs the declared uniqueness test", () => {
  const review = async (uniqueKey: unknown, declared: string[][]) => {
    const runner = {
      async impact() {
        return { hasManifest: true, severity: "SAFE", directCount: 0, transitiveCount: 0, testCount: 0 }
      },
      async grade() {
        return { grade: "B" }
      },
      async check() {
        return { issues: [], ran: true }
      },
      async detectPii() {
        return { columns: [] }
      },
      async modelConfig() {
        return { materialized: "incremental", unique_key: uniqueKey }
      },
      async declaredUniqueKeys() {
        return declared
      },
    } as unknown as ReviewRunner
    const env = await runReview({
      changedFiles: [{ path: "models/int_latest.sql", status: "added", diff: "+select 1" }],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["dbt_patterns"] },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      getContent: async () => "select 1",
    })
    return env.findings.filter((f) => /unique_key differs/.test(f.title))
  }
  test("a merge key with a column the test lacks is reported", async () => {
    const [f] = await review(["charge_point_id", "connector_id", "port_id"], [["charge_point_id", "connector_id"]])
    expect(f.body).toContain("[charge_point_id, connector_id, port_id]")
  })
  test("same set (any order or case), or no test: silent", async () => {
    expect(await review(["B", "a"], [["a", "b"]])).toHaveLength(0)
    expect(await review("id", [["ID"]])).toHaveLength(0)
    expect(await review(["a", "b"], [])).toHaveLength(0)
  })
  test("declared key plus date/partition columns: silent; plus an entity column or a narrower key: reported", async () => {
    expect(await review(["blockchain", "tx_hash", "evt_index", "block_month"], [["blockchain", "tx_hash", "evt_index"]])).toHaveLength(0)
    expect(await review(["course_pk", "effective_date"], [["course_pk"]])).toHaveLength(0)
    expect((await review(["address", "chain_id"], [["address"]]))[0].severity).toBe("suggestion")
    expect((await review(["date_start", "operator"], [["blockchain", "date_start", "operator"]]))[0].severity).toBe("warning")
  })
})

describe("OR in a join condition", () => {
  const sql = (on: string) => `select * from a\njoin b\n  on ${on}`
  test("alternative keys or overlapping ranges: reported", () => {
    expect(fires("join-or-condition", sql("(a.courserun_fk = b.courserun_fk\n    or a.program_fk = b.program_fk)\n  and a.platform_fk = b.platform_fk"))).toBe(true)
    expect(fires("join-or-condition", sql("a.id = b.id\n  and (\n    a.start_date between b.entrydate and b.exitdate\n    or a.end_date between b.entrydate and b.exitdate\n  )"))).toBe(true)
  })
  test("an open-ended interval or null-safe key guard: silent", () => {
    expect(fires("join-or-condition", sql("d.ts >= lp.day and (lp.next_update_day is null or d.ts < lp.next_update_day)"))).toBe(false)
    expect(fires("join-or-condition", sql("dt.day >= date(t.valid_from)\n  and (dt.day < date(t.valid_to)\n    or t.valid_to is null)"))).toBe(false)
    expect(fires("join-or-condition", sql("a.k = b.k or (a.k is null and b.k is null)"))).toBe(false)
  })
})

describe("engine check results in a dbt model", () => {
  const review = async (issues: { rule: string; message: string; severity?: string }[]) => {
    const runner = {
      async impact() {
        return { hasManifest: true, severity: "SAFE", directCount: 0, transitiveCount: 0, testCount: 0 }
      },
      async grade() {
        return { grade: "B" }
      },
      async check() {
        return { issues: issues.map((i) => ({ severity: "error", ...i })), ran: true }
      },
      async detectPii() {
        return { columns: [] }
      },
    } as unknown as ReviewRunner
    const env = await runReview({
      changedFiles: [{ path: "models/m.sql", status: "modified", diff: "+select 1" }],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["sql_quality"] },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      getContent: async () => "select 1",
    })
    return env.findings.filter((f) => f.evidence?.tool === "altimate_core.check")
  }
  test("injection rules and engine planner gaps: silent", async () => {
    expect(
      await review([
        { rule: "union_injection", message: "UNION SELECT injection detected" },
        { rule: "comment_injection", message: "Comment injection detected (line comment)" },
        { rule: "unbalanced_quote", message: "Unbalanced string quote (possible injection breakout)" },
        { rule: "validate", message: "Error during planning: Cannot coerce arithmetic expression Int64 * Interval(MonthDayNano)" },
        { rule: "validate", message: "This feature is not implemented: Arrays with unspecified type is not supported" },
      ]),
    ).toHaveLength(0)
  })
  test("a parser syntax error is a suggestion; an unresolved column stays a warning", async () => {
    const fs = await review([
      { rule: "validate", message: "Syntax error: sql parser error: Expected: ), found: omit" },
      { rule: "validate", message: "Column 'group_name' not found in table 'run_results'" },
    ])
    expect(fs.find((f) => /Syntax/.test(f.body))?.severity).toBe("suggestion")
    expect(fs.find((f) => /not found/.test(f.body))?.severity).toBe("warning")
  })
})

describe("whole-model shapes need the shape itself, not its words anywhere", () => {
  test("SELECT * in a UNION: only a branch that is select *", () => {
    expect(fires("union-select-star", "with a as (select id from x union all select id from y)\nselect * from a")).toBe(false)
    expect(fires("union-select-star", "select * from {{ ref('a') }}\nunion all\nselect * from {{ ref('b') }}")).toBe(true)
  })
  test("ORDER BY in a CTE: not a window or aggregate ORDER BY, not a top-N", () => {
    expect(fires("order-by-in-cte", "with x as (\n  select a, row_number() over (partition by k order by ts) as rn from t\n)\nselect * from x")).toBe(false)
    expect(fires("order-by-in-cte", "with x as (\n  select a from t\n  order by a\n  limit 10\n)\nselect * from x")).toBe(false)
    expect(fires("order-by-in-cte", "with x as (\n  select a from t\n  order by a\n)\nselect * from x")).toBe(true)
  })
  test("unqualified column: a bare column on a changed line of a joining SELECT", () => {
    const sql = "select\n  a.id,\n  name\nfrom a\njoin b on a.k = b.k"
    expect(fires("unqualified-column-multi-table", sql, ["  name"])).toBe(true)
    expect(fires("unqualified-column-multi-table", "select\n  a.id,\n  b.name\nfrom a\njoin b on a.k = b.k", ["  b.name"])).toBe(false)
    // A bare column in a SELECT without a join, while another block joins with qualified columns.
    expect(fires("unqualified-column-multi-table", "with s as (select id, name from t)\nselect s.id, u.x from s join u on s.id = u.id", ["with s as (select id, name from t)"])).toBe(false)
  })
})

describe("window function without PARTITION BY", () => {
  const titles = (sql: string) =>
    detectModelPatterns({ path: "models/m.sql", status: "modified", diff: sql.split("\n").map((l) => "+" + l).join("\n") }, sql, DEFAULT_RUBRIC).map((f) => f.title)
  test("PARTITION BY on the line after `over (`: silent", () => {
    expect(titles("select\n  row_number() over (\n    partition by k\n    order by ts\n  ) as rn\nfrom t").some((t) => /PARTITION BY/.test(t))).toBe(false)
  })
  test("a whole-table window: reported", () => {
    expect(titles("select\n  row_number() over (\n    order by ts\n  ) as rn\nfrom t").some((t) => /PARTITION BY/.test(t))).toBe(true)
  })
})
