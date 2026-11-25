// altimate_change - new file: which verified rule findings are posted
//
// After the rule types off and the refuted rule findings are dropped, a rule finding is not
// posted when (1) the verifier's verdict on it is `unverifiable` and its severity is warning,
// or (2) its rule type is on the noisy list and the verdict is not `confirmed`. A finding with
// no verdict counts as unverifiable. AI findings and critical rule findings are never touched:
// a critical rule finding is always posted. The caller skips the policy when the rule
// verifier did not run (fail-open).
import { type Finding, findingOrigin, normalizeRuleId } from "./finding"

/** Rule types at least 30% wrong over at least 3 posted findings when judged on replayed public dbt PRs. */
export const NOISY_RULE_TYPES: readonly string[] = [
  "altimate-core.structural-diff:surrogate-key-change",
  "dbt-patterns:fanout-join",
  "dbt-patterns:removed-tests",
  "dbt.manifest:unique-key-differs-from-test",
  "impact-analysis:downstream-consumers",
  "rule-catalog:implicit-cast-compare",
  "rule-catalog:sf-flatten-explosion",
]

export interface RulePostPolicy {
  noisyRules: readonly string[]
}

export const DEFAULT_RULE_POST_POLICY: RulePostPolicy = { noisyRules: NOISY_RULE_TYPES }

export type RuleVerdictValue = "confirmed" | "refuted" | "unverifiable"

export interface RulePolicyDrops {
  unverifiable_high_sev: number
  noisy_type_not_confirmed: number
}

/** Which condition drops `f`, if any (pure). */
export function rulePolicyDrop(
  f: Finding,
  verdict: RuleVerdictValue | null | undefined,
  policy: RulePostPolicy,
): keyof RulePolicyDrops | undefined {
  if (findingOrigin(f) === "ai" || f.severity === "critical") return undefined
  const v = verdict ?? "unverifiable"
  if (v === "unverifiable" && f.severity === "warning") return "unverifiable_high_sev"
  if (f.rule && v !== "confirmed" && policy.noisyRules.some((r) => normalizeRuleId(r) === normalizeRuleId(f.rule!)))
    return "noisy_type_not_confirmed"
  return undefined
}

/** `findings` without the rule findings the policy drops, and the count per condition (pure). */
export function dropByRulePolicy(
  findings: Finding[],
  verdictById: ReadonlyMap<string, RuleVerdictValue | null>,
  policy: RulePostPolicy = DEFAULT_RULE_POST_POLICY,
): { kept: Finding[]; dropped: RulePolicyDrops } {
  const dropped: RulePolicyDrops = { unverifiable_high_sev: 0, noisy_type_not_confirmed: 0 }
  const kept = findings.filter((f) => {
    const why = rulePolicyDrop(f, verdictById.get(f.id), policy)
    if (why) dropped[why]++
    return !why
  })
  return { kept, dropped }
}

/** Whether the rule verifier ran enough for the policy: it reviewed at least one finding. */
export function rulePolicyApplies(ruleVerifier: { state: string; reviewed?: number } | undefined): boolean {
  return !!ruleVerifier && ruleVerifier.state !== "skipped" && (ruleVerifier.reviewed ?? 0) > 0
}

/** The policy configured under `ai.rulePolicy` (an object changes the noisy list). */
export function configuredRulePolicy(cfg: { ai: unknown }): RulePostPolicy {
  const rp = cfg.ai && typeof cfg.ai === "object" ? (cfg.ai as { rulePolicy?: unknown }).rulePolicy : undefined
  const noisy = rp && typeof rp === "object" ? (rp as { noisyRules?: string[] }).noisyRules : undefined
  return noisy ? { noisyRules: noisy } : DEFAULT_RULE_POST_POLICY
}
