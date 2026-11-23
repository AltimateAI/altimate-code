import { describe, test, expect, spyOn } from "bun:test"
import { promises as fs } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { reviewPullRequest } from "../../src/altimate/review/run"
import * as Orchestrate from "../../src/altimate/review/orchestrate"
import {
  assignToProjects,
  discoverDbtProjects,
  mergeProjectEnvelopes,
  owningProject,
  reviewAllProjects,
} from "../../src/altimate/review/multi-project"
import { buildEnvelope, signEnvelope, verifyEnvelope, type VerdictEnvelope } from "../../src/altimate/review/verdict"
import { makeFinding } from "../../src/altimate/review/finding"
import { renderSummary } from "../../src/altimate/review/format"
import { postGitHubReview, type GitHubClient } from "../../src/altimate/review/post-github"
import type { ChangedFile } from "../../src/altimate/review/diff-filter"

/**
 * `altimate review --all-projects`: a mono-repo PR that changes several dbt
 * projects is reviewed per project and merged into one signed envelope. Each
 * test builds a synthetic git repo with two dbt projects in a temp dir.
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

const STAR_MODEL = "select * from {{ ref('stg') }}\n"
const ORDINAL_MACRO = "{% macro m() %}select a, count(*) from t group by 1{% endmacro %}\n"

/** Two dbt projects (proj_a, proj_b), each with a model and a macro, plus a workflow file; returns the base sha. */
async function fixture(opts: { nested?: boolean } = {}): Promise<{ root: string; base: string }> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "review-all-projects-")))
  await g(root, "init", "-q", "-b", "main")
  await g(root, "config", "user.email", "t@test")
  await g(root, "config", "user.name", "t")
  await g(root, "config", "commit.gpgsign", "false")
  const projects = ["proj_a", "proj_b", ...(opts.nested ? ["proj_a/integration_tests"] : [])]
  for (const p of projects) {
    await write(root, `${p}/dbt_project.yml`, `name: ${p.replace("/", "_")}\nversion: '1.0'\nprofile: x\n`)
    await write(root, `${p}/models/orders.sql`, "select id, amount from {{ ref('stg') }}\n")
    await write(root, `${p}/macros/m.sql`, "{% macro m() %}select 1{% endmacro %}\n")
  }
  await write(root, ".github/workflows/x.yml", "on: push\n")
  return { root, base: await commitAll(root, "base") }
}

const strip = (e: VerdictEnvelope) => ({
  ...e,
  signature: undefined,
  generatedAt: undefined,
  scope: e.scope ? { ...e.scope, coveredProjects: undefined } : undefined,
})

