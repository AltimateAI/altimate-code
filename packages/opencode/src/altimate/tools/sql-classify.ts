// altimate_change - SQL query classifier for write detection
//
// Uses altimate-core's AST-based getStatementTypes() for accurate classification.
// Handles CTEs, string literals, procedural blocks, all dialects correctly.
// Parser failures are never reads; lexical checks retain hard-deny protection.

import { hasMongoWriteStage, normalizeMqlCommand } from "@altimateai/drivers"
import { maskSql, statementsOf, tokenizeSql } from "./sql-tokenize"

// Safe import: napi binary may not be available on all platforms
let getStatementTypes: ((sql: string, dialect?: string | null) => any) | null = null
let extractMetadata: ((sql: string, dialect?: string | null) => any) | null = null
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
function hasQueryWriteClause(sql: string, dialect?: string): boolean {
  return /\b(INTO|INSERT|UPDATE|DELETE|MERGE)\b/i.test(maskSql(tokenizeSql(sql, dialect).tokens))
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
// Unknown bare pragmas may perform work or be added by extensions. Only known
// introspection and setting getters can skip write permission.
const READ_ONLY_BARE_PRAGMAS = new Set([
  ...READ_ONLY_PRAGMA_ARGUMENTS,
  "table_list",
  "collation_list",
  "function_list",
  "pragma_list",
  "compile_options",
  "show_tables_expanded",
  "database_size",
  "version",
  "platform",
  "quick_check",
  "user_version",
  "schema_version",
  "journal_mode",
  "foreign_keys",
  "application_id",
  "data_version",
  "encoding",
  "page_count",
  "page_size",
  "freelist_count",
])

function isReadOnlyMetadata(statement: string): boolean {
  if (READ_ONLY_OTHER_PATTERN.test(statement)) return true
  const pragma = /^\s*PRAGMA\s+(?:\w+\.)?(\w+)\s*(\([\s\S]*\))?\s*$/i.exec(statement)
  if (!pragma) return false
  const name = pragma[1].toLowerCase()
  return (pragma[2] === undefined ? READ_ONLY_BARE_PRAGMAS : READ_ONLY_PRAGMA_ARGUMENTS).has(name)
}
// EXPLAIN is a read only when the explained statement is one: `EXPLAIN ANALYZE`
// executes the statement, so `EXPLAIN ANALYZE DELETE …` must stay a write.
const EXPLAIN_PREFIX = /^\s*EXPLAIN\b(\s+(ANALYZE|VERBOSE|QUERY\s+PLAN|FORMAT\s+\w+|\([^)]*\)))*\s+/i

function isReadOnlyOther(statement: string, dialect?: string): boolean {
  if (isReadOnlyMetadata(statement)) return true
  const explained = statement.replace(EXPLAIN_PREFIX, "")
  if (explained === statement) return false
  return (
    (/^\s*(SELECT|WITH)\b/i.test(explained) && !hasQueryWriteClause(explained, dialect)) ||
    isReadOnlyMetadata(explained)
  )
}

/**
 * Check ordered parser statements independently. The parser may skip unsupported
 * statements (e.g. CHECKPOINT), so the lexical statement count must agree too.
 */
function otherIsReadOnly(sql: string, parsed: Array<{ category: string }>, dialect?: string): boolean {
  if (!tokenizeSql(sql, dialect).complete) return false
  const statements = statementsOf(sql, dialect)
  if (statements.length !== parsed.length) return false
  return parsed.every(
    (statement, i) =>
      (READ_CATEGORIES.has(statement.category) && !hasQueryWriteClause(statements[i], dialect)) ||
      (statement.category === "other" && isReadOnlyOther(statements[i], dialect)),
  )
}

// Hard-deny patterns — blocked regardless of permissions
const HARD_DENY_TYPES = new Set(["DROP DATABASE", "DROP SCHEMA", "TRUNCATE", "TRUNCATE TABLE"])

const HARD_DENY_PATTERN = /^\s*(DROP\s+(DATABASE|SCHEMA)\b|TRUNCATE(\s+TABLE)?\b)/i

/**
 * Fail closed when the parser is unavailable or rejects the input. Lexical
 * statement boundaries still enforce hard denies without reading quoted text.
 */
function classifyFallback(sql: string, dialect?: string): { queryType: "read" | "write"; blocked: boolean } {
  const statements = statementsOf(sql, dialect)
  let blocked = false
  for (const stmt of statements) {
    if (HARD_DENY_PATTERN.test(stmt)) blocked = true
  }
  return { queryType: "write", blocked }
}

