/**
 * Register native connection handlers with the Dispatcher.
 *
 * Handles: sql.execute, sql.explain, sql.autocomplete, warehouse.list,
 * warehouse.test, warehouse.add, warehouse.remove, warehouse.discover,
 * schema.inspect
 */

import { register } from "../dispatcher"
import * as Registry from "./registry"
import { discoverContainers } from "./docker-discovery"
import { parseDbtProfiles } from "./dbt-profiles"
import type {
  SqlExecuteParams,
  SqlExecuteResult,
  SqlExplainParams,
  SqlExplainResult,
  SqlAutocompleteParams,
  SqlAutocompleteResult,
  WarehouseListResult,
  WarehouseTestParams,
  WarehouseTestResult,
  WarehouseAddParams,
  WarehouseAddResult,
  WarehouseRemoveParams,
  WarehouseRemoveResult,
  WarehouseDiscoverResult,
  SchemaInspectParams,
  SchemaInspectResult,
  DbtProfilesParams,
  DbtProfilesResult,
} from "../types"
import type { ConnectionConfig } from "@altimateai/drivers"
import { Telemetry } from "../../../telemetry"

// ---------------------------------------------------------------------------
// dbt-first execution strategy
// ---------------------------------------------------------------------------

/** Cached dbt adapter (lazily created on first use). */
let dbtAdapter: any | null | undefined = undefined
let dbtConfigChecked = false

/**
 * Try to execute SQL via dbt's adapter (which uses profiles.yml for connection).
 * Returns null if dbt is not available or not configured — caller should fall back
 * to native driver.
 *
 * This is the preferred path when working in a dbt project: dbt already knows
 * how to connect, so users don't need to configure a separate connection.
 */
async function tryExecuteViaDbt(
  sql: string,
  limit?: number,
): Promise<SqlExecuteResult | null> {
  // Only attempt dbt once — if it's not configured, don't retry on every query
  if (dbtAdapter === null) return null

  if (dbtAdapter === undefined) {
    try {
      // Check if dbt config exists
      const { read: readDbtConfig } = await import(
        "../../../../../dbt-tools/src/config"
      )
      const dbtConfig = await readDbtConfig()
      if (!dbtConfig) {
        dbtConfigChecked = true
        dbtAdapter = null
        return null
      }

      // Check if dbt_project.yml exists
      const fs = await import("fs")
      const path = await import("path")
      if (
        !fs.existsSync(path.join(dbtConfig.projectRoot, "dbt_project.yml"))
      ) {
        dbtAdapter = null
        return null
      }

      // Create the adapter
      const { create } = await import("../../../../../dbt-tools/src/adapter")
      dbtAdapter = await create(dbtConfig)
    } catch {
      // dbt-tools not available or config invalid — fall back to native
      dbtAdapter = null
      return null
    }
  }

  try {
    const raw = limit
      ? await dbtAdapter.immediatelyExecuteSQLWithLimit(sql, "", limit)
      : await dbtAdapter.immediatelyExecuteSQL(sql, "")

    // QueryExecutionResult has: { columnNames, columnTypes, data, rawSql, compiledSql }
    // where data is Record<string, unknown>[] (array of row objects)
    if (raw && raw.columnNames && Array.isArray(raw.data)) {
      const columns: string[] = raw.columnNames
      const allRows = raw.data.map((row: Record<string, unknown>) =>
        columns.map((c) => row[c]),
      )
      // The adapter already applies the limit, so allRows.length <= limit.
      // We report truncated=true when exactly limit rows were returned (likely more exist).
      const truncated = limit ? allRows.length >= limit : false
      const rows = allRows
      return {
        columns,
        rows,
        row_count: rows.length,
        truncated,
      }
    }

    // Legacy format: raw.table with column_names/rows arrays
    if (raw && raw.table) {
      const columns = raw.table.column_names ?? raw.table.columns ?? []
      const rows = raw.table.rows ?? []
      const truncated = limit ? rows.length > limit : false
      const trimmedRows = truncated ? rows.slice(0, limit) : rows
      return {
        columns,
        rows: trimmedRows,
        row_count: trimmedRows.length,
        truncated,
      }
    }

    // Array of objects (e.g. from direct query)
    if (raw && Array.isArray(raw)) {
      if (raw.length === 0) return { columns: [], rows: [], row_count: 0, truncated: false }
      const columns = Object.keys(raw[0])
      const rows = raw.map((r: any) => columns.map((c) => r[c]))
      return { columns, rows, row_count: rows.length, truncated: false }
    }

    return null // Unknown result format — fall back to native
  } catch {
    // dbt execution failed — fall back to native driver silently
    return null
  }
}

