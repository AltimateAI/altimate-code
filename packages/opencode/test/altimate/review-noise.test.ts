import { describe, test, expect } from "bun:test"
import {
  anchorToDiff,
  commentableLines,
  isCatalogPortability,
  isSuppressiblePortability,
  runReview,
  validateSuggestions,
  type ReviewRunner,
} from "../../src/altimate/review/orchestrate"
import { DEFAULT_REVIEW_CONFIG } from "../../src/altimate/review/config"
import { DEFAULT_RUBRIC } from "../../src/altimate/review/rubric"
import { makeFinding, mergeRepeats, type Finding } from "../../src/altimate/review/finding"
import {
  BODY_MAX_CHARS,
  clampBody,
  findingMarker,
  inlineComments,
  postedFindingIds,
  renderSummary,
  SUMMARY_BUDGET_CHARS,
} from "../../src/altimate/review/format"
import { buildEnvelope } from "../../src/altimate/review/verdict"
import { evaluateCatalog } from "../../src/altimate/review/rule-catalog"
import { classifyPostOutcome } from "../../src/altimate/review/telemetry"
import { DEFAULT_RULE_TIERS, ruleTier, type RuleTier } from "../../src/altimate/review/rule-tiers"

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
    const a = finding({ startLine: 3, severity: "warning", tier: "inline" })
    const moved = finding({ startLine: 9, severity: "warning", tier: "inline" })
    expect(a.id).toBe(moved.id)
    const env = buildEnvelope({ findings: [a], tier: "lite", mode: "comment" })
    expect(inlineComments(env).comments[0].body).toContain(findingMarker(a.id))
  })

  test("findings already commented on the PR are not posted again", () => {
    const a = finding({ startLine: 3, title: "m: a", severity: "warning", tier: "inline" })
    const b = finding({ startLine: 4, title: "m: b", severity: "warning", tier: "inline" })
    const env = buildEnvelope({ findings: [a, b], tier: "lite", mode: "comment" })
    const posted = postedFindingIds(["🛑 old\n\n" + findingMarker(a.id), null, "human comment"])
    expect([...posted]).toEqual([a.id])
    expect(inlineComments(env, posted).comments.map((c) => c.line)).toEqual([4])
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

    // The AI lane is grounded in the same cleaned list: dropped advice never reaches it.
    let grounding: Finding[] | undefined
    const withAi = {
      ...pg,
      config: { ...pg.config, reviewers: ["dbt_patterns", "ai_review"] },
      forceTier: "full" as const,
      suppressPortability: true,
      aiReview: async (input: { grounding: Finding[] }) => {
        grounding = input.grounding
        return []
      },
    }
    const env = await runReview(withAi)
    expect(grounding).toBeDefined()
    expect(grounding!.filter(isCatalogPortability).length).toBe(0)
    expect(grounding!.map((f) => f.title)).toEqual(env.findings.map((f) => f.title))
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
  test("same-titled lint findings keep each message and line", () => {
    const lint = (line: number, msg: string) =>
      makeFinding({ severity: "suggestion", category: "sql_quality", title: "m: L001", body: msg, file: "models/m.sql", startLine: line })
    const [m, ...rest] = mergeRepeats([lint(3, "first issue"), lint(9, "second issue"), lint(12, "third issue")])
    expect(rest).toHaveLength(0)
    const all = `${m.body}`
    for (const t of ["first issue", "second issue", "third issue"]) expect(all).toContain(t)
    expect(all).toMatch(/\(line (3|9|12)\)/)
  })
  test("other files, other rules, and critical findings stay separate", () => {
    const other = { ...grain("tx_hash"), id: "x", file: "models/other.yml" }
    const crit = [grain("a", "critical"), { ...grain("b", "critical"), id: "y" }]
    expect(mergeRepeats([grain("tx_hash"), other, ...crit])).toHaveLength(4)
  })
  test("the merged id is the group's, so fixing the first instance does not change it", () => {
    const [all] = mergeRepeats([grain("tx_hash"), grain("evt_index"), grain("block_month")])
    const [rest] = mergeRepeats([grain("tx_hash"), grain("evt_index")])
    expect(all.id).toBe(rest.id)
    expect(all.id).not.toBe(grain("block_month").id)
  })
})

