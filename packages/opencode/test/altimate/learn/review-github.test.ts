// altimate_change - new file
import { describe, expect, test } from "bun:test"
import { checkReviewAccess, fetchReviews, resolveReviewRepo, type ReviewExecutor } from "../../../src/altimate/learn/review-github"

const repo = { host: "github.com", owner: "acme", name: "widgets" }
const since = Date.parse("2026-09-01T00:00:00Z")
const now = Date.parse("2026-10-02T00:00:00Z")
const end: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null }
const next = (cursor: string) => ({ hasNextPage: true, endCursor: cursor })
const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" })
const fail = { exitCode: 1, stdout: "", stderr: "failure" }
const comment = (id: string) => ({
  id, author: { __typename: "User", login: "reviewer" }, body: "Please check the boundary before calculating the offset.",
  authorAssociation: "COLLABORATOR",
  path: "src/parser.ts", createdAt: "2026-09-20T00:00:00Z", url: `https://github.com/acme/widgets/pull/2#${id}`,
})
const search = (numbers: number[], pageInfo = end, mergedAt = "2026-09-20T00:00:00Z") => ({
  search: { edges: numbers.map((number) => ({ cursor: `pr-${number}`, node: { number, mergedAt, author: { login: `author-${number}` } } })), pageInfo },
})
const threads = (nodes: object[] = [], pageInfo = end) => ({ repository: { pullRequest: { reviewThreads: { nodes, pageInfo } } } })
const reviews = (nodes: object[] = [], pageInfo = end) => ({ repository: { pullRequest: { reviews: { nodes, pageInfo } } } })
const thread = (id: string, comments: object[], pageInfo = end, resolved = true) => ({
  id, isResolved: resolved, comments: { nodes: comments, pageInfo },
})
function fake(pages: { op: string; data: object; remaining?: number; resetAt?: string; check?: (vars: Record<string, string>) => void }[]) {
  const calls: string[][] = []
  const exec: ReviewExecutor = async (args) => {
    calls.push(args)
    expect(args.slice(0, 4)).toEqual(["gh", "api", "graphql", "--hostname"])
    const vars = Object.fromEntries(args.filter((arg) => /^[\w]+=/.test(arg)).map((arg) => {
      const split = arg.indexOf("=")
      return [arg.slice(0, split), arg.slice(split + 1)]
    }))
    const page = pages.shift()
    expect(page).toBeDefined()
    expect(vars.query).toContain(`query ${page!.op}(`)
    page!.check?.(vars)
    return ok(JSON.stringify({ data: {
      ...page!.data, rateLimit: { remaining: page!.remaining ?? 5000, resetAt: page!.resetAt ?? "2026-10-02T01:00:00Z", cost: 1 },
    } }))
  }
  return { exec, calls, pages }
}

describe("GitHub review repository and access", () => {
  test.each([
    ["git@github.com:acme/widgets.git", "github.com"],
    ["https://github.com/acme/widgets.git", "github.com"],
    ["ssh://git@github.example.com/acme/widgets.git", "github.example.com"],
    ["git@ghe.internal:acme/widgets.git", "ghe.internal"],
    ["https://enterprise.example/acme/widgets", "enterprise.example"],
  ])("detects %s", async (url, host) => {
    const exec: ReviewExecutor = async (args, options) => {
      expect(args).toEqual(["git", "remote", "-v"])
      expect(options?.cwd).toBe("/workspace")
      return ok(`origin\t${url} (fetch)\norigin\t${url} (push)\n`)
    }
    expect(await resolveReviewRepo("/workspace", undefined, exec)).toEqual({ ...repo, host })
  })

  test("prefers origin and preserves the Enterprise host for an explicit repository", async () => {
    const exec: ReviewExecutor = async () => ok("upstream\tgit@github.com:up/stream.git (fetch)\norigin\tgit@ghe.internal:acme/widgets.git (fetch)")
    expect(await resolveReviewRepo("/workspace", "different/repository", exec)).toEqual({ host: "ghe.internal", owner: "different", name: "repository" })
  })

  test.each(["https://gitlab.com/acme/widgets.git", "git@bitbucket.org:acme/widgets.git", "https://codeberg.org/acme/widgets"]) (
    "rejects non-GitHub remote %s with an actionable error", async (url) => {
      await expect(resolveReviewRepo("/workspace", undefined, async () => ok(`origin\t${url} (fetch)`))).rejects.toThrow("supports GitHub only")
    },
  )

  test("missing/local remote requires --repo; explicit --repo works without a remote", async () => {
    await expect(resolveReviewRepo("/workspace", undefined, async () => fail)).rejects.toThrow("use --repo owner/name")
    await expect(resolveReviewRepo("/workspace", undefined, async () => ok("origin\t/tmp/project (fetch)"))).rejects.toThrow("Cannot detect")
    expect(await resolveReviewRepo("/workspace", "acme/widgets", async () => fail)).toEqual(repo)
    await expect(resolveReviewRepo("/workspace", "https://github.com/acme/widgets", async () => fail)).rejects.toThrow("--repo owner/name")
  })

  test("checks installed CLI, host-specific authentication, and repo read access in order", async () => {
    const calls: string[][] = []
    await checkReviewAccess({ ...repo, host: "ghe.internal" }, async (args) => {
      calls.push(args)
      return args[1] === "--version" ? ok("gh version 2.80.0") : ok("{}")
    })
    expect(calls).toEqual([
      ["gh", "--version"], ["gh", "auth", "status", "--hostname", "ghe.internal"],
      ["gh", "api", "--hostname", "ghe.internal", "repos/acme/widgets"],
    ])
  })

  test("installation, authentication, and access failures explain the fix without echoing output", async () => {
    await expect(checkReviewAccess(repo, async () => { throw new Error("ENOENT") })).rejects.toThrow("Install it")
    await expect(checkReviewAccess(repo, async () => ok("not gh"))).rejects.toThrow("not installed")
    await expect(checkReviewAccess(repo, async (args) => args[1] === "--version" ? ok("gh version 2") : fail)).rejects.toThrow("gh auth login --hostname github.com")
    await expect(checkReviewAccess(repo, async (args) => args[1] === "--version" ? ok("gh version 2") : args[1] === "auth" ? ok() : fail)).rejects.toThrow("account's read access")
  })
})

