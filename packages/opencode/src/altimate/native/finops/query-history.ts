/**
 * Query history — fetch and analyze recent query execution from warehouse system tables.
 *
 * SQL templates ported verbatim from Python altimate_engine.finops.query_history.
 */

import * as Registry from "../connections/registry"
import { bqRegionFor, interpolateBqRegion } from "./bq-utils"
import { resolveFinopsWarehouse } from "./warehouse-resolver"
import type { QueryHistoryParams, QueryHistoryResult } from "../types"

const QUERY_HISTORY_SUPPORTED_TYPES = [
  "snowflake",
  "postgres",
  "postgresql",
  "bigquery",
  "databricks",
  "clickhouse",
] as const

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
WHERE start_time >= DATEADD('day', ?, CURRENT_TIMESTAMP())
{user_filter}
{warehouse_filter}
ORDER BY start_time DESC
LIMIT ?
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

// BigQuery's INFORMATION_SCHEMA.JOBS does not have top-level `error_message`,
// `error_code`, or `total_rows` columns. Errors live under the `error_result`
// STRUCT ({reason, location, message, debug_info}) and per-row counts aren't
// exposed at the jobs level. `state` returns 'DONE' (not 'SUCCESS'), so we
// derive execution_status from error_result to stay consistent with the other
// warehouse templates and the summary loop in getQueryHistory().
const BIGQUERY_HISTORY_SQL = `
SELECT
    job_id as query_id,
    query as query_text,
    job_type as query_type,
    user_email as user_name,
    '' as warehouse_name,
    reservation_id as warehouse_size,
    CASE WHEN error_result IS NULL THEN 'SUCCESS' ELSE 'FAILED' END as execution_status,
    error_result.reason as error_code,
    error_result.message as error_message,
    start_time,
    end_time,
    TIMESTAMP_DIFF(end_time, start_time, SECOND) as execution_time_sec,
    total_bytes_billed as bytes_scanned,
    CAST(NULL AS INT64) as rows_produced,
    0 as credits_used_cloud_services
FROM \`region-{region}.INFORMATION_SCHEMA.JOBS\`
WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ? DAY)
ORDER BY creation_time DESC
LIMIT ?
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
WHERE start_time >= DATE_SUB(CURRENT_DATE(), ?)
ORDER BY start_time DESC
LIMIT ?
`

const CLICKHOUSE_HISTORY_SQL = `
SELECT
    query_id,
    query as query_text,
    query_kind as query_type,
    user as user_name,
    '' as warehouse_name,
    '' as warehouse_size,
    multiIf(exception_code = 0, 'SUCCESS', 'FAILED') as execution_status,
    toString(exception_code) as error_code,
    exception as error_message,
    event_time as start_time,
    event_time + query_duration_ms / 1000 as end_time,
    query_duration_ms / 1000.0 as execution_time_sec,
    read_bytes as bytes_scanned,
    result_rows as rows_produced,
    0 as credits_used_cloud_services
FROM system.query_log
WHERE type = 'QueryFinish'
  AND event_date >= today() - __DAYS__
  AND is_initial_query = 1
ORDER BY event_time DESC
LIMIT __LIMIT__
`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildHistoryQuery(
  whType: string,
  days: number,
  limit: number,
  user?: string,
  warehouseFilter?: string,
  bqRegion?: unknown,
): { sql: string; binds: any[] } | null {
  if (whType === "snowflake") {
    const binds: any[] = [-days]
    const userF = user ? (binds.push(user), "AND user_name = ?") : ""
    const whF = warehouseFilter ? (binds.push(warehouseFilter), "AND warehouse_name = ?") : ""
    binds.push(limit)
    return {
      sql: SNOWFLAKE_HISTORY_SQL.replace("{user_filter}", userF).replace("{warehouse_filter}", whF),
      binds,
    }
  }
  if (whType === "postgres" || whType === "postgresql") {
    return { sql: POSTGRES_HISTORY_SQL.replace("{limit}", String(Math.floor(Number(limit)))), binds: [] }
  }
  if (whType === "bigquery") {
    return {
      sql: interpolateBqRegion(BIGQUERY_HISTORY_SQL, bqRegion),
      binds: [days, limit],
    }
  }
  if (whType === "databricks") {
    return { sql: DATABRICKS_HISTORY_SQL, binds: [days, limit] }
  }
  if (whType === "clickhouse") {
    const clampedDays = Math.max(1, Math.min(Math.floor(Number(days)) || 30, 365))
    const clampedLimit = Math.max(1, Math.min(Math.floor(Number(limit)) || 100, 10000))
    // Placeholders use __NAME__ format (not ClickHouse's {name:Type} syntax) to
    // make clear these are string-substituted with clamped integer values, not
    // ClickHouse query parameters.
    const sql = CLICKHOUSE_HISTORY_SQL.replace("__DAYS__", String(clampedDays)).replace(
      "__LIMIT__",
      String(clampedLimit),
    )
    return { sql, binds: [] }
  }
  if (whType === "duckdb") {
    return null // DuckDB has no native query history
  }
  if (whType === "trino") {
    return null // Trino exposes live runtime query state, not durable query history
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
  const days = params.days ?? 7
  const limit = params.limit ?? 100

  const resolved = resolveFinopsWarehouse({
    requested: params.warehouse,
    supportedTypes: QUERY_HISTORY_SUPPORTED_TYPES,
    operationName: "Query history",
  })
  if (resolved.kind === "error") {
    return {
      success: false,
      queries: [],
      summary: {},
      error: resolved.error,
    }
  }

  const { warehouse: whName, type: whType } = resolved
  const bqRegion = whType === "bigquery" ? bqRegionFor(whName) : undefined

  const built = buildHistoryQuery(whType, days, limit, params.user, params.warehouse_filter, bqRegion)
  if (!built) {
    return {
      success: false,
      queries: [],
      summary: {},
      error: `Internal error: query history SQL template missing for ${whType}.`,
    }
  }

  try {
    const connector = await Registry.get(whName)
    const result = await connector.execute(built.sql, limit, built.binds)
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
      avg_execution_time_sec: queries.length > 0 ? Math.round((totalTime / queries.length) * 100) / 100 : 0,
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
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

// Exported for SQL template testing
export const SQL_TEMPLATES = {
  SNOWFLAKE_HISTORY_SQL,
  POSTGRES_HISTORY_SQL,
  BIGQUERY_HISTORY_SQL,
  DATABRICKS_HISTORY_SQL,
  CLICKHOUSE_HISTORY_SQL,
  buildHistoryQuery,
}
