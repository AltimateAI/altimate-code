// altimate_change - new file
/**
 * Snowflake savings: measures usage facts per warehouse from `SHOW WAREHOUSES` and
 * `SNOWFLAKE.ACCOUNT_USAGE`, and hands them to altimate-core, which decides what qualifies and what
 * that saves. The rules live in core; this file only measures.
 *
 * Days are UTC. Every window ends at 00:00 UTC on the window's end date, and a run happens at least
 * six hours after that, past the latency of each view read here: WAREHOUSE_METERING_HISTORY (three
 * hours, six for cloud services credits), WAREHOUSE_EVENTS_HISTORY (three) and QUERY_HISTORY (45
 * minutes).
 */

import * as core from "@altimateai/altimate-core"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Registry from "../connections/registry"
import { silenceWith, type CoreTelemetrySwitch } from "../core-telemetry"
import type { QueryContext } from "../query-execution"
import { savingsWindow } from "./databricks-savings"
import { reasonOf, SavingsLimitError, savingsRun } from "./savings-run"
import { resolveFinopsWarehouse } from "./warehouse-resolver"
import type { SnowflakeSavingsParams, SnowflakeSavingsReport, SnowflakeSavingsResult } from "../types"

const SUPPORTED_TYPES = ["snowflake"] as const

/** Days of usage the facts cover; the rules price a day of this window. */
const LOOKBACK_DAYS = 7

/** Rows read per query; a query that fills it says so in the result. */
export const ROW_LIMIT = 100_000

/** The driver asks for one row more than its limit, and `SHOW` accepts a `LIMIT` of at most 10,000. */
export const SHOW_ROW_LIMIT = 9_999

/** Dollars per credit when the account's rate sheet cannot be read: Enterprise list price. */
export const LIST_PRICE_PER_CREDIT = 3

export { SAVINGS_RUN_LIMIT_MS } from "./savings-run"

/** The end of the window as a timestamp for filtering `ACCOUNT_USAGE`, and as UTC wall-clock time. */
const WINDOW_END = `TO_TIMESTAMP_TZ(? || ' 00:00:00 +0000', 'YYYY-MM-DD HH24:MI:SS TZHTZM')`
const WINDOW_END_UTC = `TO_TIMESTAMP_NTZ(?, 'YYYY-MM-DD')`

export const SNOWFLAKE_WAREHOUSES_SQL = `SHOW WAREHOUSES`

/**
 * Credits per warehouse by UTC day (`usage_day`), and by the 24 hours from 23:00 UTC the day before
 * (`idle_day`), the window the idle check reads. Every fact query also returns `first_start`, its rows'
 * earliest start in epoch seconds (UTC), which tells a recreated warehouse's usage from its predecessor's.
 */
export const SNOWFLAKE_METERING_FACTS_SQL = `
WITH m AS (
  SELECT WAREHOUSE_ID AS warehouse_id, WAREHOUSE_NAME AS warehouse_name,
         TO_TIMESTAMP_NTZ(CONVERT_TIMEZONE('UTC', START_TIME)) AS hour_start, CREDITS_USED AS credits_used
  FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
  WHERE START_TIME >= DATEADD(hour, -169, ${WINDOW_END}) AND START_TIME < ${WINDOW_END} AND WAREHOUSE_ID > 0
)
SELECT warehouse_id, warehouse_name,
       IFF(hour_start >= DATEADD(day, -7, ${WINDOW_END_UTC}), TO_VARCHAR(hour_start::DATE, 'YYYY-MM-DD'), NULL) AS usage_day,
       IFF(hour_start < DATEADD(hour, -1, ${WINDOW_END_UTC}), TO_VARCHAR(DATEADD(hour, 1, hour_start)::DATE, 'YYYY-MM-DD'), NULL) AS idle_day,
       SUM(credits_used) AS credits_used, DATE_PART(epoch_second, MIN(hour_start)) AS first_start
FROM m GROUP BY 1, 2, 3, 4 ORDER BY 2, 3, 4
`

/**
 * Per warehouse, cluster and day: the periods from each cluster's resume to its next event that ran at
 * least one query, their seconds, and the seconds with no query running. Overlapping queries count as
 * one stretch of work. Seconds are `DATEDIFF('second', ...)`, which counts second boundaries crossed:
 * this is how the idle times stored by Altimate's hosted product are counted.
 */
