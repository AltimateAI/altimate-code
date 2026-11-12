// Column impact answer: where a column's value goes downstream (or comes from upstream), hop by
// hop, from the project's column resolver (project-lineage.ts), with what the engine could not
// settle kept visible as tiers rather than dropped.
import * as fs from "fs"
import * as path from "path"
import { findModel } from "./helpers"
import { describeExposure, exposureReads, GAP, joinsNaturally, namesColumn, type ColumnReachExposure } from "./column-reach"
import {
  compareText,
  missingColumn,
  projectLineage,
  selectsStar,
  stripSql,
  usesRowAsValue,
  type How,
  type HowFrom,
  type ProjectLineage,
  type ShapeFlag,
} from "./project-lineage"

export type { How, HowFrom, ShapeFlag } from "./project-lineage"

/** Must match the pinned `@altimateai/altimate-core` version (a test checks it). */
export const ENGINE = "altimate-core 0.9.0"
export const MAX_ANSWER_COLUMNS = 2000

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

export type ConsumerTier = "carries" | "may_carry" | "cleared"

/** Why a model is in the "may carry it" tier: the first thing that kept it from being proven unaffected. */
export type MayCarryReason =
  | "unresolved"
  | "read_in_part"
  | "read_columns_unknown"
  | "ephemeral"
  | "star"
  | "natural_join"
  | "dynamic_name"
  | "row_reference"
  | "names_column"
  | "reads_value_model"
  | "below"
  | "capped"

/**
 * An exposure on the focus model or anything downstream of it. An exposure names the models it reads,
 * not their columns, so "carries" means it reads a model the value reaches, not that it uses the value.
 */
export interface ColumnAnswerConsumer extends ColumnReachExposure {
  tier: ConsumerTier
  /** The models it reads in that tier, by name. */
  via: string[]
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
  /** Models whose SQL the engine couldn't read in full, or whose read columns it couldn't list. */
  unresolved: { model: number; reason: string; code: MayCarryReason; downstream?: number }[]
  /**
   * Every model in the "may carry it" tier, with the first reason it couldn't be proven unaffected; `via`
   * names the model it sits past (`below`) or reads (`reads_value_model`). Not in `nodes`.
   */
  may_carry: { id: string; name: string; reason: MayCarryReason; via?: string }[]
  flags: { model: number; flag: ShapeFlag }[]
  /**
   * Proven unaffected: downstream, every path from the column passes a reader of the edited model that
   * the engine read in full, with no `*`, NATURAL JOIN, run-time name, whole-row value or ephemeral model,
   * and whose SQL never names the column. Upstream: ancestors the engine traced no edge from, through
   * models it read in full with none of those. By name; not in `nodes`.
   */
  cleared: { id: string; name: string }[]
  /** Downstream only: upstream, `exposures` is empty. `declared` counts every exposure in the project. */
  consumers: { declared: number; exposures: ColumnAnswerConsumer[] }
  truncated: boolean
  next: null
}


// ---------------------------------------------------------------------------------------------
// The answer

