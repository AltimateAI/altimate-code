// altimate_change start — tests for the dbt mart optimizer commands
// (dbt-optimize, dbt-parity, dbt-impact, dbt-factor): pure helpers plus the
// command handlers against a FAKE core (Dispatcher handlers overridden). No
// network, no warehouse, no real engine calls for the new bindings.
import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { Dispatcher } from "../../src/altimate/native"
import { registerAll, bindingUnavailable, hasBinding } from "../../src/altimate/native/altimate-core"
import {
  alignRawToCompiled,
  findModel,
  mapRewriteToRaw,
  normalizeProof,
  formatProof,
  relationParts,
  type Manifest,
} from "../../src/cli/cmd/dbt-mart-helpers"
import {
  buildPatchPlan,
  chooseProposal,
  formatProposal,
  normalizeProposals,
  parityCommand,
} from "../../src/cli/cmd/dbt-optimize-helpers"
import {
  type Executor,
  type ParityPlan,
  formatParityText,
  runParityPlan,
} from "../../src/cli/cmd/dbt-parity-helpers"
import {
  buildChange,
  changesForFile,
  formatImpactText,
  hasExternalBreak,
  naiveRender,
  normalizeImpactReport,
  reportVerdict,
} from "../../src/cli/cmd/dbt-impact-helpers"
import { buildFactorPlan, normalizeFactorProposals } from "../../src/cli/cmd/dbt-factor-helpers"
import { DbtOptimizeCommand } from "../../src/cli/cmd/dbt-optimize"
import { DbtImpactCommand } from "../../src/cli/cmd/dbt-impact"
import { DbtFactorCommand } from "../../src/cli/cmd/dbt-factor"

// ---------------------------------------------------------------------------
// A tiny compiled dbt project: src → m → c
// ---------------------------------------------------------------------------

const SRC_REL = `"iceberg"."s"."src"`
const M_RAW = `{{ config(materialized='table') }}\n\n-- latest per account\nselect account from (select account, hash from {{ ref('src') }}) as s where 1 = 1\n`
const M_COMPILED = `\n\n-- latest per account\nselect account from (select account, hash from ${SRC_REL}) as s where 1 = 1\n`
const C_RAW = `{{ config(materialized='view') }}\nselect account, count(*) as n from {{ ref('src') }} group by account\n`
const C_COMPILED = `\nselect account, count(*) as n from ${SRC_REL} group by account\n`

function manifest(): Manifest {
  const node = (name: string, raw: string, compiled: string, extra: Record<string, unknown> = {}) => ({
    unique_id: `model.p.${name}`,
    name,
    resource_type: "model",
    original_file_path: `models/${name}.sql`,
    relation_name: `"iceberg"."s"."${name}"`,
    raw_code: raw,
    compiled_code: compiled,
    ...extra,
  })
  return {
    nodes: {
      "model.p.src": node("src", "select 1 as account, 'h' as hash", "select 1 as account, 'h' as hash"),
      "model.p.m": node("m", M_RAW, M_COMPILED),
      "model.p.c": node("c", C_RAW, C_COMPILED),
    },
    child_map: { "model.p.src": ["model.p.m", "model.p.c"] },
  }
}

function project(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dbt-mart-opt-"))
  mkdirSync(path.join(dir, "models"), { recursive: true })
  mkdirSync(path.join(dir, "target"), { recursive: true })
  writeFileSync(path.join(dir, "models/m.sql"), M_RAW)
  writeFileSync(path.join(dir, "models/c.sql"), C_RAW)
  writeFileSync(path.join(dir, "target/manifest.json"), JSON.stringify(manifest()))
  return dir
}

const proven = { verdict: "proven", confidence: 1 }
const refuted = { verdict: "refuted", differences: [{ aspect: "filters", description: "filter dropped" }] }
const undecidable = { verdict: "undecidable", reason: "cannot plan max_by" }

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

