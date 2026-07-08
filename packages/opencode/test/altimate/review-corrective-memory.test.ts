import { describe, expect, test } from "bun:test"
import {
  DEFAULT_REVIEW_CONFIG,
  DEFAULT_RUBRIC,
  getMemory,
  makeFinding,
  runReview,
  type ChangedFile,
  type GeneratedTest,
  type MemoryEntry,
  type ReviewRunner,
  type SpecSource,
} from "../../src/altimate/review"

const PROJECT = "analytics"

function memoryEntry(
  id: string,
  scope: MemoryEntry["scope"],
  polarity: MemoryEntry["polarity"] = "suppress",
  supportCount = 1,
): MemoryEntry {
  return {
    id,
    scope,
    directive: `${polarity} ${id}`,
    polarity,
    provenance: { source: "human_rule", committed: true, supportCount },
  }
}

function fakeRunner(overrides: Partial<ReviewRunner> = {}): ReviewRunner {
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

function content(files: Record<string, string>) {
  return async (file: string, side: "old" | "new") => (side === "new" ? files[file] : undefined)
}

function proposedFrom(source: SpecSource, over: Partial<GeneratedTest> = {}): GeneratedTest {
  return {
    id: `test-${over.kind ?? "not_null"}-${source.ref}`,
    kind: "not_null",
    dbtTest: { column: "discount_pct", test: "not_null" },
    rationale: "grounded proposal",
    derivedFrom: source,
    ...over,
  }
}

describe("getMemory", () => {
  test("wildcard scope matches a specific query", () => {
    const entries = [memoryEntry("wild", { project: PROJECT, category: "test_coverage", column: "*" })]

    expect(getMemory(entries, { project: PROJECT, category: "test_coverage", column: "discount_pct" }).map((e) => e.id)).toEqual([
      "wild",
    ])
  })

  test("column-specific entry beats a modelLayer-wide entry", () => {
    const entries = [
      memoryEntry("layer", { project: PROJECT, modelLayer: "marts", category: "test_coverage" }, "prefer", 10),
      memoryEntry("column", { project: PROJECT, modelLayer: "marts", category: "test_coverage", column: "discount_pct" }, "suppress"),
    ]

    const result = getMemory(entries, {
      project: PROJECT,
      modelLayer: "marts",
      table: "fct_orders",
      column: "discount_pct",
      category: "test_coverage",
    })

    expect(result.map((e) => e.id)).toEqual(["column"])
  })

  test("different project never matches", () => {
    const entries = [memoryEntry("other", { project: "other", derivedFromKind: "range" })]

    expect(getMemory(entries, { project: PROJECT, derivedFromKind: "range" })).toEqual([])
  })
})

describe("corrective memory consumers", () => {
  const modelFile: ChangedFile = { path: "models/marts/fct_orders.sql", status: "added", diff: "+select ...\n" }
  const modelSql = "select order_id, discount_pct from {{ ref('stg_orders') }}"
  const schemaYaml = `
version: 2
models:
  - name: fct_orders
    columns:
      - name: discount_pct
        description: Discount percentage from 0 to 100.
`

  test("derivedFromKind suppress drops matching track-B proposals, keeps others, and leaves track-A materialization intact", async () => {
    const suppressRange = memoryEntry("suppress-range", { project: PROJECT, derivedFromKind: "range" })
    let priors: Array<{ derivedFromKind: string; polarity: "prefer" | "suppress" }> | undefined

    const env = await runReview({
      project: PROJECT,
      changedFiles: [modelFile, { path: "models/marts/schema.yml", status: "added", diff: "+models:\n" }],
      config: {
        ...DEFAULT_REVIEW_CONFIG,
        reviewers: ["spec_tests"],
        ai: false,
        memory: { entries: [suppressRange] },
      },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner: fakeRunner({
        async declaredConstraints() {
          return [
            {
              kind: "not_null",
              column: "order_id",
              hasEnforcingTest: false,
              sourceRef: "schema.yml:fct_orders.order_id:not_null",
            },
          ]
        },
      }),
      getContent: content({
        "models/marts/fct_orders.sql": modelSql,
        "models/marts/schema.yml": schemaYaml,
      }),
      generateSpecTests: async (input) => {
        priors = input.priors
        const source = input.specSources.find((s) => s.ref === "schema.yml:fct_orders.discount_pct:description")
        return source
          ? [
              proposedFrom(source, {
                id: "range",
                kind: "range",
                dbtTest: { column: "discount_pct", test: "range", args: { min: 0, max: 100 } },
              }),
              proposedFrom(source, { id: "not-null", kind: "not_null" }),
            ]
          : []
      },
    })

    expect(priors).toEqual([{ derivedFromKind: "range", polarity: "suppress" }])
    const titles = env.findings.map((f) => f.title).sort()
    expect(titles).toContain("fct_orders: proposed not_null test for order_id")
    expect(titles).toContain("fct_orders: proposed not_null test for discount_pct")
    expect(titles.some((title) => title.includes("range"))).toBe(false)
  })

  test("category/model suppress entry drops an advisory finding in the post-filter", async () => {
    const suppressCoverage = memoryEntry("suppress-coverage", {
      project: PROJECT,
      category: "test_coverage",
      table: "fct_orders",
    })

    const env = await runReview({
      project: PROJECT,
      changedFiles: [modelFile],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["ai_review"], memory: { entries: [suppressCoverage] } },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner: fakeRunner(),
      getContent: content({ "models/marts/fct_orders.sql": modelSql }),
      aiReview: async () => [
        makeFinding({
          severity: "suggestion",
          category: "test_coverage",
          title: "fct_orders: add a baseline test",
          body: "advisory",
          file: "models/marts/fct_orders.sql",
          model: "fct_orders",
          confidence: "unknown",
          evidence: { tool: "ai-review", result: {} },
          ruleKey: "ai:test-coverage",
        }),
      ],
    })

    expect(env.findings).toEqual([])
  })

  test("suppress entries do not drop critical/executed findings or soften blocking verdicts", async () => {
    const suppressExecuted = memoryEntry("suppress-executed", {
      project: PROJECT,
      category: "contract_violation",
      table: "fct_orders",
      column: "order_id",
    })

    const executedEnv = await runReview({
      project: PROJECT,
      changedFiles: [modelFile],
      config: {
        ...DEFAULT_REVIEW_CONFIG,
        reviewers: ["spec_tests"],
        ai: false,
        mode: "gate",
        specTests: { execute: true },
        memory: { entries: [suppressExecuted] },
      },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner: fakeRunner({
        async declaredConstraints() {
          return [
            {
              kind: "not_null",
              column: "order_id",
              hasEnforcingTest: false,
              sourceRef: "schema.yml:fct_orders.order_id:not_null",
            },
          ]
        },
        async runGeneratedTests(tests) {
          return Object.fromEntries(tests.map((test) => [test.id, { status: "fail" as const, violatingRows: 2 }]))
        },
      }),
      getContent: content({ "models/marts/fct_orders.sql": modelSql }),
    })

    expect(executedEnv.findings.map((f) => f.evidence?.tool)).toEqual(["altimate.spec_test.executed"])
    expect(executedEnv.verdict).toBe("REQUEST_CHANGES")

    const suppressSqlQuality = memoryEntry("suppress-sql-quality", {
      project: PROJECT,
      category: "sql_quality",
      table: "*",
    })
    const warningFiles: ChangedFile[] = ["a", "b", "c"].map((name) => ({
      path: `models/marts/${name}.sql`,
      status: "added" as const,
      diff: "+select ...\n",
    }))

    const warningEnv = await runReview({
      project: PROJECT,
      changedFiles: warningFiles,
      config: {
        ...DEFAULT_REVIEW_CONFIG,
        reviewers: ["sql_quality"],
        ai: false,
        mode: "gate",
        memory: { entries: [suppressSqlQuality] },
      },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner: fakeRunner({
        async check() {
          return {
            ran: true,
            issues: [{ rule: "risky_sql", message: "countable deterministic warning", severity: "error", category: "sql_quality" }],
          }
        },
      }),
      getContent: content({
        "models/marts/a.sql": "select 1",
        "models/marts/b.sql": "select 1",
        "models/marts/c.sql": "select 1",
      }),
    })

    expect(warningEnv.findings).toHaveLength(3)
    expect(warningEnv.verdict).toBe("REQUEST_CHANGES")
  })
})
