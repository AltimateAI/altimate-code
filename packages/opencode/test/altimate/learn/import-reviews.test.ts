// altimate_change - new file
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { importReviews, type ImportReviewsDeps, type ImportReviewsOptions } from "../../../src/altimate/learn/import-reviews"
import type { Generate } from "../../../src/altimate/learn/reflect"
import { FEEDBACK_CAP } from "../../../src/altimate/learn/reflect"
import { claimsDirectory, createClaimManager } from "../../../src/altimate/learn/claims"
import { DEFAULT_NAME } from "../../../src/altimate/learn/playbook"
import { readReviewState } from "../../../src/altimate/learn/review-state"
import * as Signals from "../../../src/altimate/learn/signals"
import * as Store from "../../../src/altimate/learn/store"

const NOW = Date.parse("2026-10-02T12:00:00Z")
let root: string
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "learn-import-reviews-")) })
afterEach(() => fs.rm(root, { recursive: true, force: true }))

interface Comment {
  id: string
  body: string
  author: { __typename: string; login: string } | null
  path?: string
  createdAt: string
  url: string
}

const comment = (id: string, input: Partial<Comment> = {}): Comment => ({
  id,
  body: `Please list explicit columns in the query for ${id}.`,
  author: { __typename: "User", login: "reviewer" },
  path: "src/query.ts",
  createdAt: "2026-10-01T10:00:00Z",
  url: `https://github.com/acme/project/pull/42#discussion_${id}`,
  ...input,
})

interface Thread {
  id: string
  isResolved: boolean
  comments: Comment[]
}

interface Review extends Comment { state: string }

// Inject only the process/model boundaries. Filtering, consent, state, claims and curation stay real.
function harness(input: { threads?: Thread[]; reviews?: Review[]; generate?: Generate } = {}) {
  const output: string[] = []
  const prompts: string[] = []
  const calls: string[][] = []
  let factories = 0
  let confirms = 0
  const pageInfo = { hasNextPage: false, endCursor: null }
  const connection = <T>(nodes: T[]) => ({ nodes, pageInfo })
  const deps: ImportReviewsDeps = {
    isTTY: true, now: () => NOW, out: (text) => output.push(text),
    confirm: async () => { confirms++; return true },
    exec: async (args) => {
      calls.push(args)
      const result = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" })
      if (args[0] === "git") return result("origin\tgit@github.com:acme/project.git (fetch)\n")
      if (args.includes("--version")) return result("gh version 2.80.0\n")
      if (args.includes("auth")) return result()
      if (!args.includes("graphql")) return result(JSON.stringify({ full_name: "acme/project" }))
      const query = args.find((arg) => arg.startsWith("query=query "))
      const rateLimit = { remaining: 4999, resetAt: "2026-10-02T13:00:00Z", cost: 1 }
      const graph = (data: object) => result(JSON.stringify({ data: { ...data, rateLimit } }))
      if (query?.includes("LearnReviewPRs")) return graph({ search: {
        edges: [{ cursor: "pr42", node: { number: 42, mergedAt: "2026-10-01T12:00:00Z" } }], pageInfo,
      } })
      if (query?.includes("LearnReviewThreads")) return graph({ repository: { pullRequest: {
        reviewThreads: connection((input.threads ?? [{ id: "thread", isResolved: true, comments: [comment("one")] }])
          .map((thread) => ({ ...thread, comments: connection(thread.comments) }))),
      } } })
      if (query?.includes("LearnReviewBodies")) return graph({ repository: { pullRequest: {
        reviews: connection(input.reviews ?? []),
      } } })
      throw new Error(`Unexpected fake gh request: ${args.join(" ")}`)
    },
    resolveModel: async () => ({
      providerID: "test", modelID: "small", cost: { input: 2, output: 4 },
      generate: async (_abort, usage) => {
        factories++
        return async (request) => {
          prompts.push(request.prompt)
          usage({ inputTokens: 100, outputTokens: 25 })
          return input.generate ? input.generate(request) : { deltas: [] }
        }
      },
    }),
  }
  const run = (options: Partial<ImportReviewsOptions> = {}) => importReviews({ root, ...options }, deps)
  return { run, deps, output, prompts, calls, factories: () => factories, confirms: () => confirms }
}

