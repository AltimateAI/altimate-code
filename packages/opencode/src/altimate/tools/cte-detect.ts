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
  if (char === "$" && !/[\p{L}\p{N}_$]/u.test(text[pos - 1] ?? " ")) {
    // A dollar-quoted string (`$$ … $$`, `$tag$ … $tag$`) runs to its matching tag.
    const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.substring(pos, pos + 70))?.[0]
    if (tag) {
      const end = text.indexOf(tag, pos + tag.length)
      return end === -1 ? text.length : end + tag.length
    }
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

interface JinjaTag {
  /** Tag name (`if`, `set`, `macro`…), without the `end` prefix. */
  name: string
  /** The tag closes a block (`{% endif %}`). */
  closes: boolean
  /** The tag opens a block: not an `end` tag, `else`/`elif`, or an inline `{% set x = … %}`. */
  opens: boolean
  /** Offset just past the tag. */
  end: number
}

const BLOCK_TAGS = new Set(["if", "for", "macro", "call", "filter", "with", "set", "raw"])

/** The block tag of the `{% … %}` that spans `at` to `close` (the offset of its `%}`); undefined for any other tag. */
function parseTag(text: string, at: number, close: number): JinjaTag | undefined {
  const head = /^\{%-?\s*(end)?(\w+)/.exec(text.substring(at, Math.min(close + 2, at + 200)))
  if (!head || !BLOCK_TAGS.has(head[2])) return undefined
  const closes = head[1] !== undefined
  // `{% set x = … %}` is an inline set; `{% set x %}` and `{% set x | filter %}` open a block.
  const inline = head[2] === "set" && /^\{%-?\s*set\s+[\w.,\s]+=(?!=)/.test(text.substring(at, close + 2))
  return { name: head[2], closes, opens: !closes && !inline, end: close + 2 }
}

/**
 * The Jinja statement tags of `text` from `from`, in order, in one linear pass. Comments (`{# #}`) and the
 * inside of `{% raw %}` are not tags; an unterminated comment or tag ends the text.
 */
function* jinjaTags(text: string, from: number): Generator<JinjaTag> {
  let pos = from
  for (;;) {
    const at = text.indexOf("{", pos)
    if (at === -1 || at + 1 >= text.length) return
    const kind = text[at + 1]
    if (kind !== "#" && kind !== "%") {
      pos = at + 1
      continue
    }
    const close = text.indexOf(kind === "#" ? "#}" : "%}", at + 2)
    if (close === -1) return
    pos = close + 2
    if (kind === "#") continue
    const tag = parseTag(text, at, close)
    if (!tag) continue
    if (tag.name === "raw" && tag.opens) {
      // Nothing inside `{% raw %}` is Jinja: the block runs to its end tag.
      const end = /\{%-?\s*endraw\b/g
      end.lastIndex = pos
      const found = end.exec(text)
      if (!found) {
        yield { name: "raw", closes: false, opens: true, end: text.length }
        return
      }
      const endClose = text.indexOf("%}", found.index)
      pos = endClose === -1 ? text.length : endClose + 2
      yield { name: "raw", closes: false, opens: false, end: pos }
      continue
    }
    yield tag
  }
}

/**
 * Position just past the Jinja tag at `pos`, and past its whole block when it opens one whose text
 * is not the model's own SQL (`{% set x %}…{% endset %}`, `{% call %}`, `{% macro %}`): a query
 * written there is a string for dbt to run, not a CTE of the model.
 */
function skipJinjaBlock(text: string, pos: number): number {
  const close = text.indexOf("%}", pos + 2)
  if (close === -1) return text.length
  const first = parseTag(text, pos, close)
  if (!first || !first.opens || (first.name !== "set" && first.name !== "call" && first.name !== "macro")) return close + 2
  // Blocks of the same kind nest: the block ends at the end tag that matches this one.
  let depth = 1
  for (const tag of jinjaTags(text, close + 2)) {
    if (tag.name !== first.name) continue
    if (tag.closes) depth--
    else if (tag.opens) depth++
    if (depth === 0) return tag.end
  }
  return text.length
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

/** Offset of the `(` that opens a CTE body after `AS [NOT] [MATERIALIZED]` starting at `pos`; -1 when the text there is not such a header. */
function skipHeader(text: string, pos: number): number {
  let at = pos
  const word = (w: string) => {
    const re = new RegExp(`${w}\\b`, "iy")
    re.lastIndex = at
    if (!re.test(text)) return false
    at = skipTrivia(text, at + w.length, true)
    return true
  }
  if (!word("as")) return -1
  if (word("not")) {
    if (!word("materialized")) return -1
  } else word("materialized")
  return text[at] === "(" ? at : -1
}

/** The CTEs of the WITH clause that opens at `withPos`: each `name [(columns)] AS (body)`, separated by commas, up to the first thing that is not one. */
function parseWithClause(text: string, withPos: number, ctes: CteInfo[]): void {
  let pos = skipTrivia(text, withPos + 4, true)
  const keyword = /recursive\b/iy
  keyword.lastIndex = pos
  const recursive = keyword.test(text)
  if (recursive) pos = skipTrivia(text, pos + "recursive".length, true)

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
    // `AS [NOT] [MATERIALIZED] (`, with comments or Jinja tags allowed between the words.
    const open = skipHeader(text, pos)
    if (open === -1) return
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
  const end = readIdentifier(rawName, 0)
  return end === -1 || !rawName.substring(end).trimStart().startsWith("(") ? rawName.trim() : rawName.substring(0, end)
}

export function quoteSqlIdentifier(identifier: string): string {
  if (identifier.match(/^["'`[]/) || identifier.includes(".")) return identifier
  if (!identifier.match(/^[\p{L}_][\p{L}\p{N}_$]*$/u)) return `"${identifier}"`
  return identifier
}

/** Name of the first Jinja block (`if`, `for`, `macro`, `call`, `filter`, `with`, `raw`, or `set` as a block) opened in `text` and never closed there; undefined when every block is closed. Tags inside Jinja comments and `{% raw %}` do not count. */
export function unclosedJinjaBlock(text: string): string | undefined {
  const open: string[] = []
  const counts = new Map<string, number>()
  for (const tag of jinjaTags(text, 0)) {
    if (tag.closes) {
      // An end tag closes the nearest open block of its kind, and any block opened inside it.
      if (!counts.get(tag.name)) continue
      for (let top = open.pop(); top !== undefined; top = open.pop()) {
        counts.set(top, counts.get(top)! - 1)
        if (top === tag.name) break
      }
    } else if (tag.opens) {
      open.push(tag.name)
      counts.set(tag.name, (counts.get(tag.name) ?? 0) + 1)
    }
  }
  return open[0]
}

/**
 * `SELECT COUNT(*)` over one CTE: the model's text up to the end of that CTE (dbt configs, variables,
 * Jinja between CTEs and every earlier CTE of the WITH clause, as written), so the query compiles on its own.
 * Undefined for a CTE of a second WITH clause in the same file, which has no standalone query.
 */
export function buildCountQuery(text: string, ctes: CteInfo[], target: CteInfo): string | undefined {
  // The text before a later WITH holds the earlier clause's whole query: nothing valid stands alone there.
  if (ctes.some((c) => c.withClauseStart < target.withClauseStart)) return undefined
  if (target.queryStart <= target.nameStart) return undefined
  const head = text.substring(0, target.queryEnd + 1).trim()
  return `${head}\nSELECT COUNT(*) AS _profile_count FROM ${quoteSqlIdentifier(stripColumnList(target.name))}`
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
