// altimate_change - new file

const STOP = new Set([
  "select", "from", "where", "as", "not", "and", "or", "is", "in", "null", "true", "false",
  "case", "when", "then", "else", "end", "on", "join", "by", "group", "order", "having",
  "distinct", "over", "partition", "with", "union", "all", "asc", "desc", "limit", "offset",
  "coalesce", "cast", "try_cast", "safe_cast", "sum", "count", "min", "max", "avg",
  "lower", "upper", "trim", "ltrim", "rtrim", "round", "abs", "ceil", "floor", "nullif", "ifnull", "nvl",
  "date_trunc", "date", "timestamp", "dateadd", "datediff", "extract", "current_date", "current_timestamp",
  "concat", "substring", "substr", "replace", "length", "greatest", "least", "ref", "source", "config", "var", "if",
  "col", "column", "table", "entity", "x", "sql",
])

/** Remove call arguments, including nested calls, while keeping the function identifier. */
function withoutArguments(text: string): string {
  let depth = 0
  let quote = ""
  let result = ""
  for (const char of text) {
    if (depth && quote) {
      if (char === quote) quote = ""
      continue
    }
    if (depth && (char === "'" || char === '"')) {
      quote = char
      continue
    }
    if (char === "(") {
      if (!depth) result += " "
      depth++
    } else if (char === ")") {
      depth = Math.max(0, depth - 1)
    } else if (!depth) result += char
  }
  return result
}

/** Only backtick code identifiers establish overlap; prose-only contradictions rely on the reflector and replacement step. */
export function anchors(text: string): Set<string> {
  const result = new Set<string>()
  for (const span of text.matchAll(/(`+)([\s\S]*?)\1/g)) {
    const code = withoutArguments(span[2].toLowerCase()).replace(/<[^>]*>/g, "")
    for (const token of code.match(/[a-z_][a-z0-9_]*/g) ?? []) {
      if (!STOP.has(token) && /[a-z]/.test(token)) result.add(token)
    }
  }
  return result
}

function matches(affix: string, token: string): boolean {
  return (affix.startsWith("_") && token.endsWith(affix)) || (affix.endsWith("_") && token.startsWith(affix))
}

/** Shared identifiers, using the affix itself when it matches a concrete identifier. */
export function sharedAnchors(a: string, b: string): string[] {
  const shared = new Set<string>()
  const left = anchors(a)
  const right = anchors(b)
  for (const x of left) {
    for (const y of right) {
      if (x === y || matches(x, y)) shared.add(x)
      else if (matches(y, x)) shared.add(y)
    }
  }
  return [...shared].sort()
}