describe("review import consent", () => {
  test("dry run fetches and prints redacted comments and scope without writes or model calls", async () => {
    const h = harness({ threads: [{ id: "thread", isResolved: true, comments: [comment("secret", {
      body: "Please configure password=hunter2 before running this query.",
    })] }] })
    await h.run({ dryRun: true })
    const output = h.output.join("\n")
    expect(h.calls.some((call) => call.includes("graphql"))).toBe(true)
    expect(output).toContain("acme/project")
    expect(output).toContain("test/small")
    expect(output).toMatch(/Estimated input tokens: [1-9]\d*/)
    expect(output).toContain("[REDACTED]")
    expect(output).not.toContain("hunter2")
    expect(output).toContain("src/query.ts")
    expect(h.factories()).toBe(0)
    expect(h.confirms()).toBe(0)
    expect(await fs.readdir(root)).toEqual([])
  })

  test("non-TTY displays scope but requires --yes before writing or sending", async () => {
    const h = harness()
    h.deps.isTTY = false
    await expect(h.run()).rejects.toThrow("pass --yes or --dry-run")
    expect(h.output.join("\n")).toContain("acme/project")
    expect(h.output.join("\n")).toContain("Estimated input tokens")
    expect(h.factories()).toBe(0)
    expect(h.confirms()).toBe(0)
    expect(await fs.readdir(root)).toEqual([])
    expect(await h.run({ yes: true })).toMatchObject({ signalsAdded: 1, reflectionsRun: 1 })
    expect(h.factories()).toBe(1)
  })

  test("TTY confirmation sees scope before model setup and cancellation changes nothing", async () => {
    const h = harness()
    h.deps.confirm = async () => {
      const output = h.output.join("\n")
      expect(output).toContain("acme/project")
      expect(output).toContain("test/small")
      expect(output).toContain("Estimated input tokens")
      expect(h.factories()).toBe(0)
      return false
    }
    await h.run()
    expect(h.output.at(-1)).toContain("Cancelled")
    expect(h.factories()).toBe(0)
    expect(await fs.readdir(root)).toEqual([])
  })
})

