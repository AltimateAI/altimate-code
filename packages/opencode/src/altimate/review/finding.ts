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
  /** Which layer produced it: the deterministic engine, the regex/pattern
   *  catalog, or the advisory AI lane. Only `engine` findings decide the
   *  verdict unless the rubric opts a named catalog rule in. Stamped by
   *  buildEnvelope from `evidence.tool`. */
  origin: z.enum(["engine", "catalog", "ai"]).optional(),
  /** Stable rule id, `tool:rule`, normalised by `ruleId`. Keys the per-rule
   *  posting policy; not part of the fingerprint. */
  rule: z.string().optional(),
  /** True when the finding sits on a line the PR did not add. */
  preExisting: z.boolean().optional(),
  /** True when the line stands in for code the PR removed (the head-side site
   *  of a deletion): the finding concerns the PR's own change, so a context
   *  line does not make it pre-existing. */
  deletionSite: z.boolean().optional(),
  /** Where the finding is posted: inline on the diff, or in the summary only. */
  tier: z.enum(["inline", "summary"]).optional(),
  /** Id of the finding whose comment covers this one (the same team convention broken the
   *  same way on another file; see `groupConventionFindings`). Kept in the envelope with its
   *  own line; the renderer shows it through that comment while it is posted in this run. */
  groupedInto: z.string().optional(),
  /** The source line the finding points at, quoted as evidence. */
  evidenceLine: z.string().max(200).optional(),
  /** A replacement for a line range, rendered as a suggestion block. */
  suggestion: z
    .object({
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive(),
      replacement: z.string().max(2000),
    })
    .optional(),
})
export type Finding = z.infer<typeof Finding>

export type FindingOrigin = NonNullable<Finding["origin"]>

/** Evidence tools backed by the deterministic engine (AST, manifest, lineage,
 *  warehouse) rather than text patterns. */
const ENGINE_TOOLS = new Set(["impact_analysis", "dbt.manifest", "data.diff", "schema.detect_pii"])

/** The layer a finding came from, always derived from `evidence.tool`: a
 *  supplied `origin` is ignored, so an externally built finding cannot claim
 *  to be engine-backed. Unknown or missing evidence counts as `catalog`, so a
 *  new detector can never block until it is classified. */
export function findingOrigin(f: Pick<Finding, "evidence" | "origin">): FindingOrigin {
  const tool = f.evidence?.tool ?? ""
  if (tool === "ai-review") return "ai"
  if (tool.startsWith("altimate_core.") || ENGINE_TOOLS.has(tool)) return "engine"
  return "catalog"
}

/** A rule id in one spelling: catalog sources use `hardcoded-credential` and
 *  `pii_into_mart` alike, so ids compare lowercased with `_` as `-`. */
export function normalizeRuleId(id: string): string {
  return id.trim().toLowerCase().replace(/_/g, "-")
}

/** Whether the AI verifier moved a finding to the summary (it is then never posted inline). */
export function verifierDemoted(f: Pick<Finding, "evidence">): boolean {
  return (f.evidence?.result as { verification?: { decision?: unknown } } | undefined)?.verification?.decision === "summary"
}

/** The catalog rule id behind a finding (`evidence.result.rule`), if any. */
export function catalogRuleId(f: Pick<Finding, "evidence">): string | undefined {
  const rule = (f.evidence?.result as { rule?: unknown } | undefined)?.rule
  return typeof rule === "string" ? rule : undefined
}

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

/** Normalise one half of a rule id: lowercase, `_` to `-`, any other run of
 *  characters outside `[a-z0-9.-]` to a single `-`, no leading/trailing `-`. */
export function normRuleToken(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/** The stable `tool:rule` id used to key per-rule posting policy. */
export function ruleId(tool: string, rule: string): string {
  return `${normRuleToken(tool)}:${normRuleToken(rule)}`
}

/** Build a finding, auto-assigning the fingerprint id when not supplied. The
 *  `rule` id is derived from the evidence when not supplied; it never feeds the
 *  fingerprint, so ids stay stable across the change. */
export function makeFinding(input: Omit<z.input<typeof Finding>, "id"> & { id?: string; ruleKey?: string }): Finding {
  const result = input.evidence?.result as { rule?: unknown; code?: unknown } | undefined
  const rule =
    input.rule ??
    (input.evidence?.tool
      ? ruleId(input.evidence.tool, String(result?.rule ?? result?.code ?? groupKeyTitle(input)))
      : undefined)
  const id =
    input.id ??
    fingerprint({
      category: input.category,
      file: input.file,
      model: input.model,
      column: input.column,
      ruleKey: input.ruleKey ?? input.title,
    })
  return Finding.parse({ ...input, id, rule })
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

/** Backticked names blanked, so the same rule on different models/columns
 *  normalizes to the same text. */
export function blankNames(s: string): string {
  return s.replace(/`[^`]*`/g, "`…`")
}

/** A finding's title without its leading `<model or file>: ` or a merged
 *  `(+N more)` suffix, with backticked names blanked: the title half of a
 *  grouping key, so the same rule on different models/columns shares it. */
export function groupKeyTitle(f: Pick<Finding, "title">): string {
  return blankNames(f.title.replace(/^[\w.\-/]+: /, "").replace(/ \(\+\d+ more\)$/, ""))
}

/** One merged instance: its title, or its message when the title is the same as
 *  the first's (lint titles carry only the rule name), plus its line. */
function repeatLabel(f: Finding, first: Finding): string {
  const label = f.title === first.title ? (f.body.split("\n")[0] ?? "") : f.title.replace(/^[\w.\-/]+: /, "")
  return f.startLine ? `${label} (line ${f.startLine})` : label
}

/**
 * Merge repeats of one rule within one file (one finding per column of a grain
 * test, one per join onto the same kind of key) into a single finding that
 * lists every instance. Critical findings stay separate: each one can block.
 */
export function mergeRepeats(findings: Finding[]): Finding[] {
  const groups = new Map<string, Finding[]>()
  const out: Finding[] = []
  for (const f of findings) {
    if (f.severity === "critical") {
      out.push(f)
      continue
    }
    const key = [f.file, f.category, f.severity, !!f.degraded, !!f.preExisting, groupKeyTitle(f)].join("|")
    const g = groups.get(key)
    if (g) g.push(f)
    else groups.set(key, [f])
  }
  for (const [key, g] of groups) {
    if (g.length === 1) {
      out.push(g[0])
      continue
    }
    g.sort((a, b) => tieKey(a).localeCompare(tieKey(b)))
    const [first, ...rest] = g
    out.push({
      ...first,
      // Keyed by the group, not by its first instance: fixing that instance must not re-post the comment.
      id: "f_" + createHash("sha256").update(`merged ${key}`).digest("hex").slice(0, 16),
      title: `${first.title} (+${rest.length} more)`,
      body: `${first.body}\n\nSame rule, also here:\n${rest.map((f) => `- ${repeatLabel(f, first)}`).join("\n")}`,
    })
  }
  return out
}
