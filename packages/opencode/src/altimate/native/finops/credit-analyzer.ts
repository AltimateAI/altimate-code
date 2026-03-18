/**
 * Credit consumption analysis — analyze warehouse credit usage and trends.
 *
 * SQL templates ported verbatim from Python altimate_engine.finops.credit_analyzer.
 */

import * as Registry from "../connections/registry"
import { escapeSqlString } from "@altimateai/drivers"
import type {
  CreditAnalysisParams,
  CreditAnalysisResult,
  ExpensiveQueriesParams,
  ExpensiveQueriesResult,
} from "../types"

// ---------------------------------------------------------------------------
// Snowflake SQL templates
// ---------------------------------------------------------------------------

const SNOWFLAKE_CREDIT_USAGE_SQL = `
SELECT
    warehouse_name,
    DATE_TRUNC('day', start_time) as usage_date,
    SUM(credits_used) as credits_used,
    SUM(credits_used_compute) as credits_compute,
    SUM(credits_used_cloud_services) as credits_cloud,
    COUNT(*) as query_count,
    AVG(credits_used) as avg_credits_per_query
FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
WHERE start_time >= DATEADD('day', -{days}, CURRENT_TIMESTAMP())
{warehouse_filter}
GROUP BY warehouse_name, DATE_TRUNC('day', start_time)
ORDER BY usage_date DESC, credits_used DESC
LIMIT {limit}
`

const SNOWFLAKE_CREDIT_SUMMARY_SQL = `
SELECT
    warehouse_name,
    SUM(credits_used) as total_credits,
    SUM(credits_used_compute) as total_compute_credits,
    SUM(credits_used_cloud_services) as total_cloud_credits,
    COUNT(DISTINCT DATE_TRUNC('day', start_time)) as active_days,
    AVG(credits_used) as avg_daily_credits
FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
WHERE start_time >= DATEADD('day', -{days}, CURRENT_TIMESTAMP())
GROUP BY warehouse_name
ORDER BY total_credits DESC
`

const SNOWFLAKE_EXPENSIVE_SQL = `
SELECT
    query_id,
    LEFT(query_text, 200) as query_preview,
    user_name,
    warehouse_name,
    warehouse_size,
    total_elapsed_time / 1000.0 as execution_time_sec,
    bytes_scanned,
    rows_produced,
    credits_used_cloud_services as credits_used,
    start_time
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
WHERE start_time >= DATEADD('day', -{days}, CURRENT_TIMESTAMP())
  AND execution_status = 'SUCCESS'
  AND bytes_scanned > 0
ORDER BY bytes_scanned DESC
LIMIT {limit}
`

// ---------------------------------------------------------------------------
// BigQuery SQL templates
// ---------------------------------------------------------------------------

const BIGQUERY_CREDIT_USAGE_SQL = `
SELECT
    '' as warehouse_name,
    DATE(creation_time) as usage_date,
    SUM(total_bytes_billed) / 1099511627776.0 * 5.0 as credits_used,
    SUM(total_bytes_billed) / 1099511627776.0 * 5.0 as credits_compute,
    0 as credits_cloud,
    COUNT(*) as query_count,
    AVG(total_bytes_billed) / 1099511627776.0 * 5.0 as avg_credits_per_query
FROM \`region-US.INFORMATION_SCHEMA.JOBS\`
WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL {days} DAY)
  AND job_type = 'QUERY'
  AND state = 'DONE'
GROUP BY DATE(creation_time)
ORDER BY usage_date DESC
LIMIT {limit}
`

const BIGQUERY_CREDIT_SUMMARY_SQL = `
SELECT
    '' as warehouse_name,
    SUM(total_bytes_billed) / 1099511627776.0 * 5.0 as total_credits,
    SUM(total_bytes_billed) / 1099511627776.0 * 5.0 as total_compute_credits,
    0 as total_cloud_credits,
    COUNT(DISTINCT DATE(creation_time)) as active_days,
    AVG(total_bytes_billed) / 1099511627776.0 * 5.0 as avg_daily_credits
FROM \`region-US.INFORMATION_SCHEMA.JOBS\`
WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL {days} DAY)
  AND job_type = 'QUERY'
  AND state = 'DONE'
`