describe("dbt-mart helpers: proofs", () => {
  test("accepts the engine's `verdict` tag, a `kind` tag and a bare string", () => {
    expect(normalizeProof(proven).status).toBe("proven")
    expect(normalizeProof({ kind: "refuted" }).status).toBe("refuted")
    expect(normalizeProof("undecidable").status).toBe("undecidable")
  })
  test("an unknown proof is never proven", () => {
    expect(normalizeProof({ verdict: "maybe" }).status).toBe("unknown")
    expect(normalizeProof(undefined).status).toBe("unknown")
  })
  test("refuted proofs print their differences; undecidable ones their reason", () => {
    expect(formatProof(normalizeProof(refuted))).toContain("filters: filter dropped")
    expect(formatProof(normalizeProof(undecidable))).toContain("cannot plan max_by")
  })
})

describe("dbt-mart helpers: compiled → raw mapping", () => {
  test("aligns a ref-only model and recovers the binding", () => {
    const a = alignRawToCompiled(M_RAW, M_COMPILED)
    expect(a.ok).toBe(true)
    if (a.ok) {
      expect(a.bindings).toEqual([{ jinja: "{{ ref('src') }}", rendered: SRC_REL }])
      expect(a.header).toBe("{{ config(materialized='table') }}")
    }
  })
  test("refuses Jinja control flow, macros and var()", () => {
    expect(alignRawToCompiled("{% if is_incremental() %}x{% endif %}", "x").ok).toBe(false)
    const macro = alignRawToCompiled("select {{ my_macro() }} from t", "select 1 from t")
    expect(macro.ok).toBe(false)
    if (!macro.ok) expect(macro.reason).toContain("my_macro")
    expect(alignRawToCompiled("select {{ var('x') }}", "select 1").ok).toBe(false)
  })
  test("refuses a stale compile", () => {
    const a = alignRawToCompiled(M_RAW, "select something else")
    expect(a.ok).toBe(false)
  })
  test("maps a rewrite back, with or without quotes on the relation", () => {
    for (const rel of [SRC_REL, "iceberg.s.src", `ICEBERG."s".src`]) {
      const r = mapRewriteToRaw({ raw: M_RAW, compiled: M_COMPILED, beforeSql: M_COMPILED, afterSql: `SELECT account FROM ${rel} WHERE 1 = 1` })
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.sql).toContain("{{ config(materialized='table') }}")
        expect(r.sql).toContain("FROM {{ ref('src') }} WHERE")
        expect(r.warnings.some((w) => w.includes("comments"))).toBe(true)
      }
    }
  })
  test("refuses when before_sql is not the compiled model (a fragment)", () => {
    const r = mapRewriteToRaw({ raw: M_RAW, compiled: M_COMPILED, beforeSql: "select 1", afterSql: "select 2" })
    expect(r.ok).toBe(false)
  })
  test("refuses when a relation survives in an unmappable form", () => {
    const r = mapRewriteToRaw({ raw: M_RAW, compiled: M_COMPILED, beforeSql: M_COMPILED, afterSql: `select * from s.src_x join s . src on 1=1` })
    // `s . src` is the 2-part tail of the binding, but not the full relation → refuse
    expect(r.ok).toBe(false)
  })
  test("relationParts honours quotes", () => {
    expect(relationParts(`"a"."b.c"."d"`)).toEqual(["a", "b.c", "d"])
    expect(relationParts("a.b.c")).toEqual(["a", "b", "c"])
  })
})

// ---------------------------------------------------------------------------
// dbt-optimize
// ---------------------------------------------------------------------------

