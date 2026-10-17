import path from "node:path"
import {
  type Finding,
  type ReviewCategory,
  type Severity,
  ReviewCategory as ReviewCategoryEnum,
  makeFinding,
  dedupe,
  SEVERITY_ORDER,
} from "./finding"
import { type ChangedFile, filterChangedFiles } from "./diff-filter"
import { classifyPR, compilePathTokenResolver, TIER_LANES } from "./risk-tier"
import { type Rubric, exclusionReason, clampSeverity } from "./rubric"
import { type ReviewConfig } from "./config"
import { type ReviewMode, type ReviewScope, type VerdictEnvelope, buildEnvelope, signEnvelope } from "./verdict"
import { detectModelPatterns, detectSchemaYmlPatterns, splitDiff } from "./dbt-patterns"
import { type AiReviewInput } from "./ai-review"

/**
 * The deterministic review recipe.
 *
 * The LLM (when present) is a coordinator that turns engine output into prose —
 * but the findings and the verdict are produced HERE, mechanically, from
 * deterministic engine calls behind the `ReviewRunner` interface. That is the
 * defensible core: a generic reviewer guesses; this proves.
 *
 * `ReviewRunner` is intentionally high-level so the orchestrator is pure and
 * unit-testable. Production backs it with the native Dispatcher (see
 * tools/dbt-pr-review.ts); tests pass a fake.
 */

/**
 * Maps a regex-layer check code → a matcher for the equivalent core AST rule.
 * A regex twin is dropped ONLY when core lint ACTUALLY emitted the matching
 * finding for that file — not merely because core ran. This is the safe form:
 * if core's AST rule misses a specific instance (e.g. `= null` it doesn't flag),
 * the regex finding survives instead of falling through the crack.
 */
const CORE_AST_COVERED: Record<string, RegExp> = {
  "select-star": /select.?star|l001/,
  "cross-join": /cartesian|cross.?join/,
  "comma-join": /cartesian|cross.?join/,
  "constant-join": /cartesian|cross.?join|join.?without.?cond|l052/,
  "not-in-nullable": /not.?in|nullable/,
  "window-no-partition": /window.*partition/,
  "equals-null": /null.?comparison/,
  "leading-wildcard": /leading.?wildcard|like.?wildcard/,
  "division-no-guard": /division|divide/,
  "left-to-inner": /outer.?join|left.?to.?inner|l043/,
  "null-concat": /null.?propagat|null.?concat|l044/,
  "greatest-least-null": /greatest|least|l045/,
  "distinct-with-window": /distinct.?with.?window|l046/,
  "cast-float-to-int": /cast.?division|cast.?float|l048/,
  "now-in-filter": /clock.?in.?filter|l049/,
  "join-on-cast": /cast.?in.?join|join-on-cast|l050/,
  "full-outer-join": /full.?outer|l051/,
  "join-no-on": /join.?without.?cond|l052/,
  "in-with-null": /null.?in.?in.?list|l053/,
  "sum-of-ratio": /sum.?of.?ratio|l054/,
  "timezone-naive-now": /clock.?in.?filter|l049/,
}

/**
 * Extract function names a finding references in call form `NAME(` or backticked
 * `NAME`, lowercased — used to reconcile the regex portability catalog against
 * core's AST L033 (NonPortableFunction). Advice functions (coalesce, etc.) are
 * harmless: core never flags ANSI functions, so they can't cause suppression.
 */
function fnTokensOf(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/`([A-Za-z_][A-Za-z0-9_.]*)`|\b([A-Za-z_][A-Za-z0-9_.]+)\s*\(/g)) {
    out.push((m[1] ?? m[2]).toLowerCase())
  }
  return out
}

/** Impact-analysis result, normalized. */
export interface ImpactResult {
  hasManifest: boolean
  /** SAFE | LOW | MEDIUM | HIGH | BREAKING (from the DAG walk). */
  severity: "SAFE" | "LOW" | "MEDIUM" | "HIGH" | "BREAKING" | "UNKNOWN"
  directCount: number
  transitiveCount: number
  testCount: number
}

/** Equivalence result, normalized with a first-class undecidable state. */
export interface EquivalenceResult {
  /** False when the engine could not decide (no schema / undecidable). */
  decided: boolean
  equivalent?: boolean
  differences?: string[]
  confidence?: "high" | "medium" | "low"
}

export interface GradeResult {
  grade?: string // A–F
  issues?: Array<{ rule: string; message: string; line?: number; severity?: string }>
}

export interface CheckResult {
  issues?: Array<{ rule: string; message: string; line?: number; severity?: string; category?: string }>
  piiColumns?: string[]
  /**
   * True when the native core lint actually ran (parsed the SQL via the AST),
   * even if it found zero issues. Distinguishes "clean SQL" from "core
   * unavailable / degraded". When true, the orchestrator defers structural SQL
   * checks to the AST lint and suppresses the fragile regex twins.
   */
  ran?: boolean
}

/** High-level engine surface the orchestrator depends on. */
export interface ReviewRunner {
  /** True when the configured dbt manifest loaded, independent of model lookup. */
  manifestAvailable?(): Promise<boolean>
  impact(model: string): Promise<ImpactResult>
  grade(sql: string, dialect: string): Promise<GradeResult>
  check(sql: string, dialect: string, baseSql?: string): Promise<CheckResult>
  equivalence(oldSql: string, newSql: string, dialect?: string): Promise<EquivalenceResult>
  detectPii(sql: string, dialect: string): Promise<{ columns: string[] }>
  /**
   * Lexical scan (reserved-word aliases + dialect operators) — the curated lists
   * and detection live in the compiled core; this passes raw added diff lines.
   * Optional so the orchestrator stays unit-testable with a fake runner.
   */
  lexicalScan?(addedLines: string[]): Promise<Array<{ rule: string; severity?: string; message: string; line?: string }>>
  /** Direct downstream models (name + file path) of a model, from the manifest DAG. */
  downstreamModels?(model: string): Promise<Array<{ name: string; path: string }>>
  /** Column-lineage edges for a query: source `"table"."col"` → target output column. */
  columnLineage?(sql: string, dialect: string): Promise<Array<{ source: string; target: string }>>
  /** Classify a set of column names as PII (Email/SSN/…) with confidence + masking. */
  classifyPii?(
    columns: string[],
  ): Promise<Array<{ column: string; classification: string; confidence: number; masking?: string }>>
  /** Structural complexity (window/subquery/large plan) from core `metadata` — a tiering signal. */
  isComplex?(sql: string): Promise<boolean>
  /** Extract a model's grain key (final GROUP BY + dedup PARTITION BY) from its SQL. */
  grain?(sql: string): Promise<{ group_by: string[]; dedup_partition: string[] }>
  /** Declared primary/unique key of a model, from contract or unique test (manifest). */
  declaredPrimaryKey?(model: string): Promise<string[] | undefined>
  /** Per-upstream WHERE-filter columns of a model's SQL (cross-model consistency). */
  sourceFilters?(sql: string): Promise<Record<string, string[]>>
  /** dbt config/Jinja lint over RAW model SQL (parses `{{ config() }}` in core). */
  dbtConfigLint?(
    rawSql: string,
    oldRawSql?: string,
  ): Promise<Array<{ code: string; rule: string; severity?: string; message: string; suggestion?: string }>>
  /** AST base-vs-head structural diff — the `*_change` rules (parses both versions in core). */
  structuralDiff?(
    baseSql: string,
    headSql: string,
  ): Promise<Array<{ code: string; rule: string; severity?: string; message: string; suggestion?: string }>>
  /**
   * Run a base-vs-head DATA diff (core DataParity over a warehouse connection):
   * actual row/value deltas. Returns null when no warehouse/driver is available
   * (the lane then skips — data-diff is a CI capability, not always present).
   */
  dataDiff?(
    baseSql: string,
    headSql: string,
    keyColumns: string[],
    /** Warehouse connection name to diff against; omit for the default. */
    warehouse?: string,
  ): Promise<{ rowsOnlyInBase?: number; rowsOnlyInHead?: number; rowsChanged?: number; summary?: string } | null>
  // altimate_change start — dbt impact past the dbt graph (analyzeDbtImpact)
  /**
   * Per-hop blast radius of one change — dbt models, loaders and served
   * tables, each with a verdict. Returns null when the core build lacks the
   * binding (the lanes then keep their dbt-graph-only behaviour).
   */
  dbtImpact?(change: { model: string; column?: string; kind: string }): Promise<ExternalImpactEntry[] | null>
  /**
   * Schema-lag findings for a base → head SQL change: readers that production
   * can run against a relation that does not have the new column yet. Null
   * when the core build lacks the binding.
   */
  schemaLag?(change: { model: string; kind: "sql"; base_sql: string; head_sql: string }): Promise<SchemaLagResult | null>
  // altimate_change end
}

// altimate_change start — schema_lag lane
export interface SchemaLagResult {
  findings: Array<{
    reason: string
    verdict: string
    consumer: string
    column: string
    producer: string
    consumer_jobs?: string[]
    producer_jobs?: string[]
    window?: string
    message: string
    fix: string
  }>
  skipped: string[]
}
// altimate_change end

// altimate_change start — impact evidence past the dbt graph
export interface ExternalImpactEntry {
  hop: number
  node_type: string
  name: string
  verdict: string
  reason?: string
}

/** BREAKING consumers outside dbt (a loader or a served table): the only
 *  evidence that lets a MODIFIED model's lineage finding reach `critical`. */
interface ExternalBreakEvidence {
  breaks: Array<ExternalImpactEntry & { column?: string }>
}

function externalBreaks(entries: ExternalImpactEntry[], column?: string): ExternalBreakEvidence["breaks"] {
  return entries
    .filter((e) => e.verdict.toLowerCase() === "breaking" && !/^(model|dbt_)/i.test(e.node_type))
    .map((e) => ({ ...e, column }))
}