describe("GitHub review fetching", () => {
  test("compacts completed revisions even while waiting for a rate reset", async () => {
    const completed = Object.fromEntries(Array.from({ length: 1100 }, (_, i) => [i + 1, new Date(since + i * 1000).toISOString()]))
    const result = await fetchReviews({ repo, since, limit: 1,
      cursor: { since, completed, resetAt: new Date(now + 60_000).toISOString() },
    }, { now: () => now, exec: async () => { throw new Error("must not fetch before reset") } })
    expect(result.paused).toBe(true)
    expect(Object.keys(result.cursor.completed!)).toHaveLength(1000)
    expect(result.cursor.completed![100]).toBeUndefined()
    expect(result.cursor.completed![1100]).toBe(completed[1100])
    expect(Object.keys(completed)).toHaveLength(1100)
  })

  test("bounded reruns reach older PRs while revisiting newly updated completed PRs", async () => {
    const numbers = Array.from({ length: 51 }, (_, index) => 51 - index)
    let updated = false
    const exec: ReviewExecutor = async (args) => {
      const vars = Object.fromEntries(args.filter((arg) => /^[\w]+=/.test(arg)).map((arg) => {
        const split = arg.indexOf("=")
        return [arg.slice(0, split), arg.slice(split + 1)]
      }))
      if (!vars.query.includes("LearnReviewPRs")) return ok(JSON.stringify({ data:
        vars.query.includes("LearnReviewThreads") ? threads() : reviews(),
      }))
      const offset = vars.after ? numbers.indexOf(Number(vars.after.slice(3))) + 1 : 0
      const page = numbers.slice(offset, offset + Number(vars.first))
      const data = search(page, offset + page.length < numbers.length ? next(`pr-${page.at(-1)}`) : end)
      for (const edge of data.search.edges) Object.assign(edge.node, {
        updatedAt: updated && edge.node.number === 51 ? "2026-10-02T00:00:00Z" : "2026-10-01T00:00:00Z",
      })
      return ok(JSON.stringify({ data }))
    }
    const first = await fetchReviews({ repo, since, limit: 50 }, { exec })
    expect(first.prs).toHaveLength(50)
    expect(first.complete).toBe(false)
    updated = true
    const second = await fetchReviews({ repo, since, limit: 50, cursor: first.cursor }, { exec })
    expect(second.prs.map((pr) => pr.number)).toEqual([51, 1])
    expect(second.complete).toBe(true)
  })

  test("paginates PRs, threads, comments within threads, and review bodies", async () => {
    const gh = fake([
      { op: "LearnReviewPRs", data: search([2], next("pr-2")), check: (vars) => {
        expect(vars.first).toBe("2")
        expect(vars.query).toContain("author { login }")
      } },
      { op: "LearnReviewThreads", data: threads([thread("t1", [comment("c1")], next("c1"))], next("t1")),
        check: (vars) => expect(vars.query).toContain("authorAssociation") },
      { op: "LearnReviewComments", data: { node: thread("t1", [comment("c2")]) }, check: (vars) => {
        expect(vars.after).toBe("c1")
        expect(vars.query).toContain("authorAssociation")
      } },
      { op: "LearnReviewThreads", data: threads([thread("t2", [comment("c3")], end, false)]), check: (vars) => expect(vars.after).toBe("t1") },
      { op: "LearnReviewBodies", data: reviews([{ ...comment("r1"), state: "CHANGES_REQUESTED" }], next("r1")),
        check: (vars) => expect(vars.query).toContain("authorAssociation") },
      { op: "LearnReviewBodies", data: reviews([{ ...comment("r2"), state: "APPROVED" }]), check: (vars) => expect(vars.after).toBe("r1") },
      { op: "LearnReviewPRs", data: search([1]), check: (vars) => expect(vars.after).toBe("pr-2") },
      { op: "LearnReviewThreads", data: threads([thread("t3", [comment("c4")])]) },
      { op: "LearnReviewBodies", data: reviews() },
    ])
    const result = await fetchReviews({ repo, since, limit: 2 }, { exec: gh.exec })
    expect(result.comments.map((item) => [item.id, item.type, item.resolved, item.state])).toEqual([
      ["c1", "comment", true, undefined], ["c2", "comment", true, undefined], ["c3", "comment", false, undefined],
      ["r1", "review", undefined, "CHANGES_REQUESTED"], ["r2", "review", undefined, "APPROVED"],
      ["c4", "comment", true, undefined],
    ])
    expect(result.comments.map((item) => item.prAuthor)).toEqual([
      "author-2", "author-2", "author-2", "author-2", "author-2", "author-1",
    ])
    expect(result.comments.every((item) => item.authorAssociation === "COLLABORATOR")).toBe(true)
    expect(result.comments[0]).toMatchObject({ prNumber: 2, mergedAt: "2026-09-20T00:00:00Z", path: "src/parser.ts" })
    expect(result.prs.map((item) => item.number)).toEqual([2, 1])
    expect(result.prsScanned).toBe(2)
    expect(result.cursor).toEqual({ since, after: "pr-1", number: 1, scanned: 2 })
    expect(result.complete).toBe(true)
    expect(gh.pages).toHaveLength(0)
  })

  test("bounds the requested PR count and excludes merges before --since", async () => {
    const gh = fake([
      { op: "LearnReviewPRs", data: search([9], next("pr-9"), "2026-08-01T00:00:00Z") },
      { op: "LearnReviewPRs", data: search([2, 1], next("pr-1")), check: (vars) => expect(vars.after).toBe("pr-9") },
      { op: "LearnReviewThreads", data: threads() },
      { op: "LearnReviewBodies", data: reviews() },
    ])
    const result = await fetchReviews({ repo, since, limit: 1 }, { exec: gh.exec })
    expect(result.prsScanned).toBe(1)
    expect(result.cursor.number).toBe(2)
    expect(result.complete).toBe(false)
    expect(gh.pages).toHaveLength(0)
    expect(gh.calls[0]).toContain(`search=repo:acme/widgets is:pr is:merged merged:>=2026-09-01T00:00:00.000Z sort:updated-desc`)
  })

  test("low rate limit restarts changed search ordering and replays the incomplete PR after reset", async () => {
    const resetAt = new Date(now + 60_000).toISOString()
    const gh = fake([
      { op: "LearnReviewPRs", data: search([2, 1]) },
      { op: "LearnReviewThreads", data: threads() },
      { op: "LearnReviewBodies", data: reviews() },
      { op: "LearnReviewThreads", data: threads([thread("t1", [comment("c1")], next("c1"))]), remaining: 5, resetAt },
    ])
    const sleeps: number[] = []
    const result = await fetchReviews({ repo, since, limit: 2 }, { exec: gh.exec, now: () => now, sleep: async (ms) => { sleeps.push(ms) } })
    expect(result.paused).toBe(true)
    expect(result.resetAt).toBe(resetAt)
    expect(result.comments.map((item) => item.id)).toEqual(["c1"])
    expect(result.cursor).toEqual({ since, after: "pr-2", number: 2, scanned: 1, resetAt })
    expect(sleeps).toEqual([1000])
    const premature = await fetchReviews({ repo, since, limit: 2, cursor: result.cursor }, {
      exec: async () => { throw new Error("must not call API before reset") }, now: () => now,
    })
    expect(premature.paused).toBe(true)
    expect(premature.prsScanned).toBe(0)
    const resumed = fake([
      { op: "LearnReviewPRs", data: search([1, 2]), check: (vars) => expect(vars.after).toBeUndefined() },
      { op: "LearnReviewThreads", data: threads([thread("t1", [comment("c1"), comment("c2")])]) },
      { op: "LearnReviewBodies", data: reviews() },
      { op: "LearnReviewThreads", data: threads([thread("t2", [comment("newly-discovered")])]) },
      { op: "LearnReviewBodies", data: reviews() },
    ])
    const rest = await fetchReviews({ repo, since: now, limit: 2, cursor: result.cursor }, { exec: resumed.exec, now: () => now + 60_001 })
    expect(rest.comments.map((item) => item.id)).toEqual(["c1", "c2", "newly-discovered"])
    expect(rest.cursor).toEqual({ since, after: "pr-2", number: 2, scanned: 2 })
  })

  test("stops on GraphQL rate-limit errors without reusing the old search checkpoint", async () => {
    const sleeps: number[] = []
    const result = await fetchReviews({ repo, since, limit: 10, cursor: { since, after: "pr-3", number: 3 } }, {
      exec: async () => ({ exitCode: 1, stdout: JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "rate limit exceeded" }] }), stderr: "" }),
      now: () => now, sleep: async (ms) => { sleeps.push(ms) },
    })
    expect(result.cursor.after).toBeUndefined()
    expect(result.cursor.scanned).toBe(0)
    expect(result.paused).toBe(true)
    expect(result.prsScanned).toBe(0)
    expect(result.resetAt).toBe(new Date(now + 60_000).toISOString())
    expect(sleeps).toEqual([1000])
  })

  test("rejects invalid limits and malformed GraphQL responses clearly", async () => {
    for (const limit of [0, -1, 1.5, 1001]) await expect(fetchReviews({ repo, since, limit })).rejects.toThrow("--limit")
    await expect(fetchReviews({ repo, since, limit: 1 }, { exec: async () => ok("invalid") })).rejects.toThrow("GitHub could not fetch")
  })

  test("allows bounded imports above 1,000 matches and reports truncation only at the search ceiling", async () => {
    const firstSearch = search([2000], next("pr-2000"))
    const first = fake([
      { op: "LearnReviewPRs", data: { search: { ...firstSearch.search, issueCount: 2000 } } },
      { op: "LearnReviewThreads", data: threads() },
      { op: "LearnReviewBodies", data: reviews() },
    ])
    const bounded = await fetchReviews({ repo, since, limit: 1 }, { exec: first.exec })
    expect(bounded.truncated).toBeUndefined()
    expect(bounded.complete).toBe(false)
    const last = fake(Array.from({ length: 20 }, (_, page) => {
      const numbers = Array.from({ length: 50 }, (_, index) => 2000 - page * 50 - index)
      const data = search(numbers, next(`pr-${numbers.at(-1)}`))
      return [
        { op: "LearnReviewPRs", data: { search: { ...data.search, issueCount: 2000 } } },
        ...numbers.flatMap((number) => [
          { op: "LearnReviewThreads", data: threads(number === 1001 ? [thread("t1", [comment("last")])] : []) },
          { op: "LearnReviewBodies", data: reviews() },
        ]),
      ]
    }).flat())
    const ceiling = await fetchReviews({ repo, since, limit: 1000 }, { exec: last.exec })
    expect(ceiling.truncated).toBe(true)
    expect(ceiling.complete).toBe(false)
    expect(ceiling.comments.map((item) => item.id)).toEqual(["last"])
    expect(ceiling.cursor).toMatchObject({ scanned: 1000, truncated: true, number: 1001 })
    await expect(fetchReviews({ repo, since, limit: 50, cursor: ceiling.cursor }, {
      exec: async () => { throw new Error("must not make another request") },
    })).rejects.toThrow("narrower --since")
  })

  test("a restarted bounded search resets the persisted count toward the search ceiling", async () => {
    const data = search([2000], next("pr-2000"))
    const gh = fake([
      { op: "LearnReviewPRs", data: { search: { ...data.search, issueCount: 2000 } },
        check: (vars) => expect(vars.after).toBeUndefined() },
      { op: "LearnReviewThreads", data: threads() },
      { op: "LearnReviewBodies", data: reviews() },
    ])
    const result = await fetchReviews({ repo, since, limit: 1,
      cursor: { since, after: "pr-1002", number: 1002, scanned: 999 } }, { exec: gh.exec })
    expect(result.cursor.scanned).toBe(1)
    expect(result.truncated).toBeUndefined()
    expect(result.complete).toBe(false)
  })
})
