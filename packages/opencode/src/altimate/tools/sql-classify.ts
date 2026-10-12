// altimate_change - SQL query classifier for write detection
//
// Uses altimate-core's AST-based getStatementTypes() for accurate classification.
// Handles CTEs, string literals, procedural blocks, all dialects correctly.
// Falls back to regex-based heuristics if the napi binary fails to load.

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

// Metadata statements the parser files under "other" but which cannot modify data:
// SHOW / DESCRIBE, and read-only PRAGMAs (a bare pragma or a pragma with a
// parenthesised argument; `PRAGMA x = value` is an assignment and stays "write").
// Without this, a read-only agent is hard-denied from listing tables on DuckDB/SQLite.
const READ_ONLY_OTHER_PATTERN = /^\s*(SHOW\b[^;]*|DESCRIBE\b[^;]*|DESC\b[^;]*|PRAGMA\s+[\w.]+(\s*\([^)]*\))?\s*)$/i
// EXPLAIN is a read only when the explained statement is one: `EXPLAIN ANALYZE`
// executes the statement, so `EXPLAIN ANALYZE DELETE …` must stay a write.
const EXPLAIN_PREFIX = /^\s*EXPLAIN\b(\s+(ANALYZE|VERBOSE|QUERY\s+PLAN|FORMAT\s+\w+|\([^)]*\)))*\s+/i

function isReadOnlyOther(statement: string): boolean {
  if (READ_ONLY_OTHER_PATTERN.test(statement)) return true
  const explained = statement.replace(EXPLAIN_PREFIX, "")
  if (explained === statement) return false
  return /^\s*(SELECT|WITH)\b/i.test(explained) || READ_ONLY_OTHER_PATTERN.test(explained)
}

/** Split on statement boundaries after stripping comments; mirrors the fallback classifier. */
function statementsOf(sql: string): string[] {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * "other"-category statements are reads only when every statement in the input is
 * either a plain query or a metadata statement matched by READ_ONLY_OTHER_PATTERN.
 */
function otherIsReadOnly(sql: string, categories: string[]): boolean {
  if (!categories.every((c) => c === "query" || c === "other")) return false
  const statements = statementsOf(sql)
  if (statements.length === 0) return false
  return statements.every((s) => READ_PATTERN.test(s) || isReadOnlyOther(s))
}

// Hard-deny patterns — blocked regardless of permissions
const HARD_DENY_TYPES = new Set(["DROP DATABASE", "DROP SCHEMA", "TRUNCATE", "TRUNCATE TABLE"])

// Regex fallback: conservative — only known-safe reads are whitelisted, everything else is "write"
// Plain queries. Metadata statements (SHOW/DESCRIBE/read-only PRAGMA) and EXPLAIN of a
// read are handled by isReadOnlyOther(), so an explained write cannot slip through here.
const READ_PATTERN = /^\s*(SELECT|WITH)\b/i
const HARD_DENY_PATTERN =
  /^\s*(DROP\s+(DATABASE|SCHEMA)\b|TRUNCATE(\s+TABLE)?\b)/i

/**
 * Regex-based fallback classifier for when altimate-core is unavailable.
 * Conservative: treats anything not clearly a SELECT/WITH, a metadata statement, or an EXPLAIN of one as "write".
 * Handles multi-statement SQL by splitting on semicolons and checking each statement.
 */
function classifyFallback(sql: string): { queryType: "read" | "write"; blocked: boolean } {
  const cleaned = sql
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/--[^\n]*/g, "")          // line comments
  const statements = cleaned.split(";").map(s => s.trim()).filter(Boolean)
  if (statements.length === 0) return { queryType: "read", blocked: false }
  let queryType: "read" | "write" = "read"
  let blocked = false
  for (const stmt of statements) {
    if (HARD_DENY_PATTERN.test(stmt)) blocked = true
    if (!READ_PATTERN.test(stmt) && !isReadOnlyOther(stmt)) queryType = "write"
  }
  return { queryType, blocked }
}

/**
 * Classify a SQL string as "read" or "write" using AST parsing.
 * If ANY statement is a write, returns "write".
 */
export function classify(sql: string): "read" | "write" {
  if (!sql || typeof sql !== "string") return "read"
  if (!getStatementTypes) return classifyFallback(sql).queryType
  try {
    const result = getStatementTypes(sql)
    if (!result?.categories?.length) return "read"
    if (otherIsReadOnly(sql, result.categories)) return "read"
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
export function classifyAndCheck(sql: string): { queryType: "read" | "write"; blocked: boolean } {
  if (!sql || typeof sql !== "string") return { queryType: "read", blocked: false }
  if (!getStatementTypes) return classifyFallback(sql)
  try {
    const result = getStatementTypes(sql)
    if (!result?.statements?.length) return { queryType: "read", blocked: false }

    const blocked = result.statements.some(
      (s: { statement_type: string }) =>
        s.statement_type && HARD_DENY_TYPES.has(s.statement_type.toUpperCase()),
    )

    const categories = result.categories ?? []
    const queryType =
      otherIsReadOnly(sql, categories) || !categories.some((c: string) => !READ_CATEGORIES.has(c)) ? "read" : "write"
    return { queryType: queryType as "read" | "write", blocked }
  } catch {
    return classifyFallback(sql)
  }
}

// Writes confined to the session's in-memory scratch database: table/view DDL and row DML.
// Anything that can reach outside the engine — COPY … TO a file, ATTACH, INSTALL/LOAD,
// EXPORT, SET/PRAGMA — is deliberately absent and keeps needing write permission.
const SCRATCH_WRITE_TYPES = new Set([
  "CREATE TABLE",
  "CREATE VIEW",
  "DROP TABLE",
  "DROP VIEW",
  "ALTER TABLE",
  "INSERT",
  "UPDATE",
  "DELETE",
])

/**
 * True when every statement is a table/view DDL or row DML the scratch database can absorb
 * without side effects outside it. Unparseable or unknown statements are not scratch-safe.
 */
export function isScratchSafeWrite(sql: string): boolean {
  if (!getStatementTypes || !sql || typeof sql !== "string") return false
  try {
    const result = getStatementTypes(sql)
    const statements: Array<{ statement_type?: string }> = result?.statements ?? []
    if (statements.length === 0) return false
    return statements.every((s) => SCRATCH_WRITE_TYPES.has(String(s.statement_type ?? "").toUpperCase()))
  } catch {
    return false
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
