import path from "path"
import { sanitizeBqRegion } from "../native/finops/bq-utils"
import { loadRawManifest } from "../native/dbt/helpers"

/** What a model's previous runs cost, read from the warehouse's own billing tables, and the rates that turn usage into money. */

export const HISTORY_DAYS = 30
export const HISTORY_LIMIT = 500
/** A delete or update attaches to a build job of the model that starts within this long after it. */
export const BQ_ATTACH_MS = 60_000
/** The most child jobs of matched scripts the children query returns. */
export const BQ_CHILD_LIMIT = 10000
const LIMIT_NOTE = `Only the newest ${HISTORY_LIMIT} statements were read, so older runs are not counted.`
const boundaryNote = (dropped: number) =>
  `${dropped} run${dropped === 1 ? "" : "s"} that may have started before the period read ${dropped === 1 ? "was" : "were"} left out.`
/** A statement that starts more than this after the previous one ended begins a new run. */
export const RUN_GAP_MS = 10 * 60_000
/** BigQuery bills at least this many bytes for a query. */
export const BQ_MIN_BILLED_BYTES = 10 * 1024 ** 2
const TIB = 1024 ** 4

export type CostConfig = {
  bigqueryUsdPerTib?: number
  bigquerySlotHourUsd?: number
  snowflakeUsdPerCredit?: number
  databricksUsdPerDbu?: number
}

export const DEFAULT_RATES = { bigqueryUsdPerTib: 6.25, bigquerySlotHourUsd: 0.06, snowflakeUsdPerCredit: 3 }

export type CostRate = {
  value: number
  unit: string
  source: "account" | "list_price" | "config" | "default"
  /** For `account`: the blended rate actually billed (contract plus overage), or the contract rate alone. */
  detail?: "billed" | "contract"
}
export type NativeUnit = "bytes_billed" | "slot_hours" | "credits" | "dbus"

export type CostInfo = {
  basis: "history" | "dry_run" | "none"
  currency: string
  lastRun?: number
  typical?: number
  highest?: number
  runs?: number
  windowDays?: 30
  /** BigQuery on-demand: what the SELECT would bill. `low` is the per-table minimum, `high` the dry run's upper bound plus each table's minimum. */
  selectOnly?: { low: number; high: number }
  native?: { unit: NativeUnit; lastRun?: number; typical?: number; highest?: number }
  rate: CostRate | null
  notes: string[]
  unknownReason?: string
}

/** The config's rates that are usable numbers. */
export function cleanRates(raw: unknown): CostConfig {
  const out: CostConfig = {}
  if (!raw || typeof raw !== "object") return out
  const given: Record<string, unknown> = { ...raw }
  for (const key of ["bigqueryUsdPerTib", "bigquerySlotHourUsd", "snowflakeUsdPerCredit", "databricksUsdPerDbu"] as const) {
    const v = given[key]
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[key] = v
  }
  return out
}

function rateOf(config: number | undefined, fallback: number, unit: string, key: string): { rate: CostRate; note?: string } {
  if (config !== undefined) return { rate: { value: config, unit, source: "config" } }
  return {
    rate: { value: fallback, unit, source: "default" },
    note: `Rate ${fallback} ${unit} is a default rate; set cost.${key} to your contract rate.`,
  }
}

// ---- Matching a model's runs ----

/** dbt's default query comment carries `"node_id": "<unique_id>"`; the closing quote keeps `model.a.b` from matching `model.a.bc`. */
export function needleFor(uniqueId: string): string {
  return `"node_id": "${uniqueId}"`
}

/** A single-quoted SQL string literal: backslash and quote escaped. */
export function sqlString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
}

export type ModelRef = { uniqueId: string; materialized?: string; /** Physical relations the model reads (views and ephemeral models resolved to what they read), and how many of them are sources. */ tables?: number; sources?: number }

/**
 * The one model node a name stands for: a unique_id, a plain name, or a package-qualified or versioned
 * name (`shop.orders`, `orders.v2`). Several nodes, or none, is an error that names them.
 */
export function resolveModel(nodes: Record<string, any>, name: string, sources: Record<string, any> = {}): ModelRef | { error: string } {
  const models = Object.entries(nodes).filter(([, n]) => n?.resource_type === "model")
  let hits = models.filter(([id]) => id === name)
  if (!hits.length) hits = models.filter(([, n]) => n.name === name)
  if (!hits.length && name.includes(".")) hits = models.filter(([id]) => id.endsWith(`.${name}`))
  if (hits.length === 1)
    return { uniqueId: hits[0][0], materialized: hits[0][1]?.config?.materialized, ...countTables(nodes, sources, hits[0][0]) }
  if (hits.length === 0) return { error: `no model named ${name} in the manifest` }
  const ids = hits.map(([id]) => id).sort()
  return { error: `${name} is ambiguous: it matches ${ids.join(", ")}; pass a unique_id` }
}

/**
 * The physical relations a model reads: tables, incremental models, snapshots, seeds and sources. A view or an
 * ephemeral model holds no data of its own, so it counts as what it reads. A source counts as one relation.
 */
export function countTables(nodes: Record<string, any>, sources: Record<string, any>, uniqueId: string): { tables: number; sources: number } {
  const seen = new Set<string>()
  const tables = new Set<string>()
  const origins = new Set<string>()
  const visit = (id: string) => {
    if (seen.has(id)) return
    seen.add(id)
    for (const dep of nodes[id]?.depends_on?.nodes ?? []) {
      const node = nodes[dep]
      if (node && node.resource_type === "model" && ["ephemeral", "view"].includes(node.config?.materialized)) visit(dep)
      else if (node && ["model", "seed", "snapshot"].includes(node.resource_type)) tables.add(dep)
      else if (!node && sources[dep]) {
        tables.add(dep)
        origins.add(dep)
      }
    }
  }
  visit(uniqueId)
  return { tables: tables.size, sources: origins.size }
}

