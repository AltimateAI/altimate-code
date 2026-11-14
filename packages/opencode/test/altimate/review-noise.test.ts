import { describe, test, expect } from "bun:test"
import {
  anchorToDiff,
  commentableLines,
  isCatalogPortability,
  isSuppressiblePortability,
  runReview,
  type ReviewRunner,
} from "../../src/altimate/review/orchestrate"
import { DEFAULT_REVIEW_CONFIG } from "../../src/altimate/review/config"
import { DEFAULT_RUBRIC } from "../../src/altimate/review/rubric"
import { makeFinding, mergeRepeats, type Finding } from "../../src/altimate/review/finding"
import {
  findingMarker,
  inlineComments,
  postedFindingIds,
  renderSummary,
  SUMMARY_BUDGET_CHARS,
} from "../../src/altimate/review/format"
import { buildEnvelope } from "../../src/altimate/review/verdict"
import { evaluateCatalog } from "../../src/altimate/review/rule-catalog"
import { classifyPostOutcome } from "../../src/altimate/review/telemetry"

/**
 * The PR comment must stay readable: inline comments land on real lines of the
 * PR's file and are not re-posted on every push, a rule repeated across many
 * models is one bullet, the comment has a size budget, and cross-engine
 * portability advice is dropped for a single-engine project.
 */

function finding(over: Partial<Parameters<typeof makeFinding>[0]> = {}): Finding {
  return makeFinding({
    severity: "suggestion",
    category: "test_coverage",
    title: "m: new model has no uniqueness/grain test",
    body: "Add a unique or unique_combination_of_columns test.",
    file: "models/m.sql",
    model: "m",
    confidence: "high",
    evidence: { tool: "test-coverage", result: {} },
    ...over,
  })
}

const DIFF = [
  "diff --git a/models/m.sql b/models/m.sql",
  "--- a/models/m.sql",
  "+++ b/models/m.sql",
  "@@ -1,4 +1,5 @@",
  " select",
  "   id",
  "-  , old_col",
  "+  , new_col",
  "+  , other_col",
  "",
  " from src",
].join("\n")

describe("inline anchors", () => {
  test("commentable lines are the head-side added and context lines inside hunks", () => {
    // 1 select, 2 id, 3 new_col, 4 other_col, 5 blank context, 6 from src
    expect([...commentableLines(DIFF)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6])
    expect(commentableLines(undefined).size).toBe(0)
  })

  test("an added SQL line starting with `++` still counts; headers outside hunks do not", () => {
    const d = "--- a/x.sql\n+++ b/x.sql\n@@ -0,0 +1,2 @@\n+select 1\n++ 1 as weird\n"
    expect([...commentableLines(d)].sort()).toEqual([1, 2])
  })

  test("a line outside the diff moves to the summary instead of failing the batch", () => {
    const inDiff = finding({ startLine: 3, endLine: 3, title: "m: a" })
    const outside = finding({ startLine: 40, endLine: 40, title: "m: b" })
    const [a, b] = anchorToDiff([inDiff, outside], [{ path: "models/m.sql", status: "modified", diff: DIFF }])
    expect(a.startLine).toBe(3)
    expect(b.startLine).toBeUndefined()
    expect(b.endLine).toBeUndefined()
  })

  test("engine lint on compiled SQL never anchors to the raw file", async () => {
    const runner = {
      async impact() {
        return { hasManifest: true, severity: "SAFE", directCount: 0, transitiveCount: 0, testCount: 0 }
      },
      async grade() {
        return { grade: "B" }
      },
      async check() {
        return { issues: [{ rule: "select-star", message: "avoid select *", severity: "warning", line: 2 }], ran: true }
      },
      async equivalence() {
        return { decided: true, equivalent: true }
      },
      async detectPii() {
        return { columns: [] }
      },
    } as ReviewRunner
    const env = await runReview({
      changedFiles: [{ path: "models/m.sql", status: "added", diff: "@@ -0,0 +1,3 @@\n+{{ config() }}\n+select *\n+from {{ ref('a') }}\n" }],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["sql_quality"] },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      getContent: async () => "{{ config() }}\nselect *\nfrom {{ ref('a') }}\n",
      getCompiled: async () => "\n\n\nselect *\nfrom db.a\n",
    })
    const f = env.findings.find((x) => x.evidence?.tool === "altimate_core.check")
    expect(f).toBeDefined()
    expect(f!.startLine).toBeUndefined()
  })
})

