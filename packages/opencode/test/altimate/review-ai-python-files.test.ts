import { describe, test, expect, afterEach } from "bun:test"
import path from "node:path"
import os from "node:os"
import { promises as fs } from "node:fs"
import { execFileSync } from "node:child_process"
import { runReview, type ReviewRunner } from "../../src/altimate/review/orchestrate"
import { DEFAULT_REVIEW_CONFIG } from "../../src/altimate/review/config"
import { DEFAULT_RUBRIC } from "../../src/altimate/review/rubric"
import { DEFAULT_DBT_DIRS, type ChangedFile } from "../../src/altimate/review/diff-filter"
import { aiInputBudget, planAiInput, selectAiFilesByQuota, type AiReviewFile, type AiReviewInput } from "../../src/altimate/review/ai-review"
import { AI_PYTHON_KIND, isAiPythonFile } from "../../src/altimate/review/ai-python-files"
import { mergeProjectEnvelopes, reviewAllProjects } from "../../src/altimate/review/multi-project"
import { makeFinding, ruleId } from "../../src/altimate/review/finding"

// The `pythonFiles` switch (ALTIMATE_REVIEW_AI_PYTHON_FILES) sends changed .py files, inside or outside the dbt project, to the AI lane.

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

const mod = (p: string, status: ChangedFile["status"] = "modified"): ChangedFile => ({
  path: p,
  status,
  diff: `@@ -1,1 +1,2 @@\n ${p}\n+changed_${p}\n`,
})

const KEYS = [
  "ALTIMATE_REVIEW_AI_PYTHON_FILES",
  "ALTIMATE_REVIEW_AI_QUOTA_PYTHON",
  "ALTIMATE_REVIEW_AI_OTHER_FILES",
  "ALTIMATE_REVIEW_AI_COVERAGE",
  "ALTIMATE_REVIEW_AI_DRYRUN",
  "GITHUB_EVENT_PATH",
  "GITHUB_BASE_REF",
  "CI_MERGE_REQUEST_TARGET_BRANCH_NAME",
]
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

async function lane(changed: ChangedFile[], opts: { flags?: Record<string, string>; layoutRoot?: string; outside?: ChangedFile[] } = {}) {
  for (const k of ["ALTIMATE_REVIEW_AI_PYTHON_FILES", "ALTIMATE_REVIEW_AI_OTHER_FILES"]) delete process.env[k]
  Object.assign(process.env, opts.flags ?? {})
  let seen: AiReviewInput | undefined
  await runReview({
    changedFiles: changed,
    config: { ...DEFAULT_REVIEW_CONFIG },
    rubric: DEFAULT_RUBRIC,
    mode: "comment",
    runner,
    forceTier: "full",
    ...(opts.layoutRoot !== undefined ? { layout: { root: opts.layoutRoot, dirs: DEFAULT_DBT_DIRS } } : {}),
    ...(opts.outside ? { aiOutsideFiles: opts.outside } : {}),
    getContent: async (f, side) => (side === "old" ? undefined : `# head of ${f}\n`),
    generatedAt: "2026-11-24T00:00:00Z",
    aiReview: async (input) => {
      seen = input
      return { findings: [], status: { state: "ok" } }
    },
  })
  return seen!
}

const PY = { ALTIMATE_REVIEW_AI_PYTHON_FILES: "1" }
const OTHER = { ALTIMATE_REVIEW_AI_OTHER_FILES: "1" }
const IN_ROOT: ChangedFile[] = [
  mod("dbt/models/m.sql"),
  mod("dbt/models/py_model.py"),
  mod("dbt/scripts/helper.py"),
  mod("dbt/analyses/check.py"),
  mod("dbt/scripts/gone.py", "deleted"),
  mod("dbt/target/run/compiled.py"),
]
const OUTSIDE: ChangedFile[] = [mod("airflow/dags/load.py"), mod("tools/.venv/lib/x.py")]

