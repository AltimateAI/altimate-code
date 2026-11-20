import { describe, test, expect } from "bun:test"
import { runReview, type ReviewRunner } from "../../src/altimate/review/orchestrate"
import { DEFAULT_REVIEW_CONFIG } from "../../src/altimate/review/config"
import { DEFAULT_RUBRIC } from "../../src/altimate/review/rubric"
import { makeFinding } from "../../src/altimate/review/finding"
import { buildEnvelope, signEnvelope, verifyEnvelope } from "../../src/altimate/review/verdict"
import { renderSummary, findingMarker } from "../../src/altimate/review/format"
import { postGitHubReview, type GitHubClient } from "../../src/altimate/review/post-github"
import { commitParents } from "../../src/altimate/review/git"

/**
 * A review must never look clean because something broke: engine failures and
 * PII abstentions are reported, one file's crash degrades only that file, and
 * a blocking review is cleared when a rerun no longer blocks.
 */

function runner(over: Partial<ReviewRunner> = {}): ReviewRunner {
  return {
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
    ...over,
  } as ReviewRunner
}

const two = [
  { path: "models/a.sql", status: "added" as const, diff: "+select 1 as id\n" },
  { path: "models/b.sql", status: "added" as const, diff: "+select 2 as id\n" },
]

describe("engine failures are never clean", () => {
  test("no findings plus an engine failure is COMMENT, not APPROVE, and the failure is shown", async () => {
    const env = await runReview({
      changedFiles: two,
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["sql_quality"] },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner: runner({ failures: () => [{ method: "check", reason: "native core not loaded", count: 2 }] }),
      getContent: async (f) => (f.endsWith("a.sql") ? "select 1 as id" : "select 2 as id"),
    })
    expect(env.findings).toHaveLength(0)
    expect(env.idealVerdict).toBe("COMMENT")
    expect(env.engineErrors).toEqual([{ method: "check", reason: "native core not loaded", count: 2 }])
    expect(renderSummary(env)).toContain("Some engine checks failed and did not run: check ×2 (native core not loaded)")
  })

  test("engine errors are signed", () => {
    const env = signEnvelope(
      buildEnvelope({ findings: [], tier: "lite", mode: "comment", engineErrors: [{ method: "equivalence", reason: "x", count: 1 }] }),
    )
    expect(env.verdict).toBe("COMMENT")
    expect(verifyEnvelope(env)).toBe(true)
    expect(verifyEnvelope({ ...env, engineErrors: undefined })).toBe(false)
  })

  test("without failures an empty review still approves", () => {
    expect(buildEnvelope({ findings: [], tier: "lite", mode: "comment" }).verdict).toBe("APPROVE")
  })
})

describe("one file's failure degrades only that file", () => {
  test("unreadable content for one model: the other is still reviewed", async () => {
    let checked: string[] = []
    const env = await runReview({
      changedFiles: two,
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["sql_quality"] },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner: runner({
        async check(sql: string) {
          checked.push(sql)
          return { issues: [], ran: true }
        },
      }),
      getContent: async (f) => {
        if (f.endsWith("a.sql")) throw new Error("EACCES: permission denied")
        return "select 2 as id"
      },
    })
    expect(checked).toContain("select 2 as id")
    expect(env.scope?.unverified).toEqual([
      { path: "models/a.sql", reason: "review failed for this file: EACCES: permission denied", kind: "failed" },
    ])
    // A file that was never reviewed is not a clean pass.
    expect(env.verdict).not.toBe("APPROVE")
    expect(env.idealVerdict).toBe("COMMENT")
  })

  test("a lane that throws on one file keeps the other file's findings", async () => {
    const env = await runReview({
      changedFiles: two,
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["sql_quality"] },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner: runner({
        async check(sql: string) {
          if (sql.includes("1")) throw new Error("engine panic")
          return { issues: [{ rule: "select-star", message: "avoid", severity: "warning" }], ran: true }
        },
      }),
      getContent: async (f) => (f.endsWith("a.sql") ? "select 1 as id" : "select 2 as id"),
    })
    expect(env.findings.some((f) => f.file === "models/b.sql")).toBe(true)
    expect(env.scope?.unverified?.map((u) => u.path)).toEqual(["models/a.sql"])
  })
})

