/**
 * dbt model lineage — column-level lineage from manifest + model name.
 *
 * Ported from Python altimate_engine.dbt.lineage.
 */

import * as core from "@altimateai/altimate-core"
import type { DbtLineageParams, DbtLineageResult } from "../types"
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