describe("inline dedup across pushes", () => {
  test("inline bodies carry the finding fingerprint, which ignores the line", () => {
    const a = finding({ startLine: 3 })
    const moved = finding({ startLine: 9 })
    expect(a.id).toBe(moved.id)
    const env = buildEnvelope({ findings: [a], tier: "lite", mode: "comment" })
    expect(inlineComments(env)[0].body).toContain(findingMarker(a.id))
  })

  test("findings already commented on the PR are not posted again", () => {
    const a = finding({ startLine: 3, title: "m: a" })
    const b = finding({ startLine: 4, title: "m: b" })
    const env = buildEnvelope({ findings: [a, b], tier: "lite", mode: "comment" })
    const posted = postedFindingIds(["🛑 old\n\n" + findingMarker(a.id), null, "human comment"])
    expect([...posted]).toEqual([a.id])
    expect(inlineComments(env, posted).map((c) => c.line)).toEqual([4])
  })

  test("a skipped repeat review counts as a full post in telemetry", () => {
    expect(classifyPostOutcome({ inlineFellBack: false, reviewSkipped: true })).toBe("full")
    expect(classifyPostOutcome({ inlineFellBack: false })).toBe("partial")
  })
})

describe("summary grouping and budget", () => {
  test("the same rule on three or more models is one bullet listing the models", () => {
    const fs = ["a", "b", "c", "d"].map((m) =>
      finding({ model: m, file: `models/${m}.sql`, title: `${m}: new model has no uniqueness/grain test` }),
    )
    const md = renderSummary(buildEnvelope({ findings: fs, tier: "lite", mode: "comment" }))
    expect(md.match(/no uniqueness\/grain test/g)?.length).toBe(1)
    expect(md).toContain("4 findings across 4 model(s): `a`, `b`, `c`, `d`")
  })

  test("two occurrences group; a single one stays its own bullet", () => {
    const fs = ["a", "b"].map((m) => finding({ model: m, file: `models/${m}.sql`, title: `${m}: new model has no uniqueness/grain test` }))
    const md = renderSummary(buildEnvelope({ findings: fs, tier: "lite", mode: "comment" }))
    expect(md).toContain("2 findings across 2 model(s)")
    const one = renderSummary(buildEnvelope({ findings: fs.slice(0, 1), tier: "lite", mode: "comment" }))
    expect(one).toContain("a: new model has no uniqueness/grain test")
  })

  test("backticked column names do not split a group", () => {
    const fs = ["a", "b", "c"].map((m) =>
      finding({ model: m, file: `models/${m}.sql`, title: `${m}: grain column \`${m}_id\` lacks not_null`, category: "test_coverage" }),
    )
    const md = renderSummary(buildEnvelope({ findings: fs, tier: "lite", mode: "comment" }))
    expect(md).toContain("3 findings across 3 model(s)")
  })

  test("the posted comment stays within budget, most severe first, and counts what it hides", () => {
    const many: Finding[] = []
    for (let i = 0; i < 200; i++)
      many.push(
        finding({
          severity: i < 3 ? "critical" : "suggestion",
          category: i < 3 ? "lineage_breakage" : "sql_quality",
          model: `m${i}`,
          file: `models/m${i}.sql`,
          title: `m${i}: distinct issue number ${i}`,
          body: "x".repeat(120),
        }),
      )
    const env = buildEnvelope({ findings: many, tier: "full", mode: "comment" })
    const md = renderSummary(env)
    expect(md.length).toBeLessThanOrEqual(SUMMARY_BUDGET_CHARS)
    expect(md).toContain("m0: distinct issue number 0")
    expect(md).toMatch(/… \d+ more finding\(s\) not shown/)
    // Local output is complete.
    expect(renderSummary(env, { maxChars: Infinity })).toContain("m199: distinct issue number 199")
  })
})

