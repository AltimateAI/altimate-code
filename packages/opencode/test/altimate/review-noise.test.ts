import { describe, test, expect } from "bun:test"
import {
  anchorByEvidence,
  markPreExisting,
  scanDiffLines,
  walkDiffLines,
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
  commentableLines,
  findingMarker,
  inlineComments,
  postedFindingIds,
  renderSummary,
  SUMMARY_BUDGET_CHARS,
} from "../../src/altimate/review/format"
import { buildEnvelope } from "../../src/altimate/review/verdict"
import { verdictHeadline } from "../../src/altimate/review/format"
import { evaluateCatalog } from "../../src/altimate/review/rule-catalog"
import { detectModelPatterns } from "../../src/altimate/review/dbt-patterns"
import { classifyPostOutcome } from "../../src/altimate/review/telemetry"
import { postGitHubReview } from "../../src/altimate/review/post-github"
import { shouldSuppressPortability } from "../../src/altimate/review/run"
import { DEFAULT_RULE_TIERS, ruleTier, type RuleTier } from "../../src/altimate/review/rule-tiers"

/**
 * The PR comment must stay readable: inline comments land on real lines of the
 * PR's file and are not re-posted on every push, a rule repeated across many
 * models is one bullet, the comment has a size budget, and cross-engine
 * portability advice is dropped for a single-engine project.
 */