function describeBreaks(b: ExternalBreakEvidence["breaks"]): string {
  return b
    .map((e) => `${e.node_type} \`${e.name}\`${e.column ? ` (column \`${e.column}\`)` : ""}${e.reason ? ` — ${e.reason}` : ""}`)
    .join("; ")
}
// altimate_change end

export interface OrchestrateInput {
  changedFiles: ChangedFile[]
  config: ReviewConfig
  rubric: Rubric
  mode: ReviewMode
  runner: ReviewRunner
  /** Resolve RAW model contents (Jinja) from the working tree / git refs. */
  getContent?: (file: string, side: "old" | "new") => Promise<string | undefined>
  /** Resolve dbt-COMPILED SQL (rendered) for the engine lanes; undefined when
   *  no compiled artifact exists. The dbt-patterns lane always uses raw. */
  getCompiled?: (file: string, side: "old" | "new") => Promise<string | undefined>
  generatedAt?: string
  manifestHash?: string
  coreVersion?: string
  modelVersion?: string
  /** altimate-code CLI release recorded in engine.cliVersion for audit reconstruction. */
  cliVersion?: string
  /**
   * Optional LLM reviewer lane. Injected (not imported) so the orchestrator
   * stays pure/unit-testable: production wires `runAiReview` (harness LLM);
   * tests pass a fake or omit it (the lane is then skipped). Receives the
   * deterministic findings as grounding and returns ADVISORY findings only.
   */
  aiReview?: (input: AiReviewInput) => Promise<Finding[]>
  /** PR metadata passed to the AI reviewer for intent checking. */
  prTitle?: string
  prBody?: string
  /** G1 — attach the classifier's reason list to the envelope. */
  explainTier?: boolean
  /** G2 — override the classifier's tier decision. Envelope carries tierForced:true. */
  forceTier?: "trivial" | "lite" | "full"
  /** Manifest was stale relative to change-affecting files (see run.ts::detectStaleManifest). */
  staleManifest?: boolean
  /** `diff` (default) reviews base..head; `project` reviews every model in the
   *  manifest with no base version. See {@link ReviewScope}. */
  scope?: ReviewScope
}

/** Which lanes ran and which could not, with the reason. Emitted on the
 *  envelope in `project` scope; `diff` scope leaves it undefined (every lane
 *  the tier enables runs there, so the list would be noise). */
export interface LaneReport {
  ran: string[]
  skipped: Array<{ lane: string; reason: string }>
  /** How many of `totalModels` the engine lanes saw as dbt-COMPILED SQL.
   *  The SQL parser cannot parse Jinja: on a model that falls back to raw
   *  `{{ config() }}` source the parse fails at line 1, every AST rule inside
   *  the engine is skipped, and the lane returns ZERO findings — which reads
   *  exactly like a clean model. Over a whole project that silence is the
   *  difference between a review and a rubber stamp, so the counts are
   *  reported and `renderSummary` warns when they diverge. */
  compiledModels: number
  totalModels: number
}

/**
 * Lanes that compare a model's BASE version to its HEAD version. In project
 * scope there is exactly one version of each model, so none of them has an
 * input — they are reported as skipped, never silently dropped.
 */
const PROJECT_SCOPE_SKIPS: Record<string, string> = {
  lineage_breakage:
    "reports deleted/renamed models and the blast radius of a change — both are defined relative to a base ref",
  column_breakage: "diffs a model's output columns between its base and head versions",
  semantic_change: "proves base-vs-head row equivalence; in project scope there is no base version",
  structural_diff: "compares the base and head parse trees (the `*_change` rules)",
  dbt_config_diff: "compares the base and head `{{ config() }}` blocks (materialization / incremental changes)",
  data_diff: "runs the base and head SQL against the warehouse and diffs the resulting rows",
  topology_equivalence: "pairs models deleted in a diff against models added in the same diff (merge refactors)",
  schema_yml_test_removal: "detects `unique` / `not_null` / `relationships` tests REMOVED between two schema.yml versions",
  ai_review:
    "the advisory LLM lane is grounded in the diff and caps at 20 files — project-wide it would review an arbitrary subset at unbounded cost; run `altimate review` on a diff for it",
  schema_lag: "compares a model's base and head output / source columns to find readers that run before the producer is rebuilt",
  "dbt_patterns:fanout_join":
    "fires when a join is ADDED to an aggregating model; with the whole model presented as added it degenerates to \"this model aggregates and has a join\", which describes most correct analytics SQL",
}

/**
 * Present a whole model to the diff-anchored detectors as if every line were
 * added. The dbt-patterns detectors and the declarative rule catalog are
 * relevance-gated on the diff by construction (`ruleMatches` requires the
 * signal to appear in added/removed lines), so without this they evaluate to
 * nothing in project scope and the report would be a quiet lie.
 */
function wholeFileAsAddedDiff(sql: string): string {
  return sql
    .split("\n")
    .map((l) => "+" + l)
    .join("\n")
}

/** Derive the dbt model name from a model file path. */
export function modelNameFromPath(p: string): string {
  return path.basename(p).replace(/\.(sql|py)$/i, "")
}

const VALID_CATEGORIES = new Set<string>(ReviewCategoryEnum.options)

/**
 * Map a raw engine-issue category to a ReviewCategory WITHOUT discarding it.
 * Preserving the engine's category is what keeps the rubric's blockers (e.g.
 * contract_violation) effective — coercing everything to sql_quality would
 * silently neuter them.
 */
function mapCheckCategory(raw?: unknown): ReviewCategory {
  if (typeof raw !== "string" || !raw) return "sql_quality"
  const norm = raw.toLowerCase()
  if (VALID_CATEGORIES.has(norm)) return norm as ReviewCategory
  if (/contract/.test(norm)) return "contract_violation"
  if (/idempoten/.test(norm)) return "idempotency"
  if (/\btest\b|coverage/.test(norm)) return "test_coverage"
  if (/pii|sensitive/.test(norm)) return "pii_exposure"
  if (/cost|perf|scan|spill|prune/.test(norm)) return "warehouse_cost"
  if (/freshness|stale/.test(norm)) return "freshness"
  return "sql_quality"
}

/** Map an impact severity bucket to a finding severity. */
function impactToSeverity(impact: ImpactResult): Severity | null {
  switch (impact.severity) {
    case "BREAKING":
    case "HIGH":
      return "critical"
    case "MEDIUM":
      return "warning"
    case "LOW":
      return "suggestion"
    default:
      return null // SAFE / UNKNOWN → no standalone finding
  }
}

function lineageBreakageLane(
  file: ChangedFile & { kind: string },
  impact: ImpactResult,
  rubric: Rubric,
  // altimate_change start — loader/served-table evidence from analyzeDbtImpact
  external?: ExternalBreakEvidence,
  // altimate_change end
): Finding[] {
  const model = modelNameFromPath(file.path)
  const total = impact.directCount + impact.transitiveCount
  const degraded = !impact.hasManifest

  // dbt resolves `ref()` by MODEL NAME, not file path — so a rename that keeps
  // the same model name (a pure directory move) does NOT break lineage. Only a
  // rename that changes the model name is a break, alongside a deletion.
  const modelNameChanged =
    file.status === "renamed" && !!file.oldPath && modelNameFromPath(file.oldPath) !== model
  const isBreakingRemoval = file.status === "deleted" || modelNameChanged

  // Deleted/renamed model with downstream consumers is the canonical break.
  if (isBreakingRemoval && total >= rubric.thresholds.lineageWarnConsumers) {
    const sev = clampSeverity(
      "lineage_breakage",
      total >= rubric.thresholds.lineageCriticalConsumers ? "critical" : "warning",
      degraded ? "unknown" : "high",
    )
    return [
      makeFinding({
        severity: sev,
        category: "lineage_breakage",
        title: `Model ${model} ${file.status} — ${total} downstream consumer${total !== 1 ? "s" : ""}`,
        body:
          `\`${model}\` is ${file.status} but ${total} downstream model${total !== 1 ? "s" : ""}` +
          ` (+${impact.testCount} test${impact.testCount !== 1 ? "s" : ""}) still depend on it.` +
          // altimate_change start — consumers outside dbt, when analyzeDbtImpact named them
          (external?.breaks.length ? ` Outside dbt it also breaks: ${describeBreaks(external.breaks)}.` : "") +
          // altimate_change end
          (degraded ? "\n\n_No manifest available — verify the blast radius locally._" : ""),
        file: file.path,
        model,
        confidence: degraded ? "unknown" : "high",
        degraded,
        evidence: { tool: "impact_analysis", result: impact },
        ruleKey: `lineage_breakage:${file.status}`,
      }),
    ]
  }

  // altimate_change start — a modified model whose change BREAKS a loader or a
  // served table (analyzeDbtImpact, column-level) is a real break, not fan-out.
  if (external?.breaks.length) {
    return [
      makeFinding({
        severity: clampSeverity("lineage_breakage", "critical", degraded ? "unknown" : "high"),
        category: "lineage_breakage",
        title: `${model}: change breaks consumers outside dbt`,
        body:
          `This change to \`${model}\` breaks ${external.breaks.length} consumer(s) the dbt graph does not show: ` +
          `${describeBreaks(external.breaks)}. Keep the column(s) or update those consumers in the same release.`,
        file: file.path,
        model,
        confidence: degraded ? "unknown" : "high",
        degraded,
        evidence: { tool: "altimate_core.dbt_impact", result: { impact, external: external.breaks } },
        ruleKey: "lineage_breakage:external-sink",
      }),
    ]
  }
  // altimate_change end
  const sev = impactToSeverity(impact)
  if (!sev) return []
  // For a MODIFIED model, blast radius alone is NOT a breaking change — a wide
  // fan-out doesn't mean the edit broke anything (it may be additive/safe). Cap
  // modified-model lineage impact at `warning` so merely touching a popular model
  // never blocks. Delete/rename (handled above) and a loader/served-table break
  // proven by analyzeDbtImpact (also above) are the genuine breaks.
  const capped: Severity = sev === "critical" ? "warning" : sev
  const clamped = clampSeverity("lineage_breakage", capped, degraded ? "unknown" : "high")
  return [
    makeFinding({
      severity: clamped,
      category: "lineage_breakage",
      title: `${model}: high downstream fan-out (${total} model${total !== 1 ? "s" : ""})`,
      body:
        `\`${model}\` has ${impact.directCount} direct and ${impact.transitiveCount} transitive` +
        ` downstream models (+${impact.testCount} tests). Blast radius is informational — verify the` +
        ` change is backward-compatible (no removed/renamed columns) for these consumers.` +
        (degraded ? "\n\n_Lint-only: no manifest, blast radius unverified._" : ""),
      file: file.path,
      model,
      confidence: degraded ? "unknown" : "high",
      degraded,
      evidence: { tool: "impact_analysis", result: impact },
      ruleKey: "lineage_breakage:impact",
    }),
  ]
}

