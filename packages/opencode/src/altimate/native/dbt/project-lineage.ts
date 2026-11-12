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

/**
 * Whether stripping the SQL's literals and comments left nothing it can't account for: no stray quote,
 * backslash, bracket, dollar-quote or unclosed comment. Fail-closed: when this is false, the text checks
 * below can't be sure what the SQL names, so the proof stops.
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
      if (t === ")" || t === "," || t === ";" || ends.test(t) || joins.test(t)) return k
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
      // A backslash marks an alias template (DuckDB `columns('.*') as "col_\0"`), not a column.
      if (typeof name !== "string" || !name || name === "*" || name.includes("\\")) return
      const k = name.toLowerCase()
      const t = typeof type === "string" ? type : ""
      const had = found.get(k)
      if (!had || (!had.type && t)) found.set(k, { name: k, type: t })
    }
    for (const [k, c] of Object.entries<any>(n?.columns ?? {})) add(c?.name || k, c?.data_type || c?.type)
    if (n?.resource_type === "seed") for (const c of this.seedHeader(n)) add(c)
    if (this.traced(id) && !this.busy.has(id)) {
      for (const e of this.lineage(id).edges) add(e.to)
      const sql = this.sqlOf(id)
      if (sql) for (const c of this.outputColumns(sql)) add(c)
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
   * A model's are settled by a SELECT list with no `*` and no column named at run time (IDENTIFIER(),
   * COLUMNS()), or, with a `*`, by lineage that resolved over parents whose own columns are settled.
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
        ? !this.lineage(id).unresolved && this.parents(id).every((p) => this.settledColumns(p) !== undefined)
        : this.outputColumns(sql).length > 0)
    }
    const out = settled ? names : undefined
    this.settledMemo.set(id, out)
    return out
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
