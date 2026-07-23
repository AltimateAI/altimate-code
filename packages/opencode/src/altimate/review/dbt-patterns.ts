import path from "node:path"
import YAML from "yaml"
import { Log } from "@/altimate/util/log"
import { type Finding, type Severity, type ReviewCategory, makeFinding } from "./finding"
import { type ChangedFile, classifyDbtFile } from "./diff-filter"
import { type Rubric, clampSeverity, exclusionReason } from "./rubric"
import { evaluateCatalog } from "./rule-catalog"

/** Local copy to avoid a cycle with orchestrate.ts. */
function modelNameFromPath(p: string): string {
  return path.basename(p).replace(/\.(sql|py)$/i, "")
}

/**
 * Deterministic dbt/SQL anti-pattern detectors.
 *
 * These operate on the RAW model text + the unified diff — NOT on parsed/
 * compiled SQL — because the highest-frequency real-world review failures are
 * dbt-STRUCTURAL: Jinja config (`materialized`, `is_incremental()`), the diff
 * itself (a WHERE added on a left-joined table), and schema.yml test removal.
 * The SQL-AST engine (altimate-core) can't see any of that, so these belong
 * here in the orchestrator.
 *
 * Each detector is conservative (high precision over recall) — a false positive
 * erodes trust faster than a missed nit — and emits a finding clamped to `high`
 * confidence since the signal is a concrete textual pattern in the change.
 *
 * Scenario sources: r/dataengineering, dbt-core issues (#7597, #1256, #11766),
 * dbt Developer Blog, Datafold/Tobiko writeups. See docs/REVIEW_DEMO.md.
 */

interface DiffLines {
  added: string[]
  removed: string[]
}

/** Split a unified diff into added/removed payload lines (no +++/--- headers). */
export function splitDiff(diff: string | undefined): DiffLines {
  const added: string[] = []
  const removed: string[] = []
  for (const raw of (diff ?? "").split("\n")) {
    if (raw.startsWith("+") && !raw.startsWith("+++")) added.push(raw.slice(1))
    else if (raw.startsWith("-") && !raw.startsWith("---")) removed.push(raw.slice(1))
  }
  return { added, removed }
}

/** Strip line/block comments so detectors don't fire on commented-out code. */
function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\{#[\s\S]*?#\}/g, " ")
}

/**
 * Blank out single-quoted SQL string-literal CONTENTS (keeping the quotes) so a
 * regex detector can't be tripped by punctuation inside a literal — e.g. the
 * `/` in `'n/a'` must not read as division, a `,` in `'a,b'` must not read as a
 * comma join. Detectors that legitimately inspect literal content (leading
 * wildcard, hardcoded date) must NOT use this. Handles doubled-quote escapes.
 */
function stripLiterals(s: string): string {
  return s.replace(/'(?:[^']|'')*'/g, "''")
}

/**
 * True when a line's FROM clause lists two relations separated by a comma at
 * paren-depth 0 — i.e. `FROM a, b` (an implicit cross join). Scans only after
 * the FROM keyword and stops at the next clause boundary, so a comma inside a
 * function call (`nvl(brand, x)`) or a SELECT-list column never trips it. This
 * is the (degraded-mode) fallback for core's AST `CartesianProduct` rule.
 */
function fromClauseHasTopLevelComma(line: string): boolean {
  const s = stripLiterals(stripComments(line))
  const m = /\bfrom\b/i.exec(s)
  if (!m) return false
  let depth = 0
  for (let i = m.index + 4; i < s.length; i++) {
    const ch = s[i]
    if (ch === "(") depth++
    else if (ch === ")") depth = Math.max(0, depth - 1)
    else if (depth === 0) {
      if (ch === ",") return true
      // stop at the next clause keyword (group/having/order/limit/where/join/on/qualify/union)
      const rest = s.slice(i)
      if (/^\s+(where|group|having|order|limit|join|inner|left|right|full|cross|on|qualify|union|except|intersect)\b/i.test(rest))
        return false
    }
  }
  return false
}