describe("dbt-optimize: apply gate", () => {
  const props = normalizeProposals([
    { rule: "r1", proof: refuted, applicable: false, after_sql: "x" },
    { rule: "r2", proof: undecidable, applicable: true, parity_required: true, after_sql: "y" },
    { rule: "r3", proof: proven, applicable: true, after_sql: "z" },
  ])
  test("defaults to the first proven proposal", () => {
    const d = chooseProposal(props, { allowUnproven: false })
    expect(d.ok && d.proposal.rule).toBe("r3")
  })
  test("never applies a refuted proposal, even by number", () => {
    const d = chooseProposal(props, { index: 1, allowUnproven: true })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.reason).toContain("REFUTED")
  })
  test("an undecidable proposal needs --allow-unproven", () => {
    expect(chooseProposal(props, { index: 2, allowUnproven: false }).ok).toBe(false)
    expect(chooseProposal(props, { index: 2, allowUnproven: true }).ok).toBe(true)
  })
  test("all refuted → says so", () => {
    const d = chooseProposal(normalizeProposals([{ proof: refuted }]), { allowUnproven: true })
    expect(!d.ok && d.reason).toContain("every proposal was REFUTED")
  })
  test("formatProposal shows proof, guardrail and a capped AST diff", () => {
    const [p] = normalizeProposals([
      {
        rule: "optimizer:merge_subqueries",
        source: "optimizer_pass",
        proof: refuted,
        guardrail: { kind: "materialization_change", from: "view", to: "table", delete_scope: ["drop view x"] },
        ast_diff: { identical: false, diff_count: 5, diffs: Array(5).fill({ change_type: "insert", description: "y".repeat(500) }) },
      },
    ])
    const out = formatProposal(p).join("\n")
    expect(out).toContain("REFUTED — filters: filter dropped")
    expect(out).toContain("GUARDRAIL MaterializationChange: view → table")
    expect(out).toContain("AST diff: 5 change(s) (5 insert)")
    expect(out.split("\n").every((l) => l.length < 200)).toBe(true)
  })
  test("cost gate: a readability-only proposal is not the default apply and prints its verdict", () => {
    const readable = { verdict: "readability_only", perf_claim: false, reason: "the normalised plan is identical" }
    const ps = normalizeProposals([
      { rule: "rewriter:star_to_columns", proof: proven, applicable: true, cost: readable },
      { rule: "p302:split", proof: proven, applicable: true, cost: { verdict: "unverified", perf_claim: false } },
    ])
    const d = chooseProposal(ps, { allowUnproven: false })
    expect(d.ok && d.proposal.rule).toBe("p302:split")
    expect(formatProposal(ps[0]).join("\n")).toContain("cost: READABILITY ONLY")
    expect(formatProposal(ps[1]).join("\n")).toContain("cost: UNVERIFIED")
  })
  test("cost gate: a proven readability-only rewrite is still applied by default (A01) and says it is not a perf fix", () => {
    const readable = { verdict: "readability_only", perf_claim: false }
    const only = normalizeProposals([{ rule: "rewriter:redundant_distinct", proof: proven, applicable: true, cost: readable }])
    const r = chooseProposal(only, { allowUnproven: false })
    expect(r.ok && r.proposal.rule).toBe("rewriter:redundant_distinct")
    expect(r.ok && r.note).toContain("not a performance fix")
  })
  test("cost gate: --proposal N applies a readability-only or unverified proven rewrite explicitly", () => {
    const ps = normalizeProposals([
      { rule: "p302:split", proof: proven, applicable: true, cost: { verdict: "unverified" } },
      { rule: "rewriter:star_to_columns", proof: proven, applicable: true, cost: { verdict: "readability_only" } },
    ])
    const r2 = chooseProposal(ps, { index: 2, allowUnproven: false })
    expect(r2.ok && r2.proposal.rule).toBe("rewriter:star_to_columns")
    const r1 = chooseProposal(ps, { index: 1, allowUnproven: false })
    expect(r1.ok && r1.proposal.rule).toBe("p302:split")
  })
  test("parityCommand fills the before relation from the manifest", () => {
    const m = findModel(manifest(), "m")!
    expect(parityCommand(m)).toContain("--before iceberg.s.m")
    expect(parityCommand(m, "dev.m")).toContain("--after dev.m")
  })
})

