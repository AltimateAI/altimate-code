// altimate_change start — review feature telemetry.
//
// The review engine has two callers: the `review` CLI command and the `dbt_pr_review` tool. They
// share this helper so there is one telemetry contract rather than two that drift — the zero-fill,
// the privacy filtering and the failure classification all live here.
//
// Caller attribution needs no code: neither event declares a `source` field, so the envelope's
// process-level `source` (from Flag.ALTIMATE_CLI_CLIENT) passes through untouched. A caller that
// exports that variable is attributed automatically; one that does not reports `cli`.
import { Telemetry } from "../telemetry"
import { ReviewCategory, type Finding } from "./finding"
import type { VerdictEnvelope } from "./verdict"
import type { PostResult } from "./post-github"

export type ReviewInvocation = "cli" | "tool"

/**
 * Count surfaced findings by category, zero-filled across the whole enum.
 *
 * Zero-filled so a category that never fires is distinguishable from one that was never possible
 * in this run — an absent key and a zero mean different things to whoever reads the dashboard.
 * Keys come from `ReviewCategory.options`, never from the finding values themselves:
 * `Telemetry.aggregateFindings` accepts arbitrary strings and returns only observed keys, so a
 * malformed category would otherwise become a new dimension.
 */
function countByCategory(findings: Finding[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const category of ReviewCategory.options) counts[category] = 0
  for (const finding of findings) {
    if (finding.category in counts) counts[finding.category] += 1
  }
  return counts
}

/**
 * Classify a thrown review failure without threading typed errors through the engine.
 *
 * Only two failure modes actually propagate — everything else in the engine degrades rather than
 * throwing (missing manifests, dispatcher failures and the AI lane are all caught and turned into
 * empty or degraded results). So this deliberately recognises two and calls the rest `error`
 * rather than inventing buckets that can never occur.
 *
 * Matching is on the fixed prefix the config loader throws with, and on the spawn identity of the
 * git child process — not broad substring matching over the message, which would drift the moment
 * anything is reworded.
 */
export function classifyReviewFailure(err: unknown): "config_error" | "git_error" | "error" {
  const message = err instanceof Error ? err.message : String(err)
  if (message.startsWith("Failed to load")) return "config_error"
  const cmd = (err as { cmd?: unknown } | undefined)?.cmd
  if (typeof cmd === "string" && /(^|[\\/\s])git(\s|$)/.test(cmd)) return "git_error"
  if (message.startsWith("git ") || message.includes("git diff")) return "git_error"
  return "error"
}

/**
 * Map a PostResult onto the outcome enum.
 *
 * `PostResult` cannot express finer states than this: an inline fallback and a recorded post error
 * can coexist with a real review id, and `postError` is not cleared when the retry succeeds. So
 * everything short of a clean full post collapses to `partial` rather than pretending to a
 * precision the shape does not have. A throw before the summary is posted never reaches here — the
 * caller reports `summary_failed` for that.
 */
export function classifyPostOutcome(result: PostResult): "full" | "partial" {
  if (result.inlineFellBack || result.postError || result.reviewId === undefined) return "partial"
  return "full"
}

/** Emitted once per engine invocation, whichever caller reached it. */
export function emitReviewRun(input: {
  invocation: ReviewInvocation
  durationMs: number
  /** Empty on the CLI path, which has no chat session. */
  sessionID: string
  envelope?: VerdictEnvelope
  error?: unknown
}): void {
  try {
    const base = {
      type: "review_run" as const,
      timestamp: Date.now(),
      session_id: input.sessionID,
      invocation: input.invocation,
      duration_ms: input.durationMs,
    }

    if (!input.envelope) {
      Telemetry.track({ ...base, status: "failed", reason: classifyReviewFailure(input.error) })
      return
    }

    const env = input.envelope
    Telemetry.track({
      ...base,
      status: "completed",
      verdict: env.verdict,
      ideal_verdict: env.idealVerdict,
      // The effective mode, which config can set — not whatever the caller passed as a flag.
      mode: env.mode,
      tier: env.tier,
      // Optional in the schema and explicitly invalid as `false`, so normalise rather than copy.
      tier_forced: env.tierForced === true,
      degraded: env.summary.degraded,
      stale_manifest: env.staleManifest === true,
      critical: env.summary.critical,
      warning: env.summary.warning,
      suggestion: env.summary.suggestion,
      by_category: countByCategory(env.findings),
    })
  } catch {
    // Telemetry must never fail a review.
  }
}

/** Emitted on the CLI path only — the tool does not publish. */
export function emitReviewPostOutcome(input: {
  outcome: "not_requested" | "target_unresolved" | "full" | "partial" | "summary_failed"
  durationMs: number
  sessionID: string
}): void {
  try {
    Telemetry.track({
      type: "review_post_outcome",
      timestamp: Date.now(),
      session_id: input.sessionID,
      outcome: input.outcome,
      duration_ms: input.durationMs,
    })
  } catch {
    // Telemetry must never fail a review.
  }
}
// altimate_change end
