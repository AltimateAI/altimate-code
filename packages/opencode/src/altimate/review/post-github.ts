import { Octokit } from "@octokit/rest"
import { promises as fs } from "node:fs"
import { type VerdictEnvelope, VCS_EVENT } from "./verdict"
import { renderSummary, inlineComments, REVIEW_MARKER, verdictHeadline } from "./format"

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
  /** True when inline comments were dropped due to a 422 positioning error. */
  inlineFellBack: boolean
  /** Set when the review event could not be posted for a non-positioning reason. */
  postError?: string
}

export async function postGitHubReview(env: VerdictEnvelope, target: GitHubTarget): Promise<PostResult> {
  const octo = new Octokit({ auth: target.token })
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
  if (prior) {
    const r = await octo.rest.issues.updateComment({ owner, repo, comment_id: prior.id, body: summary })
    result.summaryCommentId = r.data.id
  } else {
    const r = await octo.rest.issues.createComment({ owner, repo, issue_number: prNumber, body: summary })
    result.summaryCommentId = r.data.id
  }

  // 2. Post a review. `env.verdict` arrives already mode-gated from
  //    buildEnvelope (comment mode softened REQUEST_CHANGES → COMMENT upstream);
  //    this map only translates verdict → GitHub event. APPROVE always maps to a
  //    COMMENT event — the bot must never submit a formal GitHub approval.
  const event = VCS_EVENT[env.verdict]
  const comments = inlineComments(env)
  const reviewBody = verdictHeadline(env)

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