describe("dbt-optimize: patch plans", () => {
  const m = () => findModel(manifest(), "m")!
  test("statement-level rewrite maps back onto the raw file", () => {
    const plan = buildPatchPlan({ model: m(), raw: M_RAW, proposal: { before_sql: M_COMPILED, after_sql: `SELECT account FROM ${SRC_REL} WHERE 1 = 1` } })
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.edits[0].file).toBe("models/m.sql")
      expect(plan.patch).toContain("+SELECT account FROM {{ ref('src') }} WHERE 1 = 1")
    }
  })
  test("model-level proposal → new model + consumer edit, both with refs", () => {
    const plan = buildPatchPlan({
      model: m(),
      raw: M_RAW,
      proposal: {
        before_sql: M_COMPILED,
        after_sql: "",
        model_level: {
          new_model_name: "m__s",
          new_model_sql: `select account, hash from ${SRC_REL}`,
          consumer_sql: `select account from "iceberg"."s"."m__s" as s where 1 = 1`,
        },
      },
    })
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.edits.map((e) => e.file)).toEqual(["models/m__s.sql", "models/m.sql"])
      expect(plan.edits[0].after).toContain("{{ ref('src') }}")
      expect(plan.edits[1].after).toContain("{{ ref('m__s') }}")
      expect(plan.edits[1].after.startsWith("{{ config(materialized='table') }}")).toBe(true)
    }
  })
  test("unmappable model → refusal with the compiled patch", () => {
    const node = { ...m(), raw_code: "{% set x = 1 %}" + M_RAW }
    const plan = buildPatchPlan({ model: node, raw: "{% set x = 1 %}" + M_RAW, proposal: { before_sql: M_COMPILED, after_sql: "select 1" } })
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.reason).toContain("control flow")
      expect(plan.patch).toContain("(compiled)")
    }
  })
})

// ---------------------------------------------------------------------------
// dbt-parity
// ---------------------------------------------------------------------------

const PLAN: ParityPlan = {
  model: "model.p.m",
  before: "prod.m",
  after: "dev.m",
  grain_keys: ["account"],
  grain_source: "uniqueness_test",
  tasks: [
    { kind: "row_count", task: { id: "row_count_before", sql: "RC_B" }, pass_when: "row_count_before = row_count_after" },
    { kind: "row_count", task: { id: "row_count_after", sql: "RC_A" }, pass_when: "row_count_before = row_count_after" },
    { kind: "grain_uniqueness", task: { id: "grain_duplicates_after", sql: "DUP_A" }, pass_when: "duplicated_keys = 0" },
    { kind: "except_count", task: { id: "except_count_before_minus_after", sql: "EX_BA" }, pass_when: "rows_only_on_one_side = 0" },
    { kind: "except_sample", task: { id: "except_sample_before_minus_after", sql: "SAMPLE", expected_shape: "RowSet" }, pass_when: "no rows" },
    { kind: "column_match_rates", task: { id: "column_match_rates", sql: "RATES" }, pass_when: "every <column>__matches = joined_rows" },
  ],
  notes: ["EXCEPT compares distinct rows"],
}

function fakeWarehouse(over: Record<string, { columns: string[]; rows: (string | null)[][] }> = {}): { exec: Executor; ran: string[] } {
  const base: Record<string, { columns: string[]; rows: (string | null)[][] }> = {
    RC_B: { columns: ["row_count"], rows: [["10"]] },
    RC_A: { columns: ["row_count"], rows: [["10"]] },
    DUP_A: { columns: ["duplicated_keys"], rows: [["0"]] },
    EX_BA: { columns: ["rows_only_on_one_side"], rows: [["0"]] },
    SAMPLE: { columns: ["account"], rows: [] },
    RATES: { columns: ["joined_rows", "cost__matches"], rows: [["10", "10"]] },
    ...over,
  }
  const ran: string[] = []
  return {
    ran,
    exec: async (sql) => {
      ran.push(sql)
      if (!base[sql]) throw new Error(`unexpected sql ${sql}`)
      return base[sql]
    },
  }
}

