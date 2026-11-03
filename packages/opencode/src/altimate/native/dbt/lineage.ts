/**
 * dbt model lineage — column-level lineage from manifest + model name.
 *
 * Ported from Python altimate_engine.dbt.lineage.
 */

import * as core from "@altimateai/altimate-core"
import type { DbtLineageParams, DbtLineageResult, DbtModelLineageParams, ModelLineage } from "../types"
import { loadRawManifest, findModel, getUniqueId, detectDialect, buildSchemaContext } from "./helpers"

/**
 * Compute column-level lineage for a dbt model.
 *
 * Loads the manifest, finds the target model, extracts compiled SQL + upstream
 * schemas, and delegates to altimate-core's columnLineage().
 */
export function dbtLineage(params: DbtLineageParams): DbtLineageResult {
  const emptyResult = (factors: string[]): DbtLineageResult => ({
    model_name: params.model,
    raw_lineage: {},
    confidence: "low",
    confidence_factors: factors,
  })

  let manifest: any
  try {
    manifest = loadRawManifest(params.manifest_path)
  } catch (e) {
    return emptyResult([`Failed to parse manifest: ${e}`])
  }
  if (!manifest) {
    return emptyResult(["Manifest file not found"])
  }

  const nodes = manifest.nodes || {}
  const sources = manifest.sources || {}

  // Find target model by name or unique_id
  const modelNode = findModel(nodes, params.model)
  if (!modelNode) {
    return emptyResult([`Model '${params.model}' not found in manifest`])
  }

  // Extract compiled SQL
  const sql = modelNode.compiled_code || modelNode.compiled_sql || ""
  if (!sql) {
    return emptyResult(["No compiled SQL found — run `dbt compile` first"])
  }

  // Detect dialect
  const dialect = params.dialect || detectDialect(manifest)

  // Build schema context from upstream dependencies
  const upstreamIds: string[] = modelNode.depends_on?.nodes || []
  const schemaContext = buildSchemaContext(nodes, sources, upstreamIds)

  // Delegate to altimate-core column_lineage
  let rawLineage: Record<string, unknown>
  try {
    const schema = schemaContext ? core.Schema.fromJson(JSON.stringify(schemaContext)) : undefined
    const result = core.columnLineage(sql, dialect, schema)
    rawLineage = JSON.parse(JSON.stringify(result))
  } catch (e) {
    rawLineage = { error: String(e) }
  }

  return {
    model_name: modelNode.name || params.model,
    model_unique_id: getUniqueId(nodes, params.model),
    compiled_sql: sql,
    raw_lineage: rawLineage,
    confidence: rawLineage.error ? "low" : "high",
    confidence_factors: rawLineage.error ? [String(rawLineage.error)] : [],
  }
}

type LineageNode = ModelLineage["nodes"][number]
type LineageEdge = ModelLineage["columnLineage"][number]

/**
 * A model's lineage from the manifest alone, in dbt-integration's `getModelLineage` format
 * (version 1): the model and its direct parents, with the column edges altimate-core reads from the
 * compiled SQL in the manifest. Nothing is compiled and no warehouse is read.
 */
