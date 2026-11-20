import { describe, test, expect } from "bun:test"
import { runReview, type ReviewRunner } from "../../src/altimate/review/orchestrate"
import { DEFAULT_REVIEW_CONFIG } from "../../src/altimate/review/config"
import { DEFAULT_RUBRIC } from "../../src/altimate/review/rubric"
import { makeFinding } from "../../src/altimate/review/finding"
import { buildEnvelope, signEnvelope, verifyEnvelope } from "../../src/altimate/review/verdict"
import { renderSummary, findingMarker } from "../../src/altimate/review/format"
import { postGitHubReview, type GitHubClient } from "../../src/altimate/review/post-github"

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
    reviews?: Array<{ id: number; body: string; state: string; user?: { type: string } }>
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
    const env = buildEnvelope({ findings: [], tier: "lite", mode: "gate" })
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

  test("a human review quoting the headline is never dismissed; the marker identifies the bot", async () => {
    const env = buildEnvelope({ findings: [], tier: "lite", mode: "gate" })
    const { client, calls } = fakeClient({
      reviews: [
        { id: 21, body: "Changes requested (full tier) until the backfill is fixed", state: "CHANGES_REQUESTED", user: { type: "User" } },
        {
          id: 22,
          body: "🛑 Changes requested — 1 critical (full tier)\n\n<!-- altimate-code-review:verdict -->",
          state: "CHANGES_REQUESTED",
          user: { type: "User" },
        },
      ],
    })
    await postGitHubReview(env, target, client)
    expect(calls.dismissReview.map((c) => c.review_id)).toEqual([22])
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
    const env = buildEnvelope({ findings: [engineFinding(3)], tier: "lite", mode: "gate", scope: { projectRoot: "projects/a" } })
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
