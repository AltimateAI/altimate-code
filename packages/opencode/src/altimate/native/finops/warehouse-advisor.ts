/**
 * Warehouse sizing advisor — recommend optimal warehouse configuration.
 *
 * SQL templates ported verbatim from Python altimate_engine.finops.warehouse_advisor.
 */

import * as Registry from "../connections/registry"
import type {
  WarehouseAdvisorParams,
  WarehouseAdvisorResult,
} from "../types"

// ---------------------------------------------------------------------------
// Snowflake SQL templates
// ---------------------------------------------------------------------------

const SNOWFLAKE_LOAD_SQL = `
SELECT
    warehouse_name,
    AVG(avg_running) as avg_concurrency,
    AVG(avg_queued_load) as avg_queue_load,
    MAX(avg_queued_load) as peak_queue_load,
    COUNT(*) as sample_count
FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_LOAD_HISTORY
WHERE start_time >= DATEADD('day', -{days}, CURRENT_TIMESTAMP())
GROUP BY warehouse_name
ORDER BY avg_queue_load DESC
`

const SNOWFLAKE_SIZING_SQL = `
SELECT
    warehouse_name,
    COUNT(*) as query_count,
    AVG(total_elapsed_time) / 1000.0 as avg_time_sec,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY total_elapsed_time) / 1000.0 as p95_time_sec,
    AVG(bytes_scanned) as avg_bytes_scanned,
    SUM(credits_used_cloud_services) as total_credits
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
WHERE start_time >= DATEADD('day', -{days}, CURRENT_TIMESTAMP())
  AND execution_status = 'SUCCESS'
GROUP BY warehouse_name
ORDER BY total_credits DESC
`

// SHOW WAREHOUSES: fast metadata query — no ACCOUNT_USAGE latency, no credits consumed.
// Used to look up current warehouse sizes for recommendations.
const SNOWFLAKE_SHOW_WAREHOUSES = "SHOW WAREHOUSES"

// ---------------------------------------------------------------------------
// BigQuery SQL templates
// ---------------------------------------------------------------------------

const BIGQUERY_LOAD_SQL = `
SELECT
    reservation_id as warehouse_name,
    '' as warehouse_size,
    AVG(period_slot_ms / 1000.0) as avg_concurrency,
    0 as avg_queue_load,
    MAX(period_slot_ms / 1000.0) as peak_queue_load,
    COUNT(*) as sample_count
FROM \`region-US.INFORMATION_SCHEMA.JOBS_TIMELINE\`
WHERE period_start >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL {days} DAY)
GROUP BY reservation_id
ORDER BY avg_concurrency DESC
`

const BIGQUERY_SIZING_SQL = `
SELECT
    reservation_id as warehouse_name,
    '' as warehouse_size,
    COUNT(*) as query_count,
    AVG(TIMESTAMP_DIFF(end_time, start_time, MILLISECOND)) / 1000.0 as avg_time_sec,
    APPROX_QUANTILES(TIMESTAMP_DIFF(end_time, start_time, MILLISECOND), 100)[OFFSET(95)] / 1000.0 as p95_time_sec,
    AVG(total_bytes_billed) as avg_bytes_scanned,
    SUM(total_bytes_billed) / 1099511627776.0 * 5.0 as total_credits
FROM \`region-US.INFORMATION_SCHEMA.JOBS\`
WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL {days} DAY)
  AND job_type = 'QUERY'
  AND state = 'DONE'
GROUP BY reservation_id
ORDER BY total_credits DESC
`

// ---------------------------------------------------------------------------
// Databricks SQL templates
// ---------------------------------------------------------------------------

const DATABRICKS_LOAD_SQL = `
SELECT
    warehouse_id as warehouse_name,
    '' as warehouse_size,
    AVG(num_active_sessions) as avg_concurrency,
    AVG(num_queued_queries) as avg_queue_load,
    MAX(num_queued_queries) as peak_queue_load,
    COUNT(*) as sample_count
FROM system.compute.warehouse_events
WHERE event_time >= DATE_SUB(CURRENT_DATE(), {days})
GROUP BY warehouse_id
ORDER BY avg_queue_load DESC
`

const DATABRICKS_SIZING_SQL = `
SELECT
    warehouse_id as warehouse_name,
    '' as warehouse_size,
    COUNT(*) as query_count,
    AVG(total_duration_ms) / 1000.0 as avg_time_sec,
    PERCENTILE(total_duration_ms, 0.95) / 1000.0 as p95_time_sec,
    AVG(read_bytes) as avg_bytes_scanned,
    0 as total_credits
FROM system.query.history
WHERE start_time >= DATE_SUB(CURRENT_DATE(), {days})
  AND status = 'FINISHED'
GROUP BY warehouse_id
ORDER BY query_count DESC
`

const SIZE_ORDER = ["X-Small", "Small", "Medium", "Large", "X-Large", "2X-Large", "3X-Large", "4X-Large"]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getWhType(warehouse: string): string {
  const warehouses = Registry.list().warehouses
  const wh = warehouses.find((w) => w.name === warehouse)
  return wh?.type || "unknown"
}

function buildLoadSql(whType: string, days: number): string | null {
  if (whType === "snowflake") return SNOWFLAKE_LOAD_SQL.replace("{days}", String(days))
  if (whType === "bigquery") return BIGQUERY_LOAD_SQL.replace("{days}", String(days))
  if (whType === "databricks") return DATABRICKS_LOAD_SQL.replace(/{days}/g, String(days))
  return null
}

