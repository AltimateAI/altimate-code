// altimate_change - SQL query classifier for write detection
//
// Uses altimate-core's AST-based getStatementTypes() for accurate classification.
// Handles CTEs, string literals, procedural blocks, all dialects correctly.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const core: any = require("@altimateai/altimate-core")

// Categories from altimate-core that indicate write operations
const WRITE_CATEGORIES = new Set(["dml", "ddl", "dcl", "tcl"])
// Only SELECT queries are known safe. "other" (SHOW, SET, USE, etc.) is ambiguous — prompt for permission.
const READ_CATEGORIES = new Set(["query"])

// Hard-deny patterns — blocked regardless of permissions
const HARD_DENY_TYPES = new Set(["DROP DATABASE", "DROP SCHEMA", "TRUNCATE", "TRUNCATE TABLE"])

/**
 * Classify a SQL string as "read" or "write" using AST parsing.
 * If ANY statement is a write, returns "write".
 */
export function classify(sql: string): "read" | "write" {
  const result = core.getStatementTypes(sql)
  if (!result?.categories?.length) return "read"
  // Treat unknown categories (not in WRITE or READ sets) as write to fail safe
  return result.categories.some((c: string) => !READ_CATEGORIES.has(c)) ? "write" : "read"
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
  const result = core.getStatementTypes(sql)
  if (!result?.statements?.length) return { queryType: "read", blocked: false }

  const blocked = result.statements.some((s: { statement_type: string }) =>
    s.statement_type && HARD_DENY_TYPES.has(s.statement_type.toUpperCase()),
  )

  const categories = result.categories ?? []
  // Unknown categories (not in WRITE or READ sets) are treated as write to fail safe
  const queryType = categories.some((c: string) => !READ_CATEGORIES.has(c)) ? "write" : "read"
  return { queryType: queryType as "read" | "write", blocked }
}
