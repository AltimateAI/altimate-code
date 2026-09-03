import { promises as fs } from "node:fs"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { Installation } from "../../installation"
import { Instance } from "../../project/instance"
import { Telemetry } from "../../altimate/telemetry"
import { reviewPullRequest } from "../../altimate/review/run"
import { renderSummary } from "../../altimate/review/format"
import { postGitHubReview, resolveGitHubTarget } from "../../altimate/review/post-github"
// altimate_change — review feature telemetry
import { classifyPostOutcome, emitReviewPostOutcome, emitReviewRun } from "../../altimate/review/telemetry"
import type { ReviewMode } from "../../altimate/review/verdict"
import type { Severity } from "../../altimate/review/finding"

const MAX_GITHUB_PR_BODY_CHARS = 4_000

async function readGitHubPullRequestMetadata(): Promise<{ prTitle?: string; prBody?: string }> {
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath) return {}
  try {
    const event = JSON.parse(await fs.readFile(eventPath, "utf8")) as {
      pull_request?: { title?: unknown; body?: unknown }
    }
    const title = event.pull_request?.title
    const body = event.pull_request?.body
    return {
      prTitle: typeof title === "string" ? title : undefined,
      prBody: typeof body === "string" ? body.slice(0, MAX_GITHUB_PR_BODY_CHARS) : undefined,
    }
  } catch {
    return {}
  }
}

/**
 * `altimate review` — run the dbt PR review locally or in CI.
 *
 * Local:  altimate review                      (working tree vs origin/main)
 * CI:     altimate review --post --mode gate    (posts verdict + gates merge)
 *
 * Shares the exact engine the reviewer agent / dbt_pr_review tool use, so the
 * CLI, the agent, and the GitHub Action can never diverge.
 */
