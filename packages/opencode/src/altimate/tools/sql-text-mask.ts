/**
 * Single left-to-right lexer pass that masks string literals and comments.
 *
 * Regex-based masking is order-dependent and defeatable by alternating quote
 * and comment markers; a lexer has no ordering: at every position exactly one
 * state decides how the next character is consumed, so markers inside
 * literals/comments can never hide code and quotes inside comments can never
 * open a phantom string.
 *
 * Handles: 'single' (with '' escape), "double" (with "" escape), -- line
 * comments, block comments, and PostgreSQL dollar-quotes with identifier-rule
 * tags ($$, $tag1$ — digits allowed after the first char). Backslashes inside
 * single-quoted literals fail closed: dialect escape rules (PostgreSQL E'...',
 * MySQL) make `\''` end where this lexer's ''-pair rule would continue, which
 * would mask real code as string content — so any backslash-bearing literal
 * returns null instead of being lexed.
 *
 * Returns the SQL with literal/comment contents removed, or null when a
 * construct is unterminated or unlexable (callers must fail closed).
 */
export function maskLiteralsAndComments(sql: string): string | null {
  let out = ""
  let i = 0
  const n = sql.length
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
      out += '""'
      i++
      for (;;) {
        if (i >= n) return null
        if (sql[i] === '"' && sql[i + 1] === '"') i += 2
        else if (sql[i] === '"') break
        else i++
      }
      i++
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
