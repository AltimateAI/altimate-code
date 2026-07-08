import { describe, test, expect } from "bun:test"
import {
  buildEnvelope,
  DEFAULT_REVIEW_CONFIG,
  DEFAULT_RUBRIC,
  makeFinding,
  filterToSpecDerived,
  isBlockEligible,
  renderSummary,
  runReview,
  type ChangedFile,
  type SpecSource,
  type GeneratedTest,
  type ReviewRunner,
} from "../../src/altimate/review"

// A declared-constraint source (track A) and an inferred-context source (track B).
const declared: SpecSource = {
  origin: "declared_constraint",
  kind: "not_null",
  ref: "schema.yml:dim_customer.email",
  text: "not_null",
}
const inferred: SpecSource = {
  origin: "inferred_context",
  kind: "schema_desc",
  ref: "desc:dim_customer.discount_pct",
  text: "discount percentage 0-100",
}
const providedSources = [declared, inferred]

function mkTest(over: Partial<GeneratedTest> & { derivedFrom?: GeneratedTest["derivedFrom"] }): GeneratedTest {
  return {
    id: over.id ?? "t1",
    kind: over.kind ?? "not_null",
    rationale: "because",
    derivedFrom: over.derivedFrom ?? declared,
    ...over,
  }
}

describe("filterToSpecDerived (advisory-track anti-fabrication guard)", () => {
  test("keeps a proposal citing a provided source ref", () => {
    const { kept, dropped } = filterToSpecDerived([mkTest({ derivedFrom: declared })], providedSources)
    expect(kept.length).toBe(1)
    expect(dropped.length).toBe(0)
  })

  test("replaces a proposal's derivedFrom with the trusted provided source", () => {
    const forged: SpecSource = { ...declared, origin: "inferred_context", kind: "schema_desc" }
    const { kept, dropped } = filterToSpecDerived([mkTest({ derivedFrom: forged })], providedSources)
    expect(dropped.length).toBe(0)
    expect(kept[0]?.derivedFrom).toEqual(declared)
  })

  test("drops a proposal with no derivedFrom", () => {
    const t = mkTest({})
    // @ts-expect-error deliberately null out the required field to simulate a bad LLM item
    t.derivedFrom = undefined
    const { kept, dropped } = filterToSpecDerived([t], providedSources)
    expect(kept.length).toBe(0)
    expect(dropped[0]?.reason).toBe("no_derived_from")
  })

  test("drops a FABRICATED ref the model invented (not in provided sources)", () => {
    const fabricated: SpecSource = { origin: "declared_constraint", kind: "not_null", ref: "schema.yml:dim_customer.HALLUCINATED" }
    const { kept, dropped } = filterToSpecDerived([mkTest({ derivedFrom: fabricated })], providedSources)
    expect(kept.length).toBe(0)
    expect(dropped[0]?.reason).toBe("ref_not_provided")
  })

  test("drops a disallowed kind", () => {
    const t = mkTest({ derivedFrom: declared })
    // @ts-expect-error out-of-enum kind from a malformed LLM item
    t.kind = "golden_snapshot"
    const { kept, dropped } = filterToSpecDerived([t], providedSources)
    expect(kept.length).toBe(0)
    expect(dropped[0]?.reason).toBe("kind_not_allowed")
  })

  test("drops an empty ref", () => {
    const empty: SpecSource = { origin: "inferred_context", kind: "schema_desc", ref: "  " }
    const { kept, dropped } = filterToSpecDerived([mkTest({ derivedFrom: empty })], providedSources)
    expect(kept.length).toBe(0)
    expect(dropped[0]?.reason).toBe("empty_ref")
  })

  test("drops a proposal whose dbtTest macro does not match kind", () => {
    const t = mkTest({
      kind: "not_null",
      dbtTest: { column: "email", test: "dbt_utils.expression_is_true" },
      derivedFrom: declared,
    })
    const { kept, dropped } = filterToSpecDerived([t], providedSources)
    expect(kept.length).toBe(0)
    expect(dropped[0]?.reason).toBe("test_mismatch")
  })
})

