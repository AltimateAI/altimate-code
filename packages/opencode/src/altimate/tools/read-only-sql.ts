import { classifyAndCheck, explainWrite, isSingleQuery } from "./sql-classify"
import { maskSql, tokenizeSql } from "./sql-tokenize"
import { sqlFunctionCalls } from "./sql-functions"
import { hasSideEffectFunction } from "./sql-function-policy"

/** The masked SQL and its trimmed body when it is one complete read-only query that is safe to embed: the
 * classifier reads it as a non-blocked read, its parentheses balance (so it cannot close a
 * CTE or subquery it is placed in), it has no statement separator, and it calls no function
 * that writes or runs SQL (dynamic query() included). Undefined otherwise. */
function readOnlyBody(sql: string, dialect?: string): { masked: string; body: string } | undefined {
  const { queryType, blocked } = classifyAndCheck(sql, dialect)
  // Settled already; the function scan below is costly on deeply nested input.
  if (blocked || queryType !== "read") return undefined
  const { tokens, complete } = tokenizeSql(sql, dialect)
  const masked = maskSql(tokens)
  // All calls use real code '(' tokens.
  const unsafeFunction = sqlFunctionCalls(sql, dialect).some(
    (call) => call.escaped || call.name === "query" || hasSideEffectFunction(call.name),
  )
  const body = masked.trim().replace(/;$/, "").trim()
  let depth = 0
  let balanced = true
  for (const char of body) {
    if (char === "(") depth++
    if (char === ")" && --depth < 0) balanced = false
  }
  const safe =
    !blocked &&
    queryType === "read" &&
    isSingleQuery(sql, dialect) &&
    complete &&
    !unsafeFunction &&
    balanced &&
    depth === 0 &&
    !body.includes(";")
  return safe ? { masked, body } : undefined
}

/** Throws unless sql is one read-only query that is safe to embed in a larger query. */
export function requireReadOnlyQuery(sql: string, dialect?: string): void {
  if (readOnlyBody(sql, dialect) === undefined)
    throw new Error("Only a single read-only query is accepted here; it never writes data.")
}

// Statement words refused anywhere in a read handed to sql_check; a column qualified by a whole
// identifier (t.update) is not one, as in the classifier.
const STATEMENT_WORD =
  /\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|COPY|ATTACH|DETACH|PRAGMA|VACUUM|CALL|DO|INTO|INSTALL|LOAD|EXPORT|IMPORT|GRANT|REVOKE)\b(?<!(?:^|[^\w$.])[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*\.[A-Za-z]+)/i
const REPLACE_WORD = /\bREPLACE\b(?!\s*\()(?<!(?:^|[^\w$.])[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*\.REPLACE)/i

/** Ignore quoted content while checking structure; preserve the original SELECT and its LIMIT.
 * Stricter than requireReadOnlyQuery: sql_check also requires SELECT or WITH and refuses
 * write keywords anywhere, even where the parser reports a query. */
export function readSql(sql: string, dialect?: string, options: { explain?: boolean } = {}): string {
  const checked = readOnlyBody(sql, dialect)
  const body = checked?.body ?? ""
  if (
    checked === undefined ||
    !/^(SELECT|WITH)\b/i.test(body) ||
    // A column qualified by a whole identifier (t.update) is not a statement word, as in the classifier.
    STATEMENT_WORD.test(body) ||
    REPLACE_WORD.test(body)
  ) {
    throw new Error(
      "This operation only accepts a single read-only SELECT (or WITH ... SELECT); it never writes or fixes data." +
        (options.explain === false ? "" : writeReason(sql, dialect)),
    )
  }
  const semicolon = checked.masked.indexOf(";")
  return semicolon < 0 ? sql : sql.slice(0, semicolon) + sql.slice(semicolon + 1)
}

/** Why sql is refused as a read, as a sentence to append to a refusal: the classifier's reason for a write,
 * or, for a read that only the stricter statement-word list refuses, that word (no SQL text). Empty otherwise. */
export function writeReason(sql: string, dialect?: string): string {
  const { queryType, blocked } = classifyAndCheck(sql, dialect)
  if (blocked) return ""
  if (queryType === "write") return ` It counts as a write because ${explainWrite(sql, dialect).reason}.`
  // Name the word only when it is the sole reason: the body is otherwise one SELECT or WITH query.
  const body = readOnlyBody(sql, dialect)?.body
  if (!body || !/^(SELECT|WITH)\b/i.test(body)) return ""
  const word = (STATEMENT_WORD.exec(body) ?? REPLACE_WORD.exec(body))?.[0]
  return word ? ` It contains the statement word ${word.toUpperCase()} outside a literal or comment; quote it if it is a column name.` : ""
}
