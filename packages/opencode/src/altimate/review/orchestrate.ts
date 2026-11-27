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
import { type ChangedFile, type DbtProjectLayout, filterChangedFiles, hasOldSide } from "./diff-filter"
import { classifyPR, compilePathTokenResolver, TIER_LANES } from "./risk-tier"
import { type Rubric, exclusionReason, clampSeverity } from "./rubric"
import { type ReviewConfig } from "./config"
import { type ReviewMode, type ReviewScope, type VerdictEnvelope, buildEnvelope, signEnvelope } from "./verdict"
import { detectModelPatterns, detectSchemaYmlPatterns, splitDiff } from "./dbt-patterns"
import {
  type FinalOutputs,
  type RelationPrefixes,
  type SelectItem,
  type SelectItemColumn,
  finalOutputs,
  refCovered,
  ROOT_SCOPE,
  normalizeSelectLine,
  selectItems,
} from "./rule-catalog"
import { type AiLaneStatus, type AiReviewInput, type AiReviewResult, safeReason } from "./ai-review"

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
}

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
  aiReview?: (input: AiReviewInput) => Promise<AiReviewResult | Finding[]>
  /** Why the AI lane is off when `aiReview` is not injected (shown in the comment). */
  aiDisabledReason?: string
  /** Explicit `provider/model` for the AI lane. */
  aiModel?: string
  /** PR metadata passed to the AI reviewer for intent checking. */
  prTitle?: string
  prBody?: string
  /** G1 — attach the classifier's reason list to the envelope. */
  explainTier?: boolean
  /** G2 — override the classifier's tier decision. Envelope carries tierForced:true. */
  forceTier?: "trivial" | "lite" | "full"
  /** Manifest was stale relative to change-affecting files (see run.ts::detectStaleManifest). */
  staleManifest?: boolean
  /** The dbt project's directories from dbt_project.yml (custom model-paths). */
  layout?: DbtProjectLayout
  /** What the review covered: base resolution and files left out of scope. */
  scope?: Omit<ReviewScope, "unverified">
  /** Drop the regex catalog's cross-engine portability findings (single known engine). */
  suppressPortability?: boolean
}

/** A catalog finding tagged as cross-engine portability advice. */
export function isCatalogPortability(f: Finding): boolean {
  return f.evidence?.tool === "rule-catalog" && (f.evidence.result as { portability?: boolean })?.portability === true
}

/**
 * Portability advice that is noise for a project on `dialect`: dropped only
 * when the rule names `dialect` among the engines that support the construct.
 * Otherwise (engine not listed, or support never established) it may be an
 * error on this project's own engine and is kept.
 */
export function isSuppressiblePortability(f: Finding, dialect: string): boolean {
  if (!isCatalogPortability(f)) return false
  const worksOn = (f.evidence?.result as { worksOn?: string[] })?.worksOn
  return !!worksOn && worksOn.includes(dialect.toLowerCase())
}

