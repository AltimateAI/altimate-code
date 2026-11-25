import { describe, test, expect, afterEach } from "bun:test"
import { runReview, type ReviewRunner } from "../../src/altimate/review/orchestrate"
import { DEFAULT_REVIEW_CONFIG } from "../../src/altimate/review/config"
import { DEFAULT_RUBRIC } from "../../src/altimate/review/rubric"
import { DEFAULT_DBT_DIRS, type ChangedFile } from "../../src/altimate/review/diff-filter"
import { makeFinding, ruleId } from "../../src/altimate/review/finding"
import {
  aiInputBudget,
  planAiInput,
  selectAiFilesByQuota,
  type AiReviewFile,
  type AiReviewInput,
  type AiLaneStatus,
} from "../../src/altimate/review/ai-review"

// The `otherFiles` switch (ALTIMATE_REVIEW_AI_OTHER_FILES) sends changed other/analysis files to the AI lane.

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

const mod = (path: string, status: ChangedFile["status"] = "modified"): ChangedFile => ({
  path,
  status,
  diff: `@@ -1,1 +1,2 @@\n ${path}\n+changed_${path}\n`,
})

const CHANGED: ChangedFile[] = [
  mod("models/marts/m.sql"),
  mod("macros/to_cents.sql"),
  mod("analyses/revenue_check.sql"),
  mod("scripts/load_raw.py"),
  mod("integration_tests/ci.yml"),
  mod("config/extra.yaml"),
  mod("data/lookup.csv"), // other, extension not allowed
  mod("scripts/gone.py", "deleted"),
]

const OFF_ENV = ["ALTIMATE_REVIEW_AI_OTHER_FILES", "ALTIMATE_REVIEW_AI_QUOTA_OTHER"]
afterEach(() => {
  for (const k of OFF_ENV) delete process.env[k]
})

async function lane(changed: ChangedFile[], opts: { flag?: boolean; layoutRoot?: string; finding?: string } = {}) {
  if (opts.flag) process.env.ALTIMATE_REVIEW_AI_OTHER_FILES = "1"
  else delete process.env.ALTIMATE_REVIEW_AI_OTHER_FILES
  let seen: AiReviewInput | undefined
  const env = await runReview({
    changedFiles: changed,
    config: { ...DEFAULT_REVIEW_CONFIG },
    rubric: DEFAULT_RUBRIC,
    mode: "comment",
    runner,
    forceTier: "full",
    ...(opts.layoutRoot !== undefined ? { layout: { root: opts.layoutRoot, dirs: DEFAULT_DBT_DIRS } } : {}),
    getContent: async (f, side) => (side === "old" ? undefined : `-- head of ${f}\nchanged_${f}\n`),
    generatedAt: "2026-11-24T00:00:00Z",
    aiReview: async (input) => {
      seen = input
      const target = opts.finding ? input.files.find((f) => f.path === opts.finding) : undefined
      const findings = target
        ? [
            makeFinding({
              severity: "warning",
              category: "sql_correctness",
              title: `${target.model}: wrong filter`,
              body: "The filter drops every row.",
              file: target.path,
              model: target.model,
              startLine: 2,
              endLine: 2,
              confidence: "high",
              evidence: { tool: "ai-review", result: {} },
              ruleKey: "ai:sql_correctness:wrong filter",
              rule: ruleId("ai-review", "sql_correctness"),
            }),
          ]
        : []
      return { findings, status: { state: "ok" } }
    },
  })
  return { input: seen!, env }
}

