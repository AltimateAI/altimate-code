const SIDE_EFFECT_RE =
  /\b(insert|update|delete|drop|alter|create|truncate|merge|grant|revoke|call|exec|execute|copy|into|vacuum|attach)\b/i

export type SanitizedAssertionSql =
  | { ok: true; sql: string }
  | { ok: false; reason: "empty" | "multi_statement" | "side_effect" | "not_select" | "unknown_relation" }

type ScanState = "normal" | "single" | "double" | "backtick" | "bracket" | "line_comment" | "block_comment"

function stripTrailingStatementSemicolon(sql: string): SanitizedAssertionSql {
  let state: ScanState = "normal"
  const semicolons: number[] = []
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!
    const next = sql[i + 1]
    if (state === "line_comment") {
      if (ch === "\n") state = "normal"
      continue
    }
    if (state === "block_comment") {
      if (ch === "*" && next === "/") {
        state = "normal"
        i++
      }
      continue
    }
    if (state === "single") {
      if (ch === "'" && next === "'") {
        i++
      } else if (ch === "'") {
        state = "normal"
      }
      continue
    }
    if (state === "double") {
      if (ch === '"' && next === '"') {
        i++
      } else if (ch === '"') {
        state = "normal"
      }
      continue
    }
    if (state === "backtick") {
      if (ch === "`") state = "normal"
      continue
    }
    if (state === "bracket") {
      if (ch === "]") state = "normal"
      continue
    }

    if (ch === "-" && next === "-") {
      state = "line_comment"
      i++
      continue
    }
    if (ch === "/" && next === "*") {
      state = "block_comment"
      i++
      continue
    }
    if (ch === "'") state = "single"
    else if (ch === '"') state = "double"
    else if (ch === "`") state = "backtick"
    else if (ch === "[") state = "bracket"
    else if (ch === ";") semicolons.push(i)
  }

  if (semicolons.length === 0) return { ok: true, sql: sql.trim() }
  if (semicolons.length > 1) return { ok: false, reason: "multi_statement" }
  if (withoutStringsAndComments(sql.slice(semicolons[0]! + 1)).trim()) {
    return { ok: false, reason: "multi_statement" }
  }
  return { ok: true, sql: sql.slice(0, semicolons[0]).trim() }
}

function withoutStringsAndComments(sql: string): string {
  let state: ScanState = "normal"
  let out = ""
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!
    const next = sql[i + 1]
    if (state === "line_comment") {
      if (ch === "\n") {
        state = "normal"
        out += "\n"
      } else {
        out += " "
      }
      continue
    }
    if (state === "block_comment") {
      if (ch === "*" && next === "/") {
        state = "normal"
        out += "  "
        i++
      } else {
        out += ch === "\n" ? "\n" : " "
      }
      continue
    }
    if (state === "single") {
      if (ch === "'" && next === "'") {
        out += "  "
        i++
      } else if (ch === "'") {
        state = "normal"
        out += " "
      } else {
        out += ch === "\n" ? "\n" : " "
      }
      continue
    }
    if (state === "double") {
      out += ch === "\n" ? "\n" : " "
      if (ch === '"' && next === '"') i++
      else if (ch === '"') state = "normal"
      continue
    }
    if (state === "backtick") {
      out += ch === "\n" ? "\n" : " "
      if (ch === "`") state = "normal"
      continue
    }
    if (state === "bracket") {
      out += ch === "\n" ? "\n" : " "
      if (ch === "]") state = "normal"
      continue
    }

    if (ch === "-" && next === "-") {
      state = "line_comment"
      out += "  "
      i++
    } else if (ch === "/" && next === "*") {
      state = "block_comment"
      out += "  "
      i++
    } else if (ch === "'") {
      state = "single"
      out += " "
    } else if (ch === '"') {
      state = "double"
      out += " "
    } else if (ch === "`") {
      state = "backtick"
      out += " "
    } else if (ch === "[") {
      state = "bracket"
      out += " "
    } else {
      out += ch
    }
  }
  return out
}

function withoutCommentsAndStringLiterals(sql: string): string {
  let state: ScanState = "normal"
  let out = ""
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!
    const next = sql[i + 1]
    if (state === "line_comment") {
      if (ch === "\n") {
        state = "normal"
        out += "\n"
      } else {
        out += " "
      }
      continue
    }
    if (state === "block_comment") {
      if (ch === "*" && next === "/") {
        state = "normal"
        out += "  "
        i++
      } else {
        out += ch === "\n" ? "\n" : " "
      }
      continue
    }
    if (state === "single") {
      if (ch === "'" && next === "'") {
        out += "  "
        i++
      } else if (ch === "'") {
        state = "normal"
        out += " "
      } else {
        out += ch === "\n" ? "\n" : " "
      }
      continue
    }
    if (state === "double") {
      out += ch
      if (ch === '"' && next === '"') {
        out += next
        i++
      } else if (ch === '"') {
        state = "normal"
      }
      continue
    }
    if (state === "backtick") {
      out += ch
      if (ch === "`") state = "normal"
      continue
    }
    if (state === "bracket") {
      out += ch
      if (ch === "]") state = "normal"
      continue
    }

    if (ch === "-" && next === "-") {
      state = "line_comment"
      out += "  "
      i++
    } else if (ch === "/" && next === "*") {
      state = "block_comment"
      out += "  "
      i++
    } else if (ch === "'") {
      state = "single"
      out += " "
    } else if (ch === '"') {
      state = "double"
      out += ch
    } else if (ch === "`") {
      state = "backtick"
      out += ch
    } else if (ch === "[") {
      state = "bracket"
      out += ch
    } else {
      out += ch
    }
  }
  return out
}

