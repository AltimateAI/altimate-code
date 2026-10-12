type SqlToken = { kind: "code" | "comment" | "literal" | "identifier"; text: string }

/** Lex quoted SQL before recognizing comments or statement delimiters. */
export function tokenizeSql(sql: string): { tokens: SqlToken[]; complete: boolean } {
  const tokens: SqlToken[] = []
  let complete = true
  let i = 0
  let code = 0
  while (i < sql.length) {
    const start = i
    let kind: SqlToken["kind"] | undefined
    if (sql.startsWith("--", i)) {
      kind = "comment"
      i = sql.indexOf("\n", i + 2)
      if (i < 0) i = sql.length
    } else if (sql.startsWith("/*", i)) {
      kind = "comment"
      let depth = 1
      i += 2
      while (i < sql.length && depth) {
        if (sql.startsWith("/*", i)) {
          depth++
          i += 2
        } else if (sql.startsWith("*/", i)) {
          depth--
          i += 2
        } else i++
      }
      if (depth) complete = false
    } else {
      const escaped = /[eE]/.test(sql[i]) && sql[i + 1] === "'" && !/[\w$]/.test(sql[i - 1] ?? "")
      const quote = escaped ? "'" : sql[i]
      if (quote === "'" || quote === '"' || quote === "`" || quote === "[") {
        kind = quote === "'" ? "literal" : "identifier"
        const end = quote === "[" ? "]" : quote
        i += escaped ? 2 : 1
        let closed = false
        while (i < sql.length) {
          if (escaped && sql[i] === "\\") {
            i += 2
            continue
          }
          if (sql[i++] !== end) continue
          if (sql[i] === end) {
            i++
            continue
          }
          closed = true
          break
        }
        if (!closed) complete = false
        i = Math.min(i, sql.length)
      } else if (sql[i] === "$" && !/[\w$]/.test(sql[i - 1] ?? "")) {
        const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0]
        if (tag) {
          kind = "literal"
          const end = sql.indexOf(tag, i + tag.length)
          if (end < 0) {
            complete = false
            i = sql.length
          } else i = end + tag.length
        }
      }
    }
    if (!kind) {
      i++
      continue
    }
    if (start > code) tokens.push({ kind: "code", text: sql.slice(code, start) })
    tokens.push({ kind, text: sql.slice(start, i) })
    code = i
  }
  if (code < sql.length) tokens.push({ kind: "code", text: sql.slice(code) })
  return { tokens, complete }
}

export function maskSql(tokens: SqlToken[], identifiers = false): string {
  return tokens
    .map(({ kind, text }) => {
      if (kind === "code") return text
      if (identifiers && kind === "identifier") {
        const end = text.at(-1)!
        return text.slice(1, -1).replaceAll(end + end, end)
      }
      return text.replace(/[^\r\n]/g, " ")
    })
    .join("")
}

/** Keep each statement's quoted text, replacing only actual comments with whitespace. */
export function statementsOf(sql: string): string[] {
  const { tokens } = tokenizeSql(sql)
  const statements: string[] = []
  let statement = ""
  for (const { kind, text } of tokens) {
    if (kind === "comment") {
      statement += " "
      continue
    }
    if (kind !== "code") {
      statement += text
      continue
    }
    const parts = text.split(";")
    statement += parts[0]
    for (const part of parts.slice(1)) {
      if (statement.trim()) statements.push(statement.trim())
      statement = part
    }
  }
  if (statement.trim()) statements.push(statement.trim())
  return statements
}