describe("isBlockEligible (only track-A declared constraints can block)", () => {
  test("declared_constraint + declared kind → block-eligible", () => {
    expect(isBlockEligible(mkTest({ derivedFrom: declared, kind: "not_null" }))).toBe(true)
  })

  test("inferred_context → never block-eligible, even with a declared-style kind", () => {
    const backLabeled: SpecSource = { origin: "inferred_context", kind: "not_null", ref: "desc:x" }
    expect(isBlockEligible(mkTest({ derivedFrom: backLabeled, kind: "not_null" }))).toBe(false)
  })

  test("range proposal → never block-eligible", () => {
    expect(isBlockEligible(mkTest({ derivedFrom: inferred, kind: "range" }))).toBe(false)
  })
})

function fakeRunner(): ReviewRunner {
  return {
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
      return { decided: false }
    },
    async detectPii() {
      return { columns: [] }
    },
  } as ReviewRunner
}

const modelSql = "select order_id, status from {{ ref('stg_orders') }}"
const schemaYaml = `
version: 2
models:
  - name: fct_orders
    description: Orders fact model for fulfilled order reporting.
    columns:
      - name: order_id
        description: Stable order identifier.
        tests:
          - not_null
      - name: status
        description: Fulfillment state.
        tests:
          - accepted_values:
              values: [placed, shipped]
`

function content(files: Record<string, string>) {
  return async (file: string, side: "old" | "new") => (side === "new" ? files[file] : undefined)
}

const changedFiles: ChangedFile[] = [
  { path: "models/marts/fct_orders.sql", status: "added", diff: "+select ...\n" },
  { path: "models/marts/schema.yml", status: "added", diff: "+models:\n" },
]

function proposedFrom(source: SpecSource, over: Partial<GeneratedTest> = {}): GeneratedTest {
  return {
    id: "fake-" + source.ref,
    kind: "not_null",
    dbtTest: { column: "order_id", test: "not_null" },
    rationale: "The schema declares this expectation.",
    derivedFrom: source,
    ...over,
  }
}