describe("portability noise", () => {
  const portability = finding({
    severity: "suggestion",
    category: "sql_quality",
    title: "m: DISTINCT ON isn't portable",
    body: "`DISTINCT ON (…)` isn't portable; use `qualify row_number()` for first-row-per-group.",
    evidence: { tool: "rule-catalog", result: { rule: "distinct-on", portability: true, worksOn: ["postgres", "duckdb"] } },
  })
  const coreMissing = finding({
    category: "sql_quality",
    title: "m: non_portable_function",
    body: "GETDATE() is a non-standard / dialect-specific function.",
    evidence: { tool: "altimate_core.check", result: { rule: "non_portable_function" } },
  })

  test("only explicitly tagged rules are portability advice, not rules that mention standard SQL", async () => {
    const legacy = evaluateCatalog(
      { path: "models/m.sql", status: "added" },
      "select * from [proj:ds.t]",
      ["select * from [proj:ds.t]"],
      [],
      DEFAULT_RUBRIC,
    ).find((f) => (f.evidence?.result as { rule: string }).rule === "bq-legacy-sql")
    expect(legacy).toBeDefined()
    expect(isCatalogPortability(legacy!)).toBe(false)
  })

  test("a construct that fails on the project's own engine is kept", () => {
    expect(isSuppressiblePortability(portability, "postgres")).toBe(true)
    expect(isSuppressiblePortability(portability, "snowflake")).toBe(false)
    const untagged = { ...portability, evidence: { tool: "rule-catalog", result: { rule: "pivot-portability", portability: true } } }
    expect(isSuppressiblePortability(untagged, "snowflake")).toBe(true)
  })

  test("a package with macros for several adapters keeps advice that fails on any of them", () => {
    expect(isSuppressiblePortability(portability, "postgres", ["duckdb"])).toBe(true)
    expect(isSuppressiblePortability(portability, "postgres", ["duckdb", "snowflake"])).toBe(false)
    const untagged = { ...portability, evidence: { tool: "rule-catalog", result: { rule: "pivot-portability", portability: true } } }
    expect(isSuppressiblePortability(untagged, "postgres", ["snowflake"])).toBe(true)
  })

  test("catalog portability advice is recognised; core's dialect-aware check is not", () => {
    expect(isCatalogPortability(portability)).toBe(true)
    expect(isCatalogPortability(coreMissing)).toBe(false)
  })

  test("a single known engine drops portability advice it supports, keeps what fails on it", async () => {
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
        return { decided: true, equivalent: true }
      },
      async detectPii() {
        return { columns: [] }
      },
    } as ReviewRunner
    const sql = "select distinct on (customer_id) customer_id, order_id from orders"
    const base = {
      changedFiles: [{ path: "models/m.sql", status: "added" as const, diff: `+${sql}\n` }],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["dbt_patterns"], dialect: "snowflake" },
      rubric: DEFAULT_RUBRIC,
      mode: "comment" as const,
      runner,
      getContent: async () => sql,
    }
    const kept = await runReview(base)
    expect(kept.findings.filter(isCatalogPortability).length).toBeGreaterThan(0)
    // Postgres supports DISTINCT ON: the advice is noise there and is dropped.
    const pg = { ...base, config: { ...base.config, dialect: "postgres" } }
    expect((await runReview({ ...pg, suppressPortability: true })).findings.filter(isCatalogPortability).length).toBe(0)
    // Snowflake doesn't: on a Snowflake project it is a real error and stays.
    expect((await runReview({ ...base, suppressPortability: true })).findings.filter(isCatalogPortability).length).toBeGreaterThan(0)
  })
})

describe("moved files", () => {
  test("moves are named in the comment with the folder-config caveat, and are not a lint-only run", async () => {
    const env = buildEnvelope({
      findings: [],
      tier: "trivial",
      mode: "comment",
      scope: { movedUnchangedFiles: 3 } as any,
    })
    expect(renderSummary(env)).toContain("3 file(s) moved without edits")
    expect(renderSummary(env)).toContain("`+schema`")
  })
})

describe("repeats of one rule within a file", () => {
  const grain = (col: string, severity: "suggestion" | "critical" = "suggestion") =>
    makeFinding({
      severity,
      category: "test_coverage",
      title: `_schema.yml: grain column \`${col}\` in unique_combination_of_columns lacks \`not_null\``,
      body: `\`${col}\` can be NULL.`,
      file: "models/_schema.yml",
      ruleKey: `grain:${col}`,
    })
  test("merge into one finding listing every instance", () => {
    const [m, ...rest] = mergeRepeats([grain("tx_hash"), grain("evt_index"), grain("block_month")])
    expect(rest).toHaveLength(0)
    expect(m.title).toBe("_schema.yml: grain column `block_month` in unique_combination_of_columns lacks `not_null` (+2 more)")
    expect(m.body).toContain("- grain column `evt_index`")
    expect(m.body).toContain("- grain column `tx_hash`")
  })
  test("other files, other rules, and critical findings stay separate", () => {
    const other = { ...grain("tx_hash"), id: "x", file: "models/other.yml" }
    const crit = [grain("a", "critical"), { ...grain("b", "critical"), id: "y" }]
    expect(mergeRepeats([grain("tx_hash"), other, ...crit])).toHaveLength(4)
  })
})
