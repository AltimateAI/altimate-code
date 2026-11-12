/**
 * dbt model lineage — column-level lineage from manifest + model name.
 *
 * Ported from Python altimate_engine.dbt.lineage.
 */

import * as core from "@altimateai/altimate-core"
import type { DbtLineageParams, DbtLineageResult } from "../types"
import { loadRawManifest, findModel, detectDialect, buildSchemaContext } from "./helpers"
import { lineageGraph } from "./graph"
import { projectLineage } from "./project-lineage"

/**
 * The lineage with the placeholder columns taken out, and the parents whose placeholder reached the
 * output: those a `*` reads.
 */
function withoutPlaceholders(
  lineage: Record<string, any>,
  placeholders: Map<string, string>,
): { lineage: Record<string, unknown>; starred: string[] } {
  if (!placeholders.size) return { lineage, starred: [] }
  const parentOf = (text: unknown) => {
    const lower = String(text ?? "").toLowerCase()
    return [...placeholders].find(([placeholder]) => lower.includes(placeholder))?.[1]
  }
  const named = (text: unknown) => parentOf(text) !== undefined
  const starred = new Set<string>()
  const dict: Record<string, unknown> = {}
  for (const [target, sources] of Object.entries<any>(lineage.column_dict ?? {})) {
    const parent = placeholders.get(target.toLowerCase())
    if (parent) {
      starred.add(parent)
      continue
    }
    if (!Array.isArray(sources)) {
      dict[target] = sources
      continue
    }
    // A `*` inside a function (hash(*), object_construct(*)) reads every column of the parent too.
    for (const source of sources) {
      const reads = parentOf(source)
      if (reads) starred.add(reads)
    }
    dict[target] = sources.filter((source) => !named(source))
  }
  const edges = Array.isArray(lineage.column_lineage)
    ? lineage.column_lineage.filter((edge: any) => !named(edge?.source) && !named(edge?.target))
    : lineage.column_lineage
  return {
    lineage: { ...lineage, ...(lineage.column_dict && { column_dict: dict }), ...(lineage.column_lineage && { column_lineage: edges }) },
    starred: [...starred].sort(),
  }
}

/** Up to three names, then how many more. */
function describeParents(names: string[]): string {
  const shown = names.slice(0, 3).join(", ")
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown
}

function unparsed(lineage: Record<string, unknown>): boolean {
  const errors = Array.isArray(lineage.errors) ? lineage.errors : []
  const edges = Array.isArray(lineage.column_lineage) ? lineage.column_lineage : []
  return errors.length > 0 && edges.length === 0
}

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

  // A model by name or unique_id; a snapshot by unique_id; either by its project-relative file path.
  // `./models/x.sql` and `models\\x.sql` are the manifest's `models/x.sql`.
  const filePath = (p: unknown) =>
    String(p ?? "")
      .replace(/\\/g, "/")
      .replace(/^(?:\.\/)+/, "")
  // An empty request (`./`) is no model's path.
  const wanted = filePath(params.model)
  const byPath = () =>
    wanted
      ? Object.values<any>(nodes).find(
          (node) => ["model", "snapshot"].includes(node?.resource_type) && filePath(node.original_file_path) === wanted,
        )
      : undefined
  const modelNode =
    findModel(nodes, params.model) ??
    (nodes[params.model]?.resource_type === "snapshot" ? nodes[params.model] : null) ??
    byPath() ??
    Object.values<any>(nodes).find((node) => node?.resource_type === "snapshot" && node.name === params.model) ??
    null
  if (!modelNode) {
    return emptyResult([`Model '${params.model}' not found in manifest`])
  }
  // The id of the node that was selected, not of whatever else in the manifest the request string spells.
  const uniqueId =
    (typeof modelNode.unique_id === "string" && nodes[modelNode.unique_id] === modelNode
      ? modelNode.unique_id
      : undefined) ??
    Object.keys(nodes).find((id) => nodes[id] === modelNode) ??
    params.model
  const graph = params.include_graph && uniqueId ? { graph: lineageGraph(manifest, uniqueId) } : {}

  // Extract compiled SQL
  const sql = modelNode.compiled_code || modelNode.compiled_sql || ""
  if (!sql) {
    return {
      ...emptyResult(["No compiled SQL found — run `dbt compile` first"]),
      model_name: modelNode.name || params.model,
      model_unique_id: uniqueId,
      upstream: modelNode.depends_on?.nodes ?? [],
      ...graph,
    }
  }

  // Detect dialect
  const dialect = params.dialect || detectDialect(manifest)

  // The parents' columns from the project's column resolver, as impact_analysis reads them: declared,
  // else worked out from each parent's own SQL in DAG order. An ephemeral parent is inlined as a CTE,
  // so its own parents are the tables the SQL reads.
  const upstreamIds: string[] = modelNode.depends_on?.nodes || []
  const project = projectLineage(params.manifest_path, dialect)
  const schemaContext = buildSchemaContext(nodes, sources, project.parents(uniqueId), (uid) => project.columns(uid))
  // A parent with no known column still gets a table entry, with one placeholder column: without one
  // the engine drops the columns the SQL names from that parent, or gives them to another parent with
  // a column of the same name. Where a placeholder reaches the output, a `*` reads that parent and the
  // columns it carries are missing. Placeholders are taken out of the lineage returned.
  const tables: Record<string, any> = { ...(schemaContext?.tables ?? {}) }
  const placeholders = new Map<string, string>()
  // A placeholder is matched by substring in what the engine returns, so it must not occur in the SQL or
  // in any known column's name.
  const taken = [
    sql.toLowerCase(),
    ...Object.values<any>(tables).flatMap((t) => (t?.columns ?? []).map((c: any) => String(c?.name ?? "").toLowerCase())),
  ]
  for (const id of project.unknownParents(uniqueId)) {
    const node = project.node(id)
    const table = node?.alias || node?.name || ""
    if (!table || tables[table]) continue
    let placeholder = `__altimate_unknown_${placeholders.size}__`
    while (taken.some((text) => text.includes(placeholder))) placeholder += "_"
    tables[table] = { columns: [{ name: placeholder, type: "" }] }
    placeholders.set(placeholder, String(node.name ?? table))
  }

  // Delegate to altimate-core column_lineage
  let rawLineage: Record<string, unknown>
  let missed: string[] = []
  try {
    const schema = Object.keys(tables).length ? core.Schema.fromJson(JSON.stringify({ version: "1", tables })) : undefined
    const result = core.columnLineage(sql, dialect, schema)
    ;({ lineage: rawLineage, starred: missed } = withoutPlaceholders(JSON.parse(JSON.stringify(result)), placeholders))
  } catch (e) {
    rawLineage = { error: String(e) }
  }
  // The engine reports SQL it cannot parse in `errors` with no edges, rather than throwing.
  const failure = rawLineage.error
    ? String(rawLineage.error)
    : unparsed(rawLineage)
      ? String((rawLineage.errors as unknown[])[0])
      : undefined
  const unexpanded = !failure && missed.length ? missed : []

  return {
    model_name: modelNode.name || params.model,
    model_unique_id: uniqueId,
    compiled_sql: sql,
    raw_lineage: rawLineage,
    confidence: failure || unexpanded.length ? "low" : "high",
    confidence_factors: failure
      ? [failure]
      : unexpanded.length
        ? [
            `select * over ${describeParents(unexpanded)}, whose columns aren't declared and can't be worked out from its SQL: the columns read through it are missing`,
          ]
        : [],
    upstream: upstreamIds,
    ...(unexpanded.length && { unexpanded_stars: unexpanded }),
    ...graph,
  }
}