function buildSizingSql(whType: string, days: number): string | null {
  if (whType === "snowflake") return SNOWFLAKE_SIZING_SQL.replace("{days}", String(days))
  if (whType === "bigquery") return BIGQUERY_SIZING_SQL.replace("{days}", String(days))
  if (whType === "databricks") return DATABRICKS_SIZING_SQL.replace(/{days}/g, String(days))
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

function generateSizingRecommendations(
  loadData: Record<string, unknown>[],
  sizingData: Record<string, unknown>[],
  sizeByWarehouse: Map<string, string>,
): Record<string, unknown>[] {
  const recs: Record<string, unknown>[] = []

  for (const wh of loadData) {
    const name = String(wh.warehouse_name || "unknown")
    const size = sizeByWarehouse.get(name) ?? String(wh.warehouse_size || "unknown")
    const avgQueue = Number(wh.avg_queue_load || 0)
    const peakQueue = Number(wh.peak_queue_load || 0)
    const avgConcurrency = Number(wh.avg_concurrency || 0)

    if (avgQueue > 1.0) {
      recs.push({
        type: "SCALE_UP",
        warehouse: name,
        current_size: size,
        message: `Warehouse '${name}' (${size}) has avg queue load of ${avgQueue.toFixed(1)}. Consider scaling up or enabling multi-cluster warehousing.`,
        impact: "high",
      })
    } else if (peakQueue > 5.0) {
      recs.push({
        type: "BURST_SCALING",
        warehouse: name,
        current_size: size,
        message: `Warehouse '${name}' (${size}) has peak queue load of ${peakQueue.toFixed(1)}. Consider multi-cluster with auto-scale for burst workloads.`,
        impact: "medium",
      })
    }

    if (avgConcurrency < 0.1 && avgQueue < 0.01) {
      const sizeIdx = SIZE_ORDER.findIndex((s) => s.toLowerCase() === size.toLowerCase())
      if (sizeIdx > 0) {
        const suggested = SIZE_ORDER[sizeIdx - 1]
        recs.push({
          type: "SCALE_DOWN",
          warehouse: name,
          current_size: size,
          suggested_size: suggested,
          message: `Warehouse '${name}' (${size}) is underutilized (avg concurrency ${avgConcurrency.toFixed(2)}). Consider downsizing to ${suggested}.`,
          impact: "medium",
        })
      }
    }
  }

  if (recs.length === 0) {
    recs.push({
      type: "HEALTHY",
      message: "All warehouses appear to be appropriately sized.",
      impact: "low",
    })
  }

  return recs
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function adviseWarehouse(params: WarehouseAdvisorParams): Promise<WarehouseAdvisorResult> {
  const whType = getWhType(params.warehouse)
  const days = params.days ?? 14

  const loadSql = buildLoadSql(whType, days)
  const sizingSql = buildSizingSql(whType, days)

  if (!loadSql || !sizingSql) {
    return {
      success: false,
      warehouse_load: [],
      warehouse_performance: [],
      recommendations: [],
      days_analyzed: days,
      error: `Warehouse sizing advice is not available for ${whType} warehouses.`,
    }
  }

  try {
    const connector = await Registry.get(params.warehouse)

    // Run load and sizing queries in parallel
    const [loadResult, sizingResult] = await Promise.all([
      connector.execute(loadSql, 1000),
      connector.execute(sizingSql, 1000),
    ])

    // Build warehouse name → size map from SHOW WAREHOUSES (Snowflake only).
    // Failures (e.g. insufficient privileges) are silently ignored — recommendations
    // still work but show "unknown" for size.
    const sizeByWarehouse = new Map<string, string>()
    if (whType === "snowflake") {
      try {
        const showResult = await connector.execute(SNOWFLAKE_SHOW_WAREHOUSES, 1000)
        const nameIdx = showResult.columns.indexOf("name")
        const sizeIdx = showResult.columns.indexOf("size")
        for (const row of showResult.rows) {
          if (nameIdx >= 0 && sizeIdx >= 0) {
            sizeByWarehouse.set(String(row[nameIdx]), String(row[sizeIdx]))
          }
        }
      } catch {
        // ignore — size will fall back to "unknown"
      }
    }

    const loadData = rowsToRecords(loadResult)
    const sizingData = rowsToRecords(sizingResult)
    const recommendations = generateSizingRecommendations(loadData, sizingData, sizeByWarehouse)

    return {
      success: true,
      warehouse_load: loadData,
      warehouse_performance: sizingData,
      recommendations,
      days_analyzed: days,
    }
  } catch (e) {
    return {
      success: false,
      warehouse_load: [],
      warehouse_performance: [],
      recommendations: [],
      days_analyzed: days,
      error: String(e),
    }
  }
}

// Exported for SQL template testing
export const SQL_TEMPLATES = {
  SNOWFLAKE_LOAD_SQL,
  SNOWFLAKE_SIZING_SQL,
  SNOWFLAKE_SHOW_WAREHOUSES,
  BIGQUERY_LOAD_SQL,
  BIGQUERY_SIZING_SQL,
  DATABRICKS_LOAD_SQL,
  DATABRICKS_SIZING_SQL,
  buildLoadSql,
  buildSizingSql,
  generateSizingRecommendations,
}
