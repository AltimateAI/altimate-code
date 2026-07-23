import { promises as fs } from "node:fs"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { reviewPullRequest } from "../../altimate/review/run"
import { renderSummary } from "../../altimate/review/format"
import { postGitHubReview, resolveGitHubTarget } from "../../altimate/review/post-github"
import type { ReviewMode } from "../../altimate/review/verdict"
import type { Severity } from "../../altimate/review/finding"

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
    if (args.forceTier) {
      process.stderr.write(
        `⚠️  --force-tier=${args.forceTier} is EXPERIMENTAL (bench / debug only). ` +
          `Classifier bypassed; verdict envelope will carry tierForced: true.\n`,
      )
    }
    await bootstrap(cwd, async () => {
      const env = await reviewPullRequest({
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
      })

      if (args.output) await fs.writeFile(args.output as string, JSON.stringify(env, null, 2))

      // Primary output → stdout (pipeable). Diagnostics below → stderr via UI.
      if (args.json) {
        process.stdout.write(JSON.stringify(env, null, 2) + "\n")
      } else {
        process.stdout.write(renderSummary(env) + "\n")
      }

      if (args.post) {
        const target = await resolveGitHubTarget()
        if (!target) {
          UI.println(
            "⚠️  --post requested but GITHUB_TOKEN / GITHUB_REPOSITORY / PR number could not be resolved; skipping post.",
          )
        } else {
          const r = await postGitHubReview(env, target)
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

      // Gate: exit non-zero when blocking, so CI fails the check.
      if (env.mode === "gate" && env.verdict === "REQUEST_CHANGES") {
        process.exitCode = 2
      }
    })
  },
})
