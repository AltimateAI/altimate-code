/**
 * dbt-pr-review — layered AI code review specialized for analytics engineering.
 * Every blocking verdict is mechanically backed by a deterministic engine call
 * (query equivalence, column-lineage/DAG impact, PII classification, A–F grade,
 * AST anti-pattern lint) and signed into a replayable verdict envelope; an LLM
 * reviewer adds advisory contextual comments on top.
 *
 * Module map:
 *  - finding.ts     FindingV1 schema, fingerprinting, JSONL, dedup
 *  - rubric.ts      severity rules + "what NOT to flag" exclusions (as data)
 *  - verdict.ts     verdict computation + signed VerdictEnvelope
 *  - risk-tier.ts   non-LLM tiering on blast radius / PII / contract signals
 *  - diff-filter.ts dbt-aware changed-file filtering & classification
 *  - config.ts      .altimate/review.yml loader
 *  - orchestrate.ts the deterministic recipe (engine-backed lanes)
 *  - format.ts      envelope → PR summary + inline comments
 */
export * from "./finding"
export * from "./rubric"
export * from "./verdict"
export * from "./risk-tier"
export * from "./diff-filter"
export * from "./config"
export * from "./orchestrate"
export * from "./format"
export * from "./git"
export * from "./runner"
export * from "./run"
export * from "./post-github"
export * from "./schema-context"
export * from "./dbt-patterns"
export * from "./rule-catalog"
export * from "./compiled"
