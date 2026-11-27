import { describe, test, expect } from "bun:test"
import {
  isCatalogPortability,
  isSuppressiblePortability,
  runReview,
  type ReviewRunner,
} from "../../src/altimate/review/orchestrate"
import { DEFAULT_REVIEW_CONFIG } from "../../src/altimate/review/config"
import { DEFAULT_RUBRIC } from "../../src/altimate/review/rubric"
import { makeFinding, type Finding } from "../../src/altimate/review/finding"
import {
  commentableLines,
  findingMarker,
  inlineComments,
  postedFindingIds,
  renderSummary,
  REVIEW_MARKER,
  SUMMARY_BUDGET_CHARS,
} from "../../src/altimate/review/format"
import { buildEnvelope } from "../../src/altimate/review/verdict"
import { verdictHeadline } from "../../src/altimate/review/format"
import { evaluateCatalog } from "../../src/altimate/review/rule-catalog"
import { classifyPostOutcome } from "../../src/altimate/review/telemetry"
import { postGitHubReview } from "../../src/altimate/review/post-github"
import { shouldSuppressPortability } from "../../src/altimate/review/run"
import { scopeToProject } from "../../src/altimate/review/diff-filter"

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

  test("a deleted file has no commentable line; a pure rename without a patch has none either", () => {
    const deleted = "diff --git a/models/old.sql b/models/old.sql\n--- a/models/old.sql\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-select\n-  id\n-from src\n"
    expect(commentableLines(deleted).size).toBe(0)
    expect(commentableLines("@@ -1,3 +0,0 @@\n-select\n-  id\n-from src").size).toBe(0)
    // GitHub lists a pure rename with no `patch` field.
    expect(commentableLines(undefined).size).toBe(0)
  })

  test("a line outside the diff is not posted inline but keeps its location in the envelope", () => {
    const inDiff = finding({ startLine: 3, endLine: 3, title: "m: a" })
    const outside = finding({ startLine: 40, endLine: 40, title: "m: b" })
    const env = buildEnvelope({ findings: [inDiff, outside], tier: "lite", mode: "comment" })
    const commentable = new Map([["models/m.sql", commentableLines(DIFF)]])
    expect(inlineComments(env, new Set(), commentable).map((c) => c.line)).toEqual([3])
    // Without diff information every line is attempted (the 422 fallback covers it).
    expect(inlineComments(env).map((c) => c.line)).toEqual([3, 40])
    expect(env.findings.find((f) => f.title === "m: b")!.startLine).toBe(40)
    expect(renderSummary(env, { maxChars: Infinity })).toContain("`models/m.sql:40`")
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

  test("only the trailing marker of a bot comment counts, not one echoed inside its body", () => {
    const a = finding({ startLine: 3, title: "m: a" })
    const b = finding({ startLine: 4, title: "m: b" })
    // `b`'s body quotes PR text that carries `a`'s marker; only `b`'s trailing marker counts.
    const echoed = `🛑 **m: b**\n\nThe SQL reads \`${findingMarker(a.id)}\` here.\n\n${findingMarker(b.id)}\n`
    expect([...postedFindingIds([echoed])]).toEqual([b.id])
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

  test("two occurrences stay as separate bullets", () => {
    const fs = ["a", "b"].map((m) => finding({ model: m, file: `models/${m}.sql`, title: `${m}: new model has no uniqueness/grain test` }))
    const md = renderSummary(buildEnvelope({ findings: fs, tier: "lite", mode: "comment" }))
    expect(md.match(/no uniqueness\/grain test/g)?.length).toBe(2)
  })

  test("several findings of one rule on the same model are not collapsed", () => {
    const fs = ["a_id", "b_id", "c_id"].map((c) =>
      finding({ model: "m", file: "models/m.sql", title: `m: grain column \`${c}\` lacks not_null`, category: "test_coverage" }),
    )
    const md = renderSummary(buildEnvelope({ findings: fs, tier: "lite", mode: "comment" }))
    expect(md).not.toContain("findings across")
    for (const c of ["a_id", "b_id", "c_id"]) expect(md).toContain(c)
  })

  test("backticked column names do not split a group", () => {
    const fs = ["a", "b", "c"].map((m) =>
      finding({ model: m, file: `models/${m}.sql`, title: `${m}: grain column \`${m}_id\` lacks not_null`, category: "test_coverage" }),
    )
    const md = renderSummary(buildEnvelope({ findings: fs, tier: "lite", mode: "comment" }))
    expect(md).toContain("3 findings across 3 model(s)")
  })

  test("one rule with different messages per model is not merged into the first message", () => {
    const fs = [
      ["a", "ILIKE"],
      ["b", "QUALIFY"],
      ["c", "IFF"],
    ].map(([m, fn], i) =>
      finding({
        severity: "warning",
        category: "sql_quality",
        model: m,
        file: `models/${m}.sql`,
        startLine: i + 1,
        title: `${m}: dialect-unsupported-function`,
        body: `${fn} is not supported on the target dialect.`,
        degraded: m === "c",
      }),
    )
    const md = renderSummary(buildEnvelope({ findings: fs, tier: "lite", mode: "comment" }))
    expect(md).not.toContain("findings across")
    for (const fn of ["ILIKE", "QUALIFY", "IFF"]) expect(md).toContain(`${fn} is not supported`)
    for (const loc of ["models/a.sql:1", "models/b.sql:2", "models/c.sql:3"]) expect(md).toContain(loc)
    expect(md).toContain("_unverified_")
  })

  test("a grouped bullet keeps _unverified_ when any member is degraded", () => {
    const fs = ["a", "b", "c"].map((m) =>
      finding({ model: m, file: `models/${m}.sql`, title: `${m}: new model has no uniqueness/grain test`, degraded: m === "b" }),
    )
    const md = renderSummary(buildEnvelope({ findings: fs, tier: "lite", mode: "comment" }))
    expect(md).toContain("3 findings across 3 model(s)")
    expect(md).toMatch(/findings across[^\n]*\n[^\n]*\n\s*<sub>test_coverage · _unverified_<\/sub>/)
  })

  test("a grouped body that names one model's column shows the names blanked", () => {
    const fs = ["a", "b", "c"].map((m) =>
      finding({
        model: m,
        file: `models/${m}.sql`,
        title: `${m}: grain column lacks not_null`,
        body: `Column \`${m}_id\` has no not_null test.`,
      }),
    )
    const md = renderSummary(buildEnvelope({ findings: fs, tier: "lite", mode: "comment" }))
    expect(md).toContain("3 findings across 3 model(s)")
    expect(md).toContain("Column `…` has no not_null test.")
    // Each column is attributed to its own model, never shown as everyone's.
    expect(md).not.toContain("Column `a_id`")
    expect(md).toContain("`a`: `a_id` · `b`: `b_id` · `c`: `c_id`")
  })

  test("a group whose members differ by more than the model lists each member's values", () => {
    const fs = [
      ["a", "ILIKE"],
      ["b", "QUALIFY"],
      ["c", "IFF"],
      ["c", "NVL2"],
    ].map(([m, fn]) =>
      finding({
        severity: "warning",
        category: "sql_quality",
        model: m,
        file: `models/${m}.sql`,
        title: `${m}: unsupported function`,
        body: `Function \`${fn}\` is unsupported on the target dialect.`,
      }),
    )
    const md = renderSummary(buildEnvelope({ findings: fs, tier: "lite", mode: "comment" }))
    expect(md).toContain("4 findings across 3 model(s)")
    expect(md).toContain("`a`: `ILIKE` · `b`: `QUALIFY` · `c`: `IFF` · `c`: `NVL2`")
  })

  test("findings titled by their file group like findings titled by their model", () => {
    const fs = ["a", "b", "c"].map((m) =>
      finding({
        model: m,
        file: `models/${m}/schema.yml`,
        // The removed-test shape: file prefix, model named unquoted mid-title.
        title: `schema.yml: unique test removed from ${m}.id`,
        category: "test_coverage",
      }),
    )
    const md = renderSummary(buildEnvelope({ findings: fs, tier: "lite", mode: "comment" }))
    expect(md).toContain("3 findings across 3 model(s)")
  })

  test("more than eight models: the posted comment lists eight, local output lists every finding", () => {
    const ms = Array.from({ length: 11 }, (_, i) => `m${i}`)
    const fs = ms.map((m) => finding({ model: m, file: `models/${m}.sql`, title: `${m}: new model has no uniqueness/grain test` }))
    const env = buildEnvelope({ findings: fs, tier: "lite", mode: "comment" })
    const md = renderSummary(env)
    expect(md).toContain("11 findings across 11 model(s)")
    expect(md).toContain("(+3 more)")
    expect(md).not.toContain("`m8`")
    const local = renderSummary(env, { maxChars: Infinity })
    expect(local).not.toContain("findings across")
    for (const m of ms) expect(local).toContain(`\`models/${m}.sql\``)
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

  test("a critical that does not fit stops the listing: no later, shorter finding jumps ahead of it", () => {
    // Twelve criticals with long bodies (each clipped, still ~700 chars) cannot
    // all fit; the short suggestions after them must not be listed instead.
    const fs: Finding[] = [
      ...Array.from({ length: 12 }, (_, i) =>
        finding({
          severity: "critical",
          category: "lineage_breakage",
          model: `c${i}`,
          file: `models/c${i}.sql`,
          title: `c${i}: long critical`,
          body: `issue ${i} `.repeat(600),
        }),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        finding({ model: `s${i}`, file: `models/s${i}.sql`, title: `s${i}: short suggestion ${i}` }),
      ),
    ]
    const md = renderSummary(buildEnvelope({ findings: fs, tier: "full", mode: "comment" }))
    expect(md.length).toBeLessThanOrEqual(SUMMARY_BUDGET_CHARS)
    expect(md).toContain("c0: long critical")
    expect(md).not.toContain("c11: long critical")
    expect(md).not.toContain("short suggestion")
    const shown = Number(/Critical \((\d+) of 12\)/.exec(md)?.[1])
    expect(shown).toBeGreaterThanOrEqual(3)
    expect(md).not.toMatch(/### 💡 Suggestion/)
    expect(md).toContain(`${22 - shown} more finding(s) not shown (${12 - shown} critical, 10 suggestion)`)
  })

  test("a critical with a huge body is still listed: bullet bodies are clipped", () => {
    // One critical whose body alone would fill the budget: the gate comment must
    // not say "Changes requested — 1 critical" while listing nothing.
    const fs: Finding[] = [
      finding({
        severity: "critical",
        category: "pii_exposure",
        model: "b",
        file: "models/b.sql",
        title: "b: exposes PII column (ssn)",
        body: "y".repeat(4_800),
      }),
    ]
    const md = renderSummary(buildEnvelope({ findings: fs, tier: "full", mode: "gate" }))
    expect(md.length).toBeLessThanOrEqual(SUMMARY_BUDGET_CHARS)
    expect(md).toContain("b: exposes PII column (ssn)")
    expect(md).toContain("Critical (1)")
    expect(md).not.toContain("more finding(s) not shown")
    expect(md).not.toContain("y".repeat(700))
    // Local output keeps the whole body.
    expect(renderSummary(buildEnvelope({ findings: fs, tier: "full", mode: "gate" }), { maxChars: Infinity })).toContain(
      "y".repeat(4_800),
    )
  })

  test("diagnostic reasons are clipped in the posted comment but whole in local output", () => {
    const reason = `compile failed: ${"Database Error in model m (models/m.sql) ".repeat(8)}END`
    const env = buildEnvelope({
      findings: [],
      tier: "lite",
      mode: "comment",
      scope: { unverified: [{ path: "models/m.sql", reason }] } as any,
      ai: { state: "error", reason: `ai lane: ${"timeout talking to provider ".repeat(10)}END` } as any,
    })
    const local = renderSummary(env, { maxChars: Infinity })
    expect(local).toContain(reason)
    expect(local).toContain("provider END")
    const posted = renderSummary(env)
    expect(posted).not.toContain(reason)
    expect(posted).not.toContain("provider END")
  })

  test("the grouping key cannot be forged by a `|` in a title or body", () => {
    const make = (models: string[], title: string, body: string) =>
      models.map((m) => finding({ model: m, file: `models/${m}.sql`, title: `${m}: ${title}`, body }))
    const fs = [...make(["a", "b", "c"], "r|x", "y"), ...make(["d", "e", "f"], "r", "x|y")]
    const md = renderSummary(buildEnvelope({ findings: fs, tier: "lite", mode: "comment" }))
    expect(md.match(/3 findings across 3 model\(s\)/g)?.length).toBe(2)
  })

  test("the metadata is budgeted too: a run with no findings and huge metadata stays within budget", () => {
    const long = (tag: string, i: number) => `models/${"deeply/nested/".repeat(8)}${tag}_${i}.sql`
    const env = buildEnvelope({
      findings: [],
      tier: "full",
      mode: "comment",
      tierReasons: Array.from({ length: 40 }, (_, i) => `PII column in ${long("tier", i)}`),
      scope: {
        unverified: Array.from({ length: 30 }, (_, i) => ({
          path: long("unverified", i),
          reason: `reason ${i % 3}: ${"no compiled SQL for the head ".repeat(10)}`,
        })),
        outOfScopeFiles: 4,
        movedUnchangedFiles: 2,
      } as any,
      ai: { state: "error", reason: "z".repeat(2_000) } as any,
    })
    const withOverride = { ...env, override: { by: "lead", reason: "because ".repeat(400), priorVerdict: "REQUEST_CHANGES" } }
    for (const e of [env, withOverride as typeof env]) {
      const md = renderSummary(e)
      expect(md.length).toBeLessThanOrEqual(SUMMARY_BUDGET_CHARS)
      expect(md).toContain("No issues found")
      expect(md).toContain("more in verdict envelope)")
      expect(md).toMatch(/\d+ model\(s\) not verified by the engine/)
      // Local output keeps every reason.
      expect(renderSummary(e, { maxChars: Infinity })).toContain(long("tier", 7))
    }
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
    // Support never established: the advice may be an error here, so it stays.
    expect(isSuppressiblePortability(untagged, "snowflake")).toBe(false)
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

  test("PIVOT is kept on Postgres and a string interval literal on BigQuery; both drop where they work", async () => {
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
    const rules = async (sql: string, dialect: string) => {
      const env = await runReview({
        changedFiles: [{ path: "models/m.sql", status: "added" as const, diff: `+${sql}\n` }],
        config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["dbt_patterns"], dialect },
        rubric: DEFAULT_RUBRIC,
        mode: "comment" as const,
        runner,
        getContent: async () => sql,
        suppressPortability: true,
      })
      return env.findings.filter(isCatalogPortability).map((f) => (f.evidence?.result as any)?.rule)
    }
    const pivot = "select * from t pivot(sum(x) for k in ('a'))"
    expect(await rules(pivot, "postgres")).toContain("pivot-portability")
    expect(await rules(pivot, "snowflake")).not.toContain("pivot-portability")
    const interval = "select d + interval '1 day' as next_day from t"
    expect(await rules(interval, "bigquery")).toContain("interval-string-literal")
    expect(await rules(interval, "postgres")).not.toContain("interval-string-literal")
    // The ANSI form (`interval '30' day`) is what those engines want: never flagged.
    for (const ansi of ["select d - interval '30' day as d30 from t", "select d + interval '12' month as d12 from t"])
      for (const dialect of ["trino", "athena", "bigquery", "oracle", "mysql"])
        expect(await rules(ansi, dialect)).not.toContain("interval-string-literal")
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

  test("a run of only unchanged moves, through runReview without a manifest, is not lint-only", async () => {
    const scoped = scopeToProject(
      [
        {
          path: "models/staging/b/schema.yml",
          oldPath: "models/staging/a/schema.yml",
          status: "renamed",
          similarity: 100,
          diff: "",
        },
      ],
      undefined,
    )
    expect(scoped).toMatchObject({ inScope: [], movedUnchanged: 1 })
    const runner = {
      async impact() {
        return { hasManifest: false, severity: "SAFE", directCount: 0, transitiveCount: 0, testCount: 0 }
      },
      async detectPii() {
        return { columns: [] }
      },
    } as unknown as ReviewRunner
    const env = await runReview({
      changedFiles: scoped.inScope,
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      getContent: async () => undefined,
      scope: { movedUnchangedFiles: scoped.movedUnchanged },
    })
    expect(env.summary.degraded).toBe(false)
    const md = renderSummary(env)
    expect(md).toContain("1 file(s) moved without edits")
    expect(md).not.toContain("Lint-only")
  })
})

describe("postGitHubReview", () => {
  const BOT = "github-actions[bot]"
  const target = { token: "t", owner: "o", repo: "r", prNumber: 7 }
  const PATCH = DIFF.split("\n").slice(3).join("\n")

  function fakeOcto(
    opts: {
      reviews?: Array<{ body: string; user?: { login: string } }>
      listFails?: boolean
      files?: Array<{ filename: string; patch?: string }>
      reviewComments?: Array<{ body: string; user?: { login: string } }>
      issueComments?: Array<{ id: number; body: string }>
      createReview?: (call: number) => unknown
    } = {},
  ) {
    const reviewCalls: any[] = []
    const summaryCalls: string[] = []
    const fail = async () => {
      throw new Error("listing failed")
    }
    // GitHub lists in pages: each list call returns one page of PAGE items, and
    // `paginate` walks the pages, so anything read without it sees page one only.
    const PAGE = 2
    const paged =
      <T>(items: T[]) =>
      async (p: { page?: number }) =>
        items.slice(((p?.page ?? 1) - 1) * PAGE, (p?.page ?? 1) * PAGE)
    const octo = {
      paginate: async (fn: (p: unknown) => Promise<unknown[]>, p: Record<string, unknown>) => {
        const all: unknown[] = []
        for (let page = 1; ; page++) {
          const items = await fn({ ...p, page })
          all.push(...items)
          if (items.length < PAGE) return all
        }
      },
      rest: {
        issues: {
          listComments: paged(opts.issueComments ?? []),
          createComment: async () => {
            summaryCalls.push("create")
            return { data: { id: 1, user: { login: BOT } } }
          },
          updateComment: async (p: { comment_id: number }) => {
            summaryCalls.push(`update ${p.comment_id}`)
            return { data: { id: p.comment_id, user: { login: BOT } } }
          },
        },
        pulls: {
          listReviewComments: opts.listFails ? fail : paged(opts.reviewComments ?? []),
          listReviews: opts.listFails ? fail : paged(opts.reviews ?? []),
          listFiles: opts.listFails ? fail : paged(opts.files ?? [{ filename: "models/m.sql", patch: PATCH }]),
          get: async () => ({ data: { head: { sha: "abc" } } }),
          createReview: async (p: any) => {
            reviewCalls.push(p)
            const r = opts.createReview?.(reviewCalls.length)
            return r ?? { data: { id: 9 } }
          },
        },
      },
    }
    return { octo: octo as any, reviewCalls, summaryCalls }
  }

  const noLine = buildEnvelope({ findings: [finding()], tier: "lite", mode: "comment" })

  test("markers, reviews, files and the prior summary are read from every page", async () => {
    const env = buildEnvelope({
      findings: [finding({ startLine: 3, title: "m: a" }), finding({ file: "models/late.sql", startLine: 5, title: "late: b" })],
      tier: "lite",
      mode: "comment",
    })
    const [first] = inlineComments(env, new Set(), undefined)
    const filler = (n: number) => Array.from({ length: n }, (_, i) => ({ body: `other ${i}`, user: { login: "someone" } }))
    const { octo, reviewCalls, summaryCalls } = fakeOcto({
      // Each item that matters is on page two or later.
      issueComments: [...filler(3).map((c, i) => ({ id: 100 + i, body: c.body })), { id: 42, body: `${REVIEW_MARKER}\nold` }],
      reviewComments: [...filler(3), { body: first.body, user: { login: BOT } }],
      files: [
        { filename: "models/x.sql", patch: PATCH },
        { filename: "models/y.sql", patch: PATCH },
        { filename: "models/m.sql", patch: PATCH },
        { filename: "models/late.sql", patch: PATCH },
      ],
    })
    const r = await postGitHubReview(env, target, octo)
    expect(summaryCalls).toEqual(["update 42"])
    expect(r.inlineSkippedAsPosted).toBe(1)
    expect(reviewCalls[0].comments.map((c: { path: string; line: number }) => `${c.path}:${c.line}`)).toEqual(["models/late.sql:5"])
    // This bot's latest review on page two carries the same headline: no new review.
    const quiet = buildEnvelope({ findings: [finding()], tier: "lite", mode: "comment" })
    const again = fakeOcto({ reviews: [...filler(2), { body: verdictHeadline(quiet), user: { login: BOT } }] })
    expect((await postGitHubReview(quiet, target, again.octo)).reviewSkipped).toBe(true)
  })

  test("a file the PR does not list gets no inline comment once the file list is known", async () => {
    const env = buildEnvelope({
      findings: [finding({ startLine: 3, title: "m: a" }), finding({ file: "models/unlisted.sql", startLine: 3, title: "u: b" })],
      tier: "lite",
      mode: "comment",
    })
    const { octo, reviewCalls } = fakeOcto()
    await postGitHubReview(env, target, octo)
    expect(reviewCalls[0].comments.map((c: { path: string }) => c.path)).toEqual(["models/m.sql"])
  })

  test("a non-positioning failure of the verified-only retry is recorded", async () => {
    const env = buildEnvelope({
      findings: [
        finding({ file: "models/known.sql", startLine: 3, title: "known: a" }),
        finding({ file: "models/big.sql", startLine: 900, title: "big: b" }),
      ],
      tier: "lite",
      mode: "comment",
    })
    const { octo, reviewCalls } = fakeOcto({
      files: [{ filename: "models/known.sql", patch: PATCH }, { filename: "models/big.sql" }],
      createReview: (call) => {
        if (call === 1)
          throw Object.assign(new Error("Unprocessable Entity"), {
            status: 422,
            response: { data: { errors: ["Line could not be resolved"] } },
          })
        if (call === 2) throw Object.assign(new Error("Server Error"), { status: 502 })
        return undefined
      },
    })
    const r = await postGitHubReview(env, target, octo)
    expect(reviewCalls.length).toBe(3)
    expect(reviewCalls[2].comments).toBeUndefined()
    expect(r.reviewId).toBe(9)
    expect(r.inlineFellBack).toBe(true)
    expect(r.postError).toBe("502 Server Error")
  })

  test("skips a new review when this bot's latest review has the same headline", async () => {
    const { octo, reviewCalls } = fakeOcto({
      reviews: [
        { body: "🛑 Changes requested — 1 critical (lite tier)", user: { login: BOT } },
        { body: verdictHeadline(noLine), user: { login: BOT } },
      ],
    })
    const r = await postGitHubReview(noLine, target, octo)
    expect(r.reviewSkipped).toBe(true)
    expect(reviewCalls.length).toBe(0)
  })

  test("posts a new review when this bot's latest review requested changes", async () => {
    const { octo, reviewCalls } = fakeOcto({
      reviews: [
        { body: verdictHeadline(noLine), user: { login: BOT } },
        { body: "🛑 Changes requested — 1 critical (lite tier)", user: { login: BOT } },
      ],
    })
    const r = await postGitHubReview(noLine, target, octo)
    expect(r.reviewSkipped).toBeUndefined()
    expect(reviewCalls.length).toBe(1)
    expect(reviewCalls[0].event).toBe("COMMENT")
  })

  test("another account's review with the same headline does not count", async () => {
    const { octo, reviewCalls } = fakeOcto({ reviews: [{ body: verdictHeadline(noLine), user: { login: "someone" } }] })
    const r = await postGitHubReview(noLine, target, octo)
    expect(r.reviewSkipped).toBeUndefined()
    expect(reviewCalls.length).toBe(1)
  })

  test("inline comments go only to lines inside the PR diff", async () => {
    const env = buildEnvelope({
      findings: [finding({ startLine: 3, title: "m: a" }), finding({ startLine: 40, title: "m: b" })],
      tier: "lite",
      mode: "comment",
    })
    const { octo, reviewCalls } = fakeOcto()
    const r = await postGitHubReview(env, target, octo)
    expect(reviewCalls[0].comments.map((c: { line: number }) => c.line)).toEqual([3])
    expect(r.inlineSkippedAsPosted).toBe(0)
  })

  test("a file GitHub lists without a patch keeps its inline comments", async () => {
    // GitHub omits `patch` for large diffs: the hunks are unknown, so the lines
    // are attempted (the 422 fallback covers a miss) instead of all dropped.
    const env = buildEnvelope({
      findings: [
        finding({ startLine: 3, title: "m: a" }),
        finding({ startLine: 40, title: "m: b" }),
        finding({ file: "models/big.sql", startLine: 900, title: "big: c" }),
      ],
      tier: "lite",
      mode: "comment",
    })
    const { octo, reviewCalls } = fakeOcto({
      files: [{ filename: "models/m.sql", patch: PATCH }, { filename: "models/big.sql" }],
    })
    await postGitHubReview(env, target, octo)
    expect(reviewCalls[0].comments.map((c: { path: string; line: number }) => `${c.path}:${c.line}`)).toEqual([
      "models/m.sql:3",
      "models/big.sql:900",
    ])
  })

  test("a finding marker counts only in this bot's own review comments", async () => {
    const env = buildEnvelope({ findings: [finding({ startLine: 3, title: "m: a" })], tier: "lite", mode: "comment" })
    const [first] = inlineComments(env, new Set(), undefined)
    // Another account posting (or quoting) the marker does not suppress the finding.
    const foreign = fakeOcto({ reviewComments: [{ body: first.body, user: { login: "pr-author" } }] })
    const r = await postGitHubReview(env, target, foreign.octo)
    expect(foreign.reviewCalls[0].comments.map((c: { line: number }) => c.line)).toEqual([3])
    expect(r.inlineSkippedAsPosted).toBe(0)
    // The bot's own earlier comment does.
    const own = fakeOcto({ reviewComments: [{ body: first.body, user: { login: BOT } }] })
    const again = await postGitHubReview(env, target, own.octo)
    expect(again.inlineSkippedAsPosted).toBe(1)
  })

  test("a deleted file gets no inline comment; a pure rename without a patch keeps its comments", async () => {
    const env = buildEnvelope({
      findings: [
        finding({ file: "models/old.sql", model: "old", startLine: 2, title: "old: a" }),
        finding({ file: "models/renamed.sql", model: "renamed", startLine: 5, title: "renamed: b" }),
      ],
      tier: "lite",
      mode: "comment",
    })
    const { octo, reviewCalls } = fakeOcto({
      files: [
        { filename: "models/old.sql", patch: "@@ -1,3 +0,0 @@\n-select\n-  id\n-from src" },
        { filename: "models/renamed.sql" },
      ],
    })
    await postGitHubReview(env, target, octo)
    expect(reviewCalls[0].comments.map((c: { path: string; line: number }) => `${c.path}:${c.line}`)).toEqual([
      "models/renamed.sql:5",
    ])
  })

  test("when listing fails, everything is posted and nothing is skipped", async () => {
    const env = buildEnvelope({
      findings: [finding({ startLine: 3, title: "m: a" }), finding({ startLine: 40, title: "m: b" })],
      tier: "lite",
      mode: "comment",
    })
    const { octo, reviewCalls } = fakeOcto({ listFails: true, reviews: [{ body: verdictHeadline(env), user: { login: BOT } }] })
    const r = await postGitHubReview(env, target, octo)
    expect(r.reviewSkipped).toBeUndefined()
    expect(reviewCalls[0].comments.map((c: { line: number }) => c.line)).toEqual([3, 40])
  })

  test("a positioning 422 retries the review without inline comments", async () => {
    const env = buildEnvelope({ findings: [finding({ startLine: 3 })], tier: "lite", mode: "comment" })
    const { octo, reviewCalls } = fakeOcto({
      createReview: (call) => {
        if (call === 1)
          throw Object.assign(new Error("Unprocessable Entity"), {
            status: 422,
            response: { data: { errors: ["Line could not be resolved"] } },
          })
        return undefined
      },
    })
    const r = await postGitHubReview(env, target, octo)
    expect(reviewCalls.length).toBe(2)
    expect(reviewCalls[0].comments.length).toBe(1)
    expect(reviewCalls[1].comments).toBeUndefined()
    expect(r.inlineFellBack).toBe(true)
    expect(r.postError).toBeUndefined()
    expect(r.reviewId).toBe(9)
  })

  test("a positioning 422 with a patchless file retries with the verified comments first", async () => {
    const env = buildEnvelope({
      findings: [
        finding({ file: "models/known.sql", startLine: 3, title: "known: a" }),
        finding({ file: "models/big.sql", startLine: 900, title: "big: b" }),
      ],
      tier: "lite",
      mode: "comment",
    })
    const positioning422 = Object.assign(new Error("Unprocessable Entity"), {
      status: 422,
      response: { data: { errors: ["Line could not be resolved"] } },
    })
    const where = (call: any) => (call.comments ?? []).map((c: { path: string; line: number }) => `${c.path}:${c.line}`)
    const files = [{ filename: "models/known.sql", patch: PATCH }, { filename: "models/big.sql" }]

    const kept = fakeOcto({
      files,
      createReview: (call) => {
        if (call === 1) throw positioning422
        return undefined
      },
    })
    const r = await postGitHubReview(env, target, kept.octo)
    expect(kept.reviewCalls.map(where)).toEqual([["models/known.sql:3", "models/big.sql:900"], ["models/known.sql:3"]])
    // Some inline comments were posted: a partial drop, not a summary-only fallback.
    expect(r.inlineFellBack).toBe(false)
    expect(r.inlineDropped).toBe(1)
    expect(classifyPostOutcome(r)).toBe("partial")
    expect(r.postError).toBeUndefined()
    expect(r.reviewId).toBe(9)

    // The verified-only retry also failing falls back to an event-only review.
    const none = fakeOcto({
      files,
      createReview: (call) => {
        if (call <= 2) throw positioning422
        return undefined
      },
    })
    const r2 = await postGitHubReview(env, target, none.octo)
    expect(none.reviewCalls.length).toBe(3)
    expect(none.reviewCalls[2].comments).toBeUndefined()
    expect(r2.inlineFellBack).toBe(true)
    expect(r2.reviewId).toBe(9)
  })
})

describe("portability settings", () => {
  test("unset follows whether the engine is known; an explicit value always wins", () => {
    expect(shouldSuppressPortability(undefined, true)).toBe(true)
    expect(shouldSuppressPortability(undefined, false)).toBe(false)
    expect(shouldSuppressPortability(false, false)).toBe(true)
    expect(shouldSuppressPortability(true, true)).toBe(false)
  })

  test("integer arithmetic on a timestamp is kept on Postgres; on a date it is not", () => {
    const rule = (sql: string, id: string) =>
      evaluateCatalog({ path: "models/m.sql", status: "added" }, sql, [sql], [], DEFAULT_RUBRIC).find(
        (f) => (f.evidence?.result as { rule: string }).rule === id,
      )
    const ts = rule("select updated_at + 1 from t", "timestamp-plus-int")
    expect(ts).toBeDefined()
    expect(rule("select updated_at + 1 from t", "date-plus-int")).toBeUndefined()
    expect(isSuppressiblePortability(ts!, "postgres")).toBe(false)
    expect(isSuppressiblePortability(ts!, "snowflake")).toBe(false)
    const date = rule("select order_date + 7 from t", "date-plus-int")
    expect(date).toBeDefined()
    expect(isSuppressiblePortability(date!, "postgres")).toBe(true)
  })
})