describe("per-rule tiers", () => {
  const sql = [
    "select o.id, o.amount, case when o.amount > 0 then 'pos' end as sign",
    "from {{ ref('orders') }} o, {{ ref('customers') }} c",
    "where 1=1 and o.id = c.id",
    "group by 1, 2",
  ].join("\n")
  const runner: ReviewRunner = {
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
      return { decided: true, equivalent: false, differences: ["row count differs"], confidence: "high" } as any
    },
    async detectPii() {
      return { columns: [] }
    },
  }
  const review = (rules: Record<string, RuleTier>, aiReview?: (input: { grounding: Finding[] }) => Promise<Finding[]>) =>
    runReview({
      changedFiles: [{ path: "models/marts/m.sql", status: "modified", diff: sql.split("\n").map((l) => `+${l}`).join("\n") }],
      config: {
        ...DEFAULT_REVIEW_CONFIG,
        reviewers: aiReview ? ["dbt_patterns", "semantic_change", "ai_review"] : ["dbt_patterns", "semantic_change"],
        rules,
      },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      forceTier: "full",
      aiReview: aiReview as any,
      getContent: async (_p, side) => (side === "old" ? "select id from {{ ref('orders') }}" : sql),
      getCompiled: async (_p, side) =>
        side === "old" ? "select id from db.orders" : sql.replace(/\{\{ ref\('(\w+)'\) \}\}/g, "db.$1"),
    })
  const rules = (fs: Finding[]) => fs.map((f) => f.rule).sort()

  test("an off rule is dropped from the findings and from the AI's grounding", async () => {
    let grounding: Finding[] | undefined
    const env = await review({}, async (input) => {
      grounding = input.grounding
      return []
    })
    expect(DEFAULT_RULE_TIERS["dbt-patterns:comma-join"]).toBe("off")
    expect(rules(env.findings)).toEqual(["altimate-core.equivalence:not-equivalent", "rule-catalog:group-by-positional"])
    expect(grounding).toBeDefined()
    expect(rules(grounding!)).toEqual(rules(env.findings))
    expect(env.findings.every((f) => f.tier === "summary")).toBe(true)
  })

  test("the same rules surface when the policy reports everything", async () => {
    const env = await review({ "*": "summary" })
    // These five ids are emitted by real detectors and are keys of the default table.
    for (const id of [
      "dbt-patterns:comma-join",
      "dbt-patterns:case-no-else",
      "rule-catalog:where-1-eq-1",
      "rule-catalog:self-equality",
      "rule-catalog:group-by-positional",
    ]) {
      expect(rules(env.findings)).toContain(id)
      expect(DEFAULT_RULE_TIERS[id]).toBeDefined()
    }
  })

  test("a glob turns off catalog rules but not engine equivalence", async () => {
    const env = await review({ "rule-catalog:*": "off", "*": "off" })
    expect(rules(env.findings)).toEqual(["altimate-core.equivalence:not-equivalent"])
  })

  test("an exact override can turn off an engine rule, and can promote a rule inline", async () => {
    const env = await review({ "altimate-core.equivalence:not-equivalent": "off", "rule-catalog:group-by-positional": "inline" })
    expect(rules(env.findings)).toEqual(["rule-catalog:group-by-positional"])
    expect(env.findings[0].tier).toBe("inline")
  })

  test("resolution order: exact, longest glob, default table, summary", () => {
    expect(ruleTier(undefined)).toBe("summary")
    expect(ruleTier("some-new-tool:unknown-rule")).toBe("summary")
    expect(ruleTier("dbt-project-rules:temporary-code-marker")).toBe("inline")
    expect(ruleTier("rule-catalog:join-no-on")).toBe("off")
    expect(ruleTier("rule-catalog:join-no-on", { "rule-catalog:*": "summary" })).toBe("summary")
    expect(ruleTier("rule-catalog:join-no-on", { "rule-catalog:*": "summary", "rule-catalog:join-*": "inline" })).toBe("inline")
    expect(ruleTier("rule-catalog:join-no-on", { "rule-catalog:*": "inline", "rule-catalog:join-no-on": "off" })).toBe("off")
    expect(ruleTier("impact-analysis:downstream-consumers", { "impact-analysis:*": "off" })).toBe("summary")
    expect(ruleTier("impact-analysis:downstream-consumers", { "impact-analysis:*": "inline" })).toBe("inline")
  })

  test("default table keys are well-formed ids, and verdict-relevant engine rules are never off", () => {
    const keys = Object.keys(DEFAULT_RULE_TIERS)
    expect(keys.filter((k) => DEFAULT_RULE_TIERS[k] === "inline")).toHaveLength(15)
    for (const k of keys) expect(k.endsWith(":*") || /^[a-z0-9.-]+:[a-z0-9.-]+$/.test(k)).toBe(true)
    // Rules kept at summary because they produced a real benchmark catch.
    for (const k of [
      "altimate-core.structural-diff:removed-predicate",
      "dbt-project-rules:partition-not-in-merge-key",
      "dbt-project-rules:models-disabled",
      "rule-catalog:greatest-least-null",
      "rule-catalog:hardcoded-year-filter",
      "dbt-patterns:hardcoded-date",
      "altimate-core.dbt-config:incremental-no-guard",
      "altimate-core.dbt-config:unique-key-change",
      "dbt-patterns:fanout-join",
    ])
      expect(ruleTier(k)).toBe("summary")
    for (const p of ["altimate-core.equivalence:", "impact-analysis:", "schema.detect-pii:", "contract-check:", "data.diff:"])
      expect(keys.filter((k) => k.startsWith(p) && DEFAULT_RULE_TIERS[k] === "off")).toEqual([])
  })
})

