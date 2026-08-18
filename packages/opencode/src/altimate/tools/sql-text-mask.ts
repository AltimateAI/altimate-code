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
 * `preserveQuotedIdentifiers`: keep the CONTENT of "double" and `backtick`
 * identifiers in the output (still consumed as one token, so their content can
 * never open a comment/string state); the default blanks those two. [Bracket]
 * spans are ALWAYS preserved regardless of the option — they double as
 * PostgreSQL array subscripts, and blanking would hide side-effecting
 * subscript expressions (arr[nextval(..)]) from the keyword scans.
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
  const consumeDelimited = (open: string, close: string, forcePreserve = false): number => {
    const start = i
    let j = i + 1
    for (;;) {
      if (j >= n) return -1
      if (sql[j] === close && sql[j + 1] === close) j += 2
      else if (sql[j] === close) break
      else j++
    }
    out += keepIds || forcePreserve ? sql.slice(start, j + 1) : open + close
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
      // Brackets are ambiguous: SQL Server quoted identifiers ([--]) vs
      // PostgreSQL array subscripts (arr[nextval('s')]). Consume as a unit so
      // identifier content can never open a comment state, but ALWAYS preserve
      // the content in the output: blanking it would hide a side-effecting
      // subscript expression from the keyword scans. Preserved content is
      // never re-lexed, so it can only ADD text for the scans to see — the
      // fail-safe direction (an identifier literally named [delete] merely
      // triggers a prompt).
      const j = consumeDelimited("[", "]", true)
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
