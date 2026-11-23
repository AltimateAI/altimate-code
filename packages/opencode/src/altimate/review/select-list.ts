/**
 * Output column names of a query's final SELECT, read from the SQL text.
 * Column lineage only reports columns that read a source column, so literal
 * and function-only columns (`current_date as load_date`, `1 as one`) are
 * invisible to it; this fills that gap. Conservative by design: an item counts
 * only when it is aliased (`… as name` / `… name`) or a bare (qualified)
 * column; anything else contributes nothing. `*` makes the list unknown.
 */

/** Text with `--` and block comments blanked, same length. Quoted strings and
 *  quoted identifiers are skipped first, so `'x--y'` is not a comment. */
export function blankComments(sql: string): string {
  let out = ""
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    if (c === "'" || c === '"' || c === "`") {
      // A doubled quote inside a string is an escaped quote.
      let j = i + 1
      while (j < sql.length && !(sql[j] === c && sql[j + 1] !== c)) j += sql[j] === c ? 2 : 1
      out += sql.slice(i, j + 1)
      i = j + 1
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i)
      const stop = end < 0 ? sql.length : end
      out += " ".repeat(stop - i)
      i = stop
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2)
      const stop = end < 0 ? sql.length : end + 2
      out += sql.slice(i, stop).replace(/[^\n]/g, " ")
      i = stop
    } else {
      out += c
      i++
    }
  }
  return out
}

/** Text with comments, quoted strings and parenthesized groups blanked, same length. */
function flatten(sql: string): string {
  let s = blankComments(sql)
  s = s.replace(/'(?:[^']|'')*'/g, (m) => "'" + "_".repeat(m.length - 2) + "'")
  let out = ""
  let depth = 0
  for (const c of s) {
    if (c === "(") {
      depth++
      out += "("
    } else if (c === ")") {
      depth = Math.max(0, depth - 1)
      out += ")"
    } else out += depth > 0 ? " " : c
  }
  return out
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/
const unquote = (s: string) => s.replace(/^["`\[]|["`\]]$/g, "")

/** A top-level set operator (parenthesized groups are already blanked). */
const SET_OP = /\b(union|intersect|except|minus)\b(\s+(all|distinct))?\s*(\bselect\b|\()/i

/**
 * Offset just past the `select` keyword of the final top-level query. For a
 * set operation (`… union all select …`) that is the chain's first branch,
 * which names the output columns.
 */
function finalSelectStart(flat: string): number | undefined {
  const selects = [...flat.matchAll(/\bselect\b/gi)]
  if (!selects.length) return undefined
  const head = SET_OP.test(flat) ? selects[0] : selects[selects.length - 1]
  return head.index! + "select".length
}

/** Output names of the final top-level SELECT, or null when unknown (`*`, unparseable).
 *  A set operation (`UNION` …) takes its names from its first branch. Items it
 *  cannot name contribute nothing, unless `complete` is set: then any unnamed
 *  item makes the whole list unknown (null). */
export function selectListNames(sql: string, opts: { complete?: boolean } = {}): string[] | null {
  const flat = flatten(sql)
  const start = finalSelectStart(flat)
  if (start === undefined) return null
  const fromRel = flat.slice(start).search(/\b(from|union|intersect|except|minus)\b/i)
  const listFlat = flat.slice(start, fromRel < 0 ? undefined : start + fromRel)
  const listRaw = blankComments(sql).slice(start, fromRel < 0 ? undefined : start + fromRel)
  // Split on top-level commas (the flattened text has no nested commas).
  const names: string[] = []
  let pos = 0
  for (const piece of listFlat.split(",")) {
    const raw = listRaw.slice(pos, pos + piece.length)
    pos += piece.length + 1
    const item = piece.replace(/^\s*(distinct|all)\s+/i, "").trim()
    if (!item) continue
    if (/(^|\.)\*$/.test(item)) return null
    const rawItem = raw.trim().replace(/^(distinct|all)\s+/i, "")
    const bare = /^(?:[A-Za-z_][A-Za-z0-9_$]*\.)*("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)$/.exec(rawItem)
    let name = bare ? unquote(bare[1]) : undefined
    if (!name) {
      const m = /\s(as\s+)?("[^"]+"|`[^`]+`|[A-Za-z_][A-Za-z0-9_$]*)\s*$/i.exec(rawItem)
      const before = m ? rawItem.slice(0, m.index).trimEnd() : ""
      // An alias follows a complete expression: `… as x`, or `expr x` where expr
      // ends in an identifier, `)`, a literal or `end` (never `a + b`).
      if (m && before && (m[1] || /([A-Za-z0-9_$"`\]')]|\bend)$/i.test(before))) name = unquote(m[2])
    }
    if (name && (IDENT.test(name) || /^[^"`]+$/.test(name)) && !/^(end|null|true|false)$/i.test(name)) names.push(name.toLowerCase())
    else if (opts.complete) return null
  }
  return names
}

/**
 * Output names of the final SELECT, following `select * from <cte>` to that
 * CTE's own select list (dbt's `select * from final`). Null when unknown;
 * `complete` is passed to `selectListNames`.
 */
export function finalSelectNames(sql: string, opts: { complete?: boolean } = {}): string[] | null {
  // String contents blanked too, so a `')'` literal can't close a CTE body early.
  const text = blankComments(sql).replace(/'(?:[^']|'')*'/g, (m) => "'" + "_".repeat(m.length - 2) + "'")
  let query = sql
  for (let hop = 0; hop < 5; hop++) {
    const names = selectListNames(query, opts)
    if (names) return names
    const flat = flatten(query)
    const start = finalSelectStart(flat)
    if (start === undefined) return null
    const tail = flat.slice(start)
    const from = /^\s*\*\s+from\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:(?:where|order|limit|qualify)\b[\s\S]*)?;?\s*$/i.exec(tail)
    if (!from) return null
    // The CTE's body: the parenthesis after `<name> as`.
    const def = new RegExp(`(?:\\bwith\\s+(?:recursive\\s+)?|,\\s*)${from[1]}\\s+as\\s*\\(`, "i").exec(text)
    if (!def) return null
    const open = def.index + def[0].length - 1
    let level = 0
    let close = -1
    for (let i = open; i < text.length && close < 0; i++) {
      if (text[i] === "(") level++
      else if (text[i] === ")" && --level === 0) close = i
    }
    if (close < 0) return null
    query = text.slice(open + 1, close)
  }
  return null
}
