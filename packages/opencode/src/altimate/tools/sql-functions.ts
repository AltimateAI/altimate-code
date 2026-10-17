import { tokenizeSql } from "./sql-tokenize"

type Part = { kind: "code" | "literal" | "identifier"; text: string; start: number; end: number }

export interface SqlFunctionCall {
  name: string
  args: string[]
  escaped: boolean
  /** Lowercased schema or catalog prefix, when the call is written `schema.name(...)`. */
  qualifier?: string
}

/** Recognize calls using SQL tokens: punctuation inside quoted names is never code. */
export function sqlFunctionCalls(sql: string, dialect?: string): SqlFunctionCall[] {
  const parts: Part[] = []
  let offset = 0
  for (const token of tokenizeSql(sql, dialect).tokens) {
    if (token.kind === "code") {
      for (const match of token.text.matchAll(/[A-Za-z_][A-Za-z0-9_$]*|[^\s]/g)) {
        parts.push({
          kind: "code",
          text: match[0],
          start: offset + match.index!,
          end: offset + match.index! + match[0].length,
        })
      }
    } else if (token.kind !== "comment") {
      parts.push({ kind: token.kind, text: token.text, start: offset, end: offset + token.text.length })
    }
    offset += token.text.length
  }
  const calls: SqlFunctionCall[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part.kind !== "identifier" && (part.kind !== "code" || !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(part.text))) continue
    // U&"..." [UESCAPE '...'] needs decoding before its function name is trustworthy.
    const escaped = part.kind === "identifier" && parts[i - 1]?.text === "&" && /^u$/i.test(parts[i - 2]?.text ?? "")
    let open = i + 1
    if (escaped && /^uescape$/i.test(parts[open]?.text ?? "") && parts[open + 1]?.kind === "literal") open += 2
    if (parts[open]?.kind !== "code" || parts[open].text !== "(") continue
    const name =
      part.kind === "identifier"
        ? part.text.slice(1, -1).replaceAll(part.text.at(-1)!.repeat(2), part.text.at(-1)!)
        : part.text
    const args: string[] = []
    let start = parts[open].end
    let depth = 1
    for (let j = open + 1; j < parts.length; j++) {
      if (parts[j].kind !== "code") continue
      const text = parts[j].text
      if (text === "(" || text === "[" || text === "{") depth++
      if (text === ")" || text === "]" || text === "}") depth--
      if (depth === 0 || (text === "," && depth === 1)) {
        args.push(sql.slice(start, parts[j].start))
        start = parts[j].end
      }
      if (depth === 0) break
    }
    let qualifier: string | undefined
    if (parts[i - 1]?.kind === "code" && parts[i - 1].text === "." && parts[i - 2]) {
      const q = parts[i - 2]
      qualifier = (q.kind === "identifier" ? q.text.slice(1, -1) : q.text).toLowerCase()
    }
    calls.push({ name: name.toLowerCase(), args, escaped, qualifier })
  }
  return calls
}

/** Only literal SQL is provable. Expressions, parameters and ambiguous escapes fail closed. */
export function sqlLiteral(argument: string | undefined, dialect?: string): string | undefined {
  if (argument === undefined) return undefined
  const { tokens, complete } = tokenizeSql(argument, dialect)
  const values = tokens.filter((token) => token.kind !== "comment" && !(token.kind === "code" && !token.text.trim()))
  if (!complete || values.length !== 1 || values[0].kind !== "literal") return undefined
  const text = values[0].text
  const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text)?.[0]
  if (tag) return text.slice(tag.length, -tag.length)
  // E strings and engines with backslash strings can encode quotes, keywords and delimiters.
  // Refuse escapes rather than interpreting an engine-dependent string incorrectly.
  if (text.includes("\\") && (/^[eE]/.test(text) || !/^(postgres|duckdb|sqlite)$/i.test(dialect ?? "")))
    return undefined
  return text.slice(/^[eE]/.test(text) ? 2 : 1, -1).replaceAll("''", "'")
}
