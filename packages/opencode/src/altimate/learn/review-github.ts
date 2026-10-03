// altimate_change - new file
// GitHub reads only. Every subprocess is argv-based and replaceable in tests.
export interface ReviewRepo { host: string; owner: string; name: string }
export type ReviewExecutor = (args: string[], options?: { cwd?: string }) => Promise<{
  exitCode: number; stdout: string; stderr: string
}>

export const reviewExecutor: ReviewExecutor = async (args, options) => {
  const child = Bun.spawn(args, { cwd: options?.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

export interface ReviewComment {
  id: string
  type: "comment" | "review"
  author: { __typename: string; login: string } | null
  body: string
  path?: string
  createdAt?: string
  url: string
  resolved?: boolean
  state?: string
  prNumber: number
  mergedAt: string
}

/** after/number refer to the last fully read PR; partial PRs are replayed. */
export interface ReviewCursor {
  after?: string
  number?: number
  since: number
  resetAt?: string
  /** Counts completed search edges across invocations, against GitHub's 1,000-result ceiling. */
  scanned?: number
  truncated?: boolean
}
export interface ReviewFetchResult {
  comments: ReviewComment[]
  prs: { number: number; mergedAt: string }[]
  prsScanned: number
  cursor: ReviewCursor
  paused: boolean
  resetAt?: string
  complete: boolean
  truncated?: boolean
}

function remoteRepo(value: string): ReviewRepo | undefined {
  // Accept HTTPS, ssh://, git:// and scp-style Git remotes. Host authenticity for
  // a private Enterprise installation is established by gh's auth/access checks.
  const scp = /^(?:[^@/]+@)?([^/:]+):([^/]+\/[^/]+)\/?$/.exec(value)
  let host: string
  let pathname: string
  if (scp && !value.includes("://")) {
    host = scp[1]
    pathname = scp[2]
  } else {
    let url: URL
    try { url = new URL(value) } catch { return }
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return
    host = url.hostname
    pathname = url.pathname.replace(/^\//, "").replace(/\/$/, "")
  }
  host = host.toLowerCase()
  if (/^(?:www\.)?(?:gitlab\.com|bitbucket\.org|codeberg\.org|dev\.azure\.com|ssh\.dev\.azure\.com)$/.test(host)) {
    throw new Error(`learn import-reviews supports GitHub only; ${host} is not GitHub. Use --repo owner/name for a GitHub repository.`)
  }
  const parts = pathname.replace(/\.git$/, "").split("/")
  if (!/^[a-z0-9.-]+$/i.test(host) || parts.length !== 2 || parts.some((part) => !/^[\w.-]+$/.test(part))) return
  return { host, owner: parts[0], name: parts[1] }
}

export async function resolveReviewRepo(root: string, repo?: string, exec: ReviewExecutor = reviewExecutor): Promise<ReviewRepo> {
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Use --repo owner/name (GitHub repositories only).")
  const remotes = await exec(["git", "remote", "-v"], { cwd: root }).catch(() => undefined)
  const rows = (remotes?.exitCode === 0 ? remotes.stdout : "").split("\n")
    .map((line) => /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim()))
    .filter((row): row is RegExpExecArray => !!row)
    .sort((a, b) => Number(b[1] === "origin") - Number(a[1] === "origin"))
  let detected: ReviewRepo | undefined
  let error: unknown
  for (const row of rows) {
    try { detected = remoteRepo(row[2]) } catch (cause) { error = cause }
    if (detected) break
  }
  if (repo) {
    const [owner, name] = repo.split("/")
    return { host: detected?.host ?? "github.com", owner, name }
  }
  if (detected) return detected
  if (error) throw error
  throw new Error("Cannot detect a GitHub repository from this project's git remotes. Set a GitHub/GitHub Enterprise remote or use --repo owner/name.")
}

export async function checkReviewAccess(repo: ReviewRepo, exec: ReviewExecutor = reviewExecutor): Promise<void> {
  // feedback-submit.ts uses the same availability/auth checks inline; there is no
  // shared helper. Keep the host explicit so Enterprise never uses github.com auth.
  const version = await exec(["gh", "--version"]).catch(() => undefined)
  if (!version || version.exitCode !== 0 || !version.stdout.trim().startsWith("gh version")) {
    throw new Error("The gh CLI is not installed. Install it from https://cli.github.com/ (macOS: brew install gh), then run gh auth login.")
  }
  const auth = await exec(["gh", "auth", "status", "--hostname", repo.host]).catch(() => undefined)
  if (!auth || auth.exitCode !== 0) {
    throw new Error(`The gh CLI is not authenticated for ${repo.host}. Run gh auth login --hostname ${repo.host}, then retry. For an Enterprise remote, confirm this host runs GitHub.`)
  }
  const access = await exec(["gh", "api", "--hostname", repo.host, `repos/${repo.owner}/${repo.name}`]).catch(() => undefined)
  if (!access || access.exitCode !== 0) {
    throw new Error(`Cannot read GitHub repository ${repo.host}/${repo.owner}/${repo.name}. Check the repository name and your account's read access; run gh auth status --hostname ${repo.host}.`)
  }
}

interface PageInfo { hasNextPage: boolean; endCursor: string | null }
interface Connection<T> { nodes: T[]; pageInfo: PageInfo }
interface PR { number: number; mergedAt: string | null }
type CommentNode = Pick<ReviewComment, "id" | "author" | "body" | "path" | "createdAt" | "url">
type ReviewNode = CommentNode & { state: string }
interface Thread { id: string; isResolved: boolean; comments: Connection<CommentNode> }
interface GraphData {
  rateLimit?: { remaining: number; resetAt: string; cost: number }
  search?: { issueCount?: number; edges: { cursor: string; node: PR }[]; pageInfo: PageInfo }
  repository?: { pullRequest: { reviewThreads?: Connection<Thread>; reviews?: Connection<ReviewNode> } | null } | null
  node?: Thread | null
}

const rateFields = "rateLimit { remaining resetAt cost }"
const pageFields = "pageInfo { hasNextPage endCursor }"
const commentFields = "id author { __typename login } body path createdAt url"
const prsQuery = `query LearnReviewPRs($search: String!, $after: String, $first: Int!) {
  search(query: $search, type: ISSUE, first: $first, after: $after) {
    issueCount edges { cursor node { ... on PullRequest { number mergedAt } } } ${pageFields}
  } ${rateFields}
}`
const threadsQuery = `query LearnReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviewThreads(first: 50, after: $after) { nodes {
      id isResolved comments(first: 100) { nodes { ${commentFields} } ${pageFields} }
    } ${pageFields} }
  } } ${rateFields}
}`
const commentsQuery = `query LearnReviewComments($id: ID!, $after: String!) {
  node(id: $id) { ... on PullRequestReviewThread {
    id isResolved comments(first: 100, after: $after) { nodes { ${commentFields} } ${pageFields} }
  } } ${rateFields}
}`
const reviewsQuery = `query LearnReviewBodies($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviews(first: 100, after: $after) { nodes { id author { __typename login } body state url createdAt } ${pageFields} }
  } } ${rateFields}
}`

function nextPage(page: PageInfo, previous?: string): string | undefined {
  if (!page.hasNextPage) return
  if (!page.endCursor || page.endCursor === previous) throw new Error("GitHub returned a non-advancing review cursor. Retry the import.")
  return page.endCursor
}

export async function fetchReviews(input: {
  repo: ReviewRepo; since: number; limit: number; cursor?: ReviewCursor
}, deps: { exec?: ReviewExecutor; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): Promise<ReviewFetchResult> {
  if (!Number.isFinite(input.since)) throw new Error("Review --since must be a valid date or duration.")
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1000) {
    throw new Error("Review --limit must be an integer between 1 and 1000 (GitHub's search result limit).")
  }
  if (input.cursor?.truncated) {
    throw new Error("GitHub search stopped at its 1,000-result ceiling. Use a narrower --since window to continue importing reviews; the existing signals are preserved.")
  }
  const exec = deps.exec ?? reviewExecutor
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const since = input.cursor?.since ?? input.since
  const result: ReviewFetchResult = {
    comments: [], prs: [], prsScanned: 0,
    cursor: { after: input.cursor?.after, number: input.cursor?.number, since, scanned: input.cursor?.scanned ?? 0 }, paused: false, complete: false,
  }
  if (input.cursor?.resetAt && Date.parse(input.cursor.resetAt) > now()) {
    return { ...result, cursor: input.cursor, paused: true, resetAt: input.cursor.resetAt }
  }
  const graph = async (query: string, variables: Record<string, string | number | undefined>): Promise<GraphData | undefined> => {
    if (result.paused) return
    const args = ["gh", "api", "graphql", "--hostname", input.repo.host, "-f", `query=${query}`]
    for (const [key, value] of Object.entries(variables)) {
      if (value !== undefined) args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`)
    }
    const response = await exec(args).catch(() => { throw new Error("Failed to run gh api graphql. Check your gh installation and retry the import.") })
    let parsed: { data?: GraphData; errors?: { type?: string; message?: string }[] }
    try { parsed = JSON.parse(response.stdout) } catch { parsed = {} }
    const rate = parsed.data?.rateLimit
    const throttled = parsed.errors?.some((error) => error.type === "RATE_LIMITED" || /rate limit/i.test(error.message ?? ""))
      || (response.exitCode !== 0 && /rate limit|HTTP 429/i.test(response.stderr))
    if (throttled || (rate && rate.remaining <= Math.max(10, rate.cost ?? 1))) {
      result.paused = true
      result.resetAt = rate?.resetAt ?? new Date(now() + 60_000).toISOString()
    }
    if (throttled) return
    if (response.exitCode !== 0 || parsed.errors?.length || !parsed.data) {
      throw new Error(`GitHub could not fetch reviews for ${input.repo.owner}/${input.repo.name}. Check gh auth status --hostname ${input.repo.host} and repository access, then retry.`)
    }
    return parsed.data
  }
  const finish = async () => {
    if (result.paused) {
      result.cursor.resetAt = result.resetAt
      // Do not retry while low. A short bounded backoff avoids tying up a CLI for
      // an hourly reset; the persisted resetAt tells the next run when to resume.
      await sleep(Math.min(1000, Math.max(0, Date.parse(result.resetAt!) - now())))
    }
    return result
  }
  let after = result.cursor.after
  while (result.prsScanned < input.limit) {
    // GitHub has no MERGED_AT ordering. Filter by merge time and traverse newest
    // activity first, matching GitHub's supported descending search order.
    const data = await graph(prsQuery, {
      search: `repo:${input.repo.owner}/${input.repo.name} is:pr is:merged merged:>=${new Date(since).toISOString()} sort:updated-desc`,
      after, first: Math.min(50, input.limit - result.prsScanned),
    })
    if (!data) return finish()
    if (!data.search) throw new Error("GitHub returned no pull request search results. Verify this host supports the GitHub GraphQL API.")
    const truncated = () => {
      if ((data.search!.issueCount ?? 0) <= 1000) return false
      if ((result.cursor.scanned ?? 0) < 1000 && data.search!.pageInfo.hasNextPage) return false
      result.truncated = true
      result.cursor.truncated = true
      result.complete = false
      return true
    }
    for (const edge of data.search.edges) {
      const pr = edge.node
      if (!pr?.mergedAt || Date.parse(pr.mergedAt) < since) {
        result.cursor = { after: edge.cursor, number: pr?.number, since, scanned: (result.cursor.scanned ?? 0) + 1 }
        continue
      }
      if (result.paused) return finish()
      result.prs.push({ number: pr.number, mergedAt: pr.mergedAt })
      result.prsScanned++
      const add = (node: CommentNode, extra: Pick<ReviewComment, "type"> & Partial<Pick<ReviewComment, "resolved" | "state">>) => {
        result.comments.push({ ...node, ...extra, prNumber: pr.number, mergedAt: pr.mergedAt! })
      }
      const variables = { owner: input.repo.owner, name: input.repo.name, number: pr.number }
      let threadAfter: string | undefined
      do {
        const threadsData = await graph(threadsQuery, { ...variables, after: threadAfter })
        if (!threadsData) return finish()
        const threads = threadsData.repository?.pullRequest?.reviewThreads
        if (!threads) throw new Error(`GitHub returned no review threads for PR #${pr.number}. Retry the import.`)
        for (const thread of threads.nodes) {
          for (const comment of thread.comments.nodes) add(comment, { type: "comment", resolved: thread.isResolved })
          let commentAfter = nextPage(thread.comments.pageInfo)
          while (commentAfter) {
            const commentsData = await graph(commentsQuery, { id: thread.id, after: commentAfter })
            if (!commentsData) return finish()
            if (!commentsData.node) throw new Error(`GitHub returned no comments for a review thread on PR #${pr.number}. Retry the import.`)
            for (const comment of commentsData.node.comments.nodes) add(comment, { type: "comment", resolved: commentsData.node.isResolved })
            commentAfter = nextPage(commentsData.node.comments.pageInfo, commentAfter)
          }
        }
        threadAfter = nextPage(threads.pageInfo, threadAfter)
      } while (threadAfter)
      let reviewAfter: string | undefined
      do {
        const reviewsData = await graph(reviewsQuery, { ...variables, after: reviewAfter })
        if (!reviewsData) return finish()
        const reviews = reviewsData.repository?.pullRequest?.reviews
        if (!reviews) throw new Error(`GitHub returned no review bodies for PR #${pr.number}. Retry the import.`)
        for (const review of reviews.nodes) add(review, { type: "review", state: review.state })
        reviewAfter = nextPage(reviews.pageInfo, reviewAfter)
      } while (reviewAfter)
      result.cursor = { after: edge.cursor, number: pr.number, since, scanned: (result.cursor.scanned ?? 0) + 1 }
      if ((result.cursor.scanned ?? 0) >= 1000 && truncated()) return finish()
      if (result.prsScanned >= input.limit) {
        result.complete = !data.search.pageInfo.hasNextPage && edge === data.search.edges.at(-1)
        if (result.complete) truncated()
        return finish()
      }
    }
    after = nextPage(data.search.pageInfo, after)
    if (!after) { result.complete = !truncated(); return finish() }
  }
  return finish()
}
