// altimate_change - new file: the dbt-grounded verifier over the deterministic rule findings
//
// After the finder (and its verifier), the rule findings the review would post go to the
// same verifier in its usual batches. Each one's verdict is recorded under
// `ai.verifier.ruleVerdicts`; the orchestrator drops the refuted ones (`verifyRules`
// switch) and applies the rule-post policy to the rest. Fail-open: no evidence, no model,
// a dry run or a failed call leaves every rule finding as it was.
import { Provider } from "@/provider/provider"
import { Log } from "@/altimate/util/log"
import { type Finding, normalizeRuleId } from "./finding"
import { NOISY_RULE_TYPES } from "./rule-post-policy"
import { aiDryRunEnabled, safeReason, type AiLaneStatus, type AiReviewInput, type AiReviewResult } from "./ai-review"
import { runAiVerify, type VerifierLlm, type VerifierStatus } from "./ai-verify"

const log = Log.create({ service: "ai-verify-rules" })

export const NO_RULE_FINDINGS_REASON = "nothing to verify: the PR has no rule findings"

/** Rule findings verified per PR at most (`ALTIMATE_REVIEW_AI_VERIFY_RULES_MAX_FINDINGS`): the run
 *  has its own verifier budget and each batch of 8 makes at least one call, so this bounds its
 *  calls. Findings past it, most severe first, get no verdict and are posted unchanged. */
export const RULE_VERIFY_MAX_FINDINGS = 40

/** A verifier record for a run that made no model call: its `findings` are all kept, unreviewed (fail-open). */
export function skippedVerifier(reason: string, findings = 0): VerifierStatus {
  return {
    state: "skipped",
    reason,
    durationMs: 0,
    turns: 0,
    toolCalls: 0,
    reviewed: 0,
    kept: findings,
    discarded: 0,
    summary: 0,
    unreviewed: findings,
  }
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
  const skip = (reason: string) => done({ state: "skipped", reason, verifier: skippedVerifier(reason, rules.length) })
  if (!input.evidence) return skip("the verifier's evidence is unavailable")
  const candidates = rules.filter((f) => f.severity !== "critical")
  if (!candidates.length) return skip(NO_RULE_FINDINGS_REASON)
  if (aiDryRunEnabled(env)) return skip("dry run (ALTIMATE_REVIEW_AI_DRYRUN=1): no model call")
  let model: Provider.Model
  try {
    const chosen = input.model ? Provider.parseModel(input.model) : await Provider.defaultModel()
    model = await Provider.getModel(chosen.providerID, chosen.modelID)
  } catch (err) {
    return skip(`no usable model: ${safeReason(err)}`)
  }
  const max = Number(env.ALTIMATE_REVIEW_AI_VERIFY_RULES_MAX_FINDINGS)
  const cap = Number.isInteger(max) && max > 0 ? max : RULE_VERIFY_MAX_FINDINGS
  // Critical findings are never dropped, so they are not verified. Warnings first, since the policy
  // acts on them, and within a severity the default noisy types, whose posting depends on a verdict.
  const order = { critical: 2, warning: 1, suggestion: 0 } as const
  const noisy = new Set(NOISY_RULE_TYPES.map(normalizeRuleId))
  const isNoisy = (f: Finding) => (f.rule && noisy.has(normalizeRuleId(f.rule)) ? 1 : 0)
  const sent = [...candidates].sort((a, b) => order[b.severity] - order[a.severity] || isNoisy(b) - isNoisy(a)).slice(0, cap)
  log.info("verifying rule findings", { findings: sent.length, total: rules.length })
  const v = await runAiVerify(
    { findings: sent, grounding: input.grounding, evidence: input.evidence, model, rulesOnly: true },
    { env, ...(deps.llm ? { llm: deps.llm } : {}) },
  )
  const over = candidates.length - sent.length
  const note = `${over} of ${candidates.length} rule findings over the per-PR ceiling of ${cap} were not verified`
  const verifier = over ? { ...v.status, reason: v.status.reason ? `${v.status.reason}; ${note}` : note } : v.status
  return done({ state: "ok", model: `${model.providerID}/${model.id}`, verifier })
}
