// altimate_change - new file
/**
 * Databricks savings: measures usage facts per SQL warehouse, all-purpose cluster and job of
 * every workspace the connection's system tables show, and hands them to altimate-core, which
 * decides what qualifies and what that saves. The rules and prices live in core; this file only
 * measures.
 */

import * as core from "@altimateai/altimate-core"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Registry from "../connections/registry"
import { isQueryTimeoutError } from "@altimateai/drivers/types"
import type { QueryContext } from "../query-execution"
import { RunBudget } from "../../run-budget"
import { resolveFinopsWarehouse } from "./warehouse-resolver"
import type { DatabricksSavingsParams, DatabricksSavingsResult, DatabricksSavingsReport } from "../types"

const SUPPORTED_TYPES = ["databricks"] as const

/** Days of usage the facts cover; the rules price a day of this window. */
const LOOKBACK_DAYS = 7

const DAY_MS = 86_400_000

/** The window ends at 06:00 UTC, once the day before has been billed. */
const WINDOW_END_MS = 6 * 3_600_000

/** Rows read per query; a query that fills it says so in the result. */
const ROW_LIMIT = 10_000
// The whole check, connecting included, stops after this long; a query still running then is
// cancelled on the warehouse. Claude Code runs a plugin's process for ten minutes at most, so the
// check ends before it is killed.
export const SAVINGS_RUN_LIMIT_MS = 9 * 60_000

/** A SQL warehouse's id in a connection's HTTP path (`/sql/1.0/warehouses/<id>`, or the older `/sql/1.0/endpoints/<id>`). */
const WAREHOUSE_PATH = /\/(?:warehouses|endpoints)\/([0-9a-z]+)\/?$/i

/**
 * Per-warehouse usage over the seven days to 06:00 UTC on the parameter, for every warehouse of
 * every workspace the connection's system tables cover (as Altimate's pipeline reads them), each
 * row naming its workspace.
 * Billing that landed after the window's end is left out, so a past window gives the
 * same facts on every run. Billing is read as Altimate's opportunity pipeline reads it for
 * these checks: whole usage days inside the window, ingested before its end day, which is
 * the six full days before that day.
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
  QUALIFY ROW_NUMBER() OVER (PARTITION BY workspace_id, warehouse_id ORDER BY change_time DESC) = 1
),
ev AS (
  SELECT e.workspace_id, e.warehouse_id, e.event_type, e.event_time, e.cluster_count,
         unix_timestamp(LEAD(e.event_time) OVER (PARTITION BY e.workspace_id, e.warehouse_id ORDER BY e.event_time))
           - unix_timestamp(e.event_time) AS dur_sec
  FROM system.compute.warehouse_events e CROSS JOIN w
  -- As in Altimate's pipeline, uptime counts only the time between two events inside the window:
  -- a warehouse that runs all week without a scale or stop event reads no uptime.
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
SELECT inv.workspace_id, inv.warehouse_id, inv.warehouse_name, inv.warehouse_type, inv.warehouse_size,
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

/** List price of a usage row: the price in force when the usage started. */
const LIST_PRICE_JOIN = `LEFT JOIN system.billing.list_prices lp
    ON u.sku_name = lp.sku_name AND u.cloud = lp.cloud
   AND u.usage_start_time >= lp.price_start_time
   AND (lp.price_end_time IS NULL OR u.usage_start_time < lp.price_end_time)`

/**
 * Per all-purpose cluster (created from the UI or API, not deleted) of every workspace the
 * connection's system tables cover: worker node minutes, active days, idle worker minutes (CPU
 * under 5%, CPU wait under 5%, under 10 MB of network a minute), CPU averages, and the
 * all-purpose cost it billed (Databricks does not mark job runs on these billing rows, so their
 * time is included). Seven full days before the window end, the parameter.
 */
