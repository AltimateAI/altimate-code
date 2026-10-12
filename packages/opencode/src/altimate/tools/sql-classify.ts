// altimate_change - SQL query classifier for write detection
//
// Uses altimate-core's AST-based getStatementTypes() for accurate classification.
// Handles CTEs, string literals, procedural blocks, all dialects correctly.
// Parser failures are never reads; lexical checks retain hard-deny protection.

import { normalizeMqlCommand } from "@altimateai/drivers"
import { maskSql, statementsOf, tokenizeSql } from "./sql-tokenize"

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
  // The parser is required to establish that SQL is a read.
}

// Only SELECT queries are known safe. "other" (SHOW, SET, USE, etc.) is ambiguous — prompt for permission.
const READ_CATEGORIES = new Set(["query"])

// The parser labels SELECT INTO and queries with modifying CTEs as "query".
// Quoted identifiers/literals and comments cannot introduce these write clauses.
function hasQueryWriteClause(sql: string): boolean {
  return /\b(INTO|INSERT|UPDATE|DELETE|MERGE)\b/i.test(maskSql(tokenizeSql(sql).tokens))
}

const READ_ONLY_OTHER_PATTERN = /^\s*(SHOW\b[^;]*|DESCRIBE\b[^;]*|DESC\b[^;]*)$/i
// Parentheses on a PRAGMA generally assign a value, just like '='. Only known
// introspection pragmas may take arguments without requesting write permission.
const READ_ONLY_PRAGMA_ARGUMENTS = new Set([
  "table_info",
  "table_xinfo",
  "index_info",
  "index_xinfo",
  "index_list",
  "foreign_key_list",
  "database_list",
  "show_tables",
  "storage_info",
  "integrity_check",
])
// These perform work even without arguments; the bare-name read exemption must
// not admit them (notably SQLite's PRAGMA optimize).
const WRITING_BARE_PRAGMAS = new Set([
  "optimize",
  "wal_checkpoint",
  "incremental_vacuum",
  "shrink_memory",
  "force_checkpoint",
  "create_fts_index",
  "drop_fts_index",
  "disable_checkpoint_on_shutdown",
  "enable_checkpoint_on_shutdown",
])

function isReadOnlyMetadata(statement: string): boolean {
  if (READ_ONLY_OTHER_PATTERN.test(statement)) return true
  const pragma = /^\s*PRAGMA\s+(?:\w+\.)?(\w+)\s*(\([\s\S]*\))?\s*$/i.exec(statement)
  if (!pragma) return false
  const name = pragma[1].toLowerCase()
  if (WRITING_BARE_PRAGMAS.has(name) || /^(enable|disable)_/.test(name)) return false
  return pragma[2] === undefined || READ_ONLY_PRAGMA_ARGUMENTS.has(name)
}
// EXPLAIN is a read only when the explained statement is one: `EXPLAIN ANALYZE`
// executes the statement, so `EXPLAIN ANALYZE DELETE …` must stay a write.
const EXPLAIN_PREFIX = /^\s*EXPLAIN\b(\s+(ANALYZE|VERBOSE|QUERY\s+PLAN|FORMAT\s+\w+|\([^)]*\)))*\s+/i

function isReadOnlyOther(statement: string): boolean {
  if (isReadOnlyMetadata(statement)) return true
  const explained = statement.replace(EXPLAIN_PREFIX, "")
  if (explained === statement) return false
  return (/^\s*(SELECT|WITH)\b/i.test(explained) && !hasQueryWriteClause(explained)) || isReadOnlyMetadata(explained)
}

/**
 * Check ordered parser statements independently. The parser may skip unsupported
 * statements (e.g. CHECKPOINT), so the lexical statement count must agree too.
 */
function otherIsReadOnly(sql: string, parsed: Array<{ category: string }>): boolean {
  if (!tokenizeSql(sql).complete) return false
  const statements = statementsOf(sql)
  if (statements.length !== parsed.length) return false
  return parsed.every(
    (statement, i) =>
      (READ_CATEGORIES.has(statement.category) && !hasQueryWriteClause(statements[i])) ||
      (statement.category === "other" && isReadOnlyOther(statements[i])),
  )
}

