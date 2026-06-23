import path from "node:path"
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
export function detectSchemaYmlPatterns(file: ChangedFile, rubric: Rubric): Finding[] {
  const kind = classifyDbtFile(file.path)
  if (kind !== "schema_yml" || file.status === "deleted") return []
  const { added, removed } = splitDiff(file.diff)
  const removedTests = removed.filter((l) => /^\s*-\s*(unique|not_null|relationships)\b/i.test(l))
  // A test still present (just moved) shouldn't fire.
  const addedTests = new Set(added.map((l) => l.trim()))
  const genuinelyRemoved = removedTests.filter((l) => !addedTests.has(l.trim()))
  if (!genuinelyRemoved.length) return []
  const removedUnique = genuinelyRemoved.some((l) => /\bunique\b/i.test(l))
  const f = makeFinding({
    severity: removedUnique ? "warning" : "suggestion",
    category: "test_coverage",
    title: `${file.path.split("/").pop()}: removed ${genuinelyRemoved.length} data test(s)`,
    body:
      "This change deletes `unique`/`not_null`/`relationships` test(s) — the guardrails that catch fan-out, duplicate, " +
      "and broken-FK regressions. Removing a `unique` test on a grain key is how silent duplicate bugs ship. " +
      "Confirm the test is genuinely obsolete, not removed to make CI green.",
    file: file.path,
    confidence: "high",
    evidence: {
      tool: "dbt-patterns",
      result: { rule: "removed_tests", removed: genuinelyRemoved.map((l) => l.trim()) },
    },
    ruleKey: "test_coverage:removed-tests",
  })
  return [{ ...f, severity: clampSeverity(f.category, f.severity, f.confidence) }].filter(
    (x) => !exclusionReason(x, rubric),
  )
}
