// altimate_change - new file
/**
 * Databricks SQL warehouse savings: measures one row of usage facts per SQL warehouse of
 * the connection's workspace from Databricks system tables, and hands them to
 * altimate-core, which decides which warehouses qualify and what that saves. The rules
 * and prices live in core; this file only measures.
 */

import * as core from "@altimateai/altimate-core"
import * as Registry from "../connections/registry"
import { resolveFinopsWarehouse } from "./warehouse-resolver"
import type { DatabricksSavingsParams, DatabricksSavingsResult, DatabricksSavingsReport } from "../types"

const SUPPORTED_TYPES = ["databricks"] as const

/** Days of usage the facts cover; the rules price a day of this window. */
const LOOKBACK_DAYS = 7

const DAY_MS = 86_400_000

/** A SQL warehouse's id in a connection's HTTP path (`/sql/1.0/warehouses/<id>`). */
const WAREHOUSE_PATH = /\/warehouses\/([0-9a-z]+)\/?$/i

/**
 * Per-warehouse usage over the seven days to 06:00 UTC on the first parameter, for every
 * warehouse in the workspace of the warehouse named by the second. System tables hold
 * every workspace of the account, so each input is cut to that workspace's warehouses.
 * Billing that landed after the window's end is left out, so a past window gives the
 * same facts on every run.
 */
