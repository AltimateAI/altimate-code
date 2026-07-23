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
  // R20 S4 — risk-signal promotion. Grounded in an internal corpus study of
  // real reviewer comments on dbt PRs; two failure classes drove the promotion
  // gate: (a) test-only YAML edits on contracted marts, (b) cost-anchor logic
  // redesigns landing in a business-critical vertical. Both had auto-approved
  // despite each having 8+ substantive human findings.
  /** schema.yml diff introduces or edits `data_tests:`, `constraints:`,
   *  `unique_combination_of_columns`, `contract:`, or the pre-1.8 `tests:`
   *  alias — grain / constraint territory reviewers repeatedly flagged as
   *  substantive. Convenience boolean; `dbtRiskYmlKeys` names the exact
   *  keys that matched. */
  dbtRiskYmlChanges: boolean
  /** The specific risk-YAML keys that matched in the changed lines. Empty
   *  when `dbtRiskYmlChanges` is false. Consumers should prefer this over
   *  the boolean when building human-readable reasons. */
  dbtRiskYmlKeys: string[]
  /** File lives under `models/marts/` or `models/mart/` — mart-layer changes
   *  land in the API surface downstream consumers depend on. */
  martLayerChange: boolean
  /** The user-configured risk-token category that matched this path (e.g.
   *  `finops`, `pci`, `patient`), or undefined when no configured token
   *  matched. Categories are supplied via `riskTierPathTokens` in
   *  `.altimate/review.yml`; the reviewer core is neutral. */
  highRiskPathTokenCategory: string | undefined
}

export interface ClassifyOptions {
  /** Resolve a changed file path to its downstream consumer count. */
  blastRadiusOf?: (path: string) => number
  /** Mark a path as touching a PII-classified column. */
  touchesPiiOf?: (file: ChangedFile) => boolean
  /** Mark a path as a structurally complex change (window/subquery/large plan). */
  isComplexOf?: (file: ChangedFile) => boolean
  /** Resolve a path to a user-configured risk-token category (e.g. "finops",
   *  "pci"), or undefined when no category matches. Injected from
   *  `.altimate/review.yml`'s `riskTierPathTokens`; the reviewer core carries
   *  no default token list. */
  pathTokenCategoryOf?: (path: string) => string | undefined
}

/**
 * Shipped path-token presets that a user can opt into by putting
 * `[preset:finops]` in their `riskTierPathTokens.<category>` array. The
 * lists are mined from real reviewer comments across dbt PRs in the
 * billing / cost-attribution vertical; a project that doesn't care about
 * that vertical simply doesn't enable the preset. Adding a new preset is
 * a matter of shipping a new entry here.
 */
export const RISK_TOKEN_PRESETS: Record<string, string[]> = {
  finops: [
    "cost",
    "costs",
    "saving",
    "savings",
    "billing",
    "credit",
    "credits",
    "dbu",
    "spend",
    "revenue",
    "price",
    "prices",
    "rate",
    "rates",
    "pricing",
    "invoice",
    "invoices",
  ],
}

/**
 * Compile a `riskTierPathTokens` config record into a `pathTokenCategoryOf`
 * resolver — used by orchestration to inject the callback into `classifyPR`.
 * Handles `preset:<name>` expansion. Tokens match at path/word/digit
 * boundaries: `mrt_cost.sql` fires, `broadcaster.sql` doesn't. Returns
 * undefined (no resolver) when no categories are configured, so the
 * `highRiskPathTokenCategory` field stays undefined and no promotion fires.
 */
export function compilePathTokenResolver(
  cfg: Record<string, string[]>,
): ((path: string) => string | undefined) | undefined {
  const compiled: Array<{ category: string; re: RegExp }> = []
  for (const [category, entries] of Object.entries(cfg)) {
    const tokens: string[] = []
    for (const entry of entries) {
      if (entry.startsWith("preset:")) {
        const name = entry.slice("preset:".length)
        const preset = RISK_TOKEN_PRESETS[name]
        if (preset) tokens.push(...preset)
      } else {
        tokens.push(entry)
      }
    }
    if (tokens.length === 0) continue
    // Anchor tokens at path/word/digit boundaries so incidental substrings
    // don't fire (e.g. `broadcaster` should not match token `cast`).
    const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    compiled.push({
      category,
      re: new RegExp(`(?:^|[\\/_.\\-\\d])(?:${escaped.join("|")})(?:$|[\\/_.\\-\\d])`, "i"),
    })
  }
  if (compiled.length === 0) return undefined
  return (path: string) => {
    for (const { category, re } of compiled) {
      if (re.test(path)) return category
    }
    return undefined
  }
}

