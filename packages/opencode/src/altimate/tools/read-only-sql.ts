import { UNAVAILABLE_NEXT_STEP, hardBlockCause, hasExecutableComment, classifyAndCheck, explainWrite, isSingleQuery, isSqlServerDialect } from "./sql-classify"
import { maskSql, statementsOf, tokenizeSql } from "./sql-tokenize"
import { sqlFunctionCalls } from "./sql-functions"
import { hasSideEffectFunction } from "./sql-function-policy"

/** The masked SQL and its trimmed body when it is one complete read-only query that is safe to embed: the
 * classifier reads it as a non-blocked read, its parentheses balance (so it cannot close a
 * CTE or subquery it is placed in), it has no statement separator, and it calls no function
 * that writes or runs SQL (dynamic query() included). Undefined otherwise. */
function readOnlyBody(sql: string, dialect?: string): { masked: string; body: string } | undefined {
  const checked = embeddable(sql, dialect)
  return "refused" in checked ? undefined : checked
}

/** readOnlyBody's checks, in order, with the first failed one named in fixed words (no SQL text). A write or
 * hard block is refused without a reason: the classifier explains those. */
function embeddable(sql: string, dialect?: string): { masked: string; body: string } | { refused: string } {
  const { queryType, blocked } = classifyAndCheck(sql, dialect)
  // Settled already; the function scan below is costly on deeply nested input.
  if (blocked || queryType !== "read") return { refused: "" }
  const { tokens, complete } = tokenizeSql(sql, dialect)
  const masked = maskSql(tokens)
  // All calls use real code '(' tokens.
  const calls = sqlFunctionCalls(sql, dialect)
  // SQL Server's XML .query() takes XQuery, not SQL, as in the classifier; elsewhere query() runs SQL text.
  if (!isSqlServerDialect(dialect) && calls.some((call) => call.name === "query")) {
    return { refused: "it calls query(), which runs SQL text that cannot be checked; query the tables directly" }
  }
  if (calls.some((call) => call.escaped)) return { refused: "it has an escaped function call, which cannot be checked" }
  if (calls.some((call) => hasSideEffectFunction(call.name))) {
    return { refused: "it calls a function that is not known to be read-only" }
  }
  const body = masked.trim().replace(/;$/, "").trim()
  if (body.includes(";")) return { refused: "it holds more than one statement" }
  if (!isSingleQuery(sql, dialect)) {
    return { refused: "it is not a SELECT or WITH query (a command such as SHOW cannot be embedded)" }
  }
  let depth = 0
  let balanced = true
  for (const char of body) {
    if (char === "(") depth++
    if (char === ")" && --depth < 0) balanced = false
  }
  if (!complete || !balanced || depth !== 0) return { refused: "its parentheses, quotes or comments do not balance" }
  return { masked, body }
}

/** Throws unless sql is one read-only query that is safe to embed in a larger query. */
export function requireReadOnlyQuery(sql: string, dialect?: string): void {
  if (readOnlyBody(sql, dialect) === undefined)
    throw new Error(`Only a single read-only query is accepted here; it never writes data.${writeReason(sql, dialect)}`)
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

/** Every hard-block refusal says this; its "permission" keyword sets the telemetry error class. */
export const NOT_OVERRIDABLE = "This cannot be overridden by any permission rule."

/** A hard-block refusal: head, then "cannot be overridden" unless only unreadable text (an open quote or comment)
 * made a word count, then the reason. */
export function hardBlockRefusal(head: string, sql: string, dialect?: string): string {
  const unreadable = !tokenizeSql(sql, dialect).complete && !hasExecutableComment(sql, dialect)
  return `${head}${unreadable ? "" : ` ${NOT_OVERRIDABLE}`}${writeReason(sql, dialect)}`
}

/** Why sql is refused as a read, as a sentence to append to a refusal: a hard block, the classifier's reason for a write,
 * a read shape that cannot be embedded, or a statement word refused by the stricter list. Empty for accepted reads. */
export function writeReason(sql: string, dialect?: string): string {
  const { queryType, blocked } = classifyAndCheck(sql, dialect)
  if (blocked) {
    // Name the first statement that is blocked on its own, by position only (no SQL text is quoted back).
    const statements = tokenizeSql(sql, dialect).complete ? statementsOf(sql, dialect) : []
    const index = statements.length > 1 ? statements.findIndex((statement) => classifyAndCheck(statement, dialect).blocked) : -1
    const where = index >= 0 ? `statement ${index + 1} of ${statements.length} is` : "it holds"
    const cause = hardBlockCause(index >= 0 ? statements[index] : sql, dialect)
    const hard = ` It is refused because ${where} a hard-blocked statement (${cause}); hard-blocked statements never run, whatever the permission rules allow.`
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
    const { reason, unreadable, unavailable } = explainWrite(sql, dialect)
    // A missing classifier is an installation failure, not a permission decision.
    const head = unreadable || unavailable ? "It counts as a write because" : "It counts as a write, which needs a write permission this path does not have, because"
    return ` ${head} ${reason}.${unavailable ? ` ${UNAVAILABLE_NEXT_STEP}` : ""}`
  }
  // Name the word only when it is the sole reason: the body is otherwise one SELECT or WITH query.
  const checked = embeddable(sql, dialect)
  const body = "refused" in checked ? undefined : checked.body
  if (!body || !/^(SELECT|WITH)\b/i.test(body)) {
    const cause = "refused" in checked ? checked.refused : "it is not a SELECT or WITH query (a command such as SHOW cannot be embedded)"
    return ` This read is invalid here because ${cause}; send a single SELECT or WITH query that can be embedded.`
  }
  const [statement, replace] = wordPatterns(dialect)
  const word = (statement.exec(body) ?? replace.exec(body))?.[0]
  return word ? ` It contains the statement word ${word.toUpperCase()} outside a literal or comment, so the read-only permission does not cover it; quote it if it is a column name.` : ""
}
