import { describe, expect, test } from "bun:test"
import { makeFinding } from "../../../src/altimate/review/finding"
import { REVIEW_MARKER, renderSummary } from "../../../src/altimate/review/format"
import { postGitHubReview } from "../../../src/altimate/review/post-github"
import { buildEnvelope } from "../../../src/altimate/review/verdict"

function finding(id: string) {
  return makeFinding({
    id,
    severity: "warning",
    category: "sql_quality",
    title: `Finding ${id}`,
    body: `Body ${id}.`,
    file: `models/${id}.sql`,
    ruleKey: id,
  })
}

function fakeOctokit(
  comments: Array<{ id: number; body: string; user: { login: string; type: string } }>,
  getAuthenticated: () => Promise<{ data: { login: string } }>,
  getAuthenticatedApp: () => Promise<{ data: { slug: string } }> = async () => {
    throw new Error("not an app token")
  },
) {
  const calls = {
    authenticated: 0,
    appAuthenticated: 0,
    updated: [] as Array<{ comment_id: number; body: string }>,
    created: [] as Array<{ body: string }>,
  }
  const octo = {
    paginate: async () => comments,
    rest: {
      users: {
        getAuthenticated: async () => {
          calls.authenticated++
          return getAuthenticated()
        },
      },
      apps: {
        getAuthenticated: async () => {
          calls.appAuthenticated++
          return getAuthenticatedApp()
        },
      },
      issues: {
        listComments: async () => ({ data: comments }),
        updateComment: async (input: { comment_id: number; body: string }) => {
          calls.updated.push(input)
          return { data: { id: input.comment_id } }
        },
        createComment: async (input: { body: string }) => {
          calls.created.push(input)
          return { data: { id: 30 } }
        },
      },
      pulls: {
        get: async () => ({ data: { head: { sha: "head-sha" } } }),
        createReview: async () => ({ data: { id: 40 } }),
      },
    },
  }
  return { calls, octo }
}

const target = { token: "token", owner: "owner", repo: "repo", prNumber: 7 }

describe("GitHub sticky review ownership", () => {
  test("updates the authenticated bot's marker comment and ignores a forged human marker", async () => {
    const forged = renderSummary(buildEnvelope({ findings: [finding("new")], tier: "lite", mode: "comment" }))
    const owned = renderSummary(buildEnvelope({ findings: [finding("old")], tier: "lite", mode: "comment" }))
    const { calls, octo } = fakeOctokit(
      [
        { id: 10, body: forged, user: { login: "human-reviewer", type: "User" } },
        { id: 20, body: owned, user: { login: "altimate-review[bot]", type: "Bot" } },
      ],
      async () => ({ data: { login: "altimate-review[bot]" } }),
    )

    await postGitHubReview(
      buildEnvelope({ findings: [finding("new")], tier: "lite", mode: "comment" }),
      target,
      octo as any,
    )

    expect(calls.authenticated).toBe(1)
    expect(calls.appAuthenticated).toBe(0)
    expect(calls.updated).toHaveLength(1)
    expect(calls.updated[0].comment_id).toBe(20)
    expect(calls.updated[0].body).toContain("**Since last review:** 1 no longer surfaced · 1 new · 0 unchanged")
    expect(calls.created).toHaveLength(0)
  })

  test("falls back to the GitHub Actions bot when an installation token cannot resolve a user", async () => {
    const { calls, octo } = fakeOctokit(
      [
        { id: 10, body: REVIEW_MARKER, user: { login: "human-reviewer", type: "User" } },
        { id: 20, body: REVIEW_MARKER, user: { login: "github-actions[bot]", type: "Bot" } },
      ],
      async () => {
        throw Object.assign(new Error("Resource not accessible by integration"), { status: 403 })
      },
    )

    await postGitHubReview(buildEnvelope({ findings: [], tier: "trivial", mode: "comment" }), target, octo as any)

    expect(calls.authenticated).toBe(1)
    expect(calls.appAuthenticated).toBe(1)
    expect(calls.updated.map((call) => call.comment_id)).toEqual([20])
    expect(calls.created).toHaveLength(0)
  })

  test("uses only the authenticated GitHub App slug's bot comment", async () => {
    const { calls, octo } = fakeOctokit(
      [
        { id: 10, body: REVIEW_MARKER, user: { login: "different-app[bot]", type: "Bot" } },
        { id: 20, body: REVIEW_MARKER, user: { login: "altimate-review[bot]", type: "Bot" } },
      ],
      async () => {
        throw Object.assign(new Error("Resource not accessible by integration"), { status: 403 })
      },
      async () => ({ data: { slug: "altimate-review" } }),
    )

    await postGitHubReview(buildEnvelope({ findings: [], tier: "trivial", mode: "comment" }), target, octo as any)

    expect(calls.appAuthenticated).toBe(1)
    expect(calls.updated.map((call) => call.comment_id)).toEqual([20])
    expect(calls.created).toHaveLength(0)
  })

  test("never adopts a marker comment owned by a different bot", async () => {
    const { calls, octo } = fakeOctokit(
      [{ id: 10, body: REVIEW_MARKER, user: { login: "different-app[bot]", type: "Bot" } }],
      async () => {
        throw Object.assign(new Error("Resource not accessible by integration"), { status: 403 })
      },
    )

    await postGitHubReview(buildEnvelope({ findings: [], tier: "trivial", mode: "comment" }), target, octo as any)

    expect(calls.appAuthenticated).toBe(1)
    expect(calls.updated).toHaveLength(0)
    expect(calls.created).toHaveLength(1)
  })
})