// IDENTIFIER(…) and COLUMNS(…) name columns at run time; a comment may sit before the parenthesis.
const RUN_TIME_NAME = new RegExp(String.raw`(?<![\w$])(?:identifier|columns)(?:${GAP})?\(`, "i")
// A positional column ($1), outside strings and comments.
const POSITIONAL = /(?<![\w$])\$\d+/

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
  const missing = missingColumn(p, focus, column)
  if (missing) throw new Error(missing)
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
  const unresolved = new Map<string, { reason: string; code: MayCarryReason }>()
  // Models with a column the cap left out: what sits past them was never checked.
  const capped = new Set<string>()
  // The first reason each model couldn't be proven unaffected.
  const marks = new Map<string, { reason: MayCarryReason; via?: string }>()
  const mark = (id: string, reason: MayCarryReason, via?: string) => {
    if (!marks.has(id)) marks.set(id, via ? { reason, via } : { reason })
  }
  const addAlso = (id: string, col: string) => {
    const set = also.get(id) ?? new Set<string>()
    set.add(col)
    also.set(id, set)
  }
  const nameOf = (id: string) => String(p.node(id)?.name ?? id)
  const blockers = new Map<string, { reason: string; code: MayCarryReason } | null>()
  /** What keeps a model's SQL from proving which columns it reads: null when nothing does. */
  const blockerOf = (id: string) => {
    if (blockers.has(id)) return blockers.get(id)!
    const found = ((): { reason: string; code: MayCarryReason } | null => {
      const sql = p.sqlOf(id)
      const lin = p.lineage(id)
      if (!sql || lin.unresolved) return { reason: lin.unresolved ?? "no compiled SQL", code: "unresolved" }
      if (lin.partial) return { reason: `read in part: ${lin.partial}`, code: "read_in_part" }
      if (p.reads(id) === null) return { reason: "the engine couldn't list the columns its SQL reads", code: "read_columns_unknown" }
      const raw: string[] = p.node(id)?.depends_on?.nodes ?? []
      if (p.ephemeral(id) || raw.some((one) => p.ephemeral(one)))
        return { reason: "an ephemeral model is inlined into it as a CTE", code: "ephemeral" }
      if (selectsStar(sql)) return { reason: "selects *, so it may read the column without naming it", code: "star" }
      if (joinsNaturally(sql)) return { reason: "joins with NATURAL JOIN, which may join on the column", code: "natural_join" }
      if (RUN_TIME_NAME.test(sql) || POSITIONAL.test(stripSql(sql)))
        return { reason: "names columns at run time (IDENTIFIER, COLUMNS or a positional $n)", code: "dynamic_name" }
      if (usesRowAsValue(sql)) return { reason: "uses a whole table row as a value", code: "row_reference" }
      return null
    })()
    blockers.set(id, found)
    return found
  }
  const READ_CODES: ReadonlySet<MayCarryReason> = new Set(["unresolved", "read_in_part", "read_columns_unknown"])
  const block = (id: string, found: { reason: string; code: MayCarryReason }) => {
    if (READ_CODES.has(found.code)) unresolved.set(id, found)
    mark(id, found.code)
  }

  if (direction === "downstream") {
    while (queue.length) {
      const [u, c, h] = queue.shift()!
      const from = columnIndex.get(`${u}|${c}`)!
      for (const reader of p.readers(u)) {
        const lin = p.lineage(reader)
        if (lin.unresolved) {
          block(reader, { reason: lin.unresolved, code: "unresolved" })
          continue
        }
        // Read in part: what it traced stands, and it is listed as not read in full.
        if (lin.partial) unresolved.set(reader, { reason: `read in part: ${lin.partial}`, code: "read_in_part" })
        let hit = false
        for (const e of lin.edges) {
          if (e.from !== u || e.fromCol !== c) continue
          hit = true
          const fresh = !columnIndex.has(`${reader}|${e.to}`)
          const to = colIdx(reader, e.to, h + 1, e.how, e.howFrom)
          if (to === null) {
            capped.add(reader)
            mark(reader, "capped")
            continue
          }
          edges.push(edge(from, to, e.how, e.howFrom))
          if (fresh) queue.push([reader, e.to, h + 1])
        }
        if (hit) continue
        // Only the edited model's readers can prove they don't read the value: a model the value reaches
        // may change any of its outputs (a filter, a join, a grouping), so what reads it may change too.
        if (u !== focus) {
          mark(reader, "reads_value_model", nameOf(u))
          continue
        }
        const found = blockerOf(reader)
        if (found) {
          block(reader, found)
          continue
        }
        // Read in full, no `*` or run-time name or whole row: a column it never names, it doesn't read.
        if (namesColumn(p.sqlOf(reader), c)) {
          addAlso(reader, c)
          mark(reader, "names_column")
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
        block(u, { reason: lin.unresolved, code: "unresolved" })
        continue
      }
      // Upstream the engine's edges are the answer: a model whose SQL can't prove them complete leaves
      // everything above it uncertain.
      const found = blockerOf(u)
      if (found) block(u, found)
      for (const e of lin.edges) {
        if (e.to !== c) continue
        const fresh = !columnIndex.has(`${e.from}|${e.fromCol}`)
        const from = colIdx(e.from, e.fromCol, h + 1, e.how, e.howFrom)
        if (from === null) {
          capped.add(e.from)
          mark(e.from, "capped")
          continue
        }
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

  const beyond = (id: string) => (direction === "downstream" ? p.descendants(id) : p.ancestors(id))
  const modelLevel = beyond(focus)
  const mayCarry = new Map<string, { reason: MayCarryReason; via?: string }>()
  const open = (id: string) => id !== focus && !valueModels.has(id) && modelLevel.has(id)
  for (const [id, m] of marks) if (open(id)) mayCarry.set(id, m)
  // Upstream, the edges skip an ephemeral model (it is inlined), so one the value may pass through or
  // start in (a constant) is never cleared.
  if (direction === "upstream") for (const id of modelLevel) if (p.ephemeral(id) && open(id) && !mayCarry.has(id)) mayCarry.set(id, { reason: "ephemeral" })
  for (const id of [...marks.keys(), ...mayCarry.keys()])
    for (const d of beyond(id)) if (open(d) && !mayCarry.has(d)) mayCarry.set(d, { reason: "below", via: nameOf(id) })
  const cleared = [...modelLevel]
    .filter((id) => !valueModels.has(id) && !mayCarry.has(id))
    .map((id) => ({ id, name: nameOf(id) }))
    .sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id))

  const clearedIds = new Set(cleared.map((one) => one.id))
  const consumers: ColumnAnswerConsumer[] = []
  if (direction === "downstream") {
    const carries = (id: string) => id === focus || valueModels.has(id)
    for (const [id, node] of Object.entries<any>(p.manifest.exposures ?? {})) {
      const reads = [...exposureReads(p.manifest, node)]
      const tiers: [ConsumerTier, (one: string) => boolean][] = [
        ["carries", carries],
        ["may_carry", (one) => mayCarry.has(one)],
        ["cleared", (one) => clearedIds.has(one)],
      ]
      const tier = tiers.find(([, has]) => reads.some(has))
      if (!tier) continue
      const via = reads.filter(tier[1]).map((one) => String(p.node(one)?.name ?? one))
      consumers.push({ ...describeExposure(id, node), tier: tier[0], via: via.sort(compareText) })
    }
    const rank: ConsumerTier[] = ["carries", "may_carry", "cleared"]
    consumers.sort((a, b) => rank.indexOf(a.tier) - rank.indexOf(b.tier) || compareText(a.label, b.label) || compareText(a.unique_id, b.unique_id))
  }

  const alsoReads = [...also].map(([id, cols]) => ({
    model: nodeIdx(id),
    columns: [...cols],
    downstream: p.descendants(id).size,
  }))
  const unresolvedOut = [...unresolved].map(([id, { reason, code }]) => {
    const n = beyond(id).size
    return { model: nodeIdx(id), reason, code, ...(n && { downstream: n }) }
  })
  const mayCarryOut = [...mayCarry]
    .map(([id, m]) => ({ id, name: nameOf(id), ...m }))
    .sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id))
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
    may_carry: mayCarryOut,
    flags,
    cleared,
    consumers: { declared: Object.keys(p.manifest.exposures ?? {}).length, exposures: consumers },
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
