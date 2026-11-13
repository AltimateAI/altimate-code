/**
 * CTE detection and count-query building for the CTE profiler.
 *
 * Works on the raw model text (Jinja included) with string offsets. The scanner
 * skips SQL line/block comments, Jinja comments and string literals, and
 * understands quoted CTE names and CTE column lists.
 */

export interface CteInfo {
  /** Identifier as written, including a trailing column list such as `my_cte (id, name)`. */
  name: string
  /** Offset where the name starts. */
  nameStart: number
  /** Offset just after the name (and its column list). */
  nameEnd: number
  /** Offset of the first character after the CTE body's opening parenthesis. */
  queryStart: number
  /** Offset of the CTE body's closing parenthesis. */
  queryEnd: number
  /** Order of the CTE within its WITH clause. */
  index: number
  /** Offset of the WITH keyword that opens this CTE's clause. */
  withClauseStart: number
  /** The clause is `WITH RECURSIVE`. */
  recursive?: boolean
}

/** Position just past the string literal, quoted identifier or comment (`--`, block, Jinja) that starts at `pos`; `pos` itself when none does. An unterminated one runs to the end of the text. */
function skipLiteral(text: string, pos: number): number {
  const char = text[pos]
  const next = text[pos + 1]
  if (char === "'" || char === '"' || char === "`") {
    let i = pos + 1
    while (i < text.length) {
      if (text[i] === char) {
        // A doubled quote is an escaped quote.
        if (text[i + 1] === char) i += 2
        else return i + 1
      } else i++
    }
    return text.length
  }
  const close = char === "-" && next === "-" ? "\n" : char === "/" && next === "*" ? "*/" : char === "{" && next === "#" ? "#}" : null
  if (close === null) return pos
  const end = text.indexOf(close, pos + 2)
  if (end === -1) return text.length
  return close === "\n" ? end : end + close.length
}

