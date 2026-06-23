// altimate_change - new file: real-world pain-point corpus for dbt PR review.
//
// Each BAD case is a pitfall practitioners actually report (with a SOURCE), turned
// into a reproducible test. Each GOOD case is the correct version that must stay
// quiet (precision). Run: bun run --conditions=browser script/review-realworld-eval.ts
import { runReview } from "../src/altimate/review/orchestrate"
import { createDispatcherRunner } from "../src/altimate/review/runner"
import { DEFAULT_REVIEW_CONFIG } from "../src/altimate/review/config"
import { DEFAULT_RUBRIC } from "../src/altimate/review/rubric"
import type { ChangedFile } from "../src/altimate/review/diff-filter"

const SEV: Record<string, number> = { suggestion: 1, warning: 2, critical: 3 }

interface Case {
  id: string
  source: string // where practitioners report it
  dialect: string
  path: string
  newSql: string
  added: string[]
  expect: string[] // any of these categories present = caught; [] = must stay quiet
}

const M = "models/marts/m.sql"
// Each body is already a full SELECT — no outer `select *` wrapper (that would
// add an incidental L001 select-star finding and pollute the precision cases).
const cte = (body: string) => body

const CASES: Case[] = [
  // 1. LEFT JOIN → INNER via WHERE filter on the right table
  {
    id: "left-join-to-inner",
    source: "sqlbenjamin.wordpress.com 'LEFT JOINs and WHERE clauses', sqlshack, Toad forum",
    dialect: "snowflake",
    path: M,
    newSql: "select c.id, o.amount from customers c left join orders o on c.id = o.customer_id where o.amount > 0",
    added: ["where o.amount > 0"],
    expect: ["join_risk"],
  },
  // 2. Fan-out: one-to-many join inflates SUM/COUNT
  {
    id: "fanout-before-agg",
    source: "docs.getdbt.com/docs/build/join-logic; Holistics fan-out docs",
    dialect: "snowflake",
    path: M,
    newSql:
      "select o.order_id, sum(p.amount) as total from orders o left join payments p on o.order_id = p.order_id group by 1",
    added: ["left join payments p on o.order_id = p.order_id"],
    expect: ["fanout", "join_risk"],
  },
  // 3. NOT IN (subquery with NULLs) → returns no rows
  {
    id: "not-in-nullable",
    source: "Classic SQL gotcha (StackOverflow); use NOT EXISTS",
    dialect: "postgres",
    path: M,
    newSql: "select id from t where id not in (select customer_id from orders)",
    added: ["where id not in (select customer_id from orders)"],
    expect: ["sql_correctness"],
  },
  // 4. Incremental model with no is_incremental() guard → full reprocess / dupes
  {
    id: "incremental-no-guard",
    source: "docs.getdbt.com/docs/build/incremental-models",
    dialect: "snowflake",
    path: M,
    newSql: "{{ config(materialized='incremental') }}\nselect id, amount, updated_at from {{ ref('stg_orders') }}",
    added: ["{{ config(materialized='incremental') }}"],
    expect: ["materialization"],
  },
  // 5. dedup via row_number() with no deterministic tiebreaker
  {
    id: "dedup-no-tiebreaker",
    source: "docs.getdbt.com/blog/how-we-remove-partial-duplicates",
    dialect: "snowflake",
    path: M,
    newSql: cte("select id, row_number() over (partition by id) as rn from src"),
    added: ["row_number() over (partition by id) as rn"],
    expect: ["dedup", "sql_correctness"],
  },
  // 6. current_timestamp / clock baked into a transform → non-idempotent
  {
    id: "clock-in-transform",
    source: "dbt Slack / idempotency best practices",
    dialect: "snowflake",
    path: M,
    newSql: cte("select id, current_timestamp() as processed_at from src"),
    added: ["current_timestamp() as processed_at"],
    expect: ["idempotency"],
  },
  // 7. SELECT * in a mart → breaks downstream on upstream schema change / cost
  {
    id: "select-star-mart",
    source: "dbt style guides; warehouse cost discussions",
    dialect: "bigquery",
    path: M,
    newSql: "select * from `p`.`d`.`raw`",
    added: ["select * from `p`.`d`.`raw`"],
    expect: ["warehouse_cost", "sql_quality"],
  },
  // 8. = NULL instead of IS NULL → always false
  {
    id: "equals-null",
    source: "Classic SQL gotcha (StackOverflow)",
    dialect: "postgres",
    path: M,
    newSql: cte("select id from src where status = null"),
    added: ["where status = null"],
    expect: ["sql_correctness"],
  },
  // 9. Division without a zero guard → divide-by-zero failures
  {
    id: "division-no-guard",
    source: "dbt Slack; safe_divide / nullif recommendations",
    dialect: "bigquery",
    path: M,
    newSql: cte("select id, revenue / orders as aov from src"),
    added: ["revenue / orders as aov"],
    expect: ["sql_correctness"],
  },
  // 10. Non-portable function for the project's dialect (nvl on BigQuery)
  {
    id: "non-portable-fn",
    source: "Cross-warehouse migration pain (dbt Discourse, SQLGlot)",
    dialect: "bigquery",
    path: M,
    newSql: cte("select id, nvl(brand, 'n/a') as b from src"),
    added: ["nvl(brand, 'n/a') as b"],
    expect: ["sql_quality"],
  },
  // 11. Comma / implicit cross join
  {
    id: "comma-cross-join",
    source: "SQL joins tutorials; cartesian product warnings",
    dialect: "snowflake",
    path: M,
    newSql: cte("select a.x from a, b"),
    added: ["from a, b"],
    expect: ["join_risk"],
  },
  // 12. COUNT(DISTINCT) at scale (cost) — common warehouse cost complaint
  {
    id: "count-distinct-cost",
    source: "BigQuery/Snowflake cost discussions (approx_count_distinct)",
    dialect: "bigquery",
    path: M,
    newSql: cte("select count(distinct user_id) as users, count(distinct session_id) as sessions from src"),
    added: ["count(distinct user_id) as users, count(distinct session_id) as sessions"],
    expect: ["warehouse_cost"],
  },
  // 13. BETWEEN on a timestamp drops the last day's afternoon rows (inclusive upper bound → 00:00:00)
  {
    id: "between-timestamp-eod",
    source: "StackOverflow 'Exclude rows with certain time of day' — use half-open >= / <",
    dialect: "snowflake",
    path: M,
    newSql: cte("select id from src where created_at between '2024-01-01' and '2024-01-31'"),
    added: ["where created_at between '2024-01-01' and '2024-01-31'"],
    expect: ["sql_correctness"],
  },
  // 14. String concatenation NULL propagation: `a || b` → NULL if any operand is NULL
  {
    id: "concat-null-propagation",
    source: "Baeldung 'Concatenate with NULL Values in SQL' — use concat_ws/coalesce",
    dialect: "postgres",
    path: M,
    newSql: cte("select id, name || ' (' || code || ')' as label from src"),
    added: ["name || ' (' || code || ')' as label"],
    expect: ["sql_correctness", "sql_quality"],
  },
  // 15. Hand-rolled surrogate key over raw concat → NULL field makes the whole key NULL / collisions
  {
    id: "surrogate-key-nullable",
    source: "dbt-utils #488 (NULL vs '' collision); dbt Discourse surrogate-key threads",
    dialect: "snowflake",
    path: M,
    newSql: cte("select md5(cast(a as varchar) || cast(b as varchar)) as sk, a, b from src"),
    added: ["md5(cast(a as varchar) || cast(b as varchar)) as sk"],
    expect: ["sql_correctness", "dedup", "contract_violation"],
  },
]