function normalizeIdentifierPart(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed.slice(1, -1)
  if (trimmed.length >= 2 && trimmed[0] === trimmed[trimmed.length - 1] && (trimmed[0] === '"' || trimmed[0] === "`")) {
    const quote = trimmed[0]
    return trimmed.slice(1, -1).replaceAll(`${quote}${quote}`, quote)
  }
  return trimmed
}

function normalizeRelation(value: string): string {
  return value
    .trim()
    .split(/\s*\.\s*/g)
    .map(normalizeIdentifierPart)
    .join(".")
    .toLowerCase()
}

function relationAliases(name: string): string[] {
  const normalized = normalizeRelation(name)
  const parts = normalized.split(".").filter(Boolean)
  return [...new Set([normalized, parts.length >= 2 ? parts.slice(-2).join(".") : "", parts.at(-1) ?? ""].filter(Boolean))]
}

function allowedRelationSet(allowedRelations: Iterable<string>): Set<string> {
  const out = new Set<string>()
  for (const relation of allowedRelations) {
    for (const alias of relationAliases(relation)) out.add(alias)
  }
  return out
}

function cteNames(sql: string): Set<string> {
  const out = new Set<string>()
  if (!/^\s*with\b/i.test(sql)) return out
  const re = /(?:\bwith\b|,)\s*([A-Za-z_][\w$]*|"[^"]+"|`[^`]+`|\[[^\]]+\])\s*(?:\([^)]*\))?\s+as\s*\(/gi
  for (const match of sql.matchAll(re)) out.add(normalizeRelation(match[1] ?? ""))
  return out
}

function referencedRelations(sql: string): string[] {
  const refs: string[] = []
  const ident = String.raw`(?:"[^"]+"|` + "`[^`]+`" + String.raw`|\[[^\]]+\]|[A-Za-z_][\w$]*)`
  const relation = `${ident}(?:\\s*\\.\\s*${ident}){0,2}`
  const re = new RegExp(`\\b(?:from|join)\\s+(${relation})`, "gi")
  for (const match of sql.matchAll(re)) refs.push(normalizeRelation(match[1] ?? ""))
  const factor = `${relation}(?:\\s+(?:as\\s+)?${ident})?`
  const commaList = new RegExp(`\\bfrom\\s+(${factor}(?:\\s*,\\s*${factor})+)`, "gi")
  for (const match of sql.matchAll(commaList)) {
    const group = match[1] ?? ""
    const factorRe = new RegExp(`(?:^|,)\\s*(${relation})`, "gi")
    for (const factorMatch of group.matchAll(factorRe)) refs.push(normalizeRelation(factorMatch[1] ?? ""))
  }
  return refs
}

function relationAllowed(relation: string, allowed: Set<string>): boolean {
  const parts = normalizeRelation(relation).split(".").filter(Boolean)
  if (parts.length > 1) return allowed.has(parts.join("."))
  return relationAliases(relation).some((alias) => allowed.has(alias))
}

export function sanitizeAssertionSql(sql: string, allowedRelations: Iterable<string>): SanitizedAssertionSql {
  const single = stripTrailingStatementSemicolon(sql)
  if (!single.ok) return single
  const trimmed = single.sql.trim()
  if (!trimmed) return { ok: false, reason: "empty" }

  const structuralScan = withoutStringsAndComments(trimmed)
  if (SIDE_EFFECT_RE.test(structuralScan)) return { ok: false, reason: "side_effect" }
  if (!/^\s*select\b/i.test(structuralScan) && !/^\s*with\b[\s\S]*\bselect\b/i.test(structuralScan)) {
    return { ok: false, reason: "not_select" }
  }

  const relationScan = withoutCommentsAndStringLiterals(trimmed)
  const allowed = allowedRelationSet(allowedRelations)
  const ctes = cteNames(relationScan)
  for (const relation of referencedRelations(relationScan)) {
    if (ctes.has(relation)) continue
    if (!relationAllowed(relation, allowed)) return { ok: false, reason: "unknown_relation" }
  }

  return { ok: true, sql: `select count(*) as n from ( ${trimmed} ) _s` }
}