describe("review import filtering and provenance", () => {
  const defaultBots = ["coderabbitai", "kilo-code-bot", "cubic-dev-ai", "cursor", "dependabot", "renovate",
    "github-actions", "chatgpt-codex-connector", "claude"]
  const botAuthors = [
    { __typename: "Bot", login: "robot-app" },
    { __typename: "User", login: "new-app[bot]" },
    ...defaultBots.map((login) => ({ __typename: "User", login })),
    { __typename: "User", login: "extra-agent" },
    { __typename: "User", login: "configured-agent" },
  ]

  test("filters bot type, suffix, every default login, CLI bots and configured bots", async () => {
    const h = harness({ threads: [{ id: "thread", isResolved: true, comments: [
      ...botAuthors.map((author, index) => comment(`bot${index}`, { author })),
      comment("human", { author: { __typename: "User", login: "actual-human" } }),
    ] }] })
    const summary = await h.run({ yes: true, maxReflections: 0, bots: ["extra-agent"], reviewBots: ["configured-agent"] })
    expect(summary).toMatchObject({ prsScanned: 1, commentsFetched: botAuthors.length + 1,
      commentsKept: 1, signalsAdded: 1, commentsDropped: { bot: botAuthors.length } })
    const signals = await Signals.readSignals(root)
    expect(signals).toHaveLength(1)
    expect(signals[0].messageID).toContain("human")
  })

  test("--include-bots disables all bot exclusions", async () => {
    const h = harness({ threads: [{ id: "thread", isResolved: true,
      comments: botAuthors.map((author, index) => comment(`bot${index}`, { author })) }] })
    expect(await h.run({ yes: true, maxReflections: 0, includeBots: true,
      bots: ["extra-agent"], reviewBots: ["configured-agent"] })).toMatchObject({
      commentsKept: botAuthors.length, signalsAdded: botAuthors.length, commentsDropped: { bot: 0 },
    })
    expect(await Signals.readSignals(root)).toHaveLength(botAuthors.length)
  })

  test("prefers resolved threads, retains substantive unresolved feedback and final review bodies", async () => {
    const h = harness({ threads: [
      { id: "unresolved", isResolved: false, comments: [comment("unresolved")] },
      { id: "resolved", isResolved: true, comments: [comment("resolved")] },
    ], reviews: [
      { ...comment("approved", { path: undefined }), state: "APPROVED" },
      { ...comment("changes", { path: undefined }), state: "CHANGES_REQUESTED" },
      { ...comment("commented", { path: undefined }), state: "COMMENTED" },
      { ...comment("pending", { path: undefined }), state: "PENDING" },
      { ...comment("dismissed", { path: undefined }), state: "DISMISSED" },
    ] })
    expect(await h.run({ yes: true, maxReflections: 0 })).toMatchObject({ commentsFetched: 7,
      commentsKept: 4, signalsAdded: 4, commentsDropped: { state: 3 } })
    const signals = await Signals.readSignals(root)
    expect(signals[0]).toMatchObject({ resolved: true })
    expect(signals.find((signal) => signal.messageID?.endsWith("/unresolved"))).toMatchObject({ resolved: false })
    expect(signals.every((signal) => signal.kind === "review" && signal.source === "import-reviews")).toBe(true)
    expect(signals.map((signal) => signal.messageID)).toEqual(expect.arrayContaining([
      "github.com/acme/project/comment/resolved", "github.com/acme/project/comment/unresolved",
      "github.com/acme/project/review/approved", "github.com/acme/project/review/changes",
    ]))
    expect(h.prompts).toEqual([])
  })

  test("skips empty, LGTM-only, emoji-only and very short text with separate counts", async () => {
    const bodies = ["", " \n\t", "LGTM", "LGTM! 👍", "Looks good to me!", "👍 ✅ 🚀", ":+1: :rocket:", "Rename this.",
      "LGTM overall, but please list query result columns explicitly."]
    const h = harness({ threads: [{ id: "thread", isResolved: true,
      comments: bodies.map((body, index) => comment(String(index), { body })) }] })
    expect(await h.run({ yes: true, maxReflections: 0 })).toMatchObject({ commentsFetched: 9, commentsKept: 1,
      commentsDropped: { empty: 2, lgtm: 3, emoji: 2, short: 1 }, signalsAdded: 1 })
    expect((await Signals.readSignals(root))[0].text).toContain("LGTM overall, but")
  })

  test("redacts before storage and model input while preserving file and comment URL provenance", async () => {
    const secret = comment("secret", { body: "Please replace password=hunter2 in the connection setup.", path: "src/connection.ts" })
    const h = harness({ threads: [{ id: "thread", isResolved: true, comments: [secret] }] })
    await h.run({ yes: true })
    const [signal] = await Signals.readSignals(root)
    expect(signal).toMatchObject({ kind: "review", source: "import-reviews", resolved: true,
      messageID: "github.com/acme/project/comment/secret", provenance: secret.url, status: "consumed" })
    expect(signal.text).toContain("src/connection.ts")
    expect(signal.text).toContain("[REDACTED]")
    expect(JSON.stringify(signal)).not.toContain("hunter2")
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]).toContain("[REDACTED]")
    expect(h.prompts[0]).not.toContain("hunter2")
  })

  test("provenance strips URL credentials and query strings in preview and persisted signals", async () => {
    const h = harness({ threads: [{ id: "thread", isResolved: true, comments: [comment("url", {
      url: "https://alice:hunter2@github.com/acme/project/pull/42?token=fixture-secret#discussion_42",
    })] }] })
    await h.run({ dryRun: true })
    expect(h.output.join("\n")).toContain("https://github.com/acme/project/pull/42#discussion_42")
    expect(h.output.join("\n")).not.toContain("hunter2")
    expect(h.output.join("\n")).not.toContain("fixture-secret")
    await h.run({ yes: true, maxReflections: 0 })
    expect((await Signals.readSignals(root))[0].provenance).toBe("https://github.com/acme/project/pull/42#discussion_42")
  })
})