export const DATABRICKS_CLUSTER_FACTS_SQL = `
WITH p AS (
  SELECT CAST(? AS DATE) AS we_date
),
inv AS (
  SELECT workspace_id, cluster_id, cluster_name, auto_termination_minutes, cluster_source, delete_time
  FROM system.compute.clusters
  QUALIFY ROW_NUMBER() OVER (PARTITION BY workspace_id, cluster_id ORDER BY change_time DESC) = 1
),
nodes AS (
  SELECT n.workspace_id, n.cluster_id, n.start_time, n.end_time,
         COALESCE(n.cpu_user_percent, 0) + COALESCE(n.cpu_system_percent, 0)        AS cpu_active,
         COALESCE(n.cpu_wait_percent, 0)                                              AS cpu_wait,
         COALESCE(n.network_sent_bytes, 0) + COALESCE(n.network_received_bytes, 0)    AS network_bytes
  FROM system.compute.node_timeline n CROSS JOIN p
  WHERE n.start_time >= CAST(DATE_SUB(p.we_date, 7) AS TIMESTAMP) AND n.start_time < CAST(p.we_date AS TIMESTAMP)
    AND NOT COALESCE(n.driver, false)
    AND n.cluster_id IN (SELECT cluster_id FROM inv)
),
util AS (
  SELECT workspace_id, cluster_id,
         COUNT(DISTINCT CAST(start_time AS DATE))                                       AS active_util_days,
         SUM(timestampdiff(MINUTE, start_time, end_time))                              AS total_node_minutes,
         COUNT(*)                                                                      AS total_worker_minutes,
         COUNT_IF(cpu_active < 5.0 AND cpu_wait < 5.0 AND network_bytes < 10485760)    AS idle_node_minutes,
         AVG(cpu_active)                                                               AS avg_cpu_active_pct,
         MAX(cpu_active)                                                               AS peak_cpu_active_pct
  FROM nodes GROUP BY workspace_id, cluster_id
),
bill AS (
  SELECT u.workspace_id, u.usage_metadata.cluster_id AS cluster_id, SUM(u.usage_quantity * lp.pricing.default) AS total_cost
  FROM system.billing.usage u CROSS JOIN p
  ${LIST_PRICE_JOIN}
  WHERE u.billing_origin_product = 'ALL_PURPOSE'
    AND u.usage_metadata.cluster_id IS NOT NULL
    AND u.usage_date >= DATE_SUB(p.we_date, 7) AND u.usage_date < p.we_date
  GROUP BY u.workspace_id, u.usage_metadata.cluster_id
)
SELECT inv.workspace_id, inv.cluster_id, inv.cluster_name, inv.auto_termination_minutes,
       util.total_node_minutes, util.active_util_days, util.total_worker_minutes, util.idle_node_minutes,
       util.avg_cpu_active_pct, util.peak_cpu_active_pct,
       COALESCE(bill.total_cost, 0.0) AS total_cost
FROM inv
JOIN util ON util.workspace_id = inv.workspace_id AND util.cluster_id = inv.cluster_id
LEFT JOIN bill ON bill.workspace_id = inv.workspace_id AND bill.cluster_id = inv.cluster_id
WHERE inv.delete_time IS NULL AND inv.cluster_source IN ('UI', 'API')
ORDER BY COALESCE(bill.total_cost, 0.0) DESC, inv.cluster_name
`

/**
 * Per job task of every workspace the connection's system tables cover that ran on an all-purpose
 * cluster (created from the UI or API, not deleted) in the window, one row per job, task, cluster
 * and trigger: its runs and hours, what started them, and the cluster's own all-purpose billing and
 * the workspace's jobs-compute rate to price them. The task timeline names the compute a run used
 * (billing does not name the job on all-purpose compute). It splits a run into contiguous rows cut
 * at each hour, so a run's hours are the sum of its rows, credited to the cluster it spent most of
 * them on. Deleted jobs are left out. Job ids repeat across workspaces, so every key pairs the
 * workspace with the id. Seven full days before the window end, the parameter.
 */
