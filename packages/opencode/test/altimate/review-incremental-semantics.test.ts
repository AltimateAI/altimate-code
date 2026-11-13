import { describe, test, expect } from "bun:test"
import {
  incrementalFindings,
  inlineConfig,
  modelBody,
  modelSemantics,
  snapshotFindings,
  snapshotYmlFindings,
  varScopedColumns,
  type IncrementalInput,
} from "../../src/altimate/review/incremental-semantics"
import { detectModelPatterns } from "../../src/altimate/review/dbt-patterns"
import { runReview, type ReviewRunner } from "../../src/altimate/review/orchestrate"
import { DEFAULT_REVIEW_CONFIG } from "../../src/altimate/review/config"
import { DEFAULT_RUBRIC } from "../../src/altimate/review/rubric"

/**
 * dbt incremental / microbatch / snapshot semantics. Generic rules are checked
 * on two adapters; adapter-dependent rules fire only where the capability
 * table says the behavior is real.
 */

const INC = (body: string, cfg = "materialized='incremental', incremental_strategy='merge', unique_key='id'") =>
  `{{ config(${cfg}) }}\n${body}\n{% if is_incremental() %} where ts > (select max(ts) from {{ this }}) {% endif %}\n`

function input(over: Partial<IncrementalInput>): IncrementalInput {
  return {
    file: { path: "models/marts/fct.sql", status: "modified" },
    model: "fct",
    newSql: INC("select id, ts from src"),
    oldSql: INC("select id, ts from src"),
    added: [],
    dialect: "snowflake",
    dialectKnown: true,
    prText: "",
    hasExposures: false,
    sliceVars: [],
    columnDelta: async () => ({ added: [], removed: [] }),
    ...over,
  }
}
const rules = async (over: Partial<IncrementalInput>) =>
  (await incrementalFindings(input(over))).map((f) => (f.evidence?.result as { rule: string }).rule)

describe("config parsing", () => {
  test("inline config keeps nested values whole", () => {
    const c = inlineConfig("{{ config(materialized='incremental', unique_key=['a', 'b'], contract={'enforced': true}, partition_by={'field': 'd', 'granularity': 'day'}) }}")
    expect(c.unique_key).toBe("['a', 'b']")
    expect(c.partition_by).toBe("{'field': 'd', 'granularity': 'day'}")
    expect(modelSemantics(c).uniqueKey).toEqual(["a", "b"])
    expect(modelSemantics(c).contractEnforced).toBe(true)
  })

  test("manifest config fills what the inline config doesn't set; inline wins", () => {
    const s = modelSemantics(inlineConfig("{{ config(on_schema_change='fail') }}"), {
      materialized: "incremental",
      on_schema_change: "ignore",
      unique_key: "id",
    })
    expect(s).toMatchObject({ materialized: "incremental", onSchemaChange: "fail", uniqueKey: ["id"] })
  })

  test("the model body ignores config, comments and whitespace", () => {
    expect(modelBody("{{ config(a='b') }}\nselect 1 -- x\n")).toBe(modelBody("{# doc #}{{ config(a='c') }} select   1"))
  })

  test("only columns compared to a listed slice var count", () => {
    const sql = "select * from t where t.tenant_id = '{{ var(\"tenant\") }}' and currency = '{{ var('reporting_currency') }}'"
    expect(varScopedColumns(sql, ["tenant"])).toEqual(["tenant_id"])
    expect(varScopedColumns(sql, [])).toEqual([])
  })
})

describe("incremental change without a plan for existing rows", () => {
  const delta = (added: string[]) => async () => ({ added, removed: [] })
  for (const dialect of ["snowflake", "trino"]) {
    test(`a new column fires on ${dialect}; a stated plan silences it`, async () => {
      const changed = { dialect, newSql: INC("select id, ts, kind from src"), columnDelta: delta(["kind"]) }
      const [f] = await incrementalFindings(input(changed))
      expect(f.body).toContain("`kind` is new: rows built before this change get NULL")
      expect(f.severity).toBe("suggestion")
      expect(await rules({ ...changed, prText: "Needs a --full-refresh on deploy" })).not.toContain("incremental-history-plan")
    })
  }

  test("a changed is_incremental() filter fires", async () => {
    const oldSql = "{{ config(materialized='incremental', unique_key='id') }} select id, ts from src {% if is_incremental() %} where ts > (select max(ts) from {{ this }}) {% endif %}"
    const newSql = oldSql.replace("where ts >", "where ts >=")
    expect(await rules({ oldSql, newSql })).toContain("incremental-history-plan")
  })

  test("formatting-only edits, expression edits without new columns, config-only and new models don't fire", async () => {
    expect(await rules({ newSql: INC("SELECT   id ,\n  ts\nFROM src") })).toHaveLength(0)
    expect(await rules({ newSql: INC("select id, ts + 1 as ts from src") })).toHaveLength(0)
    expect(await rules({ newSql: INC("select id, ts from src", "materialized='incremental', incremental_strategy='merge', unique_key='id', tags=['x']") })).toHaveLength(0)
    expect(await rules({ file: { path: "models/marts/fct.sql", status: "added" }, oldSql: undefined, newSql: INC("select 2"), columnDelta: delta(["x"]) })).toHaveLength(0)
  })

  test("partition_by change needs a full refresh", async () => {
    const cfg = (g: string) => `materialized='incremental', unique_key='id', partition_by={'field': 'd', 'granularity': '${g}'}`
    expect(await rules({ oldSql: INC("select 1", cfg("day")), newSql: INC("select 1", cfg("month")) })).toContain("incremental-partition-change")
  })
})

