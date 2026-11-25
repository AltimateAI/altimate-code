// altimate_change - new file: rule types not posted once the AI lane runs
//
// `NOISY_RULES_OFF` lists rule ids (`Finding.rule`) whose findings were almost never real
// defects when judged on replayed public dbt PRs, with the AI lane reviewing the same PRs.
// When the AI lane runs, rule findings with one of these ids are dropped before the rule
// verifier and before posting, and counted per rule on the envelope (`rulesOff`). AI
// findings are never dropped, and the finder's grounding is left as it is. With the AI lane
// off nothing changes. `ai.rulesOff: false` or `ALTIMATE_REVIEW_RULES_OFF=0` keeps every
// type; `ai.rulesOn: [ids]` keeps single types; `ALTIMATE_REVIEW_RULES_OFF=<file>` replaces
// the list with a JSON list of rule ids.
import { readFileSync } from "node:fs"
import { type Finding, findingOrigin } from "./finding"
import type { ReviewConfig } from "./config"
import type { AiSwitches } from "./ai-switches"

export const NOISY_RULES_OFF: readonly string[] = [
  "altimate-core.classify-pii:exposes",
  "altimate-core.lexical:op-json-arrow1",
  "altimate-core.lexical:op-pg-cast",
  "altimate-core.structural-diff:removed-predicate",
  "altimate-core.structural-diff:union-added",
  "dbt-patterns:hardcoded-date",
  "dbt-patterns:leading-wildcard",
  "dbt-patterns:multi-count-distinct",
  "dbt-patterns:partition-function",
  "dbt-patterns:self-join",
  "rule-catalog:adapter-call",
  "rule-catalog:bq-datetime-vs-timestamp",
  "rule-catalog:cast-chain",
  "rule-catalog:count-distinct-large",
  "rule-catalog:count-star-with-left-join",
  "rule-catalog:dateadd-from-now",
  "rule-catalog:datediff-arg-order",
  "rule-catalog:distinct-and-group-by",
  "rule-catalog:full-outer-join",
  "rule-catalog:hardcoded-year-filter",
  "rule-catalog:join-on-cast",
  "rule-catalog:lateral-join",
  "rule-catalog:multiple-left-joins",
  "rule-catalog:nested-case",
  "rule-catalog:now-in-filter",
  "rule-catalog:ref-to-source-table",
  "rule-catalog:regexp-heavy",
  "rule-catalog:select-now-column",
  "rule-catalog:select-pii-columns",
  "rule-catalog:select-star-in-cte-final",
  "rule-catalog:staging-as-table",
  "rule-catalog:union-not-all",
  "rule-catalog:union-select-star",
  "rule-catalog:unqualified-column-multi-table",
  "rule-catalog:where-1-eq-1",
  "rule-catalog:where-cast-column",
]

/**
 * The rule ids to drop for this review, or undefined when the switch is off. A list file
 * named by `ALTIMATE_REVIEW_RULES_OFF` replaces the shipped list (an unreadable or malformed
 * file is an error); `ai.rulesOn` takes ids back out.
 */
export function resolveRulesOff(
  cfg: Pick<ReviewConfig, "ai">,
  switches: Pick<AiSwitches, "rulesOff">,
  env: Record<string, string | undefined> = process.env,
): Set<string> | undefined {
  if (!switches.rulesOff) return undefined
  const file = env.ALTIMATE_REVIEW_RULES_OFF
  let list: readonly string[] = NOISY_RULES_OFF
  if (file && file !== "1" && file !== "0") {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (!Array.isArray(parsed) || parsed.some((r) => typeof r !== "string"))
      throw new Error(`ALTIMATE_REVIEW_RULES_OFF must name a JSON list of rule ids: ${file}`)
    list = parsed as string[]
  }
  const on = new Set(typeof cfg.ai === "object" ? (cfg.ai.rulesOn ?? []) : [])
  return new Set(list.filter((r) => !on.has(r)))
}

/** `findings` without the rule findings whose rule id is in `off`, and how many each rule lost. */
export function dropRulesOff(findings: Finding[], off: Set<string> | undefined): { kept: Finding[]; dropped: Record<string, number> } {
  const dropped: Record<string, number> = {}
  if (!off?.size) return { kept: findings, dropped }
  const kept = findings.filter((f) => {
    if (!f.rule || !off.has(f.rule) || findingOrigin(f) === "ai") return true
    dropped[f.rule] = (dropped[f.rule] ?? 0) + 1
    return false
  })
  return { kept, dropped }
}
