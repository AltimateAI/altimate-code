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
      pos = skipJinjaBlock(text, pos)
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
    // A captured block (`{% set x %}…{% endset %}`) is not the CTE's SQL: a `)` written there does not close it.
    if (text[pos] === "{" && text[pos + 1] === "%") {
      pos = skipJinjaBlock(text, pos)
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

const BLOCK_TAGS = new Set(["if", "for", "macro", "call", "filter", "with", "set", "raw", "block"])

/** The block tag of the `{% … %}` that spans `at` to `close` (the offset of its `%}`); undefined for any other tag. */
function parseTag(text: string, at: number, close: number): JinjaTag | undefined {
  const head = /^\{%[-+]?\s*(end)?(\w+)/.exec(text.substring(at, Math.min(close + 2, at + 200)))
  if (!head || !BLOCK_TAGS.has(head[2])) return undefined
  const closes = head[1] !== undefined
  // `{% set x = … %}` is an inline set; `{% set x %}` and `{% set x | filter %}` open a block.
  const inline = head[2] === "set" && /^\{%[-+]?\s*set\s+[\w.,\s()]+=(?!=)/.test(text.substring(at, close + 2))
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
      const end = /\{%[-+]?\s*endraw\b/g
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
      const bracketed = BRACKET_NAME
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
  if (keyword.test(text)) pos = skipTrivia(text, pos + "recursive".length, true)

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

/** A CTE name or a reference as written: its text without quotes, and whether it was quoted. */
type Written = { name: string; quoted: boolean }

function written(raw: string): Written {
  const quote = raw[0]
  if ((quote === '"' || quote === "`") && raw.length > 1 && raw.endsWith(quote)) return { name: raw.slice(1, -1).replaceAll(quote + quote, quote), quoted: true }
  if (quote === "[" && raw.endsWith("]")) return { name: raw.slice(1, -1).replaceAll("]]", "]"), quoted: true }
  return { name: raw, quoted: false }
}

/**
 * Whether a reference names a CTE. Two bare names match in any letter case; two quoted ones only exactly. A quoted
 * and a bare one match when the quoted text is the bare name folded to lower case (Postgres, DuckDB, Redshift) or
 * to upper case (Snowflake), the warehouse being unknown here: so `"ORDERS"` names `orders`, and `"Foo"` does not
 * name `foo`.
 */
function sameName(a: Written, b: Written): boolean {
  if (!a.quoted && !b.quoted) return a.name.toLowerCase() === b.name.toLowerCase()
  if (a.quoted && b.quoted) return a.name === b.name
  const [quoted, bare] = a.quoted ? [a, b] : [b, a]
  return quoted.name === bare.name.toLowerCase() || quoted.name === bare.name.toUpperCase()
}

const BARE_WORD = /[\p{L}_][\p{L}\p{N}_$]*/uy
/** A `[name]` (SQL Server), as a CTE's name is read. */
const BRACKET_NAME = /\[(?:[^\]\n]|\]\]){1,256}\]/y
/** A `[name]` in a body: one holding a parenthesis, comma, quote or bracket is an expression, as DuckDB's
 * `[(select …)]` list, unless it is the name of a CTE in the clause (`[a,b]`). */
const BRACKETED = /\[(?:[^\]\n(),'\[]|\]\]){1,256}\]/y

/**
 * Position just past the Jinja delimiter `{{`, `{%` or `{#` at `pos` closes: a comment at its first `#}`; an
 * expression or statement at its `}}` or `%}` outside the quoted strings in it, an expression's braces balanced,
 * as Jinja's lexer reads them.
 */
function jinjaEnd(text: string, pos: number): number {
  const kind = text[pos + 1]
  if (kind === "#") {
    const close = text.indexOf("#}", pos + 2)
    return close === -1 ? text.length : close + 2
  }
  let at = pos + 2
  let depth = 0
  while (at < text.length) {
    const char = text[at]
    if (char === "'" || char === '"') {
      at++
      while (at < text.length && text[at] !== char) at += text[at] === "\\" ? 2 : 1
      at++
    } else if (kind === "{" && char === "{") {
      depth++
      at++
    } else if (kind === "{" && char === "}" && depth > 0) {
      depth--
      at++
    } else if (char === (kind === "{" ? "}" : "%") && text[at + 1] === "}") return at + 2
    else at++
  }
  return text.length
}

/** The blocks whose body is a string for dbt (`{% set x %}…{% endset %}`, a call, a macro), not the model's SQL. */
const CAPTURING = new Set(["set", "call", "macro"])

/**
 * The text with its Jinja blanked to spaces, offsets kept: every `{{ }}`, `{% %}` and `{# #}`, and the body of a
 * captured `set`, `call` or `macro` block. Jinja renders before the SQL is read, so a quote, comment mark or name
 * inside it is not SQL, wherever it sits (in a string, a comment, a quoted name). The text inside `{% raw %}` is
 * kept as written.
 */
function blankJinja(text: string): string {
  const out: string[] = []
  let kept = 0
  // Blanked to spaces, newlines too: a Jinja comment ends no SQL line comment. Whitespace control (`{{-`, `-}}`)
  // takes the whitespace beside the tag with it, newlines included, as rendering does. A comment, which renders to
  // nothing, between two word characters is blanked to word characters instead: `orders{# x #}_archive` renders as
  // one name, not `orders`, and so does a run of such comments. A tag or expression may render either side of it
  // apart (`{% else %}`), so it stays a boundary.
  const word = /[\p{L}\p{N}_$]/u
  const run = { end: -1, joined: false }
  const blank = (from: number, to: number) => {
    const comment = text.startsWith("{#", from)
    if (text[from + 2] === "-") while (from > kept && /\s/.test(text[from - 1])) from--
    if (text[to - 3] === "-") while (to < text.length && /\s/.test(text[to])) to++
    let joined = false
    if (comment && from < run.end) joined = run.joined
    else if (comment) {
      const before = from > kept ? text[from - 1] : (out.at(-1)?.at(-1) ?? "")
      // The text after this comment and the comments right after it, less the whitespace they trim; read once per run.
      let after = to
      while (text.startsWith("{#", after)) {
        after = jinjaEnd(text, after)
        if (text[after - 3] === "-") while (after < text.length && /\s/.test(text[after])) after++
      }
      joined = word.test(before) && word.test(text[after] ?? "")
      run.end = after
      run.joined = joined
    }
    out.push(text.substring(kept, from), (joined ? "_" : " ").repeat(to - from))
    kept = to
    return to
  }
  let pos = 0
  while (pos < text.length) {
    const at = text.indexOf("{", pos)
    if (at === -1 || at + 1 >= text.length) break
    const kind = text[at + 1]
    if (kind !== "{" && kind !== "%" && kind !== "#") {
      pos = at + 1
      continue
    }
    const end = jinjaEnd(text, at)
    const head = kind === "%" ? /^\{%[-+]?\s*(\w+)/.exec(text.substring(at, Math.min(end, at + 200))) : null
    const name = head?.[1]
    if (name === "raw") {
      // The text up to {% endraw %} is output as written.
      const close = /\{%[-+]?\s*endraw\b[^%]*%\}/g
      close.lastIndex = end
      const found = close.exec(text)
      blank(at, end)
      if (found) {
        // Kept as written up to the closing tag, less the whitespace a `{%- endraw %}` trims.
        blank(found.index, close.lastIndex)
        pos = close.lastIndex
      } else pos = text.length
      continue
    }
    const inline = name === "set" && /^\{%[-+]?\s*set\s+[\w.,\s()]+=(?!=)/.test(text.substring(at, end))
    if (name && CAPTURING.has(name) && !inline) {
      // The block's body, to its own end tag (blocks of one kind nest), is blanked with it.
      let depth = 1
      let scan = end
      while (depth > 0 && scan < text.length) {
        const next = text.indexOf("{", scan)
        if (next === -1 || next + 1 >= text.length) {
          scan = text.length
          break
        }
        if (text[next + 1] !== "%" && text[next + 1] !== "{" && text[next + 1] !== "#") {
          scan = next + 1
          continue
        }
        let tagEnd = jinjaEnd(text, next)
        const tag = text[next + 1] === "%" ? /^\{%[-+]?\s*(end)?(\w+)/.exec(text.substring(next, Math.min(tagEnd, next + 200))) : null
        if (tag && !tag[1] && tag[2] === "raw") {
          // Text inside {% raw %} holds no tags: an `{% endset %}` there does not end the block.
          const close = /\{%[-+]?\s*endraw\b[^%]*%\}/g
          close.lastIndex = tagEnd
          tagEnd = close.exec(text) ? close.lastIndex : text.length
        }
        if (tag?.[2] === name) {
          const opensAgain = !tag[1] && !(name === "set" && /^\{%[-+]?\s*set\s+[\w.,\s()]+=(?!=)/.test(text.substring(next, tagEnd)))
          if (tag[1]) depth--
          else if (opensAgain) depth++
        }
        scan = tagEnd
      }
      pos = blank(at, scan)
      continue
    }
    pos = blank(at, end)
  }
  out.push(text.substring(kept))
  return out.join("")
}

/**
 * Position just past the SQL quoted text at `pos`: a single-quoted string, or a `"` or `` ` `` quoted name. A
 * doubled quote stays inside it; in a single-quoted string so does a backslash-escaped quote (Snowflake,
 * BigQuery, Databricks, MySQL). Where a backslash is a plain character (Postgres, DuckDB), a string ending in one
 * runs on past its quote and pairs the quotes after it wrongly: names after it may be missed, or a name in a
 * later string read, so such a model's reads may be off either way.
 */
function skipQuoted(text: string, pos: number): number {
  const quote = text[pos]
  let at = pos + 1
  while (at < text.length) {
    const char = text[at]
    if (char === "\\" && quote === "'") at += 2
    else if (char === quote && text[at + 1] === quote) at += 2
    else if (char === quote) return at + 1
    else at++
  }
  return text.length
}

/**
 * The CTEs the WITH clauses between `start` and `end` define: the query's own, and every subquery's that starts
 * with WITH. Each with where its name is written (`at`), where its definition ends (`from`) and where the query
 * holding it ends (`to`): its name means it from `from` to `to`.
 */
function shadowsIn(sql: string, start: number, end: number): { written: Written; at: number; from: number; to: number }[] {
  const out: { written: Written; at: number; from: number; to: number }[] = []
  const add = (from: number, to: number) => {
    const text = sql.substring(from, to)
    for (const one of detectCtes(text)) {
      // In a WITH RECURSIVE clause a CTE's name means that CTE across the whole clause, its own body included.
      const afterWith = skipTrivia(text, one.withClauseStart + 4, true)
      const recursive = /^recursive\b/i.test(text.substring(afterWith, afterWith + 10))
      out.push({ written: written(stripColumnList(one.name)), at: from + one.nameStart, from: from + (recursive ? one.withClauseStart : one.queryEnd), to })
    }
  }
  if (!/\bwith\b/i.test(sql.substring(start, end))) return out
  add(start, end)
  let pos = start
  while (pos < end) {
    const char = sql[pos]
    if (char === "'" || char === '"' || char === "`") {
      pos = skipQuoted(sql, pos)
      continue
    }
    const skipped = skipLiteral(sql, pos)
    if (skipped !== pos) {
      pos = skipped
      continue
    }
    if (char === "(") {
      const first = skipTrivia(sql, pos + 1, false)
      if (/^with\b/i.test(sql.substring(first, first + 5))) {
        const close = findMatchingClosingParen(sql, pos)
        if (close > pos) add(pos + 1, close)
      }
    }
    pos++
  }
  return out
}

/**
 * For each CTE, the positions (in `ctes`) of the earlier CTEs of its own WITH clause that its body names
 * directly: a name outside strings, comments and Jinja (blanked first: `{{ }}`, `{% %}`, `{# #}`, and the SQL a
 * `{% set %}`, `{% call %}` or `{% macro %}` block captures, which is a string for dbt), not qualified by a dot
 * (`schema . orders`) or inside a longer word, that names the CTE (see `sameName`). Once a CTE the body's own
 * WITH or a subquery's WITH defines has ended, its name is that inner CTE there, not a read of the outer one.
 * A column or alias spelled like an earlier CTE counts too, so a CTE may be listed as read when it is not; a CTE
 * named only through Jinja is not seen, nor one after a nested block comment. A client can estimate a CTE's own
 * time by subtracting the CTEs it reads directly or through another (the closure of `reads`), each once: `reads`
 * records names in the SQL, not the work the warehouse does, so separately timed counts need not add up.
 */
export function cteReads(text: string, ctes: CteInfo[]): number[][] {
  const sql = blankJinja(text)
  // Per WITH clause, the CTEs met so far, by the first letters of their names folded: built up in source order,
  // so each body is scanned once and a reference is compared with few names.
  const seen = new Map<number, Map<string, { written: Written; position: number }[]>>()
  const bucket = (name: string) => name.toLowerCase()
  return ctes.map((cte, position) => {
    // The body's end found again in the Jinja-blanked text: a `)` inside Jinja (`'{{ ')' }}'`) does not end it.
    const close = sql[cte.queryStart - 1] === "(" ? findMatchingClosingParen(sql, cte.queryStart - 1) : -1
    const queryEnd = close > cte.queryStart ? close : cte.queryEnd
    const earlier = seen.get(cte.withClauseStart) ?? new Map<string, { written: Written; position: number }[]>()
    seen.set(cte.withClauseStart, earlier)
    const reads = new Set<number>()
    // The CTEs a WITH inside the body defines (its own, or a subquery's): each shadows an outer CTE of its name
    // once its definition has ended, to the end of the query that holds it.
    // Scopes nest or are disjoint and the scan only moves forward, so each name keeps a stack of the scopes open at
    // the scan position: a reference is compared with the scopes that hold it, not every scope of its name.
    type Shadow = { written: Written; at: number; from: number; to: number }
    const inner = new Map<string, { scopes: Shadow[]; next: number; open: Shadow[] }>()
    const definedAt = new Set<number>()
    for (const one of earlier.size > 0 ? shadowsIn(sql, cte.queryStart, queryEnd) : []) {
      definedAt.add(one.at)
      const named = inner.get(bucket(one.written.name))
      if (named) named.scopes.push(one)
      else inner.set(bucket(one.written.name), { scopes: [one], next: 0, open: [] })
    }
    for (const named of inner.values()) named.scopes.sort((a, b) => a.from - b.from)
    const shadows = (ref: Written, at: number) => {
      const named = inner.get(bucket(ref.name))
      if (!named) return false
      const { scopes, open } = named
      while (named.next < scopes.length && scopes[named.next].from < at) {
        const one = scopes[named.next++]
        while (open.length > 0 && open[open.length - 1].to <= one.from) open.pop()
        open.push(one)
      }
      while (open.length > 0 && open[open.length - 1].to <= at) open.pop()
      return open.some((one) => one.from < at && at < one.to && sameName(one.written, ref))
    }
    let pos = cte.queryStart
    // The last character of SQL read before `pos`, past whitespace and comments: a dot qualifies the next name.
    let previous = ""
    while (earlier.size > 0 && pos < queryEnd) {
      const char = sql[pos]
      if (/\s/.test(char)) {
        pos++
        continue
      }
      if (char === "'") {
        pos = skipQuoted(sql, pos)
        previous = "'"
        continue
      }
      let end = -1
      if (char === '"' || char === "`") end = skipQuoted(sql, pos)
      else if (char === "[") {
        BRACKETED.lastIndex = pos
        BRACKET_NAME.lastIndex = pos
        if (BRACKETED.test(sql)) end = BRACKETED.lastIndex
        else if (BRACKET_NAME.test(sql)) {
          const ref = written(sql.substring(pos, BRACKET_NAME.lastIndex))
          const declared = (list?: { written: Written }[]) => (list ?? []).some((one) => sameName(one.written, ref))
          if (declared(earlier.get(bucket(ref.name))) || declared(inner.get(bucket(ref.name))?.scopes)) end = BRACKET_NAME.lastIndex
        }
      } else {
        // A comment or a dollar-quoted string is skipped whole.
        const skipped = skipLiteral(sql, pos)
        if (skipped !== pos) {
          if (char === "$") previous = "$"
          pos = skipped
          continue
        }
        BARE_WORD.lastIndex = pos
        if (/[\p{L}_]/u.test(String.fromCodePoint(sql.codePointAt(pos) ?? 32)) && BARE_WORD.test(sql)) end = BARE_WORD.lastIndex
      }
      if (end === -1) {
        previous = char
        pos++
        continue
      }
      if (previous !== "." && !/[\p{L}\p{N}_$]/u.test(sql[pos - 1] ?? " ")) {
        const ref = written(sql.substring(pos, end))
        const named = (earlier.get(bucket(ref.name)) ?? []).filter((one) => sameName(one.written, ref))
        // An inner CTE's own name where it is defined is no reference at all, and one in scope shadows the outer.
        const shadowed = definedAt.has(pos) || shadows(ref, pos)
        if (!shadowed) for (const one of named) reads.add(one.position)
      }
      previous = sql[end - 1]
      pos = end
    }
    const own = written(stripColumnList(cte.name))
    const list = earlier.get(bucket(own.name))
    if (list) list.push({ written: own, position })
    else earlier.set(bucket(own.name), [{ written: own, position }])
    return [...reads].sort((a, b) => a - b)
  })
}

/**
 * Offset from which the CTEs could not be read, or undefined when every CTE was read: the
 * comma after the last CTE read of a WITH clause that goes on, or the start of a clause where none was read
 * (its first name is built by a Jinja expression or loop). The list is short from there on.
 */
export function unreadCteAfter(text: string, ctes: CteInfo[]): number | undefined {
  const found: number[] = []
  for (const withPos of findTopLevelWithKeywords(text)) {
    const own = ctes.filter((c) => c.withClauseStart === withPos)
    if (own.length === 0) {
      // `START WITH` (a hierarchical query) opens no CTE list.
      if (/\bstart\s*$/i.test(text.substring(Math.max(0, withPos - 24), withPos))) continue
      let first = skipTrivia(text, withPos + 4, true)
      if (/recursive\b/iy.test(text.substring(first, first + 10))) first = skipTrivia(text, first + "recursive".length, true)
      const unreadName = /^[\p{L}\p{N}_$]*\{\{/u.exec(text.substring(first, first + 130))
      if (unreadName) found.push(first)
      continue
    }
    const last = own[own.length - 1]
    const next = skipTrivia(text, last.queryEnd + 1, true)
    if (text[next] === ",") found.push(next)
  }
  return found.length ? Math.min(...found) : undefined
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
