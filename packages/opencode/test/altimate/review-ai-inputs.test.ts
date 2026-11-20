import { describe, test, expect, spyOn, mock, afterEach } from "bun:test"
import { runReview, type ReviewRunner } from "../../src/altimate/review/orchestrate"
import { DEFAULT_REVIEW_CONFIG } from "../../src/altimate/review/config"
import { DEFAULT_RUBRIC } from "../../src/altimate/review/rubric"
import {
  addUsage,
  aiInputBudget,
  batchAiFiles,
  buildUserMessage,
  excerptDiff,
  excerptFile,
  laneUsage,
  planAiInput,
  runAiReview,
  selectAiFiles,
  selectAiFilesByQuota,
  streamUsage,
  type AiLaneStatus,
  type AiReviewFile,
  type AiReviewInput,
} from "../../src/altimate/review/ai-review"
import { renderContextCard, type ModelCard } from "../../src/altimate/review/ai-context-card"
import { defaultPromptInput } from "./fixtures/review-ai-prompt-input"
import { inlineComments, renderSummary } from "../../src/altimate/review/format"
import { makeFinding } from "../../src/altimate/review/finding"
import { emitReviewRun } from "../../src/altimate/review/telemetry"
import { Telemetry } from "../../src/altimate/telemetry"
import { createDispatcherRunner } from "../../src/altimate/review/runner"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import type { ChangedFile } from "../../src/altimate/review/diff-filter"

/**
 * Defects in macros, singular tests and yml never show in a model diff, so the
 * advisory lane receives every changed dbt file, each labeled with its role.
 */

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
    return { decided: true, equivalent: true }
  },
  async detectPii() {
    return { columns: [] }
  },
} as ReviewRunner

const FILES: Record<string, string> = {
  "models/marts/m.sql": "select 2 as id",
  "macros/to_cents.sql": "{% macro to_cents(c) %}round({{ c }} * 100){% endmacro %}",
  "models/marts/_marts.yml": "models:\n  - name: m\n    columns:\n      - name: id\n",
  "tests/assert_positive.sql": "select * from {{ ref('m') }} where id < 0",
  "seeds/country_codes.csv": "code,name\nUS,United States\n",
}

async function aiInputFor(changed: ChangedFile[]): Promise<AiReviewInput | undefined> {
  let seen: AiReviewInput | undefined
  await runReview({
    changedFiles: changed,
    config: { ...DEFAULT_REVIEW_CONFIG },
    rubric: DEFAULT_RUBRIC,
    mode: "comment",
    runner,
    getContent: async (f, side) => (side === "old" ? undefined : FILES[f]),
    generatedAt: "2026-11-14T00:00:00Z",
    aiReview: async (input) => {
      seen = input
      return { findings: [], status: { state: "ok" } }
    },
  })
  return seen
}

const mod = (path: string, diff = "+x\n"): ChangedFile => ({ path, status: "modified", diff })

describe("files sent to the advisory AI lane", () => {
  test("macros, singular tests, yml and seeds go with the model, labeled by role", async () => {
    const input = await aiInputFor(Object.keys(FILES).map((p) => mod(p)))
    const byPath = new Map(input!.files.map((f) => [f.path, f]))
    expect([...byPath.keys()].sort()).toEqual(Object.keys(FILES).sort())
    expect(byPath.get("macros/to_cents.sql")).toMatchObject({ kind: "macro", sql: FILES["macros/to_cents.sql"] })
    expect(byPath.get("tests/assert_positive.sql")?.kind).toBe("test")
    expect(byPath.get("models/marts/_marts.yml")).toMatchObject({ kind: "schema_yml", sql: FILES["models/marts/_marts.yml"] })
    // A seed goes as its diff only.
    expect(byPath.get("seeds/country_codes.csv")).toMatchObject({ kind: "seed", sql: undefined })
  })

  test("a macro-only PR reaches the lane instead of being skipped", async () => {
    const input = await aiInputFor([mod("macros/to_cents.sql", "-round({{ c }})\n+round({{ c }} * 100)\n")])
    expect(input?.files.map((f) => f.path)).toEqual(["macros/to_cents.sql"])
  })

  test("profiles.yml is never sent: it holds warehouse credentials", async () => {
    const input = await aiInputFor([
      mod("models/marts/m.sql"),
      mod("dbt_project.yml"),
      mod("profiles.yml", "+      password: hunter2\n"),
      mod("config/profiles.yaml", "+      token: abc\n"),
    ])
    const paths = input!.files.map((f) => f.path)
    expect(paths).toContain("dbt_project.yml")
    expect(paths.some((p) => /profiles\.ya?ml$/.test(p))).toBe(false)
    expect(JSON.stringify(input)).not.toContain("hunter2")
  })

  test("an explicit summary tier keeps an AI finding out of the inline comments", async () => {
    const run = (rules: Record<string, "inline" | "summary" | "off">) =>
      runReview({
        changedFiles: [mod("models/marts/m.sql", "@@ -0,0 +1 @@\n+select 2 as id\n")],
        config: { ...DEFAULT_REVIEW_CONFIG, rules },
        rubric: DEFAULT_RUBRIC,
        mode: "comment",
        runner,
        getContent: async (f, side) => (side === "old" ? undefined : FILES[f]),
        generatedAt: "2026-11-14T00:00:00Z",
        forceTier: "full",
        aiReview: async () => ({
          findings: [
            makeFinding({
              severity: "warning",
              category: "sql_quality",
              title: "m: ai finding",
              body: "why",
              file: "models/marts/m.sql",
              model: "m",
              startLine: 1,
              rule: "ai-review:sql-quality",
              evidence: { tool: "ai-review", result: {} },
            }),
          ],
          status: { state: "ok" },
        }),
      })
    const byDefault = await run({})
    expect(byDefault.findings.find((f) => f.rule === "ai-review:sql-quality")?.tier).toBe("inline")
    expect(inlineComments(byDefault).comments).toHaveLength(1)
    const summary = await run({ "ai-review:*": "summary" })
    expect(summary.findings.find((f) => f.rule === "ai-review:sql-quality")?.tier).toBe("summary")
    expect(inlineComments(summary).comments).toHaveLength(0)
  })

  test("files past the AI file cap are not marked reviewed in the ledger", async () => {
    const seeds = Array.from({ length: 21 }, (_, i) => mod(`seeds/s${String(i).padStart(2, "0")}.csv`, "+a,b\n"))
    const env = await runReview({
      changedFiles: seeds,
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      getContent: async () => undefined,
      generatedAt: "2026-11-14T00:00:00Z",
      forceTier: "full",
      aiReview: async () => ({ findings: [], status: { state: "ok" } }),
    })
    expect(env.scope?.notReviewed?.map((e) => e.path)).toEqual(["seeds/s20.csv"])
    expect(renderSummary(env)).toContain("Not reviewed: 1 file(s)")
  })

  test("a partial AI failure is shown even when the lane state is ok", async () => {
    const env = await runReview({
      changedFiles: [mod("models/marts/m.sql")],
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      getContent: async (f, side) => (side === "old" ? undefined : FILES[f]),
      generatedAt: "2026-11-14T00:00:00Z",
      forceTier: "full",
      aiReview: async () => ({ findings: [], status: { state: "ok", reason: "1 of 2 calls failed: timed out" } }),
    })
    const md = renderSummary(env)
    expect(md).toContain("Advisory AI review partly failed: 1 of 2 calls failed: timed out.")
  })

  test("deleted files are not sent", async () => {
    const input = await aiInputFor([mod("models/marts/m.sql"), { path: "macros/old.sql", status: "deleted", diff: "-x\n" }])
    expect(input?.files.some((f) => f.path === "macros/old.sql")).toBe(false)
  })
})