// GOOD cases — the correct version must stay quiet (precision on the fixes).
const GOOD: Case[] = [
  {
    id: "anti-join-is-null",
    source: "correct LEFT JOIN anti-join",
    dialect: "snowflake",
    path: M,
    newSql: "select c.id from customers c left join orders o on c.id = o.customer_id where o.customer_id is null",
    added: ["where o.customer_id is null"],
    expect: [],
  },
  {
    id: "guarded-division",
    source: "nullif guard",
    dialect: "bigquery",
    path: M,
    newSql: cte("select id, revenue / nullif(orders, 0) as aov from src"),
    added: ["revenue / nullif(orders, 0) as aov"],
    expect: [],
  },
  {
    id: "not-exists",
    source: "NOT EXISTS instead of NOT IN",
    dialect: "postgres",
    path: M,
    newSql: "select id from t where not exists (select 1 from orders o where o.customer_id = t.id)",
    added: ["where not exists (select 1 from orders o where o.customer_id = t.id)"],
    expect: [],
  },
  {
    id: "dedup-with-order",
    source: "row_number with deterministic order",
    dialect: "snowflake",
    path: M,
    newSql: cte("select id, row_number() over (partition by id order by updated_at desc) as rn from src"),
    added: ["row_number() over (partition by id order by updated_at desc) as rn"],
    expect: [],
  },
  {
    id: "native-fn",
    source: "nvl on snowflake (native)",
    dialect: "snowflake",
    path: M,
    newSql: cte("select id, nvl(brand, 'n/a') as b from src"),
    added: ["nvl(brand, 'n/a') as b"],
    expect: [],
  },
]

async function review(c: Case) {
  const file: ChangedFile = { path: c.path, status: "modified", diff: c.added.map((l) => "+" + l).join("\n") }
  const content = async (_f: string, side: "old" | "new") => (side === "new" ? c.newSql : undefined)
  const env = await runReview({
    changedFiles: [file],
    config: { ...DEFAULT_REVIEW_CONFIG, dialect: c.dialect, ai: false },
    rubric: DEFAULT_RUBRIC,
    mode: "comment",
    runner: createDispatcherRunner({ manifestPath: "/nope.json" }),
    getContent: content,
    getCompiled: content,
    generatedAt: "2026-05-30T00:00:00Z",
  })
  return env.findings
}

async function main() {
  let caught = 0
  const miss: string[] = []
  const rows: string[] = []
  for (const c of CASES) {
    const fs = await review(c)
    const hit = fs.some((f) => c.expect.includes(f.category))
    if (hit) caught++
    else
      miss.push(
        `${c.id} [${c.dialect}] want ${c.expect} got ${[...new Set(fs.map((f) => f.category))].join(",") || "(none)"}`,
      )
    rows.push(`  ${hit ? "✓" : "✗"} ${c.id.padEnd(22)} ${c.source.slice(0, 60)}`)
  }
  let fp = 0
  const fpList: string[] = []
  for (const c of GOOD) {
    const fs = await review(c)
    const bad = fs.filter((f) => SEV[f.severity] >= 1)
    if (bad.length) {
      fp++
      fpList.push(`${c.id} → ${bad.map((f) => f.category + ":" + f.severity).join(",")}`)
    }
  }
  console.log("REAL-WORLD CORPUS (sourced pain points):")
  console.log(rows.join("\n"))
  const pct = (n: number, d: number) => `${n}/${d} = ${((100 * n) / d).toFixed(1)}%`
  console.log(`\nCAUGHT: ${pct(caught, CASES.length)}`)
  if (miss.length) console.log("MISSES:\n" + miss.map((m) => "   - " + m).join("\n"))
  console.log(`FALSE POSITIVES on correct versions: ${pct(fp, GOOD.length)}`)
  if (fpList.length) console.log(fpList.map((m) => "   - " + m).join("\n"))
}

main()
