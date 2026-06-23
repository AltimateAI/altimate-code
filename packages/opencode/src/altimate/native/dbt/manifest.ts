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

/** Primary key declared via dbt contract constraints (model- or column-level). */
function contractPrimaryKey(node: any): string[] | undefined {
  // Model-level: constraints: [{ type: "primary_key", columns: [...] }]
  for (const c of node.constraints ?? []) {
    if (/primary[_ ]?key/i.test(String(c?.type ?? "")) && Array.isArray(c.columns) && c.columns.length) {
      return c.columns.map(String)
    }
  }
  // Column-level: columns.<c>.constraints: [{ type: "primary_key" }]
  const cols = Object.values<any>(node.columns ?? {}).filter((col) =>
    (col?.constraints ?? []).some((k: any) => /primary[_ ]?key/i.test(String(k?.type ?? ""))),
  )
  const names = cols.map((c) => String(c.name)).filter(Boolean)
  return names.length ? names : undefined
}

/** The columns a `unique` / `unique_combination_of_columns` test asserts, if any. */
function uniqueTestColumns(node: any): string[] | undefined {
  const tm = node.test_metadata ?? {}
  const name = String(tm.name ?? "")
  const kwargs = tm.kwargs ?? {}
  if (name === "unique" && kwargs.column_name) return [String(kwargs.column_name)]
  if (name === "unique_combination_of_columns" && Array.isArray(kwargs.combination_of_columns)) {
    return kwargs.combination_of_columns.map(String)
  }
  return undefined
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
  // node unique_id → DbtModelInfo (for back-filling PKs from tests in a 2nd pass).
  const modelsById = new Map<string, DbtModelInfo>()
  // model unique_id → unique-key column sets asserted by its uniqueness tests.
  const uniqueTestsByModel = new Map<string, string[][]>()

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
        path: node.original_file_path || node.path || undefined,
        // Contract-declared PK now; unique-test-derived PK filled in below.
        primary_key: contractPrimaryKey(node),
      }
      modelsById.set(nodeId, info)
      if (resourceType === "model") models.push(info)
      else if (resourceType === "seed") seeds.push(info)
      else snapshots.push(info)
    } else if (resourceType === "test") {
      testCount++
      const cols = uniqueTestColumns(node)
      if (cols) {
        // The model this uniqueness test is attached to (dbt 1.5+ `attached_node`,
        // else the model node among its dependencies).
        const owner =
          node.attached_node ||
          (node.depends_on?.nodes || []).find((n: string) => n.startsWith("model."))
        if (owner) {
          const sets = uniqueTestsByModel.get(owner) ?? []
          sets.push(cols)
          uniqueTestsByModel.set(owner, sets)
        }
      }
      tests.push({
        unique_id: nodeId,
        name: node.name || "",
        depends_on: node.depends_on?.nodes || [],
      })
    }
  }

  // Second pass: for models WITHOUT a contract PK, adopt a unique-key test as the
  // PK proxy — but ONLY when it's unambiguous (exactly one distinct key set), so a
  // model with several unique tests never yields a wrong key (fan-out stays sound).
  for (const [modelId, sets] of uniqueTestsByModel) {
    const info = modelsById.get(modelId)
    if (!info || info.primary_key?.length) continue
    const distinct = new Map<string, string[]>()
    for (const s of sets) distinct.set([...s].map((c) => c.toLowerCase()).sort().join(","), s)
    if (distinct.size === 1) info.primary_key = [...distinct.values()][0]
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
