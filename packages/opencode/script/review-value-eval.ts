// altimate_change - new file: prove the value of the dbt-pr-review engine.
//
// Runs a LABELED corpus of realistic dbt changes through the full deterministic
// review pipeline (engine lint + catalog + lexical + dbt-patterns; AI lane off
// for determinism) and reports:
//   - RECALL: of changes that SHOULD be flagged, how many were? (with right category)
//   - FALSE-POSITIVE RATE: of BENIGN changes, how many got a warning+ finding?
// Run: bun run --conditions=browser script/review-value-eval.ts
import { runReview } from "../src/altimate/review/orchestrate"
import { createDispatcherRunner } from "../src/altimate/review/runner"
import { DEFAULT_REVIEW_CONFIG } from "../src/altimate/review/config"
import { DEFAULT_RUBRIC } from "../src/altimate/review/rubric"
import type { ChangedFile } from "../src/altimate/review/diff-filter"

const SEV: Record<string, number> = { suggestion: 1, warning: 2, critical: 3 }

interface Scenario {
  id: string
  dialect: string
  path: string
  newSql: string
  oldSql?: string
  added: string[]
  removed?: string[]
  // expected finding categories (any one present = caught); [] = BENIGN (should produce no warning+)
  expect: string[]
}

// Realistic compiled-style (CTE) SQL so the engine AST lanes see the change.
// Final select is EXPLICIT (no incidental `select *`) so a benign change stays
// genuinely benign — the only construct under test is `cols`/`where`.
const wrap = (cols: string, where = "") =>
  `with renamed as (select id, ${cols} from \`p\`.\`d\`.\`raw\` ${where}) select id, ${cols.split(" as ").pop()} from renamed`

const BAD: Scenario[] = [
  {
    id: "div-no-guard",
    dialect: "bigquery",
    path: "models/marts/m.sql",
    newSql: wrap("revenue / orders as aov"),
    added: ["    , revenue / orders as aov"],
    expect: ["sql_correctness"],
  },
  {
    id: "equals-null",
    dialect: "bigquery",
    path: "models/marts/m.sql",
    newSql: wrap("x", "where status = null"),
    added: ["where status = null"],
    expect: ["sql_correctness"],
  },
  {
    id: "not-in-subquery",
    dialect: "bigquery",
    path: "models/marts/m.sql",
    newSql: wrap("x", "where id not in (select fk from other)"),
    added: ["where id not in (select fk from other)"],
    expect: ["sql_correctness"],
  },
  {
    id: "select-star-mart",
    dialect: "bigquery",
    path: "models/marts/m.sql",
    newSql: "select * from `p`.`d`.`raw`",
    added: ["select * from `p`.`d`.`raw`"],
    expect: ["warehouse_cost", "sql_quality"],
  },
  {
    id: "comma-cross-join",
    dialect: "bigquery",
    path: "models/marts/m.sql",
    newSql: "with j as (select a.x from `p`.`d`.`a` a, `p`.`d`.`b` b) select * from j",
    added: ["from `p`.`d`.`a` a, `p`.`d`.`b` b"],
    expect: ["join_risk"],
  },
  {
    id: "nvl-on-bigquery",
    dialect: "bigquery",
    path: "models/marts/m.sql",
    newSql: wrap("nvl(brand, 'n/a') as b"),
    added: ["    , nvl(brand, 'n/a') as b"],
    expect: ["sql_quality", "sql_correctness"],
  },
  {
    id: "getdate-on-snowflake-wrongdialect",
    dialect: "snowflake",
    path: "models/marts/m.sql",
    newSql: wrap("getdate() as loaded"),
    added: ["    , getdate() as loaded"],
    expect: ["sql_quality", "idempotency"],
  },
  {
    id: "type-int4",
    dialect: "bigquery",
    path: "models/marts/m.sql",
    newSql: wrap("cast(x as int4) as xi"),
    added: ["    , cast(x as int4) as xi"],
    expect: ["contract_violation"],
  },
  {
    id: "reserved-alias",
    dialect: "bigquery",
    path: "models/marts/m.sql",
    newSql: wrap("category as order"),
    added: ["    , category as order"],
    expect: ["sql_quality"],
  },
  {
    id: "pg-cast-operator",
    dialect: "bigquery",
    path: "models/marts/m.sql",
    newSql: wrap("x::int as xi"),
    added: ["    , x::int as xi"],
    expect: ["sql_quality"],
  },
  {
    id: "window-no-partition",
    dialect: "bigquery",
    path: "models/marts/m.sql",
    newSql: wrap("sum(amt) over (order by ts) as run"),
    added: ["    , sum(amt) over (order by ts) as run"],
    expect: ["sql_correctness"],
  },
  {
    id: "listagg-on-bigquery",
    dialect: "bigquery",
    path: "models/marts/m.sql",
    newSql: wrap("listagg(b, ',') as bs"),
    added: ["    , listagg(b, ',') as bs"],
    expect: ["sql_quality"],
  },
]