async function semanticChangeLane(
  file: ChangedFile & { kind: string },
  runner: ReviewRunner,
  oldSql: string | undefined,
  newSql: string | undefined,
  dialect: string,
  impact: ImpactResult,
  rubric: Rubric,
): Promise<Finding[]> {
  if (file.status !== "modified") return []
  if (!oldSql || !newSql || oldSql.trim() === newSql.trim()) return []
  const model = modelNameFromPath(file.path)
  const eq = await runner.equivalence(oldSql, newSql, dialect)

  // Provably equivalent: stay silent — never nitpick what's proven safe. The core
  // engine models set-vs-multiset semantics (UNION vs UNION ALL, SELECT DISTINCT),
  // so equivalent:true is trustworthy for row multiplicity.
  if (eq.decided && eq.equivalent) return []

  if (!eq.decided) {
    // Undecidable / no schema → WARNING with unknown confidence, never block.
    return [
      makeFinding({
        severity: clampSeverity("semantic_change", "critical", "unknown"),
        category: "semantic_change",
        title: `${model}: refactor could not be proven equivalent`,
        body:
          `The logic of \`${model}\` changed and equivalence could not be decided` +
          ` (no schema, or unsupported SQL). Treat as a potential behavior change and verify with a data-diff.`,
        file: file.path,
        model,
        confidence: "unknown",
        degraded: true,
        evidence: { tool: "altimate_core.equivalence", result: { decided: false } },
        ruleKey: "semantic_change:undecidable",
      }),
    ]
  }

  // Decided NOT equivalent. THE FUSION: a proven behavior change to a model with
  // downstream consumers is a genuine break → critical (clamped by confidence, so
  // only high/medium can block). No downstream → warning. This is what makes
  // `semantic_change` ∈ blockOn meaningful: "provably not equivalent + N
  // downstream → BLOCK".
  const total = impact.directCount + impact.transitiveCount
  const baseSev: Severity = total >= rubric.thresholds.lineageCriticalConsumers ? "critical" : "warning"
  const diffs = (eq.differences ?? []).slice(0, 8)
  return [
    makeFinding({
      severity: clampSeverity("semantic_change", baseSev, eq.confidence ?? "medium"),
      category: "semantic_change",
      title:
        total > 0
          ? `${model}: rewrite is NOT row-equivalent — ${total} downstream consumer${total !== 1 ? "s" : ""} affected`
          : `${model}: rewrite is NOT row-equivalent`,
      body:
        `\`${model}\` is described as a refactor but produces different results:\n` +
        (diffs.length ? diffs.map((d) => `- ${d}`).join("\n") : "- output differs") +
        `\n\nConfidence: ${eq.confidence ?? "medium"}.`,
      file: file.path,
      model,
      confidence: eq.confidence ?? "medium",
      evidence: { tool: "altimate_core.equivalence", result: { equivalent: false, differences: diffs } },
      ruleKey: "semantic_change:not-equivalent",
    }),
  ]
}

async function qualityLane(
  file: ChangedFile & { kind: string },
  runner: ReviewRunner,
  sql: string | undefined,
  dialect: string,
  oldSql?: string,
): Promise<Finding[]> {
  if (!sql || file.status === "deleted") return []
  const model = modelNameFromPath(file.path)
  const isStaging = /(^|\/)stg_|(^|\/)staging\//.test(file.path) || model.startsWith("stg_")
  const findings: Finding[] = []

  // Diff-scoping (surface only findings the PR INTRODUCED, not pre-existing
  // issues in the changed file) is done IN CORE: we pass the base compiled SQL
  // and core returns only the findings new relative to it. The structural /
  // parsing comparison lives in the AST engine, not this plumbing layer.
  const check = await runner.check(sql, dialect, oldSql)
  for (const issue of check.issues ?? []) {
    // dbt-context tuning of the generic core lint ("what NOT to flag"):
    // dbt models are SELECT definitions, not standalone queries — a missing
    // LIMIT is correct, not a smell; and `select *` from a source is the
    // idiomatic staging pattern. Suppress those in the dbt context.
    const rule = String(issue.rule ?? "").toLowerCase()
    if (rule === "select-without-limit") continue
    if (isStaging && (rule === "select-star" || rule === "select_star")) continue
    // OLTP/index-oriented rules that don't apply to columnar analytics warehouses
    // (and false-fire on idiomatic dbt SQL like a correlated NOT EXISTS):
    if (rule === "correlated-subquery" || rule === "correlated_subquery") continue
    if (rule === "function-on-filter-column" || rule === "function-on-join-column") continue
    const cat = mapCheckCategory(issue.category)
    const isError = issue.severity === "error"
    // Error-severity contract/PII issues are blockable; others are warning/suggestion.
    let sev: Severity = isError ? "warning" : "suggestion"
    if (isError && (cat === "contract_violation" || cat === "pii_exposure")) sev = "critical"
    sev = clampSeverity(cat, sev, "high")
    findings.push(
      makeFinding({
        severity: sev,
        category: cat,
        title: `${model}: ${issue.rule}`,
        body: issue.message,
        file: file.path,
        model,
        startLine: issue.line,
        endLine: issue.line,
        evidence: { tool: "altimate_core.check", result: issue },
        // Include the message so distinct instances of the same rule (e.g. two
        // different non-portable functions) don't collapse under one fingerprint.
        ruleKey: `quality:${issue.rule}:${(issue.message ?? "").slice(0, 60)}`,
      }),
    )
  }
  return findings
}

/**
 * Lexical lane — reserved-word aliases + dialect operators, detected by the
 * compiled core's `review_lexical_scan` over the raw ADDED diff lines (these
 * are pre-parse lexical checks; the curated lists live in the binary). Advisory.
 */
async function lexicalLane(file: ChangedFile & { kind: string }, runner: ReviewRunner): Promise<Finding[]> {
  if (!runner.lexicalScan || file.status === "deleted") return []
  const added = splitDiff(file.diff).added
  if (!added.length) return []
  const model = modelNameFromPath(file.path)
  const raw = await runner.lexicalScan(added)
  return raw.map((f) =>
    makeFinding({
      severity: "suggestion",
      category: "sql_quality",
      title: `${model}: ${f.message.slice(0, 70)}`,
      body: f.message,
      file: file.path,
      model,
      confidence: "medium",
      evidence: { tool: "altimate_core.lexical", result: { rule: f.rule } },
      ruleKey: `lexical:${f.rule}`,
    }),
  )
}

