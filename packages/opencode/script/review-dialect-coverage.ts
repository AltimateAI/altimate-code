// altimate_change - measure dbt-pr-review engine coverage across popular dialects.
//
// For each labeled construct we assert BOTH directions with explicit dialects:
//   - PRECISION: silent on a dialect that NATIVELY supports it (no false alarm)
//   - RECALL:    flagged on a dialect that does NOT support it (true catch)
// plus structural/type checks that must flag on every dialect.
// Run: bun run --conditions=browser script/review-dialect-coverage.ts
import { Dispatcher } from "../src/altimate/native"

const DIALECTS = [
  "bigquery",
  "snowflake",
  "redshift",
  "databricks",
  "postgres",
  "mysql",
  "duckdb",
  "trino",
  "oracle",
  "tsql",
]

interface Case {
  id: string
  sql: string
  family: "fn" | "type" | "struct"
  native?: string // a dialect that supports it → must be SILENT (precision)
  foreign?: string // a dialect that does NOT → must FLAG (recall)
}
const fn = (id: string, call: string, native: string, foreign: string): Case => ({
  id,
  sql: `select ${call} as a from t`,
  family: "fn",
  native,
  foreign,
})

const CASES: Case[] = [
  fn("nvl", "nvl(x, 0)", "snowflake", "bigquery"),
  fn("nvl2", "nvl2(x, 1, 0)", "oracle", "bigquery"),
  fn("iff", "iff(x > 0, 1, 0)", "snowflake", "postgres"),
  fn("decode", "decode(x, 1, 'a', 'b')", "oracle", "postgres"),
  fn("listagg", "listagg(x, ',')", "snowflake", "mysql"),
  fn("group_concat", "group_concat(x)", "mysql", "snowflake"),
  fn("string_agg", "string_agg(x, ',')", "postgres", "mysql"),
  fn("array_agg", "array_agg(x)", "bigquery", "mysql"),
  fn("getdate", "getdate()", "tsql", "postgres"),
  fn("sysdate", "sysdate()", "oracle", "postgres"),
  fn("charindex", "charindex('a', x)", "tsql", "postgres"),
  fn("datediff", "datediff(day, a, b)", "snowflake", "postgres"),
  fn("dateadd", "dateadd(day, 1, a)", "snowflake", "postgres"),
  fn("to_date", "to_date(x)", "oracle", "mysql"),
  fn("safe_divide", "safe_divide(a, b)", "snowflake", "postgres"),
  fn("generate_array", "generate_array(1, 5)", "bigquery", "snowflake"),
  fn("generate_series", "generate_series(1, 5)", "postgres", "bigquery"),
  fn("str_to_date", "str_to_date(x, '%Y')", "mysql", "snowflake"),
  fn("approx_count_distinct", "approx_count_distinct(x)", "databricks", "postgres"),
  fn("json_extract", "json_extract(x, '$.a')", "mysql", "bigquery"),
  fn("get_json_object", "get_json_object(x, '$.a')", "databricks", "postgres"),
  fn("flatten", "flatten(x)", "snowflake", "postgres"),
  fn("percentile_cont", "percentile_cont(0.5)", "postgres", "mysql"),
  // non-portable types — flag on every dialect
  { id: "type_int4", sql: "select cast(x as int4) as a from t", family: "type" },
  { id: "type_variant", sql: "select cast(x as variant) as a from t", family: "type" },
  // structural — flag on every dialect
  { id: "div_by_col", sql: "select a / b as r from t", family: "struct" },
  { id: "select_star", sql: "select * from t", family: "struct" },
  { id: "not_in", sql: "select x from t where x not in (select y from t)", family: "struct" },
  { id: "cross_join", sql: "select a.x from t a, t b", family: "struct" },
]

async function flagged(sql: string, dialect: string): Promise<boolean> {
  const params: any = {
    sql,
    schema_context: {
      tables: {
        t: {
          columns: [
            { name: "x", type: "string" },
            { name: "y", type: "string" },
          ],
        },
      },
      version: "1",
      dialect,
    },
  }
  // Fail fast: a dispatcher error must NOT be silently counted as "not flagged"
  // — that would corrupt the coverage metric. Let it throw and abort the eval.
  const r: any = await Dispatcher.call("altimate_core.check", params)
  return (r?.data?.lint?.findings ?? []).some((f: any) => f.code !== "L030")
}

async function main() {
  const rows: string[] = []
  let precHit = 0,
    precTot = 0,
    recHit = 0,
    recTot = 0,
    structHit = 0,
    structTot = 0
  for (const c of CASES) {
    const cells: string[] = []
    for (const d of DIALECTS) cells.push((await flagged(c.sql, d)) ? "✓" : "·")
    rows.push([c.id.padEnd(22), c.family.padEnd(6), ...cells].join(" "))
    if (c.family === "struct" || c.family === "type") {
      for (const d of DIALECTS) {
        structTot++
        if (await flagged(c.sql, d)) structHit++
      }
    }
    if (c.native) {
      precTot++
      if (!(await flagged(c.sql, c.native))) precHit++
    }
    if (c.foreign) {
      recTot++
      if (await flagged(c.sql, c.foreign)) recHit++
    }
  }
  console.log(["case".padEnd(22), "family".padEnd(6), ...DIALECTS.map((d) => d.slice(0, 3))].join(" "))
  console.log(rows.join("\n"))
  const pct = (n: number, d: number) => `${n}/${d} = ${((100 * n) / d).toFixed(1)}%`
  console.log("\n--- summary (across " + DIALECTS.length + " dialects) ---")
  console.log(`function PRECISION (silent on a native dialect):   ${pct(precHit, precTot)}`)
  console.log(`function RECALL    (flagged on a foreign dialect): ${pct(recHit, recTot)}`)
  console.log(`structural/type   (flagged on every dialect):      ${pct(structHit, structTot)}`)
}

main()