const CLOCK_RE = /\b(current_timestamp|current_date|getdate|sysdate|systimestamp|now)\s*\(/i
/** Audit/metadata columns where a clock value is expected and fine. */
const AUDIT_COL_RE = /\b(_?loaded_at|_?dbt_|_etl_|_ingested|_synced|audit_|_meta_|extracted_at)\b/i

function isModelSql(kind: string): boolean {
  return kind === "model_sql"
}

interface Ctx {
  file: ChangedFile
  kind: string
  newSql: string
  added: string[]
  removed: string[]
  model: string
  inMartOrReporting: boolean
}

type Detector = (c: Ctx) => Finding | null

// A line that is dbt Jinja / config rather than SQL — e.g. the microbatch
// `begin=(modules.datetime.datetime.now() - ...)` config kwarg, which is NOT a
// runtime clock in the transform and must not trip the idempotency rule.
const JINJA_OR_CONFIG_LINE =
  /\{\{|\{%|modules\.|^\s*(begin|event_time|lookback|batch_size|partition_by|unique_key)\s*=|config\s*\(/i

// 1. Non-idempotent clock function added to a transform (not a snapshot/audit col).
const detectClock: Detector = (c) => {
  if (c.kind === "snapshot") return null
  const hits = c.added.filter(
    (l) => CLOCK_RE.test(stripComments(l)) && !AUDIT_COL_RE.test(l) && !JINJA_OR_CONFIG_LINE.test(l),
  )
  if (!hits.length) return null
  return makeFinding({
    severity: "warning",
    category: "idempotency",
    title: `${c.model}: non-idempotent clock function in transform`,
    body:
      "A run-time clock (`current_timestamp`/`now`/`current_date`) was added to the model logic. " +
      "The same input now yields different output across runs/backfills, breaking reproducibility " +
      "and (in incremental filters) row membership. Pass an `as_of` var or use a load-time audit column instead.",
    file: c.file.path,
    model: c.model,
    confidence: "high",
    evidence: { tool: "dbt-patterns", result: { rule: "clock_in_transform", lines: hits.slice(0, 3) } },
    ruleKey: "idempotency:clock",
  })
}

// 4. SELECT * added (warehouse cost + fragility on columnar warehouses).
const detectSelectStar: Detector = (c) => {
  const hit = c.added.find((l) => /^\s*select\s+\*/i.test(stripComments(l)) && !/select\s+\*\s+from\s+\{\{/i.test(l))
  if (!hit) return null
  return makeFinding({
    severity: "suggestion",
    category: "warehouse_cost",
    title: `${c.model}: SELECT * scans all columns`,
    body:
      "`SELECT *` reads every column on a columnar warehouse (Snowflake/BigQuery) and makes the model fragile to " +
      "upstream column adds. Select only the columns you need.",
    file: c.file.path,
    model: c.model,
    confidence: "high",
    evidence: { tool: "dbt-patterns", result: { rule: "select_star", line: hit.trim() } },
    ruleKey: "warehouse_cost:select-star",
  })
}

// 5. LEFT/RIGHT JOIN silently collapsed to INNER by a WHERE/AND on the outer table.

// 6. Cross join / cartesian product added.
const detectCrossJoin: Detector = (c) => {
  const hit = c.added.find((l) => /\bcross\s+join\b/i.test(stripComments(l)))
  if (!hit) return null
  return makeFinding({
    severity: "critical",
    category: "join_risk",
    title: `${c.model}: CROSS JOIN creates a cartesian product`,
    body:
      "A CROSS JOIN multiplies every left row by every right row — an M×N explosion that inflates row counts, " +
      "every downstream aggregate, and warehouse cost. Confirm a join key is intended and add an `ON` clause.",
    file: c.file.path,
    model: c.model,
    confidence: "high",
    evidence: { tool: "dbt-patterns", result: { rule: "cross_join", line: hit.trim() } },
    ruleKey: "join_risk:cross-join",
  })
}

// 7. A new JOIN added into a model that aggregates → likely fan-out inflating SUM/COUNT.
const detectFanout: Detector = (c) => {
  const sql = stripComments(c.newSql)
  const aggregates = /\b(sum|count|avg|min|max)\s*\(/i.test(sql) && /\bgroup\s+by\b/i.test(sql)
  if (!aggregates) return null
  const newJoins = c.added.filter((l) => /\bjoin\b/i.test(stripComments(l)) && !/\bcross\s+join\b/i.test(l))
  if (newJoins.length < 1) return null
  return makeFinding({
    severity: "warning",
    category: "fanout",
    title: `${c.model}: new join before an aggregate may fan out and inflate metrics`,
    body:
      "A join was added to a model that aggregates (SUM/COUNT … GROUP BY). If the joined relation has multiple rows " +
      "per group key, the aggregate double-counts and metrics inflate — a classic, syntactically-valid bug. " +
      "Pre-aggregate the child to the group grain before joining, or verify the join is one-to-one.",
    file: c.file.path,
    model: c.model,
    confidence: "high",
    evidence: {
      tool: "dbt-patterns",
      result: { rule: "fanout_join", joins: newJoins.map((j) => j.trim()).slice(0, 2) },
    },
    ruleKey: "fanout:join-before-agg",
  })
}

// 8. NOT IN (subquery) — empties the result when the subquery yields a NULL.
const detectNotIn: Detector = (c) => {
  const hit = c.added.find((l) => /\bnot\s+in\s*\(\s*select\b/i.test(stripComments(l)))
  if (!hit) return null
  return makeFinding({
    severity: "warning",
    category: "sql_correctness",
    title: `${c.model}: NOT IN (subquery) returns zero rows if the subquery contains NULL`,
    body:
      "`NOT IN` against a subquery evaluates to UNKNOWN for every row once the subquery returns a single NULL, " +
      "silently emptying the result. Use `NOT EXISTS`, or filter `IS NOT NULL` inside the subquery.",
    file: c.file.path,
    model: c.model,
    confidence: "high",
    evidence: { tool: "dbt-patterns", result: { rule: "not_in_nullable", line: hit.trim() } },
    ruleKey: "sql_correctness:not-in",
  })
}

// 9. Dedup via ROW_NUMBER()/QUALIFY whose ORDER BY has no unique tiebreaker.
const detectDedupTie: Detector = (c) => {
  const hit = c.added.find((l) => /row_number\s*\(\s*\)\s*over\s*\(/i.test(stripComments(l)))
  if (!hit) return null
  // Only flag dedup with NO ORDER BY — that is unambiguously non-deterministic.
  // A present ORDER BY (even single-column) is the developer's deterministic
  // choice and the dbt-recommended pattern; warning "it might not be unique"
  // on every dedup is noise (false positives on the common, correct case).
  if (/order\s+by/i.test(stripComments(hit))) return null
  return makeFinding({
    severity: "warning",
    category: "dedup",
    title: `${c.model}: ROW_NUMBER() dedup has no ORDER BY`,
    body:
      "Deduplicating with `row_number() over (partition by …)` and NO `ORDER BY` makes which row survives " +
      "non-deterministic — it flaps between rebuilds. Add an `ORDER BY` (ideally with a unique tiebreaker) to pick the row deterministically.",
    file: c.file.path,
    model: c.model,
    confidence: "high",
    evidence: { tool: "dbt-patterns", result: { rule: "dedup_no_tiebreaker", line: hit.trim() } },
    ruleKey: "dedup:no-tiebreaker",
  })
}

// 11. Function/cast wrapped around a column in an added WHERE — defeats partition pruning.
const detectPartitionFunction: Detector = (c) => {
  const hit = c.added.find((l) => {
    const s = stripComments(l)
    return /^\s*(where|and)\b/i.test(s) && /\b(extract|date_trunc|date|year|month|cast|trunc)\s*\(/i.test(s)
  })
  if (!hit) return null
  return makeFinding({
    severity: "suggestion",
    category: "warehouse_cost",
    title: `${c.model}: function on a column in WHERE can defeat partition pruning`,
    body:
      "Wrapping a column in a function/cast inside a WHERE (e.g. `year(event_date) = 2024`) prevents the warehouse " +
      "from pruning partitions, forcing a full scan. Rewrite as a range predicate on the bare column " +
      "(`event_date >= '2024-01-01' and event_date < '2025-01-01'`).",
    file: c.file.path,
    model: c.model,
    confidence: "high",
    evidence: { tool: "dbt-patterns", result: { rule: "partition_function", line: hit.trim() } },
    ruleKey: "warehouse_cost:partition-function",
  })
}

// 12. COUNT(DISTINCT x) downgraded to COUNT(x) (or vice versa) — metric meaning change.
const COUNT_RE = /count\s*\(/i
const COUNT_DISTINCT_RE = /count\s*\(\s*distinct/i
const hasCount = (l: string) => COUNT_RE.test(stripComments(l))
const hasCountDistinct = (l: string) => COUNT_DISTINCT_RE.test(stripComments(l))
const hasPlainCount = (l: string) => hasCount(l) && !hasCountDistinct(l)
const detectCountDistinct: Detector = (c) => {
  const removedDistinct = c.removed.some(hasCountDistinct)
  const addedPlain = c.added.some(hasPlainCount)
  const addedDistinct = c.added.some(hasCountDistinct)
  const removedPlain = c.removed.some(hasPlainCount)
  if (!((removedDistinct && addedPlain) || (addedDistinct && removedPlain))) return null
  return makeFinding({
    severity: "warning",
    category: "sql_correctness",
    title: `${c.model}: COUNT distinctness changed — metric definition shifted`,
    body:
      "A `COUNT(DISTINCT …)` ↔ `COUNT(…)` change silently redefines the metric (e.g. 'orders' becomes 'line items'), " +
      "especially dangerous combined with a fan-out join. Confirm the intended grain.",
    file: c.file.path,
    model: c.model,
    confidence: "high",
    evidence: { tool: "dbt-patterns", result: { rule: "count_distinct_change" } },
    ruleKey: "sql_correctness:count-distinct",
  })
}

// 13. PII column pulled into a marts/reporting model.
const PII_RE =
  /\b(email|ssn|social_security|phone_number|first_name|last_name|full_name|street_address|date_of_birth|dob|passport|credit_card)\b/i
const detectPiiIntoMart: Detector = (c) => {
  if (!c.inMartOrReporting) return null
  const hit = c.added.find((l) => {
    const s = stripComments(l)
    return (
      PII_RE.test(s) &&
      /^\s*[\w.]*\b(email|ssn|social_security|phone_number|first_name|last_name|full_name|street_address|date_of_birth|dob|passport|credit_card)\b/i.test(
        s,
      )
    )
  })
  if (!hit) return null
  // Highly-sensitive identifiers (SSN/financial/passport/DOB) into a broadly-read
  // marts layer are critical; softer PII (email/phone/name) is a warning.
  const sev: Severity = /\b(ssn|social_security|credit_card|passport|date_of_birth|dob)\b/i.test(hit)
    ? "critical"
    : "warning"
  return makeFinding({
    severity: sev,
    category: "pii_exposure",
    title: `${c.model}: PII column added to a marts/reporting model`,
    body:
      "A PII-named column was added to a model in `marts/`/`reporting/`, widening PII exposure into a broadly-read " +
      "layer. Confirm the column is needed here, that masking/access policy applies, and that the downstream grant is appropriate.",
    file: c.file.path,
    model: c.model,
    confidence: "high",
    evidence: { tool: "dbt-patterns", result: { rule: "pii_into_mart", line: hit.trim() } },
    ruleKey: "pii_exposure:into-mart",
  })
}

// ---------------------------------------------------------------------------
// Extended detector battery (high-frequency real-world dbt/SQL review catches).
// Each fires on a concrete added/removed pattern; conservative by design.
// ---------------------------------------------------------------------------

const addedHit = (c: Ctx, re: RegExp) => c.added.find((l) => re.test(stripComments(l)))
function pattern(
  c: Ctx,
  category: ReviewCategory,
  severity: Severity,
  rule: string,
  title: string,
  body: string,
  line?: string,
): Finding {
  return makeFinding({
    severity,
    category,
    title: `${c.model}: ${title}`,
    body,
    file: c.file.path,
    model: c.model,
    confidence: "high",
    evidence: { tool: "dbt-patterns", result: { rule, ...(line ? { line: line.trim() } : {}) } },
    ruleKey: `${category}:${rule}`,
  })
}

// 18. DML / DDL inside a model (models must be SELECT-only).
const detectDml: Detector = (c) => {
  const hit = addedHit(
    c,
    /^\s*(delete\s+from|update\s+\w|insert\s+into|truncate\s+table|drop\s+table|merge\s+into|create\s+(or\s+replace\s+)?table|alter\s+table|grant\s+)\b/i,
  )
  if (!hit) return null
  return pattern(
    c,
    "sql_correctness",
    "critical",
    "dml-in-model",
    "DML/DDL statement inside a model",
    "dbt models must be a single `SELECT` — dbt owns materialization. A `DELETE`/`UPDATE`/`INSERT`/`TRUNCATE`/`DROP`/`MERGE`/`GRANT` here will run on every build and can corrupt or destroy data. Move it to a hook or remove it.",
    hit,
  )
}

// 19. Stray LIMIT left in a model (accidental sampling → silent data loss).
const detectLimit: Detector = (c) => {
  const hit = addedHit(c, /^\s*limit\s+\d+\s*;?\s*$/i)
  if (!hit) return null
  return pattern(
    c,
    "sql_correctness",
    "warning",
    "limit-in-model",
    "LIMIT left in a model — silently drops rows",
    "A top-level `LIMIT` in a model caps output rows on every run — usually a debugging leftover that silently loses data downstream. Remove it.",
    hit,
  )
}

// 20. Non-deterministic random functions in a transform.
const detectRandom: Detector = (c) => {
  const hit = addedHit(c, /\b(rand|random|uuid_generate_v4|gen_random_uuid|newid|uuid_string)\s*\(/i)
  if (!hit) return null
  return pattern(
    c,
    "idempotency",
    "warning",
    "random-nondeterminism",
    "non-deterministic random() in transform",
    "A random/UUID function makes the model non-idempotent — the same input yields different output across runs and backfills, breaking reproducibility and data-diffs.",
    hit,
  )
}

// 21. `= NULL` / `!= NULL` instead of IS [NOT] NULL (always UNKNOWN).
const detectEqualsNull: Detector = (c) => {
  const hit = addedHit(c, /(!=|<>|=)\s*null\b/i)
  if (!hit) return null
  return pattern(
    c,
    "sql_correctness",
    "warning",
    "equals-null",
    "comparison to NULL with =/!= is always UNKNOWN",
    "`= NULL` / `!= NULL` never matches any row (the result is UNKNOWN). Use `IS NULL` / `IS NOT NULL`.",
    hit,
  )
}

// 23. full_refresh=true hardcoded in config → rebuilds full history every run.
const detectFullRefresh: Detector = (c) => {
  const hit = addedHit(c, /full_refresh\s*[=:]\s*true/i)
  if (!hit) return null
  return pattern(
    c,
    "materialization",
    "warning",
    "full-refresh-true",
    "full_refresh=true forces a full rebuild every run",
    "`full_refresh=true` in config makes every run rebuild the entire table, defeating incremental processing — a recurring cost spike. Drop it unless you truly intend that.",
    hit,
  )
}

// 25. max()-subquery on the incremental boundary defeats partition pruning.
const detectSubqueryPruning: Detector = (c) => {
  const hit = addedHit(c, /(>=|>)\s*\(\s*select\s+max\s*\(/i)
  if (!hit) return null
  return pattern(
    c,
    "warehouse_cost",
    "suggestion",
    "subquery-pruning",
    "max() subquery boundary can defeat partition pruning",
    "`col >= (select max(col) from {{ this }})` is the canonical incremental filter, but on BigQuery/Snowflake-external tables the optimizer can't prune partitions from a dynamic subquery — each run scans everything. Inject a literal boundary computed separately.",
    hit,
  )
}

// 26. ORDER BY in a model with no LIMIT → pure cost, no effect.
const detectOrderByNoLimit: Detector = (c) => {
  const hit = c.added.find((l) => /^\s*order\s+by\b/i.test(stripComments(l)) && !/over\s*\(/i.test(l))
  if (!hit) return null
  if (/\blimit\b/i.test(c.newSql) || /over\s*\(/i.test(c.newSql)) return null
  return pattern(
    c,
    "warehouse_cost",
    "suggestion",
    "order-by-no-limit",
    "top-level ORDER BY without LIMIT — sorts for nothing",
    "A model-level `ORDER BY` with no `LIMIT` pays a full sort on every run while downstream consumers can't rely on order anyway. Remove it (use window functions if order matters).",
    hit,
  )
}

// 27. Leading-wildcard LIKE defeats indexes / scan pruning.
const detectLeadingWildcard: Detector = (c) => {
  const hit = addedHit(c, /\b(i?like)\s+'%/i)
  if (!hit) return null
  return pattern(
    c,
    "warehouse_cost",
    "suggestion",
    "leading-wildcard",
    "leading-wildcard LIKE forces a full scan",
    "`LIKE '%…'` with a leading wildcard can't use clustering/search optimization and forces a full scan. Anchor the pattern or use a search index where available.",
    hit,
  )
}

// 28. Join on a constant (1=1 / true) → cartesian product.
const detectConstantJoin: Detector = (c) => {
  const hit = addedHit(c, /\bon\s+(1\s*=\s*1|true)\b/i)
  if (!hit) return null
  return pattern(
    c,
    "join_risk",
    "warning",
    "constant-join",
    "join ON a constant is a cartesian product",
    "`JOIN … ON 1=1` (or `ON true`) joins every left row to every right row. Use a real join key unless an intentional cross join is needed.",
    hit,
  )
}

// 31. Hardcoded recent date literal in a filter → won't roll forward (staleness).
const detectHardcodedDate: Detector = (c) => {
  const hit = c.added.find((l) => {
    const s = stripComments(l)
    return /^\s*(where|and)\b/i.test(s) && /'20\d\d-\d\d-\d\d'/.test(s)
  })
  if (!hit) return null
  return pattern(
    c,
    "freshness",
    "suggestion",
    "hardcoded-date",
    "hardcoded date literal in a filter won't roll forward",
    "A filter pins a hardcoded calendar date. It silently goes stale (or drops new data) over time. Use a relative expression or a var.",
    hit,
  )
}

// 32. CAST timestamp → date (or date_trunc) — timezone truncation / off-by-one.
const detectTimestampToDate: Detector = (c) => {
  const hit = addedHit(
    c,
    /(cast\s*\(\s*[\w.]*(_at|_ts|timestamp|_time)\b[^)]*\bas\s+date\b|date_trunc\s*\(\s*'[^']+'\s*,\s*[\w.]*(_at|_ts|timestamp))/i,
  )
  if (!hit) return null
  return pattern(
    c,
    "sql_correctness",
    "suggestion",
    "timestamp-to-date",
    "truncating a TIMESTAMP to date may shift the day (timezone)",
    "Casting/truncating a timestamp to a date applies the session timezone — on a TIMESTAMP_TZ this can return the previous day, bucketing daily metrics off-by-one. Convert to the intended timezone explicitly first.",
    hit,
  )
}

// 33. HAVING without GROUP BY (or used where WHERE belongs).
const detectHavingNoGroupBy: Detector = (c) => {
  const hit = addedHit(c, /^\s*having\b/i)
  if (!hit) return null
  if (/\bgroup\s+by\b/i.test(c.newSql)) return null
  return pattern(
    c,
    "sql_correctness",
    "suggestion",
    "having-no-group-by",
    "HAVING without GROUP BY — use WHERE",
    "`HAVING` without a `GROUP BY` filters the whole result as one group; a row-level predicate belongs in `WHERE` (and prunes earlier/cheaper).",
    hit,
  )
}

// 34. CASE expression with no ELSE → silent NULLs for unmatched rows.
const detectCaseNoElse: Detector = (c) => {
  const joined = stripComments(c.added.join("\n"))
  const m = /\bcase\b[\s\S]*?\bend\b/i.exec(joined)
  if (!m || /\belse\b/i.test(m[0])) return null
  return pattern(
    c,
    "sql_correctness",
    "suggestion",
    "case-no-else",
    "CASE without ELSE returns NULL for unmatched rows",
    "A `CASE` expression with no `ELSE` silently yields NULL for any unmatched row, which can skew downstream metrics. Add an explicit `ELSE`.",
  )
}

// 36. Implicit comma cross join: `from a, b`.
const detectCommaJoin: Detector = (c) => {
  const hit = c.added.find((l) => fromClauseHasTopLevelComma(l))
  if (!hit) return null
  return pattern(
    c,
    "join_risk",
    "warning",
    "comma-join",
    "comma-style join is an implicit CROSS JOIN",
    "`FROM a, b` (comma join) produces a cartesian product unless a WHERE ties them — fragile and easy to fan out. Use explicit `JOIN … ON`.",
    hit,
  )
}

// 37. NATURAL JOIN (joins on every same-named column — silently breaks on schema change).
const detectNaturalJoin: Detector = (c) => {
  const hit = addedHit(c, /\bnatural\s+join\b/i)
  if (!hit) return null
  return pattern(
    c,
    "join_risk",
    "warning",
    "natural-join",
    "NATURAL JOIN is fragile (joins on all same-named columns)",
    "`NATURAL JOIN` matches on every column the two sides share by name, so adding a column upstream silently changes the join. Use an explicit `ON`/`USING`.",
    hit,
  )
}

// 38. Self-join: same ref()/source() appears 2+ times.
const detectSelfJoin: Detector = (c) => {
  if (!addedHit(c, /\bjoin\b/i)) return null
  const refs = [...stripComments(c.newSql).matchAll(/\{\{\s*(ref|source)\([^)]*\)\s*\}\}/gi)].map((m) =>
    m[0].replace(/\s+/g, ""),
  )
  const dup = refs.find((r, i) => refs.indexOf(r) !== i)
  if (!dup) return null
  return pattern(
    c,
    "join_risk",
    "suggestion",
    "self-join",
    "self-join detected — verify it can't fan out",
    "The same relation is joined to itself. Self-joins are easy to get wrong (missing grain predicate → fan-out). Confirm the join keys keep it one-to-one.",
  )
}

// 39. Window function without PARTITION BY (whole-table window — often unintended).
const detectWindowNoPartition: Detector = (c) => {
  const hit = c.added.find((l) => /\bover\s*\(/i.test(stripComments(l)) && !/partition\s+by/i.test(l))
  if (!hit) return null
  return pattern(
    c,
    "sql_correctness",
    "suggestion",
    "window-no-partition",
    "window function has no PARTITION BY",
    "A window `OVER (…)` without `PARTITION BY` runs across the entire table — frequently a missing partition key that produces wrong per-group results and a full sort. Confirm whole-table is intended.",
    hit,
  )
}

// 40. BETWEEN on a timestamp/date — inclusive upper bound off-by-one.
const detectBetweenTimestamp: Detector = (c) => {
  const hit = c.added.find((l) => /\bbetween\b/i.test(stripComments(l)) && /(_at|_ts|date|timestamp|_time)\b/i.test(l))
  if (!hit) return null
  return pattern(
    c,
    "sql_correctness",
    "suggestion",
    "between-timestamp",
    "BETWEEN on a timestamp is inclusive — off-by-one risk",
    "`BETWEEN a AND b` includes the upper bound; on a timestamp this pulls in `b 00:00:00` and double-counts day boundaries. Use a half-open range (`>= a AND < b`).",
    hit,
  )
}

// 41. Exact equality against a float literal.
const detectFloatEquality: Detector = (c) => {
  const hit = c.added.find(
    (l) => /^\s*(where|and|,|select|case|when)\b/i.test(stripComments(l)) && /[<>]?=\s*-?\d+\.\d+/.test(l),
  )
  if (!hit) return null
  return pattern(
    c,
    "sql_correctness",
    "suggestion",
    "float-equality",
    "exact equality against a float literal",
    "Comparing a floating-point value with `=` is unreliable (representation error). Use a tolerance/range or a fixed-precision type.",
    hit,
  )
}

// 42. Division without a zero-guard (potential divide-by-zero).
const detectDivisionNoGuard: Detector = (c) => {
  const hit = c.added.find((l) => {
    const s = stripLiterals(stripComments(l))
    return /\/\s*[a-z_][\w.]*/i.test(s) && !/nullif|safe_divide|\/\s*\d/i.test(s)
  })
  if (!hit) return null
  return pattern(
    c,
    "sql_correctness",
    "suggestion",
    "division-no-guard",
    "division without a zero-guard",
    "Dividing by a column can throw (or yield NULL/Inf) when the denominator is 0. Wrap it: `x / nullif(y, 0)` or `safe_divide(x, y)`.",
    hit,
  )
}

// 43. AND/OR mixed in one predicate without parentheses (precedence bug).
const detectBooleanPrecedence: Detector = (c) => {
  const hit = c.added.find((l) => {
    const s = stripComments(l)
    return /^\s*(where|and|or)\b/i.test(s) && /\bor\b/i.test(s) && /\band\b/i.test(s) && !/\(/.test(s)
  })
  if (!hit) return null
  return pattern(
    c,
    "sql_correctness",
    "suggestion",
    "boolean-precedence",
    "AND/OR mixed without parentheses",
    "Mixing `AND` and `OR` in one predicate without parentheses relies on precedence (`AND` binds tighter) and is a classic logic bug. Parenthesize the intended grouping.",
    hit,
  )
}

// 44. OFFSET without ORDER BY (non-deterministic pagination).
const detectOffsetNoOrder: Detector = (c) => {
  const hit = addedHit(c, /\boffset\s+\d+/i)
  if (!hit || /\border\s+by\b/i.test(c.newSql)) return null
  return pattern(
    c,
    "sql_correctness",
    "suggestion",
    "offset-no-order",
    "OFFSET without ORDER BY is non-deterministic",
    "`OFFSET` without a stable `ORDER BY` returns arbitrary, run-varying rows. Add a deterministic ORDER BY.",
    hit,
  )
}

// 45. Multiple COUNT(DISTINCT …) in one query (expensive on big tables).
const detectMultiCountDistinct: Detector = (c) => {
  const count = (stripComments(c.added.join("\n")).match(/count\s*\(\s*distinct/gi) || []).length
  if (count < 2) return null
  return pattern(
    c,
    "warehouse_cost",
    "suggestion",
    "multi-count-distinct",
    `${count} COUNT(DISTINCT …) in one query is expensive`,
    "Multiple `COUNT(DISTINCT …)` each need their own sort/hash; on large tables this is a major cost. Consider APPROX_COUNT_DISTINCT or pre-aggregation where exactness isn't required.",
  )
}

const MODEL_DETECTORS: Detector[] = [
  detectClock,
  detectSelectStar,
  detectCrossJoin,
  detectFanout,
  detectNotIn,
  detectDedupTie,
  detectPartitionFunction,
  detectCountDistinct,
  detectPiiIntoMart,
  // extended battery
  detectDml,
  detectLimit,
  detectRandom,
  detectEqualsNull,
  detectFullRefresh,
  detectSubqueryPruning,
  detectOrderByNoLimit,
  detectLeadingWildcard,
  detectConstantJoin,
  detectHardcodedDate,
  detectTimestampToDate,
  detectHavingNoGroupBy,
  detectCaseNoElse,
  detectCommaJoin,
  detectNaturalJoin,
  detectSelfJoin,
  detectWindowNoPartition,
  detectBetweenTimestamp,
  detectFloatEquality,
  detectDivisionNoGuard,
  detectBooleanPrecedence,
  detectOffsetNoOrder,
  detectMultiCountDistinct,
]

/** Run the dbt anti-pattern detectors over a changed MODEL file. */
export function detectModelPatterns(file: ChangedFile, newSql: string | undefined, rubric: Rubric): Finding[] {
  const kind = classifyDbtFile(file.path)
  if (!isModelSql(kind) || file.status === "deleted" || !newSql) return []
  const { added, removed } = splitDiff(file.diff)
  const ctx: Ctx = {
    file,
    kind,
    newSql,
    added,
    removed,
    model: modelNameFromPath(file.path),
    inMartOrReporting: /(^|\/)(marts|reporting)\//.test(file.path),
  }
  const out: Finding[] = []
  for (const d of MODEL_DETECTORS) {
    const f = d(ctx)
    if (f) out.push({ ...f, severity: clampSeverity(f.category, f.severity, f.confidence) })
  }
  // Declarative rule catalog (data-driven checks) complements the programmatic detectors.
  out.push(...evaluateCatalog(file, newSql, added, removed, rubric))
  return out.filter((f) => !exclusionReason(f, rubric))
}

/**
 * Detect removal of `unique` / `not_null` / `relationships` tests in a schema.yml
 * diff — the guardrail that catches fan-out/dupes is the thing being deleted.
 */
/**
 * Structural extraction of `(model, column?, test)` tuples from a parsed
 * schema.yml document. Handles:
 *  - Column-level tests under `models[*].columns[*].tests` / `.data_tests`
 *  - Model-level tests directly under `models[*].tests` / `.data_tests`
 *    (surrogate-key `unique`, etc. — no column)
 *  - Sources (`sources[*].tables[*].(columns[*].)tests`) since dbt supports
 *    the same test grammar there
 *  - Snapshots (`snapshots[*].(columns[*].)tests`)
 *  - Both bare (`- unique`) and block-form (`- relationships: {...}`)
 *  - Both `tests` and `data_tests` (dbt 1.8+ alias)
 *
 * Returns a Set of canonical `${modelOrSource}\x00${column}\x00${test}` keys
 * (column is empty string for model-level tests). Yields nothing when the
 * document isn't shaped like a schema.yml.
 */
function extractTestOccurrences(doc: unknown): Set<string> {
  const out = new Set<string>()
  if (!doc || typeof doc !== "object") return out
  const d = doc as Record<string, unknown>

  const emitTests = (entity: string, column: string, tests: unknown): void => {
    if (!Array.isArray(tests)) return
    for (const t of tests) {
      const name =
        typeof t === "string"
          ? t
          : t && typeof t === "object"
            ? Object.keys(t as Record<string, unknown>)[0]
            : undefined
      if (!name) continue
      const n = name.toLowerCase()
      // Restrict to the guardrail tests the detector cares about; a bespoke
      // custom test being removed is not a signal at this level.
      if (n === "unique" || n === "not_null" || n === "relationships") {
        // PR #1027 consensus MINOR #4 — a column can carry MULTIPLE
        // `relationships` tests pointing at different parents (e.g. one to
        // dim_customers, one to legacy.dim_customers during a migration).
        // Keying on `(entity, column, test)` alone collapses them into a
        // single set entry, so dropping one silently doesn't surface.
        // `unique` / `not_null` are single-instance semantically (a repeat is
        // a no-op), so this discriminator only affects `relationships`.
        // Block-form: `- relationships: {to: ..., field: ...}` → append the
        // (to, field) tuple to the key. Bare string form: no discriminator
        // (the block-form is the shape dbt requires for `relationships`
        // anyway; a bare `- relationships` isn't a legal declaration).
        let discriminator = ""
        if (n === "relationships" && t && typeof t === "object") {
          const args = (t as Record<string, unknown>)[name]
          // dbt 1.10.5+ nests test args under `arguments:`; earlier versions
          // put them at the top level of the test's value map (cubic-review P3).
          const argsObj =
            args && typeof args === "object" ? (args as Record<string, unknown>) : undefined
          const nested =
            argsObj?.arguments && typeof argsObj.arguments === "object"
              ? (argsObj.arguments as Record<string, unknown>)
              : undefined
          const to = String((nested ?? argsObj)?.to ?? "")
          const field = String((nested ?? argsObj)?.field ?? "")
          if (to || field) discriminator = `\x01${to}\x02${field}`
        }
        out.add(`${entity}\x00${column}\x00${n}${discriminator}`)
      }
    }
  }

  const walkEntityWithColumns = (entityName: string | undefined, node: unknown): void => {
    if (!entityName || !node || typeof node !== "object") return
    const n = node as Record<string, unknown>
    // Model/source/snapshot-level tests: `tests:` or `data_tests:` right under the entity.
    emitTests(entityName, "", n.tests)
    emitTests(entityName, "", n.data_tests)
    if (Array.isArray(n.columns)) {
      for (const col of n.columns) {
        if (!col || typeof col !== "object") continue
        const c = col as Record<string, unknown>
        const cname = typeof c.name === "string" ? c.name : undefined
        if (!cname) continue
        emitTests(entityName, cname, c.tests)
        emitTests(entityName, cname, c.data_tests)
      }
    }
  }

  // `models:` — array of `{ name, columns?, tests? }`
  if (Array.isArray(d.models)) {
    for (const m of d.models) {
      if (!m || typeof m !== "object") continue
      const mm = m as Record<string, unknown>
      const mname = typeof mm.name === "string" ? mm.name : undefined
      walkEntityWithColumns(mname, mm)
    }
  }
  // `snapshots:` — same shape as models
  if (Array.isArray(d.snapshots)) {
    for (const s of d.snapshots) {
      if (!s || typeof s !== "object") continue
      const ss = s as Record<string, unknown>
      const sname = typeof ss.name === "string" ? ss.name : undefined
      walkEntityWithColumns(sname, ss)
    }
  }
  // `sources:` — `[{ name, tables: [{ name, columns?, tests? }] }]`
  if (Array.isArray(d.sources)) {
    for (const src of d.sources) {
      if (!src || typeof src !== "object") continue
      const srcObj = src as Record<string, unknown>
      const srcName = typeof srcObj.name === "string" ? srcObj.name : undefined
      if (!Array.isArray(srcObj.tables)) continue
      for (const t of srcObj.tables) {
        if (!t || typeof t !== "object") continue
        const tt = t as Record<string, unknown>
        const tname = typeof tt.name === "string" ? tt.name : undefined
        const qualified = srcName && tname ? `${srcName}.${tname}` : tname || undefined
        walkEntityWithColumns(qualified, tt)
      }
    }
  }
  // `seeds:` — leaf entity, same test grammar
  if (Array.isArray(d.seeds)) {
    for (const s of d.seeds) {
      if (!s || typeof s !== "object") continue
      const ss = s as Record<string, unknown>
      const sname = typeof ss.name === "string" ? ss.name : undefined
      walkEntityWithColumns(sname, ss)
    }
  }
  return out
}

/**
 * R20 S1 — grain-key `not_null` completeness.
 *
 * A `dbt_utils.unique_combination_of_columns` test names N columns as the
 * declared grain. If any grain column lacks `not_null` coverage, a NULL
 * grain-key silently passes the uniqueness test — the guardrail is toothless.
 * `DBT_GUIDELINES.md` in the corpus repo states this as a hard rule; kilo
 * catches it, we didn't.
 *
 * Coverage sources (either counts):
 *  - `constraints: [{type: not_null}]` on the column — enforced by the
 *    database when the model has `contract: {enforced: true}` on Trino /
 *    Databricks-with-contracts / Postgres / Snowflake.
 *  - `data_tests: [not_null]` / `tests: [not_null]` on the column —
 *    enforced by dbt test runner regardless of contract.
 *
 * Returns one gap per uncovered column per grain declaration.
 */
export interface GrainKeyGap {
  /** Model / entity name. */
  model: string
  /** Column name in the uncovered `combination_of_columns`. */
  column: string
  /** True when `config.contract.enforced == true` — coverage should be a
   *  `constraints:` entry rather than a `data_tests:` entry, since the
   *  constraint enforces at write-time and the test enforces at CI-time. */
  contractEnforced: boolean
}

/**
 * Iterate every dbt entity in a schema.yml that can carry
 * `unique_combination_of_columns` + `columns:` + `constraints:` — the shape
 * checked for grain-key not_null coverage. Models are the primary case;
 * snapshots also declare grain (SCD-2 unique_key semantics) and are a real
 * miss vector when omitted. Sources declare table-level `columns:` + tests
 * on their `tables[]` entries, so we descend one level. Seeds are covered
 * for symmetry with `extractTestOccurrences` — grain-key tests on a seed
 * are rare but legal (altimate-harness-bot review, PR #1029
 * dbt-patterns.ts:963).
 */
function iterateGrainEntities(d: Record<string, unknown>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const key of ["models", "snapshots", "seeds"] as const) {
    const arr = d[key]
    if (!Array.isArray(arr)) continue
    for (const e of arr) {
      if (e && typeof e === "object") out.push(e as Record<string, unknown>)
    }
  }
  // sources nest per-table entities under `.tables[]`; each table has its own
  // `name` + `columns` + `tests`/`data_tests`, matching the model shape.
  const sources = d.sources
  if (Array.isArray(sources)) {
    for (const s of sources) {
      if (!s || typeof s !== "object") continue
      const tables = (s as Record<string, unknown>).tables
      if (!Array.isArray(tables)) continue
      for (const t of tables) {
        if (t && typeof t === "object") out.push(t as Record<string, unknown>)
      }
    }
  }
  return out
}

/**
 * Extract the `combination_of_columns` set for each entity in a doc. Used to
 * scope grain-gap findings to entities whose grain declaration actually
 * changed between the base and head of the PR — otherwise a housekeeping
 * edit (adding a description, bumping a meta tag) surfaces every
 * pre-existing gap in the file and trains reviewers to suppress the rule
 * (altimate-harness-bot review, PR #1029 dbt-patterns.ts:1099).
 */
function extractGrainDeclarations(doc: unknown): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  if (!doc || typeof doc !== "object") return out
  const d = doc as Record<string, unknown>
  for (const mm of iterateGrainEntities(d)) {
    const name = typeof mm.name === "string" ? mm.name : undefined
    if (!name) continue
    const cols = new Set<string>()
    for (const testsKey of ["tests", "data_tests"] as const) {
      const tests = mm[testsKey]
      if (!Array.isArray(tests)) continue
      for (const t of tests) {
        if (!t || typeof t !== "object") continue
        for (const [k, args] of Object.entries(t as Record<string, unknown>)) {
          const bare = k.toLowerCase().replace(/^dbt_utils\./, "")
          if (bare !== "unique_combination_of_columns") continue
          if (!args || typeof args !== "object") continue
          const argsObj = args as Record<string, unknown>
          const nested =
            argsObj.arguments && typeof argsObj.arguments === "object"
              ? (argsObj.arguments as Record<string, unknown>)
              : undefined
          const combo =
            (nested?.combination_of_columns as unknown) ?? (argsObj.combination_of_columns as unknown)
          if (!Array.isArray(combo)) continue
          for (const c of combo) if (typeof c === "string") cols.add(c.toLowerCase())
        }
      }
    }
    if (cols.size) out.set(name, cols)
  }
  return out
}

/**
 * Entities whose grain declaration differs from old → new (added, removed,
 * or column set changed). Emit gap findings only for these entities so a
 * PR that doesn't touch grain declarations doesn't surface every
 * pre-existing gap.
 */
function grainDeclChangedEntities(oldDoc: unknown, newDoc: unknown): Set<string> {
  const oldMap = extractGrainDeclarations(oldDoc)
  const newMap = extractGrainDeclarations(newDoc)
  const changed = new Set<string>()
  for (const [name, cols] of newMap) {
    const prior = oldMap.get(name)
    if (!prior || prior.size !== cols.size || [...cols].some((c) => !prior.has(c))) changed.add(name)
  }
  return changed
}

/**
 * Grain-key not_null completeness gaps for every entity (model, snapshot,
 * source table, seed) in a schema.yml document. Callers filter by
 * `grainDeclChangedEntities` before emitting findings, so this returns the
 * full population and change-scoping happens above.
 */
function extractGrainKeyGaps(doc: unknown): GrainKeyGap[] {
  const gaps: GrainKeyGap[] = []
  if (!doc || typeof doc !== "object") return gaps
  const d = doc as Record<string, unknown>
  const entities = iterateGrainEntities(d)
  if (!entities.length) return gaps

  // Normalise column names for coverage comparison. dbt YAML often uses
  // adapter-cased column names (Snowflake folds unquoted identifiers to
  // uppercase; other adapters differ). Lowercase both sides so `ORDER_ID`
  // in `combination_of_columns` matches `order_id` in `columns:`. Hoisted
  // to function scope per consensus NIT #7 (was redeclared per-model).
  const norm = (s: string): string => s.toLowerCase()

  // Pull the string test-name from a YAML test entry. Consensus fixes:
  //  - MINOR #6: dbt's documented alternative object form is
  //    `{name: <alias>, test_name: not_null, ...}`. `Object.keys(t)[0]`
  //    would return `name`, missing the underlying test type. Prefer
  //    `test_name` when present.
  //  - MINOR #4: dbt 1.8+ allows namespaced names like `dbt.not_null`;
  //    strip a leading `dbt.` prefix so `dbt.not_null` matches `not_null`.
  // Bare form: `- not_null`. Block form: `- not_null: {config: ...}`.
  const testName = (t: unknown): string | undefined => {
    if (typeof t === "string") return t.toLowerCase().replace(/^dbt\./, "")
    if (t && typeof t === "object") {
      const obj = t as Record<string, unknown>
      // Alternative form: `{name: <alias>, test_name: <macro>, ...}`.
      // If both `name` and `test_name` are present, `test_name` wins.
      if (typeof obj.test_name === "string") return obj.test_name.toLowerCase().replace(/^dbt\./, "")
      const k = Object.keys(obj)[0]
      return k ? k.toLowerCase().replace(/^dbt\./, "") : undefined
    }
    return undefined
  }

  for (const mm of entities) {
    const mname = typeof mm.name === "string" ? mm.name : undefined
    if (!mname) continue

    // Contract enforcement: either at model-level `config.contract.enforced`
    // OR at top-level `contract:` (dbt supports both shapes). Consensus
    // MINOR #3 — earlier ternary short-circuited on `cfg.contract` being
    // an object (e.g. `config: {contract: {alias: ...}}` with no
    // `enforced` key), masking a top-level `contract: {enforced: true}`.
    // Evaluate `enforced === true` at both locations independently and OR
    // them so either declaration counts.
    const cfg = mm.config && typeof mm.config === "object" ? (mm.config as Record<string, unknown>) : {}
    const cfgContract =
      cfg.contract && typeof cfg.contract === "object" ? (cfg.contract as Record<string, unknown>) : undefined
    const topContract =
      mm.contract && typeof mm.contract === "object" ? (mm.contract as Record<string, unknown>) : undefined
    const contractEnforced = cfgContract?.enforced === true || topContract?.enforced === true

    // Coverage per column, split by mechanism (per codex R20 S1 review):
    //  - constraint coverage counts ONLY when `contract.enforced == true`.
    //    On non-contracted models, `constraints: [{type: not_null}]` is
    //    documentation-only and not enforced by the database. Requiring
    //    contract-enforced means we don't miss a real gap on views.
    //  - test coverage (`tests:` / `data_tests: [not_null]`) always counts,
    //    since dbt's test runner enforces it independent of contract state.
    //
    // Consensus MAJOR #1 — also count MODEL-LEVEL constraints:
    //  - `constraints: [{type: primary_key, columns: [a, b]}]` (dbt 1.5+)
    //    inherently enforces NOT NULL on every named column on
    //    Postgres/Snowflake/BigQuery/Databricks, so grain columns declared
    //    via a model-level PK are already covered.
    //  - `constraints: [{type: not_null, columns: [...]}]` (dbt's model-
    //    level form) — same coverage, just spelled out.
    //  - Column-level `constraints: [{type: primary_key}]` — same rationale
    //    at column granularity.
    const coveredByConstraint = new Set<string>()
    const coveredByTest = new Set<string>()

    // Model-level constraints — dbt allows a `constraints:` list under
    // the model itself (not per-column) that names one or more columns.
    if (Array.isArray(mm.constraints)) {
      for (const cn of mm.constraints) {
        if (!cn || typeof cn !== "object") continue
        const cnRec = cn as Record<string, unknown>
        const type = typeof cnRec.type === "string" ? cnRec.type.toLowerCase() : ""
        // `primary_key` implies NOT NULL on every listed column across the
        // adapters dbt supports for enforced contracts; `not_null` at
        // model level is the explicit multi-column variant of the column
        // form.
        if (type !== "not_null" && type !== "primary_key") continue
        const cols = Array.isArray(cnRec.columns) ? (cnRec.columns as unknown[]) : []
        for (const c of cols) {
          if (typeof c === "string") coveredByConstraint.add(norm(c))
        }
      }
    }

    if (Array.isArray(mm.columns)) {
      for (const col of mm.columns) {
        if (!col || typeof col !== "object") continue
        const c = col as Record<string, unknown>
        const cname = typeof c.name === "string" ? c.name : undefined
        if (!cname) continue
        const key = norm(cname)
        if (Array.isArray(c.constraints)) {
          for (const cn of c.constraints) {
            if (cn && typeof cn === "object") {
              const type = (cn as Record<string, unknown>).type
              const t = typeof type === "string" ? type.toLowerCase() : ""
              // Column-level `not_null` OR `primary_key` — the latter
              // inherently enforces NOT NULL (consensus MAJOR #1).
              if (t === "not_null" || t === "primary_key") {
                coveredByConstraint.add(key)
              }
            }
          }
        }
        for (const testsKey of ["tests", "data_tests"] as const) {
          const tests = c[testsKey]
          if (!Array.isArray(tests)) continue
          for (const t of tests) {
            if (testName(t) === "not_null") coveredByTest.add(key)
          }
        }
      }
    }
    const hasCoverage = (col: string): boolean => {
      const k = norm(col)
      return coveredByTest.has(k) || (contractEnforced && coveredByConstraint.has(k))
    }

    // Find grain declarations in this model's model-level tests / data_tests.
    // Restrict to `unique_combination_of_columns` and
    // `dbt_utils.unique_combination_of_columns` exactly (per codex R20 S1
    // review) — `endsWith` would over-match `not_unique_combination_of_columns`
    // and third-party macros that share the suffix.
    // Supports both dbt shapes:
    //   pre-1.9: `- dbt_utils.unique_combination_of_columns: {combination_of_columns: [...]}`
    //   1.9+:    `- dbt_utils.unique_combination_of_columns: {arguments: {combination_of_columns: [...]}}`
    const isGrainTestName = (name: string): boolean => {
      const n = name.toLowerCase()
      return n === "unique_combination_of_columns" || n === "dbt_utils.unique_combination_of_columns"
    }
    for (const testsKey of ["tests", "data_tests"] as const) {
      const tests = mm[testsKey]
      if (!Array.isArray(tests)) continue
      for (const t of tests) {
        if (!t || typeof t !== "object") continue
        const entry = t as Record<string, unknown>
        for (const k of Object.keys(entry)) {
          if (!isGrainTestName(k)) continue
          const args = entry[k]
          if (!args || typeof args !== "object") continue
          const argsObj = args as Record<string, unknown>
          const nested =
            argsObj.arguments && typeof argsObj.arguments === "object"
              ? (argsObj.arguments as Record<string, unknown>)
              : undefined
          const combo =
            (nested?.combination_of_columns as unknown) ?? (argsObj.combination_of_columns as unknown)
          if (!Array.isArray(combo)) continue
          for (const col of combo) {
            if (typeof col !== "string") continue
            if (!hasCoverage(col)) {
              // Preserve original grain-column spelling in the finding.
              gaps.push({ model: mname, column: col, contractEnforced })
            }
          }
        }
      }
    }
  }

  return gaps
}

/**
 * Fallback removed-test detector for callers that supply only the diff
 * (no old/new content). Kept intentionally conservative: matches removed
 * lines that look like `- unique | not_null | relationships`, subtracts any
 * added line with the same trimmed text. Cannot distinguish "moved to
 * another column" from "removed from this column" — that requires content.
 * The old-string dedup false-negative on sibling columns is inherent to
 * diff-only input; when structural content is available we use the
 * structural path (`extractTestOccurrences` diff of old vs new).
 */
function fallbackRemovedTestLines(diff: string | undefined): string[] {
  if (!diff) return []
  const added: string[] = []
  const removed: string[] = []
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+") && !raw.startsWith("+++")) added.push(raw.slice(1))
    else if (raw.startsWith("-") && !raw.startsWith("---")) removed.push(raw.slice(1))
  }
  const testLine = /^\s*-\s*(unique|not_null|relationships)\b/i
  const removedTests = removed.filter((l) => testLine.test(l))
  const addedTrim = new Set(added.map((l) => l.trim()))
  return removedTests.filter((l) => !addedTrim.has(l.trim()))
}

export interface SchemaYmlDetectContent {
  oldContent?: string
  newContent?: string
}

/**
 * Detect removed data tests in a schema.yml diff.
 *
 * PREFERRED path (production, via orchestrator): pass full old/new content in
 * `opts` — the detector parses both YAML documents, diffs by
 * `(entity, column, test)` tuples, and emits one finding per genuine removal.
 * This captures model-level tests (no column), sibling-column edge cases
 * (unique removed from column X while column Y still declares it), quoted /
 * commented YAML names, and any layout / indent style the parser accepts.
 *
 * FALLBACK path (callers that only have the raw diff, e.g. unit tests or
 * pre-collected CI diffs without a content resolver): use the string-based
 * removed-line detection preserved from the pre-R18 detector. It cannot
 * tell "removed" from "moved to another column" for the same test type on
 * a sibling column — that limitation is inherent to diff-only input.
 */
export function detectSchemaYmlPatterns(
  file: ChangedFile,
  rubric: Rubric,
  opts: SchemaYmlDetectContent = {},
): Finding[] {
  const kind = classifyDbtFile(file.path)
  if (kind !== "schema_yml") return []

  const removals: Array<{
    model: string
    column: string
    test: string
    /** Extra discriminator (e.g. `to:field` for a `relationships` test) so
     *  multiple same-named tests on one column don't collapse via ruleKey.
     *  Empty for `unique` / `not_null` and for fallback (diff-only) findings. */
    testTag?: string
  }> = []
  let usedStructural = false
  // R20 S1 — populated from the structural NEW-side parse below.
  let grainGaps: GrainKeyGap[] = []

  // Deleting a whole schema.yml removes every test declared in it — arguably
  // a bigger removal than dropping a single test. Treat the new side as empty
  // and diff the old document against `{}` so every prior test surfaces as a
  // removal (cubic-review P2). Requires `oldContent` from the caller.
  const isDeletedFile = file.status === "deleted"

  // PREFERRED: structural YAML diff when we have both sides' content.
  //
  // "Added" file case (no `oldContent` supplied AND status marks the file as
  // newly-added upstream) — the old side is empty, so there's nothing to
  // remove; using the structural path with an empty old set is correct.
  //
  // "Deleted" file case — the new side is empty; use the structural path
  // with an empty new set so every old test surfaces as a removal.
  //
  // "Modified but resolver returned undefined" case (`oldContent === undefined`
  // for a file whose status is `modified` or `renamed`) — the resolver couldn't
  // read the old side. Do NOT treat this as an added file (would silently drop
  // real removals). Fall through to the diff-only fallback below.
  const isAddedFile = file.status === "added"
  const canUseStructural =
    (isDeletedFile
      ? opts.oldContent !== undefined
      : opts.newContent !== undefined &&
        // For a real modification/rename we require both sides; without oldContent
        // fall back to diff parsing so removals in the diff still surface.
        (isAddedFile || opts.oldContent !== undefined))

  if (canUseStructural) {
    let oldDoc: unknown = undefined
    let newDoc: unknown = undefined
    if (opts.newContent !== undefined) {
      try {
        newDoc = YAML.parse(opts.newContent)
      } catch (err) {
        // Debug telemetry: YAML parsers can trip on Jinja injected into a
        // schema.yml or on non-ASCII quirks; log so failures are diagnosable
        // rather than silently demoting to the fallback path.
        Log.create({ service: "review", tag: "detectSchemaYmlPatterns" }).warn(
          `YAML.parse failed on new content of ${file.path}; falling back to diff-only detection`,
          err instanceof Error ? { error: err.message } : undefined,
        )
        newDoc = undefined
      }
    }
    if (opts.oldContent !== undefined) {
      try {
        oldDoc = YAML.parse(opts.oldContent)
      } catch (err) {
        Log.create({ service: "review", tag: "detectSchemaYmlPatterns" }).warn(
          `YAML.parse failed on old content of ${file.path}; falling back to diff-only detection`,
          err instanceof Error ? { error: err.message } : undefined,
        )
        oldDoc = undefined
      }
    }
    // Only commit to the structural path when the appropriate sides parsed:
    //  - deleted → old must parse; new is treated as `{}`
    //  - added   → new must parse; old is treated as `{}`
    //  - modified/renamed → both must parse
    // This preserves "unparseable YAML" → fallback rather than
    // "structural with empty side = every test looks removed/added".
    const canCommit = isDeletedFile
      ? oldDoc !== undefined
      : newDoc !== undefined && (isAddedFile || oldDoc !== undefined)
    if (canCommit) {
      const oldSet = extractTestOccurrences(oldDoc ?? {})
      const newSet = extractTestOccurrences(isDeletedFile ? {} : newDoc)
      for (const key of oldSet) {
        if (newSet.has(key)) continue
        const [model, column, testField] = key.split("\x00")
        // `testField` may carry a `\x01<to>\x02<field>` discriminator for
        // `relationships` tests so multiple relationships on the same column
        // don't collapse to one removal (MINOR #4). Strip it for display;
        // retain the internal `\x02` separator in `testTag` for the ruleKey
        // — a colon-joined form would collide when either arg contains `:`
        // (e.g. `to='a:b'` vs `field='b:c'`, codex R20 review minor).
        // ruleKey is hashed for fingerprinting; control chars survive.
        const [test, tagPayload] = testField.split("\x01")
        const testTag = tagPayload ?? ""
        removals.push({ model, column, test, testTag })
      }
      usedStructural = true
      // R20 S1 — grain-key `not_null` completeness. Only fire on
      // non-deleted files: a deleted schema.yml has no current grain to
      // guard. Change-scoped: only emit gaps for entities (models,
      // snapshots, source tables, seeds) whose grain declaration
      // (`combination_of_columns` set) actually changed between the base
      // and head of this PR. A housekeeping edit — adding a description,
      // bumping a meta tag — must not surface pre-existing gaps on
      // unrelated entities; that trains reviewers to suppress the rule
      // (altimate-harness-bot review, PR #1029 dbt-patterns.ts:1099).
      // When there's no old side (added file), every entity counts as
      // changed and every gap surfaces.
      if (!isDeletedFile && newDoc !== undefined) {
        const changedEntities = grainDeclChangedEntities(oldDoc, newDoc)
        grainGaps = extractGrainKeyGaps(newDoc).filter((g) => changedEntities.has(g.model))
      }
    }
  }

  // FALLBACK: line-based detection for diff-only callers (unit tests, offline
  // CI diffs) OR when the structural path couldn't parse both sides.
  //
  // No local deduplication: each entry in `removedLines` is already one match
  // per raw removed line, and model/column are always empty on this path — a
  // (model, column, test) dedup key would collapse to just `test` and silently
  // merge distinct removals of the same test type on different columns.
  //
  // Downstream, `runReview` runs a global `dedupe` step that fingerprints
  // findings by (category, file, model, column, ruleKey). Two fallback
  // findings that share `file`, empty `model`, empty `column`, and a
  // test-name-only `ruleKey` would still collapse there. We tag each fallback
  // finding with a stable occurrence-index discriminator (`#0`, `#1`, …) so
  // distinct removals in the same diff survive the global dedupe. The index
  // is per-diff, not per-file-history — sufficient for one review pass and
  // stable across dry-repeats of the same diff.
  const fallbackDiscriminators: string[] = []
  if (!usedStructural) {
    const removedLines = fallbackRemovedTestLines(file.diff)
    let idx = 0
    for (const l of removedLines) {
      const m = /^\s*-\s*(unique|not_null|relationships)\b/i.exec(l)
      if (!m) continue
      removals.push({ model: "", column: "", test: m[1].toLowerCase() })
      fallbackDiscriminators.push(`#${idx++}`)
    }
  }

  if (!removals.length && !grainGaps.length) return []

  const findings: Finding[] = []
  const isMartLayer = /(^|\/)(marts?|reporting)\//.test(file.path)
  const layerLabel = isMartLayer ? "mart-layer" : "declared"
  // Emit the "N removals across models A/B/C" summary line ONCE per file
  // (on the first finding), not once per distinct model — otherwise a diff
  // that removes tests from three models produces three copies of the same
  // global summary. A single boolean guard is enough.
  let summaryEmitted = false

  // Consumed in lock-step with the removals loop below (fallback path only).
  // Using an index avoids `shift()`, which would be O(N) per call on the
  // discriminator array — negligible on 2-3 removals but O(N²) on a large
  // schema.yml PR that drops many tests.
  let fallbackIdx = 0
  for (const r of removals) {
    const isUniquenessSignal = r.test === "unique"
    const notNullOnLikelyPK =
      r.test === "not_null" && !!r.column && /(_id$|^id$|_key$)/i.test(r.column)
    // Uniqueness OR not_null on an id/key column = warning (silent-dup / null-PK
    // risk); other not_null / relationships removals = suggestion.
    const sev: Severity = isUniquenessSignal || notNullOnLikelyPK ? "warning" : "suggestion"

    // Title / body vary based on whether structural attribution is available.
    const attributed = !!r.model && !!r.column
    const modelLevel = !!r.model && !r.column
    const filename = file.path.split("/").pop()
    const locKey = attributed ? `${r.model}.${r.column}` : modelLevel ? `${r.model} (model-level)` : "(unknown location)"
    const title = attributed
      ? `${filename}: ${r.test} test removed from ${locKey}`
      : modelLevel
        ? `${filename}: model-level ${r.test} test removed from \`${r.model}\``
        : `${filename}: ${r.test} data test removed`

    let bodyLead: string
    if (attributed) {
      bodyLead = `The \`${r.test}\` data test was removed from column \`${r.column}\` on model \`${r.model}\`. `
    } else if (modelLevel) {
      bodyLead = `A model-level \`${r.test}\` test was removed from \`${r.model}\`. `
    } else {
      bodyLead = `A \`${r.test}\` data test was removed from this schema file. `
    }
    let bodyRationale: string
    if (isUniquenessSignal) {
      bodyRationale =
        `Removing a \`unique\` test on a ${layerLabel} key is how silent duplicate rows ship — ` +
        `downstream joins fan out, aggregates double-count, and no test catches it. Restore ` +
        `the test, or explicitly document why the grain no longer needs to be unique on this column.`
    } else if (notNullOnLikelyPK) {
      bodyRationale =
        `Removing \`not_null\` on what looks like an identifier column (\`${r.column}\`) means nulls ` +
        `will slip through into downstream joins and aggregates. Restore the test unless the column ` +
        `is genuinely nullable now.`
    } else {
      bodyRationale =
        `Removing an existing data test is a silent-regression risk. Confirm the test is genuinely ` +
        `obsolete, not dropped to make CI green.`
    }
    // Emit the aggregate summary once per file, on the first finding, and
    // only when there are multiple removals to summarise. Uses the file-scoped
    // `summaryEmitted` flag rather than a per-model guard so a diff touching
    // three models emits ONE summary, not three. Distinct-models computation
    // is gated inside the branch so we don't pay for the Set/spread/map on
    // every loop iteration when the summary won't be attached.
    const shouldEmitSummary = !summaryEmitted && removals.length > 1
    let bodyTail = ""
    if (shouldEmitSummary) {
      summaryEmitted = true
      const distinctModels = [...new Set(removals.map((x) => x.model).filter(Boolean))]
      const modelClause = distinctModels.length
        ? ` on model(s) ${distinctModels.map((m) => `\`${m}\``).join(", ")}`
        : ""
      // Scoped to THIS schema file — the removals loop counts the current
      // file's removals only, not the PR's aggregate. Wording was previously
      // "This PR removes N data tests in total" which misled reviewers on
      // multi-file diffs (per PR #1027 consensus MINOR #3). A global-PR
      // summary would need to move to orchestrate.ts.
      bodyTail = `\n\n_This schema file drops ${removals.length} data tests${modelClause}._`
    }

    // ruleKey feeds the finding fingerprint (finding.ts:107). For attributed
    // (structural) findings, `(model.column.test)` is unique per removal in
    // the file. For unattributed fallback findings, `(?.?.test)` collapses
    // distinct removals of the same test type — we append the fallback
    // discriminator so each removed line becomes a distinct finding
    // downstream of the global dedupe.
    const discriminator = attributed || modelLevel ? "" : `.${fallbackDiscriminators[fallbackIdx++] ?? "#?"}`
    findings.push(
      makeFinding({
        severity: clampSeverity("test_coverage", sev, "high"),
        category: "test_coverage",
        title,
        body: bodyLead + bodyRationale + bodyTail,
        file: file.path,
        // Surface the extracted attribution on the top-level Finding so
        // downstream consumers (dedupe, formatting, telemetry) see it —
        // not just inside `evidence.result` (cubic-review P3).
        model: r.model || undefined,
        column: r.column || undefined,
        confidence: "high",
        evidence: {
          tool: "dbt-patterns",
          result: {
            rule: "removed_tests",
            model: r.model || undefined,
            column: r.column || undefined,
            test: r.test,
            attribution: attributed ? "column" : modelLevel ? "model-level" : "diff-only",
          },
        },
        // testTag suffix (`:to:field` for `relationships`) survives the global
        // finding fingerprint dedupe so multiple relationships on the same
        // column emit distinct findings (MINOR #4).
        ruleKey: `test_coverage:removed-tests:${r.model || "?"}.${r.column || "?"}.${r.test}${
          r.testTag ? `.${r.testTag}` : ""
        }${discriminator}`,
      }),
    )
  }

  // R20 S1 — grain-key `not_null` completeness. For every column in a
  // `unique_combination_of_columns` test's `combination_of_columns` that
  // lacks `not_null` coverage on the same model, emit one finding.
  // Recommendation flips between `constraints:` (contracted model) and
  // `data_tests:` (view / non-contracted model) based on the model's
  // contract state — matches the adapter-semantics discussion in the
  // corpus study (four instances across the sample).
  for (const g of grainGaps) {
    const filename = file.path.split("/").pop()
    const recommendation = g.contractEnforced
      ? `Add \`constraints: [{type: not_null}]\` to \`${g.column}\` on \`${g.model}\` (contract is \`enforced: true\` so the constraint is enforced at write-time).`
      : `Add \`not_null\` to \`${g.column}\`'s \`data_tests:\` on \`${g.model}\` (contract is not enforced, so a \`constraints:\` entry would be inert — use a data_test).`
    findings.push(
      makeFinding({
        severity: clampSeverity("test_coverage", "warning", "high"),
        category: "test_coverage",
        title: `${filename}: grain column \`${g.column}\` in unique_combination_of_columns lacks \`not_null\` on \`${g.model}\``,
        body:
          `The \`unique_combination_of_columns\` test on \`${g.model}\` names \`${g.column}\` as a grain key, but no \`not_null\` ` +
          `coverage is declared for it (either as a \`constraints:\` entry on a contracted model, or as a \`data_tests: [not_null]\` ` +
          `on a view). A NULL grain-key value silently passes the uniqueness test, so a fan-out or duplicate bug can ship without ` +
          `any test catching it. ${recommendation}`,
        file: file.path,
        model: g.model,
        column: g.column,
        confidence: "high",
        evidence: {
          tool: "dbt-patterns",
          result: {
            rule: "grain_key_not_null_missing",
            model: g.model,
            column: g.column,
            contractEnforced: g.contractEnforced,
          },
        },
        // Per-column ruleKey so the global fingerprint dedupe keeps distinct
        // grain-column gaps on the same model as separate findings.
        ruleKey: `test_coverage:grain-key-not-null:${g.model}.${g.column}`,
      }),
    )
  }

  return findings.filter((x) => !exclusionReason(x, rubric))
}
