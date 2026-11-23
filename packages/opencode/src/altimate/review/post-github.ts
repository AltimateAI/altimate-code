import { Octokit } from "@octokit/rest"
import { promises as fs } from "node:fs"
import { type VerdictEnvelope, VCS_EVENT } from "./verdict"
import {
  commentableLines,
  inlineComments,
  postedFindingIds,
  renderSummary,
  REVIEW_MARKER,
  verdictHeadline,
} from "./format"

/**
 * Post a verdict envelope to a GitHub pull request: an upserted summary comment
 * (deduped by the review marker, so re-reviews update in place) plus a single
 * batched review with inline comments. The review event is never a formal
 * GitHub APPROVE (a bot approval could satisfy branch protection): an APPROVE
 * verdict posts COMMENT. In `comment` mode REQUEST_CHANGES is also softened to
 * COMMENT; in `gate` mode REQUEST_CHANGES maps through as a blocking review.
 *
 * Self-contained (uses GITHUB_TOKEN) so it works from CI without the GitHub App
 * flow. Defensive: inline comments outside the diff fall back to an event-only
 * review rather than failing the job.
 */

export interface GitHubTarget {
  token: string
  owner: string
  repo: string
  prNumber: number
}

/** Resolve owner/repo/prNumber from the GitHub Actions environment. */
export async function resolveGitHubTarget(): Promise<GitHubTarget | undefined> {
  const token = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"]
  const repoSlug = process.env["GITHUB_REPOSITORY"]
  if (!token || !repoSlug) return undefined
  const [owner, repo] = repoSlug.split("/")
  if (!owner || !repo) return undefined

  let prNumber: number | undefined
  const eventPath = process.env["GITHUB_EVENT_PATH"]
  if (eventPath) {
    try {
      const event = JSON.parse(await fs.readFile(eventPath, "utf8"))
      prNumber = event.pull_request?.number ?? event.issue?.number ?? event.number
    } catch {
      /* ignore */
    }
  }
  const fromEnv = process.env["ALTIMATE_PR_NUMBER"]
  if (!prNumber && fromEnv) prNumber = Number(fromEnv)
  if (!prNumber) return undefined
  return { token, owner, repo, prNumber }
}

export interface PostResult {
  summaryCommentId?: number
  reviewId?: number
  /** True when some or all inline comments were dropped due to a 422 positioning error. */
  inlineFellBack: boolean
  /** Set when the review event could not be posted for a non-positioning reason. */
  postError?: string
  /** Inline comments not re-posted because the same finding is already on the PR. */
  inlineSkippedAsPosted?: number
  /** True when no review was submitted: nothing new inline, the verdict is not
   *  blocking, and this bot's latest review already carries the same headline
   *  (the summary comment was updated). */
  reviewSkipped?: boolean
}