const BIGQUERY_EXPENSIVE_SQL = `
SELECT
    job_id as query_id,
    LEFT(query, 200) as query_preview,
    user_email as user_name,
    '' as warehouse_name,
    reservation_id as warehouse_size,
    TIMESTAMP_DIFF(end_time, start_time, SECOND) as execution_time_sec,
    total_bytes_billed as bytes_scanned,
    0 as rows_produced,
    total_bytes_billed / 1099511627776.0 * 5.0 as credits_used,
    start_time
FROM \`region-US.INFORMATION_SCHEMA.JOBS\`
WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL {days} DAY)
  AND job_type = 'QUERY'
  AND state = 'DONE'
  AND total_bytes_billed > 0
ORDER BY total_bytes_billed DESC
LIMIT {limit}
`

// ---------------------------------------------------------------------------
// Databricks SQL templates
// ---------------------------------------------------------------------------

const DATABRICKS_CREDIT_USAGE_SQL = `
SELECT
    usage_metadata.warehouse_id as warehouse_name,
    usage_date,
    SUM(usage_quantity) as credits_used,
    SUM(usage_quantity) as credits_compute,
    0 as credits_cloud,
    0 as query_count,
    AVG(usage_quantity) as avg_credits_per_query
FROM system.billing.usage
WHERE usage_date >= DATE_SUB(CURRENT_DATE(), {days})
  AND billing_origin_product = 'SQL'
GROUP BY usage_metadata.warehouse_id, usage_date
ORDER BY usage_date DESC
LIMIT {limit}
`

const DATABRICKS_CREDIT_SUMMARY_SQL = `
SELECT
    usage_metadata.warehouse_id as warehouse_name,
    SUM(usage_quantity) as total_credits,
    SUM(usage_quantity) as total_compute_credits,
    0 as total_cloud_credits,
    COUNT(DISTINCT usage_date) as active_days,
    AVG(usage_quantity) as avg_daily_credits
FROM system.billing.usage
WHERE usage_date >= DATE_SUB(CURRENT_DATE(), {days})
  AND billing_origin_product = 'SQL'
GROUP BY usage_metadata.warehouse_id
ORDER BY total_credits DESC
`