export const SNOWFLAKE_PERIOD_FACTS_SQL = `
WITH ev AS (
  SELECT WAREHOUSE_ID AS warehouse_id, WAREHOUSE_NAME AS warehouse_name, CLUSTER_NUMBER AS cluster_number,
         TO_TIMESTAMP_NTZ(CONVERT_TIMEZONE('UTC', TIMESTAMP)) AS ts, EVENT_NAME AS event_name
  FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_EVENTS_HISTORY
  WHERE TIMESTAMP >= DATEADD(day, -9, ${WINDOW_END}) AND TIMESTAMP < DATEADD(day, 1, ${WINDOW_END})
    AND EVENT_NAME IN ('RESUME_CLUSTER', 'SUSPEND_CLUSTER') AND EVENT_STATE = 'STARTED'
),
status AS (
  SELECT warehouse_id, warehouse_name, cluster_number, ts AS valid_from, event_name,
         LEAD(ts) OVER (PARTITION BY warehouse_id, cluster_number ORDER BY ts) AS valid_to
  FROM ev
),
periods AS (
  SELECT warehouse_id, warehouse_name, cluster_number, valid_from, valid_to
  FROM status
  WHERE event_name = 'RESUME_CLUSTER' AND valid_to IS NOT NULL
    AND DATEDIFF('millisecond', valid_from, valid_to) >= 1000
    AND valid_from >= DATEADD(hour, -169, ${WINDOW_END_UTC}) AND valid_from < ${WINDOW_END_UTC}
),
q AS (
  SELECT WAREHOUSE_ID AS warehouse_id, CLUSTER_NUMBER AS cluster_number,
         TO_TIMESTAMP_NTZ(CONVERT_TIMEZONE('UTC', START_TIME)) AS st,
         TO_TIMESTAMP_NTZ(CONVERT_TIMEZONE('UTC', END_TIME)) AS et
  FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
  WHERE START_TIME >= DATEADD(day, -10, ${WINDOW_END}) AND START_TIME < DATEADD(day, 1, ${WINDOW_END})
    AND WAREHOUSE_ID IS NOT NULL AND WAREHOUSE_SIZE IS NOT NULL AND CLUSTER_NUMBER IS NOT NULL
),
adjusted AS (
  SELECT p.warehouse_id, p.warehouse_name, p.cluster_number, p.valid_from, p.valid_to,
         GREATEST(q.st, p.valid_from) AS query_start, LEAST(q.et, p.valid_to) AS query_end
  FROM periods p JOIN q
    ON q.warehouse_id = p.warehouse_id AND q.cluster_number = p.cluster_number
   AND q.st < p.valid_to AND q.et > p.valid_from
),
flagged AS (
  SELECT *, IFF(query_start > MAX(query_end) OVER (
              PARTITION BY warehouse_id, cluster_number, valid_from ORDER BY query_start, query_end
              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 1, 0) AS later_group,
         ROW_NUMBER() OVER (PARTITION BY warehouse_id, cluster_number, valid_from ORDER BY query_start, query_end) AS rn
  FROM adjusted
),
grouped AS (
  SELECT *, SUM(IFF(rn = 1, 1, later_group)) OVER (
              PARTITION BY warehouse_id, cluster_number, valid_from ORDER BY rn
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS group_id
  FROM flagged
),
windows AS (
  SELECT warehouse_id, warehouse_name, cluster_number, valid_from, valid_to, group_id,
         MIN(query_start) AS group_start, MAX(query_end) AS group_end
  FROM grouped GROUP BY 1, 2, 3, 4, 5, 6
),
gaps AS (
  SELECT *, LAG(group_end) OVER (PARTITION BY warehouse_id, cluster_number, valid_from ORDER BY group_start) AS prev_end,
         LEAD(group_start) OVER (PARTITION BY warehouse_id, cluster_number, valid_from ORDER BY group_start) AS next_start
  FROM windows
),
per_period AS (
  SELECT warehouse_id, warehouse_name, cluster_number, valid_from,
         DATEDIFF('second', valid_from, valid_to) AS active_seconds,
         SUM(DATEDIFF('second', COALESCE(prev_end, valid_from), group_start)
             + IFF(next_start IS NULL, DATEDIFF('second', group_end, valid_to), 0)) AS idle_seconds
  FROM gaps GROUP BY 1, 2, 3, 4, 5
)
SELECT warehouse_id, warehouse_name, cluster_number,
       IFF(valid_from >= DATEADD(day, -7, ${WINDOW_END_UTC}), TO_VARCHAR(valid_from::DATE, 'YYYY-MM-DD'), NULL) AS usage_day,
       IFF(valid_from < DATEADD(hour, -1, ${WINDOW_END_UTC}), TO_VARCHAR(DATEADD(hour, 1, valid_from)::DATE, 'YYYY-MM-DD'), NULL) AS idle_day,
       COUNT(*) AS periods, COUNT_IF(active_seconds <= 80) AS short_periods,
       SUM(active_seconds) AS active_seconds, SUM(idle_seconds) AS idle_seconds,
       DATE_PART(epoch_second, MIN(valid_from)) AS first_start
FROM per_period GROUP BY 1, 2, 3, 4, 5 ORDER BY 2, 3, 4, 5
`

/**
 * Per warehouse and day: how many times it resumed, suspended and resumed again less than a minute after
 * the first resume, by the whole seconds elapsed between the two resumes. The event log
 * repeats each warehouse-level event, so events are made distinct first.
 */
