/**
 * Unused resource identification — find stale tables, idle warehouses, and dormant schemas.
 *
 * SQL templates ported verbatim from Python altimate_engine.finops.unused_resources.
 */

import * as Registry from "../connections/registry"
import type {
  UnusedResourcesParams,
  UnusedResourcesResult,
} from "../types"

// ---------------------------------------------------------------------------
// Snowflake SQL templates
// ---------------------------------------------------------------------------

const SNOWFLAKE_UNUSED_TABLES_SQL = `
SELECT
    table_catalog as database_name,
    table_schema as schema_name,
    table_name,
    row_count,
    bytes as size_bytes,
    last_altered,
    created
FROM SNOWFLAKE.ACCOUNT_USAGE.TABLE_STORAGE_METRICS
WHERE active_bytes > 0
  AND table_catalog NOT IN ('SNOWFLAKE')
  AND table_schema NOT IN ('INFORMATION_SCHEMA')
  AND NOT EXISTS (
      SELECT 1
      FROM SNOWFLAKE.ACCOUNT_USAGE.ACCESS_HISTORY ah,
           LATERAL FLATTEN(input => ah.base_objects_accessed) f
      WHERE f.value:"objectName"::string = table_catalog || '.' || table_schema || '.' || table_name
        AND ah.query_start_time >= DATEADD('day', -{days}, CURRENT_TIMESTAMP())
  )
ORDER BY size_bytes DESC NULLS LAST
LIMIT {limit}
`

const SNOWFLAKE_UNUSED_TABLES_SIMPLE_SQL = `
SELECT
    table_catalog as database_name,
    table_schema as schema_name,
    table_name,
    row_count,
    bytes as size_bytes,
    last_altered,
    created
FROM SNOWFLAKE.ACCOUNT_USAGE.TABLE_STORAGE_METRICS
WHERE active_bytes > 0
  AND table_catalog NOT IN ('SNOWFLAKE')
  AND table_schema NOT IN ('INFORMATION_SCHEMA')
  AND last_altered < DATEADD('day', -{days}, CURRENT_TIMESTAMP())
ORDER BY size_bytes DESC NULLS LAST
LIMIT {limit}
`

const SNOWFLAKE_IDLE_WAREHOUSES_SQL = `
SELECT
    name as warehouse_name,
    type,
    size as warehouse_size,
    auto_suspend,
    auto_resume,
    created_on,
    CASE
        WHEN name NOT IN (
            SELECT DISTINCT warehouse_name
            FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
            WHERE start_time >= DATEADD('day', -{days}, CURRENT_TIMESTAMP())
        ) THEN TRUE
        ELSE FALSE
    END as is_idle
FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSES
WHERE deleted_on IS NULL
ORDER BY is_idle DESC, warehouse_name
`

// ---------------------------------------------------------------------------
// BigQuery SQL templates
// ---------------------------------------------------------------------------

const BIGQUERY_UNUSED_TABLES_SQL = `
SELECT
    table_catalog as database_name,
    table_schema as schema_name,
    table_name,
    row_count,
    size_bytes,
    TIMESTAMP_MILLIS(last_modified_time) as last_altered,
    creation_time as created
FROM \`region-US.INFORMATION_SCHEMA.TABLE_STORAGE\`
WHERE NOT deleted
  AND last_modified_time < UNIX_MILLIS(TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL {days} DAY))
ORDER BY size_bytes DESC
LIMIT {limit}
`

// ---------------------------------------------------------------------------
// Databricks SQL templates
// ---------------------------------------------------------------------------

const DATABRICKS_UNUSED_TABLES_SQL = `
SELECT
    table_catalog as database_name,
    table_schema as schema_name,
    table_name,
    0 as row_count,
    0 as size_bytes,
    last_altered,
    created
FROM system.information_schema.tables
WHERE last_altered < DATE_SUB(CURRENT_DATE(), {days})
ORDER BY last_altered ASC
LIMIT {limit}
`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getWhType(warehouse: string): string {
  const warehouses = Registry.list().warehouses
  const wh = warehouses.find((w) => w.name === warehouse)
  return wh?.type || "unknown"
}