describe("ALTIMATE_REVIEW_AI_OTHER_FILES: orchestrator file list", () => {
  test("unset: other and analysis files never reach the lane", async () => {
    const { input } = await lane(CHANGED)
    expect(input.files.map((f) => f.path)).toEqual(["models/marts/m.sql", "macros/to_cents.sql"])
  })

  test("set: other/analysis files with allowed extensions are added after the rest, with head content", async () => {
    const off = await lane(CHANGED)
    const on = await lane(CHANGED, { flag: true })
    const paths = on.input.files.map((f) => f.path)
    expect(paths.slice(0, off.input.files.length)).toEqual(off.input.files.map((f) => f.path))
    expect(paths.slice(off.input.files.length)).toEqual([
      "analyses/revenue_check.sql",
      "integration_tests/ci.yml",
      "config/extra.yaml",
    ])
    const byPath = new Map(on.input.files.map((f) => [f.path, f]))
    expect(byPath.get("analyses/revenue_check.sql")).toMatchObject({ kind: "analysis", sql: "-- head of analyses/revenue_check.sql\nchanged_analyses/revenue_check.sql\n" })
    // Python files reach the lane only through the `pythonFiles` switch.
    expect(paths).not.toContain("scripts/load_raw.py")
    expect(paths).not.toContain("data/lookup.csv")
    expect(paths).not.toContain("scripts/gone.py")
  })

  test("set: files outside the dbt project root stay excluded", async () => {
    const changed = [mod("dbt/models/m.sql"), mod("dbt/analyses/a.sql"), mod("dbt/scripts/x.py"), mod("airflow/dags/load.py"), mod("infra/k8s.yaml")]
    const { input } = await lane(changed, { flag: true, layoutRoot: "dbt" })
    expect(input.files.map((f) => f.path)).toEqual(["dbt/models/m.sql", "dbt/analyses/a.sql"])
  })

  test("set: an added file the lane sent is not listed as not reviewed; unset it is", async () => {
    const off = await lane(CHANGED)
    const on = await lane(CHANGED, { flag: true })
    const listed = (e: typeof on.env) => (e.scope?.notReviewed ?? []).map((n) => n.path)
    expect(listed(off.env)).toContain("analyses/revenue_check.sql")
    expect(listed(on.env)).not.toContain("analyses/revenue_check.sql")
    expect(listed(on.env)).toContain("data/lookup.csv")
  })

  test("set: an added file stays listed as not reviewed when the lane fails or its call failed", async () => {
    const run = async (status: AiLaneStatus) => {
      process.env.ALTIMATE_REVIEW_AI_OTHER_FILES = "1"
      return runReview({
        changedFiles: CHANGED,
        config: { ...DEFAULT_REVIEW_CONFIG },
        rubric: DEFAULT_RUBRIC,
        mode: "comment",
        runner,
        forceTier: "full",
        getContent: async (f, side) => (side === "old" ? undefined : `x`),
        generatedAt: "2026-11-24T00:00:00Z",
        aiReview: async () => ({ findings: [], status }),
      })
    }
    const listed = (e: Awaited<ReturnType<typeof run>>) => (e.scope?.notReviewed ?? []).map((n) => n.path)
    for (const status of [
      { state: "error", reason: "boom" },
      { state: "timeout", reason: "slow" },
    ] as AiLaneStatus[])
      expect(listed(await run(status))).toContain("analyses/revenue_check.sql")
    const partial = await run({ state: "ok", reason: "1 of 2 calls failed: boom", failedFiles: ["analyses/revenue_check.sql"] })
    expect(listed(partial)).toContain("analyses/revenue_check.sql")
    expect(listed(partial)).not.toContain("integration_tests/ci.yml")
  })

  test("resolved switches win over the env variable", async () => {
    process.env.ALTIMATE_REVIEW_AI_OTHER_FILES = "1"
    let seen: AiReviewInput | undefined
    await runReview({
      changedFiles: CHANGED,
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      forceTier: "full",
      aiSwitches: { otherFiles: false },
      getContent: async (f, side) => (side === "old" ? undefined : `x`),
      generatedAt: "2026-11-24T00:00:00Z",
      aiReview: async (input) => {
        seen = input
        return { findings: [], status: { state: "ok" } }
      },
    })
    expect(seen!.files.map((f) => f.path)).toEqual(["models/marts/m.sql", "macros/to_cents.sql"])
  })

  test("set: a finding the model returns on an added file reaches the envelope", async () => {
    const { env } = await lane(CHANGED, { flag: true, finding: "integration_tests/ci.yml" })
    const f = env.findings.find((x) => x.file === "integration_tests/ci.yml")
    expect(f).toBeDefined()
    expect(f!.rule).toBe(ruleId("ai-review", "sql_correctness"))
    expect(f!.startLine).toBe(2)
  })
})