/** Parse a column-lineage source `"db"."schema"."table"."col"` → { table, col }. */
function parseLineageSource(src: string): { table: string; col: string } {
  const parts = src.replace(/"/g, "").split(".").filter(Boolean)
  return { col: (parts.at(-1) ?? "").toLowerCase(), table: (parts.at(-2) ?? "").toLowerCase() }
}

// altimate_change start — analyzeDbtImpact evidence, memoized per model file
const columnEvidenceMemo = new WeakMap<ModelContext, Promise<ExternalBreakEvidence>>()

/** Loader/served-table breaks caused by dropping `removed` columns of the
 *  model. Empty when the runner has no dbtImpact (or the core lacks it). */
function columnImpactEvidence(ctx: ModelContext, runner: ReviewRunner, removed: string[]): Promise<ExternalBreakEvidence> {
  const cached = columnEvidenceMemo.get(ctx)
  if (cached) return cached
  const p = (async (): Promise<ExternalBreakEvidence> => {
    if (!runner.dbtImpact || !removed.length) return { breaks: [] }
    const model = modelNameFromPath(ctx.file.path)
    const breaks: ExternalBreakEvidence["breaks"] = []
    for (const column of removed) {
      const entries = await runner.dbtImpact({ model, column, kind: "drop" }).catch(() => null)
      if (entries) breaks.push(...externalBreaks(entries, column))
    }
    return { breaks }
  })()
  columnEvidenceMemo.set(ctx, p)
  return p
}

/** Evidence for the lineage lane: model-level for a delete/rename, removed
 *  output columns (from column lineage on compiled SQL) for a modification. */
async function lineageImpactEvidence(
  ctx: ModelContext,
  runner: ReviewRunner,
  dialect: string,
): Promise<ExternalBreakEvidence> {
  if (!runner.dbtImpact) return { breaks: [] }
  const { file } = ctx
  if (file.status === "deleted" || file.status === "renamed") {
    const model = modelNameFromPath(file.oldPath ?? file.path)
    const entries = await runner.dbtImpact({ model, kind: "drop" }).catch(() => null)
    return { breaks: entries ? externalBreaks(entries) : [] }
  }
  if (file.status !== "modified" || !runner.columnLineage || !ctx.engineOldSql || !ctx.engineNewSql)
    return { breaks: [] }
  const cols = async (sql: string) =>
    new Set((await runner.columnLineage!(sql, dialect)).map((e) => e.target.toLowerCase()).filter(Boolean))
  const [oldCols, newCols] = await Promise.all([cols(ctx.engineOldSql), cols(ctx.engineNewSql)])
  const removed = [...oldCols].filter((c) => !newCols.has(c))
  return columnImpactEvidence(ctx, runner, removed)
}
// altimate_change end

// altimate_change start — schema_lag lane
/**
 * SCHEMA LAG — a reader of a column the change adds (or a newly declared
 * source column) that production can run before the producer is rebuilt:
 * another job builds it, it is incremental and never gains the column, or the
 * loader has not landed it. CI builds everything at once, so it passes there.
 * Triggered when the model's output columns change or a YAML file in the diff
 * changes declared columns.
 */
export async function schemaLagLane(
  ctx: ModelContext,
  runner: ReviewRunner,
  dialect: string,
  sourceYamlChanged: boolean,
): Promise<Finding[]> {
  if (!runner.schemaLag) return []
  const { file, engineOldSql, engineNewSql } = ctx
  if (file.status !== "modified" || !engineOldSql || !engineNewSql || engineOldSql.trim() === engineNewSql.trim()) return []
  let columnsChanged = sourceYamlChanged
  if (!columnsChanged && runner.columnLineage) {
    const cols = async (sql: string) =>
      [...new Set((await runner.columnLineage!(sql, dialect)).map((e) => e.target.toLowerCase()).filter(Boolean))].sort()
    const [o, n] = await Promise.all([cols(engineOldSql), cols(engineNewSql)])
    columnsChanged = o.join(",") !== n.join(",")
  } else if (!runner.columnLineage) columnsChanged = true
  if (!columnsChanged) return []
  const model = modelNameFromPath(file.path)
  const r = await runner
    .schemaLag({ model, kind: "sql", base_sql: engineOldSql, head_sql: engineNewSql })
    .catch(() => null)
  if (!r) return []
  return r.findings.map((f) =>
    makeFinding({
      severity: clampSeverity("lineage_breakage", f.verdict === "breaking" ? "critical" : "warning", "high"),
      category: "lineage_breakage",
      title: `${f.reason}: \`${f.consumer}\` reads \`${f.producer}.${f.column}\` before it exists in production`,
      body: `${f.message}. Suggested fix: ${f.fix}.`,
      file: file.path,
      model,
      column: f.column,
      confidence: "high",
      evidence: { tool: "altimate_core.dbt_impact", result: { schema_lag: f, skipped: r.skipped } },
      ruleKey: f.reason,
    }),
  )
}
// altimate_change end

/**
 * COLUMN-LEVEL breakage — the real lineage differentiator a linter can't do.
 * When a PR removes/renames an OUTPUT column of a model, trace (via the engine's
 * column lineage) which downstream models actually SELECT that column and flag
 * the concrete break: "removing `X` breaks `A`, `B`". Needs base+head compiled
 * SQL, the manifest DAG, and downstream compiled SQL.
 */
async function columnBreakageLane(
  ctx: ModelContext,
  runner: ReviewRunner,
  getCompiled: ((file: string, side: "old" | "new") => Promise<string | undefined>) | undefined,
  dialect: string,
): Promise<Finding[]> {
  if (!runner.columnLineage || !runner.downstreamModels || !getCompiled) return []
  const { file, engineOldSql, engineNewSql } = ctx
  if (!engineOldSql || !engineNewSql || file.status !== "modified") return []
  const model = modelNameFromPath(file.path)

  // 1. Output columns removed by this change (column-lineage targets, old − new).
  const oldCols = new Set((await runner.columnLineage(engineOldSql, dialect)).map((e) => e.target.toLowerCase()).filter(Boolean))
  if (!oldCols.size) return []
  const newCols = new Set((await runner.columnLineage(engineNewSql, dialect)).map((e) => e.target.toLowerCase()).filter(Boolean))
  const removed = [...oldCols].filter((c) => !newCols.has(c))
  if (!removed.length) return []
  const removedSet = new Set(removed)

  // 2. Which downstream models actually consume a removed column of THIS model?
  const downstream = await runner.downstreamModels(model)
  const brokenBy = new Map<string, Set<string>>() // removedCol -> downstream models
  for (const d of downstream) {
    const dSql = await getCompiled(d.path, "new")
    if (!dSql) continue
    for (const edge of await runner.columnLineage(dSql, dialect)) {
      const { table, col } = parseLineageSource(edge.source)
      if (table === model.toLowerCase() && removedSet.has(col)) {
        if (!brokenBy.has(col)) brokenBy.set(col, new Set())
        brokenBy.get(col)!.add(d.name)
      }
    }
  }
  // altimate_change start — removed columns read by loaders / served tables
  const external = await columnImpactEvidence(ctx, runner, removed)
  for (const e of external.breaks) {
    const key = e.column ?? "?"
    if (!brokenBy.has(key)) brokenBy.set(key, new Set())
    brokenBy.get(key)!.add(`${e.node_type}:${e.name}`)
  }
  // altimate_change end
  if (!brokenBy.size) return []

  const detail = [...brokenBy.entries()]
    .map(([col, models]) => `\`${col}\` → ${[...models].map((m) => `\`${m}\``).join(", ")}`)
    .join("; ")
  return [
    makeFinding({
      severity: "critical",
      category: "lineage_breakage",
      title: `${model}: removed column(s) break downstream models`,
      body:
        `This change removes/renames output column(s) that downstream models still SELECT: ${detail}. ` +
        `Those models will fail (or silently drop the column) on the next run. Update the consumers or keep the column.`,
      file: file.path,
      model,
      confidence: "high",
      evidence: { tool: "altimate_core.column_lineage", result: { removed, brokenBy: Object.fromEntries([...brokenBy].map(([k, v]) => [k, [...v]])) } },
      ruleKey: `lineage_breakage:column-removed`,
    }),
  ]
}

/**
 * DATA-DIFF — the showcase: actually run base vs head against the warehouse
 * (core DataParity) and report row/value deltas a linter can never see. Needs a
 * configured warehouse connection (CI); skips gracefully when absent. Key
 * columns are inferred from the model's `*_id`/`id` output columns.
 */
async function dataDiffLane(
  ctx: ModelContext,
  runner: ReviewRunner,
  dialect: string,
  cfg: { enabled: boolean; warehouse: string },
): Promise<Finding[]> {
  // Opt-in: data-diff costs warehouse compute and needs credentials, so it only
  // runs when explicitly enabled in `.altimate/review.yml`.
  if (!cfg.enabled) return []
  if (!runner.dataDiff || !runner.columnLineage) return []
  const { file, engineOldSql, engineNewSql } = ctx
  if (!engineOldSql || !engineNewSql || file.status !== "modified") return []
  const model = modelNameFromPath(file.path)
  const cols = (await runner.columnLineage(engineNewSql, dialect)).map((e) => e.target.toLowerCase())
  const keys = [...new Set(cols.filter((c) => c === "id" || /_id$/.test(c)))].slice(0, 1)
  if (!keys.length) return [] // no inferable key → can't data-diff
  const diff = await runner.dataDiff(engineOldSql, engineNewSql, keys, cfg.warehouse || undefined)
  if (!diff) return [] // no warehouse/driver → skip
  const base = diff.rowsOnlyInBase ?? 0
  const head = diff.rowsOnlyInHead ?? 0
  const changed = diff.rowsChanged ?? 0
  if (base + head + changed === 0) return []
  return [
    makeFinding({
      severity: "warning",
      category: "semantic_change",
      title: `${model}: data-diff shows output rows change vs base`,
      body:
        `Run against the warehouse, this change produces a different result than the base on key \`${keys[0]}\`: ` +
        `${base} only-in-base, ${head} only-in-head, ${changed} changed` +
        (diff.summary ? ` — ${diff.summary}` : "") +
        `. Confirm the data impact is intended.`,
      file: file.path,
      model,
      confidence: "high",
      evidence: { tool: "data.diff", result: diff },
      ruleKey: "semantic_change:data-diff",
    }),
  ]
}

/** Count leading `_`-separated segments two model names share (a merge-stem signal). */
function leadingSegMatch(a: string, b: string): number {
  const A = a.split("_")
  const B = b.split("_")
  let n = 0
  while (n < A.length && n < B.length && A[n] === B[n]) n++
  return n
}

/** Strip a trailing semicolon so a model's compiled SQL can be wrapped as a subquery. */
function asSubquery(sql: string, alias: string): string {
  return `select * from (\n${sql.trim().replace(/;\s*$/, "")}\n) as ${alias}`
}

/**
 * TOPOLOGY-AWARE equivalence — covers the merge refactor that model-level
 * equivalence misses. When a PR DELETES N models {X,Y,Z} and ADDS one model W
 * that supersedes them (e.g. `int_column_access_{base,direct,modified}` →
 * `int_column_access_daily`), W has no 1:1 base, so `semanticChangeLane` skips
 * it entirely. Here we compose the BASE compiled SQL of the replaced set as
 * `UNION ALL` and ask the engine whether W reproduces it.
 *
 * FP-safe BY CONSTRUCTION: the `UNION ALL` composition is INFERRED (the replaced
 * models might have been combined differently downstream), so this lane is
 * ADVISORY ONLY — it is hard-capped at `warning` and can never block. It surfaces
 * "this merge isn't proven equivalent — verify" rather than asserting a break,
 * and stays SILENT when the engine PROVES the merge equivalent.
 */
async function topologyEquivalenceLane(
  modelFiles: (ChangedFile & { kind: string })[],
  runner: ReviewRunner,
  getCompiled: ((file: string, side: "old" | "new") => Promise<string | undefined>) | undefined,
  dialect: string,
): Promise<Finding[]> {
  if (!getCompiled) return []
  const deleted = modelFiles.filter((f) => f.status === "deleted")
  const added = modelFiles.filter((f) => f.status === "added")
  if (deleted.length < 2 || !added.length) return []

  const out: Finding[] = []
  for (const w of added) {
    const wName = modelNameFromPath(w.path)
    // Pair: replaced set = deleted models sharing the MAXIMAL leading-segment
    // stem with W, requiring ≥2 shared segments and ≥2 such models (a real merge,
    // not a coincidental name overlap).
    let maxSeg = 0
    for (const d of deleted) maxSeg = Math.max(maxSeg, leadingSegMatch(wName, modelNameFromPath(d.path)))
    if (maxSeg < 2) continue
    const replaced = deleted.filter((d) => leadingSegMatch(wName, modelNameFromPath(d.path)) === maxSeg)
    if (replaced.length < 2) continue

    // Compose the BASE side: UNION ALL of the replaced models' base compiled SQL.
    const parts: string[] = []
    let ok = true
    for (let i = 0; i < replaced.length; i++) {
      const sql = await getCompiled(replaced[i].path, "old")
      if (!sql || !sql.trim()) {
        ok = false
        break
      }
      parts.push(asSubquery(sql, `_repl_${i}`))
    }
    if (!ok || parts.length < 2) continue
    const headSql = await getCompiled(w.path, "new")
    if (!headSql || !headSql.trim()) continue

    const baseComposition = parts.join("\nunion all\n")
    const eq = await runner.equivalence(baseComposition, headSql.trim().replace(/;\s*$/, ""), dialect)
    // Proven equivalent → the merge is safe; stay silent (never nitpick what's proven).
    if (eq.decided && eq.equivalent) continue

    const replacedNames = replaced.map((d) => `\`${modelNameFromPath(d.path)}\``).join(", ")
    const diffs = (eq.differences ?? []).slice(0, 6)
    const detail = eq.decided
      ? `the merged model is **NOT row-equivalent** to \`UNION ALL\` of the replaced models` +
        (diffs.length ? `:\n${diffs.map((d) => `- ${d}`).join("\n")}` : ".")
      : `equivalence could not be decided (no schema / unsupported SQL).`
    out.push(
      makeFinding({
        // Hard-capped at warning: the composition is inferred, so this never blocks.
        severity: clampSeverity("semantic_change", "warning", eq.confidence ?? "low"),
        category: "semantic_change",
        title: `${wName}: merges ${replaced.length} models — not proven equivalent`,
        body:
          `\`${wName}\` replaces ${replacedNames}. This is a TOPOLOGY refactor (the new model has ` +
          `no 1:1 base), so model-level equivalence can't check it directly. Composing the replaced ` +
          `models as \`UNION ALL\`, ${detail}\n\n` +
          `_The \`UNION ALL\` composition is inferred — if the replaced models were combined differently ` +
          `(e.g. \`UNION\` / a join) by their consumer, a difference here may be expected. Confirm the ` +
          `data impact with a data-diff._`,
        file: w.path,
        model: wName,
        confidence: eq.decided ? eq.confidence ?? "low" : "unknown",
        degraded: !eq.decided,
        evidence: {
          tool: "altimate_core.equivalence",
          result: {
            topology: "merge",
            replaced: replaced.map((d) => modelNameFromPath(d.path)),
            decided: eq.decided,
            equivalent: eq.equivalent ?? null,
          },
        },
        ruleKey: `semantic_change:topology-merge:${wName}`,
      }),
    )
  }
  return out
}

/**
 * GRAIN MISMATCH — the model's SQL dedups/groups by a key that conflicts with its
 * DECLARED uniqueness (primary key / `unique` test). Catches `6c42eab`-class bugs:
 * deduping on `role_name` while the grain is declared `role_id` keeps the wrong
 * rows / the uniqueness test silently won't hold. Sound: needs a declared key AND a
 * clear grain key in the SQL; fires only when the SQL grain has a column the
 * declared key lacks (so the declared key isn't actually unique).
 */
