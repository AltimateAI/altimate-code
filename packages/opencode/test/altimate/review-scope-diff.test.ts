import { describe, test, expect, afterEach } from "bun:test"
import { promises as fs } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { collectChangedFiles, resolveReviewBase } from "../../src/altimate/review/git"
import { classifyDbtFile, scopeToProject, type ChangedFile } from "../../src/altimate/review/diff-filter"
import { dbtProjectLayout } from "../../src/altimate/review/compiled"
import { runReview, type ReviewRunner } from "../../src/altimate/review/orchestrate"
import { DEFAULT_REVIEW_CONFIG } from "../../src/altimate/review/config"
import { DEFAULT_RUBRIC } from "../../src/altimate/review/rubric"
import { reviewPullRequest } from "../../src/altimate/review/run"

/**
 * The review must look at exactly the PR's changes, in the dbt
 * project it was pointed at. Each test builds a real git topology in a temp
 * dir (synthetic, no customer data) for one input shape that is common in
 * public dbt repos: a PR into a non-default branch, a base that moved after
 * branching, a monorepo with several dbt projects, renames, custom
 * `model-paths`, and a `dbt parse`-only CI with no compiled SQL.
 */

const exec = promisify(execFile)
const g = (cwd: string, ...args: string[]) => exec("git", args, { cwd }).then((r) => r.stdout.trim())

async function write(root: string, rel: string, body: string) {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await fs.writeFile(path.join(root, rel), body)
}

async function commitAll(root: string, msg: string) {
  await g(root, "add", "-A")
  await g(root, "commit", "-qm", msg)
  return g(root, "rev-parse", "HEAD")
}

async function newRepo(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "review-scope-")))
  await g(root, "init", "-q", "-b", "main")
  await g(root, "config", "user.email", "t@test")
  await g(root, "config", "user.name", "t")
  await g(root, "config", "commit.gpgsign", "false")
  return root
}

const noEnv: NodeJS.ProcessEnv = {}

describe("resolveReviewBase: the PR's real target branch, as a merge-base", () => {
  test("PR into a drifted non-default branch diffs against that branch, not main", async () => {
    const root = await newRepo()
    await write(root, "models/a.sql", "select 1 as id\n")
    await commitAll(root, "seed")
    await g(root, "branch", "release")
    // main drifts ahead with 3 commits the PR never touched.
    for (let i = 0; i < 3; i++) {
      await write(root, `models/drift_${i}.sql`, `select ${i} as id\n`)
      await commitAll(root, `drift ${i}`)
    }
    await g(root, "checkout", "-q", "-b", "feature", "release")
    await write(root, "models/a.sql", "select 1 as id, 2 as x\n")
    await commitAll(root, "pr change")

    const eventPath = path.join(root, "..", `event-${path.basename(root)}.json`)
    await fs.writeFile(eventPath, JSON.stringify({ pull_request: { base: { ref: "release" } } }))
    const resolved = await resolveReviewBase({ cwd: root, env: { GITHUB_EVENT_PATH: eventPath } })
    expect(resolved.source).toBe("github_event")
    expect(resolved.ref).toBe("release")
    expect(resolved.sha).toBe(await g(root, "rev-parse", "release"))

    const files = await collectChangedFiles({ base: resolved.sha, head: "HEAD", cwd: root })
    expect(files.map((f) => f.path)).toEqual(["models/a.sql"])
  })

  test("GITHUB_BASE_REF and GitLab's MR target branch are honoured", async () => {
    const root = await newRepo()
    await write(root, "a.sql", "select 1\n")
    await commitAll(root, "seed")
    await g(root, "branch", "develop")
    await g(root, "checkout", "-q", "-b", "feature")
    await write(root, "a.sql", "select 2\n")
    await commitAll(root, "pr")
    expect((await resolveReviewBase({ cwd: root, env: { GITHUB_BASE_REF: "develop" } })).source).toBe("github_env")
    const gl = await resolveReviewBase({ cwd: root, env: { CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "develop" } })
    expect(gl.source).toBe("gitlab_env")
    expect(gl.ref).toBe("develop")
  })

  test("a CI target branch that is not fetched fails loudly instead of guessing main", async () => {
    const root = await newRepo()
    await write(root, "a.sql", "select 1\n")
    await commitAll(root, "seed")
    await expect(resolveReviewBase({ cwd: root, env: { GITHUB_BASE_REF: "deployment" } })).rejects.toThrow(
      /deployment.*not available locally/,
    )
  })

  test("explicit --base wins and is reduced to the merge-base", async () => {
    const root = await newRepo()
    await write(root, "a.sql", "select 1\n")
    const forkPoint = await commitAll(root, "seed")
    await g(root, "checkout", "-q", "-b", "feature")
    await write(root, "b.sql", "select 2\n")
    await commitAll(root, "pr")
    await g(root, "checkout", "-q", "main")
    await write(root, "c.sql", "select 3\n")
    await commitAll(root, "main moves on")
    await g(root, "checkout", "-q", "feature")
    const r = await resolveReviewBase({ cwd: root, base: "main", env: noEnv })
    expect(r.source).toBe("flag")
    expect(r.sha).toBe(forkPoint)
  })
})