describe("inline posting policy", () => {
  const inlineAt = (i: number, over: Partial<Parameters<typeof makeFinding>[0]> = {}) =>
    finding({
      severity: "warning",
      category: "sql_quality",
      tier: "inline",
      model: `m${i}`,
      file: `models/m${i}.sql`,
      startLine: 3,
      title: `m${i}: inline issue ${i}`,
      ...over,
    })

  test("at most inlineBudget new comments; the rest are deferred and stay in the summary", () => {
    const env = buildEnvelope({ findings: Array.from({ length: 12 }, (_, i) => inlineAt(i)), tier: "lite", mode: "comment" })
    const { comments, deferred } = inlineComments(env)
    expect(comments).toHaveLength(10)
    expect(deferred).toHaveLength(2)
    const md = renderSummary(env)
    expect(md).toContain("### Inline (10)")
    for (const f of deferred) expect(md).toContain(`**${f.title}**`)
  })

  test("the budget counts only comments new this run", () => {
    const fs = Array.from({ length: 12 }, (_, i) => inlineAt(i))
    const env = buildEnvelope({ findings: fs, tier: "lite", mode: "comment" })
    const posted = new Set(fs.slice(0, 5).map((f) => f.id))
    const { comments, deferred } = inlineComments(env, posted)
    expect(comments).toHaveLength(7)
    expect(deferred).toHaveLength(0)
  })

  test("findings below the severity floor, summary-tier rules and pre-existing lines are never inline", () => {
    const env = buildEnvelope({
      findings: [
        inlineAt(1, { severity: "suggestion" }),
        inlineAt(2, { tier: "summary" }),
        inlineAt(3, { preExisting: true }),
        inlineAt(4, { startLine: undefined }),
      ],
      tier: "lite",
      mode: "comment",
    })
    expect(inlineComments(env).comments).toHaveLength(0)
    const md = renderSummary(env)
    expect(md).not.toContain("### Inline")
    expect(md).toContain("<details><summary>Pre-existing (1)</summary>")
    expect(md).toContain("m3: inline issue 3")
  })

  test("AI-lane findings are inline-eligible without a tier", () => {
    const ai = finding({
      severity: "warning",
      category: "sql_quality",
      startLine: 3,
      title: "m: ai finding",
      evidence: { tool: "ai-review", result: {} },
    })
    const env = buildEnvelope({ findings: [ai], tier: "lite", mode: "comment" })
    expect(inlineComments(env).comments).toHaveLength(1)
  })

  test("most severe, then most confident, then file and line first", () => {
    const env = buildEnvelope({
      findings: [
        inlineAt(1, { confidence: "low", file: "models/a.sql" }),
        inlineAt(2, { file: "models/b.sql", startLine: 9 }),
        inlineAt(3, { file: "models/b.sql", startLine: 2 }),
        inlineAt(4, { severity: "critical", category: "lineage_breakage", file: "models/z.sql" }),
      ],
      tier: "lite",
      mode: "comment",
    })
    expect(inlineComments(env).comments.map((c) => `${c.path}:${c.line}`)).toEqual([
      "models/z.sql:3",
      "models/b.sql:2",
      "models/b.sql:9",
      "models/a.sql:3",
    ])
  })

  test("the envelope's posting policy sets the budget and floor", () => {
    const env = buildEnvelope({
      findings: [inlineAt(1), inlineAt(2), inlineAt(3, { severity: "suggestion" })],
      tier: "lite",
      mode: "comment",
      policy: { source: "base", hash: "h", posting: { inlineBudget: 1, inlineSeverityFloor: "suggestion", silentWhenClean: true } },
    })
    const { comments, deferred } = inlineComments(env)
    expect(comments).toHaveLength(1)
    expect(deferred).toHaveLength(2)
  })

  test("local output renders every finding in full", () => {
    const env = buildEnvelope({ findings: [inlineAt(1, { body: "the detail" })], tier: "lite", mode: "comment" })
    expect(renderSummary(env)).not.toContain("the detail")
    expect(renderSummary(env, { inline: false })).toContain("the detail")
  })
})

