import z from "zod"
import { type Finding, type ReviewCategory, type Severity } from "./finding"

/**
 * The review rubric — rubric-as-data, NOT prompt text.
 *
 * Cloudflare's key insight is that "telling the LLM what NOT to flag is where
 * the prompt-engineering value resides." We encode both halves declaratively:
 *  - `blockOn`: categories whose `critical` findings map to a blocking verdict.
 *  - `exclusions`: the "what NOT to flag" thresholds, enforced in code so a
 *    reviewer can't talk its way past them.
 *
 * Keeping this as data (rather than baked into a prompt) makes the verdict
 * deterministic, versionable, and signable into the envelope.
 */

const Thresholds = z.object({
  /** Don't raise warehouse-cost findings on tables below this row count. */
  warehouseCostMinRows: z.number().int().nonnegative().default(1_000_000),
  /** Downstream-consumer count at/above which a lineage change is `warning`. */
  lineageWarnConsumers: z.number().int().positive().default(1),
  /** Downstream-consumer count at/above which it escalates to `critical`. */
  lineageCriticalConsumers: z.number().int().positive().default(1),
  /** Minimum letter-grade drop (e.g. B→C = 1) to flag a quality regression. */
  gradeRegressionLetters: z.number().int().positive().default(1),
})

const Exclusions = z.object({
  /** Don't flag SELECT * in staging models (acceptable convention). */
  allowSelectStarInStaging: z.boolean().default(true),
  /** Don't flag missing contracts on models that don't declare enforcement. */
  skipMissingContractWhenNotEnforced: z.boolean().default(true),
  /** Don't flag cost/quality on dev/sandbox-tagged models. */
  skipNonProdModels: z.boolean().default(true),
  /** Glob suffixes to never review (in addition to diff-filter defaults). */
  excludeGlobs: z.array(z.string()).default([]),
})

export const Rubric = z.object({
  version: z.string().default("1"),
  /** Categories where a `critical` finding forces REQUEST_CHANGES. */
  blockOn: z
    .array(z.string())
    .default([
      "lineage_breakage",
      "contract_violation",
      "pii_exposure",
      "semantic_change",
      "join_risk",
      "fanout",
      "sql_correctness",
    ]),
  /** >= this many `warning` findings is treated as a risk pattern → block. */
  warningPatternThreshold: z.number().int().positive().default(3),
  thresholds: Thresholds.default(Thresholds.parse({})),
  exclusions: Exclusions.default(Exclusions.parse({})),
})
export type Rubric = z.infer<typeof Rubric>

export const DEFAULT_RUBRIC: Rubric = Rubric.parse({})

/** Categories that block on a critical finding, as a fast lookup set. */
export function blockingCategories(rubric: Rubric): Set<string> {
  return new Set(rubric.blockOn)
}

/**
 * Apply the rubric's exclusion predicates. Returns the reason a finding should
 * be dropped, or null to keep it. Centralizing this here (vs prompt text) is
 * what keeps the false-positive rate down deterministically.
 */
export function exclusionReason(finding: Finding, rubric: Rubric): string | null {
  const ex = rubric.exclusions
  const isStaging = /(^|\/)stg_|(^|\/)staging\//.test(finding.file) || finding.model?.startsWith("stg_")
  const isDev = /(^|\/)(dev|sandbox|scratch)\//.test(finding.file)

  if (ex.skipNonProdModels && isDev) return "non-prod model (dev/sandbox/scratch)"

  if (
    ex.allowSelectStarInStaging &&
    finding.category === "warehouse_cost" &&
    isStaging &&
    /select\s*\*/i.test(finding.title + " " + finding.body)
  ) {
    return "SELECT * in staging is an accepted convention"
  }

  if (ex.excludeGlobs.length) {
    for (const g of ex.excludeGlobs) {
      const suffix = g.replace(/^\*+/, "")
      if (finding.file.endsWith(suffix)) return `excluded by glob ${g}`
    }
  }

  return null
}

/**
 * Severity floor for a category given the engine result confidence. This is the
 * load-bearing safety rule: an UNDECIDABLE equivalence/contract result can never
 * be `critical` — it downgrades to `warning`. A false auto-approve is worse than
 * a noisy warning.
 */
export function clampSeverity(
  category: ReviewCategory,
  proposed: Severity,
  confidence: Finding["confidence"],
): Severity {
  if (confidence === "unknown" && proposed === "critical") return "warning"
  if (confidence === "low" && proposed === "critical") return "warning"
  return proposed
}