/** True when SQL text contains Jinja (`{{ }}`, `{% %}` or `{# #}`). */
export function hasJinja(sql: string | undefined): boolean {
  return !!sql && /\{\{|\{%|\{#/.test(sql)
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

function lineageBreakageLane(file: ChangedFile & { kind: string }, impact: ImpactResult, rubric: Rubric): Finding[] {
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

  const sev = impactToSeverity(impact)
  if (!sev) return []
  // For a MODIFIED model, blast radius alone is NOT a breaking change — a wide
  // fan-out doesn't mean the edit broke anything (it may be additive/safe). Until
  // a real column-drop classifier exists, cap modified-model lineage impact at
  // `warning` so merely touching a popular model never blocks. Only delete/rename
  // (handled above) is treated as a genuine break.
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
  if (!hasOldSide(file)) return []
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
  /** True when `sql` is the raw file; compiled-SQL line numbers do not exist in the PR's file. */
  linesMatchFile = false,
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
        startLine: linesMatchFile ? issue.line : undefined,
        endLine: linesMatchFile ? issue.line : undefined,
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
  if (!engineOldSql || !engineNewSql || !hasOldSide(file)) return []
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
  if (!engineOldSql || !engineNewSql || !hasOldSide(file)) return []
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
  const raw = await runner.dbtConfigLint(newSql, hasOldSide(file) ? oldSql : undefined)
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

async function structuralChangeLane(ctx: ModelContext, runner: ReviewRunner): Promise<Finding[]> {
  if (!runner.structuralDiff) return []
  // Use the ENGINE (compiled) SQL — structural_diff parses with a real SQL parser,
  // so raw Jinja (`{{ ref() }}`) would fail to parse and the lane would silently
  // return nothing. engineOldSql/engineNewSql fall back to raw only when it holds no Jinja.
  const { file, engineNewSql, engineOldSql } = ctx
  if (!hasOldSide(file) || !engineNewSql || !engineOldSql || engineNewSql.trim() === engineOldSql.trim())
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
  // Without a compiled base, every head column counts as "introduced", so a
  // pre-existing column can't be told apart: never escalate to critical then.
  const baseUnknown = hasOldSide(file) && !ctx.engineOldSql
  for (const p of pii) {
    const classification = String(p.classification ?? "")
    const lowRiskClass = PII_LOW_RISK_CLASS.test(classification)
    const minConfidence = lowRiskClass ? PII_LOW_RISK_MIN_CONFIDENCE : PII_DEFAULT_MIN_CONFIDENCE
    if (p.confidence < minConfidence || !p.column) continue
    const col = p.column.toLowerCase()
    const highConfidence = p.confidence >= 0.9
    const severity: Severity = highExposureLayer && highConfidence && !lowRiskClass && !baseUnknown ? "critical" : "warning"
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
        // Without a base, exposure is undecided: `unknown` keeps these warnings
        // out of the warning-pattern count, so they never block.
        confidence: baseUnknown ? "unknown" : highConfidence ? "high" : "medium",
        evidence: { tool: "altimate_core.classify_pii", result: p },
        ruleKey: `pii_exposure:${col}`,
      }),
    )
  }
  return { findings: out, classifiedColumns, completed: true }
}

/** `baseUnknown`: the file had a previous version but its base SQL could not
 *  be compiled, so these columns may predate the PR. Reported as a warning
 *  (never blocking) instead of a critical "newly exposed" finding. */
function piiLane(file: ChangedFile & { kind: string }, columns: string[], baseUnknown = false): Finding[] {
  if (file.status === "deleted" || !columns.length) return []
  const model = modelNameFromPath(file.path)
  return [
    makeFinding({
      severity: baseUnknown ? "warning" : "critical",
      category: "pii_exposure",
      title: `${model}: exposes PII column${columns.length !== 1 ? "s" : ""} (${columns.join(", ")})`,
      body:
        `This model surfaces PII-classified column(s): ${columns.map((c) => `\`${c}\``).join(", ")}.` +
        ` Confirm masking/access policy before merging to a non-restricted schema.` +
        (baseUnknown
          ? " The base version could not be compiled, so these columns may already be exposed before this PR."
          : ""),
      file: file.path,
      model,
      // `unknown`: undecided exposure never counts toward the warning pattern.
      confidence: baseUnknown ? "unknown" : "high",
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

/**
 * The raw (uncompiled) base cannot expose any of the source columns `names`:
 * none appears in it as a word outside comments, no select item is a `*`, its
 * only Jinja expressions are `ref`, `source`, `config` or `this`, and its only
 * Jinja statements are control flow (`if`/`for`/`set` and their ends), which
 * emit no text of their own. A macro (`dbt_utils.star(…)`), a variable, a
 * `{{ col }}` loop, an `{% include %}` or a `{% call %}` block could emit any
 * column, so any other tag proves nothing. String literals still count as
 * evidence: a JSON path (`payload:ssn`, `'$.ssn'`) can expose the column.
 */
const RAW_BASE_PLAIN_EXPR = /^\{\{-?\s*(?:(?:ref|source|config)\s*\([^{}]*\)|this)\s*-?\}\}$/
const RAW_BASE_SILENT_TAG = /^\{%[-+]?\s*(?:if|elif|else|endif|for|endfor|set|endset)\b[\s\S]*%\}$/
function rawBaseLacks(oldSql: string | undefined, names: string[]): boolean {
  if (!oldSql || !names.length) return false
  if (!(oldSql.match(/\{\{[\s\S]*?\}\}/g) ?? []).every((e) => RAW_BASE_PLAIN_EXPR.test(e))) return false
  if (!(oldSql.match(/\{%[\s\S]*?%\}/g) ?? []).every((t) => RAW_BASE_SILENT_TAG.test(t))) return false
  if (selectItems(oldSql).some((i) => /(?:^|\.)\*(?:\s|$)/.test(i.text))) return false
  // Comments out, literals kept (one pass, so `--` inside a literal is not a comment).
  const code = oldSql.replace(/\{#[\s\S]*?#\}|\/\*[\s\S]*?\*\/|--[^\n]*|'(?:[^']|'')*'/g, (m) => (m.startsWith("'") ? m : " "))
  return names.every((n) => !new RegExp(`(?<![\\w$])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`, "i").test(code))
}

export async function runReview(input: OrchestrateInput): Promise<VerdictEnvelope> {
  const reviewable = filterChangedFiles(input.changedFiles, input.rubric.exclusions.excludeGlobs, input.layout)
  const dialect = input.config.dialect
  const getContent = input.getContent
  const getCompiled = input.getCompiled

  // Pre-compute every engine result ONCE per model file: blast radius (for
  // tiering + lineage), PII columns (hard-floor → must precede tiering), and
  // both SQL sides. This avoids duplicate engine calls and lets tiering see PII.
  const modelFiles = reviewable.filter((f) => f.kind === "model_sql" || f.kind === "python_model")
  const ctxByPath = new Map<string, ModelContext>()
  const unverified: Array<{ path: string; reason: string }> = []
  let anyManifest = false
  if (input.runner.manifestAvailable) {
    anyManifest = await input.runner.manifestAvailable().catch(() => false)
  }
  await Promise.all(
    modelFiles.map(async (file) => {
      const model = modelNameFromPath(file.path)
      // For renames the previous content lives at oldPath, not the new path.
      const oldRef = file.oldPath ?? file.path
      const withOld = hasOldSide(file)
      const [newSql, oldSql, compiledNew, compiledOld] = await Promise.all([
        file.status !== "deleted" ? getContent?.(file.path, "new") : Promise.resolve(undefined),
        withOld ? getContent?.(oldRef, "old") : Promise.resolve(undefined),
        file.status !== "deleted" ? getCompiled?.(file.path, "new") : Promise.resolve(undefined),
        withOld ? getCompiled?.(oldRef, "old") : Promise.resolve(undefined),
      ])
      // Engine lanes need dbt-compiled SQL. Raw SQL is used only when it holds
      // no Jinja: the AST engine reads `{{ config() }}` as an injection attempt
      // and a mixed raw-vs-compiled pair can never be proven equivalent, so a
      // Jinja model without compiled output is marked unverified instead of
      // producing warnings about its template syntax. The dbt-patterns lane
      // always uses raw (it needs the Jinja).
      const engineNewSql = compiledNew ?? (file.kind === "model_sql" && hasJinja(newSql) ? undefined : newSql)
      const engineOldSql = compiledOld ?? (file.kind === "model_sql" && hasJinja(oldSql) ? undefined : oldSql)
      if (file.status !== "deleted" && newSql && !engineNewSql)
        unverified.push({ path: file.path, reason: "no compiled SQL for the head (run dbt compile)" })
      else if (withOld && oldSql && !engineOldSql)
        unverified.push({ path: file.path, reason: "no compiled SQL for the base (compile the base into target-base)" })
      const impact = await input.runner.impact(model)
      if (impact.hasManifest) anyManifest = true
      const pii = engineNewSql ? (await input.runner.detectPii(engineNewSql, dialect)).columns : []
      const complex = engineNewSql && input.runner.isComplex ? await input.runner.isComplex(engineNewSql) : false
      ctxByPath.set(file.path, { file, impact, pii, newSql, oldSql, engineNewSql, engineOldSql, complex })
    }),
  )

  // A run is degraded when model files exist but none resolved against a manifest.
  // Nothing to resolve (yml-only, pure moves) is not a lint-only run.
  const runDegraded = modelFiles.length > 0 && !anyManifest

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
  const tierResult = classifyPR(reviewable, {
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

  const all: Finding[][] = []
  // Files where the diff-scoped PII classifier completed (looked at the change),
  // those where it actually emitted a finding, and — per file — the lowercased
  // columns it classified and those it flagged. These drive column-aware dedup
  // of the coarse regex PII twins in the merge step below.
  const diffScopedPiiCompletedFiles = new Set<string>()
  const diffScopedPiiFindingFiles = new Set<string>()
  const classifiedPiiColumnsByFile = new Map<string, Set<string>>()
  const flaggedPiiColumnsByFile = new Map<string, Set<string>>()
  // Per file: PII columns the compiled base already exposed. Neither the broad
  // fallback nor the regex twins report these (this PR did not expose them).
  const basePiiColumnsByFile = new Map<string, Set<string>>()
  // Per file, the final output of the base and head models, parsed from the SQL
  // the engine reads (compiled, or raw only when it holds no Jinja): a raw Jinja
  // base would credit it with every `{% if %}` branch, including ones the target
  // never renders. No engine SQL → nothing is known exposed.
  const outputsByFile = new Map<string, FinalOutputs>()
  const outputs = (file: string, side: "old" | "new") => {
    const key = `${side}\u0000${file}`
    let parsed = outputsByFile.get(key)
    if (!parsed) {
      const ctx = ctxByPath.get(file)
      parsed = finalOutputs((side === "old" ? ctx?.engineOldSql : ctx?.engineNewSql) ?? "")
      outputsByFile.set(key, parsed)
    }
    return parsed
  }
  // The schema prefixes the base reads tables under: a base compiled into
  // another environment (prod `target-base`, a `+schema` change) reads the same
  // tables under different prefixes, which `refCovered` then ignores.
  const envOf = (file: string): RelationPrefixes => ({ base: outputs(file, "old").prefixes })
  // `source.column` refs the base exposed raw under a name its PII detection
  // reported: named in its final select, or passed through its plain `*`
  // (`select * from customers` exposes `customers.ssn` when `ssn` is base PII).
  const baseRawPiiByFile = new Map<string, Set<string>>()
  const baseRawPii = (file: string) => {
    const cached = baseRawPiiByFile.get(file)
    if (cached) return cached
    const basePii = basePiiColumnsByFile.get(file)
    const refs = new Set<string>()
    if (!basePii) return refs
    const base = outputs(file, "old")
    for (const name of basePii) {
      for (const ref of base.raw.get(name) ?? []) refs.add(ref)
      if (!base.names.has(name) && base.passthrough) for (const ref of base.starRaw(name)) refs.add(ref)
    }
    baseRawPiiByFile.set(file, refs)
    return refs
  }
  // A regex twin's SOURCE column (`ssn`, with its output alias when it has one) is
  // already exposed only when the head reads it raw from sources that a base PII
  // output also exposed raw: same table and column (`c.ssn` → `cust.ssn` on
  // `customers` is not new; `s.ssn` from `spouses` is). An alias alone is not
  // proof (`c.email as contact` → `c.ssn as contact` newly exposes `ssn`), and
  // neither is a base output that only masks the column (`sha2(c.ssn) as ssn_hash`)
  // or a CTE's own alias that never reaches the final select. A column the head's
  // final output doesn't expose raw under that name is reported.
  // The output name comes from the head's final-select item that spans the line
  // and reads the column raw, so an alias on the next line counts; else the
  // twin's own alias, else the column.
  const isBaseExposed = (file: string, column: string, alias?: string, line?: string) => {
    const spanning = line ? headItemsOnLine(file, line).filter((i) => i.scope === ROOT_SCOPE && i.rawColumn === column) : []
    const names = spanning.length ? [...new Set(spanning.map((i) => i.name!))] : [alias ?? column]
    const head = outputs(file, "new").raw
    const exposed = baseRawPii(file)
    return names.every((name) => {
      const refs = [...(head.get(name) ?? [])].filter((r) => r.endsWith(`.${column}`))
      return refs.length > 0 && refs.every((r) => refCovered(r, exposed, envOf(file)))
    })
  }
  // A head PII output name the base already exposed. When the head selects a
  // column raw under it, the base must expose that same source column raw (base
  // `md5(home_address) as home_address` → head `home_address` is new). A head
  // output that is not a raw column is base-exposed when every source column its
  // value is computed from is one a base PII output exposed raw, or when the base
  // computes the name the same way (same item text with its literals, same
  // CTEs/subqueries read, over source columns the base's name also read):
  // `md5(x) as x` → `lower(x) as x` unmasks, and base raw `email` →
  // `lower(ssn) as email` reads `ssn`. A name the head's final select doesn't
  // resolve counts as base-exposed only when the head passes it through a plain
  // `*` and every source column that `*` resolves it to was exposed raw by a
  // base PII output (named, or through the base's own `*`).
  const isBaseExposedOutput = (file: string, name: string, basePii: Set<string>) => {
    const head = outputs(file, "new")
    const rawColumns = head.raw.get(name)
    if (rawColumns?.size) {
      const exposed = baseRawPii(file)
      return [...rawColumns].every((ref) => refCovered(ref, exposed, envOf(file)))
    }
    if (!basePii.has(name)) return false
    const base = outputs(file, "old")
    if (head.names.has(name)) {
      const exposed = baseRawPii(file)
      const reads = head.reads.get(name)
      if (reads && [...reads].every((ref) => refCovered(ref, exposed, envOf(file)))) return true
      // The same computation counts only over the same source columns: the
      // signature holds the item text and derived-query bodies, not the tables
      // (`lower(email)` from `customers` → from `spouses` is new). Refs no
      // source explains are left to the signature.
      const baseReads = base.reads.get(name) ?? new Set<string>()
      const sameReads = [...(reads ?? [])]
        .filter((ref) => !ref.startsWith("?"))
        .every((ref) => refCovered(ref, baseReads, envOf(file)))
      const baseSigs = base.signatures.get(name)
      return sameReads && !!baseSigs && [...(head.signatures.get(name) ?? [])].every((sig) => baseSigs.has(sig))
    }
    // Unresolved only through a plain `*`: a shape the parser does not model (a
    // parenthesised top-level union, `* except (…)`) is reported. A `*` the
    // parser resolves is base-exposed only when every source column it passes
    // the name through was one a base PII output exposed raw.
    if (!head.passthrough) return false
    const starRefs = head.starRaw(name)
    const exposed = baseRawPii(file)
    return starRefs.size > 0 && [...starRefs].every((ref) => refCovered(ref, exposed, envOf(file)))
  }
  for (const ctx of ctxByPath.values()) {
    const tasks: Promise<Finding[]>[] = []
    // Engine lanes consume COMPILED SQL (rendered by dbt) when available.
    if (lanes.has("sql_quality") || lanes.has("warehouse_cost"))
      tasks.push(
        qualityLane(ctx.file, input.runner, ctx.engineNewSql, dialect, ctx.engineOldSql, ctx.engineNewSql === ctx.newSql),
      )
    if (lanes.has("semantic_change")) {
      tasks.push(dataDiffLane(ctx, input.runner, dialect, input.config.dataDiff))
      tasks.push(grainMismatchLane(ctx, input.runner))
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
    if (lanes.has("lineage_breakage")) {
      all.push(lineageBreakageLane(ctx.file, ctx.impact, input.rubric))
      tasks.push(columnBreakageLane(ctx, input.runner, getCompiled, dialect))
    }
    if (lanes.has("test_coverage")) tasks.push(missingGrainTestLane(ctx, input.runner))
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
        flaggedPiiColumnsByFile.set(
          currentCtx.file.path,
          new Set(diffScopedPii.findings.map((f) => String((f.evidence?.result as any)?.column ?? "").toLowerCase())),
        )
        const findings = [...diffScopedPii.findings]
        let basePii = new Set<string>()
        if (hasOldSide(currentCtx.file) && currentCtx.engineOldSql) {
          try {
            basePii = new Set(
              (await input.runner.detectPii(currentCtx.engineOldSql, dialect)).columns.map((c) => c.toLowerCase()),
            )
          } catch {
            /* unknown base exposure: report as if new */
          }
          basePiiColumnsByFile.set(currentCtx.file.path, basePii)
        }
        if (lanes.has("pii_exposure")) {
          // The broad fallback covers output PII columns the precise lane did NOT
          // classify (pre-existing columns, or ones core's classifier missed) —
          // dedup against the columns core actually CONSIDERED, never all
          // introduced columns, so a missed column still surfaces here.
          let fallbackPii = diffScopedPii.completed
            ? currentCtx.pii.filter((col) => !diffScopedPii.classifiedColumns.has(col.toLowerCase()))
            : currentCtx.pii
          // The fallback reports only columns the base did not already expose.
          fallbackPii = fallbackPii.filter(
            (col) => !isBaseExposedOutput(currentCtx.file.path, col.toLowerCase(), basePii),
          )
          const baseUnknown = hasOldSide(currentCtx.file) && !currentCtx.engineOldSql
          findings.push(...piiLane(currentCtx.file, fallbackPii, baseUnknown))
        }
        return findings
      })(),
    )
    // Deterministic dbt anti-pattern detectors run on RAW SQL + diff (need Jinja).
    if (lanes.has("dbt_patterns")) {
      all.push(detectModelPatterns(ctx.file, ctx.newSql, input.rubric))
      tasks.push(lexicalLane(ctx.file, input.runner))
    }
    // dbt config/Jinja lint (materialization / incremental / contract) — gate on its
    // own concerns, not just dbt_patterns, so it isn't silently dropped on a tier that
    // enables those concerns without dbt_patterns.
    if (lanes.has("dbt_patterns") || lanes.has("materialization") || lanes.has("contract_violation")) {
      tasks.push(dbtConfigLane(ctx, input.runner))
    }
    // Base-vs-head structural diff is a `semantic_change` concern (DISTINCT/UNION/grain/
    // surrogate-key/predicate changes) — gate on semantic_change, keeping dbt_patterns
    // so the trivial tier (which has no semantic_change lane) still gets it.
    if (lanes.has("semantic_change") || lanes.has("dbt_patterns")) {
      tasks.push(structuralChangeLane(ctx, input.runner))
    }
    all.push(...(await Promise.all(tasks)))
  }

  // PR-level: cross-model sibling filter-consistency (divergent filters on a
  // shared upstream across the changed models).
  if (lanes.has("semantic_change")) {
    all.push(await siblingConsistencyLane([...ctxByPath.values()], input.runner))
  }

  // PR-level: topology-aware equivalence for merge refactors (N models deleted +
  // 1 added that supersedes them). Per-model equivalence can't see these because
  // the new model has no 1:1 base. Advisory only (capped at warning).
  if (lanes.has("semantic_change")) {
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
  if (lanes.has("sql_quality") || lanes.has("warehouse_cost")) {
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
  // An added line is a pure reindent (or comment/comma-only edit) only when it
  // matches a removed line AND every select item it belongs to in the head is the
  // same item, in the same query scope (CTE, nested query or final select), in the
  // base. Matching a removed line elsewhere is not enough: `email,` moved from a
  // CTE into the final select, or `ssn` left behind when `sha2(\n ssn\n) as x`
  // is unwrapped, exposes something new.
  const reindentByFile = new Map<string, { removed: Set<string>; head: SelectItem[]; headLines: string[]; base: Set<string> }>()
  const itemKey = (i: SelectItem) => `${i.scope}#${i.branch}\u0000${i.text.toLowerCase()}`
  const reindentInfo = (file: string) => {
    const ctx = ctxByPath.get(file)
    if (!ctx?.newSql) return undefined
    let r = reindentByFile.get(file)
    if (!r) {
      r = {
        removed: new Set(splitDiff(ctx.file.diff).removed.map(normalizeSelectLine).filter(Boolean)),
        head: selectItems(ctx.newSql),
        headLines: ctx.newSql.split("\n").map(normalizeSelectLine),
        base: new Set(ctx.oldSql ? selectItems(ctx.oldSql).map(itemKey) : []),
      }
      reindentByFile.set(file, r)
    }
    return r
  }
  // Head select items spanning any head line equal to `line` (normalised).
  const headItemsOnLine = (file: string, line: string) => {
    const r = reindentInfo(file)
    const normalized = normalizeSelectLine(line)
    if (!r || !normalized) return []
    const lineNos = r.headLines.flatMap((l, i) => (l === normalized ? [i + 1] : []))
    return r.head.filter((i) => lineNos.some((n) => i.startLine <= n && n <= i.endLine))
  }
  const isReindented = (file: string, line: string) => {
    const r = reindentInfo(file)
    if (!r || !ctxByPath.get(file)?.oldSql || !r.removed.has(normalizeSelectLine(line))) return false
    const items = headItemsOnLine(file, line)
    return items.length > 0 && items.every((i) => r.base.has(itemKey(i)))
  }
  // Without a compiled base every other PII lane is undecided (an unknown-
  // confidence warning). A regex twin whose source columns the raw base cannot
  // expose (`rawBaseLacks`) is proven new, so those undecided findings must not
  // stand in for it: it survives their dedup and keeps its severity below.
  const provenNewTwin = (f: Finding) => {
    const ctx = ctxByPath.get(f.file)
    if (!ctx || !hasOldSide(ctx.file) || ctx.engineOldSql) return false
    const result = (f.evidence?.result ?? {}) as { column?: string; items?: SelectItemColumn[] }
    const columns = [result.column, ...(result.items ?? []).map((it) => it.column)]
    return rawBaseLacks(ctx.oldSql, columns.filter((c): c is string => !!c))
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
      const proven = provenNewTwin(f)
      // The broad `schema.detect_pii` lane already flagged this file → redundant.
      if (schemaPiiFiles.has(f.file) && !proven) return false
      const result = (f.evidence?.result ?? {}) as {
        line?: string
        column?: string
        alias?: string
        items?: SelectItemColumn[]
      }
      if (fallbackRule === "pii-into-mart") {
        // `pii_into_mart` is one finding per column token, carrying the column,
        // its alias and the line. A reindented base line exposes nothing new.
        if (result.line && isReindented(f.file, result.line)) return false
        if (!result.column) return !diffScopedPiiCompletedFiles.has(f.file)
        // Suppress when core's classifier actually CONSIDERED that column (flagged
        // or deliberately muted). A column core never classified falls through.
        // A proven-new twin is dropped only when core muted the column, not when
        // core flagged it as an undecided warning.
        const classified = classifiedPiiColumnsByFile.get(f.file)
        const flagged = flaggedPiiColumnsByFile.get(f.file)
        const considered = (c?: string) => !!c && !!classified?.has(c) && !(proven && flagged?.has(c))
        if (considered(result.column) || considered(result.alias)) return false
        // A column the base already exposed is not newly exposed by this PR.
        return !isBaseExposed(f.file, result.column, result.alias, result.line)
      }
      // `select-pii-columns` keeps every matched column with its alias and line:
      // drop it when each one is a reindented base line or already base-exposed.
      const items = result.items ?? []
      if (items.length && items.every((i) => isReindented(f.file, i.line) || isBaseExposed(f.file, i.column, i.alias, i.line))) return false
      // Otherwise suppress only when a precise detector actually EMITTED a PII
      // finding for the file (so the exposure is reported by the better source,
      // not silently dropped).
      if (diffScopedPiiFindingFiles.has(f.file) && !proven) return false
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
  // Without a compiled base (raw Jinja on the old side) the regex PII twins can't
  // tell a new column from one the base already exposed: report them like the
  // other PII lanes, as a warning of unknown confidence that never blocks.
  // Unless the raw base proves the column new (`rawBaseLacks`): then the twin
  // keeps its severity.
  for (const [i, f] of merged.entries()) {
    const rule = (f.evidence?.result as { rule?: string } | undefined)?.rule
    if (f.category !== "pii_exposure" || (rule !== "pii_into_mart" && rule !== "select-pii-columns")) continue
    const ctx = ctxByPath.get(f.file)
    if (!ctx || !hasOldSide(ctx.file) || ctx.engineOldSql || provenNewTwin(f)) continue
    merged[i] = { ...f, severity: f.severity === "critical" ? "warning" : f.severity, confidence: "unknown" }
  }

  // AI reviewer lane — runs AFTER the deterministic lanes so it can be GROUNDED
  // in (and told not to duplicate) the engine findings. Advisory only: its
  // findings are clamped to ≤ warning upstream, so they enrich the review but
  // never change what blocks. Skipped when no aiReview fn is injected (tests /
  // headless-without-model) — the review degrades to deterministic-only.
  let aiStatus: AiLaneStatus | undefined
  if (!lanes.has("ai_review")) {
    aiStatus = { state: "skipped", reason: `not part of the ${tier} tier` }
  } else if (!input.aiReview) {
    aiStatus = { state: "skipped", reason: input.aiDisabledReason ?? "disabled" }
  } else {
    const aiFiles = [...ctxByPath.values()].map((ctx) => ({
      path: ctx.file.path,
      status: ctx.file.status,
      model: modelNameFromPath(ctx.file.path),
      diff: ctx.file.diff,
      sql: ctx.engineNewSql ?? ctx.newSql,
    }))
    try {
      const res = await input.aiReview({
        files: aiFiles,
        grounding: merged,
        prTitle: input.prTitle,
        prBody: input.prBody,
        model: input.aiModel,
      })
      const aiFindings = Array.isArray(res) ? res : res.findings
      aiStatus = Array.isArray(res) ? { state: "ok" } : res.status
      // Defense in depth: the AI never blocks, regardless of what it returns.
      for (const f of aiFindings) merged.push(f.severity === "critical" ? { ...f, severity: "warning" } : f)
    } catch (err) {
      // A failed AI lane must never fail the review — but it must say so.
      aiStatus = { state: "error", reason: safeReason(err) }
    }
  }

  // Flatten, drop excluded, dedupe, threshold-filter.
  let findings = dedupe(merged)
  findings = findings.filter((f) => !exclusionReason(f, input.rubric))
  // Cross-engine portability advice from the regex catalog is noise for a
  // project that runs on one known engine. Core's dialect-aware check (a
  // function missing on THIS engine) is a real error and is kept.
  if (input.suppressPortability) findings = findings.filter((f) => !isSuppressiblePortability(f, dialect))
  const minSev = SEVERITY_ORDER[input.config.severityThreshold]
  findings = findings.filter((f) => SEVERITY_ORDER[f.severity] >= minSev)
  // Sort by severity desc, then file.
  findings.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || a.file.localeCompare(b.file))

  // Lint-only means no changed model resolved against a manifest. A single
  // undecidable finding does not make the whole run lint-only; those findings
  // carry their own `degraded` flag and are counted separately in the summary.
  const degraded = runDegraded
  const envelope = buildEnvelope({
    ai: aiStatus,
    findings,
    tier,
    mode: input.mode,
    rubric: input.rubric,
    engine: { core: input.coreVersion, model: input.modelVersion, cliVersion: input.cliVersion },
    manifestHash: input.manifestHash,
    staleManifest: input.staleManifest,
    generatedAt: input.generatedAt,
    degraded,
    scope:
      input.scope || unverified.length
        ? { ...input.scope, unverified: unverified.length ? unverified.sort((a, b) => a.path.localeCompare(b.path)) : undefined }
        : undefined,
    // Include tierReasons whenever `--explain-tier` / `--force-tier` is set,
    // when a riskTierPathTokens config error was caught above, OR when the
    // classifier lands on `full` tier — a naturally-full run is a customer-
    // visible policy call ("why did my YAML-only diff get REQUEST_CHANGES?")
    // and the reason list is what makes the verdict debuggable without the
    // customer having to re-run with --explain-tier. `trivial`/`lite` runs
    // stay silent to avoid noise on approvals.
    tierReasons: input.explainTier || tierForced || pathTokenConfigError || tier === "full" ? tierReasons : undefined,
    tierForced: tierForced ? true : undefined,
    tierClassified: tierForced ? classifiedTier : undefined,
  })
  return signEnvelope(envelope)
}