/** Reset dbt adapter (for testing). */
export function resetDbtAdapter(): void {
  dbtAdapter = undefined
  dbtConfigChecked = false
}

// ---------------------------------------------------------------------------
// Telemetry helpers
// ---------------------------------------------------------------------------

export function detectQueryType(sql: string | null | undefined): string {
  if (!sql || typeof sql !== "string") return "OTHER"
  const trimmed = sql.trim().toUpperCase()
  if (trimmed.startsWith("SELECT") || trimmed.startsWith("WITH")) return "SELECT"
  if (trimmed.startsWith("INSERT")) return "INSERT"
  if (trimmed.startsWith("UPDATE")) return "UPDATE"
  if (trimmed.startsWith("DELETE")) return "DELETE"
  if (trimmed.startsWith("CREATE") || trimmed.startsWith("ALTER") || trimmed.startsWith("DROP")) return "DDL"
  if (trimmed.startsWith("SHOW") || trimmed.startsWith("DESCRIBE") || trimmed.startsWith("EXPLAIN")) return "SHOW"
  return "OTHER"
}

export function categorizeQueryError(e: unknown): string {
  const msg = String(e).toLowerCase()
  if (msg.includes("syntax")) return "syntax_error"
  if (msg.includes("permission") || msg.includes("denied") || msg.includes("access")) return "permission_denied"
  if (msg.includes("timeout")) return "timeout"
  if (msg.includes("connection") || msg.includes("closed") || msg.includes("terminated")) return "connection_lost"
  return "other"
}

function getWarehouseType(warehouseName?: string): string {
  if (!warehouseName) {
    const warehouses = Registry.list().warehouses
    if (warehouses.length > 0) return warehouses[0].type
    return "unknown"
  }
  return Registry.getConfig(warehouseName)?.type ?? "unknown"
}