describe("selection and prompt layout", () => {
  const f = (path: string, kind: string, status = "modified"): AiReviewFile => ({ path, status, kind, model: path, diff: "+x\n" })

  test("models first, then macros, tests, yml; deleted dropped; capped at 20", () => {
    const files = [
      f("_s.yml", "schema_yml"),
      f("t.sql", "test"),
      f("gone.sql", "macro", "deleted"),
      f("mac.sql", "macro"),
      ...Array.from({ length: 19 }, (_, i) => f(`m${i}.sql`, "model_sql")),
    ]
    const picked = selectAiFiles(files).map((x) => x.path)
    expect(picked).toHaveLength(20)
    expect(picked.slice(0, 19).every((p) => /^m\d+\.sql$/.test(p))).toBe(true)
    expect(picked[19]).toBe("mac.sql")
  })

  test("each file's header names its role and its content is fenced by type", () => {
    const msg = buildUserMessage({
      grounding: [],
      files: [
        { path: "macros/m.sql", status: "modified", kind: "macro", model: "m", sql: "{% macro m() %}1{% endmacro %}" },
        { path: "models/_s.yml", status: "added", kind: "schema_yml", model: "_s.yml", sql: "models: []" },
        { path: "models/a.sql", status: "modified", model: "a", sql: "select 1" },
      ],
    })
    expect(msg).toContain("### macros/m.sql (modified, macro (Jinja; changes every model that calls it))")
    expect(msg).toContain("### models/_s.yml (added, schema yml (tests, contracts, descriptions))\nCurrent file:\n```yaml")
    expect(msg).toContain("### models/a.sql (modified)\nCurrent SQL:\n```sql")
  })
})


describe("input budget: more of the PR, split across calls instead of cut", () => {
  const file = (p: string, n: number): AiReviewFile => ({ path: p, status: "modified", model: p, sql: "x".repeat(n) })

  test("defaults keep one bounded call; the env widens files, length and splits calls", () => {
    expect(aiInputBudget({})).toEqual({ maxFiles: 20, maxFileChars: 6_000, batchChars: Infinity })
    expect(
      aiInputBudget({ ALTIMATE_REVIEW_AI_MAX_FILES: "200", ALTIMATE_REVIEW_AI_MAX_FILE_CHARS: "40000", ALTIMATE_REVIEW_AI_BATCH_CHARS: "60000" }),
    ).toEqual({ maxFiles: 200, maxFileChars: 40_000, batchChars: 60_000 })
    expect(aiInputBudget({ ALTIMATE_REVIEW_AI_MAX_FILES: "nope" }).maxFiles).toBe(20)
  })

  test("a file longer than the default limit is sent whole under a wider limit", () => {
    const f = file("models/big.sql", 10_000)
    expect(buildUserMessage({ grounding: [], files: [f] })).toContain("… (truncated)")
    expect(buildUserMessage({ grounding: [], files: [f] }, 40_000)).not.toContain("… (truncated)")
  })

  test("files are grouped in order under the per-call size; an oversized file goes alone", () => {
    const budget = { maxFiles: 100, maxFileChars: 40_000, batchChars: 25_000 }
    const batches = batchAiFiles([file("a", 10_000), file("b", 10_000), file("c", 10_000), file("d", 30_000), file("e", 1_000)], budget)
    expect(batches.map((b) => b.map((f) => f.path))).toEqual([["a", "b"], ["c"], ["d"], ["e"]])
    expect(batchAiFiles([file("a", 10), file("b", 10)], { ...budget, batchChars: Infinity })).toHaveLength(1)
  })
})