describe("collectChangedFiles: only the PR's own changes", () => {
  test("commits the base gains after branching do not leak in (working-tree and head diffs)", async () => {
    const root = await newRepo()
    await write(root, "models/a.sql", "select 1\n")
    await commitAll(root, "seed")
    await g(root, "checkout", "-q", "-b", "feature")
    await write(root, "models/pr.sql", "select 2\n")
    await commitAll(root, "pr")
    await g(root, "checkout", "-q", "main")
    await write(root, "models/later.sql", "select 3\n")
    await commitAll(root, "main moves on")
    await g(root, "checkout", "-q", "feature")

    const { sha } = await resolveReviewBase({ cwd: root, base: "main", env: noEnv })
    const withHead = await collectChangedFiles({ base: sha, head: "HEAD", cwd: root })
    const workingTree = await collectChangedFiles({ base: sha, cwd: root })
    expect(withHead.map((f) => f.path)).toEqual(["models/pr.sql"])
    expect(workingTree.map((f) => f.path)).toEqual(["models/pr.sql"])
  })

  test("a moved-and-edited model is paired as a rename with only the edited lines in its diff", async () => {
    const root = await newRepo()
    const body = Array.from({ length: 20 }, (_, i) => `  , col_${i}`).join("\n")
    await write(root, "models/staging/stg_orders.sql", `select\n  id\n${body}\nfrom src\n`)
    await commitAll(root, "seed")
    const base = await g(root, "rev-parse", "HEAD")
    await fs.mkdir(path.join(root, "models/core"), { recursive: true })
    await g(root, "mv", "models/staging/stg_orders.sql", "models/core/stg_orders.sql")
    await write(root, "models/core/stg_orders.sql", `select\n  id\n${body}\n  , col_new\nfrom src\n`)
    await commitAll(root, "move and edit")

    const [f] = await collectChangedFiles({ base, head: "HEAD", cwd: root })
    expect(f.status).toBe("renamed")
    expect(f.oldPath).toBe("models/staging/stg_orders.sql")
    expect(f.similarity).toBeLessThan(100)
    const added = f.diff!.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    expect(added).toEqual(["+  , col_new"])
  })

  test("a pure move is reported at 100% similarity", async () => {
    const root = await newRepo()
    await write(root, "models/a/x.sql", "select 1 as id\nfrom src\n")
    await commitAll(root, "seed")
    const base = await g(root, "rev-parse", "HEAD")
    await fs.mkdir(path.join(root, "models/b"), { recursive: true })
    await g(root, "mv", "models/a/x.sql", "models/b/x.sql")
    await commitAll(root, "move")
    const [f] = await collectChangedFiles({ base, head: "HEAD", cwd: root })
    expect(f.status).toBe("renamed")
    expect(f.similarity).toBe(100)
  })
})

describe("scopeToProject: the dbt project being reviewed, nothing else", () => {
  const files: ChangedFile[] = [
    { path: "projects/a/models/x.sql", status: "modified" },
    { path: "projects/b/models/y.sql", status: "modified" },
    { path: ".github/workflows/ci.yml", status: "modified" },
    { path: "projects/a/models/moved/z.sql", oldPath: "projects/a/models/z.sql", status: "renamed", similarity: 100 },
    { path: "projects/a/models/w2.sql", oldPath: "projects/a/models/w.sql", status: "renamed", similarity: 100 },
  ]

  test("monorepo: sibling projects and non-dbt files are counted, not reviewed", () => {
    const r = scopeToProject(files, "projects/a")
    expect(r.inScope.map((f) => f.path)).toEqual(["projects/a/models/x.sql", "projects/a/models/w2.sql"])
    expect(r.outOfScope).toBe(2)
    // A pure directory move keeps the model name → dropped; a rename that
    // changes the file (model) name can break refs → kept.
    expect(r.movedUnchanged).toBe(1)
  })

  test("project at the repo root keeps every file", () => {
    expect(scopeToProject(files, "").outOfScope).toBe(0)
  })

  test("unknown project root scopes nothing out", () => {
    expect(scopeToProject(files, undefined).inScope.length).toBe(4)
  })
})