async function grainMismatchLane(ctx: ModelContext, runner: ReviewRunner): Promise<Finding[]> {
  if (!runner.grain || !runner.declaredPrimaryKey) return []
  const { file, engineNewSql } = ctx
  if (!engineNewSql || file.status === "deleted") return []
  const model = modelNameFromPath(file.path)
  const pk = await runner.declaredPrimaryKey(model)
  if (!pk || !pk.length) return [] // no declared grain → nothing to check against
  const grain = await runner.grain(engineNewSql)
  const actual = grain.group_by.length ? grain.group_by : grain.dedup_partition
  if (!actual.length) return [] // no clear grain in the SQL → stay silent

  const pkLower = new Set(pk.map((c) => c.toLowerCase()))
  const extra = actual.filter((c) => !pkLower.has(c.toLowerCase()))
  if (!extra.length) return [] // grain ⊆ declared key → the key is still unique
  const how = grain.group_by.length ? "grouped by" : "deduped (PARTITION BY) on"
  return [
    makeFinding({
      severity: clampSeverity("sql_correctness", "warning", "medium"),
      category: "sql_correctness",
      title: `${model}: grain key conflicts with declared uniqueness`,
      body:
        `\`${model}\` is ${how} [${actual.join(", ")}], but it declares uniqueness on ` +
        `[${pk.join(", ")}] (contract / unique test). Column(s) [${extra.join(", ")}] are in the ` +
        `grain but not the declared key, so the model can emit multiple rows per declared key — ` +
        `the uniqueness test will fail or the dedup keeps the wrong row. Align the GROUP BY / ` +
        `PARTITION BY with the declared key (e.g. dedup on the id, not the name).`,
      file: file.path,
      model,
      confidence: "medium",
      evidence: { tool: "altimate_core.grain", result: { grain: actual, declared: pk, extra } },
      ruleKey: "sql_correctness:grain-mismatch",
    }),
  ]
}

/**
 * MISSING GRAIN TEST — a NEW grain-bearing model (intermediate / mart / fact / dim)
 * with no declared uniqueness (`unique` / `unique_combination_of_columns` / contract
 * PK). Most of the dedup/grain/fan-out bugs in practice trace back to a model whose
 * grain was never asserted, so a silent dup never trips a test. Advisory (suggestion)
 * and scoped to grain-bearing models so staging passthroughs aren't nagged.
 */
async function missingGrainTestLane(ctx: ModelContext, runner: ReviewRunner): Promise<Finding[]> {
  if (!runner.declaredPrimaryKey) return []
  const { file } = ctx
  if (file.status !== "added") return []
  const model = modelNameFromPath(file.path)
  const grainBearing =
    /(^|\/)(marts|intermediate|reporting)\//.test(file.path) ||
    /^(int_|mrt_|fct_|fact_|dim_|agg_|rpt_)/.test(model)
  if (!grainBearing) return []
  const pk = await runner.declaredPrimaryKey(model)
  if (pk && pk.length) return [] // grain is asserted — good
  return [
    makeFinding({
      severity: clampSeverity("test_coverage", "suggestion", "medium"),
      category: "test_coverage",
      title: `${model}: new model has no uniqueness/grain test`,
      body:
        `\`${model}\` is a new grain-bearing model but declares no \`unique\` / ` +
        `\`unique_combination_of_columns\` test (and no contract primary key). Without a grain ` +
        `assertion, a fan-out or wrong-dedup bug silently doubles rows and no test catches it. ` +
        `Add a uniqueness test on the model's grain so the contract is enforced in CI.`,
      file: file.path,
      model,
      confidence: "medium",
      evidence: { tool: "dbt.manifest", result: { hasGrainTest: false } },
      ruleKey: "test_coverage:missing-grain-test",
    }),
  ]
}

/**
 * dbt CONFIG lint — runs the core dbt-config parser (minijinja) over the RAW model
 * (the `{{ config() }}` block + body) and emits the config/Jinja findings: incremental
 * guard / unique_key, microbatch lookback, enforced-contract on_table_exists,
 * var-without-default, and materialization change (vs base). This replaces the regex
 * dbt-patterns config detectors — the parsing now lives in core.
 */
async function dbtConfigLane(ctx: ModelContext, runner: ReviewRunner): Promise<Finding[]> {
  if (!runner.dbtConfigLint) return []
  const { file, newSql, oldSql } = ctx
  if (!newSql || file.status === "deleted") return []
  const model = modelNameFromPath(file.path)
  const raw = await runner.dbtConfigLint(newSql, file.status === "modified" ? oldSql : undefined)
  const out: Finding[] = []
  for (const f of raw) {
    const cat: ReviewCategory = /var_no_default|microbatch|incremental|materialization/.test(f.rule)
      ? "materialization"
      : /contract/.test(f.rule)
        ? "contract_violation"
        : "sql_correctness"
    const isError = f.severity === "error"
    let sev: Severity = isError ? "warning" : "suggestion"
    if (isError && cat === "contract_violation") sev = "critical"
    sev = clampSeverity(cat, sev, "high")
    out.push(
      makeFinding({
        severity: sev,
        category: cat,
        title: `${model}: ${f.rule.replace(/_/g, " ")}`,
        body: f.message + (f.suggestion ? `\n\n${f.suggestion}` : ""),
        file: file.path,
        model,
        confidence: "high",
        evidence: { tool: "altimate_core.dbt_config", result: { code: f.code, rule: f.rule } },
        ruleKey: `${cat}:dbt-config:${f.code}`,
      }),
    )
  }
  return out
}

/**
 * STRUCTURAL base-vs-head diff — the `*_change` SQL rules (DISTINCT/UNION flip,
 * GROUP BY grain shift, surrogate-key change, COALESCE removed, predicate
 * removed, type narrowing). These moved off diff-LINE regex onto a core AST
 * comparison (`structural_diff`): it parses BOTH versions, so it no longer
 * mistakes a moved line for a change or an ON-clause `and` for a WHERE. Cheap
 * and schema-free, so it runs at every tier the regex twins used to.
 */
const STRUCTURAL_CATEGORY: Record<string, ReviewCategory> = {
  distinct_added: "semantic_change",
  distinct_removed: "semantic_change",
  union_all_to_union: "warehouse_cost",
  union_to_union_all: "sql_correctness",
  group_by_change: "semantic_change",
  surrogate_key_change: "dedup",
  coalesce_removed: "semantic_change",
  removed_predicate: "semantic_change",
  type_narrowing: "contract_violation",
  join_key_regression: "join_risk",
}

// PII classification thresholds for the diff-scoped lane. Names/addresses are
// common, lower-sensitivity PII that the broad name-pattern detector over-flags,
// so the precise lane requires higher confidence before surfacing them. Kept a
// named constant (not a magic number) and deliberately narrow: broadening the
// low-risk set to variants would suppress MORE real columns, hurting recall.
const PII_LOW_RISK_CLASS = /^(name|address)$/i
const PII_LOW_RISK_MIN_CONFIDENCE = 0.9
const PII_DEFAULT_MIN_CONFIDENCE = 0.7
// Column-name tokens the regex PII twins (`pii_into_mart`) key off — used to
// recover which column a coarse regex finding flagged so suppression can be
// column-aware (suppress only when core actually classified THAT column).
const PII_TOKEN_RE =
  /\b(email|ssn|social_security|phone_number|first_name|last_name|full_name|street_address|date_of_birth|dob|passport|credit_card)\b/i

async function structuralChangeLane(ctx: ModelContext, runner: ReviewRunner): Promise<Finding[]> {
  if (!runner.structuralDiff) return []
  // Use the ENGINE (compiled) SQL — structural_diff parses with a real SQL parser,
  // so raw Jinja (`{{ ref() }}`) would fail to parse and the lane would silently
  // return nothing. engineOldSql/engineNewSql fall back to raw when no compiled SQL.
  const { file, engineNewSql, engineOldSql } = ctx
  if (file.status !== "modified" || !engineNewSql || !engineOldSql || engineNewSql.trim() === engineOldSql.trim())
    return []
  const model = modelNameFromPath(file.path)
  const raw = await runner.structuralDiff(engineOldSql, engineNewSql)
  const out: Finding[] = []
  for (const f of raw) {
    const cat: ReviewCategory = STRUCTURAL_CATEGORY[f.rule] ?? "semantic_change"
    // Only `join_risk` (SC010 join-key regression) is allowed to block: a changed
    // join key silently corrupts row sets. Other structural rules core marks
    // `error` stay advisory (warning) so this lane never over-blocks on a rule
    // it wasn't designed to gate.
    const sev = clampSeverity(cat, cat === "join_risk" && f.severity === "error" ? "critical" : "warning", "high")
    out.push(
      makeFinding({
        severity: sev,
        category: cat,
        title: `${model}: ${f.rule.replace(/_/g, " ")}`,
        body: f.message + (f.suggestion ? `\n\n${f.suggestion}` : ""),
        file: file.path,
        model,
        confidence: "high",
        evidence: { tool: "altimate_core.structural_diff", result: { code: f.code, rule: f.rule } },
        ruleKey: `${cat}:structural:${f.code}`,
      }),
    )
  }
  return out
}

/**
 * CROSS-MODEL SIBLING CONSISTENCY — when two+ changed models read the SAME
 * upstream but filter it differently, one is likely missing a guard the others
 * apply (ingestion `d1fe5cf`: one of three sibling loaders lacked a NULL filter →
 * 23.7k leaked rows). Per-upstream filter columns come from the core AST
 * (`source_filters`); this PR-level lane compares them. Advisory (siblings may
 * legitimately differ), so it surfaces the divergence to confirm, never blocks.
 */
