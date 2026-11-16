/**
 * Per-rule posting policy. Every finding carries a stable `rule` id
 * (`tool:rule`, see `ruleId` in finding.ts); this table decides whether a rule
 * is posted inline on the diff, kept to the summary, or not reported at all.
 *
 * The defaults come from blind per-rule judging of replayed public dbt pull
 * requests: rules whose findings were mostly judged valuable go inline, rules
 * that were wrong at least half the time with nothing valuable and no real
 * catch in the benchmark are off, and everything else stays in the summary.
 * Teams override any entry with `rules:` in `.altimate/review.yml`.
 */

export type RuleTier = "inline" | "summary" | "off"

const INLINE = [
  "dbt-project-rules:incremental-filter-created-only",
  "dbt-project-rules:temporary-code-marker",
  "dbt.manifest:removed-final-layer-columns",
  "dbt-project-rules:microbatch-granularity-mismatch",
  "altimate-core.check:non-deterministic-dedup",
  "dbt-patterns:dedup-no-tiebreaker",
  "dbt-semantics:incremental-partition-change",
  "dbt-project-rules:ref-target-missing",
  "rule-catalog:qualify-unsupported",
  "dbt-project-rules:macro-param-shifted",
  "rule-catalog:case-duplicate-when",
  "dbt-patterns:macro-var-no-default",
  "dbt.manifest:removed-columns-declared-consumers",
  "rule-catalog:ignore-nulls-inside-call",
]

const OFF = [
  "rule-catalog:unqualified-column-multi-table",
  "dbt-patterns:case-no-else",
  "dbt-patterns:comma-join",
  "altimate-core.check:non-portable-function",
  "rule-catalog:cast-float-to-int",
  "rule-catalog:union-not-all",
  "altimate-core.lexical:reserved-word-alias",
  "dbt-patterns:cross-join",
  "rule-catalog:self-join-no-inequality",
  "rule-catalog:not-exists-suggested",
  "altimate-core.check:aggregation-before-join",
  "rule-catalog:count-star-nullable",
  "rule-catalog:string-truncate-left",
  "altimate-core.structural-diff:type-narrowing",
  "rule-catalog:join-without-schema-prefix",
  "rule-catalog:bq-generate-array-large",
  "rule-catalog:intersect-perf",
  "rule-catalog:null-concat",
  "altimate-core.lexical:op-pg-regex-match",
  "rule-catalog:count-star-with-left-join",
  "altimate-core.grain:conflicts-declared-uniqueness",
  "rule-catalog:distinct-with-window",
  "rule-catalog:where-1-eq-1",
  "rule-catalog:bq-string-comparison-collation",
  "rule-catalog:self-equality",
  "rule-catalog:lag-lead-no-default",
  "rule-catalog:boolean-as-int",
  "rule-catalog:top-n-no-order",
  "altimate-core.source-filters:sibling-mismatch",
  "rule-catalog:double-aggregation-alias",
  "rule-catalog:empty-string-eq",
  "rule-catalog:join-no-on",
  "rule-catalog:bq-cross-join-unnest",
  "altimate-core.structural-diff:coalesce-removed",
  "dbt-patterns:window-no-partition",
  "rule-catalog:inequality-join",
  "rule-catalog:running-total-no-order",
  "dbt-patterns:float-equality",
  "altimate-core.structural-diff:group-by-change",
  "rule-catalog:having-row-filter",
  "rule-catalog:bq-array-no-offset",
  "rule-catalog:hardcoded-env-name",
  "altimate-core.structural-diff:join-key-regression",
  "rule-catalog:large-in-list",
  "rule-catalog:count-distinct-multiple-cols",
  "rule-catalog:varchar-fixed-size",
  "rule-catalog:boolean-eq-literal",
  "rule-catalog:trailing-semicolon",
  "dbt-patterns:boolean-precedence",
  "dbt-patterns:pii-into-mart",
  "rule-catalog:bq-legacy-sql",
  "rule-catalog:select-now-column",
  "altimate-core.structural-diff:join-type-change",
  "rule-catalog:run-query-parse",
  "altimate-core.check:non-portable-type",
  "rule-catalog:implicit-cross-join-comma",
]

/** Summary rules listed explicitly: the high-volume ones, and rules judged
 *  mostly wrong that still produced a real catch in the benchmark. */
const SUMMARY = [
  "dbt.manifest:new-model-no-grain-test",
  "rule-catalog:union-select-star",
  "rule-catalog:multiple-left-joins",
  "dbt-semantics:incremental-history-plan",
  "test-adequacy:test-inherits-threshold",
  "dbt.manifest:left-join-key-not-unique",
  "rule-catalog:join-on-cast",
  "dbt-patterns:removed-tests",
  "rule-catalog:group-by-positional",
  "dbt-project-rules:incremental-filter-not-partition",
  "altimate-core.structural-diff:removed-predicate",
  "dbt-project-rules:partition-not-in-merge-key",
  "dbt-project-rules:models-disabled",
  "rule-catalog:greatest-least-null",
  "rule-catalog:hardcoded-year-filter",
  "dbt-patterns:hardcoded-date",
  "altimate-core.dbt-config:incremental-no-guard",
  "altimate-core.dbt-config:unique-key-change",
  "dbt-patterns:fanout-join",
  "dbt-patterns:self-join",
  "rule-catalog:join-case-folded-one-side",
  "dbt-project-rules:test-on-null-column",
  "rule-catalog:distinct-and-group-by",
]

export const DEFAULT_RULE_TIERS: Record<string, RuleTier> = {
  ...Object.fromEntries(SUMMARY.map((r) => [r, "summary" as const])),
  ...Object.fromEntries(OFF.map((r) => [r, "off" as const])),
  ...Object.fromEntries(INLINE.map((r) => [r, "inline" as const])),
}

/** Engine rules that may never default below summary (verdict-relevant). */
const ENGINE_FLOOR = [
  "altimate-core.equivalence:",
  "altimate-core.column-lineage:",
  "impact-analysis:",
  "schema.detect-pii:",
  "altimate-core.classify-pii:",
  "contract-check:",
  "consumer-column-list:",
  "data.diff:",
]

const isFloor = (rule: string) => ENGINE_FLOOR.some((p) => rule.startsWith(p))

/**
 * Resolve a rule's tier: exact override, then the most specific glob override
 * (`tool:*`, longest prefix wins), then the default table, then `summary`.
 * An engine-floor rule can be turned off only by an exact override.
 */
export function ruleTier(rule: string | undefined, overrides: Record<string, RuleTier> = {}): RuleTier {
  if (!rule) return "summary"
  const exact = overrides[rule]
  if (exact) return exact
  const floor = isFloor(rule)
  const globs = Object.entries(overrides)
    .filter(([k]) => k.endsWith("*") && rule.startsWith(k.slice(0, -1)))
    .sort(([a], [b]) => b.length - a.length)
  for (const [, tier] of globs) {
    if (floor && tier === "off") continue
    return tier
  }
  const tier = DEFAULT_RULE_TIERS[rule] ?? "summary"
  return floor && tier === "off" ? "summary" : tier
}