/** Headline of a review this bot posted (see verdictHeadline). */
const BOT_REVIEW_RE = /(Approved|Reviewed with comments|Changes requested)\b.*\((trivial|lite|full) tier/

export async function postGitHubReview(
  env: VerdictEnvelope,
  target: GitHubTarget,
  octo: Octokit = new Octokit({ auth: target.token }),
): Promise<PostResult> {
  const { owner, repo, prNumber } = target
  const result: PostResult = { inlineFellBack: false }

  // 1. Upsert the summary comment (dedup by marker). Paginate ALL comments —
  //    on a busy PR the prior marker comment can be past the first page, and
  //    missing it would post a duplicate summary on every rerun.
  const summary = renderSummary(env)
  const existing = await octo.paginate(octo.rest.issues.listComments, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  })
  const prior = existing.find((c) => c.body?.includes(REVIEW_MARKER))
  const upserted = prior
    ? await octo.rest.issues.updateComment({ owner, repo, comment_id: prior.id, body: summary })
    : await octo.rest.issues.createComment({ owner, repo, issue_number: prNumber, body: summary })
  result.summaryCommentId = upserted.data.id
  // The account this token posts as: the summary comment's author.
  const botLogin = upserted.data.user?.login

  // 2. Post a review. `env.verdict` arrives already mode-gated from
  //    buildEnvelope (comment mode softened REQUEST_CHANGES → COMMENT upstream);
  //    this map only translates verdict → GitHub event. APPROVE always maps to a
  //    COMMENT event — the bot must never submit a formal GitHub approval.
  const event = VCS_EVENT[env.verdict]
  const reviewBody = verdictHeadline(env)

  // Rerun dedup: a finding already commented inline (same fingerprint, which
  // ignores line numbers) is not posted again on the next push.
  let posted = new Set<string>()
  let lastBotHeadline: string | undefined
  try {
    const [reviewComments, reviews] = await Promise.all([
      octo.paginate(octo.rest.pulls.listReviewComments, { owner, repo, pull_number: prNumber, per_page: 100 }),
      octo.paginate(octo.rest.pulls.listReviews, { owner, repo, pull_number: prNumber, per_page: 100 }),
    ])
    posted = postedFindingIds(reviewComments.map((c) => c.body))
    // Reviews are listed oldest first; only this bot's own latest review counts.
    const mine = botLogin
      ? reviews.filter((r) => r.user?.login === botLogin && BOT_REVIEW_RE.test(r.body ?? ""))
      : []
    lastBotHeadline = mine.at(-1)?.body?.trim()
  } catch {
    /* listing failed: post everything rather than nothing */
  }

  // Inline comments only on lines GitHub accepts (inside the PR's diff hunks).
  // If the file list can't be read, or a file has no `patch` (GitHub omits it
  // for large diffs), post those lines and rely on the 422 fallback.
  let commentable: Map<string, Set<number>> | undefined
  try {
    const files = await octo.paginate(octo.rest.pulls.listFiles, { owner, repo, pull_number: prNumber, per_page: 100 })
    commentable = new Map(files.filter((f) => f.patch).map((f) => [f.filename, commentableLines(f.patch)]))
  } catch {
    /* fall back to the positioning retry below */
  }
  const comments = inlineComments(env, posted, commentable)
  result.inlineSkippedAsPosted = inlineComments(env, new Set(), commentable).length - comments.length

  // Nothing new inline, not blocking, and this bot's latest review already says
  // the same thing: the updated summary comment covers it; another identical
  // timeline entry per push is noise. A blocking verdict always posts, and a
  // changed headline (e.g. after "Changes requested") posts a new review.
  if (!comments.length && event === "COMMENT" && lastBotHeadline === reviewBody) {
    result.reviewSkipped = true
    return result
  }

  // Anchor inline comments to the PR head commit. Without commit_id, GitHub's
  // line-positioning is fragile and can 422 even on valid lines.
  let commitId: string | undefined
  try {
    const pr = await octo.rest.pulls.get({ owner, repo, pull_number: prNumber })
    commitId = pr.data.head.sha
  } catch {
    /* fall back to default head resolution */
  }

  try {
    const r = await octo.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitId,
      event,
      body: reviewBody,
      comments: comments.length ? comments : undefined,
    })
    result.reviewId = r.data.id
  } catch (e: any) {
    // Only a line-positioning error (422 Unprocessable) justifies dropping the
    // inline comments — anchoring outside the diff hunk. Other errors (auth,
    // can't-approve-own-PR, 5xx) should NOT masquerade as "lines outside diff",
    // so we still retry event-only but record the real reason.
    const status = e?.status ?? e?.response?.status
    // Only a 422 that is actually about line POSITIONING justifies silently
    // dropping inline comments. A generic 422 (and any other status) is a real
    // error and must be reported, not masqueraded as "lines outside diff".
    const detail = `${e?.message ?? ""} ${JSON.stringify(e?.response?.data?.errors ?? e?.errors ?? "")}`.toLowerCase()
    const isPositioning = status === 422 && /(position|\bline\b|diff|commit)/.test(detail)
    result.inlineFellBack = isPositioning
    result.postError = isPositioning ? undefined : `${status ?? ""} ${e?.message ?? e}`.trim()
    // Lines on files without a known hunk (no `patch`) are the likely cause of a
    // positioning 422: retry once with only the comments on verified files
    // before dropping every inline comment.
    const verified = isPositioning && commentable ? comments.filter((c) => commentable!.has(c.path)) : []
    if (verified.length && verified.length < comments.length) {
      try {
        const r = await octo.rest.pulls.createReview({
          owner,
          repo,
          pull_number: prNumber,
          commit_id: commitId,
          event,
          body: reviewBody,
          comments: verified,
        })
        result.reviewId = r.data.id
        return result
      } catch {
        /* fall through to the event-only review */
      }
    }
    try {
      const r = await octo.rest.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        commit_id: commitId,
        event,
        body: reviewBody,
      })
      result.reviewId = r.data.id
    } catch (e2: any) {
      // Summary comment already landed; don't fail CI on a review-post error.
      result.postError = `${e2?.status ?? ""} ${e2?.message ?? e2}`.trim()
    }
  }
  return result
}