describe("a file whose review failed is never approved", () => {
  test("a failed-file entry downgrades an otherwise clean verdict to COMMENT", () => {
    const env = buildEnvelope({
      findings: [],
      tier: "lite",
      mode: "comment",
      scope: { unverified: [{ path: "models/a.sql", reason: "review failed for this file: boom" }] } as any,
    })
    expect(env.idealVerdict).toBe("COMMENT")
  })

  test("a synchronous detector that throws degrades only its file", async () => {
    const env = await runReview({
      changedFiles: [{ path: "models/schema.yml", kind: "schema_yml", status: "modified" as const, diff: "-      - unique\n" }] as any,
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["sql_quality"] },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner: runner(),
      getContent: async () => {
        throw new Error("git show failed")
      },
    })
    expect(env.scope?.unverified).toEqual([{ path: "models/schema.yml", reason: "review failed for this file: git show failed", kind: "failed" }])
    expect(env.idealVerdict).toBe("COMMENT")
  })
})

describe("a model without compiled SQL", () => {
  const notCompiled = (side: "head" | "base" | undefined) =>
    buildEnvelope({
      findings: [],
      tier: "lite",
      mode: "comment",
      scope: { unverified: [{ path: "models/m.sql", reason: `no compiled SQL for the ${side ?? "head"}`, kind: "not_compiled", side }] },
    })
  test("no compiled head SQL (engine and PII checks skipped) is never approved", () => {
    expect(notCompiled("head").idealVerdict).toBe("COMMENT")
    // Envelopes written before `side` existed are treated as head-side.
    expect(notCompiled(undefined).idealVerdict).toBe("COMMENT")
  })
  test("no compiled base SQL only weakens the base comparison: the run can still approve", () => {
    expect(notCompiled("base").idealVerdict).toBe("APPROVE")
  })
  test("orchestration records which side lacked compiled SQL", async () => {
    const env = await runReview({
      changedFiles: [{ path: "models/m.sql", status: "added" as const, diff: "+select {{ ref('a') }}\n" }],
      getContent: async () => "select * from {{ ref('a') }}",
      runner: runner(),
      config: DEFAULT_REVIEW_CONFIG,
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
    })
    const u = env.scope?.unverified?.find((x) => x.path === "models/m.sql")
    expect(u).toMatchObject({ kind: "not_compiled", side: "head" })
    expect(env.idealVerdict).not.toBe("APPROVE")
  })
})

describe("PII abstention", () => {
  test("an unanalysable base does not report every head PII column as newly exposed", async () => {
    const env = await runReview({
      changedFiles: [{ path: "models/a.sql", status: "modified" as const, diff: "-select 1 as id\n+select email from users\n" }],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["pii_exposure"] },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner: runner({
        async detectPii(sql: string) {
          return sql.includes("email") ? { columns: ["email"] } : { columns: [], abstained: true }
        },
      }),
      getContent: async (_f, side) => (side === "new" ? "select email from users" : "select 1 as id"),
    })
    expect(env.findings.filter((f) => f.category === "pii_exposure")).toHaveLength(0)
    expect(env.scope?.unverified).toContainEqual({
      path: "models/a.sql",
      reason: "the PII check could not analyse the base model",
      kind: "abstained",
    })
  })

  test("a PII check that could not analyse the model is reported, not treated as clean", async () => {
    const env = await runReview({
      changedFiles: [two[0]],
      config: { ...DEFAULT_REVIEW_CONFIG, reviewers: ["sql_quality"] },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner: runner({
        async detectPii() {
          return { columns: [], abstained: true }
        },
      }),
      getContent: async () => "select 1 as id",
    })
    expect(env.scope?.unverified).toEqual([
      { path: "models/a.sql", reason: "the PII check could not analyse this model", kind: "abstained" },
    ])
    expect(renderSummary(env)).toContain("the PII check could not analyse this model")
    // An abstention is "not checked", so the run cannot APPROVE.
    expect(env.idealVerdict).toBe("COMMENT")
  })
})