export const SNOWFLAKE_RESTART_FACTS_SQL = `
WITH e AS (
  SELECT DISTINCT WAREHOUSE_ID AS warehouse_id, WAREHOUSE_NAME AS warehouse_name,
         TO_TIMESTAMP_NTZ(CONVERT_TIMEZONE('UTC', TIMESTAMP)) AS ts, EVENT_NAME AS event_name
  FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_EVENTS_HISTORY
  WHERE TIMESTAMP >= DATEADD(day, -7, ${WINDOW_END}) AND TIMESTAMP < ${WINDOW_END}
    AND EVENT_NAME IN ('RESUME_WAREHOUSE', 'SUSPEND_WAREHOUSE', 'WAREHOUSE_CONSISTENT')
),
s AS (
  SELECT warehouse_id, warehouse_name, ts, event_name,
         LEAD(event_name, 1) OVER (PARTITION BY warehouse_id, ts::DATE ORDER BY ts, event_name) AS n1,
         LEAD(event_name, 2) OVER (PARTITION BY warehouse_id, ts::DATE ORDER BY ts, event_name) AS n2,
         LEAD(event_name, 3) OVER (PARTITION BY warehouse_id, ts::DATE ORDER BY ts, event_name) AS n3,
         LEAD(event_name, 4) OVER (PARTITION BY warehouse_id, ts::DATE ORDER BY ts, event_name) AS n4,
         LEAD(ts, 4) OVER (PARTITION BY warehouse_id, ts::DATE ORDER BY ts, event_name) AS t4
  FROM e
)
SELECT warehouse_id, warehouse_name, TO_VARCHAR(ts::DATE, 'YYYY-MM-DD') AS day,
       TRUNC(DATEDIFF('millisecond', ts, t4) / 1000) AS gap_seconds, COUNT(*) AS bounces,
       DATE_PART(epoch_second, MIN(ts)) AS first_start
FROM s
WHERE event_name = 'RESUME_WAREHOUSE' AND n1 = 'WAREHOUSE_CONSISTENT' AND n2 = 'SUSPEND_WAREHOUSE'
  AND n3 = 'WAREHOUSE_CONSISTENT' AND n4 = 'RESUME_WAREHOUSE'
  AND DATEDIFF('millisecond', ts, t4) < 60000
GROUP BY 1, 2, 3, 4 ORDER BY 2, 3, 4
`

/**
 * Per warehouse: queries that ended in the window, those that executed for five seconds or less, and the
 * credits attributed to those: each metered hour's compute credits shared by execution time, plus the
 * query's share of the day's billable cloud services credits.
 */
export const SNOWFLAKE_QUERY_FACTS_SQL = `
WITH metered AS (
  SELECT WAREHOUSE_ID AS warehouse_id, TO_TIMESTAMP_NTZ(CONVERT_TIMEZONE('UTC', START_TIME)) AS hour_start,
         CREDITS_USED_COMPUTE AS compute_credits, CREDITS_USED_CLOUD_SERVICES AS cloud_credits
  FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
  WHERE START_TIME >= DATEADD(day, -9, ${WINDOW_END}) AND START_TIME < ${WINDOW_END}
),
hourly AS (SELECT warehouse_id, hour_start, SUM(compute_credits) AS compute_credits FROM metered WHERE warehouse_id > 0 GROUP BY 1, 2),
daily AS (
  SELECT hour_start::DATE AS day, SUM(cloud_credits) AS cloud_credits,
         GREATEST(SUM(cloud_credits) - SUM(compute_credits) * 0.1, 0) AS billable_cloud_credits
  FROM metered GROUP BY 1
),
q AS (
  SELECT QUERY_ID AS query_id, WAREHOUSE_ID AS warehouse_id, WAREHOUSE_NAME AS warehouse_name, WAREHOUSE_SIZE AS warehouse_size,
         EXECUTION_TIME AS execution_ms, CREDITS_USED_CLOUD_SERVICES AS cloud_credits,
         TO_TIMESTAMP_NTZ(CONVERT_TIMEZONE('UTC', START_TIME)) AS st,
         TO_TIMESTAMP_NTZ(CONVERT_TIMEZONE('UTC', END_TIME)) AS et,
         DATEADD('millisecond', COALESCE(QUEUED_OVERLOAD_TIME, 0) + COALESCE(COMPILATION_TIME, 0) + COALESCE(QUEUED_PROVISIONING_TIME, 0)
                 + COALESCE(QUEUED_REPAIR_TIME, 0) + COALESCE(LIST_EXTERNAL_FILES_TIME, 0),
                 TO_TIMESTAMP_NTZ(CONVERT_TIMEZONE('UTC', START_TIME))) AS exec_start
  FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
  WHERE START_TIME >= DATEADD(day, -9, ${WINDOW_END}) AND START_TIME < ${WINDOW_END} AND WAREHOUSE_ID IS NOT NULL
),
overlap AS (
  SELECT q.query_id, q.warehouse_id, h.hour_start, h.compute_credits,
         DATEDIFF('millisecond', GREATEST(q.exec_start, h.hour_start), LEAST(q.et, DATEADD(hour, 1, h.hour_start))) AS ran_ms
  FROM q JOIN hourly h
    ON h.warehouse_id = q.warehouse_id AND h.hour_start >= DATE_TRUNC('hour', q.exec_start) AND h.hour_start < q.et
  WHERE q.warehouse_size IS NOT NULL AND q.et > q.st
),
allocated AS (
  SELECT query_id, SUM(compute_credits * ran_ms / total_ms) AS compute_credits
  FROM (SELECT *, SUM(ran_ms) OVER (PARTITION BY warehouse_id, hour_start) AS total_ms FROM overlap WHERE ran_ms > 0)
  GROUP BY 1
)
SELECT q.warehouse_id, q.warehouse_name, DATE_PART(epoch_second, MIN(q.st)) AS first_start,
       COUNT(*) AS query_count,
       COUNT_IF(q.execution_ms <= 5000) AS sub_five_second_queries,
       COALESCE(SUM(IFF(q.execution_ms <= 5000,
         COALESCE(a.compute_credits, 0)
         + IFF(d.cloud_credits > 0, COALESCE(q.cloud_credits, 0) / d.cloud_credits * d.billable_cloud_credits, 0), 0)), 0) AS sub_five_second_credits
FROM q
LEFT JOIN allocated a ON a.query_id = q.query_id
LEFT JOIN daily d ON d.day = q.st::DATE
WHERE q.et >= DATEADD(day, -7, ${WINDOW_END_UTC}) AND q.et < ${WINDOW_END_UTC}
GROUP BY 1, 2 ORDER BY 2
`

