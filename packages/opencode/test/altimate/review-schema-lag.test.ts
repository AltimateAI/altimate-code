// altimate_change start — the schema_lag review lane
import { describe, test, expect } from "bun:test"
import {
  DEFAULT_REVIEW_CONFIG,
  DEFAULT_RUBRIC,
  parseReviewConfig,
  runReview,
  type ChangedFile,
  type ReviewRunner,
} from "../../src/altimate/review"
import { TIER_LANES } from "../../src/altimate/review/risk-tier"

const BASE = "select customer_key, balance_status from stg"
const HEAD = "select customer_key, balance_status, account_balance >= 9000 as is_priority from stg"

function runner(calls: unknown[], cols: Record<string, string[]>): ReviewRunner {
  return {
    async impact() {
      return { hasManifest: true, severity: "SAFE", directCount: 1, transitiveCount: 0, testCount: 0 }
    },
    async grade() {
      return { grade: "B" }
    },
    async check() {
      return { issues: [] }
    },
    async equivalence() {
      return { decided: false }
    },
    async detectPii() {
      return { columns: [] }
    },
    async columnLineage(sql: string) {
      return (cols[sql] ?? []).map((c) => ({ source: `stg.${c}`, target: c }))
    },
    async schemaLag(change) {
      calls.push(change)
      return {
        findings: [
          {
            reason: "schema_lag:cross_job",
            verdict: "breaking",
            consumer: "status_report",
            column: "is_priority",
            producer: "account_status",
            consumer_jobs: ["hourly"],
            producer_jobs: ["nightly"],
            message: "`status_report` in `hourly` reads `account_status.is_priority`, which only `nightly` rebuilds",
            fix: "build `account_status` in `hourly` too (`+` parent selection: `+status_report`)",
          },
        ],
        skipped: [],
      }
    },
  } as ReviewRunner
}

const files = (diff = ""): ChangedFile[] => [{ path: "models/account_status.sql", status: "modified", diff }]
const content = (oldSql: string, newSql: string) => async (_f: string, side: "old" | "new") => (side === "new" ? newSql : oldSql)

async function review(r: ReviewRunner, changed: ChangedFile[], oldSql: string, newSql: string) {
  return runReview({
    changedFiles: changed,
    config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["schema_lag"] },
    rubric: DEFAULT_RUBRIC,
    mode: "comment",
    runner: r,
    getContent: content(oldSql, newSql),
    generatedAt: "2026-10-15T00:00:00Z",
  })
}

describe("schema_lag review lane", () => {
  test("runs in the lite and full tiers", () => {
    expect(TIER_LANES.lite).toContain("schema_lag")
    expect(TIER_LANES.full).toContain("schema_lag")
    expect(TIER_LANES.trivial).not.toContain("schema_lag")
  })

  test("an added output column read by another job is a critical finding with the fix", async () => {
    const calls: unknown[] = []
    const env = await review(
      runner(calls, { [BASE]: ["customer_key", "balance_status"], [HEAD]: ["customer_key", "balance_status", "is_priority"] }),
      files(),
      BASE,
      HEAD,
    )
    expect(calls).toEqual([{ model: "account_status", kind: "sql", base_sql: BASE, head_sql: HEAD }])
    const f = env.findings.find((x) => x.title.startsWith("schema_lag:cross_job"))
    expect(f).toBeDefined()
    expect(f!.severity).toBe("critical")
    expect(f!.category).toBe("lineage_breakage")
    expect(f!.column).toBe("is_priority")
    expect(f!.body).toContain("Suggested fix: build `account_status` in `hourly` too")
  })

  test("not triggered when output columns are unchanged and no source YAML changed", async () => {
    const calls: unknown[] = []
    const other = "select customer_key, upper(balance_status) as balance_status from stg"
    const env = await review(
      runner(calls, { [BASE]: ["customer_key", "balance_status"], [other]: ["customer_key", "balance_status"] }),
      files(),
      BASE,
      other,
    )
    expect(calls).toEqual([])
    expect(env.findings.some((x) => x.title.startsWith("schema_lag"))).toBe(false)
  })

  test("a changed source YAML column declaration triggers it even with the same output columns", async () => {
    const calls: unknown[] = []
    const other = "select customer_key, balance_status from stg where launch_channel is not null"
    await review(
      runner(calls, { [BASE]: ["customer_key", "balance_status"], [other]: ["customer_key", "balance_status"] }),
      [
        ...files(),
        { path: "models/_sources.yml", status: "modified", diff: "@@ -1 +1,2 @@\n+          - {name: launch_channel, data_type: varchar}\n" },
      ],
      BASE,
      other,
    )
    expect(calls).toHaveLength(1)
  })

  test("review config accepts a schemaLag job map", () => {
    const c = parseReviewConfig("schemaLag:\n  jobsFrom: selectors\n")
    expect(c.schemaLag).toEqual({ jobs: "", jobsFrom: "selectors" })
    expect(parseReviewConfig("{}").schemaLag).toBeUndefined()
  })
})
// altimate_change end