describe("dbt-parity", () => {
  test("all checks pass → MATCH; row-value tasks skipped without --sample-rows", async () => {
    const w = fakeWarehouse()
    const r = await runParityPlan(PLAN, w.exec, { sampleRows: 0 })
    expect(r.verdict).toBe("match")
    expect(w.ran).not.toContain("SAMPLE")
    expect(r.outcomes.find((o) => o.kind === "except_sample")?.status).toBe("skipped")
    expect(r.summary.row_delta).toBe(0)
    expect(r.summary.column_match_rates).toEqual([{ column: "cost", matches: 10, joined_rows: 10, rate: 1 }])
    expect(formatParityText(r, { sampleRows: 0 })).toContain("PARITY: MATCH")
  })
  test("row delta and a column mismatch → MISMATCH", async () => {
    const w = fakeWarehouse({ RC_A: { columns: ["row_count"], rows: [["11"]] }, RATES: { columns: ["joined_rows", "cost__matches"], rows: [["10", "9"]] } })
    const r = await runParityPlan(PLAN, w.exec, { sampleRows: 0 })
    expect(r.verdict).toBe("mismatch")
    expect(r.summary.row_delta).toBe(1)
    const text = formatParityText(r, { sampleRows: 0 })
    expect(text).toContain("delta +1")
    expect(text).toContain("cost: 90.0000% (9/10)")
  })
  test("samples are fetched only with --sample-rows, and a non-empty sample fails", async () => {
    const w = fakeWarehouse({ SAMPLE: { columns: ["account"], rows: [["a"], ["b"], ["c"]] } })
    const r = await runParityPlan(PLAN, w.exec, { sampleRows: 2 })
    const s = r.outcomes.find((o) => o.kind === "except_sample")!
    expect(s.status).toBe("fail")
    expect(s.rows).toHaveLength(2)
    expect(r.verdict).toBe("mismatch")
  })
  test("a failing query is INCONCLUSIVE, never a pass", async () => {
    const w = fakeWarehouse()
    const exec: Executor = async (sql, t) => (sql === "DUP_A" ? Promise.reject(new Error("boom")) : w.exec(sql, t))
    const r = await runParityPlan(PLAN, exec, { sampleRows: 0 })
    expect(r.verdict).toBe("inconclusive")
    expect(r.outcomes.find((o) => o.id === "grain_duplicates_after")?.detail).toContain("boom")
  })
  test("an unknown pass condition is INCONCLUSIVE", async () => {
    const plan: ParityPlan = { tasks: [{ kind: "x", task: { id: "x", sql: "RC_B" }, pass_when: "row_count is roughly right" }] }
    const r = await runParityPlan(plan, fakeWarehouse().exec, { sampleRows: 0 })
    expect(r.verdict).toBe("inconclusive")
  })
})

// ---------------------------------------------------------------------------
// dbt-impact
// ---------------------------------------------------------------------------

const IMPACT = {
  model: "mrt_query_usage",
  verdict: "breaking",
  loaders: ["QueryUsageLoader"],
  served_tables: ["clickhouse.query_usage"],
  hops: [
    { kind: "dbt_child", target: "int_user_query_usage", verdict: "safe", column_level: true, evidence: "does not read query_text" },
    { kind: "loader", target: "QueryUsageLoader", verdict: "breaking", column_level: true, evidence: "selects query_text" },
    { kind: "served_table", target: "clickhouse.query_usage", verdict: "breaking", column_level: true, evidence: "written by QueryUsageLoader" },
  ],
  notes: [],
}

