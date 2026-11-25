import path from "path"
import { sanitizeBqRegion } from "../native/finops/bq-utils"
import { loadRawManifest } from "../native/dbt/helpers"

/** What a model's previous runs cost, read from the warehouse's own billing tables, and the rates that turn usage into money. */

export const HISTORY_DAYS = 30
export const HISTORY_LIMIT = 500
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

export type CostRate = { value: number; unit: string; source: "account" | "list_price" | "config" | "default" }
export type NativeUnit = "bytes_billed" | "slot_hours" | "credits" | "dbus"

export type CostInfo = {
  basis: "history" | "dry_run" | "none"
  currency: string
  lastRun?: number
  typical?: number
  highest?: number
  runs?: number
  windowDays?: 30
  selectOnly?: number
  native?: { unit: NativeUnit; lastRun?: number; typical?: number; highest?: number }
  rate: CostRate | null
  notes: string[]
  unknownReason?: string
}

/** The config's rates that are usable numbers. */
export function cleanRates(raw: unknown): CostConfig {
  const out: CostConfig = {}
  if (!raw || typeof raw !== "object") return out
  for (const key of ["bigqueryUsdPerTib", "bigquerySlotHourUsd", "snowflakeUsdPerCredit", "databricksUsdPerDbu"] as const) {
    const v = (raw as Record<string, unknown>)[key]
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

export type ModelRef = { uniqueId: string; materialized?: string }

/**
 * The one model node a name stands for: a unique_id, a plain name, or a package-qualified or versioned
 * name (`shop.orders`, `orders.v2`). Several nodes, or none, is an error that names them.
 */
export function resolveModel(nodes: Record<string, any>, name: string): ModelRef | { error: string } {
  const models = Object.entries(nodes).filter(([, n]) => n?.resource_type === "model")
  let hits = models.filter(([id]) => id === name)
  if (!hits.length) hits = models.filter(([, n]) => n.name === name)
  if (!hits.length && name.includes(".")) hits = models.filter(([id]) => id.endsWith(`.${name}`))
  if (hits.length === 1) return { uniqueId: hits[0][0], materialized: hits[0][1]?.config?.materialized }
  if (hits.length === 0) return { error: `no model named ${name} in the manifest` }
  const ids = hits.map(([id]) => id).sort()
  return { error: `${name} is ambiguous: it matches ${ids.join(", ")}; pass a unique_id` }
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
  return resolveModel(manifest.nodes, name)
}

export function manifestPathFor(adapter: any, projectRoot: string | undefined): string | undefined {
  const given = typeof adapter.getManifestPath === "function" ? adapter.getManifestPath() : undefined
  if (typeof given === "string" && given) return given
  const root = (typeof adapter.getProjectRoot === "function" ? adapter.getProjectRoot() : undefined) ?? projectRoot
  return root ? path.join(root, "target", "manifest.json") : undefined
}

// ---- History SQL ----

const BQ_TYPES = ["CREATE_TABLE_AS_SELECT", "CREATE_TABLE", "CREATE_VIEW", "INSERT", "MERGE", "DELETE", "UPDATE", "SCRIPT"]
const SF_TYPES = [...BQ_TYPES.slice(0, 7), "MULTI_STATEMENT"]
const DBX_TYPES = ["CREATE", "INSERT", "MERGE", "DELETE", "UPDATE", "REPLACE", "COPY"]
const list = (xs: string[]) => xs.map((x) => `'${x}'`).join(",")

/** A BigQuery project id as a backtick-quoted name, or undefined when it holds anything a name can't. */
export function bqProject(project: unknown): string | undefined {
  return typeof project === "string" && /^[A-Za-z0-9_.:-]+$/.test(project) ? project : undefined
}

function bqJobs(project: string, location: unknown): string {
  return `\`${project}\`.\`region-${sanitizeBqRegion(location)}\`.INFORMATION_SCHEMA.JOBS`
}

export function bigqueryHistorySql(input: { project: string; location?: unknown; needle: string }): string {
  return `select job_id, creation_time, end_time, statement_type, total_bytes_billed, total_slot_ms, reservation_id, cache_hit
from ${bqJobs(input.project, input.location)}
where creation_time > timestamp_sub(current_timestamp(), interval ${HISTORY_DAYS} day)
  and job_type = 'QUERY' and state = 'DONE' and error_result is null
  and parent_job_id is null
  and statement_type in (${list(BQ_TYPES)})
  and strpos(query, ${sqlString(input.needle)}) > 0
order by creation_time desc limit ${HISTORY_LIMIT}`
}

/** Whether any query in the project ran in a reservation in the last week. */
export function bigqueryCapacitySql(input: { project: string; location?: unknown }): string {
  return `select countif(reservation_id is not null) as reserved
from ${bqJobs(input.project, input.location)}
where creation_time > timestamp_sub(current_timestamp(), interval 7 day)
  and job_type = 'QUERY' and state = 'DONE'`
}

export function snowflakeHistorySql(needle: string): string {
  return `select q.query_id, q.start_time, q.end_time, q.query_type, q.warehouse_name, q.warehouse_size,
       a.credits_attributed_compute, a.credits_used_query_acceleration, q.credits_used_cloud_services
from snowflake.account_usage.query_history q
left join snowflake.account_usage.query_attribution_history a on a.query_id = q.query_id
where q.start_time > dateadd(day, -${HISTORY_DAYS}, current_timestamp())
  and q.execution_status = 'SUCCESS'
  and q.query_type in (${list(SF_TYPES)})
  and contains(q.query_text, ${sqlString(needle)})
order by q.start_time desc limit ${HISTORY_LIMIT}`
}

export const SNOWFLAKE_RATE_SQL = `select effective_rate, currency from snowflake.organization_usage.rate_sheet_daily
where account_locator = current_account() and usage_type = 'compute' and service_type = 'WAREHOUSE_METERING'
order by date desc limit 1`

export function databricksHistorySql(needle: string): string {
  return `with q as (
  select statement_id, compute.warehouse_id as warehouse_id, start_time, end_time, statement_type, total_task_duration_ms
  from system.query.history
  where start_time > current_timestamp() - interval ${HISTORY_DAYS} days
    and execution_status = 'FINISHED' and compute.warehouse_id is not null
    and statement_type in (${list(DBX_TYPES)})
    and instr(statement_text, ${sqlString(needle)}) > 0
),
hours as (select distinct warehouse_id, date_trunc('HOUR', start_time) as hour from q),
tasks as (
  select h.warehouse_id, h.hour, sum(a.total_task_duration_ms) as task_ms
  from system.query.history a join hours h
    on a.compute.warehouse_id = h.warehouse_id and date_trunc('HOUR', a.start_time) = h.hour
  where a.start_time > current_timestamp() - interval ${HISTORY_DAYS + 1} days
  group by 1, 2
),
billed as (
  select u.usage_metadata.warehouse_id as warehouse_id, date_trunc('HOUR', u.usage_start_time) as hour,
         sum(u.usage_quantity) as dbus, sum(u.usage_quantity * p.pricing.default) as usd
  from system.billing.usage u
  join system.billing.list_prices p on p.sku_name = u.sku_name and p.cloud = u.cloud
    and u.usage_start_time >= p.price_start_time and (p.price_end_time is null or u.usage_start_time < p.price_end_time)
  join hours h on u.usage_metadata.warehouse_id = h.warehouse_id and date_trunc('HOUR', u.usage_start_time) = h.hour
  where u.usage_unit = 'DBU' and u.usage_start_time > current_timestamp() - interval ${HISTORY_DAYS + 1} days
  group by 1, 2
)
select q.statement_id, q.start_time, q.end_time, q.statement_type, q.warehouse_id, q.total_task_duration_ms,
       b.dbus * q.total_task_duration_ms / nullif(t.task_ms, 0) as dbus,
       b.usd  * q.total_task_duration_ms / nullif(t.task_ms, 0) as usd
from q
join tasks t on t.warehouse_id = q.warehouse_id and t.hour = date_trunc('HOUR', q.start_time)
left join billed b on b.warehouse_id = q.warehouse_id and b.hour = date_trunc('HOUR', q.start_time)
order by q.start_time desc limit ${HISTORY_LIMIT}`
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
}
export type Run = { start: number; cost: number; native: number }

/** A timestamp as text, read as UTC when it names no zone. */
export function parseTime(value: string | null | undefined): number {
  if (!value) return Number.NaN
  const iso = value.includes("T") ? value : value.replace(" ", "T")
  return Date.parse(/(Z|[+-]\d\d(:?\d\d)?)$/.test(iso.slice(10)) ? iso : `${iso}Z`)
}

/**
 * The statements grouped into runs: sorted by start, a new run starts when a statement starts more than ten
 * minutes after the last one ended. A run is left out when `need` is "all" and any statement's cost is unknown,
 * or "any" and none is known.
 */
export function groupRuns(stmts: Stmt[], need: "all" | "any"): { runs: Run[]; skipped: number } {
  const sorted = stmts.filter((s) => Number.isFinite(s.start)).sort((a, b) => a.start - b.start)
  const groups: Stmt[][] = []
  let end = Number.NEGATIVE_INFINITY
  for (const s of sorted) {
    if (!groups.length || s.start - end > RUN_GAP_MS) groups.push([])
    groups[groups.length - 1].push(s)
    end = Math.max(end, Number.isFinite(s.end) ? s.end : s.start)
  }
  const runs: Run[] = []
  let skipped = 0
  for (const g of groups) {
    const complete = need === "all" ? g.every((s) => s.known) : g.some((s) => s.known)
    if (!complete) {
      skipped++
      continue
    }
    runs.push({ start: g[0].start, cost: g.reduce((t, s) => t + (s.cost ?? 0), 0), native: g.reduce((t, s) => t + s.native, 0) })
  }
  return { runs, skipped }
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

export function priceBigquery(rows: Row[], uniqueId: string, cfg: CostConfig): { cost: CostInfo; reserved: boolean } {
  const table = "INFORMATION_SCHEMA.JOBS"
  const demand = rateOf(cfg.bigqueryUsdPerTib, DEFAULT_RATES.bigqueryUsdPerTib, "USD/TiB", "bigqueryUsdPerTib")
  const slot = rateOf(cfg.bigquerySlotHourUsd, DEFAULT_RATES.bigquerySlotHourUsd, "USD/slot-hour", "bigquerySlotHourUsd")
  if (!rows.length) return { cost: none(emptyMessage(uniqueId, table), [], "USD", demand.rate), reserved: false }
  const jobs = rows.map((r) => {
    const reserved = r.reservation_id !== null && r.reservation_id !== ""
    const billed = num(r.total_bytes_billed) ?? 0
    const slotHours = (num(r.total_slot_ms) ?? 0) / 3_600_000
    return {
      reserved,
      stmt: {
        start: parseTime(r.creation_time),
        end: parseTime(r.end_time),
        cost: reserved ? slotHours * slot.rate.value : (billed / TIB) * demand.rate.value,
        native: reserved ? slotHours : billed,
        known: true,
      } satisfies Stmt,
    }
  })
  const anyReserved = jobs.some((j) => j.reserved)
  const allReserved = jobs.every((j) => j.reserved)
  const { runs } = groupRuns(jobs.map((j) => j.stmt), "all")
  const newest = jobs.reduce((a, b) => (b.stmt.start > a.stmt.start ? b : a))
  const rate = newest.reserved ? slot.rate : demand.rate
  const notes: string[] = []
  if (anyReserved && !allReserved) notes.push("Some runs ran in a reservation (priced by slot time) and some on demand (priced by bytes billed).")
  if (anyReserved)
    notes.push(
      `Slot time is attributed at ${slot.rate.value} USD/slot-hour; the bill follows the reservation's baseline, commitments and autoscaling, not each job.`,
    )
  if (!allReserved) notes.push("On-demand jobs are priced by bytes billed, which BigQuery rounds up to at least 10 MiB per query.")
  if (!allReserved && demand.note) notes.push(demand.note)
  if (anyReserved && slot.note) notes.push(slot.note)
  const stats = summarize(runs)
  const mixed = anyReserved && !allReserved
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

export function priceSnowflake(rows: Row[], uniqueId: string, rate: CostRate, currency: string, rateNote?: string): CostInfo {
  const table = "snowflake.account_usage.query_history"
  if (!rows.length) return none(emptyMessage(uniqueId, table), [], currency, rate)
  let cloud = 0
  const stmts: Stmt[] = rows.map((r) => {
    const compute = num(r.credits_attributed_compute)
    const credits = (compute ?? 0) + (num(r.credits_used_query_acceleration) ?? 0)
    cloud += num(r.credits_used_cloud_services) ?? 0
    return { start: parseTime(r.start_time), end: parseTime(r.end_time), cost: credits * rate.value, native: credits, known: compute !== undefined }
  })
  const { runs, skipped } = groupRuns(stmts, "any")
  const notes = ["Credits are the warehouse compute attributed to the statements; warehouse idle time is not included."]
  if (cloud > 0)
    notes.push(
      `Cloud-services credits (${Number(cloud.toFixed(4))} over these statements) are not added: Snowflake bills them only above 10% of the day's compute.`,
    )
  if (rateNote) notes.push(rateNote)
  if (skipped)
    notes.push(
      `${skipped} run${skipped > 1 ? "s" : ""} left out: Snowflake has not attributed their queries yet (it skips queries under about 100 ms and lands attribution up to 8 hours late).`,
    )
  if (!runs.length)
    return none(
      `The ${skipped} run${skipped > 1 ? "s" : ""} of ${uniqueId} found have no query attribution yet: Snowflake lands it up to 8 hours late and skips queries under about 100 ms.`,
      notes,
      currency,
      rate,
    )
  return { basis: "history", currency, ...summarize(runs), native: { unit: "credits", ...summarize(runs).native }, rate, notes }
}

export function priceDatabricks(rows: Row[], uniqueId: string, cfg: CostConfig): CostInfo {
  const table = "system.query.history"
  const configured = cfg.databricksUsdPerDbu
  const stmts: Stmt[] = rows.map((r) => {
    const dbus = num(r.dbus)
    const usd = configured !== undefined ? (dbus === undefined ? undefined : dbus * configured) : num(r.usd)
    return { start: parseTime(r.start_time), end: parseTime(r.end_time), cost: usd, native: dbus ?? 0, known: usd !== undefined && dbus !== undefined }
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
  const { runs, skipped } = groupRuns(stmts, "all")
  const notes = [
    "Each statement carries its warehouse's billed cost for the hour it started, split across that hour's statements by task time, so idle time and overhead are spread over the queries that used the warehouse.",
    configured !== undefined ? `DBUs are priced at ${configured} USD/DBU.` : "Prices are list prices; your discount is not applied.",
  ]
  if (skipped)
    notes.push(
      `${skipped} run${skipped > 1 ? "s" : ""} left out: the billing rows for ${skipped > 1 ? "their" : "its"} hour have not landed yet.`,
    )
  if (!runs.length)
    return none(`The ${skipped} run${skipped > 1 ? "s" : ""} of ${uniqueId} found have no billing rows yet: system.billing.usage lands them late.`, notes, "USD", rate)
  const stats = summarize(runs)
  return { basis: "history", currency: "USD", ...stats, native: { unit: "dbus", ...stats.native }, rate, notes }
}

/** The Snowflake rate: the account's rate sheet, else the configured rate, else the default. */
export function snowflakeRate(sheet: Row | undefined, cfg: CostConfig): { rate: CostRate; currency: string; note?: string } {
  const effective = num(sheet?.effective_rate)
  if (effective !== undefined && effective > 0)
    return { rate: { value: effective, unit: `${sheet?.currency || "USD"}/credit`, source: "account" }, currency: sheet?.currency || "USD" }
  const fallback = rateOf(cfg.snowflakeUsdPerCredit, DEFAULT_RATES.snowflakeUsdPerCredit, "USD/credit", "snowflakeUsdPerCredit")
  return { rate: fallback.rate, currency: "USD", note: fallback.note }
}

// ---- BigQuery's pre-run price ----

/** The on-demand price of a scan: BigQuery bills at least 10 MiB per query. */
export function onDemandPrice(bytes: number, usdPerTib: number): number {
  return (Math.max(bytes, BQ_MIN_BILLED_BYTES) / TIB) * usdPerTib
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
    lines.push(`Cost of the SELECT alone, from the dry run: ${formatMoney(c.selectOnly!, c.currency)}.`)
  } else {
    lines.push(`Cost unknown: ${c.unknownReason}`)
  }
  if (c.rate) lines.push(`Rate: ${c.rate.value} ${c.rate.unit} (${{ account: "from your account", list_price: "list price", config: "from your config", default: "default" }[c.rate.source]}).`)
  for (const n of c.notes) lines.push(n)
  return lines.join("\n")
}

// ---- Reading the history ----

/** Test seams. */
export const costHistoryInternals = {
  /** How long the history queries wait for the warehouse; a slower one is no history, and the pre-run figure stands. */
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

async function within<T>(start: () => Promise<T>, signal: AbortSignal, ms: number, what: string): Promise<T> {
  signal.throwIfAborted()
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new Error(`${what} did not answer within ${ms / 1000} s`)), ms)
  const both = AbortSignal.any([signal, deadline.signal])
  try {
    return await new Promise<T>((resolve, reject) => {
      const stop = () => reject(both.reason)
      both.addEventListener("abort", stop, { once: true })
      start().then(resolve, reject).finally(() => both.removeEventListener("abort", stop))
    })
  } finally {
    clearTimeout(timer)
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * What the model's earlier runs cost and, on BigQuery, whether the project is on capacity pricing. Never rejects
 * except for a cancelled call: a failure is an answer with no cost and the reason.
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
  const ms = costHistoryInternals.historyTimeoutMs
  const rows = (sql: string, what: string) =>
    within(async () => parseRows(await adapter.unsafeCompileQuery(rowsJinja(sql), undefined)), signal, ms, what)
  const unwrap = async (): Promise<History> => {
    let uniqueId: string | undefined
    let materialized: string | undefined
    let unavailable: string | undefined
    if (!input.model) unavailable = "A SQL input has no run history; pass a model to price its earlier runs."
    else if (!input.manifestPath) unavailable = "No dbt manifest was found, so the model's unique_id is unknown."
    else {
      const found = modelFromManifest(input.manifestPath, input.model)
      if ("error" in found) unavailable = `Cost history needs the model's unique_id: ${found.error}.`
      else ({ uniqueId, materialized } = found)
    }
    if (type === "bigquery") {
      let target: Record<string, unknown> = {}
      try {
        target = JSON.parse(String(await within(() => adapter.unsafeCompileQuery(TARGET_JINJA, undefined), signal, ms, "the dbt target")).trim())
      } catch (e) {
        if (signal.aborted) throw e
        return { cost: none(unavailable ?? `The dbt target could not be read (${message(e)}).`), materialized }
      }
      const project = bqProject(target.execution_project || target.project)
      if (!project) return { cost: none(unavailable ?? "The dbt target names no usable BigQuery project."), materialized }
      const [history, capacity] = await Promise.allSettled([
        uniqueId ? rows(bigqueryHistorySql({ project, location: target.location, needle: needleFor(uniqueId) }), "INFORMATION_SCHEMA.JOBS") : Promise.reject(undefined),
        rows(bigqueryCapacitySql({ project, location: target.location }), "INFORMATION_SCHEMA.JOBS"),
      ])
      if (signal.aborted) throw signal.reason
      const checked = capacity.status === "fulfilled" ? num(capacity.value[0]?.reserved) : undefined
      let cost: CostInfo
      let reserved = false
      if (!uniqueId) cost = none(unavailable!)
      else if (history.status === "fulfilled") ({ cost, reserved } = priceBigquery(history.value, uniqueId, cfg))
      else cost = unreadable(type, message(history.reason))
      return { cost, capacity: reserved || (checked === undefined ? undefined : checked > 0), materialized }
    }
    if (!uniqueId) return { cost: none(unavailable!), materialized }
    try {
      if (type === "snowflake") {
        const [history, sheet] = await Promise.allSettled([
          rows(snowflakeHistorySql(needleFor(uniqueId)), "query_history"),
          rows(SNOWFLAKE_RATE_SQL, "the rate sheet"),
        ])
        if (signal.aborted) throw signal.reason
        if (history.status === "rejected") throw history.reason
        const { rate, currency, note } = snowflakeRate(sheet.status === "fulfilled" ? sheet.value[0] : undefined, cfg)
        return { cost: priceSnowflake(history.value, uniqueId, rate, currency, note), materialized }
      }
      return { cost: priceDatabricks(await rows(databricksHistorySql(needleFor(uniqueId)), "system.query.history"), uniqueId, cfg), materialized }
    } catch (e) {
      if (signal.aborted) throw e
      return { cost: unreadable(type, message(e)), materialized }
    }
  }
  return unwrap()
}
