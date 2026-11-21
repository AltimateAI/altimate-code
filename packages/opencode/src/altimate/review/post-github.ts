import { Octokit } from "@octokit/rest"
import { promises as fs } from "node:fs"
import { type VerdictEnvelope, VCS_EVENT, reviewIncomplete } from "./verdict"
import {
  renderSummary,
  inlineComments,
  inlineEligible,
  postedFindingIds,
  postingPolicy,
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
  /** True when inline comments were dropped due to a 422 positioning error. */
  inlineFellBack: boolean
  /** Set when the review event could not be posted for a non-positioning reason. */
  postError?: string
  /** Inline comments not re-posted because the same finding is already on the PR. */
  inlineSkippedAsPosted?: number
  /** True when no review was submitted: nothing new to say and a previous
   *  non-blocking altimate review already exists (the summary comment was updated). */
  reviewSkipped?: boolean
  /** Earlier blocking altimate reviews dismissed because this run no longer blocks. */
  dismissedReviews?: number
  /** True when a clean run under `silentWhenClean` posted no review (and no
   *  summary, unless one from an earlier run needed replacing). Implies `reviewSkipped`. */
  silent?: boolean
}

/** True when every check ran (no engine error, no failed file, no abstained
 *  check, no model without compiled head SQL), so missing findings mean
 *  "fixed", not "not checked". */
export function runCompleted(env: VerdictEnvelope): boolean {
  return !reviewIncomplete(env)
}