describe("reviewAllProjects: one envelope for every dbt project a PR touches", () => {
  test("merges findings from both projects, scopes the ledger, and signs the result", async () => {
    const { root, base } = await fixture()
    await write(root, "proj_a/models/orders.sql", STAR_MODEL)
    await write(root, "proj_b/models/orders.sql", STAR_MODEL)
    await write(root, "proj_b/macros/m.sql", ORDINAL_MACRO)
    await write(root, ".github/workflows/x.yml", "on: [push]\n")
    await commitAll(root, "head")

    const env = await reviewAllProjects({ cwd: root, base, head: "HEAD", noAi: true })

    const files = new Set(env.findings.map((f) => f.file))
    expect(files.has("proj_a/models/orders.sql")).toBe(true)
    expect(files.has("proj_b/models/orders.sql")).toBe(true)
    expect(files.has("proj_b/macros/m.sql")).toBe(true)
    expect(new Set(env.findings.map((f) => f.id)).size).toBe(env.findings.length)

    expect(env.scope?.projects?.map((p) => p.root)).toEqual(["proj_a", "proj_b"])
    expect(env.scope?.projects?.map((p) => p.files)).toEqual([1, 2])
    // No single project root: the projects carry their own.
    expect(env.scope?.projectRoot).toBeUndefined()
    const outside = (env.scope?.notReviewed ?? []).filter((n) => /^outside the dbt project/.test(n.reason))
    expect(outside.map((n) => n.path)).toEqual([".github/workflows/x.yml"])
    expect(env.scope?.outOfScopeFiles).toBe(1)

    const rank = { APPROVE: 0, COMMENT: 1, REQUEST_CHANGES: 2 }
    const worst = env.scope!.projects!.map((p) => p.verdict).reduce((a, b) => (rank[b] > rank[a] ? b : a))
    expect(env.verdict).toBe(worst)
    const sev = (s: string) => env.findings.filter((f) => f.severity === s).length
    expect(env.summary.suggestion).toBe(sev("suggestion"))
    expect(env.summary.warning).toBe(sev("warning"))
    expect(env.ai?.projects?.map((p) => p.state)).toEqual(["skipped", "skipped"])
    expect(verifyEnvelope(env)).toBe(true)

    expect(renderSummary(env, { maxChars: Infinity, inline: false, allowSilent: false })).toContain(
      "Reviewed 2 dbt projects: proj_a, proj_b",
    )
    // Both projects were reviewed at one head; the poster's stale-run guard needs it.
    expect(env.scope?.headSha).toBe(await g(root, "rev-parse", "HEAD"))
    expect(env.scope?.coveredProjects).toEqual(["proj_a", "proj_b"])
  }, 60_000)

  test("a repo-root policy applies to every project without its own; a project policy wins; --mode only tightens", async () => {
    const { root } = await fixture()
    await write(root, ".altimate/review.yml", "mode: gate\n")
    await write(root, "proj_b/.altimate/review.yml", "mode: comment\n")
    const base = await commitAll(root, "policies")
    await write(root, "proj_a/models/orders.sql", STAR_MODEL)
    await write(root, "proj_b/models/orders.sql", STAR_MODEL)
    await commitAll(root, "head")

    const modes = (env: VerdictEnvelope) => env.scope?.projects?.map((p) => [p.root, p.mode])
    const env = await reviewAllProjects({ cwd: root, base, head: "HEAD", noAi: true })
    expect(modes(env)).toEqual([["proj_a", "gate"], ["proj_b", "comment"]])
    expect(env.mode).toBe("gate")
    // The PR-editable `--mode comment` cannot loosen proj_a's base `gate`, and the merge never re-applies it.
    const loosened = await reviewAllProjects({ cwd: root, base, head: "HEAD", noAi: true, mode: "comment" })
    expect(modes(loosened)).toEqual([["proj_a", "gate"], ["proj_b", "comment"]])
    expect(loosened.mode).toBe("gate")
    // One touched project from the repo root: the root policy still applies.
    await write(root, "proj_b/models/orders.sql", "select id, amount from {{ ref('stg') }}\n")
    await commitAll(root, "only a")
    const single = await reviewAllProjects({ cwd: root, base, head: "HEAD", noAi: true })
    expect([single.mode, single.policy?.source]).toEqual(["gate", "base"])
  }, 60_000)

  test("the root policy applies when invoked from inside the sole touched project", async () => {
    const { root } = await fixture()
    await write(root, ".altimate/review.yml", "mode: gate\n")
    const base = await commitAll(root, "policy")
    await write(root, "proj_a/models/orders.sql", STAR_MODEL)
    await commitAll(root, "head")

    const env = await reviewAllProjects({ cwd: path.join(root, "proj_a"), base, head: "HEAD", noAi: true })
    expect([env.mode, env.policy?.source]).toEqual(["gate", "base"])
    // Zero touched projects (only a file outside every project) from inside proj_a: same root policy.
    await write(root, "proj_a/models/orders.sql", "select id, amount from {{ ref('stg') }}\n")
    await write(root, ".github/workflows/x.yml", "on: [push]\n")
    await commitAll(root, "outside only")
    const none = await reviewAllProjects({ cwd: path.join(root, "proj_a"), base, head: "HEAD", noAi: true })
    expect([none.mode, none.policy?.source]).toEqual(["gate", "base"])
  }, 60_000)

  test("a sibling project's policy never governs another project, whatever the invocation directory", async () => {
    const { root } = await fixture()
    await write(root, ".altimate/review.yml", "mode: gate\n")
    await write(root, "proj_a/.altimate/review.yml", "mode: comment\n")
    const base = await commitAll(root, "policies")
    await write(root, "proj_a/models/orders.sql", STAR_MODEL)
    await write(root, "proj_b/models/orders.sql", STAR_MODEL)
    await commitAll(root, "head")

    const modes = (env: VerdictEnvelope) => env.scope?.projects?.map((p) => [p.root, p.mode])
    for (const cwd of [root, path.join(root, "proj_a"), path.join(root, "proj_b")]) {
      const env = await reviewAllProjects({ cwd, base, head: "HEAD", noAi: true })
      expect(modes(env)).toEqual([["proj_a", "comment"], ["proj_b", "gate"]])
    }
  }, 60_000)

  test("a PR-added project policy is diffed against the inherited policy it would replace", async () => {
    const { root } = await fixture()
    await write(root, ".altimate/review.yml", "mode: gate\n")
    const base = await commitAll(root, "policy")
    await write(root, "proj_a/models/orders.sql", STAR_MODEL)
    await write(root, "proj_b/models/orders.sql", STAR_MODEL)

    // `mode: comment` equals the default, but over the root's `gate` it would turn gating off.
    await write(root, "proj_a/.altimate/review.yml", "mode: comment\n")
    await commitAll(root, "loosen proj_a")
    const loosened = await reviewAllProjects({ cwd: root, base, head: "HEAD", noAi: true })
    expect(loosened.scope?.projects?.map((p) => [p.root, p.mode])).toEqual([["proj_a", "gate"], ["proj_b", "gate"]])
    expect(loosened.policy?.changedInPr).toEqual(["mode"])

    // A file identical to the inherited policy changes nothing.
    await write(root, "proj_a/.altimate/review.yml", "mode: gate\n")
    await commitAll(root, "same as root")
    const same = await reviewAllProjects({ cwd: root, base, head: "HEAD", noAi: true })
    expect(same.policy?.changedInPr).toBeUndefined()
  }, 60_000)

  test("discovery skips virtualenvs and finds dbt_project.yaml", async () => {
    const { root } = await fixture()
    await write(root, ".venv/lib/site-packages/dbt/include/starter_project/dbt_project.yml", "name: starter\n")
    await write(root, "venv/x/dbt_project.yml", "name: v\n")
    await write(root, "proj_c/dbt_project.yaml", "name: proj_c\nversion: '1.0'\nprofile: x\n")
    expect(await discoverDbtProjects(root)).toEqual(["proj_a", "proj_b", "proj_c"])
  }, 60_000)

  test("a PR touching one project returns the single-project envelope", async () => {
    const { root, base } = await fixture()
    await write(root, "proj_a/models/orders.sql", STAR_MODEL)
    await write(root, ".github/workflows/x.yml", "on: [push]\n")
    await commitAll(root, "head")
    const cwd = path.join(root, "proj_a")

    const single = await reviewPullRequest({ cwd, base, head: "HEAD", noAi: true })
    const all = await reviewAllProjects({ cwd, base, head: "HEAD", noAi: true })
    expect(strip(all)).toEqual(strip(single))
    expect(all.scope?.projects).toBeUndefined()
    // It still covers every discovered project, so it can reconcile an earlier all-projects review.
    expect(all.scope?.coveredProjects).toEqual(["proj_a", "proj_b"])
    expect(verifyEnvelope(all)).toBe(true)
    // From the repo root the one touched project is reviewed as if invoked from it.
    const fromRoot = await reviewAllProjects({ cwd: root, base, head: "HEAD", noAi: true })
    expect(strip(fromRoot)).toEqual(strip(single))
    expect(renderSummary(all, { maxChars: Infinity, inline: false, allowSilent: false })).not.toContain("dbt projects:")
  }, 60_000)

  test("a file goes to the deepest project containing it", async () => {
    const { root, base } = await fixture({ nested: true })
    await write(root, "proj_a/macros/m.sql", ORDINAL_MACRO)
    await write(root, "proj_a/integration_tests/models/orders.sql", STAR_MODEL)
    await commitAll(root, "head")

    const env = await reviewAllProjects({ cwd: root, base, head: "HEAD", noAi: true })
    expect(env.scope?.projects?.map((p) => [p.root, p.files])).toEqual([
      ["proj_a", 1],
      ["proj_a/integration_tests", 1],
    ])
    expect(env.findings.some((f) => f.file === "proj_a/integration_tests/models/orders.sql")).toBe(true)
    expect(env.findings.filter((f) => f.file === "proj_a/integration_tests/models/orders.sql").length).toBe(
      new Set(env.findings.filter((f) => f.file === "proj_a/integration_tests/models/orders.sql").map((f) => f.id)).size,
    )
  }, 60_000)

  test("--manifest applies only to the project that contains it", async () => {
    const { root, base } = await fixture()
    await write(root, "proj_a/models/orders.sql", STAR_MODEL)
    await write(root, "proj_b/models/orders.sql", STAR_MODEL)
    await commitAll(root, "head")
    // Outside target/, so auto-discovery cannot find it: only the flag supplies it.
    const body = JSON.stringify({ metadata: { adapter_type: "postgres" }, nodes: {}, sources: {} })
    for (const p of ["proj_a", "proj_b"]) await write(root, `${p}/artifacts/manifest.json`, body)
    const hashes = (env: VerdictEnvelope) => env.scope?.projects?.map((p) => [p.root, !!p.manifestHash])
    const run = (owner: string) =>
      reviewAllProjects({ cwd: root, base, head: "HEAD", noAi: true, manifestPath: path.join(root, owner, "artifacts", "manifest.json") })

    const a = await run("proj_a")
    expect(hashes(a)).toEqual([["proj_a", true], ["proj_b", false]])
    // The projects disagree, so the top level carries no manifest hash.
    expect(a.manifestHash).toBeUndefined()
    // A relative --manifest resolves against --cwd, as in the single-project path.
    const rel = await reviewAllProjects({ cwd: root, base, head: "HEAD", noAi: true, manifestPath: "proj_a/artifacts/manifest.json" })
    expect(hashes(rel)).toEqual([["proj_a", true], ["proj_b", false]])
    expect(hashes(await run("proj_b"))).toEqual([["proj_a", false], ["proj_b", true]])
  }, 60_000)

  test("--manifest outside every project (CI's $RUNNER_TEMP) goes to the one touched project", async () => {
    const { root, base } = await fixture()
    await write(root, "proj_a/models/orders.sql", STAR_MODEL)
    await commitAll(root, "head")
    const tmp = await fs.mkdtemp(path.join(tmpdir(), "review-manifest-"))
    const manifestPath = path.join(tmp, "manifest.json")
    await fs.writeFile(manifestPath, JSON.stringify({ metadata: { adapter_type: "postgres" }, nodes: {}, sources: {} }))
    const env = await reviewAllProjects({ cwd: root, base, head: "HEAD", noAi: true, manifestPath })
    expect(env.manifestHash).toBeDefined()
    // Two touched projects: it can't be attributed, so neither uses it (and a warning says so).
    await write(root, "proj_b/models/orders.sql", STAR_MODEL)
    await commitAll(root, "head2")
    const two = await reviewAllProjects({ cwd: root, base, head: "HEAD", noAi: true, manifestPath })
    expect(two.scope?.projects?.map((p) => p.manifestHash)).toEqual([undefined, undefined])
  }, 60_000)

  test("projects are discovered under non-ASCII directory names (head tree and working tree)", async () => {
    const { root } = await fixture()
    await write(root, "projé/dbt_project.yml", "name: proj_e\nversion: '1.0'\nprofile: x\n")
    await commitAll(root, "head")
    expect(await discoverDbtProjects(root, "HEAD")).toEqual(["proj_a", "proj_b", "projé"])
    expect(await discoverDbtProjects(root)).toEqual(["proj_a", "proj_b", "projé"])
  }, 60_000)

  test("a credential file another project renames unedited is refused to this project's verifier", async () => {
    const { root } = await fixture()
    // Built at runtime: an obviously fake marker, never a realistic secret.
    const marker = ["FAKE", "PW", "123"].join("_")
    await write(root, "proj_b/profiles.yml", `password: ${marker}\n`)
    const base = await commitAll(root, "profiles")
    await write(root, "proj_a/models/orders.sql", STAR_MODEL)
    await write(root, "proj_b/models/orders.sql", STAR_MODEL)
    await g(root, "mv", "proj_b/profiles.yml", "proj_b/settings.txt")
    await commitAll(root, "head")

    // Each project's AI lane runs with the verifier; capture what it would be handed.
    type Input = Parameters<typeof Orchestrate.runReview>[0]
    const real = Orchestrate.runReview
    const seen = new Map<string, Parameters<NonNullable<Input["aiReview"]>>[0]>()
    const spy = spyOn(Orchestrate, "runReview").mockImplementation((input: Input) =>
      real({
        ...input,
        forceTier: "full",
        aiVerify: true,
        aiReview: async (ai) => {
          seen.set(input.layout?.root ?? "", ai)
          return { findings: [], status: { state: "ok" } }
        },
      }),
    )
    try {
      await reviewAllProjects({ cwd: root, base, head: "HEAD" })
    } finally {
      spy.mockRestore()
    }
    const a = seen.get("proj_a")?.evidence
    expect(a).toBeDefined()
    expect(a!.prFiles).not.toContain("proj_b/settings.txt")
    expect(await a!.readFile("proj_b/settings.txt", "new")).toBe("not available: may hold credentials")
    expect(await a!.readFile("proj_b/settings.txt", "old")).toBe("not available: may hold credentials")
  }, 60_000)
})