/** Register all connection-related handlers. Exported for test re-registration. */
export function registerAll(): void {

// --- sql.execute ---
register("sql.execute", async (params: SqlExecuteParams): Promise<SqlExecuteResult> => {
  const startTime = Date.now()
  const warehouseType = getWarehouseType(params.warehouse)
  try {
    // Strategy: try dbt adapter first (if in a dbt project), then fall back to native driver.
    // dbt knows how to connect using profiles.yml — no separate connection config needed.
    if (!params.warehouse) {
      const dbtResult = await tryExecuteViaDbt(params.sql, params.limit)
      if (dbtResult) return dbtResult
    }

    const warehouseName = params.warehouse
    let result: SqlExecuteResult
    if (!warehouseName) {
      const warehouses = Registry.list().warehouses
      if (warehouses.length === 0) {
        throw new Error(
          "No warehouse configured. Use warehouse.add, set ALTIMATE_CODE_CONN_* env vars, or configure a dbt profile.",
        )
      }
      // Use the first warehouse as default
      const connector = await Registry.get(warehouses[0].name)
      result = await connector.execute(params.sql, params.limit)
    } else {
      const connector = await Registry.get(warehouseName)
      result = await connector.execute(params.sql, params.limit)
    }
    try {
      Telemetry.track({
        type: "warehouse_query",
        timestamp: Date.now(),
        session_id: Telemetry.getContext().sessionId,
        warehouse_type: warehouseType,
        query_type: detectQueryType(params.sql),
        success: true,
        duration_ms: Date.now() - startTime,
        row_count: result.row_count,
        truncated: result.truncated,
      })
    } catch {}
    return result
  } catch (e) {
    try {
      Telemetry.track({
        type: "warehouse_query",
        timestamp: Date.now(),
        session_id: Telemetry.getContext().sessionId,
        warehouse_type: warehouseType,
        query_type: detectQueryType(params.sql),
        success: false,
        duration_ms: Date.now() - startTime,
        row_count: 0,
        truncated: false,
        error: String(e).slice(0, 500),
        error_category: categorizeQueryError(e),
      })
    } catch {}
    return { columns: [], rows: [], row_count: 0, truncated: false, error: String(e) } as SqlExecuteResult & { error: string }
  }
})

// --- sql.explain ---
register("sql.explain", async (params: SqlExplainParams): Promise<SqlExplainResult> => {
  try {
    const warehouseName = params.warehouse
    let connector
    let warehouseType: string | undefined

    if (warehouseName) {
      connector = await Registry.get(warehouseName)
      warehouseType = Registry.getConfig(warehouseName)?.type
    } else {
      const warehouses = Registry.list().warehouses
      if (warehouses.length === 0) {
        throw new Error("No warehouse configured.")
      }
      connector = await Registry.get(warehouses[0].name)
      warehouseType = warehouses[0].type
    }

    const explainPrefix = params.analyze ? "EXPLAIN ANALYZE" : "EXPLAIN"
    const result = await connector.execute(
      `${explainPrefix} ${params.sql}`,
      10000,
    )

    const planText = result.rows.map((r) => String(r[0])).join("\n")
    const planRows = result.rows.map((r, i) => ({
      line: i + 1,
      text: String(r[0]),
    }))

    return {
      success: true,
      plan_text: planText,
      plan_rows: planRows,
      warehouse_type: warehouseType,
      analyzed: params.analyze ?? false,
    }
  } catch (e) {
    return {
      success: false,
      plan_rows: [],
      error: String(e),
      analyzed: params.analyze ?? false,
    }
  }
})

// --- sql.autocomplete ---
// Deferred to bridge for now (complex, depends on schema cache)
// Not registering native handler — will fall through to bridge

// --- warehouse.list ---
register("warehouse.list", async (): Promise<WarehouseListResult> => {
  return Registry.list()
})

// --- warehouse.test ---
register("warehouse.test", async (params: WarehouseTestParams): Promise<WarehouseTestResult> => {
  return Registry.test(params.name)
})

// --- warehouse.add ---
register("warehouse.add", async (params: WarehouseAddParams): Promise<WarehouseAddResult> => {
  const config = params.config as ConnectionConfig
  if (!config.type) {
    return {
      success: false,
      name: params.name,
      type: "unknown",
      error: "Config must include a 'type' field (e.g., postgres, snowflake, bigquery).",
    }
  }
  return Registry.add(params.name, config)
})

// --- warehouse.remove ---
register("warehouse.remove", async (params: WarehouseRemoveParams): Promise<WarehouseRemoveResult> => {
  return Registry.remove(params.name)
})

// --- warehouse.discover ---
register("warehouse.discover", async (): Promise<WarehouseDiscoverResult> => {
  try {
    const containers = await discoverContainers()
    try {
      Telemetry.track({
        type: "warehouse_discovery",
        timestamp: Date.now(),
        session_id: Telemetry.getContext().sessionId,
        source: "docker",
        connections_found: containers.length,
        warehouse_types: [...new Set(containers.map((c) => c.db_type))],
      })
    } catch {}
    return {
      containers,
      container_count: containers.length,
    }
  } catch (e) {
    return {
      containers: [],
      container_count: 0,
      error: String(e),
    }
  }
})

// --- schema.inspect ---
register("schema.inspect", async (params: SchemaInspectParams): Promise<SchemaInspectResult> => {
  try {
    const warehouseName = params.warehouse
    let connector

    if (warehouseName) {
      connector = await Registry.get(warehouseName)
    } else {
      const warehouses = Registry.list().warehouses
      if (warehouses.length === 0) {
        throw new Error("No warehouse configured.")
      }
      connector = await Registry.get(warehouses[0].name)
    }

    const schemaName = params.schema_name ?? "public"
    const columns = await connector.describeTable(schemaName, params.table)

    return {
      table: params.table,
      schema_name: schemaName,
      columns: columns.map((c) => ({
        name: c.name,
        data_type: c.data_type,
        nullable: c.nullable,
        primary_key: false, // would need additional query for PK detection
      })),
    }
  } catch (e) {
    return {
      table: params.table,
      schema_name: params.schema_name ?? "public",
      columns: [],
      error: String(e),
    } as SchemaInspectResult & { error: string }
  }
})

// --- dbt.profiles ---
register("dbt.profiles", async (params: DbtProfilesParams): Promise<DbtProfilesResult> => {
  try {
    const connections = await parseDbtProfiles(params.path)
    return {
      success: true,
      connections,
      connection_count: connections.length,
    }
  } catch (e) {
    return {
      success: false,
      connections: [],
      connection_count: 0,
      error: String(e),
    }
  }
})

} // end registerAll

// Auto-register on module load
registerAll()
