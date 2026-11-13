/**
 * Output column names of a query's final SELECT, read from the SQL text.
 * Column lineage only reports columns that read a source column, so literal
 * and function-only columns (`current_date as load_date`, `1 as one`) are
 * invisible to it; this fills that gap. Conservative by design: an item counts
 * only when it is aliased (`… as name` / `… name`) or a bare (qualified)
 * column; anything else contributes nothing. `*` makes the list unknown.
 */

/** Text with comments blanked, same length. */
function blankComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, (m) => " ".repeat(m.length)).replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
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

/** Output names of the final top-level SELECT, or null when unknown (`*`, unparseable). */
export function selectListNames(sql: string): string[] | null {
  const flat = flatten(sql)
  const selects = [...flat.matchAll(/\bselect\b/gi)]
  if (!selects.length) return null
  const start = selects[selects.length - 1].index! + "select".length
  const fromRel = flat.slice(start).search(/\bfrom\b/i)
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
  }
  return names
}
