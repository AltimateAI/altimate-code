type SqlToken = { kind: "code" | "comment" | "literal" | "identifier"; text: string }

// PostgreSQL, DuckDB and Redshift also allow any non-ASCII character in identifiers and dollar tags.
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)?\$/y
const IDENTIFIER_CHAR = /[\w$\u0080-\uffff]/

/** A supported warehouse dialect these lexing rules model; anything else (none, "generic",
 * "unknown"...) is read conservatively. */
export function isModeledDialect(dialect?: string): boolean {
  return /^(mysql|mariadb|bigquery|clickhouse|sqlite|postgres|postgresql|duckdb|sqlserver|tsql|mssql|fabric|spark|databricks|hive|redshift|snowflake|oracle|trino)$/i.test(
    dialect ?? "",
  )
}

/** Lex quoted SQL before recognizing comments or statement delimiters.
 * `complete` is false for syntax we cannot safely interpret across supported dialects. */
export function tokenizeSql(sql: string, dialect?: string): { tokens: SqlToken[]; complete: boolean } {
  const tokens: SqlToken[] = []
  const mysqlComments = !dialect || /^(mysql|mariadb)$/i.test(dialect)
  const hashComments = /^(mysql|mariadb|bigquery)$/i.test(dialect ?? "")
  const clickhouseComments = /^clickhouse$/i.test(dialect ?? "")
  // Snowflake also starts a line comment with //.
  const slashComments = /^snowflake$/i.test(dialect ?? "")
  // E'...' escape strings exist only in PostgreSQL and the engines that follow it; elsewhere E is
  // ordinary code (in T-SQL, E'\' is a column E and a one-character alias).
  const escapeStrings = /^(postgres|postgresql|redshift|duckdb)$/i.test(dialect ?? "")
  // BigQuery also quotes strings with three quotes, ''' or """.
  const tripleQuotes = /^bigquery$/i.test(dialect ?? "")
  // Only known LF-only dialects may keep code after CR inside a comment.
  const lineEnding = /^(mysql|mariadb|sqlite|clickhouse)$/i.test(dialect ?? "") ? /\n/ : /[\r\n]/
  // Spark (and Databricks, Hive) continue a -- comment past a backslash before the line end.
  const lineContinuation = /^(spark|databricks|hive)$/i.test(dialect ?? "") || !isModeledDialect(dialect)
  // Only known nesting dialects can hide another /* ... */ level. Otherwise,
  // expose code that could execute after the first closing delimiter.
  const nestedComments = /^(postgres|duckdb|sqlserver|tsql|mssql|fabric|clickhouse|spark|databricks)$/i.test(dialect ?? "")
  // Where nesting is not known either way, a /* inside a comment makes its end uncertain.
  const nestingKnown = nestedComments || /^(mysql|mariadb|sqlite|oracle|trino)$/i.test(dialect ?? "")
  const dollarQuotes = /^(postgres|redshift|duckdb|snowflake)$/i.test(dialect ?? "")
  // Quoting is dialect-specific: brackets can contain executable array expressions,
  // and PostgreSQL backticks can be operators. Unknown dialects keep both visible.
  const backtickIdentifiers = /^(mysql|mariadb|sqlite|bigquery|clickhouse|spark|databricks|hive)$/i.test(dialect ?? "")
  const bracketIdentifiers = /^(sqlserver|tsql|mssql|fabric|sqlite)$/i.test(dialect ?? "")
  // A dialect that is not one of the supported warehouse types (none, "generic", "unknown"...)
  // may still escape a quote with a backslash or start a comment with #, so both make the SQL
  // uncertain. Oracle, Trino and Fabric do neither.
  const unmodeled = !isModeledDialect(dialect)
  const ambiguousBackslash = unmodeled || /^(postgres|postgresql|spark|databricks|hive)$/i.test(dialect ?? "")
  let complete = true
  let i = 0
  let code = 0
  while (i < sql.length) {
    const start = i
    let kind: SqlToken["kind"] | undefined
    // MySQL requires ASCII whitespace/control after -- (not Unicode spaces such as U+00A0). Keep ambiguous arithmetic visible
    // to the write-clause checks even when another dialect treats it as a comment.
    if (
      (sql.startsWith("--", i) && (!mysqlComments || i + 2 === sql.length || /[\x00-\x20\x7f]/.test(sql[i + 2]))) ||
      (hashComments && sql[i] === "#") ||
      (clickhouseComments && (sql.startsWith("//", i) || sql.startsWith("# ", i) || sql.startsWith("#!", i))) ||
      (slashComments && sql.startsWith("//", i))
    ) {
      kind = "comment"
      const end = sql.slice(i + 1).search(lineEnding)
      i = end < 0 ? sql.length : i + 1 + end
      if (lineContinuation && i < sql.length && sql[i - 1] === "\\") complete = false
    } else if (sql.startsWith("/*", i)) {
      // MySQL/MariaDB execute these comments. Generic SQL parsers discard them,
      // so they cannot establish that a query is read-only or scratch-confined.
      if (/^\/\*(?:!|[mM]!)/.test(sql.slice(i))) complete = false
      kind = "comment"
      let depth = 1
      i += 2
      while (i < sql.length && depth) {
        if (!nestingKnown && sql.startsWith("/*", i)) complete = false
        if (nestedComments && sql.startsWith("/*", i)) {
          depth++
          i += 2
        } else if (sql.startsWith("*/", i)) {
          depth--
          i += 2
        } else i++
      }
      if (depth) complete = false
    } else if (tripleQuotes && (sql.startsWith("'''", i) || sql.startsWith('"""', i))) {
      // Ends only at the same three quotes; a backslash keeps the next character even in a raw
      // r'''...''' string (BigQuery reads the escape but keeps it as text).
      kind = "literal"
      const delimiter = sql.slice(i, i + 3)
      i += 3
      let closed = false
      while (i < sql.length) {
        if (sql[i] === "\\") {
          i += 2
          continue
        }
        if (sql.startsWith(delimiter, i)) {
          i += 3
          closed = true
          break
        }
        i++
      }
      if (!closed) complete = false
      i = Math.min(i, sql.length)
    } else {
      const escaped = escapeStrings && /[eE]/.test(sql[i]) && sql[i + 1] === "'" && !IDENTIFIER_CHAR.test(sql[i - 1] ?? "")
      const quote = escaped ? "'" : sql[i]
      if (quote === "'" || quote === '"' || (quote === "`" && backtickIdentifiers) || (quote === "[" && bracketIdentifiers)) {
        kind = quote === "'" ? "literal" : "identifier"
        const end = quote === "[" ? "]" : quote
        // A backslash keeps the next character in every BigQuery quoted form ('...', "...", `...`,
        // raw r'...' included: the escape stays as text but the quote does not end it), and in
        // Redshift '...'.
        const bigquery = /^bigquery$/i.test(dialect ?? "")
        const backslashEscapes =
          (bigquery && (quote === "'" || quote === '"' || quote === "`")) || (quote === "'" && /^redshift$/i.test(dialect ?? ""))
        if (bigquery && quote === '"') kind = "literal"
        i += escaped ? 2 : 1
        let closed = false
        while (i < sql.length) {
          // Ordinary strings in these engines can escape their closing quote.
          // MySQL modes can disable that behavior (and make double quotes
          // identifiers), so neither interpretation proves a read-only query.
          if (
            sql[i] === "\\" &&
            !escaped &&
            ((quote === "'" && /^(mysql|mariadb|clickhouse|snowflake)$/i.test(dialect ?? "")) ||
              (quote === '"' && /^(mysql|mariadb)$/i.test(dialect ?? "")))
          ) complete = false
          // After an odd run of backslashes a quote is escaped in some modes and closes the literal in
          // others, so where it ends cannot be known: in an unmodeled dialect, in Spark, Databricks
          // and Hive (escapedStringLiterals) and in PostgreSQL (standard_conforming_strings off).
          if (ambiguousBackslash && !escaped && quote !== "[" && sql[i] === end) {
            let run = 0
            for (let j = i - 1; j > start && sql[j] === "\\"; j--) run++
            if (run % 2 === 1) complete = false
          }
          if ((escaped || backslashEscapes) && sql[i] === "\\") {
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
      } else if (dollarQuotes && sql[i] === "$" && !IDENTIFIER_CHAR.test(sql[i - 1] ?? "")) {
        DOLLAR_TAG.lastIndex = i
        const tag = /^snowflake$/i.test(dialect ?? "") ? (sql.startsWith("$$", i) ? "$$" : undefined) : DOLLAR_TAG.exec(sql)?.[0]
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
      // Unmodeled dialect: # starts a comment in MySQL and BigQuery, so what follows cannot be read.
      if (unmodeled && sql[start] === "#") complete = false
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
export function statementsOf(sql: string, dialect?: string): string[] {
  const { tokens } = tokenizeSql(sql, dialect)
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