describe("graph context: the changed files' unchanged dbt parents", () => {
  test("the related section lists only parents of the files in this call", () => {
    const msg = buildUserMessage({
      grounding: [],
      files: [{ path: "models/fct.sql", status: "modified", model: "fct", sql: "select 1" }],
      context: [
        { path: "models/stg.sql", kind: "model", name: "stg", forPaths: ["models/fct.sql"], content: "select id, closed_at from raw" },
        { path: "seeds/codes.csv", kind: "seed", name: "codes", forPaths: ["models/other.sql"], content: "code\nUS" },
      ],
    })
    expect(msg).toContain("## RELATED FILES")
    expect(msg).toContain("### models/stg.sql (model `stg`, used by models/fct.sql)")
    expect(msg).not.toContain("seeds/codes.csv")
    expect(buildUserMessage({ grounding: [], files: [{ path: "models/fct.sql", status: "modified", model: "fct" }] })).not.toContain(
      "RELATED FILES",
    )
  })

  test("graphParents: models, seeds, sources (with columns) and project macros; a yml maps through its tests", async () => {
    await using tmp = await tmpdir()
    const manifestPath = path.join(tmp.path, "manifest.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        metadata: { project_name: "shop" },
        nodes: {
          "model.shop.fct": {
            resource_type: "model", name: "fct", original_file_path: "models/fct.sql",
            depends_on: { nodes: ["model.shop.stg", "seed.shop.codes", "source.shop.raw.orders", "model.pkg.calendar", "source.pkg.ext.events"], macros: ["macro.shop.cents", "macro.dbt_utils.star"] },
          },
          "model.shop.stg": { resource_type: "model", name: "stg", original_file_path: "models/stg.sql", depends_on: { nodes: [] } },
          // Installed-package nodes: their paths are relative to the package, not the project.
          "model.pkg.calendar": { resource_type: "model", name: "calendar", package_name: "pkg", original_file_path: "models/calendar.sql", depends_on: { nodes: [] } },
          "seed.shop.codes": { resource_type: "seed", name: "codes", original_file_path: "seeds/codes.csv", depends_on: { nodes: [] } },
          "test.shop.unique_stg_id": {
            resource_type: "test", name: "unique_stg_id", original_file_path: "models/_schema.yml", depends_on: { nodes: ["model.shop.stg"] },
          },
        },
        sources: {
          "source.pkg.ext.events": { source_name: "ext", name: "events", package_name: "pkg", original_file_path: "models/src.yml" },
          "source.shop.raw.orders": { source_name: "raw", name: "orders", original_file_path: "models/_sources.yml", columns: { id: {}, status: {} } },
        },
        macros: {
          "macro.shop.cents": { name: "cents", package_name: "shop", original_file_path: "macros/cents.sql" },
          "macro.dbt_utils.star": { name: "star", package_name: "dbt_utils", original_file_path: "macros/sql/star.sql" },
        },
      }),
    )
    const runner = createDispatcherRunner({ manifestPath })
    const parents = await runner.graphParents!(["proj/models/fct.sql", "proj/models/_schema.yml"])
    const byName = Object.fromEntries(parents.map((p) => [p.name, p]))
    expect(Object.keys(byName).sort()).toEqual(["cents", "codes", "raw.orders", "stg"])
    expect(byName.stg.path).toBe("proj/models/stg.sql")
    expect(byName.stg.forPaths.sort()).toEqual(["proj/models/_schema.yml", "proj/models/fct.sql"])
    expect(byName["raw.orders"].columns).toEqual(["id", "status"])
    expect(byName.codes.kind).toBe("seed")
  })

  test("the orchestrator sends parents only when graph context is on", async () => {
    let seen: AiReviewInput | undefined
    const withGraph = {
      ...runner,
      async graphParents() {
        return [{ path: "models/stg.sql", kind: "model", name: "stg", forPaths: ["models/marts/m.sql"] }]
      },
    } as ReviewRunner
    const run = (aiGraphContext: boolean) =>
      runReview({
        changedFiles: [mod("models/marts/m.sql")],
        config: { ...DEFAULT_REVIEW_CONFIG },
        rubric: DEFAULT_RUBRIC,
        mode: "comment",
        runner: withGraph,
        aiGraphContext,
        forceTier: "full",
        getContent: async (f, side) => (side === "old" ? undefined : f === "models/stg.sql" ? "select id from raw" : FILES[f]),
        generatedAt: "2026-11-14T00:00:00Z",
        aiReview: async (input) => {
          seen = input
          return { findings: [], status: { state: "ok" } }
        },
      })
    await run(false)
    expect(seen?.context).toBeUndefined()
    await run(true)
    expect(seen?.context?.map((c) => [c.path, c.content])).toEqual([["models/stg.sql", "select id from raw"]])
  })
})