describe("on_schema_change='fail'", () => {
  const cfg = "materialized='incremental', unique_key='id', on_schema_change='fail'"
  test("a changed column set fails the first incremental run", async () => {
    const out = await incrementalFindings(
      input({ oldSql: INC("select id from s", cfg), newSql: INC("select id, kind from s", cfg), prText: "full refresh", columnDelta: async () => ({ added: ["kind"], removed: [] }) }),
    )
    expect(out.map((f) => f.body).join()).toContain("adds `kind`")
  })
  test("it replaces, not repeats, the history-plan finding", async () => {
    const out = await rules({ oldSql: INC("select id from s", cfg), newSql: INC("select id, kind from s", cfg), columnDelta: async () => ({ added: ["kind"], removed: [] }) })
    expect(out).toEqual(["on-schema-change-fail"])
  })
  test("an unchanged column set is fine", async () => {
    expect(await rules({ oldSql: INC("select id from s", cfg), newSql: INC("select id from s", cfg) })).not.toContain("on-schema-change-fail")
  })
})

describe("per-slice runs whose unique_key lacks the slice column", () => {
  const sql = (key: string, strategy = "delete+insert") =>
    `{{ config(materialized='incremental', incremental_strategy='${strategy}', unique_key=${key}) }}\nselect event_id, tenant_id from src where tenant_id = '{{ var("tenant") }}'`
  for (const dialect of ["snowflake", "postgres"]) {
    test(`fires on ${dialect} for delete+insert and merge`, async () => {
      const isNew = { file: { path: "models/marts/fct.sql", status: "added" as const }, oldSql: undefined, dialect, sliceVars: ["tenant"] }
      const [di] = await incrementalFindings(input({ ...isNew, newSql: sql("'event_id'") }))
      expect(di.body).toContain("deletes other slices' rows")
      const [mg] = await incrementalFindings(input({ ...isNew, newSql: sql("'event_id'", "merge") }))
      expect(mg.body).toContain("overwrites other slices' rows")
      expect(await rules({ ...isNew, newSql: sql("['event_id', 'tenant_id']") })).toHaveLength(0)
      expect(await rules({ ...isNew, sliceVars: [], newSql: sql("'event_id'") })).toHaveLength(0)
    })
  }
})

describe("non-atomic table rebuild", () => {
  const tbl = (ote: string, contract = true) =>
    `{{ config(materialized='table', on_table_exists='${ote}'${contract ? ", contract={'enforced': true}" : ""}) }}\nselect 1 as id`
  const isNew = { file: { path: "models/marts/fct.sql", status: "added" as const }, oldSql: undefined, dialect: "trino" }
  test("trino: replace with an enforced contract, or drop; always a suggestion", async () => {
    const [f] = await incrementalFindings(input({ ...isNew, newSql: tbl("replace") }))
    expect(f.severity).toBe("suggestion")
    expect(f.body).toContain("`create or replace table` and then `insert`")
    const [e] = await incrementalFindings(input({ ...isNew, newSql: tbl("replace"), hasExposures: true }))
    expect(e.severity).toBe("suggestion")
    expect(e.body).toContain("this model has exposures")
    expect((await incrementalFindings(input({ ...isNew, newSql: tbl("drop", false) })))[0].body).toContain("doesn't exist during each build")
  })
  test("rename, replace without a contract, or another adapter: silent", async () => {
    expect(await rules({ ...isNew, newSql: tbl("rename") })).toHaveLength(0)
    expect(await rules({ ...isNew, newSql: tbl("replace", false) })).toHaveLength(0)
    expect(await rules({ ...isNew, dialect: "snowflake", newSql: tbl("replace") })).toHaveLength(0)
  })
})

