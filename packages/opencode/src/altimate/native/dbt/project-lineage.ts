// The project's column resolver: each model's (or snapshot's) column lineage from the manifest's
// compiled SQL and the lineage engine, and each node's columns, shared by dbt_lineage and the
// column impact answer so both read a model against the same parent columns. Without a dbt process
// or a warehouse:
// - relations keyed `database.schema.name`, so two parents sharing a table name stay apart;
// - ephemeral parents expanded to their own parents (the child's SQL inlines them as CTEs);
// - a parent's columns are its documented ones, the targets of its own lineage and its SELECT list,
//   resolved in DAG order, so `select *` over an undocumented parent still resolves;
// - aggregate `FILTER (WHERE …)` clauses dropped before analysis (the engine loses every aggregate
//   column of a SELECT that has one);
// - a WITH nested inside a CTE reported unresolved (the engine loses it and attaches outputs to any
//   parent with a column of the same name);
// - SQL that reads tables but yields no edge reported unresolved, never as "not affected".
import * as fs from "fs"
import * as path from "path"
import { createHash } from "crypto"
import * as core from "@altimateai/altimate-core"
import { loadRawManifest, detectDialect } from "./helpers"

/** = same · ~ renamed · ƒ calculated · Σ aggregated · ? unknown */
export type How = "=" | "~" | "ƒ" | "Σ" | "?"
/** "engine": the engine's own label; "name": inferred from matching names. */
export type HowFrom = "engine" | "name" | null
export type ShapeFlag = "unnest" | "pivot" | "except" | "nested_with" | "filter_rewritten"

export interface LineageEdge {
  from: string
  fromCol: string
  to: string
  how: How
  howFrom: HowFrom
}

export interface ModelLineage {
  edges: LineageEdge[]
  /** Why the engine's answer for this model can't be used, when it can't. */
  unresolved?: string
  /** The engine read only part of the SQL: its edges stand, and what it missed may carry a value. */
  partial?: string
  flags: ShapeFlag[]
}

// ---------------------------------------------------------------------------------------------
// SQL rewrites and shape checks

/**
 * `agg(x) filter (where c)` reads like `agg(x)` for lineage: drop the clause (parenthesis-matched,
 * quote-aware) so the engine keeps the aggregate columns.
 */
export function stripAggFilter(sql: string): string {
  let out = ""
  let at = 0
  const re = /\)\s*filter\s*\(\s*where\b/gi
  for (let m = re.exec(sql); m; m = re.exec(sql)) {
    const open = sql.indexOf("(", m.index + 1)
    let depth = 0
    let quote: string | null = null
    let j = open
    for (; j < sql.length; j++) {
      const ch = sql[j]
      if (quote) {
        if (ch === quote) quote = null
        continue
      }
      if (ch === "'" || ch === '"') quote = ch
      else if (ch === "(") depth++
      else if (ch === ")" && --depth === 0) break
    }
    out += sql.slice(at, m.index + 1)
    at = j + 1
    re.lastIndex = at
  }
  return out + sql.slice(at)
}

/**
 * SQL with comments blanked and string literals (quoted or dollar-quoted) emptied, in one pass so
 * none can swallow another.
 */
export function stripSql(sql: string): string {
  // A quoted name ("a--b", `c/*d`, [e--f]) is kept whole, so comment marks inside it start no comment.
  return sql.replace(
    /"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[(?:[^\]]|\]\])*\]|'(?:[^']|'')*'|\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$|--[^\r\n]*|\/\*[\s\S]*?\*\//g,
    (match) =>
      match.startsWith('"') || match.startsWith("`") || match.startsWith("[") ? match : match.startsWith("'") || match.startsWith("$") ? "''" : " ",
  )
}