function rowsToRecords(result: { columns: string[]; rows: any[][] }): Record<string, unknown>[] {
  return result.rows.map((row) => {
    const obj: Record<string, unknown> = {}
    result.columns.forEach((col, i) => {
      obj[col] = row[i]
    })
    return obj
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function findUnusedResources(params: UnusedResourcesParams): Promise<UnusedResourcesResult> {
  const whType = getWhType(params.warehouse)
  const days = params.days ?? 30
  const limit = params.limit ?? 50

  if (!["snowflake", "bigquery", "databricks"].includes(whType)) {
    return {
      success: false,
      unused_tables: [],
      idle_warehouses: [],
      summary: {},
      days_analyzed: days,
      error: `Unused resource detection is not available for ${whType} warehouses.`,
    }
  }

  try {
    const connector = await Registry.get(params.warehouse)
    let unusedTables: Record<string, unknown>[] = []
    let idleWarehouses: Record<string, unknown>[] = []
    const errors: string[] = []

    if (whType === "snowflake") {
      // Try ACCESS_HISTORY first, fall back to simple query
      try {
        const sql = SNOWFLAKE_UNUSED_TABLES_SQL
          .replace("{days}", String(days))
          .replace("{limit}", String(limit))
        const result = await connector.execute(sql, limit)
        unusedTables = rowsToRecords(result)
      } catch {
        try {
          const sql = SNOWFLAKE_UNUSED_TABLES_SIMPLE_SQL
            .replace("{days}", String(days))
            .replace("{limit}", String(limit))
          const result = await connector.execute(sql, limit)
          unusedTables = rowsToRecords(result)
        } catch (e) {
          errors.push(`Could not query unused tables: ${e}`)
        }
      }

      // Idle warehouses
      try {
        const sql = SNOWFLAKE_IDLE_WAREHOUSES_SQL.replace("{days}", String(days))
        const result = await connector.execute(sql, 1000)
        const all = rowsToRecords(result)
        idleWarehouses = all.filter((w) => w.is_idle)
      } catch (e) {
        errors.push(`Could not query idle warehouses: ${e}`)
      }
    } else if (whType === "bigquery") {
      try {
        const sql = BIGQUERY_UNUSED_TABLES_SQL
          .replace("{days}", String(days))
          .replace("{limit}", String(limit))
        const result = await connector.execute(sql, limit)
        unusedTables = rowsToRecords(result)
      } catch (e) {
        errors.push(`Could not query unused tables: ${e}`)
      }
    } else if (whType === "databricks") {
      try {
        const sql = DATABRICKS_UNUSED_TABLES_SQL
          .replace(/{days}/g, String(days))
          .replace("{limit}", String(limit))
        const result = await connector.execute(sql, limit)
        unusedTables = rowsToRecords(result)
      } catch (e) {
        errors.push(`Could not query unused tables: ${e}`)
      }
    }

    const totalStaleBytes = unusedTables.reduce(
      (acc, t) => acc + Number(t.size_bytes || 0), 0,
    )
    const totalStaleGb = totalStaleBytes > 0
      ? Math.round(totalStaleBytes / (1024 ** 3) * 100) / 100
      : 0

    return {
      success: true,
      unused_tables: unusedTables,
      idle_warehouses: idleWarehouses,
      summary: {
        unused_table_count: unusedTables.length,
        idle_warehouse_count: idleWarehouses.length,
        total_stale_storage_gb: totalStaleGb,
      },
      days_analyzed: days,
      error: errors.length > 0 ? errors.join("; ") : undefined,
    }
  } catch (e) {
    return {
      success: false,
      unused_tables: [],
      idle_warehouses: [],
      summary: {},
      days_analyzed: days,
      error: String(e),
    }
  }
}

// Exported for SQL template testing
export const SQL_TEMPLATES = {
  SNOWFLAKE_UNUSED_TABLES_SQL,
  SNOWFLAKE_UNUSED_TABLES_SIMPLE_SQL,
  SNOWFLAKE_IDLE_WAREHOUSES_SQL,
  BIGQUERY_UNUSED_TABLES_SQL,
  DATABRICKS_UNUSED_TABLES_SQL,
}
