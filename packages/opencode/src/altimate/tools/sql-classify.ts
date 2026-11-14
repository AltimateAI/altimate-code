// altimate_change - SQL query classifier for write detection
//
// Uses altimate-core's AST-based getStatementTypes() for accurate classification.
// Handles CTEs, string literals, procedural blocks, all dialects correctly.
// Parser failures are never reads; lexical checks retain hard-deny protection.

import { hasMongoWriteStage, normalizeMqlCommand } from "@altimateai/drivers"
import { isModeledDialect, maskSql, statementsOf, tokenizeSql } from "./sql-tokenize"
import { sqlFunctionCalls, sqlLiteral } from "./sql-functions"
import { hasSideEffectFunction, isReadOnlyNestedFunction } from "./sql-function-policy"

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

/** Adapt read/write-equivalent syntax for the bundled parser, never for execution.
 * Only code tokens change; quoted content and the original statement boundaries
 * remain authoritative when checking the parser's result. */
function parserSql(sql: string, dialect?: string): string {
  const duckdb = dialect?.toLowerCase() === "duckdb"
  if (!duckdb && dialect?.toLowerCase() !== "sqlite") return sql
  const compatible = tokenizeSql(sql, dialect).tokens
    .map(({ kind, text }) => {
      if (kind !== "code") return text
      // The parser supports LIKE negation but not GLOB negation. Both are predicates.
      text = text.replace(/\bNOT\s+GLOB\b/gi, "NOT LIKE")
      if (!duckdb) return text
      // SQLite uses / for integer operands; // is a DuckDB operator. PRIOR is
      // an ordinary DuckDB identifier, not the parser's hierarchical operator.
      return text.replaceAll("//", "/ ").replace(/\bprior(?=\s*\.)/gi, '"prior"')
    })
    .join("")
  if (!duckdb) return compatible
  // The native parser recognizes these query bodies inside a derived table,
  // but reports their standalone form as UNKNOWN. Parse every body in full.
  const statements = statementsOf(compatible, dialect)
  const adapted = statements.map((statement) =>
    /^\s*(PIVOT|UNPIVOT|WITH)\b/i.test(statement) && /\b(PIVOT|UNPIVOT)\b/i.test(maskSql(tokenizeSql(statement, dialect).tokens))
      ? `SELECT * FROM (${statement})`
      : statement,
  )
  return adapted.some((statement, index) => statement !== statements[index]) ? adapted.join("; ") : compatible
}

/** Mask only UNPIVOT output labels at their own query depth, retaining SELECT INTO. */
function maskUnpivotLabels(sql: string): string {
  const heads: string[] = []
  const unpivots = new Set<number>()
  let depth = 0
  let previous = ""
  return sql.replace(/\(|\)|\bINTO\s+NAME\b|\b[A-Z_][A-Z_0-9]*\b/gi, (token) => {
    const word = token.toUpperCase()
    if (word === "(") depth++
    else if (word === ")") {
      delete heads[depth]
      unpivots.delete(depth--)
    } else if (word === "UNPIVOT" && (!heads[depth] || (heads[depth] === "WITH" && previous === ")"))) {
      unpivots.add(depth)
      heads[depth] = word
    } else if (/^INTO\s+NAME$/.test(word) && unpivots.delete(depth)) {
      return " ".repeat(token.length)
    } else if (!heads[depth] || (heads[depth] === "WITH" && /^(SELECT|VALUES|TABLE|PIVOT|INSERT|UPDATE|DELETE|MERGE)$/.test(word))) {
      heads[depth] = word
    }
    previous = word
    return token
  })
}