describe("classifyDbtFile: the project's own directories decide", () => {
  test("custom model-paths are models, and the layout root is stripped", async () => {
    const root = await newRepo()
    await write(root, "projects/a/dbt_project.yml", "name: a\nmodel-paths: [models, cases]\nsnapshot-paths: [snaps]\n")
    const layout = await dbtProjectLayout(path.join(root, "projects/a"), "projects/a")
    expect(layout?.dirs.model).toEqual(["models", "cases"])
    expect(layout?.dirs.seed).toEqual(["seeds"])
    expect(classifyDbtFile("projects/a/cases/i01/i01_revenue.sql", layout)).toBe("model_sql")
    expect(classifyDbtFile("projects/a/snaps/orders.sql", layout)).toBe("snapshot")
    expect(classifyDbtFile("projects/a/models/tests/helper.sql", layout)).toBe("model_sql")
    // Without the layout a custom model path is unknown.
    expect(classifyDbtFile("projects/a/cases/i01/i01_revenue.sql")).toBe("other")
  })

  test("without a layout the outermost conventional directory wins", () => {
    expect(classifyDbtFile("models/tests/helper.sql")).toBe("model_sql")
    expect(classifyDbtFile("tests/models/assert_x.sql")).toBe("test")
    expect(classifyDbtFile("models/marts/_marts.yml")).toBe("schema_yml")
  })
})

describe("raw Jinja never reaches the engine lanes", () => {
  function runnerRecording(seen: string[]): ReviewRunner {
    return {
      async impact() {
        return { hasManifest: true, severity: "SAFE", directCount: 0, transitiveCount: 0, testCount: 0 }
      },
      async grade() {
        return { grade: "B" }
      },
      async check(sql: string) {
        seen.push(sql)
        // What core reports for Jinja text today.
        return /\{\{/.test(sql)
          ? { issues: [{ rule: "encoding_bypass", message: "suspicious template", severity: "warning" }], ran: true }
          : { issues: [], ran: true }
      },
      async equivalence() {
        return { decided: false }
      },
      async detectPii(sql: string) {
        seen.push(sql)
        return { columns: [] }
      },
    } as ReviewRunner
  }

  test("two new Jinja models with no compiled SQL: no engine warnings, marked unverified", async () => {
    const seen: string[] = []
    const sql = "{{ config(materialized='table') }}\nselect id from {{ ref('stg_orders') }}\n"
    const env = await runReview({
      changedFiles: [
        { path: "models/marts/fct_a.sql", status: "added", diff: "+" + sql },
        { path: "models/marts/fct_b.sql", status: "added", diff: "+" + sql },
      ],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["sql_quality"] },
      rubric: DEFAULT_RUBRIC,
      mode: "gate",
      runner: runnerRecording(seen),
      getContent: async () => sql,
      getCompiled: async () => undefined,
      generatedAt: "2026-11-12T00:00:00Z",
    })
    expect(seen.some((s) => s.includes("{{"))).toBe(false)
    expect(env.findings.some((f) => f.evidence?.tool === "altimate_core.check")).toBe(false)
    expect(env.verdict).not.toBe("REQUEST_CHANGES")
    expect(env.scope?.unverified?.map((u) => u.path)).toEqual(["models/marts/fct_a.sql", "models/marts/fct_b.sql"])
  })

  test("a plain-SQL model without Jinja still runs through the engine", async () => {
    const seen: string[] = []
    await runReview({
      changedFiles: [{ path: "models/marts/fct_a.sql", status: "added", diff: "+select 1 as id\n" }],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["sql_quality"] },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner: runnerRecording(seen),
      getContent: async () => "select 1 as id\n",
      getCompiled: async () => undefined,
    })
    expect(seen).toContain("select 1 as id\n")
  })

  test("a renamed-and-edited model gets its old side, so before/after lanes run", async () => {
    let compared: [string, string] | undefined
    const runner: ReviewRunner = {
      ...runnerRecording([]),
      async equivalence(o: string, n: string) {
        compared = [o, n]
        return { decided: true, equivalent: true }
      },
    } as ReviewRunner
    await runReview({
      changedFiles: [
        { path: "models/core/m.sql", oldPath: "models/staging/m.sql", status: "renamed", similarity: 90, diff: "" },
      ],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["semantic_change"] },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      getContent: async (_f, side) => (side === "old" ? "select 1 as id" : "select 1 as id, 2 as x"),
      getCompiled: async (f, side) => (side === "old" && f === "models/staging/m.sql" ? "select 1 as id" : "select 1 as id, 2 as x"),
    })
    expect(compared).toEqual(["select 1 as id", "select 1 as id, 2 as x"])
  })
})