/** The model the manifest the adapter wrote holds under `name`. */
export function modelFromManifest(manifestPath: string, name: string): ModelRef | { error: string } {
  let manifest: any
  try {
    manifest = loadRawManifest(manifestPath)
  } catch (e) {
    return { error: `the manifest at ${manifestPath} could not be read: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!manifest?.nodes) return { error: `no manifest at ${manifestPath}; run dbt parse or dbt compile first` }
  return resolveModel(manifest.nodes, name, manifest.sources ?? {})
}

export function manifestPathFor(adapter: any, projectRoot: string | undefined): string | undefined {
  const given = typeof adapter.getManifestPath === "function" ? adapter.getManifestPath() : undefined
  if (typeof given === "string" && given) return given
  const root = (typeof adapter.getProjectRoot === "function" ? adapter.getProjectRoot() : undefined) ?? projectRoot
  return root ? path.join(root, "target", "manifest.json") : undefined
}

// ---- History SQL ----

const BQ_BUILD_TYPES = ["CREATE_TABLE_AS_SELECT", "CREATE_TABLE", "CREATE_VIEW", "INSERT", "MERGE", "SCRIPT"]
const BQ_TYPES = [...BQ_BUILD_TYPES, "DELETE", "UPDATE"]
const SF_TYPES = ["CREATE_TABLE_AS_SELECT", "CREATE_TABLE", "CREATE_VIEW", "INSERT", "MERGE", "DELETE", "UPDATE", "MULTI_STATEMENT"]
const DBX_TYPES = ["CREATE", "INSERT", "MERGE", "DELETE", "UPDATE", "REPLACE", "COPY", "OPTIMIZE", "ANALYZE"]
const list = (xs: string[]) => xs.map((x) => `'${x}'`).join(",")

/** A BigQuery project id as a backtick-quoted name, or undefined when it holds anything a name can't. */
export function bqProject(project: unknown): string | undefined {
  return typeof project === "string" && /^[A-Za-z0-9_.:-]+$/.test(project) ? project : undefined
}

/** The project's jobs, or only the caller's own (for a role that may not list every user's). */
export type JobsView = "JOBS" | "JOBS_BY_USER"

function bqJobs(project: string, location: unknown, view: JobsView): string {
  return `\`${project}\`.\`region-${sanitizeBqRegion(location)}\`.INFORMATION_SCHEMA.${view}`
}

export function bigqueryHistorySql(input: { project: string; location?: unknown; needle: string; view?: JobsView }): string {
  return `select job_id, creation_time, end_time, statement_type, total_bytes_billed, total_slot_ms, reservation_id, cache_hit
from ${bqJobs(input.project, input.location, input.view ?? "JOBS")}
where creation_time > timestamp_sub(current_timestamp(), interval ${HISTORY_DAYS} day)
  and job_type = 'QUERY' and state = 'DONE' and error_result is null
  and parent_job_id is null
  and statement_type in (${list(BQ_TYPES)})
  and strpos(query, ${sqlString(input.needle)}) > 0
order by creation_time desc limit ${HISTORY_LIMIT}`
}

/** The child jobs of matched scripts: a script's own row carries no reservation, its children do. */
export function bigqueryChildrenSql(input: { project: string; location?: unknown; parents: string[]; view?: JobsView }): string {
  return `select job_id, parent_job_id, creation_time, statement_type, total_bytes_billed, total_slot_ms, reservation_id, cache_hit
from ${bqJobs(input.project, input.location, input.view ?? "JOBS")}
where creation_time > timestamp_sub(current_timestamp(), interval ${HISTORY_DAYS} day)
  and job_type = 'QUERY' and state = 'DONE' and error_result is null
  and parent_job_id in (${input.parents.map(sqlString).join(",")})
order by creation_time desc limit ${BQ_CHILD_LIMIT}`
}

/** How many query jobs ran in the last week, and how many of them in a reservation. */
export function bigqueryCapacitySql(input: { project: string; location?: unknown; view?: JobsView }): string {
  return `select count(*) as jobs, countif(reservation_id is not null) as reserved
from ${bqJobs(input.project, input.location, input.view ?? "JOBS")}
where creation_time > timestamp_sub(current_timestamp(), interval 7 day)
  and job_type = 'QUERY' and state = 'DONE'`
}

export function snowflakeHistorySql(needle: string): string {
  return `select q.query_id, q.session_id, q.start_time, to_varchar(convert_timezone('UTC', q.start_time), 'YYYY-MM-DD') as start_date_utc, q.end_time, q.execution_time, q.query_type, q.warehouse_name, q.warehouse_size,
       a.credits_attributed_compute, a.credits_used_query_acceleration, q.credits_used_cloud_services
from snowflake.account_usage.query_history q
left join snowflake.account_usage.query_attribution_history a on a.query_id = q.query_id
where q.start_time > dateadd(day, -${HISTORY_DAYS}, current_timestamp())
  and q.execution_status = 'SUCCESS'
  and q.query_type in (${list(SF_TYPES)})
  and contains(q.query_text, ${sqlString(needle)})
order by q.start_time desc limit ${HISTORY_LIMIT}`
}

/**
 * The matching statements that started before the period the history read covers (`cutoffMs`, or the start of the
 * window when the read did not hit its limit) and ended within the grouping gap of it. They may belong to runs the
 * history saw only the end of. A day's lookback bounds the scan.
 */
export const BOUNDARY_LOOKBACK_DAYS = 1

export function snowflakeBoundarySql(needle: string, cutoffMs?: number): string {
  const c = cutoffMs === undefined ? `dateadd(day, -${HISTORY_DAYS}, current_timestamp())` : `to_timestamp_ltz(${Math.trunc(cutoffMs)}, 3)`
  return `select /* run boundary */ q.session_id, q.start_time, q.end_time
from snowflake.account_usage.query_history q
where q.start_time < ${c} and q.start_time > dateadd(day, -${BOUNDARY_LOOKBACK_DAYS}, ${c})
  and q.end_time >= dateadd(second, -${RUN_GAP_MS / 1000}, ${c})
  and q.execution_status = 'SUCCESS'
  and q.query_type in (${list(SF_TYPES)})
  and contains(q.query_text, ${sqlString(needle)})
order by q.start_time desc limit ${HISTORY_LIMIT}`
}

export function databricksBoundarySql(needle: string, cutoffMs?: number): string {
  const c = cutoffMs === undefined ? `(current_timestamp() - interval ${HISTORY_DAYS} days)` : `timestamp_millis(${Math.trunc(cutoffMs)})`
  return `select /* run boundary */ session_id, start_time, coalesce(end_time, start_time) as end_time
from system.query.history
where start_time < ${c} and start_time > ${c} - interval ${BOUNDARY_LOOKBACK_DAYS} day
  and coalesce(end_time, start_time) >= ${c} - interval ${RUN_GAP_MS / 1000} seconds
  and execution_status = 'FINISHED' and compute.warehouse_id is not null
  and statement_type in (${list(DBX_TYPES)})
  and instr(statement_text, ${sqlString(needle)}) > 0
order by start_time desc limit ${HISTORY_LIMIT}`
}

export function bigqueryBoundarySql(input: { project: string; location?: unknown; needle: string; view?: JobsView; cutoffMs?: number }): string {
  const c = input.cutoffMs === undefined ? `timestamp_sub(current_timestamp(), interval ${HISTORY_DAYS} day)` : `timestamp_millis(${Math.trunc(input.cutoffMs)})`
  return `select /* run boundary */ job_id, creation_time, end_time
from ${bqJobs(input.project, input.location, input.view ?? "JOBS")}
where creation_time < ${c} and creation_time > timestamp_sub(${c}, interval ${BOUNDARY_LOOKBACK_DAYS} day)
  and end_time >= timestamp_sub(${c}, interval ${BQ_ATTACH_MS / 1000} second)
  and job_type = 'QUERY' and state = 'DONE' and error_result is null
  and parent_job_id is null
  and statement_type in (${list(BQ_TYPES)})
  and strpos(query, ${sqlString(input.needle)}) > 0
order by creation_time desc limit ${HISTORY_LIMIT}`
}

/**
 * The account's blended rate actually billed for each day (contract and overage compute together), so a statement is
 * priced at what its day cost. The view lags up to about three days. A day billed in more than one currency has no single rate.
 */
export const SNOWFLAKE_BILLED_RATE_SQL = `select usage_date, sum(usage_in_currency) / nullif(sum(usage), 0) as rate, max(currency) as currency, count(distinct currency) as currencies
from snowflake.organization_usage.usage_in_currency_daily
where account_locator = current_account() and usage_type in ('compute', 'overage-compute')
  and usage_date >= dateadd(day, -${HISTORY_DAYS + 1}, to_date(convert_timezone('UTC', current_timestamp())))
group by usage_date
order by usage_date`

/** The contract rate for each day of the window: the fallback when the billed rates can't be read; it leaves out overage. */
export const SNOWFLAKE_RATE_SQL = `select date, effective_rate, currency from snowflake.organization_usage.rate_sheet_daily
where account_locator = current_account() and usage_type = 'compute' and service_type = 'WAREHOUSE_METERING'
  and date > dateadd(day, -${HISTORY_DAYS + 1}, current_date())
order by date`

const HOUR_US = 3_600_000_000
/** The UTC hour of a timestamp as a whole number of hours since the epoch: independent of the session's time zone. */
const hourOf = (ts: string) => `(unix_micros(${ts}) div ${HOUR_US})`
/** The hours a statement touches: its start hour through the hour holding its last microsecond. */
const hoursOf = (start: string, end: string) =>
  `explode(sequence(${hourOf(start)}, ${hourOf(`timestamp_micros(greatest(unix_micros(${end}) - 1, unix_micros(${start})))`)}))`

/** A statement's task milliseconds that fall in `a.hour`: prorated by overlap, and all of it in its start hour when it has no length. */
const prorated = (a: string) =>
  `case when ${a}.end_time <= ${a}.start_time then (case when ${a}.hour = ${hourOf(`${a}.start_time`)} then coalesce(${a}.ms, 0) else 0 end)
    else cast(coalesce(${a}.ms, 0) as double) * (least(unix_micros(${a}.end_time), (${a}.hour + 1) * ${HOUR_US}) - greatest(unix_micros(${a}.start_time), ${a}.hour * ${HOUR_US}))
         / cast(unix_micros(${a}.end_time) - unix_micros(${a}.start_time) as double) end`

export function databricksHistorySql(needle: string): string {
  return `with q as (
  select statement_id, session_id, compute.warehouse_id as warehouse_id, start_time, coalesce(end_time, start_time) as end_time,
         statement_type, total_task_duration_ms as ms
  from system.query.history
  where start_time > current_timestamp() - interval ${HISTORY_DAYS} days
    and execution_status = 'FINISHED' and compute.warehouse_id is not null
    and statement_type in (${list(DBX_TYPES)})
    and instr(statement_text, ${sqlString(needle)}) > 0
),
q_hours as (
  select q.*, ${hoursOf("start_time", "end_time")} as hour
  from q
),
hours as (select distinct warehouse_id, hour from q_hours),
all_hours as (
  select compute.warehouse_id as warehouse_id, start_time, coalesce(end_time, start_time) as end_time, total_task_duration_ms as ms,
         ${hoursOf("start_time", "coalesce(end_time, start_time)")} as hour
  from system.query.history
  where start_time > current_timestamp() - interval ${HISTORY_DAYS + 1} days and compute.warehouse_id is not null
    and compute.warehouse_id in (select warehouse_id from q)
),
tasks as (
  select a.warehouse_id, a.hour, sum(${prorated("a")}) as task_ms
  from all_hours a join hours h on a.warehouse_id = h.warehouse_id and a.hour = h.hour
  group by 1, 2
),
billed as (
  select u.usage_metadata.warehouse_id as warehouse_id, ${hourOf("u.usage_start_time")} as hour,
         sum(u.usage_quantity) as dbus,
         sum(u.usage_quantity * coalesce(p.pricing.effective_list.default, p.pricing.default)) as usd
  from system.billing.usage u
  join system.billing.list_prices p on p.sku_name = u.sku_name and p.cloud = u.cloud
    and u.usage_start_time >= p.price_start_time and (p.price_end_time is null or u.usage_start_time < p.price_end_time)
  join hours h on u.usage_metadata.warehouse_id = h.warehouse_id and ${hourOf("u.usage_start_time")} = h.hour
  where u.usage_unit = 'DBU' and u.usage_start_time > current_timestamp() - interval ${HISTORY_DAYS + 1} days
  group by 1, 2
),
shares as (select q_hours.*, ${prorated("q_hours")} as share_ms from q_hours)
select s.statement_id, s.session_id, s.start_time, s.end_time, s.statement_type, s.warehouse_id,
       sum(s.share_ms) as total_task_duration_ms,
       sum(b.dbus * s.share_ms / nullif(t.task_ms, 0)) as dbus,
       sum(b.usd * s.share_ms / nullif(t.task_ms, 0)) as usd,
       count(case when b.usd is null or b.dbus is null or coalesce(t.task_ms, 0) = 0 then 1 end) as missing_hours
from shares s
left join tasks t on t.warehouse_id = s.warehouse_id and t.hour = s.hour
left join billed b on b.warehouse_id = s.warehouse_id and b.hour = s.hour
group by s.statement_id, s.session_id, s.start_time, s.end_time, s.statement_type, s.warehouse_id
order by s.start_time desc limit ${HISTORY_LIMIT}`
}

// ---- Running a query through the dbt adapter ----

const jinjaString = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`

/**
 * Inline Jinja that runs `sql` through dbt's own connection (`run_query`) while dbt compiles it and renders every
 * row as JSON text (dates and numbers as strings, nulls as null), since dbt's `tojson` drops what it can't encode.
 * At dbt's parse pass, where `execute` is false, it runs nothing.
 */
export function rowsJinja(sql: string): string {
  const literal = jinjaString(sql.replace(/[\s;]+$/, ""))
  return (
    `{%- if execute -%}{%- set altimate_rows = run_query(${literal}) -%}{%- set altimate_out = [] -%}` +
    `{%- for r in altimate_rows.rows -%}{%- set altimate_row = [] -%}` +
    `{%- for v in r.values() -%}{%- do altimate_row.append(none if v is none else v | string) -%}{%- endfor -%}` +
    `{%- do altimate_out.append(altimate_row) -%}{%- endfor -%}` +
    `{{ tojson({"columns": altimate_rows.column_names | list, "rows": altimate_out}) }}` +
    `{%- else -%}{"columns": [], "rows": []}{%- endif -%}`
  )
}

/** Jinja that renders the fields of the dbt target the BigQuery history is read from. */
export const TARGET_JINJA =
  '{{ tojson({"project": target.get("project"), "execution_project": target.get("execution_project"), "location": target.get("location")}) }}'

export type Row = Record<string, string | null>

export function parseRows(rendered: unknown): Row[] {
  const parsed = typeof rendered === "string" ? JSON.parse(rendered.trim()) : undefined
  if (!parsed || !Array.isArray(parsed.columns) || !Array.isArray(parsed.rows)) throw new Error("the query returned no table")
  const columns: string[] = parsed.columns.map((c: unknown) => String(c).toLowerCase())
  return parsed.rows.map((values: (string | null)[]) => Object.fromEntries(columns.map((c, i) => [c, values[i] ?? null])))
}

// ---- Runs and their statistics ----

export type Stmt = {
  start: number
  end: number
  /** Money, or undefined when the warehouse has not reported it. */
  cost?: number
  /** Usage in the warehouse's own unit. */
  native: number
  /** Whether the statement's cost is known. */
  known: boolean
  /** The session the statement ran in; statements of different sessions are never one run. */
  session?: string | null
  currency?: string
}
export type Run = { start: number; cost: number; native: number; currency?: string }

/** A timestamp as text, read as UTC when it names no zone. */
export function parseTime(value: string | null | undefined): number {
  if (!value) return Number.NaN
  const iso = value.includes("T") ? value : value.replace(" ", "T")
  return Date.parse(/(Z|[+-]\d\d(:?\d\d)?)$/.test(iso.slice(10)) ? iso : `${iso}Z`)
}

/**
 * What lies before the period a history read covers. `cutoff` is the oldest returned statement's start when the read
 * hit its limit, else the start of the window. `stmts` are the matching statements that started before it and ended
 * within the grouping gap of it (they may belong to runs that began earlier); undefined when they could not be read.
 */
export type Boundary = { cutoff: number; stmts?: { session: string | null; start: number; end: number }[] }

/** When the boundary statements can't be read, runs starting this close to the cutoff are not trusted. */
export const BOUNDARY_FALLBACK_MS = 24 * 3_600_000

/**
 * The statements grouped into runs: one run is the statements of one session, sorted by start, where a statement
 * starts no more than ten minutes after the last one ended. Sessions are never merged. A run is unknown, and
 * left out, when any statement's cost is unknown or its statements carry more than one currency. A run that an
 * unread statement before the cutoff may belong to (same session, ending within the gap of the run's start) is dropped.
 */
export function groupRuns(stmts: Stmt[], boundary?: Boundary): { runs: Run[]; skipped: number; dropped: number } {
  const sorted = stmts.filter((s) => Number.isFinite(s.start)).sort((a, b) => a.start - b.start)
  const open = new Map<string, { group: { key: string; stmts: Stmt[] }; end: number }>()
  const groups: { key: string; stmts: Stmt[] }[] = []
  for (const s of sorted) {
    const key = s.session ?? ""
    const current = open.get(key)
    if (!current || s.start - current.end > RUN_GAP_MS) {
      const group = { key, stmts: [s] }
      groups.push(group)
      open.set(key, { group, end: Number.isFinite(s.end) ? s.end : s.start })
    } else {
      current.group.stmts.push(s)
      current.end = Math.max(current.end, Number.isFinite(s.end) ? s.end : s.start)
    }
  }
  const runs: Run[] = []
  let skipped = 0
  let dropped = 0
  for (const { key, stmts: g } of groups) {
    const first = g[0].start
    const unsure = boundary
      ? boundary.stmts
        ? boundary.stmts.some((b) => (b.session ?? "") === key && b.end >= first - RUN_GAP_MS)
        : first <= boundary.cutoff + BOUNDARY_FALLBACK_MS
      : false
    if (unsure) {
      dropped++
      continue
    }
    const currencies = new Set(g.map((s) => s.currency))
    if (!g.every((s) => s.known) || currencies.size > 1) {
      skipped++
      continue
    }
    runs.push({ start: first, cost: g.reduce((t, s) => t + (s.cost ?? 0), 0), native: g.reduce((t, s) => t + s.native, 0), currency: g[0].currency })
  }
  return { runs, skipped, dropped }
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function summarize(runs: Run[]) {
  const latest = runs.reduce((a, b) => (b.start > a.start ? b : a))
  return {
    lastRun: latest.cost,
    typical: median(runs.map((r) => r.cost)),
    highest: Math.max(...runs.map((r) => r.cost)),
    runs: runs.length,
    windowDays: HISTORY_DAYS as 30,
    native: {
      lastRun: latest.native,
      typical: median(runs.map((r) => r.native)),
      highest: Math.max(...runs.map((r) => r.native)),
    },
  }
}

const num = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? undefined : Number.isFinite(Number(v)) ? Number(v) : undefined)

// ---- Pricing per warehouse ----

export type History = {
  cost: CostInfo
  /** BigQuery: whether the project is on capacity pricing; undefined when that could not be told. */
  capacity?: boolean
  /** The model's materialization, when the manifest names it. */
  materialized?: string
  /** The physical relations the model reads, and how many are sources, when the manifest names them. */
  tables?: number
  sources?: number
}

const none = (reason: string, notes: string[] = [], currency = "USD", rate: CostRate | null = null): CostInfo => ({
  basis: "none",
  currency,
  rate,
  notes,
  unknownReason: reason,
})

function emptyMessage(uniqueId: string, table: string): string {
  return `No runs of ${uniqueId} in the last ${HISTORY_DAYS} days were found in ${table} (a project that overrides dbt's query-comment, or a role without access, finds none).`
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** One BigQuery job, or the children of a script, priced as what they are: bytes billed on demand, slot time in a reservation. */
type BqUnit = { start: number; build: boolean; cost: number; known: boolean; bytes: number; slotHours: number; reserved: boolean; demand: boolean }

function bqJob(r: Row, cfg: CostConfig): BqUnit {
  const slot = rateOf(cfg.bigquerySlotHourUsd, DEFAULT_RATES.bigquerySlotHourUsd, "USD/slot-hour", "bigquerySlotHourUsd").rate.value
  const demand = rateOf(cfg.bigqueryUsdPerTib, DEFAULT_RATES.bigqueryUsdPerTib, "USD/TiB", "bigqueryUsdPerTib").rate.value
  const reserved = r.reservation_id !== null && r.reservation_id !== undefined && r.reservation_id !== ""
  const slotHours = (num(r.total_slot_ms) ?? 0) / 3_600_000
  const billed = num(r.total_bytes_billed)
  // A cached result bills nothing; a missing figure (BigQuery hides it for tables under a row access policy) is not a zero.
  const cached = String(r.cache_hit).toLowerCase() === "true"
  const known = reserved || billed !== undefined || cached
  return {
    start: parseTime(r.creation_time),
    build: BQ_BUILD_TYPES.includes(String(r.statement_type)),
    cost: reserved ? slotHours * slot : ((billed ?? 0) / TIB) * demand,
    known,
    bytes: reserved ? 0 : (billed ?? 0),
    slotHours: reserved ? slotHours : 0,
    reserved,
    demand: !reserved,
  }
}

const sumUnits = (start: number, build: boolean, units: BqUnit[]): BqUnit => ({
  start,
  build,
  cost: units.reduce((t, u) => t + u.cost, 0),
  known: units.every((u) => u.known),
  bytes: units.reduce((t, u) => t + u.bytes, 0),
  slotHours: units.reduce((t, u) => t + u.slotHours, 0),
  reserved: units.some((u) => u.reserved),
  demand: units.some((u) => u.demand),
})


/**
 * BigQuery runs: each build job (a script counts as one, priced from its children) is a run; a DELETE or UPDATE
 * joins the next build job of the model within a minute, else is a run of its own.
 */
export function bigqueryRuns(units: BqUnit[], boundary?: Boundary): { runs: BqUnit[]; skipped: number; dropped: number } {
  const builds = units.filter((u) => u.build).sort((a, b) => a.start - b.start)
  const groups = new Map<BqUnit, BqUnit[]>(builds.map((b) => [b, [b]]))
  const alone: BqUnit[][] = []
  for (const u of units.filter((x) => !x.build)) {
    const next = builds.find((b) => b.start >= u.start && b.start - u.start <= BQ_ATTACH_MS)
    if (next) groups.get(next)!.push(u)
    else alone.push([u])
  }
  const all = [...groups.values(), ...alone].map((g) => sumUnits(Math.min(...g.map((u) => u.start)), true, g))
  // An unread job before the cutoff that ended within a minute of a run's start may belong to it (a delete or update
  // that precedes its build): such a run is not trusted.
  const unsure = (r: BqUnit) =>
    boundary ? (boundary.stmts ? boundary.stmts.some((b) => b.end >= r.start - BQ_ATTACH_MS) : r.start <= boundary.cutoff + BOUNDARY_FALLBACK_MS) : false
  const counted = all.filter((r) => !unsure(r))
  const runs = counted.filter((r) => r.known && Number.isFinite(r.start))
  return { runs, skipped: counted.length - runs.length, dropped: all.length - counted.length }
}

export function priceBigquery(rows: Row[], children: Row[] | undefined, uniqueId: string, cfg: CostConfig, boundary?: Boundary): { cost: CostInfo; reserved: boolean } {
  const table = "INFORMATION_SCHEMA.JOBS"
  const demand = rateOf(cfg.bigqueryUsdPerTib, DEFAULT_RATES.bigqueryUsdPerTib, "USD/TiB", "bigqueryUsdPerTib")
  const slot = rateOf(cfg.bigquerySlotHourUsd, DEFAULT_RATES.bigquerySlotHourUsd, "USD/slot-hour", "bigquerySlotHourUsd")
  if (!rows.length) return { cost: none(emptyMessage(uniqueId, table), [], "USD", demand.rate), reserved: false }
  // Children come newest first, up to a limit: a script that started before the oldest child returned may have more.
  const childrenCut = (children?.length ?? 0) >= BQ_CHILD_LIMIT
  const childBoundary = Math.min(...(children ?? []).map((c) => parseTime(c.creation_time)))
  const units = rows.map((r) => {
    if (r.statement_type !== "SCRIPT") return bqJob(r, cfg)
    const kids = (children ?? []).filter((c) => c.parent_job_id === r.job_id).map((c) => bqJob(c, cfg))
    // A script's own row is never counted beside its children; with none found, its cost is not known.
    const start = parseTime(r.creation_time)
    const unit = sumUnits(start, true, kids)
    return kids.length && !(childrenCut && !(start > childBoundary)) ? unit : { ...unit, known: false }
  })
  const truncated = rows.length >= HISTORY_LIMIT
  const { runs, skipped, dropped } = bigqueryRuns(units, boundary)
  const anyReserved = units.some((u) => u.reserved)
  const notes: string[] = truncated ? [LIMIT_NOTE] : []
  if (dropped) notes.push(boundaryNote(dropped))
  if (skipped)
    notes.push(
      `${plural(skipped, "run")} left out: BigQuery gave no bytes billed for ${skipped === 1 ? "it" : "them"} (it hides them for tables under a row access policy), or a script's child jobs were not found.`,
    )
  if (!runs.length)
    return {
      reserved: anyReserved,
      cost: none(`Every run of ${uniqueId} found has a job with no bytes billed (BigQuery hides them for tables under a row access policy) or a script with no child jobs.`, notes, "USD", demand.rate),
    }
  const anyDemand = runs.some((r) => r.demand)
  const allReserved = !anyDemand
  const mixed = runs.some((r) => r.reserved) && anyDemand
  const newest = runs.reduce((a, b) => (b.start > a.start ? b : a))
  const rate = newest.reserved && !newest.demand ? slot.rate : demand.rate
  if (mixed) notes.push("Some runs ran in a reservation (priced by slot time) and some on demand (priced by bytes billed).")
  if (runs.some((r) => r.reserved))
    notes.push(
      `Slot time is attributed at ${slot.rate.value} USD/slot-hour; the bill follows the reservation's baseline, commitments and autoscaling, not each job.`,
    )
  if (anyDemand) notes.push("On-demand jobs are priced by bytes billed, which BigQuery rounds up to at least 10 MiB per query.")
  if (anyDemand && demand.note) notes.push(demand.note)
  if (runs.some((r) => r.reserved) && slot.note) notes.push(slot.note)
  const stats = summarize(runs.map((r) => ({ start: r.start, cost: r.cost, native: allReserved ? r.slotHours : r.bytes })))
  return {
    reserved: anyReserved,
    cost: {
      basis: "history",
      currency: "USD",
      ...stats,
      native: mixed ? undefined : { unit: allReserved ? "slot_hours" : "bytes_billed", ...stats.native },
      rate,
      notes,
    },
  }
}

/** A day's account rate. */
export type SheetRate = { date: string; value: number; currency: string; detail?: "billed" | "contract"; mixed?: boolean }

/** The contract rates (`rate_sheet_daily`). */
export function sheetRates(rows: Row[]): SheetRate[] {
  return rows
    .map((r): SheetRate => ({ date: (r.date ?? "").slice(0, 10), value: num(r.effective_rate) ?? Number.NaN, currency: r.currency || "USD", detail: "contract" }))
    .filter((r) => r.date && r.value > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
}

/** The blended billed rates (`usage_in_currency_daily`); a day in more than one currency is `mixed`. */
export function billedRates(rows: Row[]): SheetRate[] {
  return rows
    .map((r): SheetRate => ({
      date: (r.usage_date ?? "").slice(0, 10),
      value: num(r.rate) ?? Number.NaN,
      currency: r.currency || "USD",
      detail: "billed",
      mixed: (num(r.currencies) ?? 1) > 1,
    }))
    .filter((r) => r.date && (r.mixed || r.value > 0))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
}

/**
 * The rate a Snowflake statement is priced at: a configured rate, else the account's rate for its day (or the nearest
 * earlier day), else the default. `stale` is set when a billed day has no row yet and the latest one is used.
 */
export function snowflakeRateFor(
  day: string,
  sheet: SheetRate[],
  cfg: CostConfig,
): { rate: CostRate; currency: string; note?: string; mixed?: boolean; stale?: string; contract?: boolean } {
  if (cfg.snowflakeUsdPerCredit !== undefined)
    return { rate: { value: cfg.snowflakeUsdPerCredit, unit: "USD/credit", source: "config" }, currency: "USD" }
  let found: SheetRate | undefined
  for (const r of sheet) if (r.date <= day) found = r
  if (found) {
    const detail = found.detail ?? "contract"
    const last = sheet[sheet.length - 1]
    return {
      rate: { value: found.value, unit: `${found.currency}/credit`, source: "account", detail },
      currency: found.currency,
      mixed: found.mixed,
      stale: detail === "billed" && day > last.date ? found.date : undefined,
      contract: detail === "contract",
    }
  }
  const fallback = rateOf(undefined, DEFAULT_RATES.snowflakeUsdPerCredit, "USD/credit", "snowflakeUsdPerCredit")
  return { rate: fallback.rate, currency: "USD", note: fallback.note }
}

/** Snowflake does not attribute a statement shorter than this (ms). */
export const SF_UNATTRIBUTED_MS = 100

export function priceSnowflake(rows: Row[], uniqueId: string, sheet: SheetRate[], cfg: CostConfig, boundary?: Boundary): CostInfo {
  const table = "snowflake.account_usage.query_history"
  if (!rows.length) return none(emptyMessage(uniqueId, table), [], "USD", snowflakeRateFor("9999-12-31", sheet, cfg).rate)
  let cloud = 0
  const defaults = new Set<string>()
  let stale: string | undefined
  let contract = false
  let newest: { start: number; rate: CostRate; currency: string } | undefined
  const stmts: Stmt[] = rows.map((r) => {
    const compute = num(r.credits_attributed_compute)
    const credits = (compute ?? 0) + (num(r.credits_used_query_acceleration) ?? 0)
    cloud += num(r.credits_used_cloud_services) ?? 0
    const { rate, currency, note, mixed, stale: late, contract: fromContract } = snowflakeRateFor(r.start_date_utc ?? "", sheet, cfg)
    if (note) defaults.add(note)
    if (late && (!stale || late > stale)) stale = late
    if (fromContract) contract = true
    const start = parseTime(r.start_time)
    if (!newest || start > newest.start) newest = { start, rate, currency }
    // An unattributed statement is a zero only when it was too short for Snowflake to attribute; otherwise it is still pending.
    const execution = num(r.execution_time)
    // A day billed in more than one currency has no single rate: its statements cannot be priced.
    const known = !mixed && (compute !== undefined || (execution !== undefined && execution < SF_UNATTRIBUTED_MS))
    return { start, end: parseTime(r.end_time), cost: credits * rate.value, native: credits, known, session: r.session_id, currency }
  })
  const truncated = rows.length >= HISTORY_LIMIT
  const { runs, skipped, dropped } = groupRuns(stmts, boundary)
  const currency = newest?.currency ?? "USD"
  const rate = newest?.rate ?? null
  const notes = ["Credits are the warehouse compute attributed to the statements; warehouse idle time is not included."]
  if (cloud > 0)
    notes.push(
      `Cloud-services credits (${Number(cloud.toFixed(4))} over these statements) are not added: Snowflake bills them only above 10% of the day's compute.`,
    )
  notes.push(...defaults)
  if (contract) notes.push("Contract rate; overage not reflected.")
  if (stale) notes.push(`Recent runs priced at the latest billed rate (${stale}): Snowflake's billing view lags up to three days.`)
  if (truncated) notes.push(LIMIT_NOTE)
  if (dropped) notes.push(boundaryNote(dropped))
  if (skipped)
    notes.push(
      `${plural(skipped, "run")} left out: pending attribution (Snowflake lands it up to 8 hours late), or on a day billed in more than one currency.`,
    )
  const sameCurrency = runs.filter((r) => r.currency === currency)
  if (sameCurrency.length < runs.length) notes.push(`Runs priced in a currency other than ${currency} are left out.`)
  if (!sameCurrency.length && !skipped && dropped)
    return none(`Every run of ${uniqueId} found may have started before the period read, so none is priced.`, notes, currency, rate)
  if (!sameCurrency.length)
    return none(
      `${plural(skipped || runs.length, "run")} of ${uniqueId} found cannot be priced yet: Snowflake lands attribution up to 8 hours late (statements under about 100 ms never get one).`,
      notes,
      currency,
      rate,
    )
  const stats = summarize(sameCurrency)
  return { basis: "history", currency, ...stats, native: { unit: "credits", ...stats.native }, rate, notes }
}

export function priceDatabricks(rows: Row[], uniqueId: string, cfg: CostConfig, boundary?: Boundary): CostInfo {
  const table = "system.query.history"
  const configured = cfg.databricksUsdPerDbu
  const stmts: Stmt[] = rows.map((r) => {
    const dbus = num(r.dbus)
    const usd = configured !== undefined ? (dbus === undefined ? undefined : dbus * configured) : num(r.usd)
    const missing = num(r.missing_hours) ?? 0
    return {
      start: parseTime(r.start_time),
      end: parseTime(r.end_time),
      cost: usd ?? 0,
      native: dbus ?? 0,
      known: missing === 0,
      session: r.session_id,
    }
  })
  let rate: CostRate | null = null
  if (configured !== undefined) rate = { value: configured, unit: "USD/DBU", source: "config" }
  else {
    const dbus = stmts.reduce((t, s) => t + (s.known ? s.native : 0), 0)
    const usd = stmts.reduce((t, s) => t + (s.known ? (s.cost ?? 0) : 0), 0)
    if (dbus > 0) rate = { value: usd / dbus, unit: "USD/DBU", source: "list_price" }
  }
  if (!rows.length)
    return none(
      `${emptyMessage(uniqueId, table)} Cost history covers SQL warehouses only: a dbt target on an all-purpose or job cluster has none.`,
      [],
      "USD",
      rate,
    )
  const truncated = rows.length >= HISTORY_LIMIT
  const { runs, skipped, dropped } = groupRuns(stmts, boundary)
  const notes = [
    "Each statement carries its warehouse's billed cost for the hours it ran in, split across each hour's statements by task time, so idle time and overhead are spread over the queries that used the warehouse.",
    configured !== undefined
      ? `DBUs are priced at ${configured} USD/DBU.`
      : "Prices are list prices (with published promotions); negotiated discounts are not applied.",
  ]
  if (truncated) notes.push(LIMIT_NOTE)
  if (dropped) notes.push(boundaryNote(dropped))
  if (skipped)
    notes.push(`${plural(skipped, "run")} left out: the billing rows for ${skipped > 1 ? "their" : "its"} hours have not landed yet.`)
  if (!runs.length && !skipped && dropped)
    return none(`Every run of ${uniqueId} found may have started before the period read, so none is priced.`, notes, "USD", rate)
  if (!runs.length)
    return none(`The ${plural(skipped, "run")} of ${uniqueId} found have no billing rows yet: system.billing.usage lands them late.`, notes, "USD", rate)
  const stats = summarize(runs)
  return { basis: "history", currency: "USD", ...stats, native: { unit: "dbus", ...stats.native }, rate, notes }
}

// ---- BigQuery's pre-run price ----

/**
 * What a scan bills on demand. The dry run is an upper bound on bytes (a clustered table can bill less), so `maxBytes`
 * is the most it reads; each table a query reads bills at least 10 MiB. The charge is therefore at least n x 10 MiB and
 * at most `maxBytes` plus n x 10 MiB (each table's bytes rounded up to the MiB stay within its 10 MiB allowance).
 */
export function onDemandPrice(input: { maxBytes: number; tables: number; usdPerTib: number }): { low: number; high: number } {
  const floor = Math.max(1, input.tables) * BQ_MIN_BILLED_BYTES
  const price = (bytes: number) => (bytes / TIB) * input.usdPerTib
  return { low: price(floor), high: price(input.maxBytes + floor) }
}

export function bigqueryOnDemandRate(cfg: CostConfig) {
  return rateOf(cfg.bigqueryUsdPerTib, DEFAULT_RATES.bigqueryUsdPerTib, "USD/TiB", "bigqueryUsdPerTib")
}

// ---- Reading the answer ----

export function accessProblem(type: string, message: string): string | undefined {
  if (type === "snowflake" && /insufficient privileges|not authorized|does not exist or not authorized|imported privileges/i.test(message))
    return "reading it needs IMPORTED PRIVILEGES on the SNOWFLAKE database (GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE TO ROLE <role>)"
  if (type === "bigquery" && /access denied|permission|not authorized|forbidden/i.test(message))
    return "the role needs bigquery.jobs.listAll on the project to read INFORMATION_SCHEMA.JOBS"
  if (type === "databricks" && /permission|not authorized|insufficient|TABLE_OR_VIEW_NOT_FOUND|schema.*not found|cannot be found/i.test(message))
    return "the role needs SELECT on system.query.history and system.billing (Unity Catalog with those system schemas enabled)"
  return undefined
}

export function unreadable(type: string, message: string): CostInfo {
  const why = accessProblem(type, message)
  return none(`Cost history could not be read${why ? `: ${why}` : ""} (${message.split("\n")[0].slice(0, 300)}).`)
}

export function formatMoney(value: number, currency: string): string {
  const digits = value === 0 ? 2 : Math.min(8, Math.max(2, 1 - Math.floor(Math.log10(Math.abs(value)))))
  const text = value.toFixed(digits)
  return currency === "USD" ? `$${text}` : `${text} ${currency}`
}

const NATIVE_LABEL: Record<NativeUnit, string> = { bytes_billed: "bytes billed", slot_hours: "slot-hours", credits: "credits", dbus: "DBUs" }

function nativeText(n: NonNullable<CostInfo["native"]>): string {
  const f = (v: number | undefined) => (v === undefined ? "-" : n.unit === "bytes_billed" ? String(Math.round(v)) : String(Number(v.toPrecision(4))))
  return `${NATIVE_LABEL[n.unit]}: last ${f(n.lastRun)}, typical ${f(n.typical)}, highest ${f(n.highest)}`
}

/** The cost as plain sentences, the first being the answer (or why there is none). */
export function costText(c: CostInfo): string {
  const lines: string[] = []
  if (c.basis === "history") {
    lines.push(
      `Cost from ${c.runs} run${c.runs === 1 ? "" : "s"} in the last ${c.windowDays} days: last run ${formatMoney(c.lastRun!, c.currency)}, typical ${formatMoney(c.typical!, c.currency)} (median), highest ${formatMoney(c.highest!, c.currency)}.`,
    )
    if (c.native) lines.push(`In the warehouse's own unit, ${nativeText(c.native)}.`)
  } else if (c.basis === "dry_run") {
    const { low, high } = c.selectOnly!
    lines.push(
      `The SELECT would bill at most ${formatMoney(high, c.currency)} on-demand (at least ${formatMoney(low, c.currency)}; pruning of clustered or partitioned tables can bill less than the dry run).`,
    )
  } else {
    lines.push(`Cost unknown: ${c.unknownReason}`)
  }
  if (c.rate) lines.push(`Rate: ${c.rate.value} ${c.rate.unit} (${c.rate.source === "account" ? `from your account${c.rate.detail ? ` (${c.rate.detail})` : ""}` : { list_price: "list price", config: "from your config", default: "default" }[c.rate.source]}).`)
  for (const n of c.notes) lines.push(n)
  return lines.join("\n")
}

// ---- Reading the history ----

/** Test seams. */
export const costHistoryInternals = {
  /** How long the history queries together wait for the warehouse; a slower one is no history, and the scan figure stands. */
  historyTimeoutMs: 60_000,
  /** The `cost` block of the config. */
  readCostConfig: async (): Promise<unknown> => {
    try {
      const { Config } = await import("@/config/config")
      return (await Config.get())?.cost
    } catch {
      return undefined
    }
  },
}

type Compiler = { unsafeCompileQuery(sql: string, model?: string): Promise<unknown> }

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * What the model's earlier runs cost and, on BigQuery, whether the project is on capacity pricing. The queries run one
 * after another (the Python bridge serialises adapter calls) inside one deadline, and after the scan figure is
 * computed. Never rejects except for a cancelled call: a failure is an answer with no cost and the reason.
 */
export async function loadHistory(input: {
  adapter: Compiler
  type: string
  model?: string
  manifestPath?: string
  signal: AbortSignal
  cfg: CostConfig
}): Promise<History> {
  const { adapter, type, signal, cfg } = input
  const deadline = new AbortController()
  const ms = costHistoryInternals.historyTimeoutMs
  const timer = setTimeout(() => deadline.abort(new Error(`the cost history did not answer within ${ms / 1000} s`)), ms)
  const both = AbortSignal.any([signal, deadline.signal])
  const run = <T>(start: () => Promise<T>): Promise<T> => {
    both.throwIfAborted()
    return new Promise<T>((resolve, reject) => {
      const stop = () => reject(both.reason)
      both.addEventListener("abort", stop, { once: true })
      start().then(resolve, reject).finally(() => both.removeEventListener("abort", stop))
    })
  }
  const rows = (sql: string) => run(async () => parseRows(await adapter.unsafeCompileQuery(rowsJinja(sql), undefined)))
  let uniqueId: string | undefined
  let materialized: string | undefined
  let tables: number | undefined
  let sources: number | undefined
  let unavailable: string | undefined
  if (!input.model) unavailable = "A SQL input has no run history; pass a model to price its earlier runs."
  else if (!input.manifestPath) unavailable = "No dbt manifest was found, so the model's unique_id is unknown."
  else {
    const found = modelFromManifest(input.manifestPath, input.model)
    if ("error" in found) unavailable = `Cost history needs the model's unique_id: ${found.error}.`
    else ({ uniqueId, materialized, tables, sources } = found)
  }
  const base = { materialized, tables, sources }
  /**
   * The matching statements just before the period `read` covers: the history read's own cutoff when it hit its
   * limit, else the start of the window. A boundary that can't be read (or hit its limit) is unknown.
   */
  const boundaryFor = async (read: Row[], startKey: string, sqlFor: (cutoffMs?: number) => string): Promise<Boundary | undefined> => {
    if (!read.length) return undefined
    const starts = read.map((r) => parseTime(r[startKey])).filter(Number.isFinite)
    const hit = read.length >= HISTORY_LIMIT && starts.length > 0
    const cutoffMs = hit ? Math.min(...starts) : undefined
    const cutoff = cutoffMs ?? Date.now() - HISTORY_DAYS * 86_400_000
    try {
      // One millisecond past the cutoff: a statement within the same millisecond as the oldest one read is not missed.
      const found = await rows(sqlFor(cutoffMs === undefined ? undefined : cutoffMs + 1))
      if (found.length >= HISTORY_LIMIT) return { cutoff }
      return {
        cutoff,
        stmts: found.map((r) => ({ session: r.session_id ?? null, start: parseTime(r[startKey]), end: parseTime(r.end_time) })),
      }
    } catch (e) {
      if (signal.aborted) throw e
      return { cutoff }
    }
  }
  try {
    if (type === "bigquery") return { ...(await bigqueryHistory()), ...base }
    if (!uniqueId) return { cost: none(unavailable!), ...base }
    if (type === "snowflake") {
      const needle = needleFor(uniqueId)
      const history = await rows(snowflakeHistorySql(needle))
      const boundary = await boundaryFor(history, "start_time", (c) => snowflakeBoundarySql(needle, c))
      // Without the rate sheet (it needs the organization account) the configured or default rate prices the credits.
      let sheet = await rows(SNOWFLAKE_BILLED_RATE_SQL).then(billedRates, () => [] as SheetRate[])
      if (!sheet.length) sheet = await rows(SNOWFLAKE_RATE_SQL).then(sheetRates, () => [] as SheetRate[])
      return { cost: priceSnowflake(history, uniqueId, sheet, cfg, boundary), ...base }
    }
    const needle = needleFor(uniqueId)
    const history = await rows(databricksHistorySql(needle))
    const boundary = await boundaryFor(history, "start_time", (c) => databricksBoundarySql(needle, c))
    return { cost: priceDatabricks(history, uniqueId, cfg, boundary), ...base }
  } catch (e) {
    if (signal.aborted) throw e
    return { cost: unreadable(type, message(e)), ...base }
  } finally {
    clearTimeout(timer)
  }

  async function bigqueryHistory(): Promise<Omit<History, "materialized" | "tables" | "sources">> {
    let target: Record<string, unknown>
    try {
      target = JSON.parse(String(await run(() => adapter.unsafeCompileQuery(TARGET_JINJA, undefined))).trim())
    } catch (e) {
      if (signal.aborted) throw e
      return { cost: none(unavailable ?? `The dbt target could not be read (${message(e)}).`) }
    }
    const project = bqProject(target.execution_project || target.project)
    if (!project) return { cost: none(unavailable ?? "The dbt target names no usable BigQuery project.") }
    const location = target.location
    // A role that may not list every user's jobs is retried on its own: the answer then covers only its own runs.
    const read = async (sqlFor: (view: JobsView) => string): Promise<{ rows: Row[]; own: boolean; view: JobsView }> => {
      try {
        return { rows: await rows(sqlFor("JOBS")), own: false, view: "JOBS" }
      } catch (e) {
        if (signal.aborted || !accessProblem("bigquery", message(e))) throw e
        try {
          return { rows: await rows(sqlFor("JOBS_BY_USER")), own: true, view: "JOBS_BY_USER" }
        } catch {
          throw e
        }
      }
    }
    let pricing: boolean | undefined
    try {
      const { rows: seen } = await read((view) => bigqueryCapacitySql({ project, location, view }))
      const reserved = num(seen[0]?.reserved) ?? 0
      pricing = reserved > 0 ? true : (num(seen[0]?.jobs) ?? 0) > 0 ? false : undefined
    } catch (e) {
      if (signal.aborted) throw e
    }
    if (!uniqueId) return { cost: none(unavailable!), capacity: pricing }
    const id = uniqueId
    let cost: CostInfo
    let reserved = false
    try {
      const history = await read((view) => bigqueryHistorySql({ project, location, needle: needleFor(id), view }))
      const parents = history.rows.filter((r) => r.statement_type === "SCRIPT" && r.job_id).map((r) => r.job_id!)
      const children = parents.length
        ? (await read((view) => bigqueryChildrenSql({ project, location, parents, view }))).rows
        : undefined
      // The boundary is read from the view the history came from.
      const boundary = await boundaryFor(history.rows, "creation_time", (cutoffMs) =>
        bigqueryBoundarySql({ project, location, needle: needleFor(id), view: history.view, cutoffMs }),
      )
      ;({ cost, reserved } = priceBigquery(history.rows, children, uniqueId, cfg, boundary))
      if (history.own) cost.notes.push("Only your own runs were read: the role cannot list every user's jobs.")
    } catch (e) {
      if (signal.aborted) throw e
      cost = unreadable(type, message(e))
    }
    return { cost, capacity: reserved ? true : pricing }
  }
}