export const DATABRICKS_WAREHOUSE_FACTS_SQL = `
WITH p AS (
  SELECT CAST(? AS DATE) AS we_date
),
w AS (
  SELECT we_date,
         CAST(we_date AS TIMESTAMP) + INTERVAL 6 HOURS                   AS r,
         CAST(we_date AS TIMESTAMP) + INTERVAL 6 HOURS - INTERVAL 7 DAYS AS rs
  FROM p
),
inv AS (
  SELECT workspace_id, warehouse_id, warehouse_name, warehouse_type, warehouse_size, delete_time
  FROM system.compute.warehouses
  WHERE workspace_id = (SELECT MAX(workspace_id) FROM system.compute.warehouses WHERE warehouse_id = ?)
  QUALIFY ROW_NUMBER() OVER (PARTITION BY workspace_id, warehouse_id ORDER BY change_time DESC) = 1
),
ev AS (
  SELECT e.workspace_id, e.warehouse_id, e.event_type, e.event_time, e.cluster_count,
         unix_timestamp(LEAD(e.event_time) OVER (PARTITION BY e.workspace_id, e.warehouse_id ORDER BY e.event_time))
           - unix_timestamp(e.event_time) AS dur_sec
  FROM system.compute.warehouse_events e CROSS JOIN w
  WHERE e.event_time >= w.rs AND e.event_time < w.r
    AND e.workspace_id IN (SELECT workspace_id FROM inv) AND e.warehouse_id IN (SELECT warehouse_id FROM inv)
),
up AS (
  SELECT workspace_id, warehouse_id,
         SUM(CASE WHEN cluster_count > 0 AND dur_sec IS NOT NULL THEN dur_sec ELSE 0 END)                 AS wall_clock_uptime_sec,
         SUM(CASE WHEN cluster_count > 0 AND dur_sec IS NOT NULL THEN cluster_count * dur_sec ELSE 0 END) AS cluster_weighted_uptime_sec
  FROM ev GROUP BY workspace_id, warehouse_id
),
q AS (
  SELECT h.workspace_id, h.compute.warehouse_id AS warehouse_id,
         h.execution_duration_ms, h.total_task_duration_ms,
         h.waiting_at_capacity_duration_ms, h.spilled_local_bytes,
         (h.execution_status = 'FINISHED'
          AND (h.from_result_cache IS NULL OR h.from_result_cache = false)
          AND COALESCE(h.statement_type, '') NOT IN ('SET', 'USE', 'SHOW', 'DESCRIBE', 'ALTER', 'DROP')
          AND COALESCE(h.execution_duration_ms, 0) > 0) AS is_compute_query
  FROM system.query.history h CROSS JOIN w
  WHERE h.start_time >= w.rs AND h.start_time < w.r AND h.compute.warehouse_id IS NOT NULL
    AND h.workspace_id IN (SELECT workspace_id FROM inv) AND h.compute.warehouse_id IN (SELECT warehouse_id FROM inv)
),
aq AS (
  SELECT workspace_id, warehouse_id,
         COUNT(*)                                                   AS total_query_count,
         SUM(COALESCE(execution_duration_ms, 0)) / 1000.0           AS active_query_sec,
         COUNT_IF(is_compute_query)                                 AS compute_query_count,
         COUNT_IF(is_compute_query AND COALESCE(spilled_local_bytes, 0) = 0)            AS no_spill_query_count,
         COUNT_IF(is_compute_query AND COALESCE(waiting_at_capacity_duration_ms, 0) = 0) AS no_queue_query_count,
         COUNT_IF(is_compute_query AND execution_duration_ms > 0 AND total_task_duration_ms > 0) AS parallelism_query_count,
         MAX(CASE WHEN is_compute_query AND execution_duration_ms > 0 AND total_task_duration_ms > 0
                  THEN total_task_duration_ms * 1.0 / execution_duration_ms END)                AS parallelism_ratio_max,
         try_element_at(sort_array(collect_list(CASE WHEN is_compute_query AND execution_duration_ms > 0 AND total_task_duration_ms > 0
                                                  THEN total_task_duration_ms * 1.0 / execution_duration_ms END)),
                    CAST(FLOOR(COUNT_IF(is_compute_query AND execution_duration_ms > 0 AND total_task_duration_ms > 0) * 0.99) AS INT) + 1)
                                                                    AS parallelism_ratio_p99,
         try_element_at(sort_array(collect_list(CASE WHEN is_compute_query AND execution_duration_ms > 0 AND total_task_duration_ms > 0
                                                  THEN total_task_duration_ms * 1.0 / execution_duration_ms END)),
                    CAST(FLOOR(COUNT_IF(is_compute_query AND execution_duration_ms > 0 AND total_task_duration_ms > 0) * 0.5) AS INT) + 1)
                                                                    AS parallelism_ratio_p50
  FROM q GROUP BY workspace_id, warehouse_id
),
bill_rows AS (
  SELECT u.workspace_id, u.usage_metadata.warehouse_id AS warehouse_id, u.sku_name, u.usage_quantity,
         lp.pricing.default AS price, u.usage_quantity * lp.pricing.default AS cost
  FROM system.billing.usage u
  CROSS JOIN w
  LEFT JOIN system.billing.list_prices lp
    ON u.sku_name = lp.sku_name AND u.cloud = lp.cloud
   AND u.usage_start_time >= lp.price_start_time
   AND (lp.price_end_time IS NULL OR u.usage_start_time < lp.price_end_time)
  WHERE u.billing_origin_product = 'SQL'
    AND u.usage_metadata.warehouse_id IS NOT NULL
    AND u.workspace_id IN (SELECT workspace_id FROM inv) AND u.usage_metadata.warehouse_id IN (SELECT warehouse_id FROM inv)
    AND CAST(u.usage_date AS TIMESTAMP) >= w.rs
    AND CAST(u.usage_date AS TIMESTAMP) <= w.r
    AND u.ingestion_date < w.we_date
),
bill AS (
  SELECT workspace_id, warehouse_id, SUM(usage_quantity) AS total_dbu_consumed, SUM(COALESCE(cost, 0)) AS total_cost
  FROM bill_rows GROUP BY workspace_id, warehouse_id
),
type_prices AS (
  SELECT MAX(CASE WHEN sku_name LIKE '%SERVERLESS_SQL_COMPUTE%' THEN price END) AS serverless_price_per_dbu
  FROM bill_rows
)
SELECT inv.warehouse_id, inv.warehouse_name, inv.warehouse_type, inv.warehouse_size,
       COALESCE(up.wall_clock_uptime_sec, 0.0)          AS wall_clock_uptime_sec,
       COALESCE(up.cluster_weighted_uptime_sec, 0.0)    AS cluster_weighted_uptime_sec,
       CASE WHEN COALESCE(up.wall_clock_uptime_sec, 0) <= 0 THEN 0.0
            ELSE GREATEST(0.0, LEAST(1.0, 1.0 - COALESCE(aq.active_query_sec, 0) / up.wall_clock_uptime_sec)) END AS idle_ratio,
       COALESCE(bill.total_dbu_consumed, 0.0)           AS total_dbu_consumed,
       COALESCE(bill.total_cost, 0.0)                   AS total_cost,
       CASE WHEN bill.total_dbu_consumed > 0 THEN bill.total_cost / bill.total_dbu_consumed ELSE 0.0 END AS price_per_dbu,
       tp.serverless_price_per_dbu,
       COALESCE(aq.total_query_count, 0)                AS total_query_count,
       COALESCE(aq.parallelism_query_count, 0)          AS parallelism_query_count,
       COALESCE(aq.parallelism_ratio_p50, 0.0)          AS parallelism_ratio_p50,
       COALESCE(aq.parallelism_ratio_p99, 0.0)          AS parallelism_ratio_p99,
       COALESCE(aq.parallelism_ratio_max, 0.0)          AS parallelism_ratio_max,
       CASE WHEN aq.compute_query_count > 0 THEN aq.no_spill_query_count * 1.0 / aq.compute_query_count ELSE 1.0 END AS no_spill_query_pct,
       CASE WHEN aq.compute_query_count > 0 THEN aq.no_queue_query_count * 1.0 / aq.compute_query_count ELSE 1.0 END AS no_queue_query_pct
FROM inv
LEFT JOIN up   ON up.workspace_id = inv.workspace_id AND up.warehouse_id = inv.warehouse_id
LEFT JOIN aq   ON aq.workspace_id = inv.workspace_id AND aq.warehouse_id = inv.warehouse_id
LEFT JOIN bill ON bill.workspace_id = inv.workspace_id AND bill.warehouse_id = inv.warehouse_id
CROSS JOIN type_prices tp
WHERE inv.delete_time IS NULL
ORDER BY inv.warehouse_name
`

