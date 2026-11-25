// altimate_change - new file: the dbt-grounded verifier over the deterministic rule findings
//
// After the finder (and its verifier), the rule findings the review would post go to the
// same verifier in its usual batches. Each one's verdict is recorded under
// `ai.verifier.ruleVerdicts`; the orchestrator drops the refuted ones (`verifyRules`
// switch) and applies the rule-post policy to the rest. Fail-open: no evidence, no model,
// a dry run or a failed call leaves every rule finding as it was.
import { Provider } from "@/provider/provider"
import { Log } from "@/altimate/util/log"
import type { Finding } from "./finding"
import { aiDryRunEnabled, safeReason, type AiLaneStatus, type AiReviewInput, type AiReviewResult } from "./ai-review"
import { runAiVerify, type VerifierLlm, type VerifierStatus } from "./ai-verify"

const log = Log.create({ service: "ai-verify-rules" })

export const NO_RULE_FINDINGS_REASON = "nothing to verify: the PR has no rule findings"

/** A verifier record for a rule run that made no model call. */
export function skippedVerifier(reason: string): VerifierStatus {
  return { state: "skipped", reason, durationMs: 0, turns: 0, toolCalls: 0, reviewed: 0, kept: 0, discarded: 0, summary: 0, unreviewed: 0 }
}

/** Verify `rules` (never calls the finder, returns no findings): the verdicts are on `status.verifier`. */
export async function runRuleVerify(
  input: AiReviewInput,
  rules: Finding[],
  deps: { env?: Record<string, string | undefined>; llm?: VerifierLlm } = {},
): Promise<AiReviewResult> {
  const startedAt = Date.now()
  const env = deps.env ?? process.env
  const done = (status: Omit<AiLaneStatus, "durationMs">): AiReviewResult => ({
    findings: [],
    status: { ...status, durationMs: Date.now() - startedAt },
  })
  const skip = (reason: string) => done({ state: "skipped", reason, verifier: skippedVerifier(reason) })
  if (!input.evidence) return skip("the verifier's evidence is unavailable")
  if (!rules.length) return skip(NO_RULE_FINDINGS_REASON)
  if (aiDryRunEnabled(env)) return skip("dry run (ALTIMATE_REVIEW_AI_DRYRUN=1): no model call")
  let model: Provider.Model
  try {
    const chosen = input.model ? Provider.parseModel(input.model) : await Provider.defaultModel()
    model = await Provider.getModel(chosen.providerID, chosen.modelID)
  } catch (err) {
    return skip(`no usable model: ${safeReason(err)}`)
  }
  log.info("verifying rule findings", { findings: rules.length })
  const v = await runAiVerify(
    { findings: rules, grounding: input.grounding, evidence: input.evidence, model, rulesOnly: true },
    { env, ...(deps.llm ? { llm: deps.llm } : {}) },
  )
  return done({ state: "ok", model: `${model.providerID}/${model.id}`, verifier: v.status })
}