describe("posting: dedup, dismissal of a stale block, no repeat reviews", () => {
  function fakeClient(state: {
    reviewComments?: Array<{ body: string }>
    reviews?: Array<{ id: number; body: string; state: string; user?: { type: string; login?: string } }>
  }) {
    const calls: Record<string, any[]> = { createReview: [], dismissReview: [], createComment: [], updateComment: [] }
    const client = {
      async paginate(fn: any) {
        if (fn === client.rest.issues.listComments) return []
        if (fn === client.rest.pulls.listReviewComments) return state.reviewComments ?? []
        if (fn === client.rest.pulls.listReviews) return state.reviews ?? []
        return []
      },
      rest: {
        issues: {
          listComments: () => {},
          async createComment(a: any) {
            calls.createComment.push(a)
            return { data: { id: 1 } }
          },
          async updateComment(a: any) {
            calls.updateComment.push(a)
            return { data: { id: 1 } }
          },
        },
        pulls: {
          listReviewComments: () => {},
          listReviews: () => {},
          async get() {
            return { data: { head: { sha: "abc" } } }
          },
          async createReview(a: any) {
            calls.createReview.push(a)
            return { data: { id: 99 } }
          },
          async dismissReview(a: any) {
            calls.dismissReview.push(a)
            return { data: {} }
          },
        },
      },
    }
    return { client: client as unknown as GitHubClient, calls }
  }
  const target = { token: "t", owner: "o", repo: "r", prNumber: 7 }
  const bot = { type: "Bot" }
  const engineFinding = (line?: number) =>
    makeFinding({
      severity: "warning",
      category: "sql_quality",
      title: "m: select-star",
      body: "avoid",
      file: "models/m.sql",
      model: "m",
      startLine: line,
      evidence: { tool: "altimate_core.check", result: {} },
      ruleKey: "q:select-star",
    })

  test("a clean rerun dismisses the earlier blocking altimate review", async () => {
    const env = buildEnvelope({ findings: [], tier: "lite", mode: "gate", scope: { headSha: "abc" } })
    const { client, calls } = fakeClient({
      reviews: [
        { id: 11, body: "🛑 Changes requested — 1 critical (full tier)", state: "CHANGES_REQUESTED", user: bot },
        { id: 12, body: "LGTM from a human", state: "CHANGES_REQUESTED" },
      ],
    })
    const r = await postGitHubReview(env, target, client)
    expect(calls.dismissReview.map((c) => c.review_id)).toEqual([11])
    expect(r.dismissedReviews).toBe(1)
  })

  test("a human review is never dismissed, even when it copies the bot's body including the marker", async () => {
    const env = buildEnvelope({ findings: [], tier: "lite", mode: "gate", scope: { headSha: "abc" } })
    const marked = "🛑 Changes requested — 1 critical (full tier)\n\n<!-- altimate-code-review:verdict -->"
    const { client, calls } = fakeClient({
      reviews: [
        { id: 21, body: "Changes requested (full tier) until the backfill is fixed", state: "CHANGES_REQUESTED", user: { type: "User" } },
        { id: 22, body: marked, state: "CHANGES_REQUESTED", user: { type: "User", login: "alice" } },
        { id: 23, body: marked, state: "CHANGES_REQUESTED", user: bot },
      ],
    })
    await postGitHubReview(env, target, client)
    expect(calls.dismissReview.map((c) => c.review_id)).toEqual([23])
  })

  test("with a personal token, the token's own marked reviews are the bot's", async () => {
    const env = buildEnvelope({ findings: [], tier: "lite", mode: "gate", scope: { headSha: "abc" } })
    const marked = "🛑 Changes requested — 1 critical (full tier)\n\n<!-- altimate-code-review:verdict -->"
    const { client, calls } = fakeClient({
      reviews: [
        { id: 24, body: marked, state: "CHANGES_REQUESTED", user: { type: "User", login: "ci-user" } },
        { id: 25, body: marked, state: "CHANGES_REQUESTED", user: { type: "User", login: "alice" } },
      ],
    })
    ;(client.rest as any).users = { getAuthenticated: async () => ({ data: { login: "ci-user" } }) }
    await postGitHubReview(env, target, client)
    expect(calls.dismissReview.map((c) => c.review_id)).toEqual([24])
  })

  test("a rerun where the engine or a file failed does not clear the block", async () => {
    const blocking = [{ id: 11, body: "🛑 Changes requested — 1 critical (full tier)", state: "CHANGES_REQUESTED", user: bot }]
    const crashed = buildEnvelope({
      findings: [],
      tier: "full",
      mode: "gate",
      engineErrors: [{ method: "check", reason: "native core not loaded", count: 3 }],
    })
    const a = fakeClient({ reviews: blocking })
    await postGitHubReview(crashed, target, a.client)
    expect(a.calls.dismissReview).toHaveLength(0)

    const fileFailed = buildEnvelope({
      findings: [],
      tier: "full",
      mode: "gate",
      scope: { unverified: [{ path: "models/m.sql", reason: "review failed for this file: boom" }] } as any,
    })
    const b = fakeClient({ reviews: blocking })
    await postGitHubReview(fileFailed, target, b.client)
    expect(b.calls.dismissReview).toHaveLength(0)
  })

  test("a rerun where the PII check abstained does not clear an earlier PII block", async () => {
    const blocking = [{ id: 11, body: "🛑 Changes requested — 1 critical (full tier)", state: "CHANGES_REQUESTED", user: bot }]
    const abstained = buildEnvelope({
      findings: [],
      tier: "full",
      mode: "gate",
      scope: { unverified: [{ path: "models/m.sql", reason: "the PII check could not analyse this model", kind: "abstained" }] },
    })
    expect(abstained.idealVerdict).toBe("COMMENT")
    const { client, calls } = fakeClient({ reviews: blocking })
    await postGitHubReview(abstained, target, client)
    expect(calls.dismissReview).toHaveLength(0)
  })

  test("a run on an older push never clears the block", async () => {
    const env = buildEnvelope({ findings: [], tier: "lite", mode: "gate", scope: { headSha: "old" } })
    const { client, calls } = fakeClient({
      reviews: [{ id: 11, body: "🛑 Changes requested — 1 critical (full tier)", state: "CHANGES_REQUESTED", user: bot }],
    })
    await postGitHubReview(env, target, client)
    expect(calls.dismissReview).toHaveLength(0)
    const current = buildEnvelope({ findings: [], tier: "lite", mode: "gate", scope: { headSha: "abc" } })
    const b = fakeClient({
      reviews: [{ id: 11, body: "🛑 Changes requested — 1 critical (full tier)", state: "CHANGES_REQUESTED", user: bot }],
    })
    await postGitHubReview(current, target, b.client)
    expect(b.calls.dismissReview.map((c) => c.review_id)).toEqual([11])
  })

  test("in a monorepo one project's clean run never dismisses another project's block", async () => {
    const env = buildEnvelope({
      findings: [engineFinding(3)],
      tier: "lite",
      mode: "gate",
      scope: { projectRoot: "projects/a", headSha: "abc" },
    })
    const { client, calls } = fakeClient({
      reviews: [
        {
          id: 31,
          body: "🛑 Changes requested — 1 critical (full tier)\n\n<!-- altimate-code-review:verdict project=projects/b -->",
          state: "CHANGES_REQUESTED",
          user: bot,
        },
        {
          id: 32,
          body: "🛑 Changes requested — 1 critical (full tier)\n\n<!-- altimate-code-review:verdict project=projects/a -->",
          state: "CHANGES_REQUESTED",
          user: bot,
        },
      ],
    })
    await postGitHubReview(env, target, client)
    expect(calls.dismissReview.map((c) => c.review_id)).toEqual([32])
    expect(calls.createReview[0].body).toContain("<!-- altimate-code-review:verdict project=projects/a -->")
  })

  test("a merge-commit checkout of the PR head (pull_request event) clears the block", async () => {
    const blocking = [{ id: 11, body: "🛑 Changes requested — 1 critical (full tier)", state: "CHANGES_REQUESTED", user: bot }]
    const merge = buildEnvelope({
      findings: [],
      tier: "lite",
      mode: "gate",
      scope: { headSha: "merge1", headParents: ["base1", "abc"] },
    })
    const a = fakeClient({ reviews: blocking })
    await postGitHubReview(merge, target, a.client)
    expect(a.calls.dismissReview.map((c) => c.review_id)).toEqual([11])

    // A merge commit built from an older push of the PR keeps the block.
    const stale = buildEnvelope({
      findings: [],
      tier: "lite",
      mode: "gate",
      scope: { headSha: "merge0", headParents: ["base1", "old"] },
    })
    const b = fakeClient({ reviews: blocking })
    await postGitHubReview(stale, target, b.client)
    expect(b.calls.dismissReview).toHaveLength(0)
  })

  test("an unknown reviewed commit or PR head keeps the block (fails closed)", async () => {
    const blocking = [{ id: 11, body: "🛑 Changes requested — 1 critical (full tier)", state: "CHANGES_REQUESTED", user: bot }]
    const noHead = buildEnvelope({ findings: [], tier: "lite", mode: "gate" })
    const a = fakeClient({ reviews: blocking })
    await postGitHubReview(noHead, target, a.client)
    expect(a.calls.dismissReview).toHaveLength(0)

    const env = buildEnvelope({ findings: [], tier: "lite", mode: "gate", scope: { headSha: "abc" } })
    const b = fakeClient({ reviews: blocking })
    ;(b.client.rest.pulls as any).get = async () => {
      throw Object.assign(new Error("Not Found"), { status: 404 })
    }
    await postGitHubReview(env, target, b.client)
    expect(b.calls.dismissReview).toHaveLength(0)
  })

  test("a rerun without compiled head SQL for a blocked model does not clear the block", async () => {
    const blocking = [{ id: 11, body: "🛑 Changes requested — 1 critical (full tier)", state: "CHANGES_REQUESTED", user: bot }]
    const notCompiled = buildEnvelope({
      findings: [],
      tier: "full",
      mode: "gate",
      scope: {
        headSha: "abc",
        unverified: [{ path: "models/m.sql", reason: "no compiled SQL for the head (run dbt compile)", kind: "not_compiled", side: "head" }],
      },
    })
    expect(notCompiled.idealVerdict).toBe("COMMENT")
    const { client, calls } = fakeClient({ reviews: blocking })
    await postGitHubReview(notCompiled, target, client)
    expect(calls.dismissReview).toHaveLength(0)
  })

  test("a pre-marker bot review of a project below the root is still matched; a project with spaces round-trips", async () => {
    const legacy = buildEnvelope({ findings: [], tier: "lite", mode: "gate", scope: { projectRoot: "projects/a", headSha: "abc" } })
    const a = fakeClient({
      reviews: [{ id: 41, body: "🛑 Changes requested — 1 critical (full tier)", state: "CHANGES_REQUESTED", user: bot }],
    })
    await postGitHubReview(legacy, target, a.client)
    expect(a.calls.dismissReview.map((c) => c.review_id)).toEqual([41])

    const spaced = buildEnvelope({
      findings: [engineFinding(3)],
      tier: "lite",
      mode: "gate",
      scope: { projectRoot: "my project", headSha: "abc" },
    })
    const first = fakeClient({ reviews: [] })
    await postGitHubReview(spaced, target, first.client)
    const body = first.calls.createReview[0].body as string
    expect(body).toContain("project=my%20project")
    const b = fakeClient({ reviews: [{ id: 42, body: body.replace("Reviewed with comments", "Changes requested"), state: "CHANGES_REQUESTED", user: bot }] })
    await postGitHubReview(spaced, target, b.client)
    expect(b.calls.dismissReview.map((c) => c.review_id)).toEqual([42])
  })

  test("the block is dismissed only after the replacement review is posted", async () => {
    const env = buildEnvelope({ findings: [engineFinding(3)], tier: "lite", mode: "gate" })
    const { client, calls } = fakeClient({
      reviews: [{ id: 11, body: "🛑 Changes requested — 1 critical (full tier)", state: "CHANGES_REQUESTED", user: bot }],
    })
    const order: string[] = []
    ;(client.rest.pulls as any).createReview = async () => {
      order.push("create")
      throw Object.assign(new Error("Server Error"), { status: 502 })
    }
    ;(client.rest.pulls as any).dismissReview = async () => {
      order.push("dismiss")
      return { data: {} }
    }
    const r = await postGitHubReview(env, target, client)
    expect(r.postError).toContain("502")
    expect(order).toEqual(["create", "create"])
    expect(calls.dismissReview).toHaveLength(0)
  })

  test("a still-blocking rerun does not dismiss and posts REQUEST_CHANGES", async () => {
    const blocking = makeFinding({
      severity: "critical",
      category: "lineage_breakage",
      title: "m: breaks downstream",
      body: "x",
      file: "models/m.sql",
      evidence: { tool: "impact_analysis", result: {} },
    })
    const env = buildEnvelope({ findings: [blocking], tier: "full", mode: "gate" })
    const { client, calls } = fakeClient({
      reviews: [{ id: 11, body: "🛑 Changes requested — 1 critical (full tier)", state: "CHANGES_REQUESTED", user: bot }],
    })
    await postGitHubReview(env, target, client)
    expect(calls.dismissReview).toHaveLength(0)
    expect(calls.createReview[0].event).toBe("REQUEST_CHANGES")
    expect(calls.createReview[0].body).toContain("<!-- altimate-code-review:verdict -->")
  })

  test("findings already on the PR are not re-posted, and with nothing new no review is added", async () => {
    const f = engineFinding(3)
    const env = buildEnvelope({ findings: [f], tier: "lite", mode: "comment" })
    const { client, calls } = fakeClient({
      reviewComments: [{ body: `⚠️ old\n\n${findingMarker(f.id)}` }],
      reviews: [{ id: 5, body: "💬 Reviewed with comments — 1 warning (lite tier)", state: "COMMENTED", user: bot }],
    })
    const r = await postGitHubReview(env, target, client)
    expect(r.inlineSkippedAsPosted).toBe(1)
    expect(r.reviewSkipped).toBe(true)
    expect(calls.createReview).toHaveLength(0)
    expect(calls.createComment.length + calls.updateComment.length).toBe(1)
  })
})

