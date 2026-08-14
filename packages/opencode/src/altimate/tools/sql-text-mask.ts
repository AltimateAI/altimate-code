/**
 * Single left-to-right lexer pass that masks string literals and comments.
 *
 * Regex-based masking is order-dependent and defeatable by alternating quote
 * and comment markers; a lexer has no ordering: at every position exactly one
 * state decides how the next character is consumed, so markers inside
 * literals/comments can never hide code and quotes inside comments can never
 * open a phantom string.
 *
 * Handles: 'single' (with '' escape), "double" (with "" escape), SQL Server
 * [bracket] identifiers (with ]] escape), MySQL `backtick` identifiers (with
 * `` escape), -- line comments (ending at \n OR \r), block comments, and
 * PostgreSQL dollar-quotes with identifier-rule tags at token boundaries.
 * Backslashes inside single-quoted literals fail closed: dialect escape rules
 * (PostgreSQL E'...', MySQL) make `\''` end where this lexer's ''-pair rule
 * would continue, which would mask real code as string content.
 *
 * `preserveQuotedIdentifiers`: keep the CONTENT of "double", [bracket], and
 * `backtick` identifiers in the output (still consumed as one token, so their
 * content can never open a comment/string state). Callers that need to detect
 * quoted function names (sql-classify's side-effect scan) use this variant;
 * the default blanks them.
 *
 * Returns the SQL with literal/comment contents removed, or null when a
 * construct is unterminated or unlexable (callers must fail closed).
 */
export function maskLiteralsAndComments(
  sql: string,
  options?: { preserveQuotedIdentifiers?: boolean },
): string | null {
  const keepIds = options?.preserveQuotedIdentifiers === true
  let out = ""
  let i = 0
  const n = sql.length

  // Consume a delimited identifier ('"', '`') or bracket pair, where `close`
  // doubled means an escaped delimiter. Returns the new index or -1.
  const consumeDelimited = (open: string, close: string): number => {
    const start = i
    let j = i + 1
    for (;;) {
      if (j >= n) return -1
      if (sql[j] === close && sql[j + 1] === close) j += 2
      else if (sql[j] === close) break
      else j++
    }
    out += keepIds ? sql.slice(start, j + 1) : open + close
    return j + 1
  }

  while (i < n) {
    const c = sql[i]
    const next = i + 1 < n ? sql[i + 1] : ""
    if (c === "'") {
      out += "''"
      i++
      for (;;) {
        if (i >= n) return null
        if (sql[i] === "\\") return null
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2
        else if (sql[i] === "'") break
        else i++
      }
      i++
    } else if (c === '"') {
      const j = consumeDelimited('"', '"')
      if (j === -1) return null
      i = j
    } else if (c === "`") {
      const j = consumeDelimited("`", "`")
      if (j === -1) return null
      i = j
    } else if (c === "[") {
      // SQL Server bracket-quoted identifiers can contain `--` etc.; consume
      // as a unit so their content cannot open a comment state. Postgres array
      // subscripts (arr[1]) lex through here harmlessly.
      const j = consumeDelimited("[", "]")
      if (j === -1) return null
      i = j
    } else if (c === "-" && next === "-") {
      // Line comments end at \n OR \r — CR-only line endings must not extend
      // the comment to EOF and hide later statements.
      const lf = sql.indexOf("\n", i)
      const cr = sql.indexOf("\r", i)
      const nl = lf === -1 ? cr : cr === -1 ? lf : Math.min(lf, cr)
      out += " "
      if (nl === -1) break
      i = nl
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2)
      if (end === -1) return null
      out += " "
      i = end + 2
    } else if (c === "$" && !(i > 0 && /[A-Za-z0-9_]/.test(sql[i - 1]))) {
      // A dollar-quote must start at a token boundary: PostgreSQL permits `$`
      // inside unquoted identifiers (foo$bar), which are not quote openers.
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length)
        if (close === -1) return null
        out += "''"
        i = close + tag[0].length
      } else {
        out += c
        i++
      }
    } else {
      out += c
      i++
    }
  }
  return out
}
