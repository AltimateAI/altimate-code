import { describe, test, expect } from "bun:test"
import {
  makeFinding,
  fingerprint,
  parseJsonl,
  toJsonl,
  dedupe,
  type Finding,
  DEFAULT_RUBRIC,
  Rubric,
  exclusionReason,
  clampSeverity,
  computeIdealVerdict,
  applyMode,
  VCS_EVENT,
  buildEnvelope,
  signEnvelope,
  verifyEnvelope,
  applyOverride,
  classifyDbtFile,
  shouldReview,
  classifyPR,
  classifyFile,
  type ChangedFile,
  runReview,
  modelNameFromPath,
  type ReviewRunner,
  type ImpactResult,
  type EquivalenceResult,
  renderSummary,
  inlineComments,
  parseReviewConfig,
  resolveRubric,
  DEFAULT_REVIEW_CONFIG,
} from "../../src/altimate/review"

// ---------------------------------------------------------------------------
// finding.ts
// ---------------------------------------------------------------------------
describe("finding", () => {
  test("fingerprint is stable and identity-based (ignores line/body)", () => {
    const a = fingerprint({ category: "lineage_breakage", file: "models/a.sql", model: "a", ruleKey: "drop" })
    const b = fingerprint({ category: "lineage_breakage", file: "models/a.sql", model: "a", ruleKey: "drop" })
    const c = fingerprint({ category: "lineage_breakage", file: "models/a.sql", model: "a", ruleKey: "rename" })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a.startsWith("f_")).toBe(true)
  })

  test("makeFinding auto-assigns fingerprint from ruleKey", () => {
    const f1 = makeFinding({
      severity: "warning",
      category: "sql_quality",
      title: "SELECT * detected",
      body: "avoid select star",
      file: "models/x.sql",
      ruleKey: "no-select-star",
    })
    const f2 = makeFinding({
      severity: "warning",
      category: "sql_quality",
      title: "SELECT * detected on line 9", // different title/body
      body: "different wording",
      file: "models/x.sql",
      ruleKey: "no-select-star",
    })
    expect(f1.id).toBe(f2.id) // identity survives rewording
  })

  test("parseJsonl tolerates malformed lines", () => {
    const good = makeFinding({
      severity: "critical",
      category: "pii_exposure",
      title: "pii",
      body: "b",
      file: "m.sql",
      ruleKey: "pii",
    })
    const jsonl = [toJsonl([good]), "{not json", "// a comment", '{"foo":"bar"}'].join("\n")
    const { findings, skipped } = parseJsonl(jsonl)
    expect(findings.length).toBe(1)
    expect(skipped).toBe(2) // bad json + invalid finding shape; comment ignored not counted
  })

  test("dedupe keeps highest severity per fingerprint", () => {
    const base = { category: "sql_quality" as const, file: "m.sql", title: "t", body: "b", ruleKey: "r" }
    const sug = makeFinding({ ...base, severity: "suggestion" })
    const warn = makeFinding({ ...base, severity: "warning" })
    const out = dedupe([sug, warn])
    expect(out.length).toBe(1)
    expect(out[0].severity).toBe("warning")
  })
})

// ---------------------------------------------------------------------------
// rubric.ts
// ---------------------------------------------------------------------------
describe("rubric", () => {
  test("UNKNOWN/low confidence can never be critical (the safety invariant)", () => {
    expect(clampSeverity("semantic_change", "critical", "unknown")).toBe("warning")
    expect(clampSeverity("lineage_breakage", "critical", "low")).toBe("warning")
    expect(clampSeverity("pii_exposure", "critical", "high")).toBe("critical")
  })

  test("exclusion: non-prod models are skipped", () => {
    const f = makeFinding({
      severity: "warning",
      category: "warehouse_cost",
      title: "scan",
      body: "x",
      file: "models/dev/scratch.sql",
      ruleKey: "scan",
    })
    expect(exclusionReason(f, DEFAULT_RUBRIC)).toContain("non-prod")
  })

  test("exclusion: SELECT * allowed in staging", () => {
    const f = makeFinding({
      severity: "suggestion",
      category: "warehouse_cost",
      title: "SELECT * found",
      body: "select * from t",
      file: "models/staging/stg_x.sql",
      model: "stg_x",
      ruleKey: "select-star",
    })
    expect(exclusionReason(f, DEFAULT_RUBRIC)).toContain("staging")
  })
})