/** A WITH opened inside a parenthesis: a CTE (or subquery) with its own WITH. */
export function hasNestedWith(sql: string): boolean {
  return /\(\s*with\s+(?:recursive\s+)?[a-z_][a-z0-9_]*\s+as\s*\(/i.test(stripSql(sql))
}

const ENGINE_NAME = /^_(?:col_)?\d+$/i
const COLUMNS_CALL = /(?<![\w$])columns\s*\(/i

/**
 * The engine's own name for an unaliased expression in a SELECT list (`_1`, `_col_1`): not the warehouse's
 * name for it. A name the SQL itself writes (`amount as _1`) is a real alias.
 */
function engineMade(name: string, stripped: string): boolean {
  return ENGINE_NAME.test(name) && !new RegExp(`(?<![\\w$])${name}(?![\\w$])`, "i").test(stripped)
}

/**
 * Whether a SELECT list's output names are the columns the warehouse makes. The engine lists no outputs for an
 * unaliased expression or a `*`, so an empty list doesn't settle; neither does a repeated name, which the
 * warehouse renames.
 */
function namesItsOutputs(outputs: string[]): boolean {
  const names = outputs.map((name) => name.toLowerCase())
  return names.length > 0 && new Set(names).size === names.length
}

const QUOTED = '"(?:[^"]|"")*"|`[^`]*`|\\[[^\\]]*\\]'
const unquoteName = (name: string) => name.replace(/^["`[]|["`\]]$/g, "").toLowerCase()

/**
 * The items of the SQL's outermost SELECT list (the first one outside parentheses, so after any WITH), split at
 * top-level commas, from literal- and comment-stripped SQL; [] when there is none.
 */
export function selectItems(stripped: string): string[] {
  // A quoted name is blanked whole, so `"from"` or `"a,b"` ends no item.
  const text = stripped.replace(new RegExp(QUOTED, "g"), (q) => " ".repeat(q.length))
  let depth = 0
  let start = -1
  const items: string[] = []
  let from = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === "(") depth++
    else if (ch === ")") depth--
    if (depth !== 0) continue
    const word = /^[a-z_]+/i.exec(text.slice(i))?.[0]?.toLowerCase()
    const boundary = i === 0 || !/[\w$]/.test(text[i - 1]!)
    if (start < 0) {
      if (boundary && word === "select") {
        start = i + 6
        // A whole word only: `allocation` and `distinct_users` are column names, not modifiers.
        const lead = /^\s+(?:distinct\s+on\s*\([^)]*\)|distinct|all|top\s+\d+)(?![\w$])/i.exec(text.slice(start))
        if (lead) start += lead[0].length
        from = start
        i = start - 1
      }
      continue
    }
    if (ch === ",") {
      items.push(stripped.slice(from, i).trim())
      from = i + 1
    } else if (boundary && word && /^(from|into|where|union|intersect|except|group|order|limit|qualify|having|window)$/.test(word)) {
      items.push(stripped.slice(from, i).trim())
      return items.filter((one) => one !== "")
    }
  }
  if (start >= 0) items.push(stripped.slice(from).trim())
  return items.filter((one) => one !== "")
}

/** Words that end an expression (`x is null`, `case … end`) rather than alias it. */
const ENDS_EXPRESSION = /^(?:null|true|false|end)$/i
/** Words after which the next word is an operand (`a and b`, `sum(x) over w`), not an alias. */
const TAKES_OPERAND = /^(?:and|or|not|is|in|like|ilike|rlike|regexp|similar|to|between|case|when|then|else|over|collate|escape|interval|distinct|by|as|at|zone|any|all|some|exists|div|mod|xor)$/i

/**
 * A SELECT item's output name when the SQL gives one (`x as name`, `x name`, a bare `t.col`), `*` for a star,
 * else null.
 */
export function itemName(item: string): string | null {
  if (/^(?:[\w$]+\.)*\*(?:\s|$)/.test(item)) return "*"
  const as = new RegExp(`\\s+as\\s+(${QUOTED}|[\\w$]+)$`, "i").exec(item)
  if (as) return unquoteName(as[1]!)
  const bare = new RegExp(`^(?:(?:${QUOTED}|[\\w$]+)\\.)*(${QUOTED}|[\\w$]+)$`).exec(item)
  if (bare) return unquoteName(bare[1]!)
  // An alias without AS: the last word, after an expression that ends in a name, a `)`, a quote or a literal.
  const plain = new RegExp(`^([\\s\\S]*?[\\w$)"\`\\]'])\\s+(${QUOTED}|[\\w$]+)$`).exec(item)
  if (!plain) return null
  const before = /([\w$]+)\s*$/.exec(plain[1]!)?.[1]
  if ((before && TAKES_OPERAND.test(before)) || /(?<![\w$])interval\s+(?:''|[\d.]+)$/i.test(plain[1]!)) return null
  return ENDS_EXPRESSION.test(plain[2]!) ? null : unquoteName(plain[2]!)
}

/** The column a SELECT item casts, unaliased (`amount::numeric`, `cast(t.amount as numeric)`); null otherwise. */
function castColumn(item: string): string | null {
  const ref = `(?:(?:${QUOTED}|[\\w$]+)\\.)*(${QUOTED}|[\\w$]+)`
  // A type name: words (`double precision`, `pg_catalog.int4`), a size (`numeric(10, 2)`), array marks (`int[]`,
  // `int[3]`), a quoted name, a further `::` cast.
  const type = `((?:[\\w\\s(),:.]|\\[\\d*\\]|"(?:[^"]|"")*")+)`
  const m = new RegExp(`^${ref}\\s*::\\s*${type}$`, "i").exec(item) ?? new RegExp(`^cast\\s*\\(\\s*${ref}\\s+as\\s+${type}\\)$`, "i").exec(item)
  if (!m || NOT_TYPE.test(m[2]!.replace(new RegExp(QUOTED, "g"), " "))) return null
  return unquoteName(m[1]!)
}

/** Words that make the rest of an item more than a type (`amount::numeric is not null`, `amount::int as x`). */
const NOT_TYPE =
  /(?<![\w$])(?:as|is|not|isnull|notnull|null|true|false|between|in|like|ilike|similar|and|or|div|mod|xor|collate|at|over|filter|case|when|then|else|end|escape)(?![\w$])/i

/**
 * The alias templates `COLUMNS(...) AS "…"` items give (DuckDB's `"col_\0"`, which hold a `\N` marker), lower-cased.
 * An alias without a marker is the output's own name.
 */
function columnsTemplates(stripped: string): Set<string> {
  const out = new Set<string>()
  const call = new RegExp(COLUMNS_CALL.source, "gi")
  // A quoted name is blanked whole, so a `)` or `columns(` inside one neither ends nor starts a call.
  const text = stripped.replace(new RegExp(QUOTED, "g"), (q) => " ".repeat(q.length))
  for (let m = call.exec(text); m; m = call.exec(text)) {
    let depth = 0
    let i = m.index + m[0].length - 1
    for (; i < text.length; i++) {
      if (text[i] === "(") depth++
      else if (text[i] === ")" && --depth === 0) break
    }
    const alias = new RegExp(`^\\s*as\\s+(${QUOTED}|[\\w$]+)`, "i").exec(stripped.slice(i + 1))
    if (alias && /\\\d/.test(alias[1]!)) out.add(unquoteName(alias[1]!))
  }
  return out
}

/**
 * The names DuckDB gives a SELECT list's repeated outputs, in list order: an output whose name is already used takes
 * the first free `_N` (`val, val, val` is `val, val_1, val_2`; `id, id, amount as id_1` is `id, id_1, id_1_1`).
 */
function duckdbRepeats(outputs: string[]): string[] {
  const used = new Set<string>()
  const out: string[] = []
  for (const raw of outputs) {
    const name = raw.toLowerCase()
    if (!used.has(name)) {
      used.add(name)
      continue
    }
    let k = 1
    while (used.has(`${name}_${k}`)) k++
    used.add(`${name}_${k}`)
    out.push(`${name}_${k}`)
  }
  return out
}

/**
 * Whether stripping the SQL's literals and comments left nothing it can't account for: no stray quote,
 * backslash, bracket, dollar-quote or unclosed comment. Fail-closed: when this is false, the text checks
 * below can't be sure what the SQL names, so the model gets that as its reason.
 */
export function quotingIsClear(sql: string): boolean {
  if (/\$[A-Za-z_]*\$/.test(sql)) return false
  const rest = stripSql(sql)
    .replace(/''/g, " ")
    .replace(/"(?:[^"]|"")*"|`(?:[^`]|``)*`/g, " ")
  return !/['"`\\[\]]|\/\*|\*\//.test(rest)
}

/**
 * How the SQL's FROM lists read: "row" when a relation or its alias is used as a value anywhere other than
 * `alias.column` (`to_json(t)`, `select t from t`, `t as row`, `t::text`); "unclear" when a FROM list holds
 * something other than a named relation, a parenthesised subquery or a parenthesised join of these, each
 * with an optional alias (a table function, TABLESAMPLE, PIVOT, an unquoted dash, …); null otherwise.
 * Fail-closed: anything it can't classify is "unclear". A column that shares a table's name counts as a row,
 * which only adds doubt.
 */
export function relationUse(sql: string): "row" | "unclear" | null {
  const code = stripSql(sql).toLowerCase()
  const word = '"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[\\p{L}_][\\p{L}\\p{N}_$]*'
  const punct = /^[.,()=<>+\-*/:;]$/
  const isWord = (t: string | undefined) => !!t && !punct.test(t) && !/^\d/.test(t)
  const unquote = (t: string) => t.replace(/^["`[]|["`\]]$/g, "")
  const tokens = [...code.matchAll(new RegExp(String.raw`${word}|\d[\w.]*|[.,()=<>+\-*/:;]`, "gu"))].map((m) => m[0])
  // A FROM list ends only at one of these, at a closing parenthesis of its level, or at the end.
  const ends = /^(where|group|having|qualify|window|order|limit|offset|fetch|union|intersect|except)$/
  const joins = /^(join|left|right|full|inner|outer|cross|natural)$/
  // Functions whose arguments use FROM as syntax, not as a list of tables (`extract(year from d)`).
  const fromSyntax = /^(extract|trim|substring|overlay)$/
  // Words that can't be an alias: anything after an item that isn't one of the shapes below is unclear.
  const reserved = /^(on|using|join|left|right|full|inner|outer|cross|natural|lateral|as|select|where|group|having|qualify|window|order|limit|offset|fetch|union|intersect|except|tablesample|pivot|unpivot|match_recognize|at|before|changes|for|start|connect|sample)$/
  const close = (open: number) => {
    let depth = 0
    for (let k = open; k < tokens.length; k++) {
      if (tokens[k] === "(") depth++
      else if (tokens[k] === ")" && --depth === 0) return k
    }
    return -1
  }
  // An ON condition: read through, nested parentheses whole, up to what ends it at this level.
  const condition = (k: number) => {
    while (k < tokens.length) {
      const t = tokens[k]!
      if (t === "(") {
        const end = close(k)
        if (end < 0) return -1
        k = end + 1
        continue
      }
      // A clause or join word ends the condition, but not as a qualified name (`on a.offset = b.offset`).
      if (t === ")" || t === "," || t === ";" || ((ends.test(t) || joins.test(t)) && tokens[k - 1] !== ".")) return k
      k++
    }
    return k
  }
  const names = new Set<string>()
  const named = new Set<number>()
  /** Reads one FROM list, item by item: the index it ends at, or -1 when something in it can't be placed. */
  const readList = (from: number): number => {
    let k = from + 1
    for (;;) {
      if (tokens[k] === "lateral") k++
      if (tokens[k] === "(") {
        const end = close(k)
        if (end < 0) return -1
        // A subquery's own FROM is read where the scan below meets it; a parenthesised join is read here.
        if (!/^(select|with|from)$/.test(tokens[k + 1] ?? "") && readList(k) !== end) return -1
        k = end + 1
      } else {
        let last = -1
        while (isWord(tokens[k]) && !reserved.test(unquote(tokens[k]!))) {
          last = k
          if (tokens[k + 1] !== ".") break
          k += 2
        }
        if (last < 0) return -1
        names.add(unquote(tokens[last]!))
        named.add(last)
        k = last + 1
        // A table function (unnest(…), flatten(…), table(…)): what it reads isn't a named column.
        if (tokens[k] === "(") return -1
      }
      if (tokens[k] === "as") k++
      if (isWord(tokens[k]) && !reserved.test(unquote(tokens[k]!))) {
        names.add(unquote(tokens[k]!))
        named.add(k)
        k++
      }
      // After an item: the next one, a join condition, or the end of the list.
      for (;;) {
        const t = tokens[k]
        if (t === undefined || t === ";" || t === ")" || ends.test(t)) return k
        if (t === ",") {
          k++
          break
        }
        if (joins.test(t)) {
          while (k < tokens.length && tokens[k] !== "join" && joins.test(tokens[k]!)) k++
          if (tokens[k] !== "join") return -1
          k++
          break
        }
        if (t === "on") {
          k = condition(k + 1)
          if (k < 0) return -1
          continue
        }
        if (t === "using") {
          const end = tokens[k + 1] === "(" ? close(k + 1) : -1
          if (end < 0) return -1
          k = end + 1
          continue
        }
        return -1
      }
    }
  }
  const opener: string[] = [""]
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === "(") opener.push(tokens[i - 1] ?? "")
    else if (t === ")") {
      if (opener.length > 1) opener.pop()
    } else if (t === "from") {
      // FROM as syntax: extract(year from d), trim(both from s), a is distinct from b.
      if (fromSyntax.test(opener[opener.length - 1]!) || tokens[i - 1] === "distinct") continue
      if (readList(i) < 0) return "unclear"
    }
  }
  for (const [i, raw] of tokens.entries()) {
    if (named.has(i) || !names.has(unquote(raw))) continue
    const prev = tokens[i - 1] ?? ""
    const next = tokens[i + 1] ?? ""
    // `t.x` or `db.s.t`, or a CTE being defined (`with t as (`, `, t as (`).
    if (next === "." || prev === "." || prev === "with" || (next === "as" && tokens[i + 2] === "(")) continue
    return "row"
  }
  return null
}


/**
 * Whether the SQL selects `*` or `t.*` in any form (DISTINCT ON, TOP n, AS STRUCT, multi-part or
 * quoted qualifiers, EXCLUDE/EXCEPT/REPLACE/RENAME modifiers). Every `*` counts except count(*) and
 * multiplication, which has an operand on both sides that is not a keyword ending the projection.
 */
export function selectsStar(sql: string): boolean {
  const code = stripSql(sql)
  const ends = /^(from|exclude|except|replace|rename|ilike|columns)\b/i
  for (let at = code.indexOf("*"); at !== -1; at = code.indexOf("*", at + 1)) {
    const before = code.slice(0, at).trimEnd()
    const after = code.slice(at + 1).trimStart()
    const prev = before.at(-1) ?? ""
    const next = after[0] ?? ""
    // count(*) reads no column; hash(*), object_construct(*), struct(*) read them all.
    if (prev === "(" && next === ")" && /\bcount(?:_big|_if)?\s*\($/i.test(before)) continue
    if (prev === "." || next === "" || next === "," || next === ")" || ends.test(after)) return true
    const operand = /[\w"'`\])]/
    // A sign on the right operand (`revenue * -1`) belongs to it.
    const right = after.replace(/^[+-]\s*/, "")[0] ?? ""
    if (operand.test(prev) && (operand.test(right) || right === "(" || /\d/.test(right))) {
      // An operand before the `*` that is itself a keyword (SELECT, DISTINCT, ALL, STRUCT) is no operand.
      if (/\b(select|distinct|all|struct)$/i.test(before)) return true
      continue
    }
    return true
  }
  return false
}

export function shapeFlags(sql: string): ShapeFlag[] {
  const code = stripSql(sql)
  const flags: ShapeFlag[] = []
  if (/\b(?:unnest|flatten|explode(?:_outer)?|posexplode)\s*\(/i.test(code)) flags.push("unnest")
  if (/\b(?:un)?pivot\b/i.test(code)) flags.push("pivot")
  if (/\bexcept\b/i.test(code)) flags.push("except")
  return flags
}

const AGGREGATE =
  /\b(?:sum|count|avg|min|max|median|approx_\w+|array_agg|listagg|string_agg|stddev\w*|variance|var_\w+|any_value|bool_and|bool_or|count_if|arbitrary|max_by|min_by|percentile\w*)\s*\(/i

/** The engine's lens when it gives one; otherwise "=" by matching names, or "?". */
export function howOf(lens: unknown, code: unknown, source: string, target: string): { how: How; howFrom: HowFrom } {
  if (lens === "Original") return { how: "=", howFrom: "engine" }
  if (lens === "Alias") return { how: "~", howFrom: "engine" }
  if (lens === "Transformation") {
    const steps = Array.isArray(code) ? code.map((s: any) => String(s?.expression ?? "")).join(" ") : ""
    return { how: AGGREGATE.test(steps) ? "Σ" : "ƒ", howFrom: "engine" }
  }
  return source === target ? { how: "=", howFrom: "name" } : { how: "?", howFrom: null }
}

export const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Quoted or bare parts of `"db"."schema"."table"."col"` or `orders.col`. */
function idents(text: string): string[] {
  return [...text.matchAll(/"((?:[^"]|"")*)"|([^."]+)/g)].map((m) => (m[1] ?? m[2] ?? "").replace(/""/g, '"'))
}

// ---------------------------------------------------------------------------------------------
// Caches: engine results keyed by a hash of the SQL and the schema it was read against, so a
// recompiled manifest reuses every model whose SQL and parents' columns did not change.

const CACHE_LIMIT = 20_000
const lineageCache = new Map<string, any>()
const outputColumnsCache = new Map<string, string[]>()
const readsCache = new Map<string, Set<string> | null>()

function remember<T>(cache: Map<string, T>, key: string, make: () => T): T {
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const value = make()
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  cache.set(key, value)
  return value
}

const hash = (...parts: string[]) => createHash("sha1").update(parts.join("\0")).digest("hex")

/** Clears the engine result caches (tests). */
export function clearLineageCaches() {
  lineageCache.clear()
  outputColumnsCache.clear()
  readsCache.clear()
}

// ---------------------------------------------------------------------------------------------
// Per-manifest lineage

const TRACED = new Set(["model", "snapshot"])

export class ProjectLineage {
  readonly nodes: Record<string, any>
  readonly sources: Record<string, any>
  /** Model and snapshot children of each node, from depends_on. */
  readonly children: Record<string, string[]> = {}
  private readonly columnMemo = new Map<string, { name: string; type: string }[]>()
  private readonly lineageMemo = new Map<string, ModelLineage>()
  private readonly settledMemo = new Map<string, Set<string> | undefined>()
  private readonly busy = new Set<string>()

  constructor(
    readonly manifest: any,
    readonly dialect: string,
    readonly projectDir: string | null,
  ) {
    this.nodes = manifest.nodes ?? {}
    this.sources = manifest.sources ?? {}
    for (const [id, node] of Object.entries<any>(this.nodes)) {
      if (!TRACED.has(node?.resource_type)) continue
      for (const parent of node.depends_on?.nodes ?? []) (this.children[parent] ??= []).push(id)
    }
  }

  node(id: string): any {
    return this.nodes[id] ?? this.sources[id]
  }

  traced(id: string): boolean {
    return TRACED.has(this.nodes[id]?.resource_type)
  }

  ephemeral(id: string): boolean {
    return this.nodes[id]?.config?.materialized === "ephemeral"
  }

  /** Parents with ephemeral ones replaced by their own parents. */
  parents(id: string): string[] {
    const out: string[] = []
    const queue = [...(this.node(id)?.depends_on?.nodes ?? [])]
    const seen = new Set<string>()
    while (queue.length) {
      const p = queue.shift()!
      if (seen.has(p)) continue
      seen.add(p)
      if (!this.node(p)) continue
      if (this.ephemeral(p)) queue.push(...(this.node(p).depends_on?.nodes ?? []))
      else out.push(p)
    }
    return out
  }

  /** Children, and the children reached through ephemeral children (they read this node inlined). */
  readers(id: string): string[] {
    const out: string[] = []
    const queue = [...(this.children[id] ?? [])]
    const seen = new Set<string>()
    while (queue.length) {
      const c = queue.shift()!
      if (seen.has(c)) continue
      seen.add(c)
      out.push(c)
      if (this.ephemeral(c)) queue.push(...(this.children[c] ?? []))
    }
    return out
  }

  /** Every model and snapshot downstream, at model level. */
  descendants(id: string): Set<string> {
    const seen = new Set<string>()
    const queue = [id]
    while (queue.length)
      for (const c of this.children[queue.shift()!] ?? []) if (!seen.has(c)) (seen.add(c), queue.push(c))
    return seen
  }

  /** The nodes that read this one directly. */
  childrenOf(id: string): string[] {
    return this.children[id] ?? []
  }

  /** The nodes this one reads directly, at model level. */
  parentsOf(id: string): string[] {
    return (this.node(id)?.depends_on?.nodes ?? []).filter((p: string) => !!this.node(p))
  }

  /** Every node upstream, at model level. */
  ancestors(id: string): Set<string> {
    const seen = new Set<string>()
    const queue = [id]
    while (queue.length)
      for (const p of this.node(queue.shift()!)?.depends_on?.nodes ?? [])
        if (this.node(p) && !seen.has(p)) (seen.add(p), queue.push(p))
    return seen
  }

  private relationKey(n: any): string {
    const name = n.resource_type === "source" ? n.identifier || n.name : n.alias || n.name
    return [n.database, n.schema, name]
      .filter((p) => typeof p === "string" && p !== "")
      .join(".")
      .toLowerCase()
  }

  sqlOf(id: string): string {
    const n = this.nodes[id]
    return String(n?.compiled_code || n?.compiled_sql || "")
  }

  private outputColumns(sql: string): string[] {
    return remember(outputColumnsCache, hash(this.dialect, sql), () => {
      try {
        return (core.extractOutputColumns(sql, this.dialect) as string[]).map(String)
      } catch {
        return []
      }
    })
  }

  /** Columns the SQL names anywhere (filters, joins, groupings included), lower-cased; null when the engine can't list them. */
  reads(id: string): Set<string> | null {
    const sql = this.sqlOf(id)
    if (!sql) return new Set()
    return remember(readsCache, hash(this.dialect, sql), () => {
      try {
        return new Set(
          ((core.extractMetadata(sql, this.dialect) as any).columns ?? []).map((c: string) => String(c).toLowerCase()),
        )
      } catch {
        return null
      }
    })
  }

  seedHeader(n: any): string[] {
    if (!this.projectDir || !n.original_file_path) return []
    try {
      const first = fs.readFileSync(path.join(this.projectDir, n.original_file_path), "utf8").split(/\r?\n/)[0] ?? ""
      return first.split(",").map((c) => c.trim().replace(/^"|"$/g, ""))
    } catch {
      return []
    }
  }

  /** A node's columns: documented, plus (models) its own lineage targets and SELECT list, (seeds) its CSV header. */
  columns(id: string): { name: string; type: string }[] {
    const memo = this.columnMemo.get(id)
    if (memo) return memo
    const n = this.node(id)
    const found = new Map<string, { name: string; type: string }>()
    const add = (name: unknown, type?: unknown) => {
      if (typeof name !== "string" || !name || name === "*") return
      const k = name.toLowerCase()
      const t = typeof type === "string" ? type : ""
      const had = found.get(k)
      if (!had || (!had.type && t)) found.set(k, { name: k, type: t })
    }
    for (const [k, c] of Object.entries<any>(n?.columns ?? {})) add(c?.name || k, c?.data_type || c?.type)
    if (n?.resource_type === "seed") for (const c of this.seedHeader(n)) add(c)
    if (this.traced(id) && !this.busy.has(id)) {
      // Names from the SQL that aren't the warehouse's: the engine's own name for an unaliased expression
      // (`_1`, `_col_1`), and the alias template a COLUMNS(...) item gives (`as "col_\0"`). A documented name is
      // kept as it is.
      const sql = this.sqlOf(id)
      const stripped = sql ? stripSql(sql) : ""
      const templates = columnsTemplates(stripped)
      const edges = this.lineage(id).edges
      // A name a parent column of the same name passes on (`select * from r` over r's real `_1`) is that column.
      const passed = new Set(edges.filter((e) => e.fromCol === e.to).map((e) => e.to))
      const real = (name: string) => !templates.has(name.toLowerCase()) && (passed.has(name) || !engineMade(name, stripped))
      for (const e of edges) if (real(e.to)) add(e.to)
      const outputs = sql ? this.outputColumns(sql).filter(real) : []
      for (const c of outputs) add(c)
      // DuckDB keeps a repeated output under a new name (`val`, `val_1`): a `select *` over it reads both. Only
      // the SELECT list decides the names; a documented `val_1` is that rename.
      if (this.dialect === "duckdb") for (const c of duckdbRepeats(outputs)) add(c)
    }
    const out = [...found.values()]
    this.columnMemo.set(id, out)
    return out
  }

  /** Parents (ephemeral ones expanded) for which the docs, a seed header and their own SQL give no column. */
  unknownParents(id: string): string[] {
    return this.parents(id).filter((p) => this.columns(p).length === 0)
  }

  /**
   * The node's columns, lower-cased, when nothing can be missing from them; undefined otherwise.
   * A model's are settled by a SELECT list with no `*`, no column named at run time (IDENTIFIER(),
   * COLUMNS()), no unaliased expression and no repeated name (the warehouse names or renames those), or,
   * with a `*`, by lineage that resolved over parents whose own columns are settled.
   * A seed's are its header, when it can be read; a source's are never settled.
   */
  settledColumns(id: string): Set<string> | undefined {
    if (this.settledMemo.has(id)) return this.settledMemo.get(id)
    this.settledMemo.set(id, undefined)
    const names = new Set(this.columns(id).map((c) => c.name))
    let settled = names.size > 0
    // A source's docs often list only some of its columns; a seed's header lists them all.
    if (settled && !this.traced(id))
      settled = this.node(id)?.resource_type === "seed" && this.seedHeader(this.node(id)).some((c) => c.trim() !== "")
    if (settled && this.traced(id)) {
      const sql = this.sqlOf(id)
      settled = !!sql && !/(?<![\w$])(?:identifier|columns)\s*\(/i.test(stripSql(sql)) && (selectsStar(sql)
        ? !this.lineage(id).unresolved && this.parents(id).every((p) => this.settledColumns(p) !== undefined) &&
          !this.renamesBesideStar(id, stripSql(sql))
        : namesItsOutputs(this.outputColumns(sql)))
    }
    const out = settled ? names : undefined
    this.settledMemo.set(id, out)
    return out
  }

  /** Whether a bare `*` sits beside an output that repeats a name the star brings in (`select *, val as id`). */
  private renamesBesideStar(id: string, stripped: string): boolean {
    const items = selectItems(stripped)
    if (!items.some((item) => /^\*(?:\s|$)/.test(item))) return false
    const brought = new Set(this.parents(id).flatMap((p) => [...(this.settledColumns(p) ?? [])]))
    const explicit = items.map(itemName).filter((name): name is string => !!name && name !== "*")
    return new Set(explicit).size !== explicit.length || explicit.some((name) => brought.has(name))
  }

  lineage(id: string): ModelLineage {
    const memo = this.lineageMemo.get(id)
    if (memo) return memo
    this.busy.add(id)
    try {
      const result = this.computeLineage(id)
      this.lineageMemo.set(id, result)
      return result
    } finally {
      this.busy.delete(id)
    }
  }

  private computeLineage(id: string): ModelLineage {
    const raw = this.sqlOf(id)
    if (!raw) return { edges: [], unresolved: "no compiled SQL: run `dbt compile`", flags: [] }
    const sql = stripAggFilter(raw)
    const flags = shapeFlags(raw)
    if (sql !== raw) flags.push("filter_rewritten")
    if (hasNestedWith(sql)) {
      flags.push("nested_with")
      return { edges: [], unresolved: "a WITH nested inside a CTE: the engine's columns here are unreliable", flags }
    }

    const tables: Record<string, any> = {}
    const byKey: Record<string, string> = {}
    const parents = this.parents(id)
    for (const p of parents) {
      const pn = this.node(p)
      const k = this.relationKey(pn)
      byKey[k] = p
      const cols = this.columns(p)
      if (!cols.length) continue
      tables[k] = {
        ...(pn.database && { database: pn.database }),
        ...(pn.schema && { schema: pn.schema }),
        columns: cols,
      }
    }
    const schemaJson = JSON.stringify({ version: "1", tables })
    const result = remember(lineageCache, hash(this.dialect, sql, schemaJson), () => {
      try {
        const schema = Object.keys(tables).length ? core.Schema.fromJson(schemaJson) : undefined
        return JSON.parse(JSON.stringify(core.columnLineage(sql, this.dialect, schema)))
      } catch (e) {
        return { exception: String(e instanceof Error ? e.message : e).slice(0, 200) }
      }
    })
    if (result.exception) return { edges: [], unresolved: result.exception, flags }

    const edges: LineageEdge[] = []
    const seen = new Set<string>()
    const keyOf = (text: string): [string, string] => {
      const parts = idents(text)
      const col = parts.pop() ?? ""
      return [parts.join(".").toLowerCase(), col]
    }
    // The engine's edge order changes from process to process. A fixed order keeps the answer the same
    // between runs, and settles which of two entries for one edge is used.
    const ordered = (result.column_lineage ?? [])
      .map((e: any) => ({ e, key: [e?.source, e?.target, e?.lens_type, JSON.stringify(e?.lens_code)].join("\0") }))
      .sort((a: { key: string }, b: { key: string }) => compareText(a.key, b.key))
    for (const { e } of ordered) {
      const text = String(e?.source ?? "")
      let [k, col] = keyOf(text)
      // A column the schema doesn't list comes back as ""db"".""schema"".""table"".col.
      if (!byKey[k] && text.startsWith('""')) [k, col] = keyOf(text.replace(/""/g, '"'))
      const from = byKey[k]
      if (!from || !col) continue
      const fromCol = col.toLowerCase()
      const to = String(e.target ?? "").toLowerCase()
      if (!to) continue
      const dedupe = `${from}|${fromCol}|${to}`
      if (seen.has(dedupe)) continue
      seen.add(dedupe)
      edges.push({ from, fromCol, to, ...howOfEdge(e, fromCol, to) })
    }
    // The engine names an unaliased expression twice: `_N`, as if the value passed through unchanged, and
    // `_col_N`, how unknown. Keep the second; the warehouse picks the real name.
    // A `_N` the SQL itself writes (`amount as _1`) is a real alias and stays.
    const stripped = stripSql(raw)
    const named = new Set(edges.filter((e) => /^_col_\d+$/.test(e.to)).map((e) => `${e.from}|${e.fromCol}|${e.to.slice(5)}`))
    for (let i = edges.length - 1; i >= 0; i--) {
      const e = edges[i]!
      if (/^_\d+$/.test(e.to) && engineMade(e.to, stripped) && named.has(`${e.from}|${e.fromCol}|${e.to.slice(1)}`)) edges.splice(i, 1)
    }
    // Postgres and Redshift name an unaliased cast of a column after the column (`amount::numeric` is `amount`).
    if (this.dialect === "postgres" || this.dialect === "redshift") {
      const items = selectItems(stripped)
      for (const e of edges) {
        // A `_col_N` the SQL writes itself (`amount::numeric as _col_1`) is that output's name: keep it.
        const n = engineMade(e.to, stripped) ? /^_col_(\d+)$/.exec(e.to)?.[1] : undefined
        const name = n === undefined ? null : castColumn(items[Number(n)] ?? "")
        if (name && !edges.some((o) => o.from === e.from && o.fromCol === e.fromCol && o.to === name)) e.to = name
      }
    }
    const errors: unknown[] = Array.isArray(result.errors) ? result.errors : []
    const firstError = (): string => {
      const first: any = errors[0]
      return String(first?.message ?? first).slice(0, 200)
    }
    if (!edges.length && errors.length) return { edges, unresolved: firstError(), flags }
    if (!edges.length && parents.length)
      return {
        edges,
        unresolved: `reads ${parents.length} table${parents.length === 1 ? "" : "s"} but the engine traced no column (select * over columns it can't see?)`,
        flags,
      }
    return { edges, flags, ...(errors.length && { partial: firstError() }) }
  }
}

function howOfEdge(e: any, fromCol: string, to: string) {
  return howOf(e?.lens_type, e?.lens_code, fromCol, to)
}

/**
 * Why a model can't have the column, when its columns are settled and don't include it (any case);
 * undefined when it has it or its columns may be incomplete.
 */
export function missingColumn(p: ProjectLineage, id: string, column: string): string | undefined {
  const settled = p.settledColumns(id)
  if (!settled || settled.has(column.toLowerCase())) return undefined
  const names = [...settled].sort(compareText)
  const shown = names.length > 12 ? `${names.slice(0, 12).join(", ")} and ${names.length - 12} more` : names.join(", ")
  return `${String(p.node(id)?.name ?? id)} has no column ${column}; its columns are ${shown}`
}

const projects = new WeakMap<object, Map<string, ProjectLineage>>()

export function projectLineage(manifestPath: string, dialect?: string): ProjectLineage {
  const manifest = loadRawManifest(manifestPath)
  if (!manifest) throw new Error(`Manifest not found at ${manifestPath}`)
  const d = dialect || detectDialect(manifest)
  let byDialect = projects.get(manifest)
  if (!byDialect) projects.set(manifest, (byDialect = new Map()))
  let p = byDialect.get(d)
  if (!p) {
    const target = path.dirname(path.resolve(manifestPath))
    byDialect.set(d, (p = new ProjectLineage(manifest, d, path.dirname(target))))
  }
  return p
}