export function dbtModelLineage(params: DbtModelLineageParams): ModelLineage {
  const startedAt = Date.now()
  const raw = dbtLineage(params)
  const errors = [...raw.confidence_factors]
  let manifest: any = null
  try {
    manifest = loadRawManifest(params.manifest_path)
  } catch {
    // dbtLineage has already reported it.
  }
  const nodes: Record<string, any> = manifest?.nodes ?? {}
  const sources: Record<string, any> = manifest?.sources ?? {}
  const model = manifest ? findModel(nodes, params.model) : null
  const dialect = params.dialect || (manifest ? detectDialect(manifest) : "")
  const focusId: string = model?.unique_id ?? raw.model_unique_id ?? params.model
  const focusName: string = model?.name ?? params.model
  const sql: string = model?.compiled_code || model?.compiled_sql || ""
  const parentIds: string[] = model ? [...new Set<string>(model.depends_on?.nodes ?? [])] : []

  const result: LineageNode[] = []
  if (model) {
    const inResult = new Set([focusId, ...parentIds])
    const parentsOf = (node: any, self: string) =>
      [...new Set<string>(node?.depends_on?.nodes ?? [])].filter((p) => p !== self && inResult.has(p))
    result.push({
      uniqueId: focusId,
      name: focusName,
      type: "model",
      ...(model.config?.materialized ? { materialization: model.config.materialized } : {}),
      direction: "focus",
      depth: 0,
      parents: parentIds,
      ...(model.original_file_path ? { path: model.original_file_path } : {}),
      ...outputColumns(sql, dialect, focusName, raw.raw_lineage, errors),
    })
    for (const uid of parentIds) {
      const node = nodes[uid] ?? sources[uid]
      const type: string = node?.resource_type ?? uid.split(".")[0]
      if (!node) errors.push(`${uid} is not in the manifest, so it has no columns`)
      const columns = Object.entries(node?.columns ?? {}).map(([key, c]: [string, any]) => ({
        name: c?.name || key,
        ...(c?.data_type || c?.type ? { dataType: c.data_type || c.type } : {}),
        ...(c?.description ? { description: c.description } : {}),
      }))
      const materialization = type === "source" || type === "seed" ? type : node?.config?.materialized
      result.push({
        uniqueId: uid,
        name:
          type === "source" && node
            ? `${node.source_name}.${node.name}`
            : (node?.name ?? uid.split(".").slice(2).join(".")),
        type,
        ...(materialization ? { materialization } : {}),
        direction: "upstream",
        depth: 1,
        parents: parentsOf(node, uid),
        ...(node?.original_file_path ? { path: node.original_file_path } : {}),
        columns,
        columnsFrom: columns.length > 0 ? "manifest" : "none",
      })
    }
  }

  const lineage = raw.raw_lineage as { column_lineage?: unknown; errors?: unknown }
  for (const e of Array.isArray(lineage.errors) ? lineage.errors : []) {
    errors.push(`${focusName}: ${typeof e === "string" ? e : (e?.message ?? JSON.stringify(e))}`)
  }
  const { byTable, shared } = tablesOf(parentIds, nodes, sources)
  if (shared.size > 0) {
    errors.push(
      `${focusName} reads ${[...shared].join(", ")}, which share a table name in altimate-core's schema, so their column edges into it were left out`,
    )
  }
  const edges = lineageEdges(
    Array.isArray(lineage.column_lineage) ? lineage.column_lineage : [],
    byTable,
    { uniqueId: focusId, name: focusName },
    errors,
    shared,
  )
  const wanted = params.column?.toLowerCase()
  const columnLineage = wanted ? edges.filter((e) => e.target[1] === wanted) : edges
  return {
    version: 1,
    project: manifest?.metadata?.project_name ?? model?.package_name ?? "",
    dialect,
    focus: { uniqueId: focusId, name: focusName, ...(params.column ? { column: params.column } : {}) },
    nodes: result,
    columnLineage,
    confidence: errors.length === 0 ? "high" : "low",
    errors,
    stats: {
      nodes: result.length,
      edges: columnLineage.length,
      compiled: sql ? 1 : 0,
      fromWarehouse: 0,
      ms: Date.now() - startedAt,
    },
  }
}

/**
 * The focus model's columns: its compiled SQL's output columns. A `select *` the SQL alone can't
 * expand takes the output columns altimate-core traced with the parents' schema instead, and says so.
 */
function outputColumns(sql: string, dialect: string, name: string, lineage: Record<string, unknown>, errors: string[]) {
  if (!sql) return { columns: [], columnsFrom: "none" }
  const resolved = Object.keys((lineage.column_dict as Record<string, unknown> | undefined) ?? {})
  let names: string[] = []
  let failure: unknown
  try {
    names = core.extractOutputColumns(sql, dialect)
  } catch (e) {
    failure = e
  }
  const explicit = names.filter((c) => c !== "*" && !c.endsWith(".*"))
  if (failure === undefined && explicit.length === names.length && names.length > 0) {
    return { columns: names.map((c) => ({ name: c })), columnsFrom: "compiled-sql" }
  }
  if (resolved.length > 0) {
    errors.push(`${name}'s compiled SQL selects *, so its columns are only the ones traced to a parent`)
    return { columns: resolved.map((c) => ({ name: c })), columnsFrom: "compiled-sql" }
  }
  errors.push(
    failure === undefined
      ? `${name}'s compiled SQL selects *, so not all its columns are known`
      : `Could not read ${name}'s output columns: ${failure instanceof Error ? failure.message : String(failure)}`,
  )
  return { columns: explicit.map((c) => ({ name: c })), columnsFrom: explicit.length > 0 ? "compiled-sql" : "none" }
}