describe("token and cost accounting", () => {
  afterEach(() => mock.restore())

  const model = { api: { npm: "@ai-sdk/openai" }, cost: { input: 1, output: 4, cache: { read: 0.5, write: 0 } } } as any
  const fakeStream = (usage: unknown, metadata: unknown = undefined) => ({
    totalUsage: Promise.resolve(usage),
    providerMetadata: Promise.resolve(metadata),
  })

  test("a drained stream's usage becomes tokens and cost with the session's rules", async () => {
    const u = await streamUsage(
      fakeStream({ inputTokens: 1_000, outputTokens: 200, totalTokens: 1_200, reasoningTokens: 50, cachedInputTokens: 400 }),
      model,
    )
    // OpenAI-style input includes cached tokens: input = 1000 - 400.
    expect(u!.tokens).toEqual({ input: 600, inputTotal: 1_000, output: 200, reasoning: 50, cacheRead: 400 })
    // (600·1 + 200·4 + 400·0.5 + 50·4) / 1e6
    expect(u!.cost).toBeCloseTo(0.0018, 10)
  })

  test("missing or failing usage never fails the lane", async () => {
    expect(await streamUsage(fakeStream(undefined), model)).toBeUndefined()
    const rejected = { totalUsage: Promise.reject(new Error("no usage")), providerMetadata: Promise.resolve(undefined) }
    expect(await streamUsage(rejected, model)).toBeUndefined()
  })

  test("batches sum; calls count every batch, even one without usage", () => {
    const a = { tokens: { input: 1, inputTotal: 2, output: 3, reasoning: 0, cacheRead: 1 }, cost: 0.1 }
    const b = { tokens: { input: 10, inputTotal: 20, output: 30, reasoning: 5, cacheRead: 10 }, cost: 0.2 }
    const sum = addUsage(a, b)
    expect(sum.tokens).toEqual({ input: 11, inputTotal: 22, output: 33, reasoning: 5, cacheRead: 11 })
    expect(sum.cost).toBeCloseTo(0.3, 10)
    const lane = laneUsage([{ usage: a }, { usage: b }, {}])
    expect(lane.calls).toBe(3)
    expect(lane.tokens).toEqual({ input: 11, inputTotal: 22, output: 33, reasoning: 5, cacheRead: 11 })
    expect(laneUsage([{}, {}])).toEqual({ calls: 2 })
  })

  test("the lane's tokens reach the envelope, the footer and the review_run event", async () => {
    const status: AiLaneStatus = {
      state: "ok",
      model: "anthropic/claude",
      tokens: { input: 900, inputTotal: 1_500, output: 300, reasoning: 0, cacheRead: 600 },
      cost: 0.0123,
      calls: 2,
    }
    const env = await runReview({
      changedFiles: [mod("models/marts/m.sql")],
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      getContent: async (f, side) => (side === "old" ? undefined : FILES[f]),
      generatedAt: "2026-11-14T00:00:00Z",
      forceTier: "full",
      aiReview: async () => ({ findings: [], status }),
    })
    expect(env.ai).toMatchObject({ tokens: status.tokens, cost: 0.0123, calls: 2 })
    expect(renderSummary(env, { allowSilent: false })).toContain("· tokens 1,800")

    const events: Telemetry.Event[] = []
    spyOn(Telemetry, "track").mockImplementation((e: Telemetry.Event) => {
      events.push(e)
    })
    emitReviewRun({ invocation: "cli", durationMs: 1, sessionID: "", envelope: env })
    expect(events[0]).toMatchObject({
      type: "review_run",
      ai_tokens_total: 1_800,
      ai_tokens_input: 1_500,
      ai_tokens_output: 300,
      ai_cost: 0.0123,
      ai_calls: 2,
    })
  })
})

describe("verifier evidence (opt-in)", () => {
  const aiFinding = {
    id: "f_ai",
    severity: "warning" as const,
    category: "sql_correctness" as const,
    title: "m: t",
    body: "b",
    file: "models/marts/m.sql",
    confidence: "medium" as const,
    degraded: false,
    evidence: { tool: "ai-review", result: { confidence: "medium" } },
    rule: "ai-review:sql-correctness",
  }
  const run = (aiVerify: boolean | undefined, seen: { input?: AiReviewInput }) =>
    runReview({
      changedFiles: [mod("models/marts/m.sql", "@@ -1 +1 @@\n-select 1 as id\n+select 2 as id\n")],
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      forceTier: "full",
      ...(aiVerify === undefined ? {} : { aiVerify }),
      getContent: async (f, side) => (side === "old" ? "select 1 as id" : FILES[f]),
      generatedAt: "2026-11-14T00:00:00Z",
      aiReview: async (input) => {
        seen.input = input
        return { findings: [aiFinding], status: { state: "ok" } }
      },
    })

  test("without aiVerify the lane gets no evidence and the envelope is unchanged", async () => {
    const off: { input?: AiReviewInput } = {}
    const on: { input?: AiReviewInput } = {}
    const envOff = await run(undefined, off)
    const envOn = await run(true, on)
    expect("evidence" in off.input!).toBe(false)
    expect(on.input!.evidence).toBeDefined()
    // A lane that ignores the evidence produces the same envelope either way.
    expect(JSON.stringify(envOn)).toBe(JSON.stringify(envOff))
    expect(envOff.ai).toEqual({ state: "ok" })
    expect(envOff.findings.map((f) => f.id)).toContain("f_ai")
  })

  test("the evidence reads engine SQL, numbered file slices and the diff's added lines", async () => {
    const seen: { input?: AiReviewInput } = {}
    await run(true, seen)
    const ev = seen.input!.evidence!
    expect(await ev.compiledSql("models/marts/m.sql", "new")).toBe("select 2 as id")
    expect(await ev.compiledSql("models/marts/m.sql", "old")).toBe("select 1 as id")
    expect(await ev.readFile("models/marts/m.sql", "new", 1, 1)).toBe("1: select 2 as id")
    expect([...ev.addedLines.get("models/marts/m.sql")!]).toEqual([1])
    expect(ev.files.map((f) => f.path)).toEqual(["models/marts/m.sql"])
    expect(ev.dialect).toBe(DEFAULT_REVIEW_CONFIG.dialect)
  })
})