describe("mergeProjectEnvelopes", () => {
  const finding = (file: string, severity: "critical" | "suggestion", tool: string) =>
    makeFinding({ severity, category: "semantic_change", title: `t ${file}`, body: "b", file, confidence: "high", evidence: { tool, result: {} } })

  test("takes the most severe verdict and highest tier, sums AI usage, de-duplicates findings by id", () => {
    const blocking = finding("b/models/x.sql", "critical", "altimate_core.equivalence")
    const shared = finding("a/models/y.sql", "suggestion", "rule-catalog")
    const a = signEnvelope(
      buildEnvelope({
        findings: [shared],
        tier: "lite",
        mode: "gate",
        ai: { state: "skipped", reason: "x", calls: 0 },
        scope: { projectRoot: "a", notReviewed: [{ path: "b/models/x.sql", reason: "outside the dbt project (a)" }] },
      }),
    )
    const b = signEnvelope(
      buildEnvelope({
        findings: [blocking, shared],
        tier: "full",
        mode: "gate",
        ai: {
          state: "ok",
          model: "p/m",
          calls: 2,
          cost: 0.5,
          tokens: { input: 1, inputTotal: 2, output: 3, reasoning: 4, cacheRead: 1 },
        },
        scope: { projectRoot: "b", notReviewed: [{ path: "a/models/y.sql", reason: "outside the dbt project (b)" }] },
      }),
    )
    expect(a.verdict).toBe("COMMENT")
    expect(b.verdict).toBe("REQUEST_CHANGES")

    const merged = mergeProjectEnvelopes([
      { root: "a", paths: ["a/models/y.sql"], env: a },
      { root: "b", paths: ["b/models/x.sql"], env: b },
    ])
    expect(merged.verdict).toBe("REQUEST_CHANGES")
    expect(merged.idealVerdict).toBe("REQUEST_CHANGES")
    expect(merged.tier).toBe("full")
    expect(merged.findings.map((f) => f.id)).toEqual([shared.id, blocking.id])
    expect(merged.summary).toMatchObject({ critical: 1, suggestion: 1, warning: 0 })
    expect(merged.scope?.notReviewed).toEqual([])
    expect(merged.scope?.outOfScopeFiles).toBeUndefined()
    expect(merged.ai).toMatchObject({ state: "ok", model: "p/m", calls: 2, cost: 0.5 })
    expect(merged.ai?.tokens).toEqual({ input: 1, inputTotal: 2, output: 3, reasoning: 4, cacheRead: 1 })
    expect(merged.ai?.projects).toEqual([
      { root: "a", state: "skipped", reason: "x", calls: 0 },
      { root: "b", state: "ok", calls: 2 },
    ])
    expect(verifyEnvelope(merged)).toBe(true)
  })

  test("a gate project's block survives the merge: modes come from the projects, never re-applied", () => {
    const blocking = finding("a/models/x.sql", "critical", "altimate_core.equivalence")
    const gateA = signEnvelope(buildEnvelope({ findings: [blocking], tier: "full", mode: "gate" }))
    const commentB = signEnvelope(buildEnvelope({ findings: [], tier: "lite", mode: "comment" }))
    const merged = mergeProjectEnvelopes([
      { root: "a", paths: ["a/models/x.sql"], env: gateA },
      { root: "b", paths: [], env: commentB },
    ])
    expect([merged.mode, merged.verdict]).toEqual(["gate", "REQUEST_CHANGES"])
    const allComment = mergeProjectEnvelopes([
      { root: "a", paths: [], env: signEnvelope(buildEnvelope({ findings: [blocking], tier: "full", mode: "comment" })) },
      { root: "b", paths: [], env: commentB },
    ])
    expect([allComment.mode, allComment.verdict]).toEqual(["comment", "COMMENT"])
  })

  test("the merged scope carries the shared head; projects reviewed at different heads fail", () => {
    const at = (headSha: string, headParents?: string[]) =>
      signEnvelope(buildEnvelope({ findings: [], tier: "lite", mode: "gate", scope: { headSha, headParents, notReviewed: [] } }))
    const merged = mergeProjectEnvelopes([
      { root: "a", paths: [], env: at("h", ["p1", "h"]) },
      { root: "b", paths: [], env: at("h", ["p1", "h"]) },
    ])
    expect([merged.scope?.headSha, merged.scope?.headParents]).toEqual(["h", ["p1", "h"]])
    expect(merged.scope?.coveredProjects).toEqual(["a", "b"])
    expect(() =>
      mergeProjectEnvelopes([
        { root: "a", paths: [], env: at("h1") },
        { root: "b", paths: [], env: at("h2") },
      ]),
    ).toThrow("different head commits")
  })

  test("AI input records, unsent files and verifier usage are merged across projects", () => {
    const rec = (p: string) => ({ path: p, kind: "model_sql", chars: 10, truncated: false, hunksSent: 1, hunksTotal: 1, card: false })
    const verifier = (cost: number, reason?: string, state: "ok" | "error" = "ok") => ({
      state,
      reason,
      cost,
      turns: 1,
      toolCalls: 2,
      reviewed: 1,
      kept: 1,
      discarded: 0,
      tokens: { input: 1, inputTotal: 1, output: 1, reasoning: 0, cacheRead: 0 },
    })
    const env = (root: string, v: ReturnType<typeof verifier>) =>
      signEnvelope(
        buildEnvelope({
          findings: [],
          tier: "full",
          mode: "comment",
          ai: { state: "ok", calls: 1, input: [rec(`${root}/m.sql`)], unsent: [`${root}/n.sql`], verifier: v },
        }),
      )
    const merged = mergeProjectEnvelopes([
      { root: "a", paths: [], env: env("a", verifier(2)) },
      { root: "b", paths: [], env: env("b", verifier(2, "timed out", "error")) },
    ])
    expect(merged.ai?.input?.map((r) => r.path)).toEqual(["a/m.sql", "b/m.sql"])
    expect(merged.ai?.unsent).toEqual(["a/n.sql", "b/n.sql"])
    expect(merged.ai?.verifier).toMatchObject({ state: "error", reason: "b: timed out", cost: 4, turns: 2, toolCalls: 4, reviewed: 2, kept: 2 })
    expect(merged.ai?.verifier?.tokens).toEqual({ input: 2, inputTotal: 2, output: 2, reasoning: 0, cacheRead: 0 })
    expect(verifyEnvelope(merged)).toBe(true)
  })

  test("a merged envelope reconciles earlier per-project blocks it covers, and only those", async () => {
    const calls: Record<string, any[]> = { createReview: [], dismissReview: [] }
    const bot = { type: "Bot" }
    const block = (id: number, marker: string) => ({
      id,
      body: `🛑 Changes requested — 1 critical (full tier)\n\n<!-- altimate-code-review:verdict${marker} -->`,
      state: "CHANGES_REQUESTED",
      user: bot,
    })
    const reviews = [block(1, " project=a"), block(2, " project=b"), block(3, " project=c"), block(4, " projects=a,b"), block(5, " projects=a,c")]
    const client = {
      async paginate(fn: any) {
        return fn === client.rest.pulls.listReviews ? reviews : []
      },
      rest: {
        issues: { listComments: () => {}, createComment: async () => ({ data: { id: 1 } }), updateComment: async () => ({ data: { id: 1 } }) },
        pulls: {
          listReviewComments: () => {},
          listReviews: () => {},
          get: async () => ({ data: { head: { sha: "h" } } }),
          createReview: async (a: any) => (calls.createReview.push(a), { data: { id: 9 } }),
          dismissReview: async (a: any) => (calls.dismissReview.push(a), { data: {} }),
        },
      },
    } as unknown as GitHubClient
    // Comment mode: the run has something to say but does not block, so it may clear earlier blocks.
    const clean = (root: string) =>
      signEnvelope(buildEnvelope({ findings: [finding(`${root}/models/y.sql`, "critical", "rule-catalog")], tier: "lite", mode: "comment", scope: { projectRoot: root, headSha: "h", notReviewed: [] } }))
    const merged = mergeProjectEnvelopes([
      { root: "a", paths: [], env: clean("a") },
      { root: "b", paths: [], env: clean("b") },
    ])
    const target = { token: "t", owner: "o", repo: "r", prNumber: 1 }
    await postGitHubReview(merged, target, client)
    expect(calls.dismissReview.map((c) => c.review_id)).toEqual([1, 2, 4])
    // With no earlier review to reuse, it posts under a marker naming every project it covers.
    reviews.length = 0
    await postGitHubReview(merged, target, client)
    expect(calls.createReview[0].body).toContain("<!-- altimate-code-review:verdict projects=a,b -->")
  })

  test("a comment-mode project's REQUEST_CHANGES does not block a gate-mode merge", () => {
    const soft = signEnvelope(buildEnvelope({ findings: [finding("a/models/x.sql", "critical", "altimate_core.equivalence")], tier: "full", mode: "comment" }))
    const gate = signEnvelope(buildEnvelope({ findings: [finding("b/models/y.sql", "suggestion", "rule-catalog")], tier: "full", mode: "gate" }))
    expect([soft.idealVerdict, soft.verdict, gate.verdict]).toEqual(["REQUEST_CHANGES", "COMMENT", "COMMENT"])
    const merged = mergeProjectEnvelopes([
      { root: "a", paths: [], env: soft },
      { root: "b", paths: [], env: gate },
    ])
    expect(merged.mode).toBe("gate")
    expect(merged.verdict).toBe("COMMENT")
    expect(merged.idealVerdict).toBe("REQUEST_CHANGES")
    expect(merged.scope?.projects?.map((p) => p.mode)).toEqual(["comment", "gate"])
  })

  test("a sibling's AI error is not hidden by another project's ok; differing policies and manifests stay per project", () => {
    const env = (root: string, ai: VerdictEnvelope["ai"], hash: string, manifestHash: string) =>
      signEnvelope(
        buildEnvelope({
          findings: [],
          tier: "lite",
          mode: "comment",
          ai,
          manifestHash,
          policy: { source: root === "a" ? "base" : "working_tree", hash, posting: undefined },
          scope: { projectRoot: root, notReviewed: [] },
        }),
      )
    const a = env("a", { state: "ok", model: "p/m", calls: 1 }, "h_a", "m_a")
    const b = env("b", { state: "error", reason: "rate limited", calls: 1 }, "h_b", "m_b")
    const merged = mergeProjectEnvelopes([
      { root: "a", paths: [], env: a },
      { root: "b", paths: [], env: b },
    ])
    expect(merged.ai).toMatchObject({ state: "error", reason: "b: rate limited", model: "p/m", calls: 2 })
    expect(merged.ai?.projects?.map((p) => [p.root, p.state, p.reason])).toEqual([
      ["a", "ok", undefined],
      ["b", "error", "rate limited"],
    ])
    expect(merged.manifestHash).toBeUndefined()
    expect(merged.policy?.source).toBe("working_tree")
    expect(merged.policy?.hash).not.toBe("h_a")
    expect(merged.scope?.projectRoot).toBeUndefined()
    expect(merged.scope?.projects?.map((p) => [p.manifestHash, p.policyHash])).toEqual([
      ["m_a", "h_a"],
      ["m_b", "h_b"],
    ])
    expect(verifyEnvelope(merged)).toBe(true)
    // Identical policies are kept as they are.
    const same = mergeProjectEnvelopes([
      { root: "a", paths: [], env: a },
      { root: "c", paths: [], env: env("a", { state: "ok", calls: 0 }, "h_a", "m_a") },
    ])
    expect(same.policy).toEqual(a.policy)
    expect(same.manifestHash).toBe("m_a")
  })

  test("assignment helpers pick the deepest root and fall back to a rename's old path", () => {
    const roots = ["", "pkg", "pkg/integration_tests"]
    expect(owningProject("pkg/macros/a.sql", roots)).toBe("pkg")
    expect(owningProject("pkg/integration_tests/models/a.sql", roots)).toBe("pkg/integration_tests")
    expect(owningProject("README.md", roots)).toBe("")
    expect(owningProject("README.md", ["pkg"])).toBeUndefined()
    const files: ChangedFile[] = [
      { path: "docs/a.sql", oldPath: "pkg/models/a.sql", status: "renamed" } as ChangedFile,
      { path: "other/x.yml", status: "modified" } as ChangedFile,
    ]
    const { byProject, unassigned } = assignToProjects(files, ["pkg"])
    expect(byProject.get("pkg")?.map((f) => f.path)).toEqual(["docs/a.sql"])
    expect(unassigned.map((f) => f.path)).toEqual(["other/x.yml"])
  })
})
