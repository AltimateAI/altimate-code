import { describe, test, expect } from "bun:test"
import {
  DEFAULT_REVIEW_CONFIG,
  DEFAULT_RUBRIC,
  runReview,
  type ChangedFile,
  type DeclaredConstraint,
  type GeneratedTest,
  type ReviewRunner,
} from "../../src/altimate/review"

const changedFiles: ChangedFile[] = [
  { path: "models/marts/fct_orders.sql", status: "added", diff: "+select order_id from {{ ref('stg_orders') }}\n" },
]

function baseRunner(overrides: Partial<ReviewRunner> = {}): ReviewRunner {
  return {
    async impact() {
      return { hasManifest: true, severity: "SAFE", directCount: 0, transitiveCount: 0, testCount: 0 }
    },
    async grade() {
      return { grade: "A" }
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
    ...overrides,
  } as ReviewRunner
}

function declared(overrides: Partial<DeclaredConstraint> = {}): DeclaredConstraint {
  return {
    kind: "not_null",
    column: "order_id",
    hasEnforcingTest: false,
    sourceRef: "schema.yml:fct_orders.order_id:not_null",
    ...overrides,
  }
}

async function reviewWith(runner: ReviewRunner, execute: boolean, generateSpecTests?: () => Promise<GeneratedTest[]>) {
  return runReview({
    changedFiles,
    config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["spec_tests"], ai: false, specTests: { execute }, mode: "gate" },
    rubric: DEFAULT_RUBRIC,
    mode: "gate",
    runner,
    getContent: async (file, side) =>
      side === "new" && file.endsWith(".sql") ? "select order_id from {{ ref('stg_orders') }}" : undefined,
    generateSpecTests,
  })
}

describe("spec test synthesis lane (P1 declared-constraint execution)", () => {
  test("failed executed declared not_null emits blocking critical contract_violation", async () => {
    const env = await reviewWith(
      baseRunner({
        async declaredConstraints() {
          return [declared()]
        },
        async runGeneratedTests(tests) {
          return { [tests[0]!.id]: { status: "fail", violatingRows: 2 } }
        },
      }),
      true,
    )

    const finding = env.findings.find((f) => f.evidence?.tool === "altimate.spec_test.executed")
    expect(finding).toBeTruthy()
    expect(finding).toMatchObject({
      severity: "critical",
      category: "contract_violation",
      confidence: "high",
    })
    expect(finding?.evidence?.result).toMatchObject({
      executed: true,
      origin: "declared_constraint",
      violatingRows: 2,
    })
    expect((finding?.evidence?.result as any).test.derivedFrom.origin).toBe("declared_constraint")
    expect(env.verdict).toBe("REQUEST_CHANGES")
  })

  test("passed executed declared constraint emits no finding and records coverage", async () => {
    const env = await reviewWith(
      baseRunner({
        async declaredConstraints() {
          return [declared()]
        },
        async runGeneratedTests(tests) {
          return { [tests[0]!.id]: { status: "pass", violatingRows: 0 } }
        },
      }),
      true,
    )

    expect(env.findings.some((f) => f.evidence?.tool === "altimate.spec_test.executed")).toBe(false)
    expect(env.summary.enforcedConstraints).toEqual({ executed: 1, passed: 1, failed: 0 })
  })

  test("no warehouse falls back to proposed enforcing test and does not request changes", async () => {
    const env = await reviewWith(
      baseRunner({
        async declaredConstraints() {
          return [declared()]
        },
        async runGeneratedTests() {
          return null
        },
      }),
      true,
    )

    const proposed = env.findings.find((f) => f.evidence?.tool === "altimate.spec_test.proposed")
    expect(proposed).toMatchObject({ severity: "suggestion", confidence: "unknown", category: "test_coverage" })
    expect(env.verdict).not.toBe("REQUEST_CHANGES")
  })

  test("execute false never calls runGeneratedTests and proposes instead", async () => {
    let calls = 0
    const env = await reviewWith(
      baseRunner({
        async declaredConstraints() {
          return [declared()]
        },
        async runGeneratedTests() {
          calls++
          return {}
        },
      }),
      false,
    )

    expect(calls).toBe(0)
    expect(env.findings.some((f) => f.evidence?.tool === "altimate.spec_test.proposed")).toBe(true)
  })

  test("track-B executed failure emits non-blocking candidate warning", async () => {
    let calls = 0
    const env = await reviewWith(
      baseRunner({
        async declaredConstraints() {
          return []
        },
        async runGeneratedTests(tests) {
          calls++
          return { [tests[0]!.id]: { status: "fail", violatingRows: 4 } }
        },
      }),
      true,
      async () => [
        {
          id: "track-b",
          kind: "not_null",
          dbtTest: { column: "order_id", test: "not_null" },
          rationale: "soft intent",
          derivedFrom: {
            origin: "inferred_context",
            kind: "ref_edge",
            ref: "ref:stg_orders",
            text: "stg_orders",
          },
        },
      ],
    )

    expect(calls).toBe(1)
    const candidate = env.findings.find((f) => f.evidence?.tool === "altimate.spec_test.candidate")
    expect(candidate).toMatchObject({
      severity: "warning",
      confidence: "unknown",
      category: "test_coverage",
    })
    expect(candidate?.body).toContain("candidate test derived from `ref:stg_orders` fails on current data")
    expect(candidate?.evidence?.result).toMatchObject({
      executed: true,
      origin: "inferred_context",
      violatingRows: 4,
    })
    expect(env.findings.some((f) => f.severity === "critical")).toBe(false)
    expect(env.idealVerdict).not.toBe("REQUEST_CHANGES")
    expect(env.verdict).not.toBe("REQUEST_CHANGES")
  })

  test("track A runs with generateSpecTests undefined when declaredConstraints is available", async () => {
    let calls = 0
    let declaredCalls = 0
    const env = await reviewWith(
      baseRunner({
        async declaredConstraints() {
          declaredCalls++
          return [declared()]
        },
        async runGeneratedTests() {
          calls++
          return {}
        },
      }),
      false,
    )

    expect(declaredCalls).toBe(1)
    expect(calls).toBe(0)
    expect(env.findings.some((f) => f.evidence?.tool === "altimate.spec_test.proposed")).toBe(true)
  })

  test("already-enforced declared constraint is not materialized", async () => {
    let calls = 0
    const env = await reviewWith(
      baseRunner({
        async declaredConstraints() {
          return [declared({ hasEnforcingTest: true })]
        },
        async runGeneratedTests() {
          calls++
          return {}
        },
      }),
      true,
    )

    expect(calls).toBe(0)
    expect(env.findings.some((f) => f.evidence?.tool?.startsWith("altimate.spec_test"))).toBe(false)
  })

  test("declared column_type is kept out of generated tests", async () => {
    let calls = 0
    const env = await reviewWith(
      baseRunner({
        async declaredConstraints() {
          return [
            declared({
              kind: "column_type",
              column: "order_id",
              args: { data_type: "integer" },
              sourceRef: "schema.yml:fct_orders.order_id:column_type",
            }),
          ]
        },
        async runGeneratedTests() {
          calls++
          return {}
        },
      }),
      true,
    )

    expect(calls).toBe(0)
    expect(env.findings.some((f) => f.evidence?.tool?.startsWith("altimate.spec_test"))).toBe(false)
  })
})
