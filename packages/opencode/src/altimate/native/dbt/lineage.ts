/**
 * dbt model lineage — column-level lineage from manifest + model name.
 *
 * Ported from Python altimate_engine.dbt.lineage.
 */

import * as fs from "fs"
import * as core from "@altimateai/altimate-core"
import type {
  DbtLineageParams,
  DbtLineageResult,
} from "../types"

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

  if (!fs.existsSync(params.manifest_path)) {
    return emptyResult(["Manifest file not found"])
  }

  let manifest: any
  try {
    const raw = fs.readFileSync(params.manifest_path, "utf-8")
    manifest = JSON.parse(raw)
  } catch (e) {
    return emptyResult([`Failed to parse manifest: ${e}`])
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
  let dialect = params.dialect
  if (!dialect) {
    dialect = detectDialect(manifest, modelNode)
  }

  // Build schema context from upstream dependencies
  const upstreamIds: string[] = modelNode.depends_on?.nodes || []
  const schemaContext = buildSchemaContext(nodes, sources, upstreamIds)

  // Delegate to altimate-core column_lineage
  let rawLineage: Record<string, unknown>
  try {
    const schema = schemaContext
      ? core.Schema.fromJson(JSON.stringify(schemaContext))
      : undefined
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

function findModel(nodes: Record<string, any>, model: string): any | null {
  if (model in nodes) return nodes[model]
  for (const [, node] of Object.entries(nodes)) {
    if (node.resource_type !== "model") continue
    if (node.name === model) return node
  }
  return null
}

function getUniqueId(nodes: Record<string, any>, model: string): string | undefined {
  if (model in nodes) return model
  for (const [nodeId, node] of Object.entries(nodes)) {
    if (node.resource_type === "model" && node.name === model) return nodeId
  }
  return undefined
}

function detectDialect(manifest: any, modelNode: any): string {
  const metadata = manifest.metadata || {}
  const adapter = metadata.adapter_type || ""
  if (adapter) {
    const dialectMap: Record<string, string> = {
      snowflake: "snowflake",
      bigquery: "bigquery",
      databricks: "databricks",
      spark: "spark",
      postgres: "postgres",
      redshift: "redshift",
      duckdb: "duckdb",
    }
    return dialectMap[adapter] || adapter
  }
  return "snowflake"
}

function buildSchemaContext(
  nodes: Record<string, any>,
  sources: Record<string, any>,
  upstreamIds: string[],
): Record<string, any> | null {
  const tables: Record<string, any> = {}

  for (const uid of upstreamIds) {
    const node = nodes[uid] || sources[uid]
    if (!node) continue

    const tableName = node.alias || node.name || ""
    if (!tableName) continue

    const columnsDict = node.columns || {}
    if (Object.keys(columnsDict).length === 0) continue

    const cols = Object.entries(columnsDict).map(([colName, col]: [string, any]) => ({
      name: col.name || colName,
      type: col.data_type || col.type || "",
    }))

    if (cols.length > 0) {
      tables[tableName] = { columns: cols }
    }
  }

  if (Object.keys(tables).length === 0) return null
  return { tables, version: "1" }
}
