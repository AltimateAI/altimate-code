/**
 * dbt manifest.json parser — extract models, sources, and node information.
 *
 * Ported from Python altimate_engine.dbt.manifest.
 */

import * as fs from "fs"
import type {
  DbtManifestParams,
  DbtManifestResult,
  DbtModelInfo,
  DbtSourceInfo,
  ModelColumn,
} from "../types"

const LARGE_MANIFEST_BYTES = 50 * 1024 * 1024 // 50 MB

function extractColumns(columnsDict: Record<string, any>): ModelColumn[] {
  return Object.entries(columnsDict).map(([colName, col]) => ({
    name: col.name || colName,
    data_type: col.data_type || col.type || "",
    description: col.description || undefined,
  }))
}

/**
 * Parse a dbt manifest.json and extract model, source, and node information.
 */
export async function parseManifest(params: DbtManifestParams): Promise<DbtManifestResult> {
  const emptyResult: DbtManifestResult = {
    models: [],
    sources: [],
    source_count: 0,
    model_count: 0,
    test_count: 0,
    snapshot_count: 0,
    seed_count: 0,
  }

  if (!fs.existsSync(params.path)) {
    return emptyResult
  }

  let raw: string
  try {
    const stat = fs.statSync(params.path)
    if (stat.size > LARGE_MANIFEST_BYTES) {
      // Log warning but continue
    }
    raw = await fs.promises.readFile(params.path, "utf-8")
  } catch {
    return emptyResult
  }

  let manifest: any
  try {
    manifest = JSON.parse(raw)
  } catch {
    return emptyResult
  }

  if (typeof manifest !== "object" || manifest === null) {
    return emptyResult
  }

  const nodes = manifest.nodes || {}
  const sourcesDict = manifest.sources || {}

  const models: DbtModelInfo[] = []
  let testCount = 0
  let snapshotCount = 0
  let seedCount = 0

  for (const [nodeId, node] of Object.entries<any>(nodes)) {
    const resourceType = node.resource_type

    if (resourceType === "model") {
      const dependsOnNodes = node.depends_on?.nodes || []
      const columns = extractColumns(node.columns || {})
      models.push({
        unique_id: nodeId,
        name: node.name || "",
        schema_name: node.schema || undefined,
        database: node.database || undefined,
        materialized: node.config?.materialized || undefined,
        depends_on: dependsOnNodes,
        columns,
      })
    } else if (resourceType === "test") {
      testCount++
    } else if (resourceType === "snapshot") {
      snapshotCount++
    } else if (resourceType === "seed") {
      seedCount++
    }
  }

  const sources: DbtSourceInfo[] = []
  for (const [sourceId, source] of Object.entries<any>(sourcesDict)) {
    const columns = extractColumns(source.columns || {})
    sources.push({
      unique_id: sourceId,
      name: source.name || "",
      source_name: source.source_name || "",
      schema_name: source.schema || undefined,
      database: source.database || undefined,
      columns,
    })
  }

  return {
    models,
    sources,
    source_count: sources.length,
    model_count: models.length,
    test_count: testCount,
    snapshot_count: snapshotCount,
    seed_count: seedCount,
  }
}
