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
}

export interface CteProfileEntry {
  name: string
  line: number
  queryTimeMs: number
  marginalTimeMs: number
  rowCount: number
  tier: "hot" | "warm" | "cool"
}

/** Longest quoted identifier ("name", `name`, [name]) the identifier regex accepts. */
const MAX_QUOTED_IDENTIFIER_LENGTH = 500

/** Longest CTE column list the identifier regex accepts. */
const MAX_COLUMN_LIST_LENGTH = 1000

const IDENT_PART =
  `(?:[a-zA-Z_][a-zA-Z0-9_]*|"[^"]{1,${MAX_QUOTED_IDENTIFIER_LENGTH}}"|` +
  `\`[^\`]{1,${MAX_QUOTED_IDENTIFIER_LENGTH}}\`|` +
  `\\[[^\\]]{1,${MAX_QUOTED_IDENTIFIER_LENGTH}}\\])`

function identifierRegex(): RegExp {
  return new RegExp(`(${IDENT_PART}(?:\\.${IDENT_PART})*(?:\\s*\\([^)]{0,${MAX_COLUMN_LIST_LENGTH}}\\))?)`, "gi")
}

interface StringState {
  newPos: number
  inString: boolean
  stringChar: string
}

function handleSqlStringLiteral(text: string, pos: number, inString: boolean, stringChar: string): StringState {
  const char = text[pos]
  const nextChar = pos < text.length - 1 ? text[pos + 1] : ""

  if (!inString && (char === "'" || char === '"')) {
    return { newPos: pos, inString: true, stringChar: char }
  }
  if (inString && char === stringChar) {
    if (nextChar === stringChar) {
      // Doubled quote is an escaped quote: skip the second one.
      return { newPos: pos + 1, inString: true, stringChar }
    }
    return { newPos: pos, inString: false, stringChar: "" }
  }
  return { newPos: pos, inString, stringChar }
}

/**
 * When `pos` starts a comment (`--`, block, or Jinja), return the position of
 * its last character (the newline for line comments); otherwise return `pos`.
 */
function handleSqlComment(text: string, pos: number): number {
  const char = text[pos]
  const nextChar = pos < text.length - 1 ? text[pos + 1] : ""

  if (char === "-" && nextChar === "-") {
    let endPos = pos + 2
    while (endPos < text.length && text[endPos] !== "\n" && text[endPos] !== "\r") endPos++
    return endPos
  }

  if (char === "/" && nextChar === "*") {
    let endPos = pos + 2
    while (endPos < text.length - 1) {
      if (text[endPos] === "*" && text[endPos + 1] === "/") return endPos + 1
      endPos++
    }
    return text.length
  }

  if (char === "{" && nextChar === "#") {
    let endPos = pos + 2
    while (endPos < text.length - 1) {
      if (text[endPos] === "#" && text[endPos + 1] === "}") return endPos + 1
      endPos++
    }
    return text.length
  }

  return pos
}

function isPositionInsideComment(content: string, position: number): boolean {
  let pos = 0
  let inBlockComment = false
  let inJinjaComment = false

  while (pos < position && pos < content.length) {
    const char = content[pos]
    const nextChar = pos < content.length - 1 ? content[pos + 1] : ""

    if (!inBlockComment && !inJinjaComment && char === "/" && nextChar === "*") {
      inBlockComment = true
      pos += 2
      continue
    }
    if (inBlockComment && char === "*" && nextChar === "/") {
      inBlockComment = false
      pos += 2
      continue
    }
    if (!inBlockComment && !inJinjaComment && char === "{" && nextChar === "#") {
      inJinjaComment = true
      pos += 2
      continue
    }
    if (inJinjaComment && char === "#" && nextChar === "}") {
      inJinjaComment = false
      pos += 2
      continue
    }
    if (!inBlockComment && !inJinjaComment && char === "-" && nextChar === "-") {
      const lineStart = pos
      let lineEnd = pos + 2
      while (lineEnd < content.length && content[lineEnd] !== "\n" && content[lineEnd] !== "\r") lineEnd++
      if (position >= lineStart && position < lineEnd) return true
      pos = lineEnd
      continue
    }
    pos++
  }

  return inBlockComment || inJinjaComment
}

/** Every WITH keyword outside comments and strings. */
function findWithKeywords(text: string): number[] {
  const positions: number[] = []
  let pos = 0
  let inString = false
  let stringChar = ""

  while (pos < text.length) {
    const commentEnd = handleSqlComment(text, pos)
    if (commentEnd !== pos) {
      pos = commentEnd + 1
      continue
    }

    const s = handleSqlStringLiteral(text, pos, inString, stringChar)
    pos = s.newPos
    inString = s.inString
    stringChar = s.stringChar

    if (!inString) {
      const m = text.substring(pos).match(/^with\b/i)
      if (m) {
        const before = pos > 0 ? text[pos - 1] : " "
        if (!/[a-zA-Z0-9_]/.test(before)) positions.push(pos)
        pos += m[0].length
        continue
      }
    }
    pos++
  }
  return positions
}

