import { UNAVAILABLE_NEXT_STEP, hasExecutableComment, classifyAndCheck, explainWrite, isSingleQuery } from "./sql-classify"
import { maskSql, statementsOf, tokenizeSql } from "./sql-tokenize"
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

// Statement words refused anywhere in a read handed to sql_check. A column qualified by a whole
// identifier (t.update) is not one, as in the classifier, except on ClickHouse, whose bundled parser
// accepts trailing text.
const WORDS = "INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|COPY|ATTACH|DETACH|PRAGMA|VACUUM|CALL|DO|INTO|INSTALL|LOAD|EXPORT|IMPORT|GRANT|REVOKE"
const QUALIFIED = "(?<!(?:^|[^\\w$.])[A-Za-z_][\\w$]*(?:\\.[A-Za-z_][\\w$]*)*\\.[A-Za-z]+)"
const STATEMENT_WORD = new RegExp(`\\b(${WORDS})\\b${QUALIFIED}`, "i")
const REPLACE_WORD = new RegExp(`\\bREPLACE\\b(?!\\s*\\()${QUALIFIED}`, "i")
const STRICT_STATEMENT_WORD = new RegExp(`\\b(${WORDS})\\b`, "i")
const STRICT_REPLACE_WORD = /\bREPLACE\b(?!\s*\()/i

function wordPatterns(dialect?: string): [RegExp, RegExp] {
  return dialect?.toLowerCase() === "clickhouse" ? [STRICT_STATEMENT_WORD, STRICT_REPLACE_WORD] : [STATEMENT_WORD, REPLACE_WORD]
}

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
    wordPatterns(dialect).some((pattern) => pattern.test(body))
  ) {
    throw new Error(
      "This operation only accepts a single read-only SELECT (or WITH ... SELECT); it never writes or fixes data." +
        (options.explain === false ? "" : writeReason(sql, dialect)),
    )
  }
  const semicolon = checked.masked.indexOf(";")
  return semicolon < 0 ? sql : sql.slice(0, semicolon) + sql.slice(semicolon + 1)
}

/** Why sql is refused as a read, as a sentence to append to a refusal: a hard block, the classifier's reason for a write,
 * or, for a read that only the stricter statement-word list refuses, that word (no SQL text). Empty otherwise. */
export function writeReason(sql: string, dialect?: string): string {
  const { queryType, blocked } = classifyAndCheck(sql, dialect)
  if (blocked) {
    // Name the first statement that is blocked on its own, by position only (no SQL text is quoted back).
    const statements = tokenizeSql(sql, dialect).complete ? statementsOf(sql, dialect) : []
    const index = statements.length > 1 ? statements.findIndex((statement) => classifyAndCheck(statement, dialect).blocked) : -1
    const where = index >= 0 ? `statement ${index + 1} of ${statements.length} is` : "it holds"
    const hard =
      ` It is refused because ${where} a hard-blocked statement, such as DROP DATABASE, DROP SCHEMA, TRUNCATE, SQL run` +
      " from a string literal or an executable comment; those never run and cannot be allowed."
    // Text that cannot be read (an open or unsupported quote or comment) is blocked on its words alone, inside the
    // unreadable text or outside it: name the unreadable text first, since fixing it may be the whole fix.
    const untilClosed =
      " Until it can be read, words such as DROP DATABASE or TRUNCATE anywhere in the SQL, inside that quoted text or" +
      " outside it, count as a hard-blocked statement; a real one outside it stays refused once the text is fixed."
    return tokenizeSql(sql, dialect).complete || hasExecutableComment(sql, dialect)
      ? hard
      : ` It counts as a write because ${explainWrite(sql, dialect).reason}.${untilClosed}`
  }
  if (queryType === "write") {
    const { reason, unavailable } = explainWrite(sql, dialect)
    return ` It counts as a write because ${reason}.${unavailable ? ` ${UNAVAILABLE_NEXT_STEP}` : ""}`
  }
  // Name the word only when it is the sole reason: the body is otherwise one SELECT or WITH query.
  const body = readOnlyBody(sql, dialect)?.body
  if (!body || !/^(SELECT|WITH)\b/i.test(body)) return ""
  const [statement, replace] = wordPatterns(dialect)
  const word = (statement.exec(body) ?? replace.exec(body))?.[0]
  return word ? ` It contains the statement word ${word.toUpperCase()} outside a literal or comment; quote it if it is a column name.` : ""
}