type RulesEngine = (input: string) => DatabricksSavingsReport

/** The installed core's rules, or null when its binary predates them. */
function rulesEngine(): RulesEngine | null {
  const found = (core as unknown as { databricksWarehouseSavings?: unknown }).databricksWarehouseSavings
  return typeof found === "function" ? (found as RulesEngine) : null
}

/** The seven-day window the facts cover: it ends at 06:00 UTC on `end`, today's UTC date. */
export function savingsWindow(nowMs: number): { start: string; end: string } {
  const today = Math.floor(nowMs / DAY_MS) * DAY_MS
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  return { start: day(today - LOOKBACK_DAYS * DAY_MS), end: day(today) }
}

function num(value: unknown): number {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

/** One returned row as the facts core reads; database types are coerced here, not in core. */
export function toFacts(row: Record<string, unknown>) {
  const id = String(row.warehouse_id ?? "")
  const serverless = row.serverless_price_per_dbu
  return {
    warehouse_id: id,
    warehouse_name: String(row.warehouse_name ?? id),
    warehouse_type: String(row.warehouse_type ?? ""),
    warehouse_size: row.warehouse_size == null ? null : String(row.warehouse_size),
    wall_clock_uptime_sec: num(row.wall_clock_uptime_sec),
    cluster_weighted_uptime_sec: num(row.cluster_weighted_uptime_sec),
    idle_ratio: num(row.idle_ratio),
    total_dbu_consumed: num(row.total_dbu_consumed),
    total_cost: num(row.total_cost),
    price_per_dbu: num(row.price_per_dbu),
    serverless_price_per_dbu: serverless == null ? null : num(serverless),
    total_query_count: Math.round(num(row.total_query_count)),
    parallelism_query_count: Math.round(num(row.parallelism_query_count)),
    parallelism_ratio_p50: num(row.parallelism_ratio_p50),
    parallelism_ratio_p99: num(row.parallelism_ratio_p99),
    parallelism_ratio_max: num(row.parallelism_ratio_max),
    no_spill_query_pct: num(row.no_spill_query_pct),
    no_queue_query_pct: num(row.no_queue_query_pct),
  }
}

export async function databricksSavings(params: DatabricksSavingsParams): Promise<DatabricksSavingsResult> {
  const window = savingsWindow(params.now_ms ?? Date.now())
  const failed = (error: string): DatabricksSavingsResult => ({ success: false, window, error })

  const resolved = resolveFinopsWarehouse({
    requested: params.warehouse,
    supportedTypes: SUPPORTED_TYPES,
    operationName: "The Databricks savings check",
  })
  if (resolved.kind === "error") return failed(resolved.error)

  const config = Registry.getConfig(resolved.warehouse) as Record<string, unknown> | undefined
  const path = String(config?.http_path ?? config?.httpPath ?? "")
  const runsOn = WAREHOUSE_PATH.exec(path)?.[1]
  if (!runsOn) {
    return failed(
      `Connection ${JSON.stringify(resolved.warehouse)} does not go through a SQL warehouse. ` +
        "Its http_path must name one (/sql/1.0/warehouses/<id>): the check reads that warehouse's workspace.",
    )
  }

  const rules = rulesEngine()
  if (!rules) {
    return failed("This altimate-code build's altimate-core has no Databricks savings rules. Update altimate-code, then try again.")
  }

  try {
    const connector = await Registry.get(resolved.warehouse)
    const result = await connector.execute(DATABRICKS_WAREHOUSE_FACTS_SQL, 10_000, [window.end, runsOn])
    const rows = result.rows.map((row) => Object.fromEntries(result.columns.map((name, at) => [name, row[at]])))
    if (rows.length === 0) {
      return failed(`No SQL warehouses were found for warehouse ${runsOn} in system.compute.warehouses.`)
    }
    const report = rules(JSON.stringify({ lookback_days: LOOKBACK_DAYS, warehouses: rows.map(toFacts) }))
    return { success: true, window, warehouse: resolved.warehouse, ran_on: runsOn, warehouses_checked: rows.length, report }
  } catch (e) {
    return failed(e instanceof Error ? e.message : String(e))
  }
}