describe("spec test synthesis lane (P0 propose-only)", () => {
  test("an ADDED model yields suggestion proposed-test findings", async () => {
    const env = await runReview({
      changedFiles,
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["spec_tests"], ai: false },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner: fakeRunner(),
      getContent: content({
        "models/marts/fct_orders.sql": modelSql,
        "models/marts/schema.yml": schemaYaml,
      }),
      generateSpecTests: async (input) => {
        const source = input.specSources.find((s) => s.ref === "schema.yml:fct_orders.order_id:not_null")
        return source ? [proposedFrom(source)] : []
      },
    })

    const findings = env.findings.filter((f) => f.evidence?.tool === "altimate.spec_test.proposed")
    expect(findings.length).toBe(1)
    expect(findings[0]).toMatchObject({
      severity: "suggestion",
      confidence: "unknown",
      category: "test_coverage",
    })
    expect(findings[0].body).toContain("```yaml")
    expect(findings[0].body).toContain("not_null")
    const summary = renderSummary(env)
    expect(summary).toContain("### Proposed tests")
    expect(summary).toContain("Candidate tests to consider adding")
  })

  test("proposed findings never request changes in comment or gate mode", async () => {
    for (const mode of ["comment", "gate"] as const) {
      const env = await runReview({
        changedFiles,
        config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["spec_tests"], ai: false, mode },
        rubric: DEFAULT_RUBRIC,
        mode,
        runner: fakeRunner(),
        getContent: content({
          "models/marts/fct_orders.sql": modelSql,
          "models/marts/schema.yml": schemaYaml,
        }),
        generateSpecTests: async (input) =>
          input.specSources.slice(0, 4).map((source, i) =>
            proposedFrom(source, {
              id: `fake-${i}`,
              dbtTest: { column: i % 2 === 0 ? "order_id" : "status", test: i % 2 === 0 ? "not_null" : "accepted_values" },
              kind: i % 2 === 0 ? "not_null" : "accepted_values",
            }),
          ),
      })
      expect(env.findings.filter((f) => f.evidence?.tool === "altimate.spec_test.proposed").length).toBeGreaterThan(1)
      expect(env.idealVerdict).toBe("COMMENT")
      expect(env.verdict).toBe("COMMENT")
    }
  })

  test("two proposals from the same ref and column but different kind both survive dedupe", async () => {
    const schemaForCollision = `
version: 2
models:
  - name: fct_orders
    columns:
      - name: order_id
        description: Stable order identifier.
`
    const env = await runReview({
      changedFiles,
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["spec_tests"], ai: false },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner: fakeRunner(),
      getContent: content({
        "models/marts/fct_orders.sql": modelSql,
        "models/marts/schema.yml": schemaForCollision,
      }),
      generateSpecTests: async (input) => {
        const source = input.specSources.find((s) => s.ref === "schema.yml:fct_orders.order_id:description")
        return source
          ? [
              proposedFrom(source, {
                id: "same-ref-not-null",
                kind: "not_null",
                dbtTest: { column: "order_id", test: "not_null" },
              }),
              proposedFrom(source, {
                id: "same-ref-accepted-values",
                kind: "accepted_values",
                dbtTest: { column: "order_id", test: "accepted_values", args: { values: ["placed"] } },
              }),
            ]
          : []
      },
    })

    const findings = env.findings.filter((f) => f.evidence?.tool === "altimate.spec_test.proposed")
    expect(findings.map((f) => f.title).sort()).toEqual([
      "fct_orders: proposed accepted_values test for order_id",
      "fct_orders: proposed not_null test for order_id",
    ])
  })

  test("fabricated-ref proposals are dropped", async () => {
    const env = await runReview({
      changedFiles,
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["spec_tests"], ai: false },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner: fakeRunner(),
      getContent: content({
        "models/marts/fct_orders.sql": modelSql,
        "models/marts/schema.yml": schemaYaml,
      }),
      generateSpecTests: async () => [
        proposedFrom({
          origin: "declared_constraint",
          kind: "not_null",
          ref: "schema.yml:fct_orders.fabricated:not_null",
          text: "not_null",
        }),
      ],
    })

    expect(env.findings.some((f) => f.evidence?.tool === "altimate.spec_test.proposed")).toBe(false)
  })

  test("does not emit schema description sources for columns already declaring enforcing tests", async () => {
    let refs: string[] = []
    await runReview({
      changedFiles,
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["spec_tests"], ai: false },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner: fakeRunner(),
      getContent: content({
        "models/marts/fct_orders.sql": modelSql,
        "models/marts/schema.yml": schemaYaml,
      }),
      generateSpecTests: async (input) => {
        refs = input.specSources.map((s) => s.ref)
        return []
      },
    })

    expect(refs).toContain("schema.yml:fct_orders.order_id:not_null")
    expect(refs).not.toContain("schema.yml:fct_orders.order_id:description")
    expect(refs).toContain("schema.yml:fct_orders.status:accepted_values")
    expect(refs).not.toContain("schema.yml:fct_orders.status:description")
  })

  test("a MODIFIED-only PR yields no spec-test findings", async () => {
    let calls = 0
    const env = await runReview({
      changedFiles: [{ path: "models/marts/fct_orders.sql", status: "modified", diff: "+select ...\n" }],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["spec_tests"], ai: false },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner: fakeRunner(),
      getContent: content({ "models/marts/fct_orders.sql": modelSql }),
      generateSpecTests: async () => {
        calls++
        return []
      },
    })

    expect(calls).toBe(0)
    expect(env.findings.some((f) => f.evidence?.tool === "altimate.spec_test.proposed")).toBe(false)
  })
})

describe("proposed test summary patch", () => {
  test("uses trusted evidence YAML and ignores YAML injected into the finding body", () => {
    const trustedYaml = `
version: 2
models:
  - name: fct_orders
    columns:
      - name: trusted_col
        tests:
          - not_null
`
    const injectedBody = [
      "Candidate dbt test to consider adding.",
      "",
      "```yaml",
      "version: 2",
      "models:",
      "  - name: fct_orders",
      "    columns:",
      "      - name: pwned_col",
      "        tests:",
      "          - unique",
      "```",
    ].join("\n")
    const finding = makeFinding({
      severity: "suggestion",
      category: "test_coverage",
      title: "fct_orders: proposed not_null test for trusted_col",
      body: injectedBody,
      file: "models/marts/fct_orders.sql",
      model: "fct_orders",
      column: "trusted_col",
      confidence: "unknown",
      evidence: {
        tool: "altimate.spec_test.proposed",
        result: { proposal: { derivedFrom: { ref: "schema.yml:fct_orders.trusted_col:description" } }, yaml: trustedYaml },
      },
      ruleKey: "spec_test:schema.yml:fct_orders.trusted_col:description:not_null:trusted_col",
    })
    const summary = renderSummary(
      buildEnvelope({
        findings: [finding],
        tier: "lite",
        mode: "comment",
        rubric: DEFAULT_RUBRIC,
      }),
    )

    expect(summary).toContain("trusted_col")
    expect(summary).not.toContain("pwned_col")
  })
})
