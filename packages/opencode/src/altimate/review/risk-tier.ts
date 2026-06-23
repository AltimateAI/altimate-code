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