// Hard-deny patterns — blocked regardless of permissions
const HARD_DENY_TYPES = new Set(["DROP DATABASE", "DROP SCHEMA", "TRUNCATE", "TRUNCATE TABLE"])

const HARD_DENY_PATTERN = /^\s*(DROP\s+(DATABASE|SCHEMA)\b|TRUNCATE(\s+TABLE)?\b)/i

/**
 * Fail closed when the parser is unavailable or rejects the input. Lexical
 * statement boundaries still enforce hard denies without reading quoted text.
 */
function classifyFallback(sql: string): { queryType: "read" | "write"; blocked: boolean } {
  const statements = statementsOf(sql)
  let blocked = false
  for (const stmt of statements) {
    if (HARD_DENY_PATTERN.test(stmt)) blocked = true
  }
  return { queryType: "write", blocked }
}

/** SQL wrapped in a subquery needs independent parser proof of exactly one query. */
export function isSingleQuery(sql: string): boolean {
  if (!getStatementTypes || !tokenizeSql(sql).complete) return false
  try {
    const result = getStatementTypes(sql)
    return (
      statementsOf(sql).length === 1 &&
      result?.statement_count === 1 &&
      result.statements?.length === 1 &&
      result.statements[0].category === "query" &&
      result.categories?.length === 1 &&
      result.categories[0] === "query"
    )
  } catch {
    return false
  }
}

/**
 * Classify a SQL string as "read" or "write" using AST parsing.
 * If ANY statement is a write, returns "write".
 */
export function classify(sql: string): "read" | "write" {
  return classifyAndCheck(sql).queryType
}

/**
 * Classify a multi-statement SQL string.
 * Parser categories and lexical statement boundaries must agree.
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
    if (!Array.isArray(result?.statements) || result.statement_count !== result.statements.length) {
      return classifyFallback(sql)
    }

    const blocked = result.statements.some(
      (s: { statement_type: string }) => s.statement_type && HARD_DENY_TYPES.has(s.statement_type.toUpperCase()),
    )

    return { queryType: otherIsReadOnly(sql, result.statements) ? "read" : "write", blocked }
  } catch {
    return classifyFallback(sql)
  }
}

// MongoDB commands are JSON, not SQL: the SQL classifier reads every one as a write, which denied
// 52 of 52 Mongo reads for a read-only agent in one benchmark sweep. Classify them by command.
const MONGO_READ_COMMANDS = new Set(["find", "aggregate", "countDocuments", "distinct", "listIndexes", "ping"])
const MONGO_BLOCKED_COMMANDS = new Set(["dropDatabase", "dropCollection"])
const MONGO_WRITE_STAGES = new Set(["$out", "$merge"])

/**
 * Classify a MongoDB command document (native `{"find": "coll"}` or `{command, collection}` shape).
 * Returns null when the text is not a JSON object, so SQL classification applies instead.
 */
export function classifyMongoCommand(
  query: string,
): { queryType: "read" | "write"; blocked: boolean; normalized: string } | null {
  const trimmed = query.trim()
  if (!trimmed.startsWith("{")) return null
  let parsed: Record<string, unknown>
  try {
    parsed = normalizeMqlCommand(JSON.parse(trimmed))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const command = String(parsed["command"] ?? "")
  const pipeline = Array.isArray(parsed["pipeline"]) ? (parsed["pipeline"] as unknown[]) : []
  const writesViaPipeline = pipeline.some(
    (stage) => stage && typeof stage === "object" && Object.keys(stage as object).some((k) => MONGO_WRITE_STAGES.has(k)),
  )
  const read = MONGO_READ_COMMANDS.has(command) && !writesViaPipeline
  return { queryType: read ? "read" : "write", blocked: MONGO_BLOCKED_COMMANDS.has(command), normalized: JSON.stringify(parsed) }
}

// Writes confined to the session's ephemeral scratch database: table/view DDL and row DML.
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
  if (!tokenizeSql(sql).complete) return false
  try {
    const result = getStatementTypes(sql)
    const statements: Array<{ statement_type?: string }> = result?.statements ?? []
    if (statements.length === 0 || statements.length !== statementsOf(sql).length) return false
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
