import z from "zod"
import { Tool } from "../../tool/tool"
import { Instance } from "../../project/instance"
import { reviewPullRequest } from "../review/run"
import { renderSummary, verdictHeadline } from "../review/format"
import { ReviewMode } from "../review/verdict"

/**
 * dbt_pr_review — run the full deterministic dbt PR review and return a signed
 * verdict envelope. The reviewer agent calls this to produce a review backed by
 * the Rust core (equivalence, lineage/DAG impact, PII, grade) rather than prose.
 */
export const DbtPrReviewTool = Tool.define("dbt_pr_review", {
  description: [
    "Run a layered dbt PR review over the changed models in this repo.",
    "Produces a SIGNED verdict (APPROVE | COMMENT | REQUEST_CHANGES) where every",
    "blocking finding is backed by a deterministic engine call — column-lineage",
    "blast radius, query equivalence, PII classification, and A–F grade — not",
    "model opinion, plus advisory LLM comments for contextual judgment. Reads",
    ".altimate/review.yml for per-repo rubric + mode.",
    "",
    "Examples:",
    "- dbt_pr_review({})                                  // review working tree vs origin/main",
    '- dbt_pr_review({ base: "origin/main", head: "HEAD" })',
    '- dbt_pr_review({ manifest_path: "target/manifest.json", mode: "gate" })',
  ].join("\n"),
  parameters: z.object({
    base: z.string().optional().describe("Base git ref. Defaults to merge-base with origin/main."),
    head: z.string().optional().describe("Head git ref. Omit to review the working tree."),
    manifest_path: z
      .string()
      .optional()
      .describe("Path to the compiled dbt manifest.json (overrides .altimate/review.yml)."),
    mode: ReviewMode.optional().describe("comment (never blocks) | gate (blocks on REQUEST_CHANGES)."),
  }),
  async execute(args, ctx) {
    const cwd = Instance.directory
    const env = await reviewPullRequest({
      cwd,
      base: args.base,
      head: args.head,
      manifestPath: args.manifest_path,
      mode: args.mode,
      modelVersion: ctx.agent,
    })
    return {
      title: verdictHeadline(env),
      metadata: {
        verdict: env.verdict,
        idealVerdict: env.idealVerdict,
        tier: env.tier,
        summary: env.summary,
        signature: env.signature,
        findingCount: env.findings.length,
      },
      output: renderSummary(env),
    }
  },
})