// The parser labels SELECT INTO and queries with modifying CTEs as "query".
// Quoted identifiers/literals and comments cannot introduce these write clauses.
function hasQueryWriteClause(sql: string, dialect?: string): boolean {
  let masked = maskSql(tokenizeSql(sql, dialect).tokens)
  // UNPIVOT's INTO NAME labels output columns; it does not create a table.
  if (dialect?.toLowerCase() === "duckdb") masked = maskUnpivotLabels(masked)
  return /\b(INTO|INSERT|UPDATE|DELETE|MERGE)\b/i.test(masked)
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

const HARD_DENY_PATTERN = /^\s*(DROP\s+((EXTERNAL|PLUGGABLE)\s+)?(DATABASE|SCHEMA|CATALOG|NAMESPACE)\b|TRUNCATE(\s+TABLE)?\b)/i

/**
 * Fail closed when the parser is unavailable or rejects the input. Lexical
 * statement boundaries still enforce hard denies without reading quoted text.
 */
function classifyFallback(sql: string, dialect?: string, write = true): { queryType: "read" | "write"; blocked: boolean } {
  const statements = statementsOf(sql, dialect)
  // Executable comments can contain entire statements or fragments of a hard
  // deny. Reject them outright because generic parsers discard their bodies.
  let blocked = tokenizeSql(sql, dialect).tokens.some(
    ({ kind, text }) => kind === "comment" && /^\/\*(?:!|[mM]!)/.test(text),
  )
  for (const stmt of statements) {
    if (HARD_DENY_PATTERN.test(stmt)) blocked = true
  }
  // When quoting or comments cannot be read with certainty, no reading of the literals or comments
  // can be trusted to hide a hard deny (a misread literal can make a real statement look like a
  // comment), so the words alone decide; the TRUNCATE() function does not count.
  const lexical = tokenizeSql(sql, dialect)
  if (!lexical.complete) {
    // Escapes decoded too: dynamic SQL may run a literal such as '\x44ROP SCHEMA s'.
    if (mentionsHardDenyAnywhere(sql)) blocked = true
  } else {
    // Read with certainty: the statement words in code (literals and comments masked, each quoted
    // identifier a placeholder name, so DROP/**/SCHEMA reads as DROP SCHEMA) decide too, since T-SQL runs `SELECT 1 DROP DATABASE x`
    // as two statements with no ; and a parser may read a literal differently from the engine.
    const names = namesKept(lexical.tokens)
    // Snowflake's ->> chains statements (elsewhere a JSON operator), and Snowflake Scripting's ASYNC (,
    // := ( and DEFAULT ( hold one (elsewhere DEFAULT(col) is a function).
    const chained =
      (/^snowflake$/i.test(dialect ?? "") || !isModeledDialect(dialect)) &&
      /(->>|\bASYNC\s*\(|:=\s*\(|\bDEFAULT\s*\()\s*TRUNCATE\b(?!\s*\()/i.test(names)
    if (CODE_HARD_DENY.test(names) || handlerTruncate(names) || chained || (write && WRITE_TRUNCATE.test(names)))
      blocked = true
  }
  return { queryType: "write", blocked }
}

/** Where statements need no separator (T-SQL) or the dialect is not one the lexer models, a read
 * must hold no statement keyword in its code (literals, identifiers and comments masked): the
 * engine would run `SELECT ... DELETE FROM t` as two statements however a parser reads it. */
function batchedStatement(masked: string, dialect?: string): boolean {
  return (/^(sqlserver|tsql|mssql|fabric)$/i.test(dialect ?? "") || !isModeledDialect(dialect)) && BATCH_STATEMENT.test(masked)
}

// T-SQL statements that can follow a read in the same batch. Words that are also common column names
// or clauses (USE, FETCH, OPEN, CLOSE, ENABLE, DISABLE, RENAME, THROW, ADD, MOVE, SEND, RECEIVE, END)
// count only in their statement forms.
const BATCH_STATEMENT = new RegExp(
  "\\bTRUNCATE\\b(?!\\s*\\()|\\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|EXEC|EXECUTE|GRANT|REVOKE|DENY|BACKUP|RESTORE|DBCC|KILL|SHUTDOWN|BULK|WAITFOR|DECLARE|SET|INTO|" +
    "OPENROWSET|OPENQUERY|OPENDATASOURCE|OPENXML|CHECKPOINT|RECONFIGURE|RAISERROR|GOTO|BEGIN|COMMIT|ROLLBACK|SAVE|DEALLOCATE|" +
    "READTEXT|UPDATETEXT|WRITETEXT|SETUSER|REVERT|PRINT)\\b" +
    "|\\b(ENABLE|DISABLE)\\s+TRIGGER\\b|\\bRENAME\\s+(OBJECT|DATABASE)\\b|\\bTHROW\\s+[\\d@]" +
    // USE except OPTION (USE HINT/PLAN) and USE INDEX; FETCH except OFFSET paging (FETCH NEXT 10 ROWS ONLY).
    "|\\bUSE\\b(?!\\s+(HINT|PLAN|INDEX|KEY)\\b)|\\bFETCH\\b(?!\\s+(FIRST|NEXT)\\s+([\\w@().+-]+\\s+)?(PERCENT\\s+)?ROWS?\\b)" +
    "|\\b(OPEN|CLOSE)\\s+(GLOBAL\\s+)?[\\w@#]+\\s*(;|\\b(SELECT|WITH)\\b)|\\bADD\\s+(SENSITIVITY|SIGNATURE|COUNTER)\\b" +
    "|\\bMOVE\\s+CONVERSATION\\b|\\bSEND\\s+ON\\b|\\bRECEIVE\\s+(TOP\\b|\\*|\\w+\\s+FROM\\b)|\\bEND\\s+CONVERSATION\\b",
  "i",
)

/** A literal's text as an engine may run it, one string per reading: numeric escapes (\xHH, \uHHHH,
 * \UHHHHHHHH, octal \ooo, U&'...' \HHHH and \+HHHHHH) decoded, and a single-character escape read as a
 * space when it stands for whitespace (\n \r \t \f, and \v in BigQuery) and as itself otherwise;
 * and SQL Server's reading, where a backslash before a line break joins the two lines. */
function escapeReadings(sql: string): string[] {
  const char = (hex: string, base = 16) => String.fromCodePoint(Math.min(parseInt(hex, base), 0x10ffff))
  let numeric = sql
  if (/U&/i.test(numeric)) numeric = numeric.replace(/\\\+([0-9a-fA-F]{6})|\\([0-9a-fA-F]{4})/g, (_, six, four) => char(six ?? four))
  const decode = (whitespace: RegExp) =>
    numeric.replace(
      /\\(?:x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|([0-7]{1,3})|([\s\S]))/g,
      (_, x, u, U, octal, single) =>
        single !== undefined ? (whitespace.test(single) ? " " : single) : octal ? char(octal, 8) : char(x ?? u ?? U),
    )
  return [sql, sql.replace(/\\\r?\n/g, ""), decode(/^[nrtf]$/), decode(/^[nrtfv]$/)]
}

// TRUNCATE as a statement: TRUNCATE TABLE, or TRUNCATE starting a statement or a block (BEGIN [NOT
// ATOMIC], DO, LOOP, REPEAT, a handler's condition). After THEN or ELSE it must be a name and the end
// of the statement, since CASE ... THEN truncate ... is a column. In a read, a column or alias named truncate is not.
const CODE_HARD_DENY = new RegExp(
  "\\bDROP\\s+((EXTERNAL|PLUGGABLE)\\s+)?(DATABASE|SCHEMA|CATALOG|NAMESPACE)\\b|\\bTRUNCATE\\s+TABLE\\b" +
    // DuckDB accepts TRUNCATE after EXPLAIN (options), PREPARE p AS and as a CTE body, WITH x AS
    // [[NOT] MATERIALIZED] (TRUNCATE t) ([^()] keeps the scan linear).
    "|(^|;|\\bPREPARE\\s+\\w+\\s+AS\\b|\\bEXPLAIN\\s*\\([^()]*\\)|\\bAS\\s*((NOT\\s+)?MATERIALIZED\\s*)?\\()\\s*TRUNCATE\\b(?!\\s*\\()" +
    // After a block or handler word (or EXPLAIN ANALYZE), a target must follow: these words are also
    // column names, so `SELECT atomic truncate FROM t` is an alias.
    "|\\b(BEGIN|NOT\\s+ATOMIC|DO|LOOP|REPEAT|SQLEXCEPTION|SQLWARNING|FOUND|ANALYZE|ANALYSE)\\s+TRUNCATE\\s+" +
    "(?!(FROM|AS|WHERE|ORDER|GROUP|HAVING|UNION|LIMIT|WINDOW|INTO|JOIN|ON|AND|OR|END)\\b)[\\w\"`$\\u0080-\\uffff]" +
    // After THEN/ELSE: [IF EXISTS] a (dotted, quoted or IDENTIFIER(...)) name, then the statement's end.
    "|\\b(THEN|ELSE)\\s+TRUNCATE\\s+(IF\\s+EXISTS\\s+)?(?!END\\b)" +
    "(IDENTIFIER\\s*\\([^()]*\\)|[^\\s;,().]+(\\s*\\.{1,2}\\s*[^\\s;,().]+)*)(\\s+(NOWAIT|WAIT\\s+\\d+))?\\s*(;|$)",
  "i",
)

// In a write, TRUNCATE is a statement wherever it sits (a routine or task body, ALTER TABLE ... TRUNCATE
// PARTITION), so any unqualified TRUNCATE not followed by `(` (the function) counts. A column named
// truncate is exempt only in a read, which holds no statement body.
const WRITE_TRUNCATE = /\bTRUNCATE\b(?<!\.\s*TRUNCATE)(?!\s*\()/i

/** A handler's statement follows its conditions (a code, SQLSTATE '...', a name): a TRUNCATE after
 * HANDLER FOR within the same statement counts. One pass over the statements. */
function handlerTruncate(masked: string): boolean {
  return masked.split(";").some((part) => {
    const handler = part.search(/\bHANDLER\s+FOR\b/i)
    return handler >= 0 && /\bTRUNCATE\b(?!\s*\()/i.test(part.slice(handler))
  })
}

/** Code with literals and comments masked, and each quoted identifier as a placeholder name, so a
 * statement keeps its target (TRUNCATE `t`) without the identifier's text reading as code. */
function namesKept(tokens: ReturnType<typeof tokenizeSql>["tokens"]): string {
  return tokens
    .map(({ kind, text }) =>
      kind === "code" ? text : kind === "identifier" ? ` ${"_".repeat(Math.max(text.length - 2, 1))} ` : text.replace(/[^\r\n]/g, " "),
    )
    .join("")
}

/** Whether a write's quoted text holds a hard-denied statement. A write can run its literals as SQL:
 * dynamic SQL (EXEC('...'), sp_executesql N'...', EXECUTE IMMEDIATE, PREPARE ... FROM, dblink_exec),
 * or a function, procedure or trigger body created and called in the same call. Each literal is read
 * word by word with its escapes decoded, as uncertain SQL is, so nothing inside it (nested quotes,
 * comments) can separate the words. Each literal is read alone here (classifyAndCheck reads dynamic SQL
 * across its literals), and a custom UESCAPE character is not decoded, so it blocks. */
function quotedHardDeny(tokens: ReturnType<typeof tokenizeSql>["tokens"], dialect?: string): boolean {
  // UESCAPE counts with a U&'...' literal: U& in code right before a literal token.
  const unicode = tokens.some(({ kind, text }, i) => kind === "code" && /\bU&$/i.test(text) && tokens[i + 1]?.kind === "literal")
  if (unicode && /\bUESCAPE\b/i.test(maskSql(tokens))) return true
  // "..." is a string in Spark, Databricks and Hive, under SQL Server's QUOTED_IDENTIFIER OFF and in
  // MySQL without ANSI_QUOTES; other identifiers never are.
  const quotedStrings =
    /^(sqlserver|tsql|mssql|fabric|mysql|mariadb|spark|databricks|hive)$/i.test(dialect ?? "") || !isModeledDialect(dialect)
  return tokens.some(
    ({ kind, text }) =>
      (kind === "literal" || (kind === "identifier" && quotedStrings && text[0] === '"')) &&
      ((/\bUESCAPE\b/i.test(text) && /\bU&'/i.test(text)) || mentionsHardDenyAnywhere(text)),
  )
}

const DYNAMIC_SQL = /\bEXEC(UTE)?\b|(^|;)\s*(PREPARE|DO)\b/i

// Sequence advances outside PostgreSQL's nextval(): NEXT VALUE FOR s (SQL Server, DB2), and in Oracle,
// Snowflake and MariaDB (Oracle mode) s.NEXTVAL, quoted or not (in Oracle a quoted name must be
// uppercase). In other dialects s.nextval is a column.
function advancesSequence(tokens: ReturnType<typeof tokenizeSql>["tokens"], masked: string, dialect?: string): boolean {
  if (/\bNEXT\s+VALUE\s+FOR\b/i.test(masked)) return true
  if (!/^(oracle|snowflake|mysql|mariadb)$/i.test(dialect ?? "") && isModeledDialect(dialect)) return false
  // Comments masked to spaces, and a quoted name counts only when it is the word NEXTVAL, so
  // s./* c */"NEXTVAL" reads as s.NEXTVAL while "s.NEXTVAL" and t."NEXTVAL VALUE" are column names. Only
  // Oracle always keeps the case of a quoted name; Snowflake (QUOTED_IDENTIFIERS_IGNORE_CASE) and
  // MariaDB's Oracle mode can resolve s."nextval" as the sequence.
  const nextval = /^oracle$/i.test(dialect ?? "") ? /^"NEXTVAL"$/ : /^["`]NEXTVAL["`]$/i
  const names = tokens.map((token) =>
    token.kind === "identifier" && !nextval.test(token.text) ? { ...token, text: '"_"' } : token,
  )
  return /\.\s*NEXTVAL\b/i.test(maskSql(names, true))
}

/** The word DROP with DATABASE, SCHEMA, CATALOG or NAMESPACE anywhere after it, or TRUNCATE not
 * directly followed by `(` (the TRUNCATE() function; a comment before the `(` does not count, since
 * where a comment ends is part of what is uncertain). Only words count: quotes and comments are ignored, since how they read
 * is what is uncertain, so no comment or quote placement can separate the words. One forward pass. */
function mentionsHardDeny(sql: string): boolean {
  let drop = false
  let i = 0
  while (i < sql.length) {
    if (!/[A-Za-z_]/.test(sql[i])) {
      i++
      continue
    }
    let j = i + 1
    while (j < sql.length && /\w/.test(sql[j])) j++
    const word = sql.slice(i, j).toUpperCase()
    if (word === "DROP") drop = true
    else if (drop && (word === "DATABASE" || word === "SCHEMA" || word === "CATALOG" || word === "NAMESPACE")) return true
    else if (word === "TRUNCATE" && !/^[ \t\r\n]*\(/.test(sql.slice(j, j + 64))) return true
    i = j
  }
  return false
}

/** SQL wrapped in a subquery needs independent parser proof of exactly one query. */
export function isSingleQuery(sql: string, dialect?: string): boolean {
  if (!getStatementTypes || !tokenizeSql(sql, dialect).complete) return false
  try {
    const result = getStatementTypes(parserSql(sql, dialect), dialect)
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

// query_table and *_scan take table identifiers, not executable SQL. Only these
// known SQL arguments can establish read safety recursively in their target dialect.
const SQL_ARGUMENTS: Record<string, { index: number; dialect: string }> = {
  query: { index: 0, dialect: "duckdb" },
  to_query: { index: 0, dialect: "snowflake" },
  postgres_query: { index: 1, dialect: "postgres" },
  mysql_query: { index: 1, dialect: "mysql" },
  sqlite_query: { index: 1, dialect: "sqlite" },
  postgres_execute: { index: 1, dialect: "postgres" },
  mysql_execute: { index: 1, dialect: "mysql" },
  sqlite_execute: { index: 1, dialect: "sqlite" },
  eval: { index: 0, dialect: "sqlite" },
}

// Nested execution lacks the outer driver's read-only boundary. Apply sql_check's
// conservative function policy there without extending its PG allowlist to ordinary sql_execute reads.
function functionSafety(sql: string, dialect: string | undefined, depth: number, strict = depth > 0) {
  let write = false
  let blocked = false
  for (const call of sqlFunctionCalls(sql, dialect)) {
    // ODBC and other opaque remote engines do not reveal the target SQL dialect.
    if (
      call.escaped ||
      hasSideEffectFunction(call.name, strict) ||
      /^(odbc_query|odbc_copy|odbc_commit|odbc_rollback|openquery|external_query)$/.test(call.name)
    ) write = true
    // Nested and remote SQL cannot be proven read-only by a denylist: a user-defined
    // function may write. Require every call to be on the read-only allowlist.
    // SQL-string executors (query, postgres_query, ...) are exempt because their literal SQL is
    // classified recursively below; dynamic arguments and executors with side effects still fail closed.
    const nestedExecutor =
      Object.hasOwn(SQL_ARGUMENTS, call.name) && call.qualifier === undefined && !hasSideEffectFunction(call.name)
    if (depth > 0 && !nestedExecutor && !isReadOnlyNestedFunction(call.name, call.qualifier)) write = true
    // SQL Server's XML .query() takes XQuery, not executable SQL.
    if (call.name === "query" && /^(sqlserver|tsql|mssql|fabric)$/i.test(dialect ?? "")) continue
    const argument = Object.hasOwn(SQL_ARGUMENTS, call.name) ? SQL_ARGUMENTS[call.name] : undefined
    if (!argument) continue
    const inner = sqlLiteral(call.args[argument.index], dialect)
    if (!inner?.trim() || depth >= 8) {
      write = true
      continue
    }
    const result = classifySql(inner, argument.dialect, depth + 1)
    if (result.queryType !== "read" || !isSingleQuery(inner, argument.dialect)) write = true
    if (result.blocked) blocked = true
  }
  return { write, blocked }
}

/**
 * Single-pass: classify and check for hard-denied statement types.
 * Returns both the overall query type and whether a hard-deny pattern was found.
 */
export function classifyAndCheck(sql: string, dialect?: string): {
  queryType: "read" | "write"
  blocked: boolean
  parseError?: string
} {
  const result = classifySql(sql, dialect, 0)
  if (result.queryType === "write" && !result.blocked) {
    // SQL read with certainty: a write may still run the SQL in its literals. Otherwise the word scan
    // of the whole text already covered them.
    const lexical = tokenizeSql(sql, dialect)
    if (lexical.complete && quotedHardDeny(lexical.tokens, dialect)) return { ...result, blocked: true }
    // Dynamic SQL can join literals into one statement ('DROP ' + 'DATABASE x', or PostgreSQL's
    // adjacent constants), so its words count across literals too.
    if (lexical.complete && DYNAMIC_SQL.test(maskSql(lexical.tokens)) && mentionsHardDenyAnywhere(sql))
      return { ...result, blocked: true }
  }
  return result
}

/** Whether DROP DATABASE/SCHEMA/CATALOG/NAMESPACE or TRUNCATE appears anywhere in the text, read word by word
 * with quotes and comments ignored and escapes decoded (for text another layer renders, such as dbt's
 * Jinja). */
export function mentionsHardDenyAnywhere(sql: string): boolean {
  return escapeReadings(sql).some(mentionsHardDeny)
}

function classifySql(sql: string, dialect: string | undefined, depth: number): {
  queryType: "read" | "write"
  blocked: boolean
  parseError?: string
} {
  if (!sql || typeof sql !== "string") return { queryType: "read", blocked: false }
  const lexical = tokenizeSql(sql, dialect)
  if (!lexical.complete) {
    return { ...classifyFallback(sql, dialect), parseError: "SQL contains unterminated or unsupported quoted text or comments" }
  }
  if (!getStatementTypes) return { ...classifyFallback(sql, dialect), parseError: "SQL parser is unavailable" }
  try {
    const result = getStatementTypes(parserSql(sql, dialect), dialect)
    if (!Array.isArray(result?.statements) || result.statement_count !== result.statements.length) {
      return { ...classifyFallback(sql, dialect), parseError: "SQL parser returned an invalid statement list" }
    }

    // A generic parser can treat MySQL arithmetic (--2) as a comment and omit
    // trailing statements. Keep dialect-aware lexical hard denies authoritative.
    const functions = functionSafety(sql, dialect, depth)
    const masked = maskSql(lexical.tokens)
    const blocked =
      functions.blocked ||
      classifyFallback(sql, dialect, false).blocked ||
      result.statements.some(
        (s: { statement_type: string }) => s.statement_type && HARD_DENY_TYPES.has(s.statement_type.toUpperCase()),
      )

    const queryType =
      !functions.write &&
      !blocked &&
      !batchedStatement(masked, dialect) &&
      // Snowflake's ->> runs the statements it chains, DML included.
      !(/^snowflake$/i.test(dialect ?? "") && masked.includes("->>")) &&
      // Spark/Hive SELECT TRANSFORM(...) USING 'cmd' runs a command on the cluster; any USING not
      // followed by "(" counts (comments and the script masked), while JOIN ... USING (col) is a join.
      !((/^(spark|databricks|hive)$/i.test(dialect ?? "") || !isModeledDialect(dialect)) &&
        /\bTRANSFORM\s*\(/i.test(masked) &&
        /\bUSING\b(?!\s*\()/i.test(masked)) &&
      !advancesSequence(lexical.tokens, masked, dialect) &&
      otherIsReadOnly(sql, result.statements, dialect)
      ? "read"
      : "write"
    return { queryType, blocked: blocked || (queryType === "write" && WRITE_TRUNCATE.test(namesKept(lexical.tokens))) }
  } catch (error) {
    return { ...classifyFallback(sql, dialect), parseError: error instanceof Error ? error.message : String(error) }
  }
}

// MongoDB commands are JSON, not SQL: the SQL classifier reads every one as a write, which denied
// 52 of 52 Mongo reads for a read-only agent in one evaluation run. Classify them by command.
const MONGO_READ_COMMANDS = new Set([
  "find",
  "aggregate",
  "countDocuments",
  "estimatedDocumentCount",
  "distinct",
  "listCollections",
  "listIndexes",
  "ping",
])
const MONGO_WRITE_COMMANDS = new Set([
  "insertOne",
  "insertMany",
  "updateOne",
  "updateMany",
  "deleteOne",
  "deleteMany",
  "createCollection",
  "createIndex",
])
const MONGO_BLOCKED_COMMANDS = new Set(["dropDatabase", "dropCollection"])

/**
 * Classify a MongoDB command document (native `{"find": "coll"}` or `{command, collection}` shape).
 * Returns null when the text is not a JSON command document.
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
  const command = parsed["command"]
  if (typeof command !== "string" || !command.trim()) return null
  if (!MONGO_READ_COMMANDS.has(command) && !MONGO_WRITE_COMMANDS.has(command) && !MONGO_BLOCKED_COMMANDS.has(command)) return null
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
 * Reads are excluded: the driver caps rows only when the whole text starts with a read.
 */
export function isScratchSafeWrite(sql: string): boolean {
  const dialect = "duckdb"
  if (!getStatementTypes || !sql || typeof sql !== "string") return false
  if (!tokenizeSql(sql, dialect).complete) return false
  const functions = functionSafety(sql, dialect, 0, true)
  if (functions.write || functions.blocked) return false
  try {
    const result = getStatementTypes(sql, dialect)
    const statements: Array<{ statement_type?: string }> = result?.statements ?? []
    const source = statementsOf(sql, dialect)
    if (statements.length === 0 || statements.length !== source.length) return false
    return (
      statements.every((s) => SCRATCH_WRITE_TYPES.has(String(s.statement_type ?? "").toUpperCase())) &&
      source.every(hasLocalScratchTarget)
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