/**
 * The warehouse lifecycle the view keeps for a year, as rows (`kind`, `warehouse_id`, `warehouse_name`,
 * `event_ms` in epoch milliseconds, UTC):
 * - one `history` row counting the events in the span the period query reads, which tells a view with
 *   nothing for those days from one that was read;
 * - a `drop` row per id dropped since ten days before the window's end, the earliest any usage read here
 *   begins: a dropped id is no listed warehouse's, since a dropped warehouse cannot be recovered;
 * - a `create` row per creation of an id not dropped in the year: a creation within a second of a listed
 *   warehouse's `created_on` names its id when it carries that warehouse's name or the id's usage does.
 * The view records no rename, so a rename changes nothing here: an id keeps the creation that names it.
 */
export const SNOWFLAKE_IDENTITY_EVENTS_SQL = `
WITH e AS (
  SELECT WAREHOUSE_ID AS warehouse_id, WAREHOUSE_NAME AS warehouse_name, EVENT_NAME AS event_name, TIMESTAMP AS ts
  FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_EVENTS_HISTORY
  WHERE TIMESTAMP >= DATEADD(day, -365, ${WINDOW_END}) AND WAREHOUSE_ID IS NOT NULL
    AND (EVENT_NAME IN ('CREATE_WAREHOUSE', 'DROP_WAREHOUSE')
         OR (TIMESTAMP >= DATEADD(day, -9, ${WINDOW_END}) AND TIMESTAMP < DATEADD(day, 1, ${WINDOW_END})))
),
gone AS (SELECT DISTINCT warehouse_id FROM e WHERE event_name = 'DROP_WAREHOUSE')
SELECT 'history' AS kind, NULL AS warehouse_id, NULL AS warehouse_name, NULL AS event_ms,
       COUNT_IF(ts >= DATEADD(day, -9, ${WINDOW_END}) AND ts < DATEADD(day, 1, ${WINDOW_END})) AS recent_events
FROM e
UNION ALL
SELECT DISTINCT IFF(event_name = 'DROP_WAREHOUSE', 'drop', 'create'), warehouse_id, warehouse_name,
       DATE_PART(epoch_millisecond, TO_TIMESTAMP_NTZ(CONVERT_TIMEZONE('UTC', ts))), NULL
FROM e
WHERE (event_name = 'DROP_WAREHOUSE' AND ts >= DATEADD(day, -10, ${WINDOW_END}))
   OR (event_name = 'CREATE_WAREHOUSE' AND warehouse_id NOT IN (SELECT warehouse_id FROM gone))
ORDER BY 1 DESC, 2, 4
`

/** The account's contracted price of a warehouse credit: the latest above zero before the window's end, the lowest if that date has several. */
export const SNOWFLAKE_RATE_SQL = `
SELECT EFFECTIVE_RATE AS effective_rate, CURRENCY AS currency, TO_VARCHAR(DATE, 'YYYY-MM-DD') AS rate_date
FROM SNOWFLAKE.ORGANIZATION_USAGE.RATE_SHEET_DAILY
WHERE ACCOUNT_NAME = CURRENT_ACCOUNT_NAME() AND SERVICE_TYPE = 'WAREHOUSE_METERING' AND USAGE_TYPE = 'compute' AND DATE < ${WINDOW_END_UTC}::DATE
  AND EFFECTIVE_RATE > 0
ORDER BY DATE DESC, EFFECTIVE_RATE LIMIT 1
`

/** Core's rules: a `SnowflakeSavingsInput` as JSON in, the report out. */
export type RulesEngine = (input: string) => SnowflakeSavingsReport

type CoreModule = { snowflakeSavings?: unknown } & CoreTelemetrySwitch

/** The installed core's rules, or null when its binary predates them. See `databricks-savings.ts` for assessment mode. */
export function rulesEngine(lib: CoreModule = core as unknown as CoreModule): RulesEngine | null {
  const found = lib.snowflakeSavings
  if (typeof found !== "function") return null
  if (Flag.ALTIMATE_ASSESSMENT_MODE) silenceWith(lib)
  return found as RulesEngine
}

type Row = Record<string, unknown>

function num(value: unknown): number {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

const whole = (value: unknown) => Math.max(0, Math.round(num(value)))

function optionalWhole(value: unknown): number | null {
  return value == null || value === "" ? null : whole(value)
}

function records(result: { columns: string[]; rows: unknown[][] }): Row[] {
  return result.rows.map((row) => Object.fromEntries(result.columns.map((name, at) => [name, row[at]])))
}

/** A map entry, created on first use. */
function entry<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  let found = map.get(key)
  if (found === undefined) {
    found = create()
    map.set(key, found)
  }
  return found
}