describe("review import reflection and continuation", () => {
  test("consumed comments remain deduplicated on later imports", async () => {
    const h = harness()
    expect(await h.run({ yes: true })).toMatchObject({ signalsAdded: 1, reflectionsRun: 1 })
    expect(await h.run({ yes: true })).toMatchObject({ signalsAdded: 0, reflectionsRun: 0,
      commentsKept: 0, commentsDropped: { duplicate: 1 } })
    expect(h.prompts).toHaveLength(1)
    expect(await Signals.readSignals(root)).toHaveLength(1)
  })

  test("dedupe IDs distinguish the same object ID across type, repository and host", async () => {
    const h = harness({ reviews: [{ ...comment("one", { path: undefined }), state: "APPROVED" }] })
    expect(await h.run({ yes: true, maxReflections: 0 })).toMatchObject({ signalsAdded: 2 })
    expect(await h.run({ yes: true, maxReflections: 0, repo: "acme/another" })).toMatchObject({ signalsAdded: 2 })
    const exec = h.deps.exec!
    h.deps.exec = (args, options) => args[0] === "git"
      ? Promise.resolve({ exitCode: 0, stdout: "origin\tgit@github.corp.example:acme/project.git (fetch)\n", stderr: "" })
      : exec(args, options)
    expect(await h.run({ yes: true, maxReflections: 0 })).toMatchObject({ signalsAdded: 2 })
    expect((await Signals.readSignals(root)).map((signal) => signal.messageID)).toEqual([
      "github.com/acme/project/comment/one", "github.com/acme/project/review/one",
      "github.com/acme/another/comment/one", "github.com/acme/another/review/one",
      "github.corp.example/acme/project/comment/one", "github.corp.example/acme/project/review/one",
    ])
  })

  test("batches within feedback budget, respects --max-reflections and resumes open work", async () => {
    const h = harness({ threads: [{ id: "thread", isResolved: true, comments: Array.from({ length: 7 }, (_, index) =>
      comment(`large${index}`, { body: `Please use explicit columns ${index}. ${"x".repeat(1950)}` })) }] })
    expect(await h.run({ yes: true, maxReflections: 1 })).toMatchObject({ signalsAdded: 7, reflectionsRun: 1 })
    expect((await Signals.listSignals(root)).length).toBeGreaterThan(0)
    expect(await h.run({ yes: true, maxReflections: 1 })).toMatchObject({ signalsAdded: 0, reflectionsRun: 1 })
    expect(await Signals.listSignals(root)).toEqual([])
    for (const prompt of h.prompts) {
      const feedback = prompt.split('<feedback kind="review" untrusted="true">\n')[1].split("\n</feedback>")[0]
      expect(feedback.length).toBeLessThanOrEqual(FEEDBACK_CAP)
    }
    expect(await Signals.readSignals(root)).toHaveLength(7)
  })

  test("claim contention prevents duplicate model calls and a later import retries", async () => {
    const h = harness()
    await h.run({ yes: true, maxReflections: 0 })
    const signals = await Signals.listSignals(root)
    const other = createClaimManager({ pid: 123, host: "other-process", isAlive: () => true })
    const claim = await other.acquire(root, DEFAULT_NAME, signals.map((signal) => signal.id))
    expect(claim).toBeDefined()
    try {
      expect(await h.run({ yes: true })).toMatchObject({ reflectionsRun: 0 })
      expect(h.factories()).toBe(0)
      expect(await Signals.listSignals(root)).toHaveLength(1)
    } finally { await claim!.release() }
    expect(await h.run({ yes: true })).toMatchObject({ reflectionsRun: 1 })
    expect(await Signals.listSignals(root)).toEqual([])
    expect(await fs.readdir(claimsDirectory(root))).toEqual([])
  })

  test("counts candidates and measured tokens/cost without promoting lessons", async () => {
    let count = 0
    const h = harness({ threads: [{ id: "thread", isResolved: true, comments: Array.from({ length: 7 }, (_, index) =>
      comment(`large${index}`, { body: `Please use explicit columns ${index}. ${"x".repeat(1950)}` })) }],
      generate: async () => {
        expect((await fs.readdir(claimsDirectory(root))).length).toBe(1)
        if (count++ === 0) return { deltas: [{ op: "ADD", text: "List query result columns explicitly.", reason: "review" }] }
        const [lesson] = (await Store.loadCandidateLessons(root, DEFAULT_NAME))!
        return { deltas: [{ op: "EDIT", id: lesson.id,
          text: "List query result columns explicitly and qualify joined column names.", reason: "review" }] }
      },
    })
    expect(await h.run({ yes: true })).toMatchObject({ prsScanned: 1, commentsFetched: 7, commentsKept: 7,
      signalsAdded: 7, reflectionsRun: 2, candidatesAdded: 1, candidatesEdited: 1,
      inputTokens: 200, outputTokens: 50, tokensEstimated: false, estimatedCost: 0.0006 })
    expect(await Store.loadApproved(root, DEFAULT_NAME)).toEqual([])
    expect((await Store.loadCandidateLessons(root, DEFAULT_NAME))![0].text).toContain("qualify joined column names")
    const output = h.output.join("\n")
    expect(output).toContain("candidate lessons: 1 added, 1 edited")
    expect(output).toContain("200 input, 50 output")
    expect(output).toContain("$0.000600")
    expect(output).toContain("`learn show`")
    expect(output).toContain("`learn promote`")
  })

  test("provider failure leaves comments open and redacts the error", async () => {
    const h = harness({ generate: async () => { throw new Error("unavailable password=hunter2") } })
    expect(await h.run({ yes: true })).toMatchObject({ signalsAdded: 1, reflectionsRun: 1, failures: 1 })
    expect((await Signals.listSignals(root)).map((signal) => signal.status)).toEqual(["open"])
    expect(await fs.readdir(claimsDirectory(root))).toEqual([])
    const output = h.output.join("\n")
    expect(output).not.toContain("hunter2")
    expect(output).toContain("[REDACTED]")
    expect(output).toContain("learn import-reviews")
  })

  test("persists the completed PR cursor on low rate and resumes a partial PR without losing comments", async () => {
    const h = harness()
    const exec = h.deps.exec!
    let pause = true
    let now = NOW
    const sleeps: number[] = []
    h.deps.now = () => now
    h.deps.sleep = async (ms) => { sleeps.push(ms) }
    h.deps.exec = async (args, options) => {
      const response = await exec(args, options)
      if (!args.includes("graphql")) return response
      const parsed = JSON.parse(response.stdout)
      const query = args.find((arg) => arg.startsWith("query=query "))!
      if (query.includes("LearnReviewPRs")) parsed.data.search.edges = [
        ...args.includes("after=pr43") ? [] : [{ cursor: "pr43", node: { number: 43, mergedAt: "2026-10-02T10:00:00Z" } }],
        { cursor: "pr42", node: { number: 42, mergedAt: "2026-10-01T12:00:00Z" } },
      ]
      if (query.includes("LearnReviewThreads")) {
        parsed.data.repository.pullRequest.reviewThreads.nodes[0].comments.nodes = [comment(args.includes("number=43") ? "first" : "partial")]
        if (pause && args.includes("number=42")) {
          pause = false
          parsed.data.rateLimit = { remaining: 1, cost: 1, resetAt: new Date(NOW + 1000).toISOString() }
        }
      }
      if (query.includes("LearnReviewBodies") && args.includes("number=42")) {
        parsed.data.repository.pullRequest.reviews.nodes = [{ ...comment("last-body", { path: undefined }), state: "APPROVED" }]
      }
      return { ...response, stdout: JSON.stringify(parsed) }
    }
    expect(await h.run({ yes: true })).toMatchObject({ paused: true, prsScanned: 2, signalsAdded: 2, reflectionsRun: 2 })
    const checkpoint = (await readReviewState(root)).repositories["github.com/acme/project"]
    expect(checkpoint.cursor).toMatchObject({ after: "pr43", number: 43, resetAt: new Date(NOW + 1000).toISOString() })
    expect(checkpoint.seenIDs).toHaveLength(2)
    expect(sleeps).toEqual([1000])
    now += 2000
    expect(await h.run({ yes: true })).toMatchObject({ paused: false, prsScanned: 1, signalsAdded: 1,
      reflectionsRun: 1, commentsDropped: { duplicate: 1 } })
    expect(h.calls.some((args) => args.includes("after=pr43"))).toBe(true)
    expect((await Signals.readSignals(root)).map((signal) => signal.messageID)).toEqual([
      "github.com/acme/project/comment/first", "github.com/acme/project/comment/partial", "github.com/acme/project/review/last-body",
    ])
    const resumed = (await readReviewState(root)).repositories["github.com/acme/project"]
    expect(resumed.cursor).toBeUndefined()
    expect(resumed.pending).toEqual([])
  })

  test("a narrower bot scope excludes old pending bot feedback and can resume it when opted in again", async () => {
    const bot = comment("bot", { author: { __typename: "Bot", login: "review-app" } })
    const h = harness({ threads: [{ id: "thread", isResolved: true, comments: [bot, comment("human")] }] })
    expect(await h.run({ yes: true, includeBots: true, maxReflections: 0 })).toMatchObject({ signalsAdded: 2 })
    expect(await h.run({ yes: true })).toMatchObject({ signalsAdded: 0, reflectionsRun: 1,
      commentsDropped: { bot: 1, duplicate: 1 } })
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]).toContain("query for human")
    expect(h.prompts[0]).not.toContain("query for bot")
    expect((await Signals.listSignals(root)).map((signal) => signal.messageID)).toEqual(["github.com/acme/project/comment/bot"])
    expect(await h.run({ yes: true, includeBots: true })).toMatchObject({ signalsAdded: 0, reflectionsRun: 1 })
    expect(await Signals.listSignals(root)).toEqual([])
    expect(h.prompts[1]).toContain("query for bot")
  })

  test("a narrowed scope persists its allowed comments across a later pending-only resume", async () => {
    const bot = comment("bot", { author: { __typename: "Bot", login: "review-app" } })
    const h = harness({ threads: [{ id: "thread", isResolved: true, comments: [bot, comment("human")] }] })
    expect(await h.run({ yes: true, includeBots: true, maxReflections: 0 })).toMatchObject({ signalsAdded: 2 })
    expect(await h.run({ yes: true, maxReflections: 0 })).toMatchObject({ signalsAdded: 0, reflectionsRun: 0,
      commentsDropped: { bot: 1, duplicate: 1 } })
    expect(h.prompts).toEqual([])
    const calls = h.calls.length
    expect(await h.run({ yes: true })).toMatchObject({ signalsAdded: 0, reflectionsRun: 1 })
    expect(h.calls.slice(calls).some((args) => args.includes("graphql"))).toBe(false)
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]).toContain("query for human")
    expect(h.prompts[0]).not.toContain("query for bot")
    expect((await Signals.listSignals(root)).map((signal) => signal.messageID)).toEqual(["github.com/acme/project/comment/bot"])
  })
})
