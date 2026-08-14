// altimate_change - SQL query classifier for write detection
//
// Uses altimate-core's AST-based getStatementTypes() for accurate classification.
// Handles CTEs, string literals, procedural blocks, all dialects correctly.
// Falls back to regex-based heuristics if the napi binary fails to load.

import { maskLiteralsAndComments } from "./sql-text-mask"

// Safe import: napi binary may not be available on all platforms
let getStatementTypes: ((sql: string, dialect?: string | null) => any) | null = null
let extractMetadata: ((sql: string) => any) | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const core = require("@altimateai/altimate-core")
  if (typeof core?.getStatementTypes === "function") {
    getStatementTypes = core.getStatementTypes
  }
  if (typeof core?.extractMetadata === "function") {
    extractMetadata = core.extractMetadata
  }
} catch {
  // napi binary failed to load — will use regex fallback
}

// Only SELECT queries are known safe. "other" (SHOW, SET, USE, etc.) is ambiguous — prompt for permission.
const READ_CATEGORIES = new Set(["query"])

// Hard-deny patterns — blocked regardless of permissions
const HARD_DENY_TYPES = new Set(["DROP DATABASE", "DROP SCHEMA", "TRUNCATE", "TRUNCATE TABLE"])

// Regex fallback: conservative — only known-safe reads are whitelisted, everything else is "write"
const READ_PATTERN = /^\s*(SELECT|WITH|SHOW|EXPLAIN|DESCRIBE|DESC)\b/i
const HARD_DENY_PATTERN =
  /^\s*(DROP\s+(DATABASE|SCHEMA)\b|TRUNCATE(\s+TABLE)?\b)/i

/**
 * Regex-based fallback classifier for when altimate-core is unavailable.
 * Conservative: treats anything not clearly a SELECT/WITH/SHOW/EXPLAIN as "write".
 * Handles multi-statement SQL by splitting on semicolons and checking each statement.
 */
function classifyFallback(sql: string): { queryType: "read" | "write"; blocked: boolean } {
  // Use the single-pass lexer, NOT ordered regexes: comments-first stripping
  // is bypassable via comment markers inside string literals (e.g.
  // `SELECT '--' LIMIT 1; DELETE FROM users` would reduce to `SELECT '`).
  // Unlexable SQL fails closed as a write.
  const cleaned = maskLiteralsAndComments(sql)
  if (cleaned === null) return { queryType: "write", blocked: false }
  const statements = cleaned.split(";").map(s => s.trim()).filter(Boolean)
  if (statements.length === 0) return { queryType: "read", blocked: false }
  // A read-shaped PREFIX is not proof: `WITH x AS (SELECT 1) DELETE FROM u`
  // and `EXPLAIN ANALYZE DELETE FROM u` start like reads but execute writes
  // (and PostgreSQL EXPLAIN ANALYZE always executes). Any write keyword in the
  // masked statement body forces "write" — the safe direction is a prompt.
  const WRITE_KEYWORD =
    /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|vacuum|into)\b/i
  // replace/copy/call/set double as read-only functions (REPLACE(str,..)); only
  // the statement form (not immediately followed by `(`) counts as a write.
  const WRITE_STATEMENT_FORM = /\b(replace|copy|call|set)\b(?!\s*\()/i
  let queryType: "read" | "write" = "read"
  let blocked = false
  for (const stmt of statements) {
    if (HARD_DENY_PATTERN.test(stmt)) blocked = true
    if (!READ_PATTERN.test(stmt) || WRITE_KEYWORD.test(stmt) || WRITE_STATEMENT_FORM.test(stmt)) queryType = "write"
  }
  return { queryType, blocked }
}

/**
 * Side-effecting functions that mutate warehouse state from inside a
 * read-shaped SELECT. AST statement categories cannot see these — a
 * `SELECT dblink_exec(...)` or `SELECT nextval(...)` parses as a read — so
 * they are matched against MASKED SQL (string literals and comments removed
 * by a single-pass lexer) and escalate the classification to "write", routing
 * the statement through the sql_execute_write permission.
 *
 * Masking first is load-bearing in both directions: a block comment wedged
 * between the function name and the open paren collapses so the call is
 * still detected, and the names appearing inside string literals or comments
 * no longer false-positive. Word boundary + `(` keeps column names like
 * `nextval_cache` unaffected. An unlexable statement (unterminated construct,
 * backslash-escape ambiguity) fails closed as a write.
 */