const DATABRICKS_EXPENSIVE_SQL = `
SELECT
    query_id,
    LEFT(query_text, 200) as query_preview,
    user_name,
    warehouse_id as warehouse_name,
    '' as warehouse_size,
    total_duration_ms / 1000.0 as execution_time_sec,
    read_bytes as bytes_scanned,
    rows_produced,
    0 as credits_used,
    start_time
FROM system.query.history
WHERE start_time >= DATE_SUB(CURRENT_DATE(), {days})
  AND status = 'FINISHED'
  AND read_bytes > 0
ORDER BY read_bytes DESC
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

function buildCreditUsageSql(
  whType: string, days: number, limit: number, warehouseFilter?: string,
): string | null {
  if (whType === "snowflake") {
    const whF = warehouseFilter ? `AND warehouse_name = '${escapeSqlString(warehouseFilter)}'` : ""
    return SNOWFLAKE_CREDIT_USAGE_SQL
      .replace("{days}", String(days))
      .replace("{limit}", String(limit))
      .replace("{warehouse_filter}", whF)
  }
  if (whType === "bigquery") {
    return BIGQUERY_CREDIT_USAGE_SQL
      .replace(/{days}/g, String(days))
      .replace("{limit}", String(limit))
  }
  if (whType === "databricks") {
    return DATABRICKS_CREDIT_USAGE_SQL
      .replace("{days}", String(days))
      .replace("{limit}", String(limit))
  }
  return null
}

function buildCreditSummarySql(whType: string, days: number): string | null {
  if (whType === "snowflake") {
    return SNOWFLAKE_CREDIT_SUMMARY_SQL.replace("{days}", String(days))
  }
  if (whType === "bigquery") {
    return BIGQUERY_CREDIT_SUMMARY_SQL.replace(/{days}/g, String(days))
  }
  if (whType === "databricks") {
    return DATABRICKS_CREDIT_SUMMARY_SQL.replace("{days}", String(days))
  }
  return null
}

function buildExpensiveSql(whType: string, days: number, limit: number): string | null {
  if (whType === "snowflake") {
    return SNOWFLAKE_EXPENSIVE_SQL
      .replace("{days}", String(days))
      .replace("{limit}", String(limit))
  }
  if (whType === "bigquery") {
    return BIGQUERY_EXPENSIVE_SQL
      .replace(/{days}/g, String(days))
      .replace("{limit}", String(limit))
  }
  if (whType === "databricks") {
    return DATABRICKS_EXPENSIVE_SQL
      .replace(/{days}/g, String(days))
      .replace("{limit}", String(limit))
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

function generateRecommendations(
  summary: Record<string, unknown>[], daily: Record<string, unknown>[], days: number,
): Record<string, unknown>[] {
  const recs: Record<string, unknown>[] = []

  for (const wh of summary) {
    const name = String(wh.warehouse_name || "unknown")
    const total = Number(wh.total_credits || 0)
    const activeDays = Number(wh.active_days || 0)

    if (activeDays < days * 0.3 && total > 0) {
      recs.push({
        type: "IDLE_WAREHOUSE",
        warehouse: name,
        message: `Warehouse '${name}' was active only ${activeDays}/${days} days but consumed ${total.toFixed(2)} credits. Consider auto-suspend or reducing size.`,
        impact: "high",
      })
    }

    if (total > 100 && days <= 30) {
      recs.push({
        type: "HIGH_USAGE",
        warehouse: name,
        message: `Warehouse '${name}' consumed ${total.toFixed(2)} credits in ${days} days. Review query patterns and consider query optimization.`,
        impact: "high",
      })
    }
  }

  if (recs.length === 0) {
    recs.push({
      type: "HEALTHY",
      message: "No immediate cost optimization issues detected.",
      impact: "low",
    })
  }

  return recs
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function analyzeCredits(params: CreditAnalysisParams): Promise<CreditAnalysisResult> {
  const whType = getWhType(params.warehouse)
  const days = params.days ?? 30
  const limit = params.limit ?? 50

  const dailySql = buildCreditUsageSql(whType, days, limit, params.warehouse_filter)
  const summarySql = buildCreditSummarySql(whType, days)

  if (!dailySql || !summarySql) {
    return {
      success: false,
      daily_usage: [],
      warehouse_summary: [],
      total_credits: 0,
      days_analyzed: days,
      recommendations: [],
      error: `Credit analysis is not available for ${whType} warehouses.`,
    }
  }

  try {
    const connector = await Registry.get(params.warehouse)
    const dailyResult = await connector.execute(dailySql, limit)
    const summaryResult = await connector.execute(summarySql, 1000)

    const daily = rowsToRecords(dailyResult)
    const summary = rowsToRecords(summaryResult)
    const recommendations = generateRecommendations(summary, daily, days)
    const totalCredits = summary.reduce((acc, s) => acc + Number(s.total_credits || 0), 0)

    return {
      success: true,
      daily_usage: daily,
      warehouse_summary: summary,
      total_credits: Math.round(totalCredits * 10000) / 10000,
      days_analyzed: days,
      recommendations,
    }
  } catch (e) {
    return {
      success: false,
      daily_usage: [],
      warehouse_summary: [],
      total_credits: 0,
      days_analyzed: days,
      recommendations: [],
      error: String(e),
    }
  }
}

export async function getExpensiveQueries(params: ExpensiveQueriesParams): Promise<ExpensiveQueriesResult> {
  const whType = getWhType(params.warehouse)
  const days = params.days ?? 7
  const limit = params.limit ?? 20

  const sql = buildExpensiveSql(whType, days, limit)
  if (!sql) {
    return {
      success: false,
      queries: [],
      query_count: 0,
      days_analyzed: days,
      error: `Expensive query analysis is not available for ${whType} warehouses.`,
    }
  }

  try {
    const connector = await Registry.get(params.warehouse)
    const result = await connector.execute(sql, limit)
    const queries = rowsToRecords(result)

    return {
      success: true,
      queries,
      query_count: queries.length,
      days_analyzed: days,
    }
  } catch (e) {
    return {
      success: false,
      queries: [],
      query_count: 0,
      days_analyzed: days,
      error: String(e),
    }
  }
}

// Exported for SQL template testing
export const SQL_TEMPLATES = {
  SNOWFLAKE_CREDIT_USAGE_SQL,
  SNOWFLAKE_CREDIT_SUMMARY_SQL,
  SNOWFLAKE_EXPENSIVE_SQL,
  BIGQUERY_CREDIT_USAGE_SQL,
  BIGQUERY_CREDIT_SUMMARY_SQL,
  BIGQUERY_EXPENSIVE_SQL,
  DATABRICKS_CREDIT_USAGE_SQL,
  DATABRICKS_CREDIT_SUMMARY_SQL,
  DATABRICKS_EXPENSIVE_SQL,
  buildCreditUsageSql,
  buildCreditSummarySql,
  buildExpensiveSql,
}