/**
 * Each parent's table names, lowercased, as altimate-core can report them. The schema names
 * buildSchemaContext uses (`alias || name`) are claimed first, then the other names and a source's
 * identifier; the first parent to claim a name keeps it. `shared` holds the parents whose schema
 * name another parent has too: the schema keeps only one of them, so a column can bind to the wrong one.
 */
function tablesOf(parentIds: string[], nodes: Record<string, any>, sources: Record<string, any>) {
  const byTable = new Map<string, string>()
  const bySchemaName = new Map<string, string[]>()
  const claim = (key: unknown, uid: string) => {
    if (typeof key === "string" && key && !byTable.has(key.toLowerCase())) byTable.set(key.toLowerCase(), uid)
  }
  const nodeOf = (uid: string) => nodes[uid] ?? sources[uid]
  for (const uid of parentIds) {
    const schemaName = nodeOf(uid)?.alias || nodeOf(uid)?.name
    if (typeof schemaName !== "string" || !schemaName) continue
    claim(schemaName, uid)
    const key = schemaName.toLowerCase()
    bySchemaName.set(key, [...(bySchemaName.get(key) ?? []), uid])
  }
  for (const uid of parentIds) {
    for (const key of [nodeOf(uid)?.alias, nodeOf(uid)?.name, nodeOf(uid)?.identifier]) claim(key, uid)
  }
  const shared = new Set([...bySchemaName.values()].filter((ids) => ids.length > 1).flat())
  return { byTable, shared }
}

/** A dotted SQL name's parts, unquoted: `"db"."schema"."t"."c"` gives db, schema, t, c. */
function nameParts(name: string): string[] {
  const parts: string[] = []
  let current = ""
  let quote: string | undefined
  for (const ch of name) {
    if (quote) {
      if (ch === quote) quote = undefined
      else current += ch
    } else if (ch === '"' || ch === "`") quote = ch
    else if (ch === ".") {
      parts.push(current)
      current = ""
    } else current += ch
  }
  parts.push(current)
  return parts
}

/**
 * altimate-core's column edges as `getModelLineage`'s, from a parent's column to the focus model's.
 * An edge whose table isn't one of the parents goes to `errors`; one from a parent in `leaveOut`
 * (already reported) is dropped. Edges are deduplicated: altimate-core 0.9 can report one edge under
 * a qualified and a bare table name.
 */
export function lineageEdges(
  raw: any[],
  byTable: Map<string, string>,
  focus: { uniqueId: string; name: string },
  errors: string[],
  leaveOut: Set<string> = new Set(),
): LineageEdge[] {
  const seen = new Set<string>()
  const edges: LineageEdge[] = []
  for (const e of raw) {
    const from = nameParts(String(e?.source ?? ""))
    const column = from.length >= 2 ? from[from.length - 1].toLowerCase() : ""
    const table = from.length >= 2 ? from[from.length - 2].toLowerCase() : ""
    // The target is an output column's name, which can contain a dot (`as "customer.id"`).
    const target = String(e?.target ?? "").toLowerCase()
    const parent = byTable.get(table)
    if (!parent || !column || !target) {
      errors.push(
        `${e?.source} -> ${focus.name}.${e?.target}: ${table ? `${table} isn't one of ${focus.name}'s parents` : "no table"}, so the edge was left out`,
      )
      continue
    }
    if (leaveOut.has(parent)) continue
    const edge: LineageEdge = {
      source: [parent, column],
      target: [focus.uniqueId, target],
      type: String(e?.lineage_type ?? ""),
      viewsType: String(e?.lens_type ?? ""),
      viewsCode: (Array.isArray(e?.lens_code) ? e.lens_code : [])
        .map((step: any) => (typeof step === "string" ? step : step?.expression))
        .filter((code: unknown): code is string => typeof code === "string"),
    }
    const key = [...edge.source, ...edge.target, edge.type, edge.viewsType].join("\u0000")
    if (seen.has(key)) continue
    seen.add(key)
    edges.push(edge)
  }
  return edges
}