describe("output form", () => {
  const head = "select\n  id\n  , new_col\n  , other_col\n\nfrom src"
  const added = new Map([["models/m.sql", new Set([3, 4])]])
  const getContent = async () => head
  const withSuggestion = (startLine: number, endLine: number, replacement: string) =>
    finding({
      severity: "warning",
      category: "sql_quality",
      title: "m: ai finding",
      startLine,
      evidence: { tool: "ai-review", result: {} },
      suggestion: { startLine, endLine, replacement },
    })

  test("a valid suggestion renders a suggestion fence over its line range", async () => {
    const [f] = await validateSuggestions([withSuggestion(3, 4, "  , new_col\n  , other_col_v2")], getContent, added)
    expect(f.suggestion).toBeDefined()
    const [c] = inlineComments(buildEnvelope({ findings: [f], tier: "lite", mode: "comment" })).comments
    expect(c.body).toContain("```suggestion\n  , new_col\n  , other_col_v2\n```")
    expect({ start_line: c.start_line, start_side: c.start_side, line: c.line, side: c.side }).toEqual({
      start_line: 3,
      start_side: "RIGHT",
      line: 4,
      side: "RIGHT",
    })
  })

  test("a one-line suggestion sets only `line`", async () => {
    const [f] = await validateSuggestions([withSuggestion(3, 3, "  , new_col_v2")], getContent, added)
    const [c] = inlineComments(buildEnvelope({ findings: [f], tier: "lite", mode: "comment" })).comments
    expect(c.line).toBe(3)
    expect(c.start_line).toBeUndefined()
  })

  test("a range outside the added lines, past the file end, or unchanged degrades to a text block", async () => {
    const cases = [
      withSuggestion(2, 3, "  id\n  , x"), // line 2 is context, not added
      withSuggestion(3, 3, "  , new_col"), // replacement equals the current line
    ]
    const out = await validateSuggestions(cases, getContent, added)
    const past = await validateSuggestions(
      [withSuggestion(3, 4, "x")],
      async () => "select\n  id\n  , new_col",
      added,
    )
    for (const f of [...out, ...past]) {
      expect(f.suggestion).toBeUndefined()
      expect(f.body).toContain("Suggested fix:\n```sql\n")
      const [c] = inlineComments(buildEnvelope({ findings: [f], tier: "lite", mode: "comment" })).comments
      expect(c.body).not.toContain("```suggestion")
      expect(c.start_line).toBeUndefined()
    }
  })

  test("long bodies are clamped when rendered; the envelope keeps the full text", () => {
    const body = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} explains the problem.`).join(" ")
    const f = finding({ severity: "warning", category: "sql_quality", tier: "inline", startLine: 3, body })
    const env = buildEnvelope({ findings: [f], tier: "lite", mode: "comment" })
    expect(env.findings[0].body).toBe(body)
    const [c] = inlineComments(env).comments
    expect(c.body).not.toContain(body)
    expect(c.body).toContain("explains the problem.…")
    const clamped = clampBody(body)
    expect(clamped.length).toBeLessThanOrEqual(BODY_MAX_CHARS)
    expect(clamped.endsWith("problem.…")).toBe(true)
    expect(renderSummary(env, { inline: false })).toContain(clamped)
    expect(clampBody("short")).toBe("short")
  })

  test("a clamp inside a code fence closes the fence", () => {
    const body = "Use this instead:\n```sql\n" + "select a, b from t\n".repeat(60) + "```"
    const out = clampBody(body, 200)
    expect((out.match(/^```/gm) ?? []).length % 2).toBe(0)
  })

  test("the matched source line is quoted in inline comments and summary bullets", async () => {
    const sql = "select id from a\nwhere id not in (select id from b)"
    const env = await runReview({
      changedFiles: [{ path: "models/m.sql", status: "added", diff: `@@ -0,0 +1,2 @@\n+select id from a\n+where id not in (select id from b)\n` }],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["dbt_patterns"] },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner: {
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
      } as ReviewRunner,
      getContent: async () => sql,
      forceTier: "full",
    })
    const f = env.findings.find((x) => x.evidenceLine === "where id not in (select id from b)")
    expect(f).toBeDefined()
    const md = renderSummary(env, { inline: false })
    expect(md).toContain(`\`${f!.file}${f!.startLine ? `:${f!.startLine}` : ""}\` — \`where id not in (select id from b)\``)

    const g = finding({ severity: "warning", category: "sql_quality", tier: "inline", startLine: 3, evidenceLine: "  , new_col" })
    const [c] = inlineComments(buildEnvelope({ findings: [g], tier: "lite", mode: "comment" })).comments
    expect(c.body).toContain("`models/m.sql:3` — `, new_col`")
  })
})