const BENIGN: Scenario[] = [
  {
    id: "nvl-on-snowflake-native",
    dialect: "snowflake",
    path: "models/marts/m.sql",
    newSql: wrap("nvl(brand, 'n/a') as b"),
    added: ["    , nvl(brand, 'n/a') as b"],
    expect: [],
  },
  {
    id: "nullif-division",
    dialect: "bigquery",
    path: "models/marts/m.sql",
    newSql: wrap("revenue / nullif(orders, 0) as aov"),
    added: ["    , revenue / nullif(orders, 0) as aov"],
    expect: [],
  },
  {
    id: "coalesce-portable",
    dialect: "bigquery",
    path: "models/marts/m.sql",
    newSql: wrap("coalesce(brand, 'n/a') as b"),
    added: ["    , coalesce(brand, 'n/a') as b"],
    expect: [],
  },
  {
    id: "portable-cast",
    dialect: "bigquery",
    path: "models/marts/m.sql",
    newSql: wrap("cast(x as numeric) as xn"),
    added: ["    , cast(x as numeric) as xn"],
    expect: [],
  },
  {
    id: "clear-alias",
    dialect: "bigquery",
    path: "models/marts/m.sql",
    newSql: wrap("amount as order_amount"),
    added: ["    , amount as order_amount"],
    expect: [],
  },
  {
    id: "standard-agg",
    dialect: "bigquery",
    path: "models/marts/m.sql",
    newSql: "with j as (select id, sum(amt) as total from `p`.`d`.`raw` group by id) select id, total from j",
    added: ["    , sum(amt) as total"],
    expect: [],
  },
  {
    id: "windowed-partition",
    dialect: "bigquery",
    path: "models/marts/m.sql",
    newSql: wrap("sum(amt) over (partition by id order by ts) as run"),
    added: ["    , sum(amt) over (partition by id order by ts) as run"],
    expect: [],
  },
  {
    id: "array_agg-ordered-on-bigquery",
    dialect: "bigquery",
    path: "models/marts/m.sql",
    newSql: wrap("array_agg(x order by x) as xs"),
    added: ["    , array_agg(x order by x) as xs"],
    expect: [],
  },
]

async function review(s: Scenario) {
  const file: ChangedFile = {
    path: s.path,
    status: "modified",
    diff: [...s.added.map((l) => "+" + l), ...(s.removed ?? []).map((l) => "-" + l)].join("\n"),
  }
  // old side is undefined unless a scenario sets oldSql — so diff-scoping (which
  // needs a base) doesn't suppress the construct under test. Diff-scoping is
  // verified separately in the scope tests.
  const content = async (_f: string, side: "old" | "new") => (side === "new" ? s.newSql : s.oldSql)
  const env = await runReview({
    changedFiles: [file],
    config: { ...DEFAULT_REVIEW_CONFIG, dialect: s.dialect, ai: false },
    rubric: DEFAULT_RUBRIC,
    mode: "comment",
    runner: createDispatcherRunner({ manifestPath: "/nonexistent/manifest.json" }),
    getContent: content,
    getCompiled: content, // synthetic: compiled == raw (no Jinja)
    generatedAt: "2026-05-30T00:00:00Z",
  })
  return env.findings
}

async function main() {
  let caughtAny = 0
  let caughtCat = 0
  const catMiss: string[] = []
  const trueMiss: string[] = []
  for (const s of BAD) {
    const fs = await review(s)
    if (fs.length) caughtAny++
    else trueMiss.push(`${s.id} [${s.dialect}] → (no finding)`)
    if (fs.some((f) => s.expect.includes(f.category))) caughtCat++
    else if (fs.length)
      catMiss.push(`${s.id} [${s.dialect}] want ${s.expect} got ${[...new Set(fs.map((f) => f.category))].join(",")}`)
  }
  let fpWarn = 0
  let fpAny = 0
  const fpList: string[] = []
  for (const s of BENIGN) {
    const fs = await review(s)
    if (fs.filter((f) => SEV[f.severity] >= 2).length) fpWarn++
    if (fs.length) {
      fpAny++
      fpList.push(`${s.id} [${s.dialect}] → ${fs.map((f) => f.category + ":" + f.severity).join(",")}`)
    }
  }
  const pct = (n: number, d: number) => `${n}/${d} = ${((100 * n) / d).toFixed(1)}%`
  console.log(`\nRECALL (caught at all):            ${pct(caughtAny, BAD.length)}`)
  if (trueMiss.length) console.log("  true misses:\n" + trueMiss.map((m) => "   - " + m).join("\n"))
  console.log(`RECALL (correct category):         ${pct(caughtCat, BAD.length)}`)
  if (catMiss.length)
    console.log("  category mismatches (still caught):\n" + catMiss.map((m) => "   - " + m).join("\n"))
  console.log(`\nFALSE-POSITIVE (warning+ on benign): ${pct(fpWarn, BENIGN.length)}`)
  console.log(`FALSE-POSITIVE (any finding, incl. suggestions): ${pct(fpAny, BENIGN.length)}`)
  if (fpList.length) console.log("  benign findings:\n" + fpList.map((m) => "   - " + m).join("\n"))
}

main()