export interface FactRows {
  warehouses: Row[]
  metering: Row[]
  periods: Row[]
  restarts: Row[]
  queries: Row[]
  /** The rows of `SNOWFLAKE_IDENTITY_EVENTS_SQL`; none when the view could not be read in full. */
  lifecycle?: Row[]
}

/** Milliseconds of a `created_on` value, or NaN when it cannot be read. */
function timeOf(value: unknown): number {
  if (value instanceof Date) return value.getTime()
  const json = (value as { toJSON?: () => unknown } | null | undefined)?.toJSON?.()
  return Date.parse(String(json ?? value ?? ""))
}

const HOUR_MS = 3_600_000

/** How far an event or query time may read before `created_on`, which Snowflake stamps on its own clock. */
const CLOCK_SKEW_MS = 60_000

/** How far a warehouse's CREATE_WAREHOUSE event may be from the `created_on` SHOW WAREHOUSES reports. */
const CREATE_TOLERANCE_MS = 1_000

/**
 * The id each listed warehouse's creation event names, and the ids that were dropped. A creation within a
 * second of a listed warehouse's `created_on` is not enough: another warehouse, one this role cannot list
 * among them, can be created in the same second. The creation must also carry the listed name, or the id's
 * usage must have been logged under it (`namesById`). A listed warehouse gets an id only when exactly one
 * such id was created within a second of its `created_on` (the query leaves out the creations of ids
 * dropped since), and that id fits no other listed warehouse; otherwise it has none here, and an id with
 * no listed owner stays unattributed.
 */
function identityOf(warehouses: Row[], lifecycle: Row[], namesById: Map<number, Map<string, number>>) {
  const dropped = new Set(lifecycle.filter((row) => row.kind === "drop").map((row) => num(row.warehouse_id)))
  const creations = lifecycle
    .filter((row) => row.kind === "create")
    .map((row) => ({ id: num(row.warehouse_id), at: num(row.event_ms), name: String(row.warehouse_name ?? "") }))
  const namesByCreatedId = new Map<number, string[]>()
  for (const row of warehouses) {
    const name = String(row.name ?? "")
    const created = timeOf(row.created_on)
    const ids = new Set(
      creations
        .filter((one) => Math.abs(one.at - created) <= CREATE_TOLERANCE_MS)
        .filter((one) => one.name === name || namesById.get(one.id)?.has(name))
        .map(({ id }) => id),
    )
    if (ids.size === 1) entry(namesByCreatedId, [...ids][0]!, () => []).push(name)
  }
  const listedAs = new Map<number, string>()
  for (const [id, names] of namesByCreatedId) if (names.length === 1) listedAs.set(id, names[0]!)
  return { dropped, listedAs }
}

/**
 * When a fact row's usage began, in milliseconds: its `first_start` (epoch seconds). A row without one (only
 * hand-built rows) falls back to the start of its UTC day.
 */
function startOf(row: Row): number {
  if (row.first_start != null && row.first_start !== "") return num(row.first_start) * 1000
  const day = row.usage_day ?? row.idle_day ?? row.day
  return day == null ? Number.NaN : Date.parse(`${String(day)}T00:00:00Z`)
}

/** Whether a row shows any usage worth naming when it is left out. */
const active = (row: Row) =>
  num(row.credits_used) > 0 || whole(row.periods) > 0 || whole(row.bounces) > 0 || whole(row.query_count) > 0

/** Orders larger values first; an unreadable time sorts last. */
const later = (a: number, b: number) => (a === b ? 0 : a > b ? -1 : 1)

/**
 * The input core reads, one entry per warehouse `SHOW WAREHOUSES` lists, which gives names and no ids.
 * Usage belongs to a warehouse id, and each id belongs to at most one listed warehouse. The warehouse
 * events give that from ids: an id dropped belongs to none, and an id whose creation matches a listed
 * warehouse's `created_on` and name (or whose usage was logged under that name) belongs to that one,
 * whatever other names its usage was logged under. A creation matching only the time names nothing. Ids and listed
 * warehouses the events leave open (created more than a year ago or in the same second as another, dropped
 * or created after the view's latest event, or no events read) are matched by name and time:
 * - the name an id was seen under last, by each row's start (a query row starts at that name's first query),
 *   unless some of its usage began before the warehouse now holding that name was created (a dropped
 *   warehouse whose name was reused);
 * - otherwise another listed name it was seen under, created before all of its usage (a warehouse renamed
 *   away from a name that was then reused).
 * A metered hour counts from its start, which can be up to an hour before the creation inside it, and other
 * times may read up to a minute early. A name that several ids belong to keeps the one seen last, then the
 * larger (newer) id. Without an id from the events, a listed warehouse can still get the usage of another
 * that used its name before: one renamed away with no usage under its new name, or one dropped after the
 * view's latest event.
 * `unlisted` names the warehouses that billed credits but are not listed: dropped, or hidden from the role.
 * `replaced` names the listed ones whose name an earlier warehouse also used with any usage (credits,
 * periods, restarts or queries): that earlier usage is left out.
 */