export const DATABRICKS_JOB_FACTS_SQL = `
WITH p AS (
  SELECT CAST(? AS DATE) AS we_date
),
clusters AS (
  SELECT workspace_id, cluster_id, cluster_name FROM (
    SELECT workspace_id, cluster_id, cluster_name, cluster_source, delete_time
    FROM system.compute.clusters
    QUALIFY ROW_NUMBER() OVER (PARTITION BY workspace_id, cluster_id ORDER BY change_time DESC) = 1
  )
  WHERE delete_time IS NULL AND cluster_source IN ('UI', 'API')
),
timeline AS (
  SELECT t.workspace_id, t.job_id, COALESCE(NULLIF(TRIM(t.task_key), ''), '(no task key)') AS task_key,
         COALESCE(NULLIF(t.job_run_id, ''), t.run_id) AS job_run_id,
         t.run_id, t.period_start_time, t.period_end_time, explode(t.compute_ids) AS compute_id
  FROM system.lakeflow.job_task_run_timeline t CROSS JOIN p
  WHERE t.period_start_time >= CAST(DATE_SUB(p.we_date, 7) AS TIMESTAMP) AND t.period_start_time < CAST(p.we_date AS TIMESTAMP)
    AND t.job_id IS NOT NULL AND t.job_id <> ''
),
timeline_row AS (
  SELECT tl.workspace_id, tl.job_id, tl.task_key, tl.job_run_id, tl.run_id, tl.period_start_time,
         MIN(c.cluster_id) AS cluster_id,
         MAX(timestampdiff(SECOND, tl.period_start_time, tl.period_end_time)) AS seconds
  FROM timeline tl
  JOIN clusters c ON c.workspace_id = tl.workspace_id AND c.cluster_id = tl.compute_id
  GROUP BY tl.workspace_id, tl.job_id, tl.task_key, tl.job_run_id, tl.run_id, tl.period_start_time
),
run_on_cluster AS (
  SELECT workspace_id, job_id, task_key, job_run_id, cluster_id, SUM(seconds) AS seconds
  FROM timeline_row
  GROUP BY workspace_id, job_id, task_key, job_run_id, cluster_id
),
task_run AS (
  SELECT workspace_id, job_id, task_key, job_run_id,
         MIN_BY(cluster_id, struct(-seconds, cluster_id)) AS cluster_id,
         SUM(seconds) / 3600.0 AS hours
  FROM run_on_cluster
  GROUP BY workspace_id, job_id, task_key, job_run_id
),
run_trigger AS (
  SELECT r.workspace_id, r.run_id, MAX(r.trigger_type) AS trigger_type
  FROM system.lakeflow.job_run_timeline r CROSS JOIN p
  WHERE r.period_start_time >= CAST(DATE_SUB(p.we_date, 7) AS TIMESTAMP) AND r.period_start_time < CAST(p.we_date AS TIMESTAMP)
  GROUP BY r.workspace_id, r.run_id
),
task AS (
  SELECT tr.workspace_id, tr.job_id, tr.task_key, tr.cluster_id, rt.trigger_type,
         COUNT(*) AS task_runs, SUM(tr.hours) AS task_hours
  FROM task_run tr
  LEFT JOIN run_trigger rt ON rt.workspace_id = tr.workspace_id AND rt.run_id = tr.job_run_id
  GROUP BY tr.workspace_id, tr.job_id, tr.task_key, tr.cluster_id, rt.trigger_type
),
bill AS (
  SELECT u.workspace_id, u.usage_metadata.cluster_id AS cluster_id, u.billing_origin_product AS product,
         u.usage_start_time, u.usage_end_time, u.usage_quantity AS dbus, u.usage_quantity * lp.pricing.default AS cost
  FROM system.billing.usage u CROSS JOIN p
  ${LIST_PRICE_JOIN}
  WHERE u.billing_origin_product IN ('ALL_PURPOSE', 'JOBS')
    AND u.usage_date >= DATE_SUB(p.we_date, 7) AND u.usage_date < p.we_date
),
billed_period AS (
  SELECT workspace_id, cluster_id, usage_start_time, usage_end_time,
         SUM(COALESCE(cost, 0)) AS cost, SUM(dbus) AS dbus,
         timestampdiff(SECOND, usage_start_time, usage_end_time) AS seconds
  FROM bill WHERE product = 'ALL_PURPOSE' AND cluster_id IS NOT NULL
  GROUP BY workspace_id, cluster_id, usage_start_time, usage_end_time
),
cluster_bill AS (
  SELECT workspace_id, cluster_id, SUM(cost) AS cost, SUM(dbus) AS dbus, SUM(seconds) / 3600.0 AS billed_hours
  FROM billed_period GROUP BY workspace_id, cluster_id
),
jobs_rate AS (
  SELECT workspace_id, CASE WHEN SUM(dbus) > 0 THEN SUM(COALESCE(cost, 0)) / SUM(dbus) END AS rate
  FROM bill WHERE product = 'JOBS' GROUP BY workspace_id
),
inv AS (
  SELECT workspace_id, job_id, name, delete_time FROM system.lakeflow.jobs
  QUALIFY ROW_NUMBER() OVER (PARTITION BY workspace_id, job_id ORDER BY change_time DESC) = 1
)
SELECT t.workspace_id, t.job_id, COALESCE(NULLIF(TRIM(inv.name), ''), 'job ' || t.job_id) AS job_name,
       t.task_key, t.trigger_type, t.cluster_id AS host_cluster_id,
       COALESCE(NULLIF(TRIM(c.cluster_name), ''), t.cluster_id) AS host_cluster_name,
       t.task_runs, t.task_hours,
       COALESCE(cb.cost, 0) AS host_cluster_cost,
       COALESCE(cb.dbus, 0) AS host_cluster_dbus,
       COALESCE(cb.billed_hours, 0) AS host_cluster_billed_hours,
       jr.rate AS jobs_rate_per_dbu
FROM task t
JOIN clusters c ON c.workspace_id = t.workspace_id AND c.cluster_id = t.cluster_id
LEFT JOIN inv ON inv.workspace_id = t.workspace_id AND inv.job_id = t.job_id
LEFT JOIN cluster_bill cb ON cb.workspace_id = t.workspace_id AND cb.cluster_id = t.cluster_id
LEFT JOIN jobs_rate jr ON jr.workspace_id = t.workspace_id
WHERE inv.delete_time IS NULL
ORDER BY t.task_hours DESC, t.workspace_id, t.job_id, t.task_key, t.cluster_id, t.trigger_type
`