// ---------------------------------------------------------------------------
// verdict.ts
// ---------------------------------------------------------------------------
describe("verdict", () => {
  const mk = (severity: Finding["severity"], category: any = "sql_quality") =>
    makeFinding({
      severity,
      category,
      title: "t",
      body: "b",
      file: `m_${Math.random()}.sql`,
      ruleKey: String(Math.random()),
    })

  test("empty findings → APPROVE", () => {
    expect(computeIdealVerdict([], DEFAULT_RUBRIC)).toBe("APPROVE")
  })

  test("blocking-category critical → REQUEST_CHANGES", () => {
    expect(computeIdealVerdict([mk("critical", "lineage_breakage")], DEFAULT_RUBRIC)).toBe("REQUEST_CHANGES")
  })

  test("non-blocking critical does not force block by category", () => {
    // sql_quality is not in blockOn; a lone non-blocking critical → COMMENT
    expect(computeIdealVerdict([mk("critical", "sql_quality")], DEFAULT_RUBRIC)).toBe("COMMENT")
  })

  test(">= threshold warnings → REQUEST_CHANGES (risk pattern)", () => {
    const f = [mk("warning"), mk("warning"), mk("warning")]
    expect(computeIdealVerdict(f, DEFAULT_RUBRIC)).toBe("REQUEST_CHANGES")
  })

  test("unknown-confidence warnings do NOT accumulate into a block", () => {
    const u = (i: number) =>
      makeFinding({
        severity: "warning",
        category: "semantic_change",
        title: "t" + i,
        body: "b",
        file: `m${i}.sql`,
        confidence: "unknown",
        ruleKey: "r" + i,
      })
    // Three unprovable refactors must not fail the gate.
    expect(computeIdealVerdict([u(1), u(2), u(3)], DEFAULT_RUBRIC)).toBe("COMMENT")
  })

  test("advisory AI warnings do NOT accumulate into a block (gate-mode safe)", () => {
    // The LLM lane is advisory-only: even ≥ threshold confident AI warnings must NOT
    // force REQUEST_CHANGES (otherwise a chatty/prompt-injected review could block).
    const ai = (i: number) =>
      makeFinding({
        severity: "warning",
        category: "sql_quality",
        title: "ai" + i,
        body: "b",
        file: `m${i}.sql`,
        confidence: "medium",
        evidence: { tool: "ai-review", result: {} },
        ruleKey: `ai:sql_quality:t${i}`,
      })
    expect(computeIdealVerdict([ai(1), ai(2), ai(3), ai(4)], DEFAULT_RUBRIC)).toBe("COMMENT")
    // A mix: 2 deterministic warnings + many AI warnings still must not reach the
    // threshold of 3 deterministic-confident warnings on the strength of AI alone.
    expect(computeIdealVerdict([mk("warning"), mk("warning"), ai(1), ai(2)], DEFAULT_RUBRIC)).toBe("COMMENT")
  })

  test("single suggestion → COMMENT", () => {
    expect(computeIdealVerdict([mk("suggestion")], DEFAULT_RUBRIC)).toBe("COMMENT")
  })

  test("the bot NEVER emits a formal APPROVE review event", () => {
    // A bot approval could satisfy branch protection and merge a PR without human
    // sign-off. An APPROVE verdict must post a COMMENT review event instead.
    expect(VCS_EVENT.APPROVE).toBe("COMMENT")
    expect(Object.values(VCS_EVENT)).not.toContain("APPROVE")
  })

  test("comment mode softens REQUEST_CHANGES → COMMENT", () => {
    expect(applyMode("REQUEST_CHANGES", "comment")).toBe("COMMENT")
    expect(applyMode("REQUEST_CHANGES", "gate")).toBe("REQUEST_CHANGES")
  })

  test("composition: computeIdealVerdict → applyMode → VCS_EVENT maps to the right event in both modes", () => {
    // Adversarial composition test. The static-map test guards the table in
    // isolation; this asserts the POSITIVE expected GitHub event for every
    // verdict-producing finding-set across both modes, so a regression at any
    // layer (computeIdealVerdict, applyMode, or the map) is caught — not just a
    // resurrected APPROVE path. Each case lists [findings, gate event, comment event].
    type Event = "COMMENT" | "REQUEST_CHANGES"
    const cases: Array<{ findings: Finding[]; gate: Event; comment: Event }> = [
      { findings: [], gate: "COMMENT", comment: "COMMENT" }, // ideal APPROVE → never a formal APPROVE
      { findings: [mk("suggestion")], gate: "COMMENT", comment: "COMMENT" }, // ideal COMMENT
      { findings: [mk("critical", "lineage_breakage")], gate: "REQUEST_CHANGES", comment: "COMMENT" }, // blocking critical
      { findings: [mk("warning"), mk("warning"), mk("warning")], gate: "REQUEST_CHANGES", comment: "COMMENT" }, // risk pattern
    ]
    for (const { findings, gate, comment } of cases) {
      const gateEnv = buildEnvelope({ findings, tier: "full", mode: "gate" })
      const commentEnv = buildEnvelope({ findings, tier: "full", mode: "comment" })
      expect(VCS_EVENT[gateEnv.verdict]).toBe(gate)
      expect(VCS_EVENT[commentEnv.verdict]).toBe(comment)
      // No mode/finding combination may ever emit a formal APPROVE.
      expect(VCS_EVENT[gateEnv.verdict]).not.toBe("APPROVE")
      expect(VCS_EVENT[commentEnv.verdict]).not.toBe("APPROVE")
    }

    // Separation of semantic verdict vs VCS event: with no findings in gate mode
    // the internal verdict is still APPROVE (audit signal preserved), but the
    // posted event is COMMENT — the bot never formally approves.
    const approve = buildEnvelope({ findings: [], tier: "full", mode: "gate" })
    expect(approve.verdict).toBe("APPROVE")
    expect(approve.idealVerdict).toBe("APPROVE")
    expect(VCS_EVENT[approve.verdict]).toBe("COMMENT")

    // Comment mode preserves the would-have-blocked audit trail: idealVerdict is
    // REQUEST_CHANGES while the gated verdict (and event) soften to COMMENT.
    const softened = buildEnvelope({ findings: [mk("critical", "lineage_breakage")], tier: "full", mode: "comment" })
    expect(softened.idealVerdict).toBe("REQUEST_CHANGES")
    expect(softened.verdict).toBe("COMMENT")
    expect(VCS_EVENT[softened.verdict]).toBe("COMMENT")
  })

  test("envelope signs and verifies; tamper is detected", () => {
    const env = buildEnvelope({
      findings: [mk("critical", "pii_exposure")],
      tier: "full",
      mode: "gate",
      generatedAt: "2026-05-29T00:00:00Z",
    })
    const signed = signEnvelope(env, "test-key")
    expect(signed.signature).toBeDefined()
    expect(verifyEnvelope(signed, "test-key")).toBe(true)
    expect(verifyEnvelope(signed, "wrong-key")).toBe(false)
    const tampered = { ...signed, verdict: "APPROVE" as const }
    expect(verifyEnvelope(tampered, "test-key")).toBe(false)
  })

  test("tampering a NESTED finding field is detected (signature covers findings)", () => {
    const f = makeFinding({
      severity: "warning",
      category: "sql_quality",
      title: "t",
      body: "b",
      file: "m.sql",
      ruleKey: "r",
    })
    const signed = signEnvelope(
      buildEnvelope({ findings: [f], tier: "lite", mode: "comment", generatedAt: "2026-05-29T00:00:00Z" }),
      "k",
    )
    expect(verifyEnvelope(signed, "k")).toBe(true)
    const tampered = { ...signed, findings: [{ ...signed.findings[0], severity: "critical" as const }] }
    expect(verifyEnvelope(tampered, "k")).toBe(false)
  })

  test("break-glass override records prior verdict and re-signs", () => {
    const env = signEnvelope(
      buildEnvelope({ findings: [mk("critical", "contract_violation")], tier: "full", mode: "gate" }),
      "k",
    )
    const overridden = applyOverride(env, "alice", "hotfix", "k")
    expect(overridden.verdict).toBe("COMMENT")
    expect(overridden.override?.priorVerdict).toBe("REQUEST_CHANGES")
    expect(verifyEnvelope(overridden, "k")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// diff-filter.ts + risk-tier.ts
// ---------------------------------------------------------------------------
describe("diff-filter", () => {
  test("skips build artifacts, keeps models/macros/snapshots", () => {
    expect(shouldReview("target/compiled/x.sql")).toBe(false)
    expect(shouldReview("dbt_packages/dbt_utils/x.sql")).toBe(false)
    expect(shouldReview("target/manifest.json")).toBe(false)
    expect(shouldReview("models/marts/fct_orders.sql")).toBe(true)
    expect(shouldReview("macros/x.sql")).toBe(true)
    expect(shouldReview("snapshots/s.sql")).toBe(true)
  })

  test("classifies dbt file kinds", () => {
    expect(classifyDbtFile("models/marts/fct_orders.sql")).toBe("model_sql")
    expect(classifyDbtFile("models/marts/_marts.yml")).toBe("schema_yml")
    expect(classifyDbtFile("macros/x.sql")).toBe("macro")
    expect(classifyDbtFile("snapshots/s.sql")).toBe("snapshot")
    expect(classifyDbtFile("seeds/c.csv")).toBe("seed")
    expect(classifyDbtFile("dbt_project.yml")).toBe("project_config")
    expect(classifyDbtFile("models/marts/m.py")).toBe("python_model")
  })
})

describe("risk-tier", () => {
  const file = (path: string, diff: string, status: ChangedFile["status"] = "modified"): ChangedFile => ({
    path,
    status,
    diff,
  })

  test("trivial: schema-yml description-only, no downstream", () => {
    const r = classifyPR([file("models/marts/_m.yml", "+    description: better docs\n")])
    expect(r.tier).toBe("trivial")
  })

  test("full: PII touch forces full regardless of size", () => {
    const r = classifyPR([file("models/marts/dim.sql", "+select email from x\n")], {
      touchesPiiOf: () => true,
    })
    expect(r.tier).toBe("full")
    expect(r.reasons.join(" ")).toContain("PII")
  })

  test("full: materialization change forces full", () => {
    const r = classifyPR([file("models/marts/big.sql", "+{{ config(materialized='table') }}\nselect 1\n")])
    expect(r.tier).toBe("full")
  })

  test("full: contract touch forces full", () => {
    const r = classifyPR([file("models/marts/_m.yml", "+    contract:\n+      enforced: true\n")])
    expect(r.tier).toBe("full")
  })

  test("lite: small SQL logic change with bounded blast radius", () => {
    const diff = "+select a, b\n-select a\n"
    const r = classifyPR([file("models/intermediate/int_x.sql", diff)], { blastRadiusOf: () => 2 })
    expect(r.tier).toBe("lite")
  })

  test("full: blast radius > 5", () => {
    const r = classifyPR([file("models/staging/stg_x.sql", "+select a\n")], { blastRadiusOf: () => 12 })
    expect(r.tier).toBe("full")
  })

  test("full: source definition (+sources:) forces full despite diff prefix", () => {
    const r = classifyPR([file("models/staging/_sources.yml", "+sources:\n+  - name: raw_orders\n")])
    expect(r.tier).toBe("full")
    expect(r.reasons.join(" ")).toContain("source")
  })
})

// ---------------------------------------------------------------------------
// config.ts
// ---------------------------------------------------------------------------
describe("config", () => {
  test("parses yaml and applies defaults", () => {
    const cfg = parseReviewConfig("mode: gate\nseverityThreshold: warning\nexclude:\n  - legacy/**\n")
    expect(cfg.mode).toBe("gate")
    expect(cfg.severityThreshold).toBe("warning")
    expect(cfg.manifestPath).toBe("target/manifest.json") // default
  })

  test("empty config yields defaults", () => {
    expect(parseReviewConfig("").mode).toBe("comment")
  })

  test("resolveRubric folds exclude globs into rubric", () => {
    const cfg = { ...DEFAULT_REVIEW_CONFIG, exclude: ["legacy/old.sql"] }
    const rubric = resolveRubric(cfg)
    expect(rubric.exclusions.excludeGlobs).toContain("legacy/old.sql")
  })
})

// ---------------------------------------------------------------------------
// orchestrate.ts — the integration test with a fake engine
// ---------------------------------------------------------------------------
describe("orchestrate", () => {
  test("modelNameFromPath", () => {
    expect(modelNameFromPath("models/marts/fct_revenue.sql")).toBe("fct_revenue")
    expect(modelNameFromPath("models/x/m.py")).toBe("m")
  })

  // A scripted fake engine keyed by model name.
  function fakeRunner(opts: {
    impact?: Record<string, ImpactResult>
    equivalence?: Record<string, EquivalenceResult>
    pii?: Record<string, string[]>
    checkIssues?: Record<
      string,
      Array<{ rule: string; message: string; line?: number; severity?: string; category?: string }>
    >
  }): ReviewRunner {
    return {
      async impact(model) {
        return (
          opts.impact?.[model] ?? {
            hasManifest: true,
            severity: "SAFE",
            directCount: 0,
            transitiveCount: 0,
            testCount: 0,
          }
        )
      },
      async grade() {
        return { grade: "B" }
      },
      async check(_sql, _d) {
        // keyed by nothing here — issues injected via closure when needed
        return { issues: [] }
      },
      async equivalence(_o, _n, _d) {
        return { decided: false }
      },
      async detectPii() {
        return { columns: [] }
      },
    } as ReviewRunner
  }

  const content = (newSql: string, oldSql?: string) => async (_f: string, side: "old" | "new") =>
    side === "new" ? newSql : (oldSql ?? newSql)

  test("breaking deletion of a model with downstream → critical lineage_breakage + REQUEST_CHANGES (gate)", async () => {
    const files: ChangedFile[] = [{ path: "models/staging/stg_orders.sql", status: "deleted", diff: "" }]
    const runner = fakeRunner({
      impact: {
        stg_orders: { hasManifest: true, severity: "BREAKING", directCount: 3, transitiveCount: 8, testCount: 4 },
      },
    })
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG, mode: "gate" },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      generatedAt: "2026-05-29T00:00:00Z",
    })
    const breakage = env.findings.find((f) => f.category === "lineage_breakage")
    expect(breakage).toBeDefined()
    expect(breakage!.severity).toBe("critical")
    expect(env.verdict).toBe("REQUEST_CHANGES")
    expect(verifyEnvelope(signEnvelope({ ...env, signature: undefined }))).toBe(true)
  })

  test("core AST lint ran → fragile regex twin (comma-join) is suppressed", async () => {
    const files: ChangedFile[] = [
      { path: "models/marts/m.sql", status: "modified", diff: "+from {{ ref('a') }} a, {{ ref('b') }} b\n" },
    ]
    const sql = "select * from {{ ref('a') }} a, {{ ref('b') }} b"
    // Runner WITH core lint available (ran:true) emits the AST cartesian finding.
    const withCore: ReviewRunner = {
      ...fakeRunner({}),
      async check() {
        return { issues: [{ rule: "cartesian-product", message: "implicit cross join", severity: "warning" }], ran: true }
      },
    }
    const envCore = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["sql_quality", "dbt_patterns"] },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner: withCore,
      getContent: content(sql),
      generatedAt: "2026-05-29T00:00:00Z",
    })
    // The regex comma-join twin is dropped; the core AST finding remains.
    const regexJoin = envCore.findings.find(
      (f) => f.evidence?.tool === "dbt-patterns" && f.category === "join_risk",
    )
    expect(regexJoin).toBeUndefined()
    expect(envCore.findings.some((f) => f.evidence?.tool === "altimate_core.check")).toBe(true)

    // Control: core lint NOT available (ran:false) → regex twin is kept (fallback).
    const noCore = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["sql_quality", "dbt_patterns"] },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner: { ...fakeRunner({}), async check() { return { issues: [], ran: false } } },
      getContent: content(sql),
      generatedAt: "2026-05-29T00:00:00Z",
    })
    expect(noCore.findings.some((f) => f.evidence?.tool === "dbt-patterns" && f.category === "join_risk")).toBe(true)
  })

  test("structuralChangeLane passes COMPILED SQL (not raw Jinja) to structural_diff and surfaces the finding", async () => {
    // Regression guard: structural_diff parses with a real SQL parser, so the lane
    // MUST use engine/compiled SQL — raw Jinja (`{{ ref() }}`) would never parse and
    // the lane would silently emit nothing.
    const rawNew = "select distinct id from {{ ref('orders') }}"
    const rawOld = "select id from {{ ref('orders') }}"
    const compiledNew = "select distinct id from prod.orders"
    const compiledOld = "select id from prod.orders"
    let sawBase = ""
    let sawHead = ""
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async structuralDiff(baseSql, headSql) {
        sawBase = baseSql
        sawHead = headSql
        return [{ code: "SC001", rule: "distinct_added", severity: "warning", message: "DISTINCT added" }]
      },
    }
    const env = await runReview({
      changedFiles: [{ path: "models/marts/m.sql", status: "modified", diff: "+select distinct" }],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["dbt_patterns"], ai: false },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      getContent: async (_f, side) => (side === "new" ? rawNew : rawOld),
      getCompiled: async (_f, side) => (side === "new" ? compiledNew : compiledOld),
      generatedAt: "2026-05-29T00:00:00Z",
    })
    // The lane received the COMPILED SQL, never the raw Jinja.
    expect(sawBase).toBe(compiledOld)
    expect(sawHead).toBe(compiledNew)
    expect(sawHead.includes("{{")).toBe(false)
    // And the structural finding is surfaced.
    expect(
      env.findings.some(
        (f) => f.evidence?.tool === "altimate_core.structural_diff" && (f.evidence?.result as any)?.code === "SC001",
      ),
    ).toBe(true)
  })

  test("structuralChangeLane runs under the semantic_change lane (NOT only dbt_patterns)", async () => {
    // Wiring guard: structuralChangeLane is a `semantic_change` concern. It must run
    // when the tier enables semantic_change even if dbt_patterns is absent.
    let called = false
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async structuralDiff() {
        called = true
        return [{ code: "SC003", rule: "group_by_change", severity: "warning", message: "grain changed" }]
      },
    }
    const env = await runReview({
      changedFiles: [{ path: "models/marts/m.sql", status: "modified", diff: "+group by" }],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["semantic_change"], ai: false },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      getContent: async (_f, side) => (side === "new" ? "select g, sum(x) from t group by g, h" : "select g, sum(x) from t group by g"),
      getCompiled: async (_f, side) => (side === "new" ? "select g, sum(x) from t group by g, h" : "select g, sum(x) from t group by g"),
      generatedAt: "2026-05-29T00:00:00Z",
    })
    expect(called).toBe(true)
    expect(
      env.findings.some((f) => f.evidence?.tool === "altimate_core.structural_diff"),
    ).toBe(true)
  })

  test("core SC010 join-key regression maps to critical join_risk and blocks", async () => {
    const oldSql = `
      select *
      from orders
      left join customers
        on orders.customer_id = customers.customer_id
    `
    const newSql = `
      select *
      from orders
      left join customers
        on orders.order_id = customers.customer_id
    `
    let sawBase = ""
    let sawHead = ""
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async structuralDiff(baseSql, headSql) {
        sawBase = baseSql
        sawHead = headSql
        return [
          {
            code: "SC010",
            rule: "join_key_regression",
            severity: "error",
            message:
              "A join key changed from matching the same identifier stem to `orders.order_id = customers.customer_id`.",
          },
        ]
      },
    }
    const env = await runReview({
      changedFiles: [
        {
          path: "models/marts/fct_customer_orders.sql",
          status: "modified",
          diff: "+on orders.order_id = customers.customer_id\n-on orders.customer_id = customers.customer_id\n",
        },
      ],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["semantic_change"], ai: false },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: async (_f, side) => (side === "new" ? newSql : oldSql),
      getCompiled: async (_f, side) => (side === "new" ? newSql : oldSql),
      generatedAt: "2026-06-08T00:00:00Z",
    })
    expect(sawBase).toBe(oldSql)
    expect(sawHead).toBe(newSql)
    const f = env.findings.find(
      (x) => x.evidence?.tool === "altimate_core.structural_diff" && (x.evidence?.result as any)?.code === "SC010",
    )
    expect(f).toBeDefined()
    expect(f!.severity).toBe("critical")
    expect(f!.category).toBe("join_risk")
    expect(env.verdict).toBe("REQUEST_CHANGES")
  })

  test("core structural diff quiet on CTE rename and bridge join countercases", async () => {
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async structuralDiff() {
        return []
      },
    }
    const safeEnv = await runReview({
      changedFiles: [
        {
          path: "models/marts/fct_customer_orders.sql",
          status: "modified",
          diff:
            "+on order_records.customer_id = customer_records.customer_id\n" +
            "-on orders.customer_id = customers.customer_id\n",
        },
      ],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["semantic_change"], ai: false },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: async (_f, side) =>
        side === "new"
          ? "select * from order_records left join customer_records on order_records.customer_id = customer_records.customer_id"
          : "select * from orders left join customers on orders.customer_id = customers.customer_id",
      getCompiled: async (_f, side) =>
        side === "new"
          ? "select * from order_records left join customer_records on order_records.customer_id = customer_records.customer_id"
          : "select * from orders left join customers on orders.customer_id = customers.customer_id",
      generatedAt: "2026-06-08T00:00:00Z",
    })
    expect(
      safeEnv.findings.some(
        (x) => x.evidence?.tool === "altimate_core.structural_diff" && (x.evidence?.result as any)?.code === "SC010",
      ),
    ).toBe(false)

    const bridgeEnv = await runReview({
      changedFiles: [
        {
          path: "models/marts/fct_order_items.sql",
          status: "modified",
          diff: "+on orders.order_id = order_items.order_id\n-on orders.customer_id = customers.customer_id\n",
        },
      ],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["semantic_change"], ai: false },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: async (_f, side) =>
        side === "new"
          ? "select * from orders left join order_items on orders.order_id = order_items.order_id"
          : "select * from orders left join customers on orders.customer_id = customers.customer_id",
      getCompiled: async (_f, side) =>
        side === "new"
          ? "select * from orders left join order_items on orders.order_id = order_items.order_id"
          : "select * from orders left join customers on orders.customer_id = customers.customer_id",
      generatedAt: "2026-06-08T00:00:00Z",
    })
    expect(
      bridgeEnv.findings.some(
        (x) => x.evidence?.tool === "altimate_core.structural_diff" && (x.evidence?.result as any)?.code === "SC010",
      ),
    ).toBe(false)
  })

  test("core L033 portability → regex portability twin suppressed, idempotency concern survives", async () => {
    const sql = "select getdate() as loaded_at from {{ ref('a') }}"
    const files: ChangedFile[] = [{ path: "models/marts/m.sql", status: "modified", diff: "+    , getdate() as loaded_at\n" }]
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async check() {
        return {
          issues: [{ rule: "non_portable_function", message: "GETDATE() is a non-standard / dialect-specific function.", severity: "info" }],
          ran: true,
        }
      },
    }
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["sql_quality", "dbt_patterns"] },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      getContent: content(sql),
      generatedAt: "2026-05-29T00:00:00Z",
    })
    // Core L033 is the single portability source.
    expect(env.findings.some((f) => f.evidence?.tool === "altimate_core.check")).toBe(true)
    // The regex portability twin (mentions GETDATE + "non-portable") is dropped.
    const regexPortability = env.findings.find(
      (f) => f.evidence?.tool === "rule-catalog" && /portab|non-?standard|dialect/i.test(f.body) && /getdate/i.test(f.body),
    )
    expect(regexPortability).toBeUndefined()
    // But the distinct IDEMPOTENCY concern about GETDATE survives.
    expect(env.findings.some((f) => f.category === "idempotency" && /getdate/i.test(f.body))).toBe(true)
  })

  test("PII lane: flags a newly-introduced PII column (classify_pii), diff-scoped", async () => {
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async columnLineage() {
        return [
          { source: '"users"."email"', target: "email" },
          { source: '"users"."first_name"', target: "first_name" },
        ]
      },
      async classifyPii(cols) {
        expect(cols).toContain("email")
        return [
          { column: "email", classification: "Email", confidence: 0.95, masking: "'***'" },
          { column: "first_name", classification: "Name", confidence: 0.6 }, // below threshold → ignored
        ]
      },
    }
    const env = await runReview({
      changedFiles: [{ path: "models/marts/m.sql", status: "modified", diff: "+    , email" }],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["pii_exposure"], ai: false },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      getContent: async (_f, side) => (side === "new" ? "select id, email, first_name from users" : undefined),
      generatedAt: "2026-05-29T00:00:00Z",
    })
    const pii = env.findings.find((f) => f.evidence?.tool === "altimate_core.classify_pii")
    expect(pii).toBeDefined()
    expect(pii!.title).toMatch(/Email.*email/)
    // first_name (low confidence) and any pre-existing-but-not-in-diff PII are not flagged
    expect(env.findings.filter((f) => f.evidence?.tool === "altimate_core.classify_pii").length).toBe(1)
  })

  test("data-diff lane: surfaces base-vs-head row deltas via the engine (forwards warehouse)", async () => {
    const sql = "select customer_id, amount from t"
    let sawWarehouse: string | undefined
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async columnLineage() {
        return [{ source: '"t"."customer_id"', target: "customer_id" }, { source: '"t"."amount"', target: "amount" }]
      },
      async dataDiff(_b, _h, keys, warehouse) {
        expect(keys).toEqual(["customer_id"]) // inferred PK
        sawWarehouse = warehouse
        return { rowsOnlyInBase: 12, rowsOnlyInHead: 0, rowsChanged: 3, summary: "drops 12 rows" }
      },
    }
    const env = await runReview({
      changedFiles: [{ path: "models/marts/m.sql", status: "modified", diff: "+where amount > 0" }],
      config: {
        ...DEFAULT_REVIEW_CONFIG,
        reviewers: ["semantic_change"],
        ai: false,
        dataDiff: { enabled: true, warehouse: "prod_wh" },
      },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      getContent: async (_f, side) => (side === "new" ? sql : "select customer_id, amount from t /*base*/"),
      generatedAt: "2026-05-29T00:00:00Z",
    })
    const dd = env.findings.find((f) => f.evidence?.tool === "data.diff")
    expect(dd).toBeDefined()
    expect(dd!.body).toMatch(/12 only-in-base/)
    expect(sawWarehouse).toBe("prod_wh") // config.dataDiff.warehouse threaded through
  })

  test("data-diff lane: OFF by default (opt-in) — never calls the warehouse", async () => {
    let called = false
    const env = await runReview({
      changedFiles: [{ path: "models/marts/m.sql", status: "modified", diff: "+x" }],
      // No dataDiff config → defaults to disabled.
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["semantic_change"], ai: false },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner: {
        ...fakeRunner({}),
        async columnLineage() { return [{ source: '"t"."id"', target: "id" }] },
        async dataDiff() { called = true; return { rowsOnlyInBase: 5 } },
      },
      getContent: async (_f, side) => (side === "new" ? "select id from t" : "select id from t /*b*/"),
      generatedAt: "2026-05-29T00:00:00Z",
    })
    expect(called).toBe(false) // disabled → lane short-circuits before the warehouse
    expect(env.findings.some((f) => f.evidence?.tool === "data.diff")).toBe(false)
  })

  test("data-diff lane: enabled but skips gracefully when no warehouse/driver (dataDiff → null)", async () => {
    const env = await runReview({
      changedFiles: [{ path: "models/marts/m.sql", status: "modified", diff: "+x" }],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["semantic_change"], ai: false, dataDiff: { enabled: true, warehouse: "" } },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner: { ...fakeRunner({}), async columnLineage() { return [{ source: '"t"."id"', target: "id" }] }, async dataDiff() { return null } },
      getContent: async (_f, side) => (side === "new" ? "select id from t" : "select id from t /*b*/"),
      generatedAt: "2026-05-29T00:00:00Z",
    })
    expect(env.findings.some((f) => f.evidence?.tool === "data.diff")).toBe(false)
  })

  // --- Topology-aware equivalence (merge refactor: N deleted + 1 added) ---

  const MERGE_FILES: ChangedFile[] = [
    { path: "models/intermediate/int_column_access_base.sql", status: "deleted", diff: "" },
    { path: "models/intermediate/int_column_access_direct.sql", status: "deleted", diff: "" },
    { path: "models/intermediate/int_column_access_modified.sql", status: "deleted", diff: "" },
    { path: "models/intermediate/int_column_access_daily.sql", status: "added", diff: "+select 1\n" },
  ]
  const mergeCompiled = async (file: string, side: "old" | "new") => {
    if (side === "new") return "select account, day, query_count from src_daily"
    return `select account, day, query_count from src_${file.split("/").pop()}`
  }

  test("topology lane: N-models-merged-into-1 that is NOT proven equivalent → advisory warning (never blocks)", async () => {
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async equivalence() {
        // High confidence on purpose: the lane must STILL cap at warning because
        // the UNION ALL composition is inferred.
        return { decided: true, equivalent: false, differences: ["Different aggregation structure"], confidence: "high" }
      },
    }
    const env = await runReview({
      changedFiles: MERGE_FILES,
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["semantic_change"], ai: false },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: async (f, side) => mergeCompiled(f, side),
      getCompiled: mergeCompiled,
      generatedAt: "2026-05-29T00:00:00Z",
    })
    const topo = env.findings.find((f) => (f.evidence?.result as any)?.topology === "merge")
    expect(topo).toBeDefined()
    expect(topo!.category).toBe("semantic_change")
    expect(topo!.severity).toBe("warning") // hard-capped — inferred composition never blocks
    expect((topo!.evidence?.result as any).replaced).toEqual([
      "int_column_access_base",
      "int_column_access_direct",
      "int_column_access_modified",
    ])
    expect(topo!.title).toMatch(/merges 3 models/)
    // Advisory: even in gate mode a merge-equivalence warning must not REQUEST_CHANGES.
    expect(env.verdict).not.toBe("REQUEST_CHANGES")
  })

  test("topology lane: merge PROVEN equivalent → stays silent", async () => {
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async equivalence() {
        return { decided: true, equivalent: true, confidence: "high" }
      },
    }
    const env = await runReview({
      changedFiles: MERGE_FILES,
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["semantic_change"], ai: false },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      getContent: async (f, side) => mergeCompiled(f, side),
      getCompiled: mergeCompiled,
      generatedAt: "2026-05-29T00:00:00Z",
    })
    expect(env.findings.some((f) => (f.evidence?.result as any)?.topology === "merge")).toBe(false)
  })

  test("topology lane: not a merge (single deletion) → no topology finding", async () => {
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async equivalence() {
        return { decided: true, equivalent: false, confidence: "high" }
      },
    }
    const env = await runReview({
      changedFiles: [
        { path: "models/intermediate/int_column_access_base.sql", status: "deleted", diff: "" },
        { path: "models/intermediate/int_column_access_daily.sql", status: "added", diff: "+select 1\n" },
      ],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["semantic_change"], ai: false },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      getContent: async (f, side) => mergeCompiled(f, side),
      getCompiled: mergeCompiled,
      generatedAt: "2026-05-29T00:00:00Z",
    })
    expect(env.findings.some((f) => (f.evidence?.result as any)?.topology === "merge")).toBe(false)
  })

  test("topology lane: undecidable composition → degraded advisory, never blocks", async () => {
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async equivalence() {
        return { decided: false }
      },
    }
    const env = await runReview({
      changedFiles: MERGE_FILES,
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["semantic_change"], ai: false },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: async (f, side) => mergeCompiled(f, side),
      getCompiled: mergeCompiled,
      generatedAt: "2026-05-29T00:00:00Z",
    })
    const topo = env.findings.find((f) => (f.evidence?.result as any)?.topology === "merge")
    expect(topo).toBeDefined()
    expect(topo!.severity).toBe("warning")
    expect(topo!.degraded).toBe(true)
    expect(env.verdict).not.toBe("REQUEST_CHANGES")
  })

  test("topology lane: no compiled SQL available → skips (no crash)", async () => {
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async equivalence() {
        return { decided: true, equivalent: false }
      },
    }
    const env = await runReview({
      changedFiles: MERGE_FILES,
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["semantic_change"], ai: false },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      getContent: async (f, side) => mergeCompiled(f, side),
      // getCompiled omitted → engine lanes have no rendered SQL.
      generatedAt: "2026-05-29T00:00:00Z",
    })
    expect(env.findings.some((f) => (f.evidence?.result as any)?.topology === "merge")).toBe(false)
  })

  // --- Cross-model sibling filter consistency ---
  test("sibling consistency: one of two siblings missing a filter on a shared upstream → advisory", async () => {
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async sourceFilters(sql) {
        // model A filters usage on warehouse_size; model B does not.
        return /modelA/.test(sql) ? { usage: ["warehouse_size"] } : { usage: [] }
      },
    }
    const env = await runReview({
      changedFiles: [
        { path: "models/staging/stg_a.sql", status: "modified", diff: "+x\n" },
        { path: "models/staging/stg_b.sql", status: "modified", diff: "+y\n" },
      ],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["semantic_change"], ai: false },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      getContent: async (f) => (f.includes("stg_a") ? "select 1 -- modelA" : "select 1 -- modelB"),
      generatedAt: "2026-05-29T00:00:00Z",
    })
    const f = env.findings.find((x) => /filters .* differently from sibling/.test(x.title))
    expect(f).toBeDefined()
    expect(f!.body).toMatch(/warehouse_size/)
  })

  test("sibling consistency: identical filters on shared upstream → no finding", async () => {
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async sourceFilters() { return { usage: ["warehouse_size"] } },
    }
    const env = await runReview({
      changedFiles: [
        { path: "models/staging/stg_a.sql", status: "modified", diff: "+x\n" },
        { path: "models/staging/stg_b.sql", status: "modified", diff: "+y\n" },
      ],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["semantic_change"], ai: false },
      rubric: DEFAULT_RUBRIC, mode: "comment", runner,
      getContent: content("select 1"), generatedAt: "2026-05-29T00:00:00Z",
    })
    expect(env.findings.some((x) => /differently from sibling/.test(x.title))).toBe(false)
  })

  // --- Grain mismatch (dedup/group key vs declared uniqueness) ---
  test("grain mismatch: dedup PARTITION BY conflicts with declared PK → flagged", async () => {
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async grain() { return { group_by: [], dedup_partition: ["account", "role_name"] } },
      async declaredPrimaryKey() { return ["account", "role_id"] },
    }
    const env = await runReview({
      changedFiles: [{ path: "models/intermediate/int_roles.sql", status: "modified", diff: "+x\n" }],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["semantic_change"], ai: false },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: content("select 1"),
      generatedAt: "2026-05-29T00:00:00Z",
    })
    const f = env.findings.find((x) => /grain key conflicts/.test(x.title))
    expect(f).toBeDefined()
    expect(f!.severity).toBe("warning")
  })

  test("grain mismatch: grain matches declared PK → no finding", async () => {
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async grain() { return { group_by: ["account", "role_id"], dedup_partition: [] } },
      async declaredPrimaryKey() { return ["account", "role_id"] },
    }
    const env = await runReview({
      changedFiles: [{ path: "models/intermediate/int_roles.sql", status: "modified", diff: "+x\n" }],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["semantic_change"], ai: false },
      rubric: DEFAULT_RUBRIC, mode: "comment", runner,
      getContent: content("select 1"), generatedAt: "2026-05-29T00:00:00Z",
    })
    expect(env.findings.some((x) => /grain key conflicts/.test(x.title))).toBe(false)
  })

  test("grain mismatch: no declared PK → stays silent (sound)", async () => {
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async grain() { return { group_by: ["a", "b"], dedup_partition: [] } },
      async declaredPrimaryKey() { return undefined },
    }
    const env = await runReview({
      changedFiles: [{ path: "models/intermediate/m.sql", status: "modified", diff: "+x\n" }],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["semantic_change"], ai: false },
      rubric: DEFAULT_RUBRIC, mode: "comment", runner,
      getContent: content("select 1"), generatedAt: "2026-05-29T00:00:00Z",
    })
    expect(env.findings.some((x) => /grain key conflicts/.test(x.title))).toBe(false)
  })

  // --- Missing grain test on a new model ---
  test("missing grain test: new mart model with no declared PK → suggestion", async () => {
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async declaredPrimaryKey() { return undefined },
    }
    const env = await runReview({
      changedFiles: [{ path: "models/marts/mrt_new.sql", status: "added", diff: "+select 1\n" }],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["test_coverage"], ai: false },
      rubric: DEFAULT_RUBRIC, mode: "comment", runner,
      getContent: content("select 1"), generatedAt: "2026-05-29T00:00:00Z",
    })
    const f = env.findings.find((x) => /no uniqueness\/grain test/.test(x.title))
    expect(f).toBeDefined()
    expect(f!.severity).toBe("suggestion")
  })

  test("missing grain test: new staging model → not flagged", async () => {
    const runner: ReviewRunner = { ...fakeRunner({}), async declaredPrimaryKey() { return undefined } }
    const env = await runReview({
      changedFiles: [{ path: "models/staging/stg_new.sql", status: "added", diff: "+select 1\n" }],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["test_coverage"], ai: false },
      rubric: DEFAULT_RUBRIC, mode: "comment", runner,
      getContent: content("select 1"), generatedAt: "2026-05-29T00:00:00Z",
    })
    expect(env.findings.some((x) => /no uniqueness\/grain test/.test(x.title))).toBe(false)
  })

  test("missing grain test: new mart WITH a declared PK → not flagged", async () => {
    const runner: ReviewRunner = { ...fakeRunner({}), async declaredPrimaryKey() { return ["id"] } }
    const env = await runReview({
      changedFiles: [{ path: "models/marts/mrt_ok.sql", status: "added", diff: "+select 1\n" }],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["test_coverage"], ai: false },
      rubric: DEFAULT_RUBRIC, mode: "comment", runner,
      getContent: content("select 1"), generatedAt: "2026-05-29T00:00:00Z",
    })
    expect(env.findings.some((x) => /no uniqueness\/grain test/.test(x.title))).toBe(false)
  })

  test("diff-scoping: the base SQL is forwarded to core for engine-side scoping", async () => {
    // Diff-scoping is done IN CORE (it receives base_sql). Here we assert the
    // orchestrator forwards the base compiled SQL to runner.check so core can
    // scope. (The structural scoping itself is covered by core's Rust tests.)
    let sawBase: string | undefined
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async check(_sql, _dialect, baseSql) {
        if (baseSql) sawBase = baseSql // qualityLane passes the base; other calls don't
        return { issues: [], ran: true }
      },
    }
    await runReview({
      changedFiles: [{ path: "models/marts/m.sql", status: "modified", diff: "+x" }],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["sql_quality"], ai: false },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      getContent: async (_f, side) => (side === "new" ? "select 2" : "select 1"),
      generatedAt: "2026-05-29T00:00:00Z",
    })
    expect(sawBase).toBe("select 1")
  })

  test("AI reviewer lane: advisory comments merge in, are grounded, and never block", async () => {
    const sql = "select customer_id, sum(amount) as revenue from {{ ref('orders') }} group by 1"
    const files: ChangedFile[] = [{ path: "models/marts/m.sql", status: "modified", diff: "+select ...\n" }]
    let groundingSeen: number | undefined
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["dbt_patterns", "ai_review"], mode: "gate" },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner: fakeRunner({}),
      getContent: content(sql),
      prTitle: "Add revenue mart",
      // Fake AI reviewer: returns a contextual comment + a (disallowed) critical
      // that must be downgraded — the AI must never block.
      aiReview: async (input) => {
        groundingSeen = input.grounding.length
        return [
          makeFinding({
            severity: "warning",
            category: "sql_correctness",
            title: "m: `revenue` may double-count un-deduped orders",
            body: "If orders has multiple rows per order_id, summing amount inflates revenue.",
            file: "models/marts/m.sql",
            model: "m",
            confidence: "medium",
            evidence: { tool: "ai-review", result: { confidence: "medium" } },
            ruleKey: "ai:sql_correctness:revenue-double-count",
          }),
          makeFinding({
            severity: "critical", // disallowed for AI — must be downgraded, must not block
            category: "sql_correctness",
            title: "m: bogus critical",
            body: "AI should never block.",
            file: "models/marts/m.sql",
            model: "m",
            evidence: { tool: "ai-review", result: {} },
            ruleKey: "ai:sql_correctness:bogus",
          }),
        ]
      },
      generatedAt: "2026-05-29T00:00:00Z",
    })
    // The advisory comment is present.
    expect(env.findings.some((f) => f.evidence?.tool === "ai-review" && /double-count/.test(f.title))).toBe(true)
    // The AI was grounded (received the deterministic findings, even if zero).
    expect(groundingSeen).toBeDefined()
    // No AI finding survived as critical, and the AI did NOT cause a block.
    expect(env.findings.some((f) => f.evidence?.tool === "ai-review" && f.severity === "critical")).toBe(false)
    expect(env.verdict).not.toBe("REQUEST_CHANGES")
  })

  test("FUSION: proven non-equivalent + downstream → critical → blocks (gate)", async () => {
    const files: ChangedFile[] = [{ path: "models/marts/fct_revenue.sql", status: "modified", diff: "+x\n-y\n" }]
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async impact() {
        return { hasManifest: true, severity: "MEDIUM", directCount: 4, transitiveCount: 2, testCount: 1 }
      },
      async equivalence() {
        return {
          decided: true,
          equivalent: false,
          differences: ["LEFT JOIN became INNER → drops NULL rows"],
          confidence: "high",
        }
      },
    }
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: content("select 2", "select 1"),
      generatedAt: "2026-05-29T00:00:00Z",
    })
    const sem = env.findings.find((f) => f.category === "semantic_change")
    expect(sem).toBeDefined()
    expect(sem!.severity).toBe("critical") // proven break + downstream consumers
    expect(sem!.body).toContain("NULL")
    expect(env.verdict).toBe("REQUEST_CHANGES")
  })

  test("proven non-equivalent with NO downstream → warning (not critical)", async () => {
    const files: ChangedFile[] = [{ path: "models/marts/leaf.sql", status: "modified", diff: "+x\n-y\n" }]
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async impact() {
        return { hasManifest: false, severity: "UNKNOWN", directCount: 0, transitiveCount: 0, testCount: 0 }
      },
      async equivalence() {
        return { decided: true, equivalent: false, differences: ["filter changed"], confidence: "high" }
      },
    }
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: content("select 2", "select 1"),
      generatedAt: "2026-05-29T00:00:00Z",
    })
    const sem = env.findings.find((f) => f.category === "semantic_change")
    expect(sem!.severity).toBe("warning")
    expect(env.verdict).not.toBe("REQUEST_CHANGES")
  })

  test("modified high-fanout model → warning (not critical), does not block", async () => {
    const files: ChangedFile[] = [{ path: "models/staging/stg_orders.sql", status: "modified", diff: "+select 1\n" }]
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async impact() {
        return { hasManifest: true, severity: "HIGH", directCount: 12, transitiveCount: 30, testCount: 5 }
      },
    }
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: content("select 1", "select 1"), // identical → no semantic finding, isolates lineage
      generatedAt: "2026-05-29T00:00:00Z",
    })
    const lin = env.findings.find((f) => f.category === "lineage_breakage")
    expect(lin?.severity).toBe("warning")
    expect(env.verdict).not.toBe("REQUEST_CHANGES")
  })

  test("engine contract_violation is preserved (not coerced to sql_quality) and blocks", async () => {
    const files: ChangedFile[] = [{ path: "models/marts/fct_orders.sql", status: "modified", diff: "+x\n" }]
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async check() {
        return {
          issues: [{ rule: "contract.enforced", message: "type narrowed", severity: "error", category: "contract" }],
        }
      },
    }
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: content("select 1", "select 1"), // identical → isolate the quality lane
      generatedAt: "2026-05-29T00:00:00Z",
    })
    const cv = env.findings.find((f) => f.category === "contract_violation")
    expect(cv).toBeDefined()
    expect(cv!.severity).toBe("critical")
    expect(env.verdict).toBe("REQUEST_CHANGES")
  })

  test("provably equivalent refactor → no semantic finding (don't nitpick what's safe)", async () => {
    const files: ChangedFile[] = [{ path: "models/marts/fct_revenue.sql", status: "modified", diff: "+x\n-y\n" }]
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async equivalence() {
        return { decided: true, equivalent: true, confidence: "high" }
      },
    }
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      getContent: content("select 2 /*refactor*/", "select 1"),
    })
    expect(env.findings.find((f) => f.category === "semantic_change")).toBeUndefined()
  })

  test("undecidable equivalence → unknown-confidence warning, never critical", async () => {
    const files: ChangedFile[] = [{ path: "models/marts/fct_revenue.sql", status: "modified", diff: "+x\n" }]
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async equivalence() {
        return { decided: false }
      },
    }
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: content("select 2", "select 1"),
    })
    const sem = env.findings.find((f) => f.category === "semantic_change")
    expect(sem).toBeDefined()
    expect(sem!.confidence).toBe("unknown")
    expect(sem!.severity).not.toBe("critical")
  })

  test("PII exposure → critical pii_exposure finding", async () => {
    const files: ChangedFile[] = [{ path: "models/marts/dim_customers.sql", status: "modified", diff: "+email\n" }]
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async detectPii() {
        return { columns: ["email", "ssn"] }
      },
    }
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: content("select email, ssn from x"),
    })
    const pii = env.findings.find((f) => f.category === "pii_exposure")
    expect(pii).toBeDefined()
    expect(pii!.severity).toBe("critical")
    expect(env.verdict).toBe("REQUEST_CHANGES")
  })

  test("diff-scoped core PII is the single blocker for newly introduced mart email", async () => {
    const files: ChangedFile[] = [{ path: "models/marts/dim_customers.sql", status: "modified", diff: "+    email\n" }]
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async detectPii() {
        return { columns: ["email"] }
      },
      async columnLineage(sql) {
        return sql.includes("email")
          ? [
              { source: "customers.customer_name", target: "customer_name" },
              { source: "customers.email", target: "email" },
            ]
          : [{ source: "customers.customer_name", target: "customer_name" }]
      },
      async classifyPii(columns) {
        return columns.map((column) => ({
          column,
          classification: "Email",
          confidence: 0.95,
          masking: "'***MASKED***'",
        }))
      },
    }
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: content("select customer_name, email from customers", "select customer_name from customers"),
    })
    const pii = env.findings.filter((f) => f.category === "pii_exposure")
    expect(pii).toHaveLength(1)
    expect(pii[0].severity).toBe("critical")
    expect(pii[0].evidence?.tool).toBe("altimate_core.classify_pii")
    expect(env.verdict).toBe("REQUEST_CHANGES")
  })

  test("broad PII detector remains fallback for existing output columns", async () => {
    const files: ChangedFile[] = [{ path: "models/marts/dim_customers.sql", status: "modified", diff: "+    lower(email) as email\n" }]
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async detectPii() {
        return { columns: ["email"] }
      },
      async columnLineage(sql) {
        return sql.includes("email")
          ? [
              { source: "customers.customer_id", target: "customer_id" },
              { source: "customers.email", target: "email" },
            ]
          : [{ source: "customers.customer_id", target: "customer_id" }]
      },
      async classifyPii(columns) {
        return columns.map((column) => ({
          column,
          classification: "Email",
          confidence: 0.95,
          masking: "'***MASKED***'",
        }))
      },
    }
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: content("select customer_id, lower(email) as email from customers", "select customer_id, email from customers"),
    })
    const pii = env.findings.filter((f) => f.category === "pii_exposure")
    expect(pii).toHaveLength(1)
    expect(pii[0].evidence?.tool).toBe("schema.detect_pii")
    expect(env.verdict).toBe("REQUEST_CHANGES")
  })

  test("PII fallback survives core lineage failure instead of aborting review", async () => {
    const files: ChangedFile[] = [{ path: "models/marts/dim_customers.sql", status: "modified", diff: "+    email\n" }]
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async detectPii() {
        return { columns: ["email"] }
      },
      async columnLineage() {
        throw new Error("lineage parser crashed")
      },
      async classifyPii(columns) {
        return columns.map((column) => ({
          column,
          classification: "Email",
          confidence: 0.95,
        }))
      },
    }
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: content("select customer_id, email from customers", "select customer_id from customers"),
    })
    const pii = env.findings.filter((f) => f.category === "pii_exposure")
    expect(pii).toHaveLength(1)
    expect(pii[0].evidence?.tool).toBe("schema.detect_pii")
    expect(env.verdict).toBe("REQUEST_CHANGES")
  })

  test("PII fallback survives core classification failure instead of hiding risk", async () => {
    const files: ChangedFile[] = [{ path: "models/marts/dim_customers.sql", status: "modified", diff: "+    email\n" }]
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async detectPii() {
        return { columns: ["email"] }
      },
      async columnLineage(sql) {
        return sql.includes("email")
          ? [
              { source: "customers.customer_id", target: "customer_id" },
              { source: "customers.email", target: "email" },
            ]
          : [{ source: "customers.customer_id", target: "customer_id" }]
      },
      async classifyPii() {
        throw new Error("classifier unavailable")
      },
    }
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: content("select customer_id, email from customers", "select customer_id from customers"),
    })
    const pii = env.findings.filter((f) => f.category === "pii_exposure")
    expect(pii).toHaveLength(1)
    expect(pii[0].evidence?.tool).toBe("schema.detect_pii")
    expect(env.verdict).toBe("REQUEST_CHANGES")
  })

  test("case-variant PII detector output does not duplicate core diff-scoped finding", async () => {
    const files: ChangedFile[] = [{ path: "models/marts/dim_customers.sql", status: "modified", diff: "+    Email as EMAIL\n" }]
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async detectPii() {
        return { columns: ["EMAIL", "email"] }
      },
      async columnLineage(sql) {
        return sql.toLowerCase().includes("email")
          ? [
              { source: "customers.customer_id", target: "customer_id" },
              { source: "customers.email", target: "EMAIL" },
            ]
          : [{ source: "customers.customer_id", target: "customer_id" }]
      },
      async classifyPii(columns) {
        return columns.map((column) => ({
          column,
          classification: "Email",
          confidence: 0.95,
        }))
      },
    }
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: content("select customer_id, Email as EMAIL from customers", "select customer_id from customers"),
    })
    const pii = env.findings.filter((f) => f.category === "pii_exposure")
    expect(pii).toHaveLength(1)
    expect(pii[0].evidence?.tool).toBe("altimate_core.classify_pii")
  })

  test("low-confidence name PII does not surface or fall back to regex PII comments", async () => {
    const files: ChangedFile[] = [{ path: "models/marts/dim_customers.sql", status: "modified", diff: "+    first_name\n" }]
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async detectPii() {
        return { columns: ["first_name"] }
      },
      async columnLineage(sql) {
        return sql.includes("first_name")
          ? [
              { source: "customers.customer_id", target: "customer_id" },
              { source: "customers.first_name", target: "first_name" },
            ]
          : [{ source: "customers.customer_id", target: "customer_id" }]
      },
      async classifyPii(columns) {
        return columns.map((column) => ({
          column,
          classification: "Name",
          confidence: 0.85,
        }))
      },
    }
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: content("select customer_id, first_name from customers", "select customer_id from customers"),
    })
    expect(env.findings.some((f) => f.category === "pii_exposure")).toBe(false)
  })

  test("diff-scoped PII recall: a column core's classifier MISSED still surfaces via the broad fallback", async () => {
    // Regression guard: when core `classify_pii` returns NOTHING for an introduced
    // column (it missed it), that column must remain eligible for the broad
    // `schema.detect_pii` detector — it must not be silently dropped just because
    // the diff-scoped lane ran for the file.
    const files: ChangedFile[] = [{ path: "models/marts/dim_customers.sql", status: "modified", diff: "+    ssn\n" }]
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async detectPii() {
        return { columns: ["ssn"] }
      },
      async columnLineage(sql) {
        return sql.includes("ssn")
          ? [
              { source: "customers.customer_id", target: "customer_id" },
              { source: "customers.ssn", target: "ssn" },
            ]
          : [{ source: "customers.customer_id", target: "customer_id" }]
      },
      async classifyPii() {
        return []
      },
    }
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["pii_exposure"] },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: content("select customer_id, ssn from customers", "select customer_id from customers"),
    })
    const pii = env.findings.filter((f) => f.category === "pii_exposure")
    expect(pii).toHaveLength(1)
    expect(pii[0].evidence?.tool).toBe("schema.detect_pii")
    expect(env.verdict).toBe("REQUEST_CHANGES")
  })

  test("core-missed high-risk PII still caught by the regex twin when the broad PII lane is off", async () => {
    // Lower tiers (trivial/lite) run `dbt_patterns` but not `pii_exposure`. If core
    // classification ran but missed a high-risk column, the regex twin is the only
    // safety net — it must NOT be suppressed for a column core never classified.
    const files: ChangedFile[] = [{ path: "models/marts/dim_customers.sql", status: "modified", diff: "+    ssn\n" }]
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async detectPii() {
        return { columns: ["ssn"] }
      },
      async columnLineage(sql) {
        return sql.includes("ssn")
          ? [
              { source: "customers.customer_id", target: "customer_id" },
              { source: "customers.ssn", target: "ssn" },
            ]
          : [{ source: "customers.customer_id", target: "customer_id" }]
      },
      async classifyPii() {
        return []
      },
    }
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["dbt_patterns"] },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: content("select customer_id, ssn from customers", "select customer_id from customers"),
    })
    const pii = env.findings.filter((f) => f.category === "pii_exposure")
    expect(
      pii.some((f) => f.evidence?.tool === "dbt-patterns" && (f.evidence?.result as any)?.rule === "pii_into_mart"),
    ).toBe(true)
    expect(env.verdict).toBe("REQUEST_CHANGES")
  })

  test("zero-target lineage does not mark the file PII-complete, so the regex twin survives", async () => {
    // Regression guard: when `columnLineage` RESOLVES but yields no output targets
    // (the parser couldn't derive columns — uncertainty, not "no new PII"), the
    // diff-scoped lane must not flag the file as completed. Otherwise the file
    // enters the PII-completed/classified sets and a deterministic regex twin could
    // be suppressed for a column core never actually classified.
    const files: ChangedFile[] = [{ path: "models/marts/dim_customers.sql", status: "modified", diff: "+    ssn\n" }]
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async detectPii() {
        return { columns: ["ssn"] }
      },
      async columnLineage() {
        // Lineage resolves but derives zero output columns for every input.
        return []
      },
      async classifyPii() {
        return []
      },
    }
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["dbt_patterns"] },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: content("select customer_id, ssn from customers", "select customer_id from customers"),
    })
    const pii = env.findings.filter((f) => f.category === "pii_exposure")
    expect(
      pii.some((f) => f.evidence?.tool === "dbt-patterns" && (f.evidence?.result as any)?.rule === "pii_into_mart"),
    ).toBe(true)
    expect(env.verdict).toBe("REQUEST_CHANGES")
  })

  test("core considered the matched column (muted as low-confidence) → the regex twin is suppressed", async () => {
    // Inverse of the recall guards above: suppression must be COLUMN-aware, not
    // merely "the classifier ran". Here core's `classify_pii` DID consider `ssn`
    // but muted it (confidence below threshold → no diff-scoped finding). Because
    // the column was considered, the coarse `pii_into_mart` regex twin for the
    // same column is redundant and must be suppressed — otherwise the same column
    // is double-reported. This exercises the token-gated suppression branch
    // (`classifiedPiiColumnsByFile.has(token)`), distinct from the "never
    // classified → twin survives" path.
    const files: ChangedFile[] = [{ path: "models/marts/dim_customers.sql", status: "modified", diff: "+    ssn\n" }]
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async detectPii() {
        return { columns: ["ssn"] }
      },
      async columnLineage(sql) {
        return sql.includes("ssn")
          ? [
              { source: "customers.customer_id", target: "customer_id" },
              { source: "customers.ssn", target: "ssn" },
            ]
          : [{ source: "customers.customer_id", target: "customer_id" }]
      },
      async classifyPii() {
        // Considered `ssn` but is not confident → muted, no diff-scoped finding,
        // yet `ssn` still lands in the classified-columns set.
        return [{ column: "ssn", classification: "SSN", confidence: 0.1 }]
      },
    }
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["dbt_patterns"] },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: content("select customer_id, ssn from customers", "select customer_id from customers"),
    })
    const piiIntoMart = env.findings.filter(
      (f) => f.evidence?.tool === "dbt-patterns" && (f.evidence?.result as any)?.rule === "pii_into_mart",
    )
    expect(piiIntoMart).toHaveLength(0)
  })

  test("structural error severity blocks only for join_risk; other rules stay advisory", async () => {
    // SC003 group_by_change is `semantic_change`, not `join_risk`. Even at core
    // `severity: "error"` it must NOT be escalated to critical — only join-key
    // regressions are allowed to hard-block.
    const oldSql = "select g, sum(x) as x from t group by g"
    const newSql = "select g, h, sum(x) as x from t group by g, h"
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async structuralDiff() {
        return [{ code: "SC003", rule: "group_by_change", severity: "error", message: "grain changed" }]
      },
    }
    const env = await runReview({
      changedFiles: [{ path: "models/marts/fct_orders.sql", status: "modified", diff: "+group by g, h\n" }],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["semantic_change"], ai: false },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: async (_f, side) => (side === "new" ? newSql : oldSql),
      getCompiled: async (_f, side) => (side === "new" ? newSql : oldSql),
      generatedAt: "2026-06-08T00:00:00Z",
    })
    const f = env.findings.find(
      (x) => x.evidence?.tool === "altimate_core.structural_diff" && (x.evidence?.result as any)?.code === "SC003",
    )
    expect(f).toBeDefined()
    expect(f!.severity).toBe("warning")
    expect(f!.category).toBe("semantic_change")
  })

  test("join_key_regression below error severity stays advisory (warning, not critical)", async () => {
    const oldSql = "select * from orders left join customers on orders.customer_id = customers.customer_id"
    const newSql = "select * from orders left join customers on orders.order_id = customers.customer_id"
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async structuralDiff() {
        return [{ code: "SC010", rule: "join_key_regression", severity: "warning", message: "join key changed" }]
      },
    }
    const env = await runReview({
      changedFiles: [
        {
          path: "models/marts/fct_customer_orders.sql",
          status: "modified",
          diff: "+on orders.order_id = customers.customer_id\n",
        },
      ],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["semantic_change"], ai: false },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner,
      getContent: async (_f, side) => (side === "new" ? newSql : oldSql),
      getCompiled: async (_f, side) => (side === "new" ? newSql : oldSql),
      generatedAt: "2026-06-08T00:00:00Z",
    })
    const f = env.findings.find(
      (x) => x.evidence?.tool === "altimate_core.structural_diff" && (x.evidence?.result as any)?.code === "SC010",
    )
    expect(f).toBeDefined()
    expect(f!.severity).toBe("warning")
    expect(f!.category).toBe("join_risk")
  })

  test("clean change with no manifest → degraded, APPROVE/COMMENT, lint-only labeled", async () => {
    const files: ChangedFile[] = [{ path: "models/staging/stg_x.sql", status: "modified", diff: "+select 1\n" }]
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async impact() {
        return { hasManifest: false, severity: "UNKNOWN", directCount: 0, transitiveCount: 0, testCount: 0 }
      },
    }
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      getContent: content("select 1"),
    })
    expect(env.summary.degraded).toBe(true)
    expect(["APPROVE", "COMMENT"]).toContain(env.verdict)
  })

  test("loaded manifest is not marked lint-only when a changed model is absent from it", async () => {
    const files: ChangedFile[] = [{ path: "models/staging/new_model.sql", status: "added", diff: "+select 1\n" }]
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async manifestAvailable() {
        return true
      },
      async impact() {
        return { hasManifest: false, severity: "UNKNOWN", directCount: 0, transitiveCount: 0, testCount: 0 }
      },
    }
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["sql_quality"] },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      getContent: content("select 1 as value"),
    })
    expect(env.summary.degraded).toBe(false)
  })

  test("manifest availability errors degrade safely instead of aborting the review", async () => {
    const files: ChangedFile[] = [{ path: "models/staging/stg_x.sql", status: "modified", diff: "+select 1\n" }]
    const runner: ReviewRunner = {
      ...fakeRunner({}),
      async manifestAvailable() {
        throw new Error("manifest unreadable")
      },
      async impact() {
        return { hasManifest: false, severity: "UNKNOWN", directCount: 0, transitiveCount: 0, testCount: 0 }
      },
    }
    const env = await runReview({
      changedFiles: files,
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["sql_quality"] },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      getContent: content("select 1 as value"),
    })
    expect(env.summary.degraded).toBe(true)
  })

  test("renderSummary + inlineComments produce marker + structured output", async () => {
    const env = buildEnvelope({
      findings: [
        makeFinding({
          severity: "warning",
          category: "sql_quality",
          title: "issue",
          body: "body",
          file: "models/x.sql",
          startLine: 5,
          ruleKey: "r",
        }),
      ],
      tier: "lite",
      mode: "comment",
      generatedAt: "2026-05-29T00:00:00Z",
    })
    const summary = renderSummary(env)
    expect(summary).toContain("altimate-code-review")
    expect(summary).toContain("Reviewed with comments")
    const inline = inlineComments(env)
    expect(inline.length).toBe(1)
    expect(inline[0]).toMatchObject({ path: "models/x.sql", line: 5, side: "RIGHT" })
  })
})