async function siblingConsistencyLane(ctxs: ModelContext[], runner: ReviewRunner): Promise<Finding[]> {
  if (!runner.sourceFilters) return []
  const perModel: Array<{ model: string; file: string; filters: Map<string, Set<string>> }> = []
  for (const ctx of ctxs) {
    if (!ctx.engineNewSql || ctx.file.status === "deleted") continue
    const sf = await runner.sourceFilters(ctx.engineNewSql)
    const filters = new Map<string, Set<string>>()
    for (const [u, cols] of Object.entries(sf)) filters.set(u, new Set(cols.map((c) => c.toLowerCase())))
    if (filters.size) perModel.push({ model: modelNameFromPath(ctx.file.path), file: ctx.file.path, filters })
  }
  if (perModel.length < 2) return []

  // upstream → sibling models that read it (within this PR).
  const byUpstream = new Map<string, typeof perModel>()
  for (const pm of perModel) {
    for (const u of pm.filters.keys()) {
      if (!byUpstream.has(u)) byUpstream.set(u, [])
      byUpstream.get(u)!.push(pm)
    }
  }
  const out: Finding[] = []
  const seen = new Set<string>()
  for (const [u, models] of byUpstream) {
    if (models.length < 2) continue
    const union = new Set<string>()
    for (const m of models) for (const c of m.filters.get(u) ?? []) union.add(c)
    for (const m of models) {
      const mine = m.filters.get(u) ?? new Set<string>()
      const missing = [...union].filter((c) => !mine.has(c))
      if (!missing.length) continue
      const key = `${m.file}|${u}`
      if (seen.has(key)) continue
      seen.add(key)
      const others = models.filter((x) => x.file !== m.file).map((x) => `\`${x.model}\``)
      out.push(
        makeFinding({
          severity: clampSeverity("sql_correctness", "warning", "medium"),
          category: "sql_correctness",
          title: `${m.model}: filters \`${u}\` differently from sibling model(s)`,
          body:
            `\`${m.model}\` reads \`${u}\` but does not filter it on [${missing.join(", ")}], while sibling ` +
            `model(s) ${others.join(", ")} (also reading \`${u}\` in this PR) do. A missing row filter silently ` +
            `leaks rows. Confirm the difference is intentional, or apply the same predicate.`,
          file: m.file,
          model: m.model,
          confidence: "medium",
          evidence: { tool: "altimate_core.source_filters", result: { upstream: u, missing } },
          ruleKey: `sql_correctness:sibling-filter:${u}`,
        }),
      )
    }
  }
  return out
}

/**
 * PII exposure via core's `classify_pii` — flags columns the change INTRODUCES
 * that classify as PII (Email/SSN/…), with the masking suggestion. Diff-scoped:
 * only NEW PII (a column whose name appears in the added diff), so it never nags
 * about pre-existing PII columns the PR didn't touch.
 */
async function piiClassifyLane(
  ctx: ModelContext,
  runner: ReviewRunner,
  dialect: string,
): Promise<{ findings: Finding[]; classifiedColumns: Set<string>; completed: boolean }> {
  const empty = { findings: [], classifiedColumns: new Set<string>(), completed: false }
  if (!runner.classifyPii) return empty
  const { file, engineNewSql } = ctx
  if (!engineNewSql || file.status === "deleted") return empty
  const model = modelNameFromPath(file.path)
  if (!runner.columnLineage) return empty
  // Output columns the change INTRODUCED = head targets − base targets (precise;
  // a pre-existing column merely mentioned in the diff is NOT counted).
  let newCols: string[]
  try {
    const headCols = [...new Set((await runner.columnLineage(engineNewSql, dialect)).map((e) => e.target).filter(Boolean))]
    // Zero head targets means lineage could NOT resolve this model's output
    // columns — the classifier considered nothing, so this is uncertainty, not a
    // confident "no new PII". Returning `completed: false` keeps the deterministic
    // regex fallback alive (vs. the `!newCols.length` case below, where lineage
    // DID resolve columns but none are newly introduced — that is genuinely done).
    if (!headCols.length) return empty
    const baseCols = ctx.engineOldSql
      ? new Set((await runner.columnLineage(ctx.engineOldSql, dialect)).map((e) => e.target.toLowerCase()))
      : undefined
    newCols = baseCols ? headCols.filter((c) => !baseCols.has(c.toLowerCase())) : headCols
  } catch {
    return empty
  }
  if (!newCols.length) return { findings: [], classifiedColumns: new Set<string>(), completed: true }
  let pii
  try {
    pii = await runner.classifyPii(newCols)
  } catch {
    return empty
  }
  // Columns core's classifier actually CONSIDERED (returned a verdict for), even
  // if below threshold. The broad fallback and the regex twins dedup against THIS
  // set — not all introduced columns — so a column core simply MISSED (never
  // classified) stays eligible for the broad name-pattern detector instead of
  // being silently dropped.
  const classifiedColumns = new Set(pii.map((p) => String(p.column ?? "").toLowerCase()).filter(Boolean))
  const out: Finding[] = []
  // "Exposure" severity only escalates for published/broadly-read layers
  // (marts/reporting). This is intentionally narrower than where grain tests
  // apply (`missingGrainTestLane` also includes `intermediate`): an internal
  // intermediate model surfacing PII is a warning, not a hard block.
  const highExposureLayer = /(^|\/)(marts|reporting)\//.test(file.path)
  for (const p of pii) {
    const classification = String(p.classification ?? "")
    const lowRiskClass = PII_LOW_RISK_CLASS.test(classification)
    const minConfidence = lowRiskClass ? PII_LOW_RISK_MIN_CONFIDENCE : PII_DEFAULT_MIN_CONFIDENCE
    if (p.confidence < minConfidence || !p.column) continue
    const col = p.column.toLowerCase()
    const highConfidence = p.confidence >= 0.9
    const severity: Severity = highExposureLayer && highConfidence && !lowRiskClass ? "critical" : "warning"
    out.push(
      makeFinding({
        severity: clampSeverity("pii_exposure", severity, highConfidence ? "high" : "medium"),
        category: "pii_exposure",
        title: `${model}: exposes ${p.classification} column \`${p.column}\``,
        body:
          `This change surfaces a **${p.classification}**-classified column \`${p.column}\` ` +
          `(confidence ${(p.confidence * 100).toFixed(0)}%). Confirm masking / access policy before merging to a non-restricted schema` +
          (p.masking ? `; suggested masking: \`${p.masking}\`.` : "."),
        file: file.path,
        model,
        confidence: highConfidence ? "high" : "medium",
        evidence: { tool: "altimate_core.classify_pii", result: p },
        ruleKey: `pii_exposure:${col}`,
      }),
    )
  }
  return { findings: out, classifiedColumns, completed: true }
}

