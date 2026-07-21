import {
  type ChangedFile,
  type DbtFileKind,
  classifyDbtFile,
  countChangedLines,
  looksLikeSourceYml,
  touchesContract,
} from "./diff-filter"
import type { RiskTier } from "./verdict"

/**
 * Deterministic, non-LLM risk-tiering — the cost keystone.
 *
 * Cloudflare tiers on line count because its reviewers are generic. We own a
 * DAG-aware blast-radius signal, so we tier on DATA-relevant signals: which dbt
 * surface changed, how many models are downstream, and whether a PII / source /
 * contract / migration path is touched. The expensive lanes (equivalence,
 * data-diff) only fire when the change actually warrants them.
 *
 * Hard floor: any PII / source / contract / snapshot / migration touch is
 * always FULL regardless of size — the data analogue of Cloudflare's
 * "security-sensitive files always full".
 */

/** Per-file classification feeding the tier decision. */
export interface FileChangeClass {
  path: string
  kind: DbtFileKind
  changedLines: number
  /** Downstream consumer count from impact-analysis (0 when unknown/no manifest). */
  blastRadius: number
  touchesPii: boolean
  touchesContract: boolean
  touchesSource: boolean
  materializationChange: boolean
  incrementalLogicChange: boolean
  /** Structurally complex SQL (window/subquery/large plan) — never `trivial`. */
  complex: boolean
  // R20 S4 — risk-signal promotion. Grounded in the 5-PR internal corpus study
  // (see data-engineering-skills/docs/pr-review-corpus-findings-r20.md) where
  // PRs D (test-only YAML on contracted marts) and E (cost-anchor redesign)
  // both auto-approved despite each having 8+ substantive human findings.
  /** schema.yml diff introduces or edits `data_tests:`, `constraints:`,
   *  `unique_combination_of_columns`, or `contract:` — grain / constraint
   *  territory reviewers repeatedly flagged as substantive. */
  dbtRiskYmlChanges: boolean
  /** File lives under `models/marts/` or `models/mart/` — mart-layer changes
   *  land in the API surface downstream consumers depend on. */
  martLayerChange: boolean
  /** Path or filename contains a FinOps keyword
   *  (`cost|saving|billing|credit|dbu|spend|revenue|price|rate`). The
   *  highest-severity blockers in the corpus (cross-model rate asymmetry,
   *  DBU savings > DBU cost, misanchored billing units) landed here. */
  finopsPathToken: boolean
}

export interface ClassifyOptions {
  /** Resolve a changed file path to its downstream consumer count. */
  blastRadiusOf?: (path: string) => number
  /** Mark a path as touching a PII-classified column. */
  touchesPiiOf?: (file: ChangedFile) => boolean
  /** Mark a path as a structurally complex change (window/subquery/large plan). */
  isComplexOf?: (file: ChangedFile) => boolean
}

