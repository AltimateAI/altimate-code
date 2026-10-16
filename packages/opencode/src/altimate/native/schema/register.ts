/**
 * Register schema cache, PII detection, and tag handlers with the Dispatcher.
 */

import { register } from "../dispatcher"
import { getCache } from "./cache"
import { awaitIndex, withIndexSignal } from "./index-control"
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
  const config = Registry.getConfig(params.warehouse)
  const warehouseType = config?.type || "unknown"

  try {
    const result = await withIndexSignal({ signal: params.signal, timeoutMs: params.timeout_ms }, async (signal) => {
      try {
        const connector = await awaitIndex(signal, () => Registry.get(params.warehouse))
        const cache = await awaitIndex(signal, () => getCache())
        return await cache.indexWarehouse(params.warehouse, warehouseType, connector, { signal, timeoutMs: params.timeout_ms })
      } catch (error) {
        if (!signal.aborted) throw error
        return {
          warehouse: params.warehouse,
          type: warehouseType,
          schemas_indexed: 0,
          tables_indexed: 0,
          columns_indexed: 0,
          timestamp: new Date().toISOString(),
          partial: true,
          note: signal.reason instanceof Error ? signal.reason.message : "Schema indexing cancelled.",
        }
      }
    })
    try {
      Telemetry.track({
        type: "warehouse_introspection",
        timestamp: Date.now(),
        session_id: Telemetry.getContext().sessionId,
        warehouse_type: warehouseType,
        operation: "index_warehouse",
        success: !result.partial,
        duration_ms: Date.now() - startTime,
        result_count: result.tables_indexed,
      })
      // altimate_change start — schema complexity signal from introspection results
      Telemetry.track({
        type: "schema_complexity",
        timestamp: Date.now(),
        session_id: Telemetry.getContext().sessionId,
        warehouse_type: warehouseType,
        table_count_bucket: Telemetry.bucketCount(result.tables_indexed),
        column_count_bucket: Telemetry.bucketCount(result.columns_indexed),
        schema_count_bucket: Telemetry.bucketCount(result.schemas_indexed),
        avg_columns_per_table: result.tables_indexed > 0
          ? Math.round(result.columns_indexed / result.tables_indexed)
          : 0,
      })
      // altimate_change end
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