export const ReviewCommand = cmd({
  command: "review",
  describe: "review dbt/SQL changes and emit a signed verdict (APPROVE/COMMENT/REQUEST_CHANGES)",
  builder: (yargs) =>
    yargs
      // Disable yargs' `--no-<option>` auto-negation for this command. Without this,
      // yargs interprets bare `--no-ai` as "set option `ai` to false" — which is
      // NOT a declared option, so the command silently falls into the help path
      // (exit 0, no review runs). With `boolean-negation: false`, `--no-ai` binds
      // to the declared `noAi` boolean flag as authored. B1 fix, Round 18.
      .parserConfiguration({ "boolean-negation": false })
      .option("base", { type: "string", describe: "base git ref (default: merge-base with origin/main)" })
      .option("head", { type: "string", describe: "head git ref (default: working tree)" })
      .option("manifest", { type: "string", describe: "path to dbt manifest.json (auto-discovered under target/ when omitted)" })
      .option("mode", {
        type: "string",
        choices: ["comment", "gate"] as const,
        describe: "comment = never block; gate = exit non-zero on REQUEST_CHANGES",
      })
      .option("severity", {
        type: "string",
        choices: ["critical", "warning", "suggestion"] as const,
        describe: "minimum severity to surface",
      })
      .option("json", { type: "boolean", default: false, describe: "print the verdict envelope as JSON" })
      .option("output", { type: "string", describe: "write the verdict envelope JSON to this file" })
      .option("post", {
        type: "boolean",
        default: false,
        describe: "post the review to the GitHub PR (uses GITHUB_TOKEN + the Actions event)",
      })
      .option("no-ai", {
        type: "boolean",
        default: false,
        describe: "disable the advisory LLM reviewer lane (no model calls / cost)",
      })
      .option("explain-tier", {
        type: "boolean",
        default: false,
        describe: "emit tierReasons[] in the verdict envelope explaining the tier classification",
      })
      .option("force-tier", {
        type: "string",
        choices: ["trivial", "lite", "full"] as const,
        describe: "[EXPERIMENTAL / bench debug] override the tier classifier — verdict envelope carries tierForced: true",
      })
      .option("cwd", { type: "string", describe: "project directory (default: current dir)" }),
  async handler(args) {
    const cwd = (args.cwd as string) || process.cwd()
    const prMetadata = await readGitHubPullRequestMetadata()
    if (args.forceTier) {
      process.stderr.write(
        `⚠️  --force-tier=${args.forceTier} is EXPERIMENTAL (bench / debug only). ` +
          `Classifier bypassed; verdict envelope will carry tierForced: true.\n`,
      )
    }
    await bootstrap(cwd, async () => {
      Telemetry.setContext({ sessionId: "", projectId: Instance.project?.id ?? "" })
      // altimate_change — time the engine only. Output writing and posting happen after this and
      // must not be counted as review latency, nor turn a computed review into a failed one.
      const startedAt = Date.now()
      let env
      try {
        env = await reviewPullRequest({
          cwd,
          base: args.base as string | undefined,
          head: args.head as string | undefined,
          manifestPath: args.manifest as string | undefined,
          mode: args.mode as ReviewMode | undefined,
          severityThreshold: args.severity as Severity | undefined,
          // With `boolean-negation: false` above, `--no-ai` binds to `noAi` and
          // the historical `--ai=false` programmatic path stays supported.
          noAi: args.noAi === true || args.ai === false,
          explainTier: args.explainTier === true,
          forceTier: args.forceTier as "trivial" | "lite" | "full" | undefined,
          prTitle: prMetadata.prTitle,
          prBody: prMetadata.prBody,
          // Stamp the CLI version into engine.cliVersion so an auditor can
          // reconstruct which policy version generated a stored verdict long
          // after the binary that ran it is gone.
          cliVersion: Installation.VERSION,
        })
      } catch (err) {
        emitReviewRun({ invocation: "cli", durationMs: Date.now() - startedAt, sessionID: "", error: err })
        throw err
      }
      emitReviewRun({ invocation: "cli", durationMs: Date.now() - startedAt, sessionID: "", envelope: env })

      // altimate_change start — publication is its own event: it happens after the review is
      // computed and can partially succeed, so it must not fold into review_run.
      //
      // CONTRACT: exactly one review_post_outcome per COMPLETED review. A review that threw
      // returned above with `review_run: failed` and never reached a publication phase, so the
      // absence of a post event means "the review failed" and never "telemetry was lost".
      //
      // Enforced by a latch plus the finally below rather than by the control flow being
      // obviously exhaustive — it was not. The `not_requested` emit used to sit AFTER the
      // `--output` write and the stdout render, so a bad `--output` path produced a completed
      // review with no post event at all, indistinguishable from a dropped event.
      let postOutcomeEmitted = false
      function emitPostOnce(outcome: Parameters<typeof emitReviewPostOutcome>[0]["outcome"], durationMs: number) {
        if (postOutcomeEmitted) return
        postOutcomeEmitted = true
        emitReviewPostOutcome({ outcome, durationMs, sessionID: "" })
      }

      try {
        // Emitted before anything that can throw, so the no-publication case cannot be lost.
        if (!args.post) emitPostOnce("not_requested", 0)

        if (args.output) await fs.writeFile(args.output as string, JSON.stringify(env, null, 2))

        // Primary output → stdout (pipeable). Diagnostics below → stderr via UI.
        if (args.json) {
          process.stdout.write(JSON.stringify(env, null, 2) + "\n")
        } else {
          process.stdout.write(renderSummary(env) + "\n")
        }

        if (args.post) {
          // Started here, not above: the `not_requested` path reports 0 and never reads these, and
          // capturing them earlier made that hardcoded 0 look like an oversight.
          const postStartedAt = Date.now()
          const postDuration = () => Date.now() - postStartedAt
          let target
          try {
            target = await resolveGitHubTarget()
          } catch (err) {
            // Defensive today — the resolver returns undefined rather than throwing — but the
            // contract should not rest on that staying true. No summary was attempted.
            emitPostOnce("target_unresolved", postDuration())
            throw err
          }
          if (!target) {
            emitPostOnce("target_unresolved", postDuration())
            UI.println(
              "⚠️  --post requested but GITHUB_TOKEN / GITHUB_REPOSITORY / PR number could not be resolved; skipping post.",
            )
          } else {
            let r
            try {
              r = await postGitHubReview(env, target)
            } catch (err) {
              // A throw here means the summary comment itself failed; nothing was published.
              emitPostOnce("summary_failed", postDuration())
              throw err
            }
            emitPostOnce(classifyPostOutcome(r), postDuration())
            const where = `${target.owner}/${target.repo}#${target.prNumber}`
            if (r.postError) {
              UI.println(`⚠️  Posted the summary comment to ${where}, but the review event failed: ${r.postError}`)
            } else {
              UI.println(
                `Posted review to ${where}` +
                  (r.inlineFellBack ? " (inline comments fell back to summary-only)" : ""),
              )
            }
          }
        }
      } finally {
        // Anything that threw between the completed review and the post attempt — a bad
        // `--output` path, a stdout write error. Latched, so a real outcome always wins.
        emitPostOnce("not_attempted", 0)
      }
      // altimate_change end

      // Gate: exit non-zero when blocking, so CI fails the check.
      if (env.mode === "gate" && env.verdict === "REQUEST_CHANGES") {
        process.exitCode = 2
      }
    })
  },
})