const SIDE_EFFECT_FUNCTIONS =
  /\b(nextval|setval|dblink_exec|dblink|pg_terminate_backend|pg_cancel_backend|lo_import|lo_export|lo_unlink|pg_reload_conf|pg_rotate_logfile)\s*\(/i

// Quoted-identifier call form: `SELECT "lo_import"('/tmp/x')` (or the
// `backtick`/[bracket] dialect variants) is a valid invocation. Checked
// against the identifier-PRESERVING mask (comments and string literals
// removed, quoted-identifier content kept): raw-SQL matching would miss a
// comment wedged between the quote and the paren (`"lo_import"/**/(...)`),
// while the default mask blanks the name entirely. On the preserved-id mask
// the wedge collapses to whitespace and the delimited name survives.
const QUOTED_SIDE_EFFECT =
  /["`[](nextval|setval|dblink_exec|dblink|pg_terminate_backend|pg_cancel_backend|lo_import|lo_export|lo_unlink|pg_reload_conf|pg_rotate_logfile)["`\]]\s*\(/i

function hasSideEffectFunction(sql: string): boolean {
  const masked = maskLiteralsAndComments(sql)
  if (masked === null) return true
  if (SIDE_EFFECT_FUNCTIONS.test(masked)) return true
  const maskedWithIds = maskLiteralsAndComments(sql, { preserveQuotedIdentifiers: true })
  if (maskedWithIds === null) return true
  return QUOTED_SIDE_EFFECT.test(maskedWithIds)
}

/**
 * Normalize CR / CRLF to LF before any classification. The AST engine and the
 * fallback both treat `--` comments as running to the next LF; a CR-only line
 * ending would otherwise let a comment visually "end" while the classifier
 * still considers everything after it commented out — hiding a following
 * statement from write detection.
 */
function normalizeNewlines(sql: string): string {
  return sql.replace(/\r\n?/g, "\n")
}

/**
 * Classify a SQL string as "read" or "write" using AST parsing.
 * If ANY statement is a write, returns "write".
 */
export function classify(rawSql: string): "read" | "write" {
  if (!rawSql || typeof rawSql !== "string") return "read"
  const sql = normalizeNewlines(rawSql)
  if (hasSideEffectFunction(sql)) return "write"
  if (!getStatementTypes) return classifyFallback(sql).queryType
  try {
    const result = getStatementTypes(sql)
    if (!result?.categories?.length) return "read"
    return result.categories.some((c: string) => !READ_CATEGORIES.has(c)) ? "write" : "read"
  } catch {
    return classifyFallback(sql).queryType
  }
}

/**
 * Classify a multi-statement SQL string.
 * getStatementTypes handles multi-statement natively — no semicolon splitting needed.
 */
export function classifyMulti(sql: string): "read" | "write" {
  return classify(sql)
}

/**
 * Single-pass: classify and check for hard-denied statement types.
 * Returns both the overall query type and whether a hard-deny pattern was found.
 */
export function classifyAndCheck(rawSql: string): { queryType: "read" | "write"; blocked: boolean } {
  if (!rawSql || typeof rawSql !== "string") return { queryType: "read", blocked: false }
  const sql = normalizeNewlines(rawSql)
  const sideEffect = hasSideEffectFunction(sql)
  if (!getStatementTypes) {
    const fb = classifyFallback(sql)
    return sideEffect ? { ...fb, queryType: "write" } : fb
  }
  try {
    const result = getStatementTypes(sql)
    if (!result?.statements?.length) return { queryType: sideEffect ? "write" : "read", blocked: false }

    const blocked = result.statements.some(
      (s: { statement_type: string }) =>
        s.statement_type && HARD_DENY_TYPES.has(s.statement_type.toUpperCase()),
    )

    const categories = result.categories ?? []
    const queryType =
      sideEffect || categories.some((c: string) => !READ_CATEGORIES.has(c)) ? "write" : "read"
    return { queryType: queryType as "read" | "write", blocked }
  } catch {
    const fb = classifyFallback(sql)
    return sideEffect ? { ...fb, queryType: "write" } : fb
  }
}

// altimate_change start — SQL structure fingerprint for telemetry (no content, only shape)
export interface SqlFingerprint {
  statement_types: string[]
  categories: string[]
  table_count: number
  function_count: number
  has_subqueries: boolean
  has_aggregation: boolean
  has_window_functions: boolean
  node_count: number
}

/** Compute a PII-safe structural fingerprint of a SQL query.
 *  Uses altimate-core AST parsing — local, no API calls, ~1-5ms. */
export function computeSqlFingerprint(sql: string): SqlFingerprint | null {
  if (!getStatementTypes || !extractMetadata) return null
  try {
    const stmtResult = getStatementTypes(sql)
    const meta = extractMetadata(sql)
    return {
      statement_types: stmtResult?.types ?? [],
      categories: stmtResult?.categories ?? [],
      table_count: meta?.tables?.length ?? 0,
      function_count: meta?.functions?.length ?? 0,
      has_subqueries: meta?.has_subqueries ?? false,
      has_aggregation: meta?.has_aggregation ?? false,
      has_window_functions: meta?.has_window_functions ?? false,
      node_count: meta?.node_count ?? 0,
    }
  } catch {
    return null
  }
}
// altimate_change end