function piiLane(file: ChangedFile & { kind: string }, columns: string[]): Finding[] {
  if (file.status === "deleted" || !columns.length) return []
  const model = modelNameFromPath(file.path)
  return [
    makeFinding({
      severity: "critical",
      category: "pii_exposure",
      title: `${model}: exposes PII column${columns.length !== 1 ? "s" : ""} (${columns.join(", ")})`,
      body:
        `This model surfaces PII-classified column(s): ${columns.map((c) => `\`${c}\``).join(", ")}.` +
        ` Confirm masking/access policy before merging to a non-restricted schema.`,
      file: file.path,
      model,
      confidence: "high",
      evidence: { tool: "schema.detect_pii", result: { columns } },
      ruleKey: "pii:exposure",
    }),
  ]
}

/**
 * Run the full review and return a signed verdict envelope.
 */
interface ModelContext {
  file: ChangedFile & { kind: string }
  impact: ImpactResult
  pii: string[]
  /** RAW Jinja SQL (for the dbt-patterns lane + the diff). */
  newSql?: string
  oldSql?: string
  /** dbt-COMPILED SQL (preferred) for the engine lanes; falls back to raw. */
  engineNewSql?: string
  engineOldSql?: string
  /** Structurally complex change (window/subquery/large plan) — a tiering signal. */
  complex?: boolean
}

export async function runReview(input: OrchestrateInput): Promise<VerdictEnvelope> {
  const reviewable = filterChangedFiles(input.changedFiles, input.rubric.exclusions.excludeGlobs)
  const scope: ReviewScope = input.scope ?? "diff"
  // `project` scope (`altimate review --all`): one version of every model, no
  // base ref. Every base-vs-head lane below is gated on this and reported in
  // `laneReport.skipped` with the reason it could not run.
  const projectScope = scope === "project"
  const laneReport: LaneReport = { ran: [], skipped: [], compiledModels: 0, totalModels: 0 }
  const laneRan = (lane: string) => {
    if (!laneReport.ran.includes(lane)) laneReport.ran.push(lane)
  }
  const laneSkipped = (lane: string, reason: string) => {
    if (!laneReport.skipped.some((s) => s.lane === lane)) laneReport.skipped.push({ lane, reason })
  }
  const dialect = input.config.dialect
  const getContent = input.getContent
  const getCompiled = input.getCompiled

  // Pre-compute every engine result ONCE per model file: blast radius (for
  // tiering + lineage), PII columns (hard-floor → must precede tiering), and
  // both SQL sides. This avoids duplicate engine calls and lets tiering see PII.
  const modelFiles = reviewable.filter((f) => f.kind === "model_sql" || f.kind === "python_model")
  const ctxByPath = new Map<string, ModelContext>()
  let anyManifest = false
  if (input.runner.manifestAvailable) {
    anyManifest = await input.runner.manifestAvailable().catch(() => false)
  }
  await Promise.all(
    modelFiles.map(async (file) => {
      const model = modelNameFromPath(file.path)
      // For renames the previous content lives at oldPath, not the new path.
      const oldRef = file.oldPath ?? file.path
      const [newSql, oldSql, compiledNew, compiledOld] = await Promise.all([
        file.status !== "deleted" ? getContent?.(file.path, "new") : Promise.resolve(undefined),
        file.status === "modified" ? getContent?.(oldRef, "old") : Promise.resolve(undefined),
        file.status !== "deleted" ? getCompiled?.(file.path, "new") : Promise.resolve(undefined),
        file.status === "modified" ? getCompiled?.(oldRef, "old") : Promise.resolve(undefined),
      ])
      // Engine lanes prefer dbt-compiled SQL (correct rendered SQL); raw is the
      // fallback. The dbt-patterns lane always uses raw (it needs the Jinja).
      const engineNewSql = compiledNew ?? newSql
      const engineOldSql = compiledOld ?? oldSql
      const impact = await input.runner.impact(model)
      if (impact.hasManifest) anyManifest = true
      const pii = engineNewSql ? (await input.runner.detectPii(engineNewSql, dialect)).columns : []
      const complex = engineNewSql && input.runner.isComplex ? await input.runner.isComplex(engineNewSql) : false
      // In project scope the caller has no hunks to hand us. Present the whole
      // model as added so the diff-anchored detectors (dbt-patterns, the
      // declarative rule catalog, the lexical scan) actually evaluate it —
      // they are relevance-gated on the diff and would otherwise return
      // nothing while still reporting as "ran".
      const scoped =
        projectScope && !file.diff && newSql ? { ...file, diff: wholeFileAsAddedDiff(newSql) } : file
      if (projectScope) {
        laneReport.totalModels++
        if (compiledNew) laneReport.compiledModels++
      }
      ctxByPath.set(file.path, { file: scoped, impact, pii, newSql, oldSql, engineNewSql, engineOldSql, complex })
    }),
  )

  // A run is degraded when model files exist but none resolved against a manifest.
  const runDegraded = modelFiles.length > 0 ? !anyManifest : reviewable.length === 0

  // High-risk path tokens are user-configured (billing/pci/patient/etc.) —
  // the reviewer core carries no default list. `undefined` when no
  // categories are configured, which keeps `highRiskPathTokenCategory`
  // undefined per file and no promotion fires.
  //
  // `compilePathTokenResolver` throws on an unknown `preset:<name>` (typo
  // guard, cubic + harness-bot P2). Catch that here so a single config
  // typo in `.altimate/review.yml` doesn't crash every review run in the
  // project's CI — surface the error to stderr AND propagate a
  // `configError` reason into the envelope so the reader can see what
  // broke. The review continues with no path-token promotion (the
  // conservative safe fallback), so users notice their opt-in is dead
  // rather than getting silent auto-approve on billing/PCI/etc. paths
  // (cubic-review P2 on PR #1028 risk-tier.ts:134).
  let pathTokenCategoryOf: ((p: string) => string | undefined) | undefined
  let pathTokenConfigError: string | undefined
  try {
    pathTokenCategoryOf = compilePathTokenResolver(input.config.riskTierPathTokens)
  } catch (e: any) {
    pathTokenConfigError = `riskTierPathTokens config invalid: ${e?.message ?? String(e)}`
    process.stderr.write(`⚠️  ${pathTokenConfigError}\n   Review continuing without path-token promotion.\n`)
    pathTokenCategoryOf = undefined
  }
  // Tiering is a COST control for diffs: it reads diff signals (changed-line
  // count, a contract/source block touched in the hunk) to decide which
  // expensive lanes a small PR can skip. None of those signals exist in
  // project scope, where the classifier would land on `trivial` and silently
  // disable most of the review. Project scope is not a tiering situation — it
  // runs every lane that can evaluate a single model version.
  const tierResult = projectScope
    ? { tier: "full" as const, reasons: ["project scope (--all): tiering is a diff cost-control and does not apply"] }
    : classifyPR(reviewable, {
        blastRadiusOf: (p) => {
          const c = ctxByPath.get(p)
          return c ? c.impact.directCount + c.impact.transitiveCount : 0
        },
        touchesPiiOf: (f) => (ctxByPath.get(f.path)?.pii.length ?? 0) > 0,
        isComplexOf: (f) => ctxByPath.get(f.path)?.complex ?? false,
        pathTokenCategoryOf,
      })
  // Surface config errors in the tier-reasons stream so a reader of the
  // envelope (or PR comment) sees WHY their opt-in didn't fire.
  if (pathTokenConfigError) tierResult.reasons.unshift(pathTokenConfigError)
  const classifiedTier = tierResult.tier
  // G2 — --force-tier overrides the classifier. Envelope records both the
  // forced tier and the original classification whenever the flag is passed
  // (regardless of whether the forced value happens to match the classifier),
  // so audits can see the bypass every time the flag was used. The reasons
  // list gets a leading "forced" marker so downstream doesn't confuse the
  // forced tier for a natural one. Codex-R18-review fix — the earlier
  // `!== classifiedTier` gate silently hid the bypass when the forced tier
  // matched the classifier's result.
  const tier = input.forceTier ?? classifiedTier
  const tierForced = input.forceTier !== undefined
  const tierReasons = tierForced
    ? [
        `forced via --force-tier=${input.forceTier} (classifier said ${classifiedTier})`,
        ...tierResult.reasons,
      ]
    : tierResult.reasons

  const lanes = new Set(input.config.reviewers.length ? input.config.reviewers : TIER_LANES[tier])

  // Lane enablement, resolved ONCE so the per-model loop and the lane report
  // can never disagree about what ran. `runStructural` / `runAi` are wholly
  // base-vs-head, so they carry the project-scope gate here; `runSemantic` and
  // `runLineage` each cover a single-version lane AND base-vs-head ones, so
  // theirs sits at the individual call sites below.
  const runCoreLint = lanes.has("sql_quality") || lanes.has("warehouse_cost")
  const runSemantic = lanes.has("semantic_change")
  const runLineage = lanes.has("lineage_breakage")
  const runTestCoverage = lanes.has("test_coverage")
  const runDbtPatterns = lanes.has("dbt_patterns")
  const runDbtConfig = runDbtPatterns || lanes.has("materialization") || lanes.has("contract_violation")
  const runStructural = (runSemantic || runDbtPatterns) && !projectScope
  const runPiiExposure = lanes.has("pii_exposure")
  const runAi = lanes.has("ai_review") && !!input.aiReview && !projectScope
  const runSchemaLag = lanes.has("schema_lag") && !projectScope
  // Declared source columns changed: models reading sources may now read a
  // column the loader has not landed yet.
  const sourceYamlChanged = reviewable.some((f) => /\.ya?ml$/i.test(f.path) && /(^|\n)[+-]\s*-?\s*(\{\s*)?name:/.test(f.diff ?? ""))
  const notEnabled =
    `not enabled at \`${tier}\` tier` + (input.config.reviewers.length ? " / by the `reviewers` config" : "")
  if (projectScope) {
    // Single-version lanes: what a project review actually consists of.
    const note = (lane: string, enabled: boolean) => (enabled ? laneRan(lane) : laneSkipped(lane, notEnabled))
    note("core_lint", runCoreLint)
    note("dbt_patterns", runDbtPatterns)
    note("lexical_scan", runDbtPatterns)
    note("dbt_config_lint", runDbtConfig)
    note("grain_mismatch", runSemantic)
    note("missing_grain_test", runTestCoverage)
    note("sibling_filter_consistency", runSemantic)
    laneRan("pii_classify")
    note("pii_detect", runPiiExposure)
    // Base-vs-head lanes: reported, never dropped.
    for (const [lane, reason] of Object.entries(PROJECT_SCOPE_SKIPS)) laneSkipped(lane, reason)
  }

  const all: Finding[][] = []
  // Files where the diff-scoped PII classifier completed (looked at the change),
  // those where it actually emitted a finding, and — per file — the lowercased
  // columns it classified. These drive column-aware dedup of the coarse regex
  // PII twins in the merge step below.
  const diffScopedPiiCompletedFiles = new Set<string>()
  const diffScopedPiiFindingFiles = new Set<string>()
  const classifiedPiiColumnsByFile = new Map<string, Set<string>>()
  for (const ctx of ctxByPath.values()) {
    const tasks: Promise<Finding[]>[] = []
    // Engine lanes consume COMPILED SQL (rendered by dbt) when available.
    if (runCoreLint) tasks.push(qualityLane(ctx.file, input.runner, ctx.engineNewSql, dialect, ctx.engineOldSql))
    if (runSemantic) {
      // grainMismatchLane reads one version of the model; the other two are
      // base-vs-head and no-op in project scope (see PROJECT_SCOPE_SKIPS).
      tasks.push(grainMismatchLane(ctx, input.runner))
      if (!projectScope) {
        tasks.push(dataDiffLane(ctx, input.runner, dialect, input.config.dataDiff))
        tasks.push(
          semanticChangeLane(
            ctx.file,
            input.runner,
            ctx.engineOldSql,
            ctx.engineNewSql,
            dialect,
            ctx.impact,
            input.rubric,
          ),
        )
      }
    }
    if (runLineage && !projectScope) {
      // altimate_change start — the lineage lane waits on analyzeDbtImpact evidence
      const lineageCtx = ctx
      tasks.push(
        lineageImpactEvidence(lineageCtx, input.runner, dialect).then((external) =>
          lineageBreakageLane(lineageCtx.file, lineageCtx.impact, input.rubric, external),
        ),
      )
      // altimate_change end
      tasks.push(columnBreakageLane(ctx, input.runner, getCompiled, dialect))
    }
    if (runSchemaLag) {
      laneRan("schema_lag")
      tasks.push(schemaLagLane(ctx, input.runner, dialect, sourceYamlChanged))
    }
    if (runTestCoverage) tasks.push(missingGrainTestLane(ctx, input.runner))
    // PII classification always runs (cheap name-pattern check, diff-scoped to
    // newly-introduced columns) — exposing PII is a hard-floor concern that
    // shouldn't depend on the cost tier enabling the pii_exposure lane. If core
    // lineage/classification fails, keep the broad deterministic fallback.
    // Run it as a concurrent task (not an inline await) so the heavy native
    // lineage/classify calls overlap the other engine lanes for this file.
    const currentCtx = ctx
    tasks.push(
      (async () => {
        const diffScopedPii = await piiClassifyLane(currentCtx, input.runner, dialect)
        if (diffScopedPii.completed) {
          diffScopedPiiCompletedFiles.add(currentCtx.file.path)
          classifiedPiiColumnsByFile.set(currentCtx.file.path, diffScopedPii.classifiedColumns)
        }
        if (diffScopedPii.findings.length) diffScopedPiiFindingFiles.add(currentCtx.file.path)
        const findings = [...diffScopedPii.findings]
        if (runPiiExposure) {
          // The broad fallback covers output PII columns the precise lane did NOT
          // classify (pre-existing columns, or ones core's classifier missed) —
          // dedup against the columns core actually CONSIDERED, never all
          // introduced columns, so a missed column still surfaces here.
          const fallbackPii = diffScopedPii.completed
            ? currentCtx.pii.filter((col) => !diffScopedPii.classifiedColumns.has(col.toLowerCase()))
            : currentCtx.pii
          findings.push(...piiLane(currentCtx.file, fallbackPii))
        }
        return findings
      })(),
    )
    // Deterministic dbt anti-pattern detectors run on RAW SQL + diff (need Jinja).
    if (runDbtPatterns) {
      all.push(
        detectModelPatterns(ctx.file, ctx.newSql, input.rubric, { wholeFile: projectScope, dialect }),
      )
      tasks.push(lexicalLane(ctx.file, input.runner))
    }
    // dbt config/Jinja lint (materialization / incremental / contract) — gate on its
    // own concerns, not just dbt_patterns, so it isn't silently dropped on a tier that
    // enables those concerns without dbt_patterns.
    if (runDbtConfig) tasks.push(dbtConfigLane(ctx, input.runner))
    // Base-vs-head structural diff is a `semantic_change` concern (DISTINCT/UNION/grain/
    // surrogate-key/predicate changes) — gate on semantic_change, keeping dbt_patterns
    // so the trivial tier (which has no semantic_change lane) still gets it.
    if (runStructural) tasks.push(structuralChangeLane(ctx, input.runner))
    all.push(...(await Promise.all(tasks)))
  }

  // PR-level: cross-model sibling filter-consistency (divergent filters on a
  // shared upstream across the changed models).
  if (runSemantic) {
    all.push(await siblingConsistencyLane([...ctxByPath.values()], input.runner))
  }

  // PR-level: topology-aware equivalence for merge refactors (N models deleted +
  // 1 added that supersedes them). Per-model equivalence can't see these because
  // the new model has no 1:1 base. Advisory only (capped at warning).
  if (runSemantic && !projectScope) {
    all.push(await topologyEquivalenceLane(modelFiles, input.runner, getCompiled, dialect))
  }

  // schema.yml-level detectors (test removal) — run on changed YAML files
  // regardless of tier, since deleting a guardrail test is always worth flagging.
  // Pass old + new content when available so the detector diffs structural YAML
  // (per-(entity, column, test) tuples) instead of walking the unified diff
  // (which loses context when the model header is outside the -U3 window and
  // silently drops sibling-column edge cases). Falls back to diff-only line
  // detection when a content resolver isn't wired (e.g. unit-test callers).
  //
  // `oldContent` is fetched for anything that has an old side — MODIFIED,
  // RENAMED, and DELETED. A schema.yml being renamed (e.g. moved to a new
  // subdir) that also drops a `unique`/`not_null` guardrail must still surface
  // as a finding; the earlier `status === "modified"` gate silently skipped
  // renames. A whole schema.yml being DELETED removes every test declared in
  // it — an even bigger removal — so the detector runs against `oldContent`
  // vs an empty new document (cubic-review P2).
  //
  // `newContent` fetch is skipped for deleted files (nothing at HEAD to read;
  // git-show would fail).
  //
  // Fetches run in parallel across schema files (a schema-heavy PR could touch
  // dozens of yml files; serial `git show` per file adds up).
  const schemaFiles = reviewable.filter((f) => f.kind === "schema_yml")
  if (schemaFiles.length) {
    const schemaFindingSets = await Promise.all(
      schemaFiles.map(async (file) => {
        const oldRef = file.oldPath ?? file.path
        const [oldContent, newContent] = await Promise.all([
          file.status !== "added" ? getContent?.(oldRef, "old") : Promise.resolve(undefined),
          file.status !== "deleted" ? getContent?.(file.path, "new") : Promise.resolve(undefined),
        ])
        return detectSchemaYmlPatterns(file, input.rubric, { oldContent, newContent })
      }),
    )
    for (const findings of schemaFindingSets) all.push(findings)
  }

  // Architectural dedup: the regex `dbt-patterns`/`rule-catalog` layer is a
  // diff-aware, Jinja-aware, offline fallback. For the STRUCTURAL SQL checks
  // that the native core lint covers via the parsed AST, the AST version is the
  // source of truth — it can't be tripped by string literals, aliases, or
  // leading commas the way regex can. So when core lint actually ran for a
  // file, drop the regex twins of those AST-covered checks. The dbt-specific /
  // diff-specific detectors (incremental, materialization, ref conventions,
  // schema.yml test removal, portability) are NOT covered by core and stay.
  const coreRanFiles = new Set<string>()
  if (runCoreLint) {
    await Promise.all(
      [...ctxByPath.values()].map(async (ctx) => {
        if (!ctx.engineNewSql || ctx.file.status === "deleted") return
        // Cache hit: qualityLane already ran this exact check.
        const cr = await input.runner.check(ctx.engineNewSql, dialect, ctx.engineOldSql)
        if (cr.ran) coreRanFiles.add(ctx.file.path)
      }),
    )
  }
  // Per file, the function names core's AST L033 (NonPortableFunction) flagged.
  // The regex portability catalog defers to core for these (single source);
  // regex still covers functions core didn't flag (dialect-suppressed / not in
  // core's set) plus reserved words / types / operators that L033 doesn't do.
  const flat = all.flat()
  const schemaPiiFiles = new Set(
    flat.filter((f) => f.category === "pii_exposure" && f.evidence?.tool === "schema.detect_pii").map((f) => f.file),
  )
  // Per file, the concatenated rule names core's AST lint actually emitted —
  // so we suppress a regex twin only when core genuinely covered that concern.
  const coreRulesByFile = new Map<string, string>()
  for (const f of flat) {
    if (f.evidence?.tool !== "altimate_core.check") continue
    const rule = String((f.evidence?.result as any)?.rule ?? "")
      .toLowerCase()
      .replace(/_/g, "-")
    coreRulesByFile.set(f.file, `${coreRulesByFile.get(f.file) ?? ""} ${rule}`)
  }
  const corePortabilityFns = new Map<string, Set<string>>()
  for (const f of flat) {
    if (f.evidence?.tool === "altimate_core.check" && (f.evidence?.result as any)?.rule === "non_portable_function") {
      const m = /([A-Za-z_][A-Za-z0-9_.]*)\s*\(\)/.exec(`${f.title} ${f.body}`)
      if (m) {
        const set = corePortabilityFns.get(f.file) ?? new Set<string>()
        set.add(m[1].toLowerCase())
        corePortabilityFns.set(f.file, set)
      }
    }
  }
  const merged = flat.filter((f) => {
    const tool = f.evidence?.tool
    const fallbackRule = String((f.evidence?.result as any)?.rule ?? "").replace(/_/g, "-")
    // Dedup the coarse regex PII twins against the precise deterministic PII
    // detectors — but only when a better detector genuinely COVERS the same
    // column. Suppressing whenever the classifier merely "ran" hid real PII
    // (a high-risk column core's classifier missed but the regex would catch,
    // especially on tiers without the broad `pii_exposure` lane).
    if (
      (tool === "dbt-patterns" || tool === "rule-catalog") &&
      f.category === "pii_exposure" &&
      (fallbackRule === "pii-into-mart" || fallbackRule === "select-pii-columns")
    ) {
      // The broad `schema.detect_pii` lane already flagged this file → redundant.
      if (schemaPiiFiles.has(f.file)) return false
      if (fallbackRule === "pii-into-mart") {
        // `pii_into_mart` carries the matched column in `result.line`: suppress
        // only when core's classifier actually CONSIDERED that column (flagged or
        // deliberately muted). A column core never classified falls through.
        const token = PII_TOKEN_RE.exec(String((f.evidence?.result as any)?.line ?? ""))?.[1]?.toLowerCase()
        if (token && classifiedPiiColumnsByFile.get(f.file)?.has(token)) return false
        // No recoverable column: defer to the prior file-level behavior so the
        // twin isn't double-reported when core ran for the file.
        if (!token && diffScopedPiiCompletedFiles.has(f.file)) return false
        return true
      }
      // `select-pii-columns` doesn't preserve its column. Suppress only when a
      // precise detector actually EMITTED a PII finding for the file (so the
      // exposure is reported by the better source, not silently dropped).
      if (diffScopedPiiFindingFiles.has(f.file)) return false
      return true
    }
    if (!coreRanFiles.has(f.file)) return true
    if (tool !== "dbt-patterns" && tool !== "rule-catalog") return true
    // Structural twins: the check code survives on evidence.result.rule (ruleKey
    // is stripped by the zod schema). Suppress ONLY if core actually emitted the
    // equivalent rule for this file (else the issue would fall through).
    const code = fallbackRule
    const coreMatcher = CORE_AST_COVERED[code]
    if (coreMatcher && coreMatcher.test(coreRulesByFile.get(f.file) ?? "")) return false
    // Portability twins: drop a regex finding ONLY IF it is itself a portability
    // finding AND core L033 flagged the same function. This spares other
    // concerns about the same function (e.g. GETDATE() idempotency), which are
    // distinct findings that must survive.
    const coreFns = corePortabilityFns.get(f.file)
    // Portability phrasings used across the catalog ("non-portable",
    // "dialect-specific", "aren't/isn't standard", "not standard SQL"). Excludes
    // idempotency/other concerns, which never use this language.
    const isPortability = /portab|dialect[ -]specific|non-?standard|n't standard|not standard|standard sql/i.test(
      f.body,
    )
    if (coreFns?.size && isPortability && fnTokensOf(`${f.title} ${f.body}`).some((t) => coreFns.has(t)))
      return false
    return true
  })

  // AI reviewer lane — runs AFTER the deterministic lanes so it can be GROUNDED
  // in (and told not to duplicate) the engine findings. Advisory only: its
  // findings are clamped to ≤ warning upstream, so they enrich the review but
  // never change what blocks. Skipped when no aiReview fn is injected (tests /
  // headless-without-model) — the review degrades to deterministic-only.
  if (runAi && input.aiReview) {
    const aiFiles = [...ctxByPath.values()].map((ctx) => ({
      path: ctx.file.path,
      status: ctx.file.status,
      model: modelNameFromPath(ctx.file.path),
      diff: ctx.file.diff,
      sql: ctx.engineNewSql ?? ctx.newSql,
    }))
    try {
      const aiFindings = await input.aiReview({
        files: aiFiles,
        grounding: merged,
        prTitle: input.prTitle,
        prBody: input.prBody,
      })
      // Defense in depth: the AI never blocks, regardless of what it returns.
      for (const f of aiFindings) merged.push(f.severity === "critical" ? { ...f, severity: "warning" } : f)
    } catch {
      // A failed AI lane must never fail the review.
    }
  }

  // Flatten, drop excluded, dedupe, threshold-filter.
  let findings = dedupe(merged)
  findings = findings.filter((f) => !exclusionReason(f, input.rubric))
  const minSev = SEVERITY_ORDER[input.config.severityThreshold]
  findings = findings.filter((f) => SEVERITY_ORDER[f.severity] >= minSev)
  // Sort by severity desc, then file.
  findings.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || a.file.localeCompare(b.file))

  const degraded = runDegraded || findings.some((f) => f.degraded)
  const envelope = buildEnvelope({
    findings,
    tier,
    mode: input.mode,
    rubric: input.rubric,
    engine: { core: input.coreVersion, model: input.modelVersion, cliVersion: input.cliVersion },
    manifestHash: input.manifestHash,
    staleManifest: input.staleManifest,
    generatedAt: input.generatedAt,
    degraded,
    // Include tierReasons whenever `--explain-tier` / `--force-tier` is set,
    // when a riskTierPathTokens config error was caught above, OR when the
    // classifier lands on `full` tier — a naturally-full run is a customer-
    // visible policy call ("why did my YAML-only diff get REQUEST_CHANGES?")
    // and the reason list is what makes the verdict debuggable without the
    // customer having to re-run with --explain-tier. `trivial`/`lite` runs
    // stay silent to avoid noise on approvals.
    // A naturally-`full` diff run surfaces its reasons (the verdict is a
    // customer-visible policy call). Project scope is always `full` by
    // construction, so the same block there would be pure noise — the lane
    // report below is what explains that run.
    tierReasons:
      input.explainTier || tierForced || pathTokenConfigError || (tier === "full" && !projectScope)
        ? tierReasons
        : undefined,
    tierForced: tierForced ? true : undefined,
    tierClassified: tierForced ? classifiedTier : undefined,
    scope: projectScope ? "project" : undefined,
    // Only in project scope: in diff scope every lane the tier enables runs,
    // so the list would be noise on every PR comment.
    lanes: projectScope ? laneReport : undefined,
  })
  return signEnvelope(envelope)
}
