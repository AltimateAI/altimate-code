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

/** Register all connection-related handlers. Exported for test re-registration. */
export function registerAll(): void {

// --- sql.execute ---
register("sql.execute", async (params: SqlExecuteParams): Promise<SqlExecuteResult> => {
  try {
    const warehouseName = params.warehouse
    if (!warehouseName) {
      const warehouses = Registry.list().warehouses
      if (warehouses.length === 0) {
        throw new Error(
          "No warehouse configured. Use warehouse.add or set ALTIMATE_CODE_CONN_* env vars.",
        )
      }
      // Use the first warehouse as default
      const connector = await Registry.get(warehouses[0].name)
      return connector.execute(params.sql, params.limit)
    }
    const connector = await Registry.get(warehouseName)
    return connector.execute(params.sql, params.limit)
  } catch (e) {
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