export function buildFacts(rows: FactRows) {
  const listed = new Set(rows.warehouses.map((row) => String(row.name ?? "")))
  const createdAt = new Map(rows.warehouses.map((row) => [String(row.name ?? ""), timeOf(row.created_on)]))
  // Each id's rows from every source, with whether a row's time is a metered hour, and when each of its names was last seen.
  const sources = [
    { list: rows.metering, hourly: true },
    { list: rows.periods, hourly: false },
    { list: rows.restarts, hourly: false },
    { list: rows.queries, hourly: false },
  ]
  const rowsById = new Map<number, { row: Row; hourly: boolean }[]>()
  const namesById = new Map<number, Map<string, number>>()
  for (const { list, hourly } of sources) {
    for (const row of list) {
      const id = num(row.warehouse_id)
      const name = String(row.warehouse_name ?? "")
      const start = startOf(row)
      const at = Number.isFinite(start) ? start : -Infinity
      entry(rowsById, id, () => []).push({ row, hourly })
      const names = entry(namesById, id, () => new Map<string, number>())
      names.set(name, Math.max(names.get(name) ?? -Infinity, at))
    }
  }
  const { dropped, listedAs } = identityOf(rows.warehouses, rows.lifecycle ?? [], namesById)
  const identified = new Set(listedAs.values())
  /** A listed warehouse whose id the events did not give. */
  const open = (name: string) => listed.has(name) && !identified.has(name)
  /** An id's names, latest first; on a tie a listed name comes first. */
  const namesOf = (id: number) =>
    [...(namesById.get(id) ?? [])]
      .sort(([a, at], [b, bt]) => later(at, bt) || Number(listed.has(b)) - Number(listed.has(a)))
      .map(([name]) => name)
  const lastSeen = (id: number) => Math.max(...(namesById.get(id)?.values() ?? []))
  /** Whether none of an id's usage began before `created`. An unreadable start compares false. */
  const startedAfter = (id: number, created: number) =>
    (rowsById.get(id) ?? []).every(({ row, hourly }) => {
      const start = startOf(row)
      return hourly ? start + HOUR_MS > created : start + CLOCK_SKEW_MS >= created
    })
  /**
   * The listed warehouse an id belongs to, if any. An unreadable creation time on its last name keeps the id
   * there; it never moves an id to another name.
   */
  const ownerOf = (id: number): string | undefined => {
    if (dropped.has(id)) return undefined
    const known = listedAs.get(id)
    if (known !== undefined) return known
    const [last, ...earlier] = namesOf(id)
    if (last !== undefined && open(last)) {
      const created = createdAt.get(last) ?? Number.NaN
      if (!Number.isFinite(created) || startedAfter(id, created)) return last
    }
    // Moving an id to another of its names needs that warehouse's creation time to show the id fits it: an
    // unreadable one compares false.
    return earlier.find((name) => open(name) && startedAfter(id, createdAt.get(name) ?? Number.NaN))
  }
  const replaced = new Set<string>()
  const unlisted = new Set<string>()
  const idsByOwner = new Map<string, number[]>()
  for (const [id, list] of rowsById) {
    const owner = ownerOf(id)
    if (owner !== undefined) {
      entry(idsByOwner, owner, () => []).push(id)
      continue
    }
    const last = namesOf(id)[0] ?? ""
    if (listed.has(last) && list.some(({ row }) => active(row))) replaced.add(last)
    if (!listed.has(last) && list.some(({ hourly }) => hourly)) unlisted.add(last)
  }
  const idOf = new Map<string, number>()
  for (const [owner, ids] of idsByOwner) {
    const [id, ...others] = ids.sort((a, b) => later(lastSeen(a), lastSeen(b)) || b - a)
    idOf.set(owner, id!)
    if (others.some((other) => rowsById.get(other)?.some(({ row }) => active(row)))) replaced.add(owner)
  }
  // Each source's rows by id, grouped once so every listed warehouse reads only its own.
  const byId = (list: Row[]) => {
    const grouped = new Map<number, Row[]>()
    for (const row of list) entry(grouped, num(row.warehouse_id), () => []).push(row)
    return grouped
  }
  const [metering, periods, restarts, queries] = sources.map(({ list }) => byId(list))
  const of = (grouped: Map<number, Row[]> | undefined, id: number | undefined) => (id === undefined ? [] : (grouped?.get(id) ?? []))

  const facts = rows.warehouses.map((row) => {
    const name = String(row.name ?? "")
    const id = idOf.get(name)
    const usage = new Map<string, { day: string; credits_used: number | null; active_periods: number; short_periods: number }>()
    const idle = new Map<string, { day: string; active_seconds: number; idle_seconds: number; credits_used: number }>()
    const clusters = new Map<string, Map<string, { cluster_number: number; idle_seconds: number; busy_seconds: number }>>()
    const usageDay = (day: string) => entry(usage, day, () => ({ day, credits_used: null, active_periods: 0, short_periods: 0 }))
    const idleDay = (day: string) => entry(idle, day, () => ({ day, active_seconds: 0, idle_seconds: 0, credits_used: 0 }))

    for (const one of of(metering, id)) {
      const credits = num(one.credits_used)
      if (one.usage_day != null) {
        const day = usageDay(String(one.usage_day))
        day.credits_used = (day.credits_used ?? 0) + credits
      }
      if (one.idle_day != null) idleDay(String(one.idle_day)).credits_used += credits
    }
    for (const one of of(periods, id)) {
      const active = whole(one.active_seconds)
      const idleSeconds = whole(one.idle_seconds)
      if (one.usage_day != null) {
        const key = String(one.usage_day)
        const day = usageDay(key)
        day.active_periods += whole(one.periods)
        day.short_periods += whole(one.short_periods)
        const number = whole(one.cluster_number)
        const cluster = entry(entry(clusters, key, () => new Map()), String(number), () => ({
          cluster_number: number,
          idle_seconds: 0,
          busy_seconds: 0,
        }))
        cluster.idle_seconds += idleSeconds
        cluster.busy_seconds += active - idleSeconds
      }
      if (one.idle_day != null) {
        const day = idleDay(String(one.idle_day))
        day.active_seconds += active
        day.idle_seconds += idleSeconds
      }
    }
    // A rename splits a day's or the window's rows by name; they are one warehouse's.
    const gaps = new Map<string, Map<string, { gap_seconds: number; bounces: number }>>()
    for (const one of of(restarts, id)) {
      const seconds = whole(one.gap_seconds)
      const gap = entry(entry(gaps, String(one.day), () => new Map()), String(seconds), () => ({ gap_seconds: seconds, bounces: 0 }))
      gap.bounces += whole(one.bounces)
    }
    const query = { count: 0, short: 0, credits: 0 }
    for (const one of of(queries, id)) {
      query.count += whole(one.query_count)
      query.short += whole(one.sub_five_second_queries)
      query.credits += num(one.sub_five_second_credits)
    }
    return {
      // Prefixed so an unused warehouse named like another's numeric id cannot collide with it.
      warehouse_id: id ? String(id) : `unused:${name}`,
      warehouse_name: name,
      warehouse_size: row.size == null ? null : String(row.size),
      warehouse_type: row.type == null ? null : String(row.type),
      min_cluster_count: optionalWhole(row.min_cluster_count),
      max_cluster_count: optionalWhole(row.max_cluster_count),
      query_count: query.count,
      sub_five_second_queries: query.short,
      sub_five_second_credits: query.credits,
      usage_days: [...usage.values()],
      idle_days: [...idle.values()],
      cluster_days: [...clusters].map(([day, byNumber]) => ({ day, clusters: [...byNumber.values()] })),
      restart_days: [...gaps].map(([day, byGap]) => ({ day, gaps: [...byGap.values()] })),
    }
  })
  return { facts, unlisted: [...unlisted].sort(), replaced: [...replaced].sort() }
}

