/**
 * dbt manifest.json parser — extract models, sources, and node information.
 *
 * Ported from Python altimate_engine.dbt.manifest.
 */

import type {
  DbtManifestParams,
  DbtManifestResult,
  DbtModelInfo,
  DbtSourceInfo,
  DbtTestInfo,
  ModelColumn,
} from "../types"
import { loadRawManifest } from "./helpers"

function extractColumns(columnsDict: Record<string, any>): ModelColumn[] {
  return Object.entries(columnsDict).map(([colName, col]) => ({
    name: col.name || colName,
    data_type: col.data_type || col.type || "",
    description: col.description || undefined,
  }))
}

/**
 * Parse a dbt manifest.json and extract model, source, and node information.
 *
 * Uses the shared `loadRawManifest` helper which caches by path+mtime, so
 * repeated calls (e.g. parseManifest → dbtLineage) don't re-read large files.
 */
export async function parseManifest(params: DbtManifestParams): Promise<DbtManifestResult> {
  const emptyResult: DbtManifestResult = {
    models: [],
    sources: [],
    tests: [],
    seeds: [],
    snapshots: [],
    source_count: 0,
    model_count: 0,
    test_count: 0,
    snapshot_count: 0,
    seed_count: 0,
  }

  let manifest: any
  try {
    manifest = loadRawManifest(params.path)
  } catch {
    return emptyResult
  }
  if (!manifest) return emptyResult

  const nodes = manifest.nodes || {}
  const sourcesDict = manifest.sources || {}

  const models: DbtModelInfo[] = []
  const tests: DbtTestInfo[] = []
  const seeds: DbtModelInfo[] = []
  const snapshots: DbtModelInfo[] = []
  let testCount = 0

  for (const [nodeId, node] of Object.entries<any>(nodes)) {
    const resourceType = node.resource_type

    if (resourceType === "model" || resourceType === "seed" || resourceType === "snapshot") {
      const info: DbtModelInfo = {
        unique_id: nodeId,
        name: node.name || "",
        description: node.description || undefined,
        schema_name: node.schema || undefined,
        database: node.database || undefined,
        materialized: node.config?.materialized || undefined,
        depends_on: node.depends_on?.nodes || [],
        columns: extractColumns(node.columns || {}),
      }
      if (resourceType === "model") models.push(info)
      else if (resourceType === "seed") seeds.push(info)
      else snapshots.push(info)
    } else if (resourceType === "test") {
      testCount++
      tests.push({
        unique_id: nodeId,
        name: node.name || "",
        depends_on: node.depends_on?.nodes || [],
      })
    }
  }

  const sources: DbtSourceInfo[] = []
  for (const [sourceId, source] of Object.entries<any>(sourcesDict)) {
    const columns = extractColumns(source.columns || {})
    sources.push({
      unique_id: sourceId,
      name: source.name || "",
      description: source.description || undefined,
      source_name: source.source_name || "",
      schema_name: source.schema || undefined,
      database: source.database || undefined,
      columns,
    })
  }

  return {
    models,
    sources,
    tests,
    seeds,
    snapshots,
    source_count: sources.length,
    model_count: models.length,
    test_count: testCount,
    snapshot_count: snapshots.length,
    seed_count: seeds.length,
    adapter_type: manifest.metadata?.adapter_type || undefined,
  }
}