/** An inline-eligible finding: inline-tier rule at the default severity floor. */
const inlineFinding = (over: Partial<Parameters<typeof makeFinding>[0]> = {}): Finding =>
  finding({ tier: "inline", severity: "warning", ...over })

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

  test("a line outside the diff is not posted inline but keeps its location in the envelope", () => {
    const inDiff = inlineFinding({ startLine: 3, endLine: 3, title: "m: a" })
    const outside = inlineFinding({ startLine: 40, endLine: 40, title: "m: b" })
    const env = buildEnvelope({ findings: [inDiff, outside], tier: "lite", mode: "comment" })
    const commentable = new Map([["models/m.sql", commentableLines(DIFF)]])
    expect(inlineComments(env, new Set(), commentable).comments.map((c) => c.line)).toEqual([3])
    // Without diff information every line is attempted (the 422 fallback covers it).
    expect(inlineComments(env).comments.map((c) => c.line)).toEqual([3, 40])
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
    expect(md).not.toContain("`a_id`")
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

describe("postGitHubReview", () => {
  const BOT = "github-actions[bot]"
  const target = { token: "t", owner: "o", repo: "r", prNumber: 7 }
  const PATCH = DIFF.split("\n").slice(3).join("\n")

  function fakeOcto(
    opts: {
      reviews?: Array<{ body: string; user?: { login: string } }>
      listFails?: boolean
      files?: Array<{ filename: string; patch?: string }>
      createReview?: (call: number) => unknown
    } = {},
  ) {
    const reviewCalls: any[] = []
    const fail = async () => {
      throw new Error("listing failed")
    }
    const octo = {
      paginate: async (fn: (p: unknown) => unknown, p: unknown) => fn(p),
      rest: {
        issues: {
          listComments: async () => [],
          createComment: async () => ({ data: { id: 1, user: { login: BOT } } }),
          updateComment: async () => ({ data: { id: 1, user: { login: BOT } } }),
        },
        pulls: {
          listReviewComments: opts.listFails ? fail : async () => [],
          listReviews: opts.listFails ? fail : async () => opts.reviews ?? [],
          listFiles: opts.listFails ? fail : async () => opts.files ?? [{ filename: "models/m.sql", patch: PATCH }],
          get: async () => ({ data: { head: { sha: "abc" } } }),
          createReview: async (p: any) => {
            reviewCalls.push(p)
            const r = opts.createReview?.(reviewCalls.length)
            return r ?? { data: { id: 9 } }
          },
        },
      },
    }
    return { octo: octo as any, reviewCalls }
  }

  const noLine = buildEnvelope({ findings: [finding()], tier: "lite", mode: "comment" })

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
      findings: [inlineFinding({ startLine: 3, title: "m: a" }), inlineFinding({ startLine: 40, title: "m: b" })],
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
        inlineFinding({ startLine: 3, title: "m: a" }),
        inlineFinding({ startLine: 40, title: "m: b" }),
        inlineFinding({ file: "models/big.sql", startLine: 900, title: "big: c" }),
      ],
      tier: "lite",
      mode: "comment",
    })
    const { octo, reviewCalls } = fakeOcto({
      files: [{ filename: "models/m.sql", patch: PATCH }, { filename: "models/big.sql" }],
    })
    await postGitHubReview(env, target, octo)
    expect(reviewCalls[0].comments.map((c: { path: string; line: number }) => `${c.path}:${c.line}`)).toEqual([
      "models/big.sql:900",
      "models/m.sql:3",
    ])
  })

  test("when listing fails, everything is posted and nothing is skipped", async () => {
    const env = buildEnvelope({
      findings: [inlineFinding({ startLine: 3, title: "m: a" }), inlineFinding({ startLine: 40, title: "m: b" })],
      tier: "lite",
      mode: "comment",
    })
    const { octo, reviewCalls } = fakeOcto({ listFails: true, reviews: [{ body: verdictHeadline(env), user: { login: BOT } }] })
    const r = await postGitHubReview(env, target, octo)
    expect(r.reviewSkipped).toBeUndefined()
    expect(reviewCalls[0].comments.map((c: { line: number }) => c.line)).toEqual([3, 40])
  })

  test("a positioning 422 retries the review without inline comments", async () => {
    const env = buildEnvelope({ findings: [inlineFinding({ startLine: 3 })], tier: "lite", mode: "comment" })
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
    expect(r.inlineFellBack).toBe(true)
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
    expect(keys.filter((k) => DEFAULT_RULE_TIERS[k] === "inline")).toHaveLength(14)
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

describe("anchoring rule findings by their matched line", () => {
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

  // Head lines: 1 select id, 2 from t, 3 qualify (context), 4 qualify (added), 5 where x = 1, 6 qualify (added again)
  const QDIFF = [
    "@@ -1,3 +1,6 @@",
    " select id",
    " from t",
    " qualify row_number() over (partition by id order by d) = 1",
    "+  qualify row_number() over (partition by k order by d) = 1 -- latest",
    "+where x = 1",
    "+  qualify row_number() over (partition by k order by d) = 1 -- latest",
  ].join("\n")
  const file = { path: "models/m.sql", status: "modified" as const, diff: QDIFF }
  const withLine = (line: string) => finding({ evidence: { tool: "rule-catalog", result: { rule: "x", line } } })

  test("the hunk walker yields head-side lines that agree with scanDiffLines", () => {
    const rows = [...walkDiffLines(DIFF)]
    expect(rows.map((r) => `${r.kind}${r.line}`)).toEqual([" 1", " 2", "+3", "+4", " 5", " 6"])
    expect(rows[2].text).toBe("  , new_col")
    const { commentable, added } = scanDiffLines(DIFF)
    expect([...commentable]).toEqual(rows.map((r) => r.line))
    expect([...added]).toEqual(rows.filter((r) => r.kind === "+").map((r) => r.line))
  })

  test("a catalog rule records the raw added line, not the comment-stripped one", () => {
    const added = ["select id from t", "  qualify row_number() over (partition by k order by d) = 1 -- latest"]
    const f = evaluateCatalog(file, added.join("\n"), added, [], DEFAULT_RUBRIC).find(
      (x) => (x.evidence?.result as { rule?: string }).rule === "qualify-unsupported",
    )
    expect((f!.evidence!.result as { line?: string }).line).toBe(added[1])
  })

  test("a finding whose text is on an added line gets that line, and it posts inline when its rule is inline-tier", () => {
    const [f] = anchorByEvidence([withLine("  qualify row_number() over (partition by k order by d) = 1 -- latest")], [file])
    expect(f.startLine).toBe(4)
    expect(f.endLine).toBe(4)
    const [g] = markPreExisting([{ ...f, severity: "warning", tier: "inline" }], [file])
    expect(g.preExisting).toBeUndefined()
    const { comments } = inlineComments(buildEnvelope({ findings: [g], tier: "lite", mode: "comment" }))
    expect(comments.map((c) => c.line)).toEqual([4])
  })

  test("text only on a context line anchors there and is marked pre-existing", () => {
    const [f] = markPreExisting(anchorByEvidence([withLine("qualify row_number() over (partition by id order by d) = 1")], [file]), [file])
    expect(f.startLine).toBe(3)
    expect(f.preExisting).toBe(true)
  })

  test("text absent from the diff leaves the finding without a line", () => {
    const [f] = anchorByEvidence([withLine("select something_else from nowhere")], [file])
    expect(f.startLine).toBeUndefined()
    const [g] = anchorByEvidence([withLine("where x = 1")], [{ ...file, path: "models/other.sql" }])
    expect(g.startLine).toBeUndefined()
  })

  test("duplicate added lines anchor to the first; surrounding whitespace is ignored", () => {
    const [f] = anchorByEvidence([withLine("\tqualify row_number() over (partition by k order by d) = 1 -- latest   ")], [file])
    expect(f.startLine).toBe(4)
  })

  test("a long fragment matches inside an added line; a short one does not", () => {
    const [long] = anchorByEvidence([withLine("over (partition by k order by d)")], [file])
    expect(long.startLine).toBe(4)
    const [short] = anchorByEvidence([withLine("x = 1 --")], [file])
    expect(short.startLine).toBeUndefined()
  })

  test("a finding that already has a line keeps it", () => {
    const [f] = anchorByEvidence([{ ...withLine("where x = 1"), startLine: 1, endLine: 1 }], [file])
    expect(f.startLine).toBe(1)
  })

  test("a dbt-patterns detector's recorded line anchors", () => {
    const diff = "@@ -1,2 +1,3 @@\n select id from a\n+where id not in (select id from b)\n from_here\n"
    const changed = { path: "models/m.sql", status: "modified" as const, diff }
    const found = detectModelPatterns(changed, "select id from a\nwhere id not in (select id from b)\n", DEFAULT_RUBRIC)
    const notIn = found.find((f) => (f.evidence?.result as { rule?: string }).rule === "not_in_nullable")
    expect(notIn).toBeDefined()
    expect(anchorByEvidence([notIn!], [changed])[0].startLine).toBe(2)
  })

  test("the dedup detector records the added line that opens the window", () => {
    const sql = "select *\nfrom (\n  select *, row_number() over (\n    partition by id\n  ) as rn\n  from t\n)\nwhere rn = 1\n"
    const diff = "@@ -0,0 +1,8 @@\n" + sql.trimEnd().split("\n").map((l) => `+${l}`).join("\n") + "\n"
    const changed = { path: "models/m.sql", status: "added" as const, diff }
    const f = detectModelPatterns(changed, sql, DEFAULT_RUBRIC).find(
      (x) => (x.evidence?.result as { rule?: string }).rule === "dedup_no_tiebreaker",
    )
    expect((f!.evidence!.result as { line?: string }).line).toBe("  select *, row_number() over (")
    expect(anchorByEvidence([f!], [changed])[0].startLine).toBe(3)
  })

  test("end to end: an inline-tier catalog rule becomes an inline comment on its line", async () => {
    const sql = "select id\nfrom t\nqualify row_number() over (partition by id order by d desc) = 1\n"
    const env = await runReview({
      changedFiles: [
        {
          path: "models/m.sql",
          status: "modified",
          diff: "@@ -1,2 +1,3 @@\n select id\n from t\n+qualify row_number() over (partition by id order by d desc) = 1\n",
        },
      ],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["dbt_patterns"], dialect: "postgres" },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      getContent: async () => sql,
      forceTier: "full",
    })
    const f = env.findings.find((x) => x.rule === "rule-catalog:qualify-unsupported")
    expect(f).toBeDefined()
    expect(f!.tier).toBe("inline")
    expect(f!.startLine).toBe(3)
    expect(f!.preExisting).toBeUndefined()
    const { comments } = inlineComments(env)
    expect(comments.find((c) => c.body.includes(findingMarker(f!.id)))?.line).toBe(3)
  })

  test("a core check issue on a Jinja model anchors by its compiled line's text", async () => {
    const raw = "with o as (\n  select * from {{ ref('orders') }}\n)\nselect *,\n  row_number() over (partition by order_id order by ordered_at desc) as rn\nfrom o\n"
    const compiled = "with o as (\n\n  select * from \"db\".\"main\".\"orders\"\n\n)\nselect *,\n  row_number() over (partition by order_id order by ordered_at desc) as rn\nfrom o\n"
    const diff = "@@ -1,4 +1,6 @@\n with o as (\n   select * from {{ ref('orders') }}\n )\n-select * from o\n+select *,\n+  row_number() over (partition by order_id order by ordered_at desc) as rn\n+from o\n"
    const review = (line: number) =>
      runReview({
        changedFiles: [{ path: "models/m.sql", status: "modified", diff }],
        config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["sql_quality"] },
        rubric: DEFAULT_RUBRIC,
        mode: "comment",
        runner: {
          ...runner,
          async check() {
            return { issues: [{ rule: "non_deterministic_dedup", message: "ROW_NUMBER() orders only by time", line, severity: "warning" }], ran: true }
          },
        } as ReviewRunner,
        getContent: async () => raw,
        getCompiled: async () => compiled,
        forceTier: "full",
      })
    const dedup = (env: Awaited<ReturnType<typeof review>>) => env.findings.find((x) => x.rule === "altimate-core.check:non-deterministic-dedup")
    // Compiled line 7 is the window: found on head line 5 of the raw file.
    expect(dedup(await review(7))?.startLine).toBe(5)
    // Compiled line 3 (the expanded ref) is not in the raw file; line 5 (`)`) is too short to be specific.
    for (const line of [3, 5]) {
      const f = dedup(await review(line))
      expect(f).toBeDefined()
      expect(f!.startLine).toBeUndefined()
    }
  })
})