describe("ALTIMATE_REVIEW_AI_OTHER_FILES: planner", () => {
  const file = (path: string, kind: string, lines = 1, status = "modified"): AiReviewFile => ({
    path,
    status,
    kind,
    model: path,
    diff: `@@ -1,1 +1,${lines} @@\n` + Array.from({ length: lines }, (_, i) => `+${path}_${i}`).join("\n"),
    sql: `head of ${path}\n`,
  })
  const COVERAGE = { ALTIMATE_REVIEW_AI_COVERAGE: "1" }
  const base = [file("models/m.sql", "model_sql", 3), file("macros/x.sql", "macro", 2), file("models/_s.yml", "schema_yml")]

  test("flag off: the plan is byte-identical with or without the flag's quota variable", () => {
    const a = planAiInput({ grounding: [], files: base }, COVERAGE)
    const b = planAiInput({ grounding: [], files: base }, { ...COVERAGE, ALTIMATE_REVIEW_AI_QUOTA_OTHER: "3" })
    expect(b.messages).toEqual(a.messages)
    expect(b.input).toEqual(a.input)
    expect(aiInputBudget(COVERAGE).coverage).not.toHaveProperty("otherQuota")
  })

  test("flag on, no other files: the plan equals the flag-off plan", () => {
    const off = planAiInput({ grounding: [], files: base }, COVERAGE)
    const on = planAiInput({ grounding: [], files: base }, { ...COVERAGE, ALTIMATE_REVIEW_AI_OTHER_FILES: "1" })
    expect(on.messages).toEqual(off.messages)
    expect(on.input).toEqual(off.input)
  })

  test("flag on: other/analysis files follow the existing files, under their own quota", () => {
    const others = [
      file("scripts/a.py", "other", 1),
      file("analyses/b.sql", "analysis", 5),
      file("ci/c.yml", "other", 3),
    ]
    const env = { ...COVERAGE, ALTIMATE_REVIEW_AI_OTHER_FILES: "1", ALTIMATE_REVIEW_AI_QUOTA_OTHER: "2" }
    const off = planAiInput({ grounding: [], files: base }, COVERAGE)
    const on = planAiInput({ grounding: [], files: [...base, ...others] }, env)
    // Existing files: same order, same sections.
    expect(on.input.slice(0, off.input.length)).toEqual(off.input)
    expect(on.messages[0].startsWith(off.messages[0].replace(/\nReturn ONLY the JSON array per the output contract\.$/, ""))).toBe(true)
    // Added: the two most-changed others, with their kind on the input row; the third is unsent.
    expect(on.input.slice(off.input.length).map((r) => [r.path, r.kind])).toEqual([
      ["analyses/b.sql", "analysis"],
      ["ci/c.yml", "other"],
    ])
    expect(on.unsent.map((f) => f.path)).toEqual(["scripts/a.py"])
    expect(on.messages[0]).toContain("### ci/c.yml (modified, other project file)")
    expect(on.messages[0]).toContain("Current file:\n```yaml\nhead of ci/c.yml")
  })

  test("default quota is 8 and does not lend spare to the existing buckets", () => {
    // More models than the four quotas plus their spare can take, so a spare that wrongly
    // counted the other quota would send more models.
    const models = Array.from({ length: 40 }, (_, i) => file(`models/m${i}.sql`, "model_sql"))
    const others = Array.from({ length: 10 }, (_, i) => file(`scripts/s${i}.py`, "other"))
    const quotas = aiInputBudget({ ...COVERAGE, ALTIMATE_REVIEW_AI_OTHER_FILES: "1" }).coverage!
    expect(quotas.otherQuota).toBe(8)
    const off = selectAiFilesByQuota(models, quotas.quotas)
    const on = selectAiFilesByQuota([...models, ...others], quotas.quotas, quotas)
    expect(on.sent.slice(0, off.sent.length)).toEqual(off.sent)
    expect(on.sent.slice(off.sent.length).map((f) => f.path)).toEqual(others.slice(0, 8).map((f) => f.path))
    expect(on.sent.length).toBe(off.sent.length + 8)
  })

  test("deleted other files are never sent", () => {
    const env = { ...COVERAGE, ALTIMATE_REVIEW_AI_OTHER_FILES: "1" }
    const plan = planAiInput({ grounding: [], files: [...base, file("scripts/gone.py", "other", 1, "deleted")] }, env)
    expect(plan.input.map((r) => r.path)).not.toContain("scripts/gone.py")
  })
})