/** Core's rules: a `DatabricksSavingsInput` as JSON in, the report out. */
export type RulesEngine = (input: string) => DatabricksSavingsReport

type CoreModule = { databricksSavings?: unknown; initSdk?: (...args: [string, string, string, boolean, boolean]) => void }

/**
 * The installed core's rules, or null when its binary predates them. In assessment mode core's own
 * usage event is switched off first: core reads its telemetry opt-out variables or `initSdk`, not
 * assessment mode, and a variable set from here does not reach it. `initSdk` only stores the setting.
 */
export function rulesEngine(lib: CoreModule = core as unknown as CoreModule): RulesEngine | null {
  const found = lib.databricksSavings
  if (typeof found !== "function") return null
  if (Flag.ALTIMATE_ASSESSMENT_MODE) lib.initSdk?.("", "", "", false, false)
  return found as RulesEngine
}

/** The seven-day window the facts cover: it ends at 06:00 UTC on `end`, the latest one that has passed. */
export function savingsWindow(nowMs: number): { start: string; end: string } {
  const today = Math.floor((nowMs - WINDOW_END_MS) / DAY_MS) * DAY_MS
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
    workspace_id: row.workspace_id == null ? null : String(row.workspace_id),
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

/** One cluster row as the facts core reads. */
export function toClusterFacts(row: Record<string, unknown>) {
  const id = String(row.cluster_id ?? "")
  const autoTermination = row.auto_termination_minutes
  return {
    cluster_id: id,
    workspace_id: row.workspace_id == null ? null : String(row.workspace_id),
    cluster_name: String(row.cluster_name ?? id),
    auto_termination_minutes: autoTermination == null ? null : Math.max(0, Math.round(num(autoTermination))),
    total_node_minutes: num(row.total_node_minutes),
    active_util_days: Math.round(num(row.active_util_days)),
    total_worker_minutes: num(row.total_worker_minutes),
    idle_node_minutes: num(row.idle_node_minutes),
    avg_cpu_active_pct: num(row.avg_cpu_active_pct),
    peak_cpu_active_pct: num(row.peak_cpu_active_pct),
    total_cost: num(row.total_cost),
  }
}

/** One job task row as the facts core reads. */
export function toJobFacts(row: Record<string, unknown>) {
  const id = String(row.job_id ?? "")
  const cluster = String(row.host_cluster_id ?? "")
  const rate = row.jobs_rate_per_dbu
  return {
    job_id: id,
    workspace_id: row.workspace_id == null ? null : String(row.workspace_id),
    job_name: String(row.job_name ?? `job ${id}`),
    task_key: String(row.task_key ?? ""),
    trigger_type: row.trigger_type == null ? null : String(row.trigger_type),
    host_cluster_id: cluster,
    host_cluster_name: String(row.host_cluster_name || cluster),
    task_runs: Math.round(num(row.task_runs)),
    task_hours: num(row.task_hours),
    host_cluster_cost: num(row.host_cluster_cost),
    host_cluster_dbus: num(row.host_cluster_dbus),
    host_cluster_billed_hours: num(row.host_cluster_billed_hours),
    jobs_rate_per_dbu: rate == null ? null : num(rate),
  }
}

function records(result: { columns: string[]; rows: unknown[][] }): Record<string, unknown>[] {
  return result.rows.map((row) => Object.fromEntries(result.columns.map((name, at) => [name, row[at]])))
}

/** With no connection named: the first Databricks connection that runs through a SQL warehouse, if any. */
function preferredConnection(): string | undefined {
  return Registry.list().warehouses.find((one) => {
    if (one.type.toLowerCase() !== "databricks") return false
    const config = Registry.getConfig(one.name) as Record<string, unknown> | undefined
    return WAREHOUSE_PATH.test(String(config?.http_path ?? config?.httpPath ?? ""))
  })?.name
}

/** `rules` defaults to the installed core's; tests pass their own. */
export async function databricksSavings(
  params: DatabricksSavingsParams,
  rules: RulesEngine | null = rulesEngine(),
  context?: QueryContext,
): Promise<DatabricksSavingsResult> {
  const window = savingsWindow(params.now_ms ?? Date.now())
  const failed = (error: string): DatabricksSavingsResult => ({ success: false, window, error })

  const resolved = resolveFinopsWarehouse({
    requested: params.warehouse?.trim() || preferredConnection(),
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
        "Its http_path must name one (/sql/1.0/warehouses/<id>): the check's queries run on that warehouse.",
    )
  }

  if (!rules) {
    return failed("This altimate-code build's altimate-core has no Databricks savings rules. Update altimate-code, then try again.")
  }

  // Stopping the session cancels the running query and starts no other. The check stops at its own
  // limit, or earlier at the session's query cutoff (`altimate run --time-budget`).
  const signal = context?.signal
  const ownLimitAt = Date.now() + SAVINGS_RUN_LIMIT_MS
  const sessionCutoff = context?.sessionID ? RunBudget.queryDeadline(context.sessionID) : undefined
  const stopsAt = Math.min(ownLimitAt, sessionCutoff ?? Infinity)
  const limitName = stopsAt < ownLimitAt ? "the run's time budget" : "the check's 9-minute limit"

  // Connecting can wait on a stopped warehouse: it counts toward the limit and yields to a stop.
  const beforeStop = async <T>(work: Promise<T>, what: string): Promise<T> => {
    signal?.throwIfAborted()
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${what} took longer than ${limitName}.`)), Math.max(0, stopsAt - Date.now()))
        }),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(signal!.reason)
          signal?.addEventListener("abort", onAbort, { once: true })
        }),
      ])
    } finally {
      clearTimeout(timer)
      if (onAbort) signal?.removeEventListener("abort", onAbort)
      work.catch(() => {})
    }
  }

  try {
    const connector = await beforeStop(Registry.get(resolved.warehouse), "Connecting to the warehouse")
    const binds = [window.end]
    // A query that fills the row limit reads only its first rows; the result names it.
    const limited: string[] = []
    const read = async (what: string, sql: string, rows = what) => {
      signal?.throwIfAborted()
      const left = stopsAt - Date.now()
      if (left <= 0) throw new Error(`The ${what} query was not started: it would run past ${limitName}.`)
      try {
        const result = await connector.execute(sql, ROW_LIMIT, binds, { cancelAfterMs: left, signal })
        if (result.truncated) limited.push(rows)
        return records(result)
      } catch (e) {
        if (!isQueryTimeoutError(e)) throw e
        const outcome = (e as { cancelled?: boolean }).cancelled
          ? "and was cancelled on the warehouse"
          : "and may still be running on the warehouse"
        throw new Error(`The ${what} query ran past ${limitName} ${outcome}.`)
      }
    }
    const warehouses = await read("SQL warehouses", DATABRICKS_WAREHOUSE_FACTS_SQL)
    if (warehouses.length === 0) {
      return failed(`No SQL warehouses were found for warehouse ${runsOn} in system.compute.warehouses.`)
    }
    // A table the connection may not read stops only its own check; the rest still report.
    const skipped: { check: string; reason: string }[] = []
    const optional = async (check: string, what: string, sql: string, rows = what) => {
      try {
        return await read(what, sql, rows)
      } catch (e) {
        if (signal?.aborted) throw e
        skipped.push({ check, reason: (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 300) })
        return []
      }
    }
    const clusters = await optional("Idle Cluster Detection", "all-purpose clusters", DATABRICKS_CLUSTER_FACTS_SQL)
    const jobs = await optional("Job Running on All-Purpose Compute", "jobs", DATABRICKS_JOB_FACTS_SQL, "job task rows")
    const input = {
      lookback_days: LOOKBACK_DAYS,
      warehouses: warehouses.map(toFacts),
      clusters: clusters.map(toClusterFacts),
      jobs: jobs.map(toJobFacts),
    }
    let report: DatabricksSavingsReport
    try {
      report = rules(JSON.stringify(input))
    } catch (e) {
      // Core refuses the whole input over one bad value. If the warehouses alone pass, the
      // cluster and job checks are named as skipped instead of losing every finding.
      if (input.clusters.length === 0 && input.jobs.length === 0) throw e
      report = rules(JSON.stringify({ ...input, clusters: [], jobs: [] }))
      const reason = `core refused their facts: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 240)}`
      if (input.clusters.length > 0) skipped.push({ check: "Idle Cluster Detection", reason })
      if (input.jobs.length > 0) skipped.push({ check: "Job Running on All-Purpose Compute", reason })
      clusters.length = 0
      jobs.length = 0
    }
    // Every workspace a checked row came from, whether or not it has a finding or a SQL warehouse.
    const workspaces = new Set(
      [...warehouses, ...clusters, ...jobs]
        .map((row) => (row.workspace_id == null ? "" : String(row.workspace_id).trim()))
        .filter((id) => id !== ""),
    )
    return {
      success: true,
      window,
      warehouse: resolved.warehouse,
      ran_on: runsOn,
      workspaces_checked: workspaces.size,
      warehouses_checked: warehouses.length,
      clusters_checked: clusters.length,
      // The query gives a row per task, cluster and trigger: each job is counted once.
      jobs_checked: new Set(jobs.map((row) => `${row.workspace_id ?? ""}/${row.job_id}`)).size,
      skipped,
      limited,
      // What each warehouse is and costs now, so a later run can tell what changed.
      warehouses: warehouses.map((row) => ({
        id: String(row.warehouse_id ?? ""),
        workspace_id: row.workspace_id == null ? null : String(row.workspace_id),
        name: String(row.warehouse_name ?? row.warehouse_id ?? ""),
        type: String(row.warehouse_type ?? ""),
        size: row.warehouse_size == null ? null : String(row.warehouse_size),
        window_cost: num(row.total_cost),
      })),
      report,
    }
  } catch (e) {
    return failed(e instanceof Error ? e.message : String(e))
  }
}