describe("snapshots", () => {
  const snap = (cols: string, body = "select id, status from src") =>
    `{% snapshot s %}\n{{ config(unique_key='id', strategy='check', check_cols=${cols}) }}\n${body}\n{% endsnapshot %}`
  const file = { path: "snapshots/s.sql", status: "modified" as const }
  const rule = (f: ReturnType<typeof snapshotFindings>) => f.map((x) => (x.evidence?.result as { rule: string }).rule)
  test("a check_cols change can record history that never happened", () => {
    expect(rule(snapshotFindings({ file, model: "s", oldSql: snap("['status']"), newSql: snap("['status', 'amount']"), prText: "" }))).toEqual([
      "snapshot-tracking-change",
    ])
  })
  test("yml-defined snapshots (dbt 1.9+) are checked too", () => {
    const y = (cols: string) => `snapshots:\n  - name: orders_snap\n    relation: source('raw', 'orders')\n    config:\n      unique_key: id\n      strategy: check\n      check_cols: ${cols}\n`
    const yfile = { path: "snapshots/_snapshots.yml", status: "modified" as const }
    expect(snapshotYmlFindings(yfile, y("[status]"), y("[status, amount]")).map((f) => f.title)).toEqual(["orders_snap: snapshot `check_cols` changed"])
    expect(snapshotYmlFindings(yfile, y("[status]"), y("[status]"))).toEqual([])
  })

  test("a query change needs a plan; a new snapshot is fine", () => {
    const changed = { file, model: "s", oldSql: snap("['status']"), newSql: snap("['status']", "select id, upper(status) as status from src") }
    expect(rule(snapshotFindings({ ...changed, prText: "" }))).toEqual(["snapshot-logic-no-plan"])
    expect(rule(snapshotFindings({ ...changed, prText: "we will backfill" }))).toEqual([])
    expect(rule(snapshotFindings({ ...changed, newSql: snap("['status']", "SELECT id,\n   status FROM src"), prText: "" }))).toEqual([])
    expect(snapshotFindings({ ...changed, file: { ...file, status: "added" }, prText: "" })).toEqual([])
  })
})

describe("dedup ordered only by a load timestamp", () => {
  const run = (line: string) =>
    detectModelPatterns({ path: "models/m.sql", status: "added", diff: `+${line}\n` }, line, DEFAULT_RUBRIC).filter(
      (f) => (f.evidence?.result as { rule?: string })?.rule === "dedup_load_timestamp_only",
    )
  test("load timestamps fire, as a suggestion", () => {
    for (const col of ["loaded_at", "ingestion_timestamp", "src.load_ts", "_loaded_at"]) {
      const f = run(`select *, row_number() over (partition by id order by ${col} desc) as rn from t`)
      expect(f).toHaveLength(1)
      expect(f[0].severity).toBe("suggestion")
    }
  })
  test("loader sync columns (the standard staging idiom) stay silent", () => {
    for (const col of ["_fivetran_synced", "_airbyte_extracted_at", "_sdc_batched_at"])
      expect(run(`select *, row_number() over (partition by id order by ${col} desc) as rn from t`)).toHaveLength(0)
  })
  test("a business timestamp, a tie-breaker, or no row_number: silent", () => {
    expect(run("select *, row_number() over (partition by id order by updated_at desc) as rn from t")).toHaveLength(0)
    expect(run("select *, row_number() over (partition by id order by loaded_at desc, seq desc) as rn from t")).toHaveLength(0)
    expect(run("select *, rank() over (partition by id order by loaded_at) as rn from t")).toHaveLength(0)
  })
})

describe("end to end through the orchestrator", () => {
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
    async equivalence() {
      return { decided: true, equivalent: false }
    },
    async detectPii() {
      return { columns: [] }
    },
    async modelConfig() {
      return { materialized: "incremental", unique_key: "id" }
    },
    async columnLineage(sql: string) {
      const m = /select\s+([\s\S]*?)\s+from/i.exec(sql)
      return m ? m[1].split(",").map((c) => ({ source: `"src"."${c.trim()}"`, target: c.trim() })) : []
    },
  } as ReviewRunner

  test("an incremental model whose materialization is set in yml (manifest) still gets the rule; findings never block", async () => {
    const env = await runReview({
      changedFiles: [
        { path: "models/marts/fct.sql", status: "modified", diff: "-select id from src\n+select id, kind from src\n" },
        { path: "snapshots/s.sql", status: "modified", diff: "-check_cols=['a']\n+check_cols=['a', 'b']\n" },
      ],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["dbt_patterns"] },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: async (f, side) =>
        f.startsWith("snapshots/")
          ? `{{ config(strategy='check', unique_key='id', check_cols=${side === "old" ? "['a']" : "['a', 'b']"}) }} select id, a, b from src`
          : side === "old"
            ? "select id from src"
            : "select id, kind from src",
    })
    const titles = env.findings.map((f) => f.title)
    expect(titles).toContain("fct: incremental change without a plan for existing rows")
    expect(titles.some((t) => t.startsWith("s: snapshot `check_cols` changed"))).toBe(true)
    expect(env.findings.filter((f) => f.evidence?.tool === "dbt-semantics").every((f) => f.origin === "catalog")).toBe(true)
    expect(env.verdict).not.toBe("REQUEST_CHANGES")
  })
})