describe("input coverage (opt-in ALTIMATE_REVIEW_AI_COVERAGE=1)", () => {
  const COVERAGE = { ALTIMATE_REVIEW_AI_COVERAGE: "1" }
  const f = (path: string, kind: string, changed = 1): AiReviewFile => ({
    path,
    status: "modified",
    kind,
    model: path,
    diff: "@@ -1,1 +1,1 @@\n" + "+x\n".repeat(changed),
  })

  test("with both switches unset the prompt is byte-identical to the pre-change snapshot", () => {
    const input = defaultPromptInput()
    const messages = [{}, { ALTIMATE_REVIEW_AI_BATCH_CHARS: "12000" }].flatMap((env) => planAiInput(input, env).messages)
    const snapshot = readFileSync(path.join(import.meta.dir, "fixtures/review-ai-prompt-default.txt"), "utf8")
    expect(messages.join("\n=====BATCH=====\n")).toBe(snapshot)
    // Default selection is the old cap; nothing is recorded as unsent to the AI on the envelope.
    expect(planAiInput(input, {}).files).toEqual(selectAiFiles(input.files))
  })

  test("30 models + 3 macros + 2 yml: every macro and yml goes, models fill the rest up to 30", () => {
    const models = Array.from({ length: 30 }, (_, i) => f(`m${i}.sql`, "model_sql", i + 1))
    const files = [...models, f("a.sql", "macro"), f("b.sql", "macro"), f("c.sql", "macro"), f("_a.yml", "schema_yml"), f("_b.yml", "source_yml")]
    const { sent, unsent } = selectAiFilesByQuota(files)
    expect(sent).toHaveLength(30)
    const paths = sent.map((x) => x.path)
    for (const p of ["a.sql", "b.sql", "c.sql", "_a.yml", "_b.yml"]) expect(paths).toContain(p)
    // Most-changed models first; the five least-changed are left out.
    expect(paths.slice(0, 3)).toEqual(["m29.sql", "m28.sql", "m27.sql"])
    expect(unsent.map((x) => x.path)).toEqual(["m0.sql", "m1.sql", "m2.sql", "m3.sql", "m4.sql"])
    // Today's cap would have sent no macro at all.
    expect(selectAiFiles(files).some((x) => x.kind === "macro")).toBe(false)
  })

  test("unused quota flows to other kinds; env overrides the quotas", () => {
    const files = [...Array.from({ length: 40 }, (_, i) => f(`m${i}.sql`, "model_sql")), f("mac.sql", "macro")]
    const { sent } = selectAiFilesByQuota(files)
    expect(sent.filter((x) => x.kind === "model_sql")).toHaveLength(29)
    expect(sent.map((x) => x.path)).toContain("mac.sql")
    const budget = aiInputBudget({ ...COVERAGE, ALTIMATE_REVIEW_AI_QUOTA_MODEL: "2", ALTIMATE_REVIEW_AI_QUOTA_MACRO: "1", ALTIMATE_REVIEW_AI_QUOTA_TEST: "1", ALTIMATE_REVIEW_AI_QUOTA_YML: "1" })
    expect(budget.coverage?.quotas).toEqual({ model: 2, macro: 1, test: 1, yml: 1 })
    expect(selectAiFilesByQuota(files, budget.coverage!.quotas).sent).toHaveLength(5)
    expect(aiInputBudget({}).coverage).toBeUndefined()
  })

  test("coverage bounds the per-call size by default; the env still overrides it", () => {
    expect(aiInputBudget(COVERAGE).batchChars).toBe(120_000)
    expect(aiInputBudget({ ...COVERAGE, ALTIMATE_REVIEW_AI_BATCH_CHARS: "50000" }).batchChars).toBe(50_000)
    expect(aiInputBudget({}).batchChars).toBe(Infinity)
    // 30 files with ~16k-char diffs no longer land in one call.
    const diff = "@@ -1,200 +1,200 @@\n" + ("+" + "x".repeat(79) + "\n").repeat(200)
    const big = Array.from({ length: 30 }, (_, i) => ({ ...f(`m${i}.sql`, "model_sql"), diff }))
    expect(batchAiFiles(big, aiInputBudget(COVERAGE)).length).toBeGreaterThan(1)
  })

  test("a 20k-char file with one hunk near char 15k: the hunk and its ±20-line window are sent", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `  , col_${String(i + 1).padStart(3, "0")} as alias_${String(i + 1).padStart(3, "0")} -- padding text, more padding`)
    lines[299] = "  , amount / 0 as broken_ratio"
    const sql = lines.join("\n")
    expect(sql.length).toBeGreaterThan(19_000)
    expect(sql.indexOf("broken_ratio")).toBeGreaterThan(14_000)
    const diff = "@@ -298,5 +298,5 @@\n" + [lines[297], lines[298]].map((l) => " " + l).join("\n") + "\n-  , amount as ratio\n+" + lines[299] + "\n " + lines[300] + "\n " + lines[301] + "\n"
    const file: AiReviewFile = { path: "models/wide.sql", status: "modified", model: "wide", diff, sql }
    // Today: the head cut drops the changed line.
    const today = buildUserMessage({ grounding: [], files: [file] })
    expect(today.slice(today.indexOf("Current SQL"))).not.toContain("broken_ratio")
    const msg = buildUserMessage({ grounding: [], files: [file] }, 6_000, true)
    const current = msg.slice(msg.indexOf("Current SQL"))
    expect(current).toContain(lines[279]) // line 280
    expect(current).toContain(lines[319]) // line 320
    expect(current).toContain("broken_ratio")
    const markers = [...current.matchAll(/… \(lines (\d+)–(\d+) omitted\)/g)].map((m) => [Number(m[1]), Number(m[2])])
    expect(markers.length).toBe(2)
    // The head fills the budget up to the first gap; the gap ends at line 279; the tail runs to the last line.
    expect(markers[0][1]).toBe(279)
    expect(markers[1]).toEqual([321, 400])
    expect(excerptFile(sql, diff, 6_000).text.length).toBeLessThanOrEqual(6_000)
  })

  test("compiled SQL: windows follow the changed text, not the raw diff's line numbers", () => {
    // Raw: the change is on line 12. Compiled: a Jinja loop above it expands into 300 lines.
    const raw = ["select", ...Array.from({ length: 9 }, (_, i) => `  , c${i}`), "  {% for x in xs %} , {{ x }} {% endfor %}", "  , amount / nullif(qty, 0) as unit_price", "from t"]
    const diff = "@@ -11,3 +11,3 @@\n " + raw[10] + "\n-  , amount / qty as unit_price\n+" + raw[11] + "\n " + raw[12] + "\n"
    const expanded = Array.from({ length: 300 }, (_, i) => `  , expanded_column_${String(i).padStart(3, "0")} -- generated by the loop`)
    const compiled = [...raw.slice(0, 10), ...expanded, raw[11], ...Array.from({ length: 100 }, (_, i) => `  , tail_${i} -- more compiled output here`), "from t"].join("\n")
    expect(compiled.length).toBeGreaterThan(6_000)
    const ex = excerptFile(compiled, diff, 6_000)
    expect(ex.text).toContain("amount / nullif(qty, 0) as unit_price")
    expect(ex.text).toMatch(/… \(lines \d+–290 omitted\)/) // window starts 20 lines above compiled line 311
    // Raw content keeps raw line numbers.
    const rawBig = [...raw, ...Array.from({ length: 300 }, (_, i) => `  -- trailing filler line ${i} with padding text`)].join("\n")
    expect(excerptFile(rawBig, diff, 6_000).text).toContain(raw[11])
    // Changed text that cannot be found: head cut, marked approximate.
    const lost = excerptFile(compiled.replace("nullif(qty, 0)", "nullif(qty, 1)"), diff, 6_000).text
    expect(lost).toContain("windows would be approximate")
    expect(lost).not.toContain("unit_price")
  })

  test("the diff gets its own 16k budget: a 20-hunk 14k diff goes whole, a 30k diff stops at 16k", () => {
    const hunk = (k: number, size: number) =>
      `@@ -${10 + k * 100},${size} +${10 + k * 100},${size} @@\n` + Array.from({ length: size }, (_, i) => `+  , hub_hashkey_${k}_${i} as hk_${k}_${i} -- macro col`).join("\n")
    const diffOf = (hunks: number, size: number) => Array.from({ length: hunks }, (_, k) => hunk(k, size)).join("\n") + "\n"
    // The current file holds every added line at its head-side line number.
    const fileLines = Array.from({ length: 4_000 }, (_, i) => `  , select_line_${i} -- current file content`)
    for (let k = 0; k < 40; k++) for (let i = 0; i < 15; i++) fileLines[10 + k * 100 + i - 1] = `  , hub_hashkey_${k}_${i} as hk_${k}_${i} -- macro col`
    const sql = fileLines.join("\n")
    const small = diffOf(20, 15)
    expect(small.length).toBeGreaterThan(13_000)
    expect(small.length).toBeLessThan(16_000)
    const file: AiReviewFile = { path: "macros/hub.sql", status: "modified", model: "hub", kind: "macro", diff: small, sql }
    const plan = planAiInput({ grounding: [], files: [file] }, COVERAGE)
    expect(plan.input[0]).toMatchObject({ hunksSent: 20, hunksTotal: 20, truncated: true })
    const msg = plan.messages[0]
    expect(msg).toContain(hunk(19, 15))
    expect(msg).not.toContain("hunk omitted")
    // Every hunk is in the diff, so the current file is a 2,000-char head.
    const current = msg.slice(msg.indexOf("Current file:"))
    expect(current).toContain("… (truncated)")
    expect(current.length).toBeLessThan(2_200)
    expect(plan.input[0].chars).toBe(msg.slice(msg.indexOf("\n### macros/hub.sql"), msg.indexOf("\n\nReturn ONLY")).length)

    const big = diffOf(40, 15)
    expect(big.length).toBeGreaterThan(28_000)
    const bigPlan = planAiInput({ grounding: [], files: [{ ...file, diff: big }] }, COVERAGE)
    const rec = bigPlan.input[0]
    expect(rec.hunksTotal).toBe(40)
    expect(rec.hunksSent).toBeGreaterThan(20)
    expect(rec.hunksSent).toBeLessThan(40)
    const diffPart = bigPlan.messages[0].slice(bigPlan.messages[0].indexOf("Diff:"), bigPlan.messages[0].indexOf("Current file:"))
    expect(diffPart.length).toBeLessThan(16_300)
    expect(diffPart).toMatch(/more hunks omitted, at lines \d+–\d+/)
    // Not every hunk went, so the current file keeps its ±20-line windows.
    expect(bigPlan.messages[0]).toMatch(/Current file:[\s\S]*lines \d+–\d+ omitted/)
    // The budget is env-overridable; the default lane still cuts the head at 6,000.
    expect(aiInputBudget({ ...COVERAGE, ALTIMATE_REVIEW_AI_COVERAGE_DIFF_CHARS: "8000" }).coverage?.diffChars).toBe(8_000)
    const plain = planAiInput({ grounding: [], files: [file] }, {})
    expect(plain.messages[0]).toBe(buildUserMessage({ grounding: [], files: [file] }))
    expect(plain.input[0].hunksSent).toBeLessThan(20)
  })

  test("diff excerpts keep whole hunks and name the omitted ones by line; one oversized hunk keeps its head", () => {
    const hunk = (start: number) => `@@ -${start},40 +${start},40 @@\n` + Array.from({ length: 40 }, (_, i) => `+  , value_${start}_${i} as column_${start}_${i}`).join("\n")
    const diff = [10, 200, 400, 600, 800].map(hunk).join("\n") + "\n"
    expect(diff.length).toBeGreaterThan(6_000)
    const ex = excerptDiff(diff, 6_000)
    expect(ex.text.length).toBeLessThanOrEqual(6_100)
    expect(ex.hunksTotal).toBe(5)
    expect(ex.hunksSent).toBeGreaterThan(0)
    expect(ex.hunksSent).toBeLessThan(5)
    // Every hunk sent is whole.
    for (const start of [10, 200, 400, 600, 800].slice(0, ex.hunksSent)) expect(ex.text).toContain(hunk(start))
    const omitted = [10, 200, 400, 600, 800].slice(ex.hunksSent).map((s) => `${s}–${s + 39}`)
    expect(ex.text).toContain(`omitted, at lines ${omitted.join(", ")})`)
    const one = excerptDiff(hunk(5) + "\n" + hunk(5).split("\n").slice(1).join("\n").repeat(3), 1_000)
    expect(one.text).toContain("… (hunk truncated)")
    expect(one).toMatchObject({ hunksSent: 1, hunksTotal: 1, truncated: true })
  })

  test("dry run records ai.input, lists files over quota as not reviewed and skips the model", async () => {
    const saved = { ...process.env }
    try {
      Object.assign(process.env, COVERAGE, { ALTIMATE_REVIEW_AI_DRYRUN: "1" })
      const env = await runReview({
        changedFiles: [mod("models/marts/m.sql", "@@ -1 +1 @@\n-select 1\n+select 2 as id\n"), mod("models/marts/n.sql"), mod("macros/to_cents.sql")],
        config: { ...DEFAULT_REVIEW_CONFIG },
        rubric: DEFAULT_RUBRIC,
        mode: "comment",
        runner,
        forceTier: "full",
        getContent: async (p, side) => (side === "old" ? undefined : FILES[p] ?? "select 1"),
        generatedAt: "2026-11-14T00:00:00Z",
        aiReview: runAiReview,
      })
      expect(env.ai?.state).toBe("skipped")
      expect(env.ai?.reason).toContain("dry run")
      expect(env.ai?.input?.map((r) => r.path).sort()).toEqual(["macros/to_cents.sql", "models/marts/m.sql", "models/marts/n.sql"])
      const m = env.ai?.input?.find((r) => r.path === "models/marts/m.sql")
      expect(m).toMatchObject({ kind: "model_sql", truncated: false, hunksSent: 1, hunksTotal: 1, card: false })
      expect(m!.chars).toBeGreaterThan(0)
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      Object.assign(process.env, saved)
    }
  })

  test("files over quota reach scope.notReviewed; the default lane records nothing new", async () => {
    const saved = { ...process.env }
    // Quotas of 1 each make a total of 4: one macro and three of the six models (most changed first).
    const changed = [
      mod("models/marts/m.sql", "@@ -1 +1 @@\n-select 1\n+select 2 as id\n"),
      ...["n", "o", "p", "q", "r"].map((n) => mod(`models/marts/${n}.sql`)),
      mod("macros/to_cents.sql"),
    ]
    const run = () =>
      runReview({
        changedFiles: changed,
        config: { ...DEFAULT_REVIEW_CONFIG },
        rubric: DEFAULT_RUBRIC,
        mode: "comment",
        runner,
        forceTier: "full",
        getContent: async (p, side) => (side === "old" ? undefined : FILES[p] ?? "select 1"),
        generatedAt: "2026-11-14T00:00:00Z",
        aiReview: runAiReview,
      })
    try {
      Object.assign(process.env, { ALTIMATE_REVIEW_AI_DRYRUN: "1" })
      const plain = await run()
      expect(plain.ai?.input?.length).toBe(7)
      expect(plain.scope?.notReviewed?.some((e) => e.reason.includes("file quota")) ?? false).toBe(false)
      const one = { ALTIMATE_REVIEW_AI_QUOTA_MODEL: "1", ALTIMATE_REVIEW_AI_QUOTA_MACRO: "1", ALTIMATE_REVIEW_AI_QUOTA_TEST: "1", ALTIMATE_REVIEW_AI_QUOTA_YML: "1" }
      Object.assign(process.env, COVERAGE, one)
      const env = await run()
      expect(env.ai?.input?.map((r) => r.path)).toEqual(["models/marts/m.sql", "models/marts/n.sql", "models/marts/o.sql", "macros/to_cents.sql"])
      const quota = env.scope?.notReviewed?.filter((e) => e.reason === "not sent to the AI (file quota)").map((e) => e.path)
      expect(quota).toEqual(["models/marts/p.sql", "models/marts/q.sql", "models/marts/r.sql"])
      expect("unsent" in (env.ai ?? {})).toBe(false)
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      Object.assign(process.env, saved)
    }
  })
})

