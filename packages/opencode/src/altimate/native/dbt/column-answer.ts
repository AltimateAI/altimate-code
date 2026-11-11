// Column impact answer: where a column's value goes downstream (or comes from upstream), hop by
// hop, from the project's column resolver (project-lineage.ts), with what the engine could not
// settle kept visible as tiers rather than dropped.
import * as fs from "fs"
import * as path from "path"
import { findModel } from "./helpers"
import { describeExposure, exposureReads, type ColumnReachExposure } from "./column-reach"
import { compareText, missingColumn, projectLineage, type How, type HowFrom, type ProjectLineage, type ShapeFlag } from "./project-lineage"

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
  unresolved: { model: number; reason: string; downstream?: number }[]
  flags: { model: number; flag: ShapeFlag }[]
  /** Model-level downstream (upstream: ancestors) in none of the tiers, by name. Not in `nodes`. */
  cleared: { id: string; name: string }[]
  /** Downstream only: upstream, `exposures` is empty. `declared` counts every exposure in the project. */
  consumers: { declared: number; exposures: ColumnAnswerConsumer[] }
  truncated: boolean
  next: null
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
