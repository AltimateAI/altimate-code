import z from "zod"
import { createHash } from "node:crypto"

/**
 * Structured findings for dbt-pr-review.
 *
 * A FindingV1 is the atomic unit a reviewer (or the deterministic recipe)
 * emits. Every blocking finding must carry `evidence` describing the
 * deterministic engine call that produced it — the coordinator drops any
 * finding the engine contradicts. The schema is versioned so the verdict
 * envelope stays replayable across releases.
 */

export const FINDING_VERSION = "v1" as const

/** Severity tiers, mirroring the Cloudflare critical/warning/suggestion model
 *  but defined in analytics-engineering terms (see rubric.ts). */
export const Severity = z.enum(["critical", "warning", "suggestion"])
export type Severity = z.infer<typeof Severity>

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 3,
  warning: 2,
  suggestion: 1,
}

/**
 * Confidence in a finding. `unknown` is a first-class state: the equivalence
 * and contract engines are undecidable in general, so an undecidable result
 * MUST surface as `unknown` and downgrade severity rather than guess. A false
 * "equivalent=true" would actively sign off on a regression, so the rubric
 * never lets `unknown` reach `critical`.
 */
export const Confidence = z.enum(["high", "medium", "low", "unknown"])
export type Confidence = z.infer<typeof Confidence>

/** The specialized reviewer lanes. Each maps to a deterministic engine call. */
export const ReviewCategory = z.enum([
  "lineage_breakage", // column/model dropped or renamed with downstream consumers
  "semantic_change", // refactor that is provably NOT equivalent
  "contract_violation", // change breaks an enforced dbt model contract
  "pii_exposure", // PII column newly exposed / masking removed
  "materialization", // risky materialization / incremental logic change
  "warehouse_cost", // SQL anti-pattern with measurable warehouse-cost impact
  "test_coverage", // missing baseline tests on new model/column
  "sql_quality", // lint / readability / best-practice (graded A–F)
  "idempotency", // non-deterministic transformation (e.g. CURRENT_TIMESTAMP)
  "freshness", // source/schedule freshness regression
  "join_risk", // LEFT→INNER collapse, cross join, missing/non-unique join key
  "fanout", // one-to-many join before aggregation → inflated metrics
  "dedup", // non-deterministic dedup / surrogate-key change
  "sql_correctness", // NOT IN NULL, COUNT vs COUNT DISTINCT, NULL handling
])
export type ReviewCategory = z.infer<typeof ReviewCategory>

/** The deterministic engine call backing a finding (the "proof"). */
export const Evidence = z.object({
  /** Dispatcher method or tool id, e.g. "altimate_core.equivalence". */
  tool: z.string(),
  /** Compact, JSON-serialisable result excerpt used to justify the finding. */
  result: z.unknown().optional(),
})
export type Evidence = z.infer<typeof Evidence>

export const Finding = z.object({
  /** Stable fingerprint — identical findings across re-reviews share this id. */
  id: z.string(),
  severity: Severity,
  category: ReviewCategory,
  /** One-line, human-readable headline. */
  title: z.string(),
  /** Markdown body with the explanation and, where possible, a concrete fix. */
  body: z.string(),
  /** Repo-relative path the finding applies to. */
  file: z.string(),
  /** 1-based inclusive line range within the file's diff hunk (for inline posting). */
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  /** dbt model the finding concerns, when applicable. */
  model: z.string().optional(),
  /** Column the finding concerns, when applicable. */
  column: z.string().optional(),
  confidence: Confidence.default("high"),
  /** True when produced without a manifest/warehouse (lint-only degraded run). */
  degraded: z.boolean().default(false),
  evidence: Evidence.optional(),
})
export type Finding = z.infer<typeof Finding>

/** Fields that define finding identity for fingerprinting / dedup. */
export interface FingerprintInput {
  category: ReviewCategory | string
  file: string
  model?: string
  column?: string
  /** A normalized rule/title key — NOT the free-text body, so wording tweaks
   *  don't change identity across re-reviews. */
  ruleKey: string
}

/**
 * Compute a stable fingerprint for a finding. Deliberately excludes line
 * numbers and free-text body so a finding survives line drift and re-phrasing
 * across pushes — that stability is what makes incremental re-review (auto
 * resolve fixed, re-emit unfixed) correct.
 */
export function fingerprint(input: FingerprintInput): string {
  const canonical = [input.category, input.file, input.model ?? "", input.column ?? "", input.ruleKey]
    .map((s) => String(s).trim().toLowerCase())
    .join(" ")
  return "f_" + createHash("sha256").update(canonical).digest("hex").slice(0, 16)
}

/** Build a finding, auto-assigning the fingerprint id when not supplied. */
export function makeFinding(input: Omit<z.input<typeof Finding>, "id"> & { id?: string; ruleKey?: string }): Finding {
  const id =
    input.id ??
    fingerprint({
      category: input.category,
      file: input.file,
      model: input.model,
      column: input.column,
      ruleKey: input.ruleKey ?? input.title,
    })
  return Finding.parse({ ...input, id })
}

/** Serialize findings as JSONL (one finding per line). */
export function toJsonl(findings: Finding[]): string {
  return findings.map((f) => JSON.stringify(f)).join("\n")
}

/**
 * Parse JSONL findings emitted by a reviewer session. Tolerant: malformed or
 * non-finding lines are skipped (and counted) rather than aborting the whole
 * review — a single bad line from the model must not sink a verdict.
 */
export function parseJsonl(text: string): { findings: Finding[]; skipped: number } {
  const findings: Finding[] = []
  let skipped = 0
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("//") || line.startsWith("#")) continue
    try {
      const obj = JSON.parse(line)
      const parsed = Finding.safeParse(obj)
      if (parsed.success) findings.push(parsed.data)
      else skipped++
    } catch {
      skipped++
    }
  }
  return { findings, skipped }
}

/** Stable ordering key so dedupe ties resolve identically regardless of the
 *  order findings arrive in (lanes run concurrently). */
function tieKey(f: Finding): string {
  return `${f.startLine ?? Number.MAX_SAFE_INTEGER} ${f.title} ${f.body}`
}

/** Deduplicate findings by fingerprint, keeping the highest-severity instance.
 *  On equal severity a deterministic tie-break keeps output stable across runs. */
export function dedupe(findings: Finding[]): Finding[] {
  const byId = new Map<string, Finding>()
  for (const f of findings) {
    const existing = byId.get(f.id)
    if (!existing) {
      byId.set(f.id, f)
      continue
    }
    const bySev = SEVERITY_ORDER[f.severity] - SEVERITY_ORDER[existing.severity]
    if (bySev > 0 || (bySev === 0 && tieKey(f) < tieKey(existing))) {
      byId.set(f.id, f)
    }
  }
  return [...byId.values()]
}