describe("reviewPullRequest end to end: monorepo, PR into a non-default branch", () => {
  const saved = { ...process.env }
  afterEach(() => {
    for (const k of ["GITHUB_EVENT_PATH", "GITHUB_BASE_REF", "CI_MERGE_REQUEST_TARGET_BRANCH_NAME"]) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  test("reviews only the PR's files inside --cwd's project and records the base on the envelope", async () => {
    const root = await newRepo()
    await write(root, "projects/a/dbt_project.yml", "name: a\nmodel-paths: [models, cases]\n")
    await write(root, "projects/b/dbt_project.yml", "name: b\n")
    await write(root, "projects/a/models/base_a.sql", "select 1 as id\n")
    await write(root, "projects/b/models/base_b.sql", "select 1 as id\n")
    await commitAll(root, "seed")
    await g(root, "branch", "release")
    await write(root, "projects/a/models/drift.sql", "select 9 as id\n")
    await commitAll(root, "main drifts")
    await g(root, "checkout", "-q", "-b", "feature", "release")
    await write(root, "projects/a/cases/c1/c1_model.sql", "select 2 as id\n")
    await write(root, "projects/b/models/sibling.sql", "select 3 as id\n")
    await write(root, "README.md", "docs\n")
    await commitAll(root, "pr")

    delete process.env.GITHUB_EVENT_PATH
    delete process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME
    process.env.GITHUB_BASE_REF = "release"
    const env = await reviewPullRequest({ cwd: path.join(root, "projects/a"), head: "HEAD", noAi: true })
    expect(env.scope?.baseSource).toBe("github_env")
    expect(env.scope?.baseSha).toBe(await g(root, "rev-parse", "release"))
    expect(env.scope?.projectRoot).toBe("projects/a")
    // sibling project file + README are out of scope; drift on main never appears.
    expect(env.scope?.outOfScopeFiles).toBe(2)
    expect(env.findings.every((f) => f.file.startsWith("projects/a/"))).toBe(true)
    expect(env.findings.some((f) => f.file.includes("drift"))).toBe(false)
  }, 60_000)
})

describe("a shallow CI checkout without the target branch", () => {
  test("the target branch and enough history are fetched to find the merge-base", async () => {
    const exec = (await import("node:util")).promisify((await import("node:child_process")).execFile)
    const fsp = (await import("node:fs")).promises
    const os = await import("node:os")
    const pth = await import("node:path")
    const g = (cwd: string, ...a: string[]) => exec("git", a, { cwd }).then((r) => r.stdout.trim())
    const origin = await fsp.realpath(await fsp.mkdtemp(pth.join(os.tmpdir(), "shallow-origin-")))
    await g(origin, "init", "-q", "-b", "main")
    await g(origin, "config", "user.email", "t@t")
    await g(origin, "config", "user.name", "t")
    await g(origin, "config", "commit.gpgsign", "false")
    await g(origin, "config", "uploadpack.allowReachableSHA1InWant", "true")
    for (let i = 0; i < 5; i++) {
      await fsp.writeFile(pth.join(origin, `f${i}.sql`), `select ${i}\n`)
      await g(origin, "add", "-A")
      await g(origin, "commit", "-qm", `main ${i}`)
    }
    const branchPoint = await g(origin, "rev-parse", "HEAD")
    await g(origin, "checkout", "-q", "-b", "feature")
    for (let i = 0; i < 3; i++) {
      await fsp.writeFile(pth.join(origin, `pr${i}.sql`), `select ${i}\n`)
      await g(origin, "add", "-A")
      await g(origin, "commit", "-qm", `pr ${i}`)
    }
    const clone = await fsp.realpath(await fsp.mkdtemp(pth.join(os.tmpdir(), "shallow-clone-")))
    await exec("git", ["clone", "-q", "--depth", "1", "--branch", "feature", `file://${origin}`, clone])
    const resolved = await resolveReviewBase({ cwd: clone, env: { GITHUB_BASE_REF: "main" } })
    expect(resolved.source).toBe("github_env")
    expect(resolved.sha).toBe(branchPoint)
  }, 60_000)
})