function findMatchingClosingParen(text: string, openParenPos: number): number {
  let parenCount = 1
  let pos = openParenPos + 1
  let inString = false
  let stringChar = ""

  while (pos < text.length && parenCount > 0) {
    const char = text[pos]

    const commentEnd = handleSqlComment(text, pos)
    if (commentEnd !== pos) {
      pos = commentEnd
      continue
    }

    const s = handleSqlStringLiteral(text, pos, inString, stringChar)
    pos = s.newPos
    inString = s.inString
    stringChar = s.stringChar

    if (!inString) {
      if (char === "(") parenCount++
      else if (char === ")") parenCount--
    }
    pos++
  }

  return parenCount === 0 ? pos - 1 : -1
}

/** Position of the main SELECT after the CTEs, the end of text, or -1 when a nested WITH is found. */
function findWithClauseEnd(text: string, withStartPos: number): number {
  let pos = withStartPos
  let parenCount = 0
  let inString = false
  let stringChar = ""

  while (pos < text.length) {
    const char = text[pos]

    const commentEnd = handleSqlComment(text, pos)
    if (commentEnd !== pos) {
      pos = commentEnd
      continue
    }

    const s = handleSqlStringLiteral(text, pos, inString, stringChar)
    pos = s.newPos
    inString = s.inString
    stringChar = s.stringChar

    if (!inString) {
      if (char === "(") {
        parenCount++
      } else if (char === ")") {
        parenCount--
      } else if (parenCount === 0) {
        const rest = text.substring(pos)
        if (/^\s*with\b/i.test(rest)) return -1
        if (/^\s*select\b/i.test(rest)) return pos
      }
    }
    pos++
  }
  return text.length
}

/** `identifier [(columns)] [comments] AS (` starting at `startIndex`; returns the matched text or undefined. */
function validateCteMatchWithComments(content: string, startIndex: number, identifierName: string): string | undefined {
  let pos = startIndex + identifierName.length

  while (pos < content.length && /\s/.test(content[pos])) pos++
  if (pos < content.length && content[pos] === "(") {
    const end = findMatchingClosingParen(content, pos)
    if (end !== -1) pos = end + 1
  }

  while (pos < content.length) {
    while (pos < content.length && /\s/.test(content[pos])) pos++
    if (pos >= content.length) break

    const commentEnd = handleSqlComment(content, pos)
    if (commentEnd !== pos) {
      pos = commentEnd + 1
      continue
    }

    const asMatch = content.substring(pos).match(/^as\s*\(/i)
    if (asMatch) return content.substring(startIndex, pos + asMatch[0].length)
    break
  }
  return undefined
}

function findCteIdentifiersOnly(withClauseContent: string): Array<{ index: number; name: string; fullMatch: string }> {
  const regex = identifierRegex()
  const out: Array<{ index: number; name: string; fullMatch: string }> = []
  let match: RegExpExecArray | null

  while ((match = regex.exec(withClauseContent)) !== null) {
    const name = match[1]
    if (isPositionInsideComment(withClauseContent, match.index)) continue
    const fullMatch = validateCteMatchWithComments(withClauseContent, match.index, name)
    if (fullMatch !== undefined) out.push({ index: match.index, name, fullMatch })
  }
  return out
}

function extractCtesFromWithClause(
  withClauseContent: string,
  withStartPos: number,
  withClauseStart: number,
  ctes: CteInfo[],
): void {
  let cteIndex = 0

  for (const m of findCteIdentifiersOnly(withClauseContent)) {
    const nameStart = withStartPos + m.index
    const nameEnd = nameStart + m.name.length
    const openParenRel = m.index + m.fullMatch.length - 1
    const closeRel = findMatchingClosingParen(withClauseContent, openParenRel)
    if (closeRel === -1) continue

    ctes.push({
      name: m.name,
      nameStart,
      nameEnd,
      queryStart: withStartPos + openParenRel + 1,
      queryEnd: withStartPos + closeRel,
      index: cteIndex,
      withClauseStart,
    })
    cteIndex++
  }
}

/** Find every CTE in the model text, in source order. */
export function detectCtes(text: string): CteInfo[] {
  const ctes: CteInfo[] = []

  for (const withPos of findWithKeywords(text)) {
    let start = withPos + 4 // "with".length

    while (start < text.length) {
      while (start < text.length && /\s/.test(text[start])) start++
      if (start >= text.length) break
      const commentEnd = handleSqlComment(text, start)
      if (commentEnd !== start) {
        start = commentEnd + 1
        continue
      }
      break
    }

    const end = findWithClauseEnd(text, start)
    if (end === -1) continue

    extractCtesFromWithClause(text.substring(start, end), start, withPos, ctes)
  }

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
 */
export function buildCountQuery(text: string, ctes: CteInfo[], target: CteInfo): string | undefined {
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
  query += "WITH " + definitions.join(",\n")
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

/** Zero-based line number of an offset. */
export function lineOf(text: string, offset: number): number {
  let line = 0
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++
  return line
}
