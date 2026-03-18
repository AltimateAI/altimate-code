/**
 * Register schema cache, PII detection, and tag handlers with the Dispatcher.
 */

import { register } from "../dispatcher"
import { getCache } from "./cache"
import { detectPii } from "./pii-detector"
import { getTags, listTags } from "./tags"
import * as Registry from "../connections/registry"
import type {
  SchemaIndexParams,
  SchemaIndexResult,
  SchemaSearchParams,
  SchemaSearchResult,
  SchemaCacheStatusResult,
  PiiDetectParams,
  PiiDetectResult,
  TagsGetParams,
  TagsGetResult,
  TagsListParams,
  TagsListResult,
} from "../types"
import { Telemetry } from "../../../telemetry"

/** Register all schema.* native handlers. Exported for test re-registration. */
export function registerAll(): void {

// --- schema.index ---
register("schema.index", async (params: SchemaIndexParams): Promise<SchemaIndexResult> => {
  const startTime = Date.now()
  const connector = await Registry.get(params.warehouse)
  const config = Registry.getConfig(params.warehouse)
  const warehouseType = config?.type || "unknown"

  const cache = await getCache()
  try {
    const result = await cache.indexWarehouse(params.warehouse, warehouseType, connector)
    try {
      Telemetry.track({
        type: "warehouse_introspection",
        timestamp: Date.now(),
        session_id: Telemetry.getContext().sessionId,
        warehouse_type: warehouseType,
        operation: "index_warehouse",
        success: true,
        duration_ms: Date.now() - startTime,
        result_count: result.tables_indexed,
      })
    } catch {}
    return result
  } catch (e) {
    try {
      Telemetry.track({
        type: "warehouse_introspection",
        timestamp: Date.now(),
        session_id: Telemetry.getContext().sessionId,
        warehouse_type: warehouseType,
        operation: "index_warehouse",
        success: false,
        duration_ms: Date.now() - startTime,
        result_count: 0,
        error: String(e).slice(0, 500),
      })
    } catch {}
    throw e
  }
})

// --- schema.search ---
register("schema.search", async (params: SchemaSearchParams): Promise<SchemaSearchResult> => {
  const cache = await getCache()
  return cache.search(params.query, params.warehouse, params.limit)
})

// --- schema.cache_status ---
register("schema.cache_status", async (): Promise<SchemaCacheStatusResult> => {
  const cache = await getCache()
  return cache.cacheStatus()
})

// --- schema.detect_pii ---
register("schema.detect_pii", async (params: PiiDetectParams): Promise<PiiDetectResult> => {
  return detectPii(params)
})

// --- schema.tags ---
register("schema.tags", async (params: TagsGetParams): Promise<TagsGetResult> => {
  return getTags(params)
})

// --- schema.tags_list ---
register("schema.tags_list", async (params: TagsListParams): Promise<TagsListResult> => {
  return listTags(params)
})

} // end registerAll

// Auto-register on module load
registerAll()