/** Position of the first character at or after `pos` that is not whitespace, a comment, or (when `jinja`) a Jinja `{% %}` tag. */
function skipTrivia(text: string, pos: number, jinja: boolean): number {
  while (pos < text.length) {
    if (/\s/.test(text[pos])) {
      pos++
      continue
    }
    const end = skipLiteral(text, pos)
    if (end !== pos && !/['"`]/.test(text[pos])) {
      pos = end
      continue
    }
    if (jinja && text[pos] === "{" && text[pos + 1] === "%") {
      const close = text.indexOf("%}", pos + 2)
      if (close === -1) return text.length
      pos = close + 2
      continue
    }
    return pos
  }
  return pos
}

/** Offset of the `)` that closes the `(` at `openParenPos`, or -1 when it is never closed. */
function findMatchingClosingParen(text: string, openParenPos: number): number {
  let depth = 1
  let pos = openParenPos + 1
  while (pos < text.length) {
    const end = skipLiteral(text, pos)
    if (end !== pos) {
      pos = end
      continue
    }
    if (text[pos] === "(") depth++
    else if (text[pos] === ")" && --depth === 0) return pos
    pos++
  }
  return -1
}

/**
 * Position just past the Jinja tag at `pos`, and past its whole block when it opens one whose text
 * is not the model's own SQL (`{% set x %}…{% endset %}`, `{% call %}`, `{% macro %}`): a query
 * written there is a string for dbt to run, not a CTE of the model.
 */
function skipJinjaBlock(text: string, pos: number): number {
  const close = text.indexOf("%}", pos + 2)
  if (close === -1) return text.length
  const tag = /^\{%-?\s*(set|call|macro)\b([^%]*)/.exec(text.substring(pos, close + 2))
  // `{% set x = … %}` is an inline set, with no block to skip.
  if (!tag || (tag[1] === "set" && tag[2].includes("="))) return close + 2
  const end = new RegExp(`\\{%-?\\s*end${tag[1]}\\b[^%]*%\\}`, "g")
  end.lastIndex = close + 2
  const found = end.exec(text)
  return found ? found.index + found[0].length : text.length
}

/** Every WITH keyword outside comments, strings and parentheses: a WITH inside a CTE body or a subquery belongs to that query, not to the model. */
function findTopLevelWithKeywords(text: string): number[] {
  const positions: number[] = []
  const keyword = /with\b/iy
  let depth = 0
  let pos = 0
  while (pos < text.length) {
    const end = skipLiteral(text, pos)
    if (end !== pos) {
      pos = end
      continue
    }
    const char = text[pos]
    if (char === "{" && text[pos + 1] === "%") {
      pos = skipJinjaBlock(text, pos)
      continue
    }
    if (char === "(") depth++
    else if (char === ")") depth = Math.max(0, depth - 1)
    else if (depth === 0 && (char === "w" || char === "W") && !/[A-Za-z0-9_$]/.test(text[pos - 1] ?? " ")) {
      keyword.lastIndex = pos
      if (keyword.test(text)) {
        positions.push(pos)
        pos += 4
        continue
      }
    }
    pos++
  }
  return positions
}

/** Offset just past the identifier (`a`, `"a""b"`, `` `a` ``, `[a]`, `db.schema.a`) that starts at `pos`; -1 when none does. */
function readIdentifier(text: string, pos: number): number {
  let end = pos
  for (;;) {
    const char = text[end]
    if (char === '"' || char === "`") {
      const close = skipLiteral(text, end)
      if (close === end || text[close - 1] !== char || close - end < 2) return -1
      end = close
    } else if (char === "[") {
      const bracketed = /\[[^\]\n]{1,256}\]/y
      bracketed.lastIndex = end
      if (!bracketed.test(text)) return -1
      end = bracketed.lastIndex
    } else {
      const bare = /[\p{L}_][\p{L}\p{N}_$]*/uy
      bare.lastIndex = end
      if (!bare.test(text)) return -1
      end = bare.lastIndex
    }
    if (text[end] !== ".") return end
    end++
  }
}

/** The CTEs of the WITH clause that opens at `withPos`: each `name [(columns)] AS (body)`, separated by commas, up to the first thing that is not one. */
function parseWithClause(text: string, withPos: number, ctes: CteInfo[]): void {
  let pos = skipTrivia(text, withPos + 4, true)
  const keyword = /recursive\b/iy
  keyword.lastIndex = pos
  const recursive = keyword.test(text)
  if (recursive) pos = skipTrivia(text, pos + "recursive".length, true)

  const asOpen = /as(?:\s+(?:not\s+)?materialized)?\s*\(/iy
  for (let index = 0; ; index++) {
    const nameStart = pos
    const identifierEnd = readIdentifier(text, nameStart)
    if (identifierEnd === -1) return
    let nameEnd = identifierEnd
    let name = text.substring(nameStart, identifierEnd)
    pos = skipTrivia(text, identifierEnd, false)
    if (text[pos] === "(") {
      const close = findMatchingClosingParen(text, pos)
      if (close === -1) return
      // The name as written plus its column list; a comment between them is left out.
      name += ` ${text.substring(pos, close + 1)}`
      nameEnd = close + 1
      pos = skipTrivia(text, nameEnd, false)
    }
    asOpen.lastIndex = pos
    const header = asOpen.exec(text)
    if (!header) return
    const open = pos + header[0].length - 1
    const close = findMatchingClosingParen(text, open)
    if (close === -1) return
    ctes.push({
      name,
      nameStart,
      nameEnd,
      queryStart: open + 1,
      queryEnd: close,
      index,
      withClauseStart: withPos,
      ...(recursive && { recursive }),
    })
    pos = skipTrivia(text, close + 1, true)
    if (text[pos] !== ",") return
    pos = skipTrivia(text, pos + 1, true)
  }
}

/** Find every CTE of the model's own WITH clauses, in source order. A WITH inside a CTE body or a subquery is not listed: its CTEs cannot be counted without the query around them. */
export function detectCtes(text: string): CteInfo[] {
  const ctes: CteInfo[] = []
  for (const withPos of findTopLevelWithKeywords(text)) parseWithClause(text, withPos, ctes)
  return ctes
}

/** Drop a trailing column list: `my_cte (id, name)` -> `my_cte`. */
export function stripColumnList(rawName: string): string {
  return rawName.replace(/\s*\([^)]*\)\s*$/, "").trim()
}

export function quoteSqlIdentifier(identifier: string): string {
  if (identifier.match(/^["'`[]/) || identifier.includes(".")) return identifier
  if (!identifier.match(/^[a-zA-Z_][a-zA-Z0-9_]*$/)) return `"${identifier}"`
  return identifier
}

/**
 * `SELECT COUNT(*)` over one CTE, keeping the preamble (dbt configs, variables)
 * and every earlier CTE of the same WITH clause, so the query compiles on its own.
 * Undefined for a CTE of a second WITH clause in the same file, which has no standalone query.
 */
export function buildCountQuery(text: string, ctes: CteInfo[], target: CteInfo): string | undefined {
  // The text before a later WITH holds the earlier clause's whole query: nothing valid stands alone there.
  if (ctes.some((c) => c.withClauseStart < target.withClauseStart)) return undefined
  const upToTarget = ctes.filter((c) => c.withClauseStart === target.withClauseStart && c.index <= target.index)

  const definitions: string[] = []
  for (const cte of upToTarget) {
    if (cte.queryStart <= cte.nameStart) continue
    // Slice from the name to the body so column lists and comments before AS are kept.
    const header = text.substring(cte.nameStart, cte.queryStart)
    const body = text.substring(cte.queryStart, cte.queryEnd)
    definitions.push(`${header}\n${body}\n)`)
  }
  if (definitions.length === 0) return undefined

  const preamble = text.substring(0, target.withClauseStart).trim()
  let query = ""
  if (preamble) query += preamble + "\n\n"
  query += (target.recursive ? "WITH RECURSIVE " : "WITH ") + definitions.join(",\n")
  query += `\nSELECT COUNT(*) AS _profile_count FROM ${quoteSqlIdentifier(stripColumnList(target.name))}`
  return query
}

/**
 * Read the single COUNT(*) value by position: Snowflake and Oracle upper-case
 * the alias, so a lookup by name would report 0 rows.
 */
export function extractRowCount(data: Record<string, unknown>[] | undefined): number {
  if (!data || data.length === 0) return 0
  const first = Object.values(data[0])[0]
  return typeof first === "number" ? first : Number(first) || 0
}
