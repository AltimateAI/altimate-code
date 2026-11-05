// Column impact answer: where a column's value goes downstream (or comes from upstream), hop by
// hop, from the manifest's compiled SQL and the lineage engine, with what the engine could not
// settle kept visible as tiers rather than dropped.
//
// Inputs, per model, all without a dbt process or a warehouse:
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
import { loadRawManifest, detectDialect, findModel } from "./helpers"

/** Must match the pinned `@altimateai/altimate-core` version (a test checks it). */
export const ENGINE = "altimate-core 0.9.0"
export const MAX_ANSWER_COLUMNS = 2000

/** = same · ~ renamed · ƒ calculated · Σ aggregated · ? unknown */
export type How = "=" | "~" | "ƒ" | "Σ" | "?"
/** "engine": the engine's own label; "name": inferred from matching names. */
export type HowFrom = "engine" | "name" | null
export type ShapeFlag = "unnest" | "pivot" | "except" | "nested_with" | "filter_rewritten"

export const WORKAROUNDS = [
  "relations keyed database.schema.name",
  "ephemeral parents expanded",
  "parent columns = documented + own lineage targets + SELECT list",
  "aggregate FILTER clause dropped before analysis",
  "WITH nested inside a CTE reported unresolved",
  "reads with zero traced columns reported unresolved",
]

export interface ColumnAnswerNode {
  id: string
  name: string
  folder: string
  materialized: string | null
  contract: boolean
  tests: number
  exposures: string[]
}

export interface ColumnAnswerColumn {
  /** Index into `nodes`. */
  model: number
  column: string
  hop: number
  /** Downstream: no reader of its own. Upstream: no source of its own. */
  end: boolean
  /** How it was reached; null on the focus column. */
  how: How | null
  how_from: HowFrom
  type?: string
}

/** [from column, to column, how], plus "name" when `how` was inferred from matching names. */
export type ColumnAnswerEdge = [number, number, How] | [number, number, How, "name"]

export interface ColumnAnswer {
  version: 1
  focus: { model: string; column: string }
  direction: "downstream" | "upstream"
  inputs: {
    manifest: { generated_at: string | null; older_than_sql: boolean }
    sql: "compiled_code"
    catalog: null
    engine: string
    workarounds: string[]
  }
  counts: {
    columns: number
    models: number
    hops: number
    contracts: number
    ends: number
    may_carry_models: number
    cleared_models: number
    model_level: number
  }
  nodes: ColumnAnswerNode[]
  columns: ColumnAnswerColumn[]
  edges: ColumnAnswerEdge[]
  also_reads: { model: number; columns: string[]; downstream: number }[]
  unresolved: { model: number; reason: string; downstream?: number }[]
  flags: { model: number; flag: ShapeFlag }[]
  /** Model-level downstream (upstream: ancestors) in none of the tiers, by name. Not in `nodes`. */
  cleared: { id: string; name: string }[]
  truncated: boolean
  next: null
}

interface LineageEdge {
  from: string
  fromCol: string
  to: string
  how: How
  howFrom: HowFrom
}