describe("isAiPythonFile", () => {
  test(".py, not deleted, not a build or vendored path", () => {
    expect(isAiPythonFile({ path: "a/b.py", status: "added" })).toBe(true)
    expect(isAiPythonFile({ path: "a/B.PY", status: "modified" })).toBe(true)
    expect(isAiPythonFile({ path: "a/b.py", status: "deleted" })).toBe(false)
    expect(isAiPythonFile({ path: "a/b.sql", status: "modified" })).toBe(false)
    expect(isAiPythonFile({ path: "x/.venv/b.py", status: "modified" })).toBe(false)
    expect(isAiPythonFile({ path: "target/b.py", status: "modified" })).toBe(false)
  })
})

describe("ALTIMATE_REVIEW_AI_PYTHON_FILES: orchestrator file list", () => {
  test("unset: the lane input is unchanged, outside files given or not", async () => {
    const plain = await lane(IN_ROOT, { layoutRoot: "dbt" })
    const withOutside = await lane(IN_ROOT, { layoutRoot: "dbt", outside: OUTSIDE })
    expect(withOutside.files).toEqual(plain.files)
    expect(plain.files.map((f) => f.path)).toEqual(["dbt/models/m.sql", "dbt/models/py_model.py"])
  })

  test("set: .py files inside and outside the root follow every other file, as python_file, with head content", async () => {
    const off = await lane(IN_ROOT, { layoutRoot: "dbt" })
    const on = await lane(IN_ROOT, { layoutRoot: "dbt", outside: OUTSIDE, flags: PY })
    expect(on.files.slice(0, off.files.length)).toEqual(off.files)
    expect(on.files.slice(off.files.length).map((f) => [f.path, f.kind, f.sql])).toEqual([
      ["dbt/scripts/helper.py", AI_PYTHON_KIND, "# head of dbt/scripts/helper.py\n"],
      ["dbt/analyses/check.py", AI_PYTHON_KIND, "# head of dbt/analyses/check.py\n"],
      ["airflow/dags/load.py", AI_PYTHON_KIND, "# head of airflow/dags/load.py\n"],
    ])
    // The Python model is not sent twice; deleted and build-output files never are.
    expect(on.files.filter((f) => f.path === "dbt/models/py_model.py")).toHaveLength(1)
  })

  test("ALTIMATE_REVIEW_AI_OTHER_FILES alone sends no .py file; Python files go through this switch only", async () => {
    const other = await lane(IN_ROOT, { layoutRoot: "dbt", flags: OTHER })
    const both = await lane(IN_ROOT, { layoutRoot: "dbt", outside: OUTSIDE, flags: { ...OTHER, ...PY } })
    expect(other.files.filter((f) => f.path.endsWith(".py")).map((f) => f.path)).toEqual(["dbt/models/py_model.py"])
    expect(both.files.slice(0, other.files.length)).toEqual(other.files)
    expect(both.files.slice(other.files.length).map((f) => [f.path, f.kind])).toEqual([
      ["dbt/scripts/helper.py", AI_PYTHON_KIND],
      ["dbt/analyses/check.py", AI_PYTHON_KIND],
      ["airflow/dags/load.py", AI_PYTHON_KIND],
    ])
    const paths = both.files.map((f) => f.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  test("the verifier sees the added lines of outside-project files", async () => {
    process.env.ALTIMATE_REVIEW_AI_PYTHON_FILES = "1"
    let seen: AiReviewInput | undefined
    await runReview({
      changedFiles: [mod("dbt/models/m.sql")],
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      forceTier: "full",
      layout: { root: "dbt", dirs: DEFAULT_DBT_DIRS },
      aiOutsideFiles: [mod("airflow/load.py")],
      aiVerify: true,
      getContent: async (f, side) => (side === "old" ? undefined : `x`),
      generatedAt: "2026-11-25T00:00:00Z",
      aiReview: async (input) => {
        seen = input
        return { findings: [], status: { state: "ok" } }
      },
    })
    expect([...(seen!.evidence!.addedLines.get("airflow/load.py") ?? [])]).toEqual([2])
  })
})

describe("ALTIMATE_REVIEW_AI_PYTHON_FILES: planner", () => {
  const file = (p: string, kind: string, lines = 1, status = "modified"): AiReviewFile => ({
    path: p,
    status,
    kind,
    model: p,
    diff: `@@ -1,1 +1,${lines} @@\n` + Array.from({ length: lines }, (_, i) => `+${p}_${i}`).join("\n"),
    sql: `head of ${p}\n`,
  })
  const COVERAGE = { ALTIMATE_REVIEW_AI_COVERAGE: "1" }
  const base = [file("models/m.sql", "model_sql", 3), file("macros/x.sql", "macro", 2), file("models/_s.yml", "schema_yml")]

  test("flag off: byte-identical plan with or without the quota variable; no pythonQuota", () => {
    for (const env of [{}, COVERAGE]) {
      const a = planAiInput({ grounding: [], files: base }, env)
      const b = planAiInput({ grounding: [], files: base }, { ...env, ALTIMATE_REVIEW_AI_QUOTA_PYTHON: "2" })
      expect(b.messages).toEqual(a.messages)
      expect(b.input).toEqual(a.input)
    }
    expect(aiInputBudget(COVERAGE).coverage).not.toHaveProperty("pythonQuota")
    expect(aiInputBudget({ ...COVERAGE, ...PY }).coverage?.pythonQuota).toBe(6)
  })

  test("flag on, no Python files: the plan equals the flag-off plan", () => {
    for (const env of [{}, COVERAGE]) {
      const off = planAiInput({ grounding: [], files: base }, env)
      const on = planAiInput({ grounding: [], files: base }, { ...env, ...PY })
      expect(on.messages).toEqual(off.messages)
      expect(on.input).toEqual(off.input)
    }
  })

  test("flag on: Python files follow the other files under their own quota, most-changed first, with a python fence", () => {
    const others = [file("scripts/o.sql", "other", 1)]
    const py = [file("a.py", AI_PYTHON_KIND, 1), file("b.py", AI_PYTHON_KIND, 5), file("c.py", AI_PYTHON_KIND, 3)]
    const env = { ...COVERAGE, ...OTHER, ...PY, ALTIMATE_REVIEW_AI_QUOTA_PYTHON: "2" }
    const off = planAiInput({ grounding: [], files: [...base, ...others] }, { ...COVERAGE, ...OTHER })
    const on = planAiInput({ grounding: [], files: [...base, ...py, ...others] }, env)
    expect(on.input.slice(0, off.input.length)).toEqual(off.input)
    expect(on.input.slice(off.input.length).map((r) => [r.path, r.kind])).toEqual([
      ["b.py", AI_PYTHON_KIND],
      ["c.py", AI_PYTHON_KIND],
    ])
    expect(on.unsent.map((f) => f.path)).toEqual(["a.py"])
    expect(on.messages[0]).toContain("### b.py (modified, Python file)")
    expect(on.messages[0]).toContain("Current file:\n```python\nhead of b.py")
  })

  test("the quota lends no spare to the existing buckets, and theirs none to it", () => {
    const models = Array.from({ length: 14 }, (_, i) => file(`models/m${i}.sql`, "model_sql"))
    const py = Array.from({ length: 9 }, (_, i) => file(`scripts/s${i}.py`, AI_PYTHON_KIND))
    const q = aiInputBudget({ ...COVERAGE, ...PY }).coverage!
    const off = selectAiFilesByQuota(models, q.quotas)
    const on = selectAiFilesByQuota([...models, ...py], q.quotas, { pythonQuota: q.pythonQuota })
    expect(on.sent.slice(0, off.sent.length)).toEqual(off.sent)
    expect(on.sent.slice(off.sent.length).map((f) => f.path)).toEqual(py.slice(0, 6).map((f) => f.path))
  })
})

describe("reviewPullRequest end to end: .py files outside the dbt project reach the lane only under the flag", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
      cwd,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    }).toString()
  const write = async (root: string, rel: string, body: string) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await fs.writeFile(path.join(root, rel), body)
  }

  test("AI dry run: ai.input lists the outside .py file as python_file; unset it is out of scope only", async () => {
    const { reviewPullRequest } = await import("../../src/altimate/review/run")
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "review-py-e2e-")))
    const lines: string[] = []
    const write0 = process.stderr.write.bind(process.stderr)
    try {
      await write(root, "dbt/dbt_project.yml", "name: p\n")
      await write(root, "dbt/models/m.sql", "select 1 as id\n")
      await write(root, "airflow/dags/load.py", "print(1)\n")
      await write(root, "airflow/old.py", "print(0)\n")
      git(root, "init", "-q", "-b", "main")
      git(root, "add", "-A")
      git(root, "commit", "-q", "-m", "base")
      git(root, "checkout", "-q", "-b", "pr")
      await write(root, "dbt/models/m.sql", "select 1 as id, 2 as x\n")
      await write(root, "airflow/dags/load.py", "print(2)\n")
      await write(root, "README.md", "docs\n")
      await fs.rm(path.join(root, "airflow/old.py"))
      git(root, "add", "-A")
      git(root, "commit", "-q", "-m", "pr")
      for (const k of ["GITHUB_EVENT_PATH", "GITHUB_BASE_REF", "CI_MERGE_REQUEST_TARGET_BRANCH_NAME"]) delete process.env[k]
      process.env.ALTIMATE_REVIEW_AI_DRYRUN = "1"
      ;(process.stderr as any).write = (chunk: any, ...rest: any[]) => {
        lines.push(String(chunk))
        return write0(chunk, ...rest)
      }
      const outsideLines = () => lines.filter((l) => l.includes("outside the dbt project"))
      process.env.ALTIMATE_REVIEW_AI_PYTHON_FILES = "0"
      const off = await reviewPullRequest({ cwd: path.join(root, "dbt"), base: "main", head: "HEAD" })
      expect(outsideLines()).toEqual(["ℹ️  3 changed file(s) outside the dbt project (dbt) were not reviewed.\n"])
      lines.length = 0
      expect(off.ai?.input?.map((r) => r.path)).toEqual(["dbt/models/m.sql"])
      expect(off.scope?.outOfScopeFiles).toBe(3)
      process.env.ALTIMATE_REVIEW_AI_PYTHON_FILES = "1"
      const on = await reviewPullRequest({ cwd: path.join(root, "dbt"), base: "main", head: "HEAD" })
      expect(on.ai?.input?.map((r) => [r.path, r.kind])).toEqual([
        ["dbt/models/m.sql", "model_sql"],
        ["airflow/dags/load.py", AI_PYTHON_KIND],
      ])
      expect(on.findings).toEqual(off.findings)
      // The stderr count leaves out the file offered to the AI lane.
      expect(outsideLines()).toEqual([
        "ℹ️  2 changed file(s) outside the dbt project (dbt) were not reviewed.\n",
        "ℹ️  1 changed Python file(s) outside the dbt project (dbt) are offered to the AI review only, when that lane runs; the result lists any it did not review.\n",
      ])
      // The dry run made no model call, so the file is still listed as not reviewed.
      expect(on.scope?.notReviewed.map((n) => n.path)).toContain("airflow/dags/load.py")
      expect(on.scope?.aiReviewedOutside).toBeUndefined()
    } finally {
      ;(process.stderr as any).write = write0
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("outside-project Python files the AI lane reviewed are not listed as not reviewed", () => {
  const outsideScope = (paths: string[]) => ({
    projectRoot: "dbt",
    outOfScopeFiles: paths.length,
    notReviewed: paths.map((p) => ({ path: p, reason: "outside the dbt project (dbt)" })),
  })
  async function run(state: "ok" | "error" | "partial") {
    process.env.ALTIMATE_REVIEW_AI_PYTHON_FILES = "1"
    return runReview({
      changedFiles: [mod("dbt/models/m.sql")],
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      forceTier: "full",
      layout: { root: "dbt", dirs: DEFAULT_DBT_DIRS },
      aiOutsideFiles: [mod("airflow/load.py")],
      scope: outsideScope(["airflow/load.py", "README.md"]),
      getContent: async (f, side) => (side === "old" ? undefined : `x`),
      generatedAt: "2026-11-25T00:00:00Z",
      aiReview: async () => ({
        findings: [],
        status:
          state === "ok"
            ? { state: "ok" }
            : state === "partial"
              ? { state: "ok", reason: "1 of 2 calls failed: boom", failedFiles: ["airflow/load.py"] }
              : { state: "error", reason: "boom" },
      }),
    })
  }

  test("lane answered: dropped from notReviewed, recorded as aiReviewedOutside, count lowered", async () => {
    const env = await run("ok")
    expect(env.scope?.notReviewed.map((n) => n.path)).toEqual(["README.md"])
    expect(env.scope?.aiReviewedOutside).toEqual(["airflow/load.py"])
    expect(env.scope?.outOfScopeFiles).toBe(1)
  })

  test("lane failed: still listed as outside the project, not reviewed", async () => {
    const env = await run("error")
    expect(env.scope?.notReviewed.map((n) => n.path)).toEqual(["airflow/load.py", "README.md"])
    expect(env.scope?.aiReviewedOutside).toBeUndefined()
    expect(env.scope?.outOfScopeFiles).toBe(2)
  })

  test("its call failed while others answered: still listed as outside the project, not reviewed", async () => {
    const env = await run("partial")
    expect(env.scope?.notReviewed.map((n) => n.path)).toEqual(["airflow/load.py", "README.md"])
    expect(env.scope?.aiReviewedOutside).toBeUndefined()
  })

  test("multi-project merge: a path one project's AI lane reviewed is not listed by the others", async () => {
    const a = await run("ok")
    const b = await run("error")
    const merged = mergeProjectEnvelopes([
      { root: "dbt", paths: ["dbt/models/m.sql"], env: a },
      { root: "other", paths: [], env: b },
    ])
    expect(merged.scope?.notReviewed.map((n) => n.path)).toEqual(["README.md"])
    expect(merged.scope?.aiReviewedOutside).toEqual(["airflow/load.py"])
    expect(merged.scope?.outOfScopeFiles).toBe(1)
  })
})

describe("--all-projects: an outside-project Python file goes to one project's AI lane", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
      cwd,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    }).toString()
  const write = async (root: string, rel: string, body: string) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await fs.writeFile(path.join(root, rel), body)
  }

  test("AI dry run over two projects: the outside .py file is in one project's input", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "review-py-mp-")))
    try {
      await write(root, "a/dbt_project.yml", "name: a\n")
      await write(root, "a/models/m.sql", "select 1 as id\n")
      await write(root, "b/dbt_project.yml", "name: b\n")
      await write(root, "b/models/n.sql", "select 1 as id\n")
      await write(root, "airflow/load.py", "print(1)\n")
      git(root, "init", "-q", "-b", "main")
      git(root, "add", "-A")
      git(root, "commit", "-q", "-m", "base")
      git(root, "checkout", "-q", "-b", "pr")
      await write(root, "a/models/m.sql", "select 1 as id, 2 as x\n")
      await write(root, "b/models/n.sql", "select 1 as id, 3 as y\n")
      await write(root, "airflow/load.py", "print(2)\n")
      git(root, "add", "-A")
      git(root, "commit", "-q", "-m", "pr")
      for (const k of ["GITHUB_EVENT_PATH", "GITHUB_BASE_REF", "CI_MERGE_REQUEST_TARGET_BRANCH_NAME"]) delete process.env[k]
      process.env.ALTIMATE_REVIEW_AI_DRYRUN = "1"
      process.env.ALTIMATE_REVIEW_AI_PYTHON_FILES = "1"
      const env = await reviewAllProjects({ cwd: root, base: "main", head: "HEAD" })
      const py = (env.ai?.input ?? []).filter((r) => r.path === "airflow/load.py")
      expect(py.length).toBe(1)
      expect(env.ai?.input?.map((r) => r.path).sort()).toEqual(["a/models/m.sql", "airflow/load.py", "b/models/n.sql"])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  test("the first project's AI lane is off in its policy: the next project's lane takes the file", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "review-py-mp-off-")))
    try {
      await write(root, "a/dbt_project.yml", "name: a\n")
      await write(root, "a/.altimate/review.yml", "ai: false\n")
      await write(root, "a/models/m.sql", "select 1 as id\n")
      await write(root, "b/dbt_project.yml", "name: b\n")
      await write(root, "b/models/n.sql", "select 1 as id\n")
      await write(root, "airflow/load.py", "print(1)\n")
      git(root, "init", "-q", "-b", "main")
      git(root, "add", "-A")
      git(root, "commit", "-q", "-m", "base")
      git(root, "checkout", "-q", "-b", "pr")
      await write(root, "a/models/m.sql", "select 1 as id, 2 as x\n")
      await write(root, "b/models/n.sql", "select 1 as id, 3 as y\n")
      await write(root, "airflow/load.py", "print(2)\n")
      git(root, "add", "-A")
      git(root, "commit", "-q", "-m", "pr")
      for (const k of ["GITHUB_EVENT_PATH", "GITHUB_BASE_REF", "CI_MERGE_REQUEST_TARGET_BRANCH_NAME"]) delete process.env[k]
      process.env.ALTIMATE_REVIEW_AI_DRYRUN = "1"
      process.env.ALTIMATE_REVIEW_AI_PYTHON_FILES = "1"
      const env = await reviewAllProjects({ cwd: root, base: "main", head: "HEAD" })
      expect(env.ai?.input?.map((r) => r.path).sort()).toEqual(["airflow/load.py", "b/models/n.sql"])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("ai.unsent lists only files the deterministic lanes checked", () => {
  test("Python files over their quota are not in ai.unsent (the coverage ledger has them)", async () => {
    const { runAiReview } = await import("../../src/altimate/review/ai-review")
    process.env.ALTIMATE_REVIEW_AI_DRYRUN = "1"
    const py = Array.from({ length: 8 }, (_, i): AiReviewFile => ({
      path: `scripts/s${i}.py`,
      status: "modified",
      kind: AI_PYTHON_KIND,
      model: `s${i}`,
      diff: "@@ -1,1 +1,2 @@\n x\n+y\n",
      sql: "print(1)\n",
    }))
    const res = await runAiReview({ grounding: [], files: py, switches: { coverage: true, pythonFiles: true } })
    expect(res.status.input?.length).toBe(6)
    expect(res.status.unsent).toBeUndefined()
  })
})

describe("--all-projects: the outside-project handoff follows what a project actually took", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
      cwd,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    }).toString()
  const write = async (root: string, rel: string, body: string) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await fs.writeFile(path.join(root, rel), body)
  }
  const ENV = ["ALTIMATE_REVIEW_AI_REPLAY", "ALTIMATE_REVIEW_AI_VERIFY"]
  const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]))
  afterEach(() => {
    for (const k of ENV) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
  })

  test("the first project's lane answers with `pythonFiles: false`: the next project's lane reviews the file", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "review-py-mp-took-")))
    try {
      await write(root, "a/dbt_project.yml", "name: a\n")
      await write(root, "a/.altimate/review.yml", "ai:\n  pythonFiles: false\n")
      await write(root, "a/models/m.sql", "select 1 as id\n")
      await write(root, "b/dbt_project.yml", "name: b\n")
      await write(root, "b/models/n.sql", "select 1 as id\n")
      await write(root, "airflow/load.py", "print(1)\n")
      git(root, "init", "-q", "-b", "main")
      git(root, "add", "-A")
      git(root, "commit", "-q", "-m", "base")
      git(root, "checkout", "-q", "-b", "pr")
      await write(root, "a/models/m.sql", "select 1 as id, 2 as x\n")
      await write(root, "b/models/n.sql", "select 1 as id, 3 as y\n")
      await write(root, "airflow/load.py", "print(2)\n")
      git(root, "add", "-A")
      git(root, "commit", "-q", "-m", "pr")
      for (const k of ["GITHUB_EVENT_PATH", "GITHUB_BASE_REF", "CI_MERGE_REQUEST_TARGET_BRANCH_NAME", "ALTIMATE_REVIEW_AI_PYTHON_FILES"])
        delete process.env[k]
      // A replayed lane answers (`state: ok`) without a model call; the verifier is off.
      const replay = path.join(root, "..", path.basename(root) + "-replay.json")
      await fs.writeFile(replay, JSON.stringify({ findings: [], ai: { state: "ok", calls: 1 } }))
      process.env.ALTIMATE_REVIEW_AI_REPLAY = replay
      process.env.ALTIMATE_REVIEW_AI_VERIFY = "0"
      try {
        const env = await reviewAllProjects({ cwd: root, base: "main", head: "HEAD" })
        expect(env.scope?.aiReviewedOutside).toEqual(["airflow/load.py"])
        expect((env.scope?.notReviewed ?? []).map((n) => n.path)).not.toContain("airflow/load.py")
      } finally {
        await fs.rm(replay, { force: true })
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("outside-project Python findings are classified pre-existing like in-project ones", () => {
  test("a finding on a context line of an outside .py file is marked pre-existing", async () => {
    process.env.ALTIMATE_REVIEW_AI_PYTHON_FILES = "1"
    const outside: ChangedFile = { path: "airflow/load.py", status: "modified", diff: "@@ -1,2 +1,3 @@\n a = 1\n b = 2\n+c = 3\n" }
    const env = await runReview({
      changedFiles: [mod("dbt/models/m.sql")],
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      forceTier: "full",
      layout: { root: "dbt", dirs: DEFAULT_DBT_DIRS },
      aiOutsideFiles: [outside],
      getContent: async (f, side) => (side === "old" ? undefined : "a = 1\nb = 2\nc = 3\n"),
      generatedAt: "2026-11-27T00:00:00Z",
      aiReview: async () => ({
        findings: [
          makeFinding({
            severity: "warning",
            category: "sql_correctness",
            title: "load: unused name",
            body: "b is never read.",
            file: "airflow/load.py",
            model: "load",
            startLine: 2,
            endLine: 2,
            confidence: "high",
            evidence: { tool: "ai-review", result: {} },
            ruleKey: "ai:sql_correctness:unused name",
            rule: ruleId("ai-review", "sql_correctness"),
          }),
        ],
        status: { state: "ok" },
      }),
    })
    const f = env.findings.find((x) => x.file === "airflow/load.py")
    expect(f).toBeDefined()
    expect(f!.preExisting).toBe(true)
  })
})

describe("--all-projects: a lane that did not answer does not take the outside files", () => {
  test("error, timeout or no model: its input stays pending; ok, dry run or reviewed: taken", async () => {
    const { outsideTaken } = await import("../../src/altimate/review/multi-project")
    const rec = { path: "airflow/load.py", kind: AI_PYTHON_KIND, chars: 1, truncated: false, hunksSent: 1, hunksTotal: 1, card: false }
    for (const state of ["error", "timeout", "skipped"] as const) expect(outsideTaken({ ai: { state, input: [rec] } } as any, false)).toEqual([])
    expect(outsideTaken({ ai: { state: "ok", input: [rec] } } as any, false)).toEqual(["airflow/load.py"])
    expect(outsideTaken({ ai: { state: "skipped", input: [rec] } } as any, true)).toEqual(["airflow/load.py"])
    expect(outsideTaken({ ai: { state: "error" }, scope: { aiReviewedOutside: ["airflow/x.py"] } } as any, false)).toEqual(["airflow/x.py"])
  })
})
