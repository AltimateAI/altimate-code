/**
 * Query history — fetch and analyze recent query execution from warehouse system tables.
 *
 * SQL templates ported verbatim from Python altimate_engine.finops.query_history.
 */

import * as Registry from "../connections/registry"
import { escapeSqlString } from "@altimateai/drivers"
import type {
  QueryHistoryParams,
  QueryHistoryResult,
} from "../types"

// ---------------------------------------------------------------------------
// SQL templates
// ---------------------------------------------------------------------------

const SNOWFLAKE_HISTORY_SQL = `
SELECT
    query_id,
    query_text,
    query_type,
    user_name,
    warehouse_name,
    warehouse_size,
    execution_status,
    error_code,
    error_message,
    start_time,
    end_time,
    total_elapsed_time / 1000.0 as execution_time_sec,
    bytes_scanned,
    rows_produced,
    credits_used_cloud_services
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
WHERE start_time >= DATEADD('day', -{days}, CURRENT_TIMESTAMP())
{user_filter}
{warehouse_filter}
ORDER BY start_time DESC
LIMIT {limit}
`

const POSTGRES_HISTORY_SQL = `
SELECT
    queryid::text as query_id,
    query as query_text,
    'SELECT' as query_type,
    '' as user_name,
    '' as warehouse_name,
    '' as warehouse_size,
    'SUCCESS' as execution_status,
    NULL as error_code,
    NULL as error_message,
    now() as start_time,
    now() as end_time,
    mean_exec_time / 1000.0 as execution_time_sec,
    shared_blks_read * 8192 as bytes_scanned,
    rows as rows_produced,
    0 as credits_used_cloud_services,
    calls as execution_count
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT {limit}
`

const BIGQUERY_HISTORY_SQL = `
SELECT
    job_id as query_id,
    query as query_text,
    job_type as query_type,
    user_email as user_name,
    '' as warehouse_name,
    reservation_id as warehouse_size,
    state as execution_status,
    NULL as error_code,
    error_message,
    start_time,
    end_time,
    TIMESTAMP_DIFF(end_time, start_time, SECOND) as execution_time_sec,
    total_bytes_billed as bytes_scanned,
    total_rows as rows_produced,
    0 as credits_used_cloud_services
FROM \`region-US.INFORMATION_SCHEMA.JOBS\`
WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL {days} DAY)
ORDER BY creation_time DESC
LIMIT {limit}
`

const DATABRICKS_HISTORY_SQL = `
SELECT
    query_id,
    query_text,
    statement_type as query_type,
    user_name,
    warehouse_id as warehouse_name,
    '' as warehouse_size,
    status as execution_status,
    NULL as error_code,
    error_message,
    start_time,
    end_time,
    execution_time_ms / 1000.0 as execution_time_sec,
    bytes_read as bytes_scanned,
    rows_produced,
    0 as credits_used_cloud_services
FROM system.query.history
WHERE start_time >= DATE_SUB(CURRENT_DATE(), {days})
ORDER BY start_time DESC
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

function buildHistoryQuery(
  whType: string, days: number, limit: number, user?: string, warehouseFilter?: string,
): string | null {
  if (whType === "snowflake") {
    const userF = user ? `AND user_name = '${escapeSqlString(user)}'` : ""
    const whF = warehouseFilter ? `AND warehouse_name = '${escapeSqlString(warehouseFilter)}'` : ""
    return SNOWFLAKE_HISTORY_SQL
      .replace("{days}", String(days))
      .replace("{limit}", String(limit))
      .replace("{user_filter}", userF)
      .replace("{warehouse_filter}", whF)
  }
  if (whType === "postgres" || whType === "postgresql") {
    return POSTGRES_HISTORY_SQL.replace("{limit}", String(limit))
  }
  if (whType === "bigquery") {
    return BIGQUERY_HISTORY_SQL
      .replace("{days}", String(days))
      .replace("{limit}", String(limit))
  }
  if (whType === "databricks") {
    return DATABRICKS_HISTORY_SQL
      .replace("{days}", String(days))
      .replace("{limit}", String(limit))
  }
  if (whType === "duckdb") {
    return null // DuckDB has no native query history
  }
  return null
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

export async function getQueryHistory(params: QueryHistoryParams): Promise<QueryHistoryResult> {
  const whType = getWhType(params.warehouse)
  const days = params.days ?? 7
  const limit = params.limit ?? 100

  const sql = buildHistoryQuery(whType, days, limit, params.user, params.warehouse_filter)
  if (!sql) {
    return {
      success: false,
      queries: [],
      summary: {},
      error: `Query history is not available for ${whType} warehouses.`,
    }
  }

  try {
    const connector = await Registry.get(params.warehouse)
    const result = await connector.execute(sql, limit)
    const queries = rowsToRecords(result)

    let totalBytes = 0
    let totalTime = 0
    let errorCount = 0

    for (const q of queries) {
      totalBytes += Number(q.bytes_scanned || 0)
      totalTime += Number(q.execution_time_sec || 0)
      if (String(q.execution_status || "").toUpperCase() !== "SUCCESS") {
        errorCount++
      }
    }

    const summary = {
      query_count: queries.length,
      total_bytes_scanned: totalBytes,
      total_execution_time_sec: Math.round(totalTime * 100) / 100,
      error_count: errorCount,
      avg_execution_time_sec: queries.length > 0
        ? Math.round((totalTime / queries.length) * 100) / 100
        : 0,
    }

    return {
      success: true,
      queries,
      summary,
      warehouse_type: whType,
    }
  } catch (e) {
    return {
      success: false,
      queries: [],
      summary: {},
      error: String(e),
    }
  }
}

// Exported for SQL template testing
export const SQL_TEMPLATES = {
  SNOWFLAKE_HISTORY_SQL,
  POSTGRES_HISTORY_SQL,
  BIGQUERY_HISTORY_SQL,
  DATABRICKS_HISTORY_SQL,
  buildHistoryQuery,
}