interface ModelLineage {
  edges: LineageEdge[]
  /** Why the engine's answer for this model can't be used, when it can't. */
  unresolved?: string
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

/** SQL with comments blanked and string literals emptied. */
function codeOnly(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'|--[^\r\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith("'") ? "''" : " "))
}

/** A WITH opened inside a parenthesis: a CTE (or subquery) with its own WITH. */
export function hasNestedWith(sql: string): boolean {
  return /\(\s*with\s+(?:recursive\s+)?[a-z_][a-z0-9_]*\s+as\s*\(/i.test(codeOnly(sql))
}

export function shapeFlags(sql: string): ShapeFlag[] {
  const code = codeOnly(sql)
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
const readsCache = new Map<string, Set<string>>()

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
export function clearColumnAnswerCache() {
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

  private ephemeral(id: string): boolean {
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

  /** Columns the SQL names anywhere (filters, joins, groupings included), lower-cased. */
  reads(id: string): Set<string> {
    const sql = this.sqlOf(id)
    if (!sql) return new Set()
    return remember(readsCache, hash(this.dialect, sql), () => {
      try {
        return new Set(
          ((core.extractMetadata(sql, this.dialect) as any).columns ?? []).map((c: string) => String(c).toLowerCase()),
        )
      } catch {
        return new Set<string>()
      }
    })
  }

  private seedHeader(n: any): string[] {
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
      for (const e of this.lineage(id).edges) add(e.to)
      const sql = this.sqlOf(id)
      if (sql) for (const c of this.outputColumns(sql)) add(c)
    }
    const out = [...found.values()]
    this.columnMemo.set(id, out)
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
    for (const e of result.column_lineage ?? []) {
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
    if (!edges.length && errors.length) {
      const first: any = errors[0]
      return { edges, unresolved: String(first?.message ?? first).slice(0, 200), flags }
    }
    if (!edges.length && parents.length)
      return {
        edges,
        unresolved: `reads ${parents.length} table${parents.length === 1 ? "" : "s"} but the engine traced no column (select * over columns it can't see?)`,
        flags,
      }
    return { edges, flags }
  }
}

function howOfEdge(e: any, fromCol: string, to: string) {
  return howOf(e?.lens_type, e?.lens_code, fromCol, to)
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

// ---------------------------------------------------------------------------------------------
// The answer

export function columnAnswer(
  manifestPath: string,
  model: string,
  column: string,
  direction: "downstream" | "upstream" = "downstream",
  dialect?: string,
): ColumnAnswer {
  const p = projectLineage(manifestPath, dialect)
  const focusNode =
    findModel(p.nodes, model) ??
    (p.traced(model) ? p.nodes[model] : null) ??
    Object.values<any>(p.nodes).find((n) => n?.resource_type === "snapshot" && n.name === model)
  if (!focusNode) throw new Error(`Model '${model}' not found in manifest`)
  const focus: string = focusNode.unique_id ?? Object.keys(p.nodes).find((id) => p.nodes[id] === focusNode)!
  const want = column.toLowerCase()

  const tests: Record<string, number> = {}
  for (const n of Object.values<any>(p.nodes))
    if (n?.resource_type === "test") for (const d of n.depends_on?.nodes ?? []) tests[d] = (tests[d] ?? 0) + 1
  const exposures: Record<string, string[]> = {}
  for (const x of Object.values<any>(p.manifest.exposures ?? {}))
    for (const d of x?.depends_on?.nodes ?? []) (exposures[d] ??= []).push(String(x.label || x.name))

  const nodes: ColumnAnswerNode[] = []
  const nodeIndex = new Map<string, number>()
  const nodeIdx = (id: string) => {
    let i = nodeIndex.get(id)
    if (i !== undefined) return i
    const n = p.node(id) ?? {}
    i = nodes.length
    nodeIndex.set(id, i)
    const dir = String(n.original_file_path ?? "")
      .replace(/\\/g, "/")
      .split("/")
      .slice(1, -1)
      .join("/")
    nodes.push({
      id,
      name: String(n.name ?? id),
      folder: dir || String(n.resource_type ?? ""),
      materialized: n.config?.materialized ?? null,
      contract: !!n.config?.contract?.enforced,
      tests: tests[id] ?? 0,
      exposures: exposures[id] ?? [],
    })
    return i
  }

  const columns: ColumnAnswerColumn[] = []
  const columnIndex = new Map<string, number>()
  const edges: ColumnAnswerEdge[] = []
  let truncated = false
  const typeOf = (id: string, col: string) => {
    const docs = p.node(id)?.columns ?? {}
    const hit: any = docs[col] ?? Object.values<any>(docs).find((c) => String(c?.name ?? "").toLowerCase() === col)
    return hit?.data_type || undefined
  }
  /** The column's index, adding it when new (null when the answer is full). */
  const colIdx = (id: string, col: string, hop: number, how: How | null, howFrom: HowFrom): number | null => {
    const k = `${id}|${col}`
    const had = columnIndex.get(k)
    if (had !== undefined) return had
    if (columns.length >= MAX_ANSWER_COLUMNS) {
      truncated = true
      return null
    }
    const i = columns.length
    columnIndex.set(k, i)
    const type = typeOf(id, col)
    columns.push({ model: nodeIdx(id), column: col, hop, end: false, how, how_from: howFrom, ...(type && { type }) })
    return i
  }
  const edge = (from: number, to: number, how: How, howFrom: HowFrom): ColumnAnswerEdge =>
    howFrom === "name" ? [from, to, how, "name"] : [from, to, how]

  const start = colIdx(focus, want, 0, null, null)!
  const queue: [string, string, number][] = [[focus, want, 0]]
  const also = new Map<string, Set<string>>()
  const unresolved = new Map<string, string>()

  if (direction === "downstream") {
    while (queue.length) {
      const [u, c, h] = queue.shift()!
      const from = columnIndex.get(`${u}|${c}`)!
      for (const reader of p.readers(u)) {
        const lin = p.lineage(reader)
        if (lin.unresolved) {
          unresolved.set(reader, lin.unresolved)
          continue
        }
        let hit = false
        for (const e of lin.edges) {
          if (e.from !== u || e.fromCol !== c) continue
          hit = true
          const fresh = !columnIndex.has(`${reader}|${e.to}`)
          const to = colIdx(reader, e.to, h + 1, e.how, e.howFrom)
          if (to === null) continue
          edges.push(edge(from, to, e.how, e.howFrom))
          if (fresh) queue.push([reader, e.to, h + 1])
        }
        if (!hit && p.reads(reader).has(c)) {
          const set = also.get(reader) ?? new Set<string>()
          set.add(c)
          also.set(reader, set)
        }
      }
    }
  } else {
    while (queue.length) {
      const [u, c, h] = queue.shift()!
      if (!p.traced(u)) continue
      const to = columnIndex.get(`${u}|${c}`)!
      const lin = p.lineage(u)
      if (lin.unresolved) {
        unresolved.set(u, lin.unresolved)
        continue
      }
      for (const e of lin.edges) {
        if (e.to !== c) continue
        const fresh = !columnIndex.has(`${e.from}|${e.fromCol}`)
        const from = colIdx(e.from, e.fromCol, h + 1, e.how, e.howFrom)
        if (from === null) continue
        edges.push(edge(from, to, e.how, e.howFrom))
        if (fresh) queue.push([e.from, e.fromCol, h + 1])
      }
    }
  }

  // Ends: downstream, a reached column nothing reads; upstream, one nothing feeds.
  const linked = new Set(edges.map((e) => (direction === "downstream" ? e[0] : e[1])))
  for (const [i, c] of columns.entries()) c.end = i !== start && !linked.has(i)

  const valueModels = new Set(columns.filter((_, i) => i !== start).map((c) => nodes[c.model]!.id))
  valueModels.delete(focus)
  // A value model that also reads the column in a filter, join or grouping stays listed: its other
  // outputs (and the models past it) may change with the column too.

  const beyond = (id: string) => (direction === "downstream" ? p.descendants(id) : p.ancestors(id))
  const modelLevel = beyond(focus)
  const mayCarry = new Set<string>()
  for (const id of [...also.keys(), ...unresolved.keys()]) {
    mayCarry.add(id)
    for (const d of beyond(id)) mayCarry.add(d)
  }
  for (const id of [...valueModels, focus]) mayCarry.delete(id)
  const cleared = [...modelLevel]
    .filter((id) => !valueModels.has(id) && !mayCarry.has(id))
    .map((id) => ({ id, name: String(p.node(id)?.name ?? id) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const alsoReads = [...also].map(([id, cols]) => ({
    model: nodeIdx(id),
    columns: [...cols],
    downstream: p.descendants(id).size,
  }))
  const unresolvedOut = [...unresolved].map(([id, reason]) => {
    const n = beyond(id).size
    return { model: nodeIdx(id), reason, ...(n && { downstream: n }) }
  })
  const flags: ColumnAnswer["flags"] = []
  for (const n of nodes)
    if (p.traced(n.id)) for (const flag of p.lineage(n.id).flags) flags.push({ model: nodeIndex.get(n.id)!, flag })

  return {
    version: 1,
    focus: { model: focus, column: want },
    direction,
    inputs: {
      manifest: {
        generated_at: p.manifest.metadata?.generated_at ?? null,
        older_than_sql: olderThanSql(manifestPath, p, nodes),
      },
      sql: "compiled_code",
      catalog: null,
      engine: ENGINE,
      workarounds: WORKAROUNDS,
    },
    counts: {
      columns: columns.length - 1,
      models: valueModels.size,
      hops: Math.max(0, ...columns.map((c) => c.hop)),
      contracts: [...valueModels].filter((id) => !!p.node(id)?.config?.contract?.enforced).length,
      ends: columns.filter((c) => c.end).length,
      may_carry_models: mayCarry.size,
      cleared_models: cleared.length,
      model_level: modelLevel.size,
    },
    nodes,
    columns,
    edges,
    also_reads: alsoReads,
    unresolved: unresolvedOut,
    flags,
    cleared,
    truncated,
    next: null,
  }
}

/** Whether a model file in the answer changed after the manifest was written. */
function olderThanSql(manifestPath: string, p: ProjectLineage, nodes: ColumnAnswerNode[]): boolean {
  if (!p.projectDir) return false
  try {
    const written = fs.statSync(manifestPath).mtimeMs
    for (const n of nodes) {
      const file = p.nodes[n.id]?.original_file_path
      if (!file || !p.traced(n.id)) continue
      try {
        if (fs.statSync(path.join(p.projectDir, file)).mtimeMs > written) return true
      } catch {}
    }
  } catch {}
  return false
}

/** One line for the text report. */
export function describeAnswer(a: ColumnAnswer): string {
  const c = a.counts
  const what = a.direction === "downstream" ? "Column impact" : "Column trace (upstream)"
  const reach = `${c.columns} column${c.columns === 1 ? "" : "s"} in ${c.models} model${c.models === 1 ? "" : "s"}, ${c.hops} hop${c.hops === 1 ? "" : "s"}, ${c.ends} end${c.ends === 1 ? "" : "s"}`
  const tiers = `${c.may_carry_models} more may carry it, ${c.cleared_models} cleared of ${c.model_level} at model level`
  return `${what}: ${reach}; ${tiers}${a.truncated ? " (truncated)" : ""} (metadata.column_answer)`
}