describe("dbt-impact", () => {
  test("normalizes the engine's hops (kind/target/evidence) in hop order", () => {
    const r = normalizeImpactReport(IMPACT)
    expect(r.entries.map((e) => [e.hop, e.node_type, e.name, e.verdict])).toEqual([
      [1, "dbt_child", "int_user_query_usage", "safe"],
      [3, "loader", "QueryUsageLoader", "breaking"],
      [4, "served_table", "clickhouse.query_usage", "breaking"],
    ])
    expect(hasExternalBreak(r.entries)).toBe(true)
    expect(reportVerdict(r)).toBe("breaking")
  })
  test("a missing verdict is unknown, never safe", () => {
    const r = normalizeImpactReport({ hops: [{ kind: "loader", target: "L" }] })
    expect(r.entries[0].verdict).toBe("unknown")
    expect(reportVerdict(r)).toBe("unknown")
  })
  test("text names every hop with its verdict and evidence", () => {
    const text = formatImpactText({ model: "mrt_query_usage", column: "query_text", kind: "drop" }, normalizeImpactReport(IMPACT))
    expect(text).toContain("dbt-impact: drop mrt_query_usage.query_text")
    expect(text).toContain("BREAKING  loader QueryUsageLoader — selects query_text")
    expect(text).toContain("Overall: BREAKING")
  })
  test("buildChange enforces the fields each kind needs", () => {
    expect(buildChange({ model: "m", kind: "rename" })).toEqual({ error: "--kind rename needs --new-name" })
    expect(buildChange({ model: "m", column: "c", kind: "rename", newName: "d" })).toEqual({ model: "m", column: "c", kind: "rename", new_name: "d" })
    expect(buildChange({ model: "m", kind: "materialization", to: "incremental" })).toEqual({ model: "m", kind: "materialization", to: "incremental" })
    expect("error" in buildChange({ model: "m", kind: "retype" })).toBe(true)
  })
  test("diff mode: delete → drop, materialization change, sql change, unrenderable → unclassified", () => {
    expect(changesForFile({ model: "m", status: "deleted", baseRaw: M_RAW }).changes).toEqual([{ model: "m", kind: "drop" }])
    const mod = changesForFile({ model: "m", status: "modified", baseRaw: M_RAW, headRaw: M_RAW.replace("'table'", "'view'").replace("hash", "hash2") })
    expect(mod.changes.map((c) => c.kind)).toEqual(["materialization", "sql"])
    expect(mod.changes[1].head_sql).toContain("from src")
    const jinja = changesForFile({ model: "m", status: "modified", baseRaw: "{% if x %}a{% endif %}", headRaw: "b" })
    expect(jinja.unclassified).toHaveLength(1)
  })
  test("naiveRender spells refs and sources as bare relations", () => {
    expect(naiveRender("{{ config(a=1) }} select * from {{ ref('a') }} join {{ source('s', 't') }}")?.trim()).toBe("select * from a join s.t")
    expect(naiveRender("select {{ var('x') }}")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// dbt-factor
// ---------------------------------------------------------------------------

describe("dbt-factor", () => {
  const raw = [
    {
      new_model_name: "account_usage",
      new_model_sql: `select account from ${SRC_REL}`,
      consumers: [
        { model: "m", consumer_sql: `select account from "iceberg"."s"."int_account_usage" as s where 1 = 1`, proof: proven },
        { model: "c", consumer_sql: `select account, count(*) as n from "iceberg"."s"."int_account_usage" group by account`, proof: proven },
      ],
      savings: { scans_saved: 1 },
      storage: "one extra table",
    },
  ]
  const readRaw = (f: string) => (f === "models/m.sql" ? M_RAW : f === "models/c.sql" ? C_RAW : undefined)
  test("normalizes and int_-prefixes the new model", () => {
    const [p] = normalizeFactorProposals(raw)
    expect(p.name).toBe("int_account_usage")
    expect(p.consumers.map((c) => c.proof.status)).toEqual(["proven", "proven"])
  })
  test("builds the multi-file patch: model + yml + consumers", () => {
    const [p] = normalizeFactorProposals(raw)
    const plan = buildFactorPlan({ manifest: manifest(), proposal: p, readRaw })
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.edits.map((e) => e.file)).toEqual([
        "models/intermediate/int_account_usage.sql",
        "models/intermediate/int_account_usage.yml",
        "models/m.sql",
        "models/c.sql",
      ])
      expect(plan.edits[0].after).toContain("{{ ref('src') }}")
      expect(plan.edits[3].after).toContain("{{ ref('int_account_usage') }}")
      expect(plan.edits[3].after.startsWith("{{ config(materialized='view') }}")).toBe(true)
    }
  })
  test("any refuted consumer proof blocks the apply", () => {
    const [p] = normalizeFactorProposals([{ ...raw[0], consumers: [raw[0].consumers[0], { ...raw[0].consumers[1], proof: refuted }] }])
    const plan = buildFactorPlan({ manifest: manifest(), proposal: p, readRaw })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reason).toContain("REFUTED for c")
  })
  test("D02: a consumer whose generated SQL does not bind blocks the apply and is never PROVEN", () => {
    const invalid = { verdict: "invalid_sql", reason: "the shared model does not bind: order_date must appear in GROUP BY" }
    const [p] = normalizeFactorProposals([{ ...raw[0], consumers: [raw[0].consumers[0], { ...raw[0].consumers[1], proof: invalid }] }])
    expect(p.consumers[1].proof.status).toBe("invalid_sql")
    expect(formatProof(p.consumers[1].proof)).toContain("INVALID SQL")
    const plan = buildFactorPlan({ manifest: manifest(), proposal: p, readRaw })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reason).toContain("does not bind for c")
  })
})

// ---------------------------------------------------------------------------
// Command handlers against a fake core
// ---------------------------------------------------------------------------

describe("command handlers (fake core)", () => {
  let errors: string[] = []
  let stdout: string[] = []
  const origError = console.error
  const origWrite = process.stdout.write.bind(process.stdout)
  let dir = ""

  beforeAll(async () => {
    // Trigger the lazy registration once, so the overrides below are not
    // clobbered by it on the first call.
    await Dispatcher.call("altimate_core.grain", { sql: "select 1" }).catch(() => undefined)
  })
  afterAll(() => registerAll())
  afterEach(() => {
    console.error = origError
    process.stdout.write = origWrite
    process.exitCode = 0
    if (dir) rmSync(dir, { recursive: true, force: true })
  })
  const capture = () => {
    errors = []
    stdout = []
    console.error = (...a: unknown[]) => void errors.push(a.join(" "))
    process.stdout.write = ((s: string) => (stdout.push(String(s)), true)) as typeof process.stdout.write
  }
  const fakePerf = () =>
    Dispatcher.register("altimate_core.dbt_perf", async () => ({
      success: true,
      data: { findings: [{ code: "P999", model: "model.p.m", severity: "warning", message: "subquery" }], skipped_rules: [], summary: {} },
    }))

  test("dbt-optimize --apply writes a proven rewrite back with refs", async () => {
    dir = project()
    fakePerf()
    Dispatcher.register("altimate_core.dbt_rewrites", async () => ({
      success: true,
      data: { proposals: [{ rule: "optimizer:merge_subqueries", source: "optimizer_pass", before_sql: M_COMPILED, after_sql: `SELECT account FROM ${SRC_REL} WHERE 1 = 1`, proof: proven, applicable: true }] },
    }))
    capture()
    await DbtOptimizeCommand.handler({ model: "m", cwd: dir, apply: true, _: [], $0: "" } as never)
    const text = errors.join("\n")
    expect(text).toContain("P999")
    expect(text).toContain("APPLIED proposal #1")
    expect(text).toContain("altimate dbt-parity --model m --before iceberg.s.m")
    expect(readFileSync(path.join(dir, "models/m.sql"), "utf-8")).toBe(
      "{{ config(materialized='table') }}\n\nSELECT account FROM {{ ref('src') }} WHERE 1 = 1\n",
    )
    expect(process.exitCode ?? 0).toBe(0)
  })

  test("dbt-optimize --apply refuses a refuted proposal and leaves the file alone", async () => {
    dir = project()
    fakePerf()
    Dispatcher.register("altimate_core.dbt_rewrites", async () => ({
      success: true,
      data: { proposals: [{ rule: "r", before_sql: M_COMPILED, after_sql: "select 2", proof: refuted, applicable: false }] },
    }))
    capture()
    await DbtOptimizeCommand.handler({ model: "m", cwd: dir, apply: true, _: [], $0: "" } as never)
    expect(errors.join("\n")).toContain("NOT APPLIED")
    expect(readFileSync(path.join(dir, "models/m.sql"), "utf-8")).toBe(M_RAW)
    expect(process.exitCode).toBe(1)
  })

  test("a missing core export is a named error, not an empty result", async () => {
    dir = project()
    Dispatcher.register("altimate_core.dbt_impact", async () => ({
      success: false,
      data: {},
      error: bindingUnavailable("analyzeDbtImpact", "altimate dbt-impact"),
    }))
    capture()
    await DbtImpactCommand.handler({ model: "m", cwd: dir, kind: "drop", _: [], $0: "" } as never)
    expect(errors.join("\n")).toContain("lacks analyzeDbtImpact")
    expect(process.exitCode).toBe(1)
  })

  test("dbt-impact passes --strategy / --unique-key, and --no-exposure-sinks as an option", async () => {
    dir = project()
    let sent: unknown
    let opts: unknown
    Dispatcher.register("altimate_core.dbt_impact", async (p: { change_json: string; options_json?: string }) => {
      sent = JSON.parse(p.change_json)
      opts = p.options_json ? JSON.parse(p.options_json) : undefined
      return { success: true, data: IMPACT }
    })
    capture()
    await DbtImpactCommand.handler({
      model: "m",
      kind: "materialization",
      to: "incremental",
      strategy: "delete+insert",
      "unique-key": ["account"],
      "exposure-sinks": false,
      cwd: dir,
      json: true,
      _: [],
      $0: "",
    } as never)
    expect(sent).toEqual({
      model: "m",
      kind: "materialization",
      to: "incremental",
      incremental_strategy: "delete+insert",
      unique_key: ["account"],
    })
    expect(opts).toEqual({ sinks_from_exposures: false })
  })

  test("diff mode reads incremental_strategy and unique_key from the head config", () => {
    const d = changesForFile({
      model: "f",
      status: "modified",
      baseRaw: "{{ config(materialized='table') }}\nselect 1 as k",
      headRaw:
        "{{ config(materialized='incremental', incremental_strategy='delete+insert', unique_key=['k', 'd']) }}\nselect 1 as k",
    })
    expect(d.changes[0]).toEqual({
      model: "f",
      kind: "materialization",
      from: "table",
      to: "incremental",
      incremental_strategy: "delete+insert",
      unique_key: ["k", "d"],
    })
  })

  test("dbt-impact --json carries the per-hop report and honours --fail-on", async () => {
    dir = project()
    let sent: unknown
    Dispatcher.register("altimate_core.dbt_impact", async (p: { change_json: string }) => {
      sent = JSON.parse(p.change_json)
      return { success: true, data: IMPACT }
    })
    capture()
    await DbtImpactCommand.handler({ model: "m", column: "account", kind: "drop", cwd: dir, json: true, "fail-on": "breaking", _: [], $0: "" } as never)
    expect(errors.join("\n")).toBe("")
    expect(sent).toEqual({ model: "m", column: "account", kind: "drop" })
    const out = JSON.parse(stdout.join(""))
    expect(out.worst).toBe("breaking")
    expect(out.results[0].report.entries).toHaveLength(3)
    expect(process.exitCode).toBe(1)
  })

  test("dbt-factor sends --min-occurrences as core's min_models", async () => {
    dir = project()
    let sent: Record<string, unknown> | undefined
    Dispatcher.register("altimate_core.dbt_factoring", async (params) => {
      sent = JSON.parse(String(params.options_json))
      return { success: true, data: { proposals: [] } }
    })
    capture()
    await DbtFactorCommand.handler({ project: true, cwd: dir, "min-occurrences": 3, _: [], $0: "" } as never)
    expect(sent).toEqual({ min_models: 3 })
  })

  test("dbt-factor shows proposals as patches without --apply", async () => {
    dir = project()
    Dispatcher.register("altimate_core.dbt_factoring", async () => ({
      success: true,
      data: {
        proposals: [
          {
            new_model_name: "int_account_usage",
            new_model_sql: `select account from ${SRC_REL}`,
            consumers: [{ model: "c", consumer_sql: `select account, count(*) as n from "iceberg"."s"."int_account_usage" group by account`, proof: proven }],
            savings: "1 scan",
          },
        ],
      },
    }))
    capture()
    await DbtFactorCommand.handler({ project: true, cwd: dir, _: [], $0: "" } as never)
    const text = errors.join("\n")
    expect(text).toContain("#1 int_account_usage")
    expect(text).toContain("+++ b/models/intermediate/int_account_usage.sql")
    expect(text).toContain("altimate dbt-parity --model c")
    expect(readFileSync(path.join(dir, "models/c.sql"), "utf-8")).toBe(C_RAW)
  })
})

describe("native registration degrades with a named error", () => {
  beforeAll(() => registerAll())
  test.skipIf(hasBinding("proposeFactoring"))("dbt_factoring on a core without proposeFactoring", async () => {
    const r = await Dispatcher.call("altimate_core.dbt_factoring", { project_dir: "/nope" })
    expect(r.success).toBe(false)
    expect(r.error).toContain("lacks proposeFactoring")
    expect(r.error).toContain("altimate dbt-factor")
  })
})
// altimate_change end