const MATERIALIZATION_RE = /[+]?materialized\s*[:=]|config\s*\(\s*[^)]*materialized/i
const INCREMENTAL_RE = /is_incremental\s*\(|unique_key|incremental_strategy|merge_update_columns|partition_by/i

// R20 S4 — signals that lift a PR out of trivial / lite. See FileChangeClass docs.
//
// Anchored to YAML key position after the optional diff marker (`+`/`-`),
// optional indentation, and optional list-item marker (`- `). Excludes comment
// lines (`#`) and description strings that happen to contain the keyword. Two
// forms because `data_tests`/`constraints`/`contract` are ALWAYS keys, whereas
// `unique_combination_of_columns` is a dbt test macro / test parameter that
// shows up as a list item under a `tests:` / `data_tests:` map
// (`- dbt_utils.unique_combination_of_columns:`). Comment wording fixed per
// consensus NIT #10.
// Consensus-review MAJOR #1 — `tests:` (the pre-dbt-1.8 alias for
// `data_tests:`) is also a risk-bearing YAML key. Without it, a schema.yml
// under `models/marts/` adding `tests: [- unique / - not_null]` would fall
// through to `trivial` and auto-approve on any project that hasn't migrated
// to `data_tests:`. Each signal is its own regex so we can name the exact
// triggering key in the reason string (consensus MINOR #4).
const DBT_RISK_KEY_PATTERNS: Array<{ key: string; re: RegExp }> = [
  { key: "data_tests", re: /^[+-]?[ \t]*(?!#)(?:-[ \t]+)?data_tests[ \t]*:/im },
  { key: "tests", re: /^[+-]?[ \t]*(?!#)(?:-[ \t]+)?tests[ \t]*:/im },
  { key: "constraints", re: /^[+-]?[ \t]*(?!#)(?:-[ \t]+)?constraints[ \t]*:/im },
  { key: "contract", re: /^[+-]?[ \t]*(?!#)(?:-[ \t]+)?contract[ \t]*:/im },
]
// unique_combination_of_columns is a TEST NAME, not a YAML key — matches
// both list-item form (`- dbt_utils.unique_combination_of_columns:`) and
// the bare-key indented form (`unique_combination_of_columns:` under a
// short-form `tests:` map). Consensus NIT #8.
const DBT_UNIQUE_COMBO_RE =
  /^[+-]?[ \t]*(?!#)(?:-[ \t]+)?(?:[\w.]+\.)?unique_combination_of_columns[ \t]*:/im
const MARTS_DIR_RE = /(?:^|\/)models\/marts?\//i

/** The ADDED/REMOVED lines of a unified diff (excludes context + hunk headers),
 *  so signal detection fires on what actually changed, not surrounding context. */
function changedLines(diff: string | undefined): string {
  if (!diff) return ""
  return diff
    .split("\n")
    .filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---"))
    .join("\n")
}

/** Walk a unified diff, tracking block-scalar state from context lines AND
 *  changed lines, then return only the ADDED/REMOVED lines with any that
 *  live inside a block scalar blanked out.
 *
 *  Codex R20 round-6 review HIGH — an earlier version stripped only the
 *  already-filtered +/- slice, which missed the common case where a
 *  pre-existing `description: |` is in the context (unchanged) but the
 *  added line inside its body contains `data_tests:` etc. Tracking scalar
 *  state over the whole diff — and only masking output on changed lines —
 *  closes that gap while preserving the +/- filter's role of ignoring
 *  surrounding-code noise. */
function changedLinesForScan(diff: string | undefined): string {
  if (!diff) return ""
  const lines = diff.split("\n")
  const out: string[] = []
  let scalarIndent = -1
  // YAML block-scalar header. The optional trailing tail covers:
  //  - explicit indentation indicator (1-9) either before or after the
  //    chomping indicator: `|2`, `|+2`, `|2+`, `>2-`
  //  - trailing comment: `description: | # legacy`
  // kilo-code-bot suggestion — the earlier form matched only `|`/`>`
  // with an optional `+`/`-` chomp, so `|2` and `| # comment` skipped the
  // opener → body lines beginning with a risk keyword false-positive
  // promoted (safe-direction over-tiering, but still wrong).
  const blockScalarStart = /^[ \t]*[^\s#:][^:]*:[ \t]*[|>](?:[+-]?[1-9]?|[1-9]?[+-]?)[ \t]*(?:#.*)?$/
  for (const raw of lines) {
    // Skip hunk headers entirely — they aren't code and would confuse the
    // block-scalar tracker.
    if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("@@")) continue
    // Distinguish added / removed / context so we can update scalar state
    // from context lines too but only include +/- in the output.
    // Unified-diff context lines start with a leading SPACE (the diff
    // marker), so we must strip that space too — otherwise a context line
    // like " description: |1" is measured as 1-deeper indent than an
    // otherwise-equivalent "+   data_tests: ..." changed line, and the
    // scalar body fails the `indent > scalarIndent` check (cubic P2).
    const marker = raw.startsWith("+") || raw.startsWith("-") ? raw[0] : raw.startsWith(" ") ? " " : ""
    const stripped = marker === "" ? raw : raw.slice(1)
    const indent = stripped.length - stripped.replace(/^[ \t]+/, "").length
    const contentEmpty = stripped.trim() === ""
    // Close the current scalar when we hit a non-empty line at ≤ scalarIndent.
    if (scalarIndent >= 0 && !contentEmpty && indent <= scalarIndent) {
      scalarIndent = -1
    }
    const insideScalar = scalarIndent >= 0 && !contentEmpty && indent > scalarIndent
    // Open a new scalar when the *stripped* content matches the start form.
    // Do this AFTER the close-check so a line that both closes one scalar
    // and opens a new one is handled correctly (rare).
    if (blockScalarStart.test(stripped)) {
      scalarIndent = indent
    }
    // Only added/removed lines are candidates for regex scanning; context
    // lines only feed scalar-state tracking. When the changed line lives
    // inside a scalar, emit a blank so the regex has nothing to match.
    if (marker === " ") continue
    out.push(insideScalar ? "" : raw)
  }
  return out.join("\n")
}

/** Return the specific risk-YAML keys that matched in the changed lines, in
 *  a stable order matching DBT_RISK_KEY_PATTERNS. Used by classifyFile to
 *  populate `dbtRiskYmlKeys` so the promotion reason can name the exact
 *  triggering key rather than a concatenated "data_tests/constraints/contract"
 *  umbrella (consensus MINOR #4). Non-schema.yml files always return an
 *  empty list. */
function dbtRiskYmlKeyMatches(kind: DbtFileKind, scanned: string): string[] {
  if (kind !== "schema_yml" || !scanned) return []
  const matched: string[] = []
  for (const { key, re } of DBT_RISK_KEY_PATTERNS) {
    if (re.test(scanned)) matched.push(key)
  }
  if (DBT_UNIQUE_COMBO_RE.test(scanned)) matched.push("unique_combination_of_columns")
  return matched
}

/** Classify a single changed file from its diff + optional manifest signals. */
export function classifyFile(file: ChangedFile, opts: ClassifyOptions = {}): FileChangeClass {
  const kind = classifyDbtFile(file.path)
  const diff = file.diff
  const changed = changedLines(diff)
  // Block-scalar-aware scan: walks the whole diff (including context lines)
  // to track scalar state, then returns +/- lines with scalar bodies blanked
  // (codex R20 round-6 HIGH). Used only for the risk-YAML regexes; other
  // signals (materialization, incremental) run on the classic filter.
  const scannedForRisk = kind === "schema_yml" ? changedLinesForScan(diff) : ""
  const dbtRiskYmlKeys = dbtRiskYmlKeyMatches(kind, scannedForRisk)
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
    dbtRiskYmlChanges: dbtRiskYmlKeys.length > 0,
    dbtRiskYmlKeys,
    martLayerChange: MARTS_DIR_RE.test(file.path),
    highRiskPathTokenCategory: opts.pathTokenCategoryOf?.(file.path),
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
  // R20 S4 — trivial/lite promotion for signals the corpus study proved are
  // reviewer-critical. Each reason surfaces in the signed envelope's
  // `tierReasons`, so a customer can see WHY a nominally-tiny YAML-only diff
  // ran at full tier.
  //
  // Path-based `martLayerChange` on its own is intentionally NOT a promotion
  // reason — description-only edits under `models/marts/` are legitimately
  // trivial. Promotion here requires diff-level evidence (`dbtRiskYmlChanges`)
  // or a user-configured high-risk path-token match, either of which
  // correlates with real reviewer blockers. `martLayerChange` enriches the
  // reason string (adds the mart-API-surface context) but doesn't fire on its
  // own — the tier is already `full` when `dbtRiskYmlChanges` is true; there's
  // no additional weighting or ordering effect (consensus MINOR #5 clarified).
  if (c.dbtRiskYmlChanges) {
    // Name the exact triggering YAML keys rather than a fixed umbrella string
    // — consensus MINOR #4. Falls back to the umbrella when we can't
    // enumerate (defensive, should not happen post-classifier).
    const keys = c.dbtRiskYmlKeys.length ? c.dbtRiskYmlKeys.join(" / ") : "data_tests/constraints/contract"
    const loc = c.martLayerChange ? " under models/marts/ (mart-API surface)" : ""
    reasons.push(`schema.yml diff touches ${keys}${loc}`)
  }
  if (c.highRiskPathTokenCategory) {
    reasons.push(`path matches high-risk token category '${c.highRiskPathTokenCategory}'`)
  }
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