const MATERIALIZATION_RE = /[+]?materialized\s*[:=]|config\s*\(\s*[^)]*materialized/i
const INCREMENTAL_RE = /is_incremental\s*\(|unique_key|incremental_strategy|merge_update_columns|partition_by/i

// R20 S4 — signals that lift a PR out of trivial / lite. See FileChangeClass docs.
//
// Anchored to YAML key position after the optional diff marker (`+`/`-`),
// optional indentation, and optional list-item marker (`- `). Excludes comment
// lines (`#`) and description strings that happen to contain the keyword. Two
// forms because `data_tests`/`constraints`/`contract` are ALWAYS keys, whereas
// `unique_combination_of_columns` is a TEST NAME that shows up as a list item
// (`- dbt_utils.unique_combination_of_columns:`).
const DBT_RISK_KEY_RE = /^[+-]?[ \t]*(?!#)(?:-[ \t]+)?(?:data_tests|constraints|contract)[ \t]*:/im
const DBT_UNIQUE_COMBO_RE = /^[+-]?[ \t]*(?!#)-[ \t]+(?:[\w.]+\.)?unique_combination_of_columns[ \t]*:/im
const MARTS_DIR_RE = /(?:^|\/)models\/marts?\//i
// FinOps keyword must sit at a path or filename boundary so we don't fire on
// arbitrary substrings (e.g. `broadcaster` matching `caste` never triggers
// `cost`, but `_backups_of_cost_config.sql` would still catch on the `cost`
// token via `_`). Cover common word / segment / extension boundaries.
const FINOPS_TOKEN_RE = /(?:^|[\/_.-])(?:cost|costs|saving|savings|billing|credit|credits|dbu|dbus|spend|revenue|price|prices|rate|rates|pricing|invoice|invoices)(?:$|[\/_.-])/i

/** The ADDED/REMOVED lines of a unified diff (excludes context + hunk headers),
 *  so signal detection fires on what actually changed, not surrounding context. */
function changedLines(diff: string | undefined): string {
  if (!diff) return ""
  return diff
    .split("\n")
    .filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---"))
    .join("\n")
}

/** Classify a single changed file from its diff + optional manifest signals. */
export function classifyFile(file: ChangedFile, opts: ClassifyOptions = {}): FileChangeClass {
  const kind = classifyDbtFile(file.path)
  const diff = file.diff
  const changed = changedLines(diff)
  return {
    path: file.path,
    kind,
    changedLines: countChangedLines(diff),
    blastRadius: opts.blastRadiusOf?.(file.path) ?? 0,
    touchesPii: opts.touchesPiiOf?.(file) ?? false,
    touchesContract: touchesContract(diff),
    touchesSource: kind === "source_yml" || looksLikeSourceYml(diff),
    materializationChange: kind === "model_sql" && !!changed && MATERIALIZATION_RE.test(changed),
    incrementalLogicChange: kind === "model_sql" && !!changed && INCREMENTAL_RE.test(changed),
    complex: opts.isComplexOf?.(file) ?? false,
    dbtRiskYmlChanges:
      kind === "schema_yml" && !!changed && (DBT_RISK_KEY_RE.test(changed) || DBT_UNIQUE_COMBO_RE.test(changed)),
    martLayerChange: MARTS_DIR_RE.test(file.path),
    finopsPathToken: FINOPS_TOKEN_RE.test(file.path),
  }
}

/** Reasons a file forces FULL tier (the hard floor). */
export function fullTierReasons(c: FileChangeClass): string[] {
  const reasons: string[] = []
  if (c.touchesPii) reasons.push("PII column touched")
  if (c.touchesContract) reasons.push("enforced contract touched")
  if (c.touchesSource) reasons.push("source definition touched")
  if (c.kind === "snapshot") reasons.push("snapshot changed")
  if (c.kind === "macro") reasons.push("macro changed (broad blast radius)")
  if (c.kind === "project_config") reasons.push("project config changed (global blast radius)")
  if (c.materializationChange) reasons.push("materialization changed")
  if (c.incrementalLogicChange) reasons.push("incremental logic changed")
  if (c.blastRadius > 5) reasons.push(`${c.blastRadius} downstream models`)
  // R20 S4 — trivial/lite promotion for signals the 5-PR corpus proved are
  // reviewer-critical. Each reason surfaces in the signed envelope's
  // `tierReasons`, so a customer can see WHY a nominally-tiny YAML-only diff
  // ran at full tier.
  //
  // Path-based `martLayerChange` on its own is intentionally NOT a promotion
  // reason — description-only edits under `models/marts/` are legitimately
  // trivial. Promotion here requires diff-level evidence (`dbtRiskYmlChanges`)
  // or a FinOps path token, either of which correlates with real reviewer
  // blockers in the corpus. `martLayerChange` upgrades the WEIGHT of a
  // dbtRiskYmlChanges hit but doesn't fire on its own.
  if (c.dbtRiskYmlChanges) {
    const loc = c.martLayerChange ? " under models/marts/ (mart-API surface)" : ""
    reasons.push(`schema.yml diff touches data_tests/constraints/contract${loc}`)
  }
  if (c.finopsPathToken) reasons.push("path contains FinOps keyword (cost/saving/billing/dbu/etc.)")
  return reasons
}

export interface TierResult {
  tier: RiskTier
  reasons: string[]
  perFile: FileChangeClass[]
}

const LITE_LINE_LIMIT = 100
const LITE_BLAST_LIMIT = 5

/**
 * Decide the PR-level risk tier from the classified changes.
 *
 *  TRIVIAL — docs/schema-description or seed-only edits, <=10 changed SQL lines,
 *            zero downstream. Runs grade + lint only.
 *  LITE    — SQL logic change, <=100 lines, <=5 downstream, no contract/PII/source.
 *            Adds lineage + impact.
 *  FULL    — any hard-floor reason, or >100 lines, or >5 downstream. Adds
 *            equivalence (+ optional data-diff).
 */
export function classifyPR(files: ChangedFile[], opts: ClassifyOptions = {}): TierResult {
  const perFile = files.map((f) => classifyFile(f, opts))

  // FULL: any hard-floor reason on any file.
  const fullReasons: string[] = []
  for (const c of perFile) {
    const rs = fullTierReasons(c)
    if (rs.length) fullReasons.push(`${c.path}: ${rs.join(", ")}`)
  }
  const totalSqlLines = perFile
    .filter((c) => c.kind === "model_sql" || c.kind === "python_model")
    .reduce((n, c) => n + c.changedLines, 0)
  const maxBlast = perFile.reduce((m, c) => Math.max(m, c.blastRadius), 0)

  if (fullReasons.length) return { tier: "full", reasons: fullReasons, perFile }
  if (totalSqlLines > LITE_LINE_LIMIT)
    return { tier: "full", reasons: [`${totalSqlLines} changed SQL lines (> ${LITE_LINE_LIMIT})`], perFile }

  // TRIVIAL: only schema/doc/seed edits, tiny, no downstream.
  const onlyDocs = perFile.every(
    (c) => c.kind === "schema_yml" || c.kind === "seed" || c.kind === "analysis" || c.kind === "other",
  )
  const anyComplex = perFile.some((c) => c.complex)
  if (onlyDocs && totalSqlLines <= 10 && maxBlast === 0 && !anyComplex) {
    return { tier: "trivial", reasons: ["docs/schema-only, no downstream"], perFile }
  }

  // LITE: SQL logic change within bounds.
  if (totalSqlLines <= LITE_LINE_LIMIT && maxBlast <= LITE_BLAST_LIMIT) {
    return { tier: "lite", reasons: [`${totalSqlLines} SQL lines, <=${LITE_BLAST_LIMIT} downstream`], perFile }
  }

  return { tier: "full", reasons: [`${maxBlast} downstream models`], perFile }
}

/** Which reviewer lanes fire at each tier. */
export const TIER_LANES: Record<RiskTier, string[]> = {
  trivial: ["sql_quality", "dbt_patterns"],
  lite: ["sql_quality", "lineage_breakage", "semantic_change", "test_coverage", "dbt_patterns", "ai_review"],
  full: [
    "sql_quality",
    "lineage_breakage",
    "semantic_change",
    "contract_violation",
    "pii_exposure",
    "materialization",
    "warehouse_cost",
    "test_coverage",
    "idempotency",
    "dbt_patterns",
    "ai_review",
  ],
}
