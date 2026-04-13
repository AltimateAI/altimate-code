/**
 * Shared helpers for dbt native handlers.
 *
 * Extracted from lineage.ts to avoid duplication across dbt handlers.
 */

import * as fs from "fs"
import type { ModelColumn } from "../types"

/**
 * Load and parse a manifest.json file, returning the raw JSON object.
 * Returns null if the file doesn't exist.
 * Throws with a descriptive message if the file exists but can't be parsed.
 *
 * Caches by absolute path + mtime so repeated calls within the same
 * request (e.g. unit-tests → lineage) don't re-read 128 MB from disk.
 *
 * IMPORTANT: The returned object is shared across callers via the cache.
 * Callers MUST NOT mutate the returned object or its nested properties.
 * Mutations would corrupt the cache for all subsequent callers.
 */
let _manifestCache: { path: string; mtimeMs: number; data: any } | null = null

export function loadRawManifest(manifestPath: string): any | null {
  if (!fs.existsSync(manifestPath)) return null
  const resolved = fs.realpathSync(manifestPath)
  const mtimeMs = fs.statSync(resolved).mtimeMs

  if (_manifestCache && _manifestCache.path === resolved && _manifestCache.mtimeMs === mtimeMs) {
    return _manifestCache.data
  }

  const raw = fs.readFileSync(resolved, "utf-8")
  const parsed = JSON.parse(raw)
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Manifest is not a JSON object")
  }
  _manifestCache = { path: resolved, mtimeMs, data: parsed }
  return parsed
}

/**
 * Find a model node in the manifest by name or unique_id.
 * Only returns nodes where resource_type === "model".
 */
export function findModel(nodes: Record<string, any>, model: string): any | null {
  if (model in nodes && nodes[model]?.resource_type === "model") return nodes[model]
  for (const [, node] of Object.entries(nodes)) {
    if (node.resource_type !== "model") continue
    if (node.name === model) return node
  }
  return null
}

/**
 * Get the unique_id for a model (by name or unique_id lookup).
 * Only matches nodes where resource_type === "model".
 */
export function getUniqueId(nodes: Record<string, any>, model: string): string | undefined {
  if (model in nodes && nodes[model]?.resource_type === "model") return model
  for (const [nodeId, node] of Object.entries(nodes)) {
    if (node.resource_type === "model" && node.name === model) return nodeId
  }
  return undefined
}

/**
 * Detect SQL dialect from manifest metadata.adapter_type.
 */
export function detectDialect(manifest: any): string {
  const adapter = manifest.metadata?.adapter_type || ""
  const dialectMap: Record<string, string> = {
    snowflake: "snowflake",
    bigquery: "bigquery",
    databricks: "databricks",
    spark: "spark",
    postgres: "postgres",
    redshift: "redshift",
    duckdb: "duckdb",
    clickhouse: "clickhouse",
    mysql: "mysql",
    sqlserver: "tsql",
    trino: "trino",
  }
  return dialectMap[adapter] || adapter || "snowflake"
}

/**
 * Build a schema context object from upstream dependency nodes.
 * Returns the { tables, version } format expected by core.Schema.fromJson().
 */
export function buildSchemaContext(
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

/**
 * Extract typed ModelColumn[] from a raw node's columns dict.
 */
export function extractColumns(columnsDict: Record<string, any>): ModelColumn[] {
  return Object.entries(columnsDict).map(([colName, col]: [string, any]) => ({
    name: col.name || colName,
    data_type: col.data_type || col.type || "",
    description: col.description || undefined,
  }))
}

/**
 * List model names from manifest nodes (for error messages).
 */
export function listModelNames(nodes: Record<string, any>): string[] {
  return Object.values(nodes)
    .filter((n: any) => n.resource_type === "model")
    .map((n: any) => n.name)
}
