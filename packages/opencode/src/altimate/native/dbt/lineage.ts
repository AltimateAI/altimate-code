/**
 * dbt model lineage — column-level lineage from manifest + model name.
 *
 * Ported from Python altimate_engine.dbt.lineage.
 */

import * as core from "@altimateai/altimate-core"
import type { DbtLineageParams, DbtLineageResult } from "../types"
import { loadRawManifest, findModel, detectDialect, buildSchemaContext } from "./helpers"
import { lineageGraph } from "./graph"

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
  const filePath = (p: unknown) => String(p ?? "").replace(/\\/g, "/").replace(/^(?:\.\/)+/, "")
  const byPath = () =>
    Object.values<any>(nodes).find(
      (node) => ["model", "snapshot"].includes(node?.resource_type) && filePath(node.original_file_path) === filePath(params.model),
    )
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
    (typeof modelNode.unique_id === "string" && nodes[modelNode.unique_id] === modelNode ? modelNode.unique_id : undefined) ??
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
    model_unique_id: uniqueId,
    compiled_sql: sql,
    raw_lineage: rawLineage,
    // The engine reports SQL it cannot parse in `errors` with no edges, rather than throwing.
    confidence: rawLineage.error || unparsed(rawLineage) ? "low" : "high",
    confidence_factors: rawLineage.error ? [String(rawLineage.error)] : unparsed(rawLineage) ? [String((rawLineage.errors as unknown[])[0])] : [],
    upstream: upstreamIds,
    ...graph,
  }
}