describe("merge-commit checkout", () => {
  test("commitParents reports a merge commit's parents even in a depth-1 clone", async () => {
    const exec = (await import("node:util")).promisify((await import("node:child_process")).execFile)
    const fsp = (await import("node:fs")).promises
    const os = await import("node:os")
    const pth = await import("node:path")
    const g = (cwd: string, ...a: string[]) => exec("git", a, { cwd }).then((r) => r.stdout.trim())
    const origin = await fsp.realpath(await fsp.mkdtemp(pth.join(os.tmpdir(), "merge-origin-")))
    await g(origin, "init", "-q", "-b", "main")
    await g(origin, "config", "user.email", "t@t")
    await g(origin, "config", "user.name", "t")
    await g(origin, "config", "commit.gpgsign", "false")
    const commit = async (file: string, msg: string) => {
      await fsp.writeFile(pth.join(origin, file), `${msg}\n`)
      await g(origin, "add", "-A")
      await g(origin, "commit", "-qm", msg)
    }
    await commit("seed.sql", "seed")
    await g(origin, "checkout", "-q", "-b", "pr")
    await commit("pr.sql", "pr")
    const prHead = await g(origin, "rev-parse", "HEAD")
    await g(origin, "checkout", "-q", "main")
    await commit("main.sql", "main")
    const baseTip = await g(origin, "rev-parse", "HEAD")
    await g(origin, "merge", "-q", "--no-ff", "-m", "merge pr", "pr")
    const merge = await g(origin, "rev-parse", "HEAD")
    expect(await commitParents(merge, origin)).toEqual([baseTip, prHead])
    expect(await commitParents(prHead, origin)).toHaveLength(1)

    const clone = await fsp.realpath(await fsp.mkdtemp(pth.join(os.tmpdir(), "merge-clone-")))
    await exec("git", ["clone", "-q", "--depth", "1", "--branch", "main", `file://${origin}`, clone])
    expect(await commitParents(merge, clone)).toEqual([baseTip, prHead])
  }, 30_000)
})