/** Headline of a review this bot posted (see verdictHeadline). */
const BOT_REVIEW_RE = /(Approved|Reviewed with comments|Changes requested)\b.*\((trivial|lite|full) tier/
/** Hidden marker in the body of every review this bot posts; reviews of a
 *  dbt project below the repository root also name it (`project=<dir>`,
 *  URI-encoded so a directory with spaces stays one token). */
const BOT_REVIEW_MARKER_RE = /<!-- altimate-code-review:verdict(?: project=(\S+))? -->/

function botReviewMarker(projectRoot: string | undefined): string {
  return projectRoot
    ? `<!-- altimate-code-review:verdict project=${encodeURI(projectRoot)} -->`
    : "<!-- altimate-code-review:verdict -->"
}

function markerProject(encoded: string | undefined): string {
  if (!encoded) return ""
  try {
    return decodeURI(encoded)
  } catch {
    return encoded
  }
}

type ReviewLike = { body?: string | null; user?: { type?: string; login?: string } | null }

/** A review this bot posted for this dbt project. The author must be a bot
 *  (GitHub App / `github-actions[bot]`) or the token's own login: a human
 *  review that quotes the bot's body, marker included, is never the bot's.
 *  The marker then scopes it to a project, so in a monorepo one project's run
 *  never touches another project's review. A bot review without the marker
 *  (posted before it existed) matches every project. */
function isBotReview(r: ReviewLike, projectRoot: string | undefined, selfLogin: string | undefined): boolean {
  const body = r.body ?? ""
  if (!BOT_REVIEW_RE.test(body)) return false
  const byBot = r.user?.type === "Bot" || (!!selfLogin && r.user?.login === selfLogin)
  if (!byBot) return false
  const marker = BOT_REVIEW_MARKER_RE.exec(body)
  if (!marker) return true
  return markerProject(marker[1]) === (projectRoot ?? "")
}

/** True only when the run is known to have reviewed the PR's current head:
 *  the reviewed commit is the head itself, or the merge commit a `pull_request`
 *  checkout builds from it (`refs/pull/N/merge`, whose second parent is the
 *  head). Unknown on either side means "not proven", so a block is kept. */
export function reviewedPrHead(scope: VerdictEnvelope["scope"], prHeadSha: string | undefined): boolean {
  const headSha = scope?.headSha
  if (!headSha || !prHeadSha) return false
  return headSha === prHeadSha || (scope?.headParents ?? []).slice(1).includes(prHeadSha)
}

/** The Octokit surface the poster uses; injectable so the posting rules
 *  (dedup, dismissal, skip) are testable without the network. `users` is
 *  optional: it only resolves the token's login for non-bot tokens. */
export type GitHubClient = Pick<Octokit, "paginate"> & {
  rest: Pick<Octokit["rest"], "issues" | "pulls"> & Partial<Pick<Octokit["rest"], "users">>
}

/** Login of the token's user, needed only when a marked review has a non-bot
 *  author (a personal token posts as a User). The Actions GITHUB_TOKEN cannot
 *  call this endpoint; its reviews are authored by a Bot anyway. */
async function tokenLogin(octo: GitHubClient): Promise<string | undefined> {
  try {
    return (await octo.rest.users?.getAuthenticated())?.data.login
  } catch {
    return undefined
  }
}

export async function postGitHubReview(
  env: VerdictEnvelope,
  target: GitHubTarget,
  client?: GitHubClient,
): Promise<PostResult> {
  const octo = client ?? new Octokit({ auth: target.token })
  const { owner, repo, prNumber } = target
  const result: PostResult = { inlineFellBack: false }
  const projectRoot = env.scope?.projectRoot || undefined

  // 1. Read what is already on the PR. Rerun dedup: a finding already
  //    commented inline (same fingerprint, which ignores line numbers) is not
  //    posted again on the next push.
  let posted = new Set<string>()
  let priorBotReview = false
  let staleBlocking: number[] = []
  try {
    const [reviewComments, reviews] = await Promise.all([
      octo.paginate(octo.rest.pulls.listReviewComments, { owner, repo, pull_number: prNumber, per_page: 100 }),
      octo.paginate(octo.rest.pulls.listReviews, { owner, repo, pull_number: prNumber, per_page: 100 }),
    ])
    posted = postedFindingIds(reviewComments.map((c) => c.body))
    const needsLogin = reviews.some((r) => r.user?.type !== "Bot" && BOT_REVIEW_MARKER_RE.test(r.body ?? ""))
    const selfLogin = needsLogin ? await tokenLogin(octo) : undefined
    const botReviews = reviews.filter((r) => isBotReview(r, projectRoot, selfLogin))
    priorBotReview = botReviews.length > 0
    staleBlocking = botReviews.filter((r) => r.state === "CHANGES_REQUESTED").map((r) => r.id)
  } catch {
    /* listing failed: post everything rather than nothing */
  }

  // 2. Upsert the summary comment (dedup by marker). Paginate ALL comments —
  //    on a busy PR the prior marker comment can be past the first page, and
  //    missing it would post a duplicate summary on every rerun. A silent clean
  //    run posts nothing, but still overwrites an earlier summary so it does
  //    not keep showing findings that are gone.
  const summary = renderSummary(env, { alreadyPosted: posted })
  const silent = summary === ""
  const existing = await octo.paginate(octo.rest.issues.listComments, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  })
  const prior = existing.find((c) => c.body?.includes(REVIEW_MARKER))
  if (prior) {
    const body = silent ? renderSummary(env, { alreadyPosted: posted, allowSilent: false }) : summary
    const r = await octo.rest.issues.updateComment({ owner, repo, comment_id: prior.id, body })
    result.summaryCommentId = r.data.id
  } else if (!silent) {
    const r = await octo.rest.issues.createComment({ owner, repo, issue_number: prNumber, body: summary })
    result.summaryCommentId = r.data.id
  }

  // 3. Post a review. `env.verdict` arrives already mode-gated from
  //    buildEnvelope (comment mode softened REQUEST_CHANGES → COMMENT upstream);
  //    this map only translates verdict → GitHub event. APPROVE always maps to a
  //    COMMENT event — the bot must never submit a formal GitHub approval.
  const event = VCS_EVENT[env.verdict]
  const headline = verdictHeadline(env)
  const reviewBody = `${headline}\n\n${botReviewMarker(projectRoot)}`
  const { comments } = inlineComments(env, posted)
  const posting = postingPolicy(env)
  result.inlineSkippedAsPosted = env.findings.filter((f) => inlineEligible(f, posting) && posted.has(f.id)).length

  // Anchor inline comments to the PR head commit. Without commit_id, GitHub's
  // line-positioning is fragile and can 422 even on valid lines.
  let commitId: string | undefined
  try {
    const pr = await octo.rest.pulls.get({ owner, repo, pull_number: prNumber })
    commitId = pr.data.head.sha
  } catch {
    /* fall back to default head resolution */
  }

  // Gate lifecycle: when this run no longer blocks, an earlier blocking
  // altimate review would keep the PR blocked forever. Dismiss it, pointing at
  // the new verdict. (Requires `pull-requests: write`; a failure is non-fatal.)
  // Only a run that actually completed may clear a block: when an engine call
  // or a file failed, a check abstained, or a model had no compiled SQL, the
  // blocking finding may simply not have been produced. Only a run proven to
  // have reviewed the PR's current head clears a block: a run on an older push,
  // or one whose reviewed commit or PR head is unknown, keeps it.
  const onCurrentHead = reviewedPrHead(env.scope, commitId)
  const dismissStale = async () => {
    if (event !== "COMMENT" || !staleBlocking.length || !runCompleted(env) || !onCurrentHead) return
    let dismissed = 0
    for (const id of staleBlocking) {
      try {
        await octo.rest.pulls.dismissReview({
          owner,
          repo,
          pull_number: prNumber,
          review_id: id,
          message: `Superseded by a newer altimate review: ${headline}`,
        })
        dismissed++
      } catch {
        /* keep going; the summary still shows the current verdict */
      }
    }
    result.dismissedReviews = dismissed
  }

  // A silent clean run adds no review: the check status records the run.
  if (silent) {
    result.silent = true
    result.reviewSkipped = true
    await dismissStale()
    return result
  }

  // Nothing new inline, not blocking, and the PR already has an altimate
  // review: the updated summary comment says it all; another "Reviewed with
  // comments" entry per push is noise. A blocking verdict always posts.
  if (!comments.length && event === "COMMENT" && priorBotReview) {
    result.reviewSkipped = true
    await dismissStale()
    return result
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
    await dismissStale()
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
    // The summary listed inline findings as one-line pointers; with the inline
    // comments gone, rewrite it with every finding in full so none loses its body.
    if (comments.length && result.summaryCommentId !== undefined) {
      try {
        const body = renderSummary(env, { alreadyPosted: posted, inline: false, allowSilent: false })
        await octo.rest.issues.updateComment({ owner, repo, comment_id: result.summaryCommentId, body })
      } catch {
        /* the event-only review below still records the verdict */
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
      await dismissStale()
    } catch (e2: any) {
      // The replacement review did not land: keep the earlier block.
      // Summary comment already landed; don't fail CI on a review-post error.
      result.postError = `${e2?.status ?? ""} ${e2?.message ?? e2}`.trim()
    }
  }
  return result
}
