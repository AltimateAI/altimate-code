// A representative AI-lane input whose default prompt is pinned by
// `review-ai-prompt-default.txt` (captured before the opt-in coverage and
// context-card switches existed): with both switches off the prompt must not change.
import { makeFinding } from "../../../src/altimate/review/finding"
import type { AiReviewFile, AiReviewInput } from "../../../src/altimate/review/ai-review"

/** A diff with `hunks` hunks of `size` added lines each, spaced 100 lines apart. */
function bigDiff(hunks: number, size: number): string {
  const out: string[] = []
  for (let h = 0; h < hunks; h++) {
    const start = 10 + h * 100
    out.push(`@@ -${start},${size + 2} +${start},${size + 4} @@`)
    out.push(` select ${h} as ctx_before`)
    for (let i = 0; i < size; i++) out.push(`+  , coalesce(col_${h}_${i}, 'unknown_value_${i}') as renamed_column_${h}_${i}`)
    out.push(`-  , old_col_${h}`)
    out.push(`   from {{ ref('stg_${h}') }}`)
  }
  return out.join("\n") + "\n"
}

function bigSql(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `  , cast(field_${i} as varchar) as field_${i}_text -- line ${i + 1}`).join("\n")
}

export function defaultPromptInput(): AiReviewInput {
  const files: AiReviewFile[] = [
    { path: "models/marts/_marts.yml", status: "modified", model: "_marts.yml", kind: "schema_yml", diff: "+      - name: id\n+        tests: [unique]\n", sql: "models:\n  - name: fct\n" },
    { path: "macros/to_cents.sql", status: "modified", model: "to_cents", kind: "macro", diff: "-round({{ c }})\n+round({{ c }} * 100)\n", sql: "{% macro to_cents(c) %}round({{ c }} * 100){% endmacro %}" },
    { path: "models/marts/fct_big.sql", status: "modified", model: "fct_big", kind: "model_sql", diff: bigDiff(5, 20), sql: bigSql(300) },
    { path: "tests/assert_positive.sql", status: "added", model: "assert_positive", kind: "test", diff: "+select * from {{ ref('fct') }} where id < 0\n", sql: "select * from {{ ref('fct') }} where id < 0" },
    { path: "seeds/codes.csv", status: "modified", model: "codes", kind: "seed", diff: "+US,United States\n" },
    { path: "snapshots/snap.sql", status: "modified", model: "snap", kind: "snapshot", diff: "+  unique_key='id',\n", sql: "{% snapshot snap %}select 1{% endsnapshot %}" },
    { path: "dbt_project.yml", status: "modified", model: "dbt_project.yml", kind: "project_config", diff: "+  +materialized: table\n", sql: "name: shop\n" },
    { path: "models/py/pm.py", status: "added", model: "pm", kind: "python_model", diff: "+def model(dbt, session):\n", sql: "def model(dbt, session):\n    return dbt.ref('fct')\n" },
    { path: "macros/gone.sql", status: "deleted", model: "gone", kind: "macro", diff: "-x\n" },
    ...Array.from({ length: 18 }, (_, i): AiReviewFile => ({
      path: `models/staging/stg_${i}.sql`,
      status: "modified",
      model: `stg_${i}`,
      kind: "model_sql",
      diff: `@@ -1,2 +1,2 @@\n select\n-  a_${i}\n+  b_${i}\n`,
      sql: `select b_${i} from {{ source('raw', 't${i}') }}`,
    })),
  ]
  return {
    prTitle: "Rework revenue marts",
    prBody: "Moves cents conversion into a macro.\n\nAlso adds tests.",
    grounding: [
      makeFinding({
        severity: "warning",
        category: "warehouse_cost",
        title: "SELECT * in a mart",
        body: "Project columns explicitly.",
        file: "models/marts/fct_big.sql",
        model: "fct_big",
      }),
    ],
    context: [
      { path: "models/staging/stg_orders.sql", kind: "model", name: "stg_orders", forPaths: ["models/marts/fct_big.sql"], content: "select id, amount from raw.orders" },
      { path: "seeds/unused.csv", kind: "seed", name: "unused", forPaths: ["models/other.sql"], content: "a\n1" },
    ],
    files,
  }
}