describe("dbt manifest context card (opt-in ALTIMATE_REVIEW_AI_CONTEXT_CARD=1)", () => {
  const card: ModelCard = {
    resourceType: "model",
    materialized: "incremental",
    uniqueKey: "order_id",
    incrementalStrategy: "merge",
    contractEnforced: true,
    parents: ["stg_orders", "raw.payments"],
    children: ["fct_revenue"],
    exposures: ["finance_dash"],
    columns: [{ name: "order_id", dataType: "int", tests: ["unique", "not_null"] }, { name: "amount", tests: [] }],
    siblings: ["fct_refunds"],
  }

  test("a model card names keys, parents, children, columns with tests and siblings", () => {
    const text = renderContextCard({ name: "fct_orders", model: card })
    expect(text).toBe(
      [
        "model `fct_orders`: materialized: incremental; strategy: merge; unique_key: order_id; contract: enforced",
        "parents: stg_orders, raw.payments",
        "children: fct_revenue",
        "exposures: finance_dash",
        "columns: order_id int [unique, not_null], amount",
        "siblings: fct_refunds",
      ].join("\n"),
    )
  })

  test("a macro card lists callers and adapter variants; long lists shrink to +N more within 600 chars", () => {
    const text = renderContextCard({
      name: "hash",
      macro: { name: "hash", callers: ["a", "b"], variants: ["snowflake__hash (macros/sf/hash.sql)", "default__hash (macros/hash.sql)"] },
    })
    expect(text).toBe("macro `hash`\ncallers: a, b\nvariants: snowflake__hash (macros/sf/hash.sql), default__hash (macros/hash.sql)")
    const big = renderContextCard({
      name: "wide",
      model: { ...card, children: Array.from({ length: 60 }, (_, i) => `downstream_model_number_${i}`), columns: Array.from({ length: 25 }, (_, i) => ({ name: `column_${i}`, tests: ["not_null"] })) },
    })
    expect(big.length).toBeLessThanOrEqual(600)
    expect(big).toMatch(/children: .*\+\d+ more/)
  })

  test("the card sits right under the file header; a call holds at most 6,000 chars of cards", () => {
    const files: AiReviewFile[] = Array.from({ length: 15 }, (_, i) => ({ path: `m${i}.sql`, status: "modified", model: `m${i}`, sql: "select 1", card: "c".repeat(500) }))
    const plan = planAiInput({ grounding: [], files }, {})
    expect(plan.messages[0]).toContain("### m0.sql (modified)\ndbt context (from manifest):\n" + "c".repeat(500) + "\nCurrent SQL:")
    expect(plan.input.filter((r) => r.card)).toHaveLength(12)
  })

  const cardRunner = {
    ...runner,
    async manifestAvailable() {
      return true
    },
    async modelCard(name: string) {
      return name === "m" ? card : undefined
    },
    async macroCard(name: string) {
      return { name, callers: ["m"], variants: [] }
    },
    async graphParents(paths: string[]) {
      return paths[0].endsWith(".yml") ? [{ path: "models/marts/m.sql", kind: "model", name: "m", forPaths: paths }] : []
    },
  } as ReviewRunner
  const run = async (aiContextCard: boolean, r: ReviewRunner = cardRunner) => {
    let seen: AiReviewInput | undefined
    await runReview({
      changedFiles: [mod("models/marts/m.sql"), mod("macros/to_cents.sql"), mod("models/marts/_marts.yml")],
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner: r,
      forceTier: "full",
      aiContextCard,
      getContent: async (p, side) => (side === "old" ? undefined : FILES[p]),
      generatedAt: "2026-11-14T00:00:00Z",
      aiReview: async (input) => {
        seen = input
        return { findings: [], status: { state: "ok" } }
      },
    })
    return new Map(seen!.files.map((f) => [f.path, f.card]))
  }

  test("the orchestrator attaches cards only with the switch on and a manifest", async () => {
    const on = await run(true)
    expect(on.get("models/marts/m.sql")).toContain("model `m`")
    expect(on.get("macros/to_cents.sql")).toBe("macro `to_cents`\ncallers: m")
    expect(on.get("models/marts/_marts.yml")).toContain("model `m`")
    expect([...(await run(false)).values()].every((c) => c === undefined)).toBe(true)
    const noManifest = {
      ...cardRunner,
      async manifestAvailable() {
        return false
      },
      async impact() {
        return { hasManifest: false, severity: "UNKNOWN", directCount: 0, transitiveCount: 0, testCount: 0 }
      },
    } as ReviewRunner
    expect([...(await run(true, noManifest)).values()].every((c) => c === undefined)).toBe(true)
  })

  test("modelCard and macroCard read the manifest and never throw", async () => {
    await using tmp = await tmpdir()
    const manifestPath = path.join(tmp.path, "manifest.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        metadata: { project_name: "shop" },
        nodes: {
          "model.shop.fct": {
            resource_type: "model", name: "fct", original_file_path: "models/marts/fct.sql",
            config: { materialized: "incremental", unique_key: ["order_id", "line"], incremental_strategy: "merge", partition_by: { field: "day", data_type: "date" }, contract: { enforced: true } },
            columns: { order_id: { name: "order_id", data_type: "int" }, amount: { name: "amount" } },
            depends_on: { nodes: ["model.shop.stg", "source.shop.raw.orders"], macros: ["macro.shop.hash"] },
          },
          "model.shop.fct_refunds": { resource_type: "model", name: "fct_refunds", original_file_path: "models/marts/fct_refunds.sql", depends_on: { nodes: ["model.shop.stg"], macros: ["macro.shop.hash"] } },
          "model.shop.other_dir": { resource_type: "model", name: "other_dir", original_file_path: "models/x/other_dir.sql", depends_on: { nodes: ["model.shop.stg"] } },
          "model.shop.rev": { resource_type: "model", name: "rev", original_file_path: "models/marts/rev.sql", depends_on: { nodes: ["model.shop.fct"] } },
          "model.shop.stg": { resource_type: "model", name: "stg", original_file_path: "models/stg.sql", depends_on: { nodes: [] } },
          "test.shop.unique_fct_order_id": { resource_type: "test", name: "unique_fct_order_id", attached_node: "model.shop.fct", column_name: "order_id", test_metadata: { name: "unique" }, depends_on: { nodes: ["model.shop.fct"] } },
        },
        sources: { "source.shop.raw.orders": { source_name: "raw", name: "orders", original_file_path: "models/_sources.yml" } },
        exposures: { "exposure.shop.dash": { name: "dash", depends_on: { nodes: ["model.shop.fct"] } } },
        macros: {
          "macro.shop.hash": { name: "hash", package_name: "shop", original_file_path: "macros/hash.sql" },
          "macro.shop.snowflake__hash": { name: "snowflake__hash", package_name: "shop", original_file_path: "macros/sf/hash.sql" },
          "macro.shop.default__hash": { name: "default__hash", package_name: "shop", original_file_path: "macros/hash.sql" },
          "macro.shop.hash_other": { name: "hash_other", package_name: "shop", original_file_path: "macros/o.sql" },
        },
      }),
    )
    const r = createDispatcherRunner({ manifestPath })
    expect(await r.modelCard!("fct")).toEqual({
      resourceType: "model",
      materialized: "incremental",
      uniqueKey: "order_id, line",
      incrementalStrategy: "merge",
      partitionBy: "day",
      clusterBy: undefined,
      contractEnforced: true,
      parents: ["stg", "raw.orders"],
      children: ["rev"],
      exposures: ["dash"],
      columns: [{ name: "order_id", dataType: "int", tests: ["unique"] }, { name: "amount", tests: [] }],
      siblings: ["fct_refunds"],
    })
    expect(await r.modelCard!("missing")).toBeUndefined()
    expect(await r.macroCard!("hash", { changedModels: ["fct_refunds"] })).toEqual({
      name: "hash",
      callers: ["fct_refunds", "fct"],
      variants: ["snowflake__hash (macros/sf/hash.sql)", "default__hash (macros/hash.sql)"],
    })
    // A file whose base name is no macro resolves through its path.
    expect((await r.macroCard!("sf_file", { path: "proj/macros/sf/hash.sql" }))?.variants).toEqual(["hash (macros/hash.sql)", "default__hash (macros/hash.sql)"])
    const broken = createDispatcherRunner({ manifestPath: path.join(tmp.path, "nope.json") })
    expect(await broken.modelCard!("fct")).toBeUndefined()
    expect(await broken.macroCard!("hash")).toBeUndefined()
  })
})
