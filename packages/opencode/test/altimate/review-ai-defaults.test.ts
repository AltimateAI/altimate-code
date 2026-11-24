import { describe, test, expect, afterEach } from "bun:test"
import path from "node:path"
import os from "node:os"
import { promises as fs } from "node:fs"
import { execFileSync } from "node:child_process"
import { runReview, type ReviewRunner } from "../../src/altimate/review/orchestrate"
import { DEFAULT_REVIEW_CONFIG } from "../../src/altimate/review/config"
import { DEFAULT_RUBRIC } from "../../src/altimate/review/rubric"
import { DEFAULT_DBT_DIRS, type ChangedFile } from "../../src/altimate/review/diff-filter"
import { planAiInput, type AiReviewFile, type AiReviewInput } from "../../src/altimate/review/ai-review"
import { AI_SWITCH_DEFAULTS, AI_SWITCH_ENV, resolveAiSwitches, type AiSwitches } from "../../src/altimate/review/ai-switches"

const ALL_OFF = Object.fromEntries(Object.keys(AI_SWITCH_DEFAULTS).map((k) => [k, false])) as AiSwitches
const ENV_KEYS = [...Object.values(AI_SWITCH_ENV), "ALTIMATE_REVIEW_AI_DRYRUN", "GITHUB_EVENT_PATH", "GITHUB_BASE_REF", "CI_MERGE_REQUEST_TARGET_BRANCH_NAME"]
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

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

const mod = (p: string): ChangedFile => ({ path: p, status: "modified", diff: `@@ -1,1 +1,2 @@\n ${p}\n+changed_${p}\n` })

describe("product defaults", () => {
  test("every switch is on by default and each can be turned off by config or env", () => {
    expect(resolveAiSwitches({ ai: true }, {})).toEqual(AI_SWITCH_DEFAULTS)
    expect(Object.values(AI_SWITCH_DEFAULTS).every(Boolean)).toBe(true)
    expect(resolveAiSwitches({ ai: { ...ALL_OFF } }, {})).toEqual(ALL_OFF)
    const envOff = Object.fromEntries(Object.values(AI_SWITCH_ENV).map((k) => [k, "0"]))
    expect(resolveAiSwitches({ ai: true }, envOff)).toEqual(ALL_OFF)
  })
})

describe("flags-off identity: every switch off is today's lane", () => {
  const files: AiReviewFile[] = [
    { path: "models/a.sql", status: "modified", model: "a", kind: "model_sql", diff: "@@ -1 +1,2 @@\n x\n+y\n", sql: "select 1" },
    { path: "macros/m.sql", status: "modified", model: "m", kind: "macro", diff: "@@ -1 +1,2 @@\n x\n+y\n", sql: "{% macro m() %}{% endmacro %}" },
    { path: "analyses/q.sql", status: "modified", model: "q", kind: "analysis", diff: "@@ -1 +1,2 @@\n x\n+y\n", sql: "select 2" },
  ]

  test("planner: resolved switches all off equal the env-only plan with nothing set", () => {
    const legacy = planAiInput({ grounding: [], files }, {})
    const off = planAiInput({ grounding: [], files, switches: ALL_OFF }, {})
    expect(off.messages).toEqual(legacy.messages)
    expect(off.input).toEqual(legacy.input)
    expect(off.budget).toEqual(legacy.budget)
  })

  test("orchestrator: the AI lane input with switches all off equals the input without switches", async () => {
    const changed = [mod("models/marts/m.sql"), mod("macros/to_cents.sql"), mod("analyses/a.sql"), mod("scripts/x.py")]
    const run = async (aiSwitches?: AiSwitches) => {
      let seen: AiReviewInput | undefined
      const env = await runReview({
        changedFiles: changed,
        config: { ...DEFAULT_REVIEW_CONFIG },
        rubric: DEFAULT_RUBRIC,
        mode: "comment",
        runner,
        forceTier: "full",
        layout: { root: "", dirs: DEFAULT_DBT_DIRS },
        aiOutsideFiles: [mod("airflow/load.py")],
        ...(aiSwitches ? { aiSwitches } : {}),
        getContent: async (f, side) => (side === "old" ? undefined : `head ${f}`),
        generatedAt: "2026-11-25T00:00:00Z",
        aiReview: async (input) => {
          seen = input
          return { findings: [], status: { state: "ok" } }
        },
      })
      const { switches: _s, ...rest } = seen!
      return { input: rest, env }
    }
    const legacy = await run()
    const off = await run(ALL_OFF)
    expect(off.input).toEqual(legacy.input)
    expect({ ...off.env, signature: undefined }).toEqual({ ...legacy.env, signature: undefined })
  })
})

describe("AI lane off: the switches change nothing", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
      cwd,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    }).toString()
  const write = async (root: string, rel: string, body: string) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await fs.writeFile(path.join(root, rel), body)
  }

  test("--no-ai: identical envelope with every switch on or off", async () => {
    const { reviewPullRequest } = await import("../../src/altimate/review/run")
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "review-ai-off-")))
    try {
      await write(root, "dbt/dbt_project.yml", "name: p\n")
      await write(root, "dbt/models/m.sql", "select 1 as id\n")
      await write(root, "dbt/analyses/a.sql", "select 1\n")
      await write(root, "airflow/load.py", "print(1)\n")
      git(root, "init", "-q", "-b", "main")
      git(root, "add", "-A")
      git(root, "commit", "-q", "-m", "base")
      git(root, "checkout", "-q", "-b", "pr")
      await write(root, "dbt/models/m.sql", "select 1 as id, 2 as x\n")
      await write(root, "dbt/analyses/a.sql", "select 2\n")
      await write(root, "airflow/load.py", "print(2)\n")
      git(root, "add", "-A")
      git(root, "commit", "-q", "-m", "pr")
      for (const k of ["GITHUB_EVENT_PATH", "GITHUB_BASE_REF", "CI_MERGE_REQUEST_TARGET_BRANCH_NAME"]) delete process.env[k]
      const strip = (e: any) => ({ ...e, generatedAt: undefined, signature: undefined })
      for (const k of Object.values(AI_SWITCH_ENV)) process.env[k] = "1"
      const on = await reviewPullRequest({ cwd: path.join(root, "dbt"), base: "main", head: "HEAD", noAi: true })
      for (const k of Object.values(AI_SWITCH_ENV)) process.env[k] = "0"
      const off = await reviewPullRequest({ cwd: path.join(root, "dbt"), base: "main", head: "HEAD", noAi: true })
      expect(strip(on)).toEqual(strip(off))
      expect(on.scope?.notReviewed.map((n) => n.path)).toContain("airflow/load.py")
      expect(on.ai?.state).toBe("skipped")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
