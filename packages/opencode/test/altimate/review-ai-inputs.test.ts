import { describe, test, expect, spyOn, mock, afterEach } from "bun:test"
import { runReview, type ReviewRunner } from "../../src/altimate/review/orchestrate"
import { DEFAULT_REVIEW_CONFIG } from "../../src/altimate/review/config"
import { DEFAULT_RUBRIC } from "../../src/altimate/review/rubric"
import {
  addUsage,
  aiInputBudget,
  batchAiFiles,
  buildUserMessage,
  laneUsage,
  selectAiFiles,
  streamUsage,
  type AiLaneStatus,
  type AiReviewFile,
  type AiReviewInput,
} from "../../src/altimate/review/ai-review"
import { renderSummary } from "../../src/altimate/review/format"
import { emitReviewRun } from "../../src/altimate/review/telemetry"
import { Telemetry } from "../../src/altimate/telemetry"
import { createDispatcherRunner } from "../../src/altimate/review/runner"
import { writeFileSync } from "node:fs"
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
            depends_on: { nodes: ["model.shop.stg", "seed.shop.codes", "source.shop.raw.orders"], macros: ["macro.shop.cents", "macro.dbt_utils.star"] },
          },
          "model.shop.stg": { resource_type: "model", name: "stg", original_file_path: "models/stg.sql", depends_on: { nodes: [] } },
          "seed.shop.codes": { resource_type: "seed", name: "codes", original_file_path: "seeds/codes.csv", depends_on: { nodes: [] } },
          "test.shop.unique_stg_id": {
            resource_type: "test", name: "unique_stg_id", original_file_path: "models/_schema.yml", depends_on: { nodes: ["model.shop.stg"] },
          },
        },
        sources: {
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