/** The price of a credit: the account's rate when it can be read in dollars, otherwise list price. */
export function creditPrice(rate: Row | undefined): { per_credit: number; source: "rate_sheet" | "list_price"; as_of?: string } {
  const value = num(rate?.effective_rate)
  if (value > 0 && String(rate?.currency ?? "").toUpperCase() === "USD") {
    return { per_credit: value, source: "rate_sheet", as_of: String(rate?.rate_date ?? "") }
  }
  return { per_credit: LIST_PRICE_PER_CREDIT, source: "list_price" }
}

function resolveConnection(warehouse: string | undefined) {
  return resolveFinopsWarehouse({
    requested: warehouse?.trim() || undefined,
    supportedTypes: SUPPORTED_TYPES,
    operationName: "The Snowflake savings check",
  })
}

/** The connection a check with this `warehouse` argument runs on, or why there is none. */
export function savingsConnection(warehouse?: string): { warehouse: string } | { error: string } {
  const resolved = resolveConnection(warehouse)
  return resolved.kind === "error" ? { error: resolved.error } : { warehouse: resolved.warehouse }
}

/** `rules` defaults to the installed core's; tests pass their own. */
export async function snowflakeSavings(
  params: SnowflakeSavingsParams,
  rules: RulesEngine | null = rulesEngine(),
  context?: QueryContext,
): Promise<SnowflakeSavingsResult> {
  const window = savingsWindow(params.now_ms ?? Date.now())
  const failed = (error: string): SnowflakeSavingsResult => ({ success: false, window, error })

  const resolved = resolveConnection(params.warehouse)
  if (resolved.kind === "error") return failed(resolved.error)

  if (!rules) {
    return failed("This altimate-code build's altimate-core has no Snowflake savings rules. Update altimate-code, then try again.")
  }

  const run = savingsRun(context)
  const signal = run.signal

  try {
    const connector = await run.beforeStop(() => Registry.get(resolved.warehouse), "Connecting to the warehouse")
    const config = Registry.getConfig(resolved.warehouse) as Record<string, unknown> | undefined
    const limited: string[] = []
    // Every parameter is the window's end date.
    const binds = (sql: string) => Array.from({ length: sql.split("?").length - 1 }, () => window.end)
    const read = async (what: string, sql: string, rowLimit = ROW_LIMIT) => {
      const result = await run.query(connector, what, sql, rowLimit, binds(sql))
      if (result.truncated) limited.push(what)
      return records(result)
    }
    const warehouses = await read("warehouses", SNOWFLAKE_WAREHOUSES_SQL, SHOW_ROW_LIMIT)
    if (warehouses.length === 0) return failed("SHOW WAREHOUSES lists no warehouse this connection's role can see.")

    // A view the role may not read stops only the checks that need it; the rest still report.
    const skipped: { check: string; reason: string }[] = []
    let checksMissing = 0
    const optional = async (check: string, what: string, sql: string) => {
      try {
        return await read(what, sql)
      } catch (e) {
        if (signal?.aborted) throw e
        checksMissing++
        skipped.push({ check, reason: reasonOf(e) })
        return []
      }
    }
    const metering = await read("metering", SNOWFLAKE_METERING_FACTS_SQL)
    const periods = await optional(
      "High Idle Time, Underutilized Cluster and the short-period signal of Downsize Warehouse",
      "active periods",
      SNOWFLAKE_PERIOD_FACTS_SQL,
    )
    const restarts = await optional("Frequent Restart Overcharge", "restart events", SNOWFLAKE_RESTART_FACTS_SQL)
    const queries = await optional("The short-query signal of Downsize Warehouse", "query history", SNOWFLAKE_QUERY_FACTS_SQL)

    // All four checks rest on these three queries: with none of them, nothing was assessed.
    if (checksMissing === 3) {
      // A query that may still be running and billing matters more than the ones after it.
      const reason = skipped.find((one) => one.reason.includes("may still be running")) ?? skipped.at(-1)!
      return failed(`No check could run. ${reason.reason}`)
    }

    // Read after the usage queries: only the price needs it, and a slow or unreadable rate sheet must not
    // cost a usage query its time. Most accounts cannot read it (it needs organization access); list price
    // stands in.
    const rate = await read("credit rate", SNOWFLAKE_RATE_SQL).catch((e) => {
      if (signal?.aborted) throw e
      // An unreadable rate sheet is ordinary; a lookup the time limit stopped, or that may still be
      // running, is named, so the list price is not passed off as an unreadable rate sheet.
      if (e instanceof SavingsLimitError) skipped.push({ check: "The account's credit rate", reason: reasonOf(e) })
      return [] as Row[]
    })
    const price = creditPrice(rate[0])

    // Read last: it scans a year of events, and the price matters to every warehouse while this matters only
    // to warehouses that shared a name. Without it, usage is matched to warehouses by name and time, and the
    // answer says so.
    let lifecycle: Row[] = []
    const byNameAndTime = (reason: string) =>
      skipped.push({
        check: "Telling dropped, recreated and renamed warehouses apart by id",
        reason: `${reason.replace(/\.$/, "")}; usage was matched to warehouses by name and creation time instead`,
      })
    try {
      const sql = SNOWFLAKE_IDENTITY_EVENTS_SQL
      const result = await run.query(connector, "warehouse identity", sql, ROW_LIMIT, binds(sql))
      const events = records(result)
      const history = events.find((row) => row.kind === "history")
      // The period and restart queries read the same view: events there and none here is a view not read.
      if (history === undefined || (whole(history.recent_events) === 0 && periods.length + restarts.length > 0)) {
        byNameAndTime("WAREHOUSE_EVENTS_HISTORY returned no events for the days the other queries read events from")
      } else if (result.truncated) {
        // A cut list can lack the creation that would rule a match out, so none of it is used.
        byNameAndTime(`WAREHOUSE_EVENTS_HISTORY has more creations and drops than the ${ROW_LIMIT.toLocaleString("en-US")}-row limit`)
      } else lifecycle = events
    } catch (e) {
      if (signal?.aborted) throw e
      byNameAndTime(reasonOf(e))
    }
    const { facts, unlisted, replaced } = buildFacts({ warehouses, metering, periods, restarts, queries, lifecycle })
    if (unlisted.length > 0) {
      skipped.push({
        check: `${unlisted.length} warehouse${unlisted.length === 1 ? "" : "s"} that billed credits`,
        reason: `SHOW WAREHOUSES does not list ${unlisted.slice(0, 5).join(", ")}${unlisted.length > 5 ? ", …" : ""}: dropped, renamed, or not visible to the connection's role`,
      })
    }
    if (replaced.length > 0) {
      skipped.push({
        check: `Earlier usage of ${replaced.length} warehouse name${replaced.length === 1 ? "" : "s"}`,
        reason: `${replaced.slice(0, 5).join(", ")}${replaced.length > 5 ? ", …" : ""} also had usage from an earlier warehouse, since dropped or renamed: only the current warehouse's usage was checked`,
      })
    }
    const report = rules(JSON.stringify({ lookback_days: LOOKBACK_DAYS, price_per_credit: price.per_credit, warehouses: facts }))
    return {
      success: true,
      window,
      warehouse: resolved.warehouse,
      ran_on: config?.warehouse == null ? undefined : String(config.warehouse),
      warehouses_checked: facts.length,
      price,
      skipped,
      limited,
      // What each warehouse is and costs now, so a later run can tell what changed.
      warehouses: facts.map((one) => ({
        id: one.warehouse_id,
        name: one.warehouse_name,
        type: one.warehouse_type ?? "",
        size: one.warehouse_size,
        window_cost: one.usage_days.reduce((sum, day) => sum + (day.credits_used ?? 0), 0) * price.per_credit,
      })),
      report,
    }
  } catch (e) {
    return failed(e instanceof Error ? e.message : String(e))
  }
}
