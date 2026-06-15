import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { runReview, DEFAULT_RUBRIC, DEFAULT_REVIEW_CONFIG, type ChangedFile } from "../../src/altimate/review"
import { createDispatcherRunner } from "../../src/altimate/review/runner"
import { registerAll } from "../../src/altimate/native/altimate-core"
import { tmpdir } from "../fixture/fixture"

// ---------------------------------------------------------------------------
// Full-stack E2E: dbt PR review pipeline → real Dispatcher → real altimate-core
// 0.5.1 engine. NO mocks. Exercises the complete chain that the dialect wiring
// (core 0.5.1 `dialect` arg) and `decidable` handling run through:
//
//   runReview → semanticChangeLane → runner.equivalence(old, new, dialect)
//             → Dispatcher → altimate_core.equivalence handler
//             → core.checkEquivalence(sqlA, sqlB, schema, dialect)
//
// A real dbt manifest supplies the schema so the engine can resolve columns and
// actually DECIDE equivalence rather than abstain.
// ---------------------------------------------------------------------------

describe("E2E: review pipeline + real engine equivalence (core 0.5.1)", () => {
  beforeAll(async () => {
    process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
    // The DispatcherRunner calls the REAL native handlers; register them in case
    // another file reset the Dispatcher.
    registerAll()
    const { registerAllSql } = await import("../../src/altimate/native/sql/register")
    registerAllSql()
  })
  afterAll(() => {
    delete process.env.ALTIMATE_TELEMETRY_DISABLED
  })

  // A real manifest with typed columns so resolveSchema() yields a usable schema.
  async function reviewerWithManifest() {
    const tmp = await tmpdir()
    const manifestPath = path.join(tmp.path, "manifest.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        metadata: { adapter_type: "snowflake" },
        nodes: {
          "model.demo.orders": {
            resource_type: "model",
            name: "orders",
            original_file_path: "models/marts/orders.sql",
            config: { materialized: "table" },
            depends_on: { nodes: [] },
            columns: {
              id: { name: "id", data_type: "integer" },
              amount: { name: "amount", data_type: "integer" },
              status: { name: "status", data_type: "varchar" },
            },
          },
        },
        sources: {},
      }),
    )
    return { tmp, runner: createDispatcherRunner({ manifestPath }) }
  }

  async function review(oldSql: string, newSql: string, dialect = "snowflake") {
    const { tmp, runner } = await reviewerWithManifest()
    try {
      const files: ChangedFile[] = [{ path: "models/marts/orders.sql", status: "modified", diff: "+changed" }]
      const env = await runReview({
        changedFiles: files,
        config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["semantic_change"], dialect, ai: false },
        rubric: DEFAULT_RUBRIC,
        mode: "comment",
        runner,
        getContent: async (_f, side) => (side === "new" ? newSql : oldSql),
        getCompiled: async (_f, side) => (side === "new" ? newSql : oldSql),
        generatedAt: "2026-06-10T00:00:00Z",
      })
      return env
    } finally {
      await tmp[Symbol.asyncDispose]?.()
    }
  }

  const eqFindings = (env: Awaited<ReturnType<typeof review>>) =>
    env.findings.filter((f) => f.evidence?.tool === "altimate_core.equivalence")

  test("real engine DECIDES a non-equivalent rewrite through the full pipeline", async () => {
    // `amount > 5` vs `amount > 6` is a genuine row-changing predicate change.
    const env = await review(
      "select id from orders where amount > 5",
      "select id from orders where amount > 6",
    )
    const findings = eqFindings(env)
    expect(findings.length).toBeGreaterThan(0)
    const f = findings[0]
    expect(f.category).toBe("semantic_change")
    expect((f.evidence?.result as any)?.equivalent).toBe(false)
    // The engine names the concrete predicate difference (not a vague abstention).
    const diffs = (f.evidence?.result as any)?.differences ?? []
    expect(diffs.length).toBeGreaterThan(0)
  })

  test("real engine PROVES an equivalent refactor → lane stays silent (no false positive)", async () => {
    // AND-conjunct reorder is provably equivalent; the reviewer must not nitpick it.
    const env = await review(
      "select id from orders where amount > 5 and status = 'x'",
      "select id from orders where status = 'x' and amount > 5",
    )
    expect(eqFindings(env)).toEqual([])
    expect(env.verdict).toBe("APPROVE")
  })

  test("identical compiled SQL → equivalence lane is skipped entirely", async () => {
    const sql = "select id from orders where amount > 5"
    const env = await review(sql, sql)
    expect(eqFindings(env)).toEqual([])
    expect(env.verdict).toBe("APPROVE")
  })

  test("column projection change (drop a column) is decided NOT equivalent", async () => {
    const env = await review(
      "select id, amount from orders",
      "select id from orders",
    )
    const findings = eqFindings(env)
    expect(findings.length).toBeGreaterThan(0)
    expect((findings[0].evidence?.result as any)?.equivalent).toBe(false)
  })

  test("DEFAULT config dialect (empty string) still DECIDES — no engine throw", async () => {
    // ReviewConfig.dialect defaults to "". The engine throws on an unknown dialect
    // "", so without coercion the lane would abstain on EVERY change under the
    // default config. This drives the full pipeline with dialect="" and asserts
    // the non-equivalent change is still caught (decided), proving the coercion.
    const env = await review(
      "select id from orders where amount > 5",
      "select id from orders where amount > 6",
      "", // <- default ReviewConfig.dialect
    )
    const findings = eqFindings(env)
    expect(findings.length).toBeGreaterThan(0)
    expect((findings[0].evidence?.result as any)?.equivalent).toBe(false)
  })
})