/** SQL wrapped in a subquery needs independent parser proof of exactly one query. */
export function isSingleQuery(sql: string, dialect?: string): boolean {
  if (!getStatementTypes || !tokenizeSql(sql, dialect).complete) return false
  try {
    const result = getStatementTypes(sql, dialect)
    return (
      statementsOf(sql, dialect).length === 1 &&
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
export function classify(sql: string, dialect?: string): "read" | "write" {
  return classifyAndCheck(sql, dialect).queryType
}

/**
 * Classify a multi-statement SQL string.
 * Parser categories and lexical statement boundaries must agree.
 */
export function classifyMulti(sql: string, dialect?: string): "read" | "write" {
  return classify(sql, dialect)
}

/**
 * Single-pass: classify and check for hard-denied statement types.
 * Returns both the overall query type and whether a hard-deny pattern was found.
 */
export function classifyAndCheck(sql: string, dialect?: string): { queryType: "read" | "write"; blocked: boolean } {
  if (!sql || typeof sql !== "string") return { queryType: "read", blocked: false }
  if (!getStatementTypes) return classifyFallback(sql, dialect)
  try {
    const result = getStatementTypes(sql, dialect)
    if (!Array.isArray(result?.statements) || result.statement_count !== result.statements.length) {
      return classifyFallback(sql, dialect)
    }

    // A generic parser can treat MySQL arithmetic (--2) as a comment and omit
    // trailing statements. Keep dialect-aware lexical hard denies authoritative.
    const blocked =
      classifyFallback(sql, dialect).blocked ||
      result.statements.some(
        (s: { statement_type: string }) => s.statement_type && HARD_DENY_TYPES.has(s.statement_type.toUpperCase()),
      )

    return { queryType: otherIsReadOnly(sql, result.statements, dialect) ? "read" : "write", blocked }
  } catch {
    return classifyFallback(sql, dialect)
  }
}

// MongoDB commands are JSON, not SQL: the SQL classifier reads every one as a write, which denied
// 52 of 52 Mongo reads for a read-only agent in one evaluation run. Classify them by command.
const MONGO_READ_COMMANDS = new Set(["find", "aggregate", "countDocuments", "distinct", "listIndexes", "ping"])
const MONGO_BLOCKED_COMMANDS = new Set(["dropDatabase", "dropCollection"])

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
  const writesViaPipeline = hasMongoWriteStage(pipeline)
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

// DuckDB accepts catalog.table as well as catalog.schema.table. A two-part
// target is safe only for the built-in main schema; quoted names keep their dots.
function hasLocalScratchTarget(statement: string): boolean {
  const identifier = '"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*'
  const target = new RegExp(
    `^\\s*(?:CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:(?:TEMP|TEMPORARY)\\s+)?(?:TABLE|VIEW)|DROP\\s+(?:TABLE|VIEW)|ALTER\\s+TABLE|INSERT\\s+(?:OR\\s+(?:REPLACE|IGNORE)\\s+)?INTO|UPDATE|DELETE\\s+FROM)\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?((?:${identifier})(?:\\s*\\.\\s*(?:${identifier}))*)`,
    "i",
  ).exec(statement)
  if (!target) return false
  const names = target[1].match(new RegExp(identifier, "g"))!
  if (names.length > 2 || (names.length === 2 && names[0].replace(/^"|"$/g, "").toLowerCase() !== "main")) return false
  // A DROP statement can name more than one table, unlike the other forms.
  return !/^\s*DROP\b/i.test(statement) || !statement.slice(target[0].length).includes(",")
}

/**
 * True when every statement is a table/view DDL or row DML the scratch database can absorb
 * without side effects outside it. Unparseable or unknown statements are not scratch-safe.
 */
export function isScratchSafeWrite(sql: string): boolean {
  const dialect = "duckdb"
  if (!getStatementTypes || !sql || typeof sql !== "string") return false
  if (!tokenizeSql(sql, dialect).complete) return false
  try {
    const result = getStatementTypes(sql, dialect)
    const statements: Array<{ statement_type?: string }> = result?.statements ?? []
    if (statements.length === 0 || statements.length !== statementsOf(sql, dialect).length) return false
    return (
      statements.every((s) => SCRATCH_WRITE_TYPES.has(String(s.statement_type ?? "").toUpperCase())) &&
      statementsOf(sql, dialect).every(hasLocalScratchTarget)
    )
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
export function computeSqlFingerprint(sql: string, dialect?: string): SqlFingerprint | null {
  if (!getStatementTypes || !extractMetadata) return null
  try {
    const stmtResult = getStatementTypes(sql, dialect)
    const meta = extractMetadata(sql, dialect)
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
