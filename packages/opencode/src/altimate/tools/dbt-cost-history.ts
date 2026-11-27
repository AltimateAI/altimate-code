import path from "path"
import { sanitizeBqRegion } from "../native/finops/bq-utils"
import { loadRawManifest } from "../native/dbt/helpers"

/** What a model's previous runs cost, read from the warehouse's own billing tables, and the rates that turn usage into money. */

export const HISTORY_DAYS = 30
export const HISTORY_LIMIT = 500
const DAY_MS = 86_400_000
/** INFORMATION_SCHEMA.JOBS keeps the last 180 days of jobs (BigQuery's documented retention): the furthest back any read can reach. */
export const JOBS_RETENTION_DAYS = 180
/** The start of a read's window: `days` before the instant the whole call reads as of. */
export const windowStartMs = (asOfMs: number, days = HISTORY_DAYS) => asOfMs - days * DAY_MS
/** A matched job by the same user joins the run of the job before it when it starts within this long after that job ended. */
export const BQ_CHAIN_MS = 60_000
/** The largest rate the tool uses, in USD; a larger configured value is ignored and named. */
export const MAX_RATE = 1e6
/** The most child jobs of matched scripts the children query returns. */
export const BQ_CHILD_LIMIT = 10000
const LIMIT_NOTE = `Only the newest ${HISTORY_LIMIT} statements were read, so older runs are not counted.`
const boundaryNote = (dropped: number) =>
  `${dropped} run${dropped === 1 ? "" : "s"} that may have started before the period read ${dropped === 1 ? "was" : "were"} left out.`
const TIB = 1024 ** 4

export type CostConfig = {
  bigqueryUsdPerTib?: number
  bigquerySlotHourUsd?: number
}

export const DEFAULT_RATES = { bigqueryUsdPerTib: 6.25, bigquerySlotHourUsd: 0.06 }

export type CostRate = {
  value: number
  unit: string
  source: "config" | "default"
}
export type NativeUnit = "bytes_billed" | "slot_hours"

export type CostInfo = {
  basis: "history" | "dry_run" | "none"
  currency: "USD"
  lastRun?: number
  typical?: number
  highest?: number
  runs?: number
  windowDays?: 30
  /** BigQuery on-demand: the dry run's bytes (at least BigQuery's 10 MiB per-query minimum) at the on-demand rate, `estimate`. It is an estimate, not a bound: a cached or BI Engine result bills nothing, and external sources and some queries are not fully counted. */
  selectOnly?: { estimate: number }
  /** `user`: only the caller's own jobs were read (no bigquery.jobs.listAll); `project`: every user's. */
  scope?: "user" | "project"
  /** How the history was priced: attributed slot time for reservation runs, bytes billed on demand, or both. */
  attribution?: "slot_time" | "bytes_billed" | "mixed"
  /** The dbt target the statistics are of, when the runs could be told apart by target. */
  target?: string
  /** Runs of other targets (and of an unknown one), left out of the statistics. */
  otherTargets?: {
    target: string
    runs: number
    typical: number
    /** How its runs were priced, and the rate behind `typical` (the on-demand rate; `slotRate` too when the runs mix both). */
    attribution: "slot_time" | "bytes_billed" | "mixed"
    rate: CostRate
    slotRate?: CostRate
  }[]
  native?: { unit: NativeUnit; lastRun?: number; typical?: number; highest?: number }
  rate: CostRate | null
  notes: string[]
  unknownReason?: string
}

const RATE_KEYS = ["bigqueryUsdPerTib", "bigquerySlotHourUsd"] as const
const usableRate = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= MAX_RATE

/** The config's rates that are usable numbers: positive, finite and at most MAX_RATE. */
export function cleanRates(raw: unknown): CostConfig {
  const out: CostConfig = {}
  if (!raw || typeof raw !== "object") return out
  const given: Record<string, unknown> = { ...raw }
  for (const key of RATE_KEYS) {
    const v = given[key]
    if (usableRate(v)) out[key] = v
  }
  return out
}

/** A note for each configured rate that `cleanRates` ignores, so a default is never taken for the configured value. */
export function ignoredRateNotes(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return []
  const given: Record<string, unknown> = { ...raw }
  return RATE_KEYS.filter((key) => given[key] !== undefined && !usableRate(given[key])).map(
    (key) => `cost.${key} is ignored: it must be a positive number up to ${MAX_RATE}; the default rate is used.`,
  )
}

function rateOf(config: number | undefined, fallback: number, unit: string, key: string): { rate: CostRate; note?: string } {
  if (config !== undefined) return { rate: { value: config, unit, source: "config" } }
  return {
    rate: { value: fallback, unit, source: "default" },
    note: `Rate ${fallback} ${unit} is a default rate${key === "bigquerySlotHourUsd" ? " (BigQuery Enterprise pay-as-you-go; Standard is 0.04)" : ""}; set cost.${key} to your contract rate.`,
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

export type ModelRef = { uniqueId: string; materialized?: string; language?: string }

/**
 * The one model node a name stands for: a unique_id, a plain name, or a package-qualified or versioned
 * name (`shop.orders`, `orders.v2`). Several nodes, or none, is an error that names them.
 */
export function resolveModel(nodes: Record<string, any>, name: string): ModelRef | { error: string } {
  const models = Object.entries(nodes).filter(([, n]) => n?.resource_type === "model")
  let hits = models.filter(([id]) => id === name)
  if (!hits.length) hits = models.filter(([, n]) => n.name === name)
  if (!hits.length && name.includes(".")) hits = models.filter(([id]) => id.endsWith(`.${name}`))
  if (hits.length === 1)
    return { uniqueId: hits[0][0], materialized: hits[0][1]?.config?.materialized, language: hits[0][1]?.language }
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

/** The statements that build the model's relation: a run holds at least one. Hooks, deletes, updates and reads around them join the run but are not one on their own. */
const BQ_BUILD_TYPES = ["CREATE_TABLE_AS_SELECT", "CREATE_TABLE", "CREATE_VIEW", "CREATE_MATERIALIZED_VIEW", "INSERT", "MERGE", "SCRIPT"]
/** Marks the history tool's own queries, whose text carries the model's needle and which the reads must not match. */
const OWN_MARK = "altimate_cost_read"
const notOwn = `strpos(query, '${OWN_MARK}') = 0`
/** dbt-bigquery labels every job it runs with the id of the dbt invocation (`dbt_invocation_id`); the jobs of one invocation are one run. */
export const INVOCATION_LABEL = "dbt_invocation_id"
/** The dbt target the job ran as, from the JSON in dbt's default query comment. */
const targetColumn = `regexp_extract(query, r'"target_name": "([^"]*)"') as target_name`
const invocationColumn = `(select value from unnest(labels) where key = '${INVOCATION_LABEL}') as dbt_invocation_id`
/** A job that finished successfully, or one that is still queued or running (its run is not complete). */
const LIVE_OR_DONE = "((upper(state) = 'DONE' and error_result is null) or upper(state) in ('PENDING','RUNNING'))"
/** The statement that ends a run: dbt builds an incremental model's temporary relation, then merges or inserts from it. */
/** BigQuery ML statements: on demand, model training bills at its own price per TiB, not the query rate, so it is not priced from bytes billed. */
const BQ_ML_TYPES = ["CREATE_MODEL"]
const BQ_FINAL_TYPES = ["MERGE", "INSERT", "SCRIPT"]
const DBT_TMP_SUFFIX = "__dbt_tmp"
/** A temporary-relation CREATE TABLE AS SELECT joins the final build that starts within this long after it ends. */
export const BQ_TMP_JOIN_MS = 10 * 60_000

/** A BigQuery project id as a backtick-quoted name, or undefined when it holds anything a name can't. */
export function bqProject(project: unknown): string | undefined {
  return typeof project === "string" && /^[A-Za-z0-9_.:-]+$/.test(project) ? project : undefined
}

/** The project's jobs, or only the caller's own (for a role that may not list every user's). */
export type JobsView = "JOBS" | "JOBS_BY_USER"

function bqJobs(project: string, location: unknown, view: JobsView): string {
  return `\`${project}\`.\`region-${sanitizeBqRegion(location)}\`.INFORMATION_SCHEMA.${view}`
}

/** The history and capacity queries (and the boundary, from its cutoff) read the same instant, `asOfMs`, as a literal: a window that slid between queries would not describe one period. */
export function bigqueryHistorySql(input: { project: string; location?: unknown; needle: string; view?: JobsView; asOfMs: number }): string {
  return `select /* ${OWN_MARK} */ job_id, user_email, creation_time, end_time, state, statement_type, destination_table.table_id as destination_table_id, destination_table.dataset_id as destination_dataset_id, ${invocationColumn}, ${targetColumn}, total_bytes_billed, total_slot_ms, reservation_id, cache_hit
from ${bqJobs(input.project, input.location, input.view ?? "JOBS")}
where creation_time > timestamp_millis(${windowStartMs(input.asOfMs)}) and creation_time <= timestamp_millis(${input.asOfMs})
  and upper(job_type) = 'QUERY' and ${LIVE_OR_DONE}
  and parent_job_id is null
  and ${notOwn}
  and strpos(query, ${sqlString(input.needle)}) > 0
order by creation_time desc limit ${HISTORY_LIMIT}`
}

/** The child jobs of matched scripts: a script's own row carries no reservation, its children do. */
/** `sinceMs` is the earliest parent's creation: a child never starts before its parent, and a fixed bound cannot slide past a child while the parents are read. */
export function bigqueryChildrenSql(input: { project: string; location?: unknown; parents: string[]; sinceMs: number; view?: JobsView }): string {
  return `select job_id, parent_job_id, creation_time, statement_type, total_bytes_billed, total_slot_ms, reservation_id, cache_hit
from ${bqJobs(input.project, input.location, input.view ?? "JOBS")}
where creation_time >= timestamp_millis(${Math.floor(input.sinceMs)})
  and upper(job_type) = 'QUERY' and upper(state) = 'DONE' and error_result is null
  and parent_job_id in (${input.parents.map(sqlString).join(",")})
order by creation_time desc limit ${BQ_CHILD_LIMIT}`
}

/** How many query jobs ran in the last week, and how many of them in a reservation. */
export function bigqueryCapacitySql(input: { project: string; location?: unknown; view?: JobsView; asOfMs: number }): string {
  return `select count(*) as jobs, countif(reservation_id is not null) as reserved
from ${bqJobs(input.project, input.location, input.view ?? "JOBS")}
where creation_time > timestamp_millis(${windowStartMs(input.asOfMs, 7)}) and creation_time <= timestamp_millis(${input.asOfMs})
  and upper(job_type) = 'QUERY' and upper(state) = 'DONE'`
}

/**
 * The boundary reads the matching statements that started before the period the history read covers (`cutoffMs`, or the
 * start of the window when the read did not hit its limit) and could join a run the history saw only the end of.
 *
 * The longest a job can plausibly be in flight, from BigQuery's documented limits (quotas page and query queues page): a
 * query that has not started times out in the queue after 6 hours (interactive) or 24 hours (batch); once running, a query
 * or script may run up to 6 hours per attempt with up to three attempts (18 hours), and a CREATE MODEL statement times out
 * at 24 hours by default, but at 48 hours for time series, AutoML and hyperparameter tuning models. The longest is the
 * batch queue plus the 48-hour CREATE MODEL: 24 + 48 = 72 hours. A job in flight longer than that (a queue timeout
 * raised in the project's settings) is not covered, and neither is a job still going that was created longer ago than that.
 */
const BQ_QUEUE_MAX_MS = 24 * 3_600_000
const BQ_RUN_MAX_MS = 48 * 3_600_000
export const MAX_JOB_SPAN_MS = BQ_QUEUE_MAX_MS + BQ_RUN_MAX_MS

/**
 * How far from the cutoff a statement can be and still belong to a run that begins after it: a job in flight for the
 * longest it can be (MAX_JOB_SPAN_MS), plus the longest gap by which one job joins the next (a temporary CTAS to its final
 * build, ten minutes; ordinary chaining is a minute). It bounds the time rules for jobs that carry no invocation label: a
 * finished job created earlier than this cannot chain into a run at the cutoff, and an unlabelled run starting later than
 * this after the cutoff cannot have an unread job in it. A labelled invocation has no such limit: its jobs are found by id.
 */
export const BOUNDARY_SPAN_MS = MAX_JOB_SPAN_MS + Math.max(BQ_TMP_JOIN_MS, BQ_CHAIN_MS)

/**
 * The instants a boundary query is written with, all derived from the cutoff itself. `startBeforeMs` is one
 * millisecond past it, so a statement that starts exactly at the cutoff is read; the lookbacks are measured from the
 * cutoff, not from that millisecond.
 */
export type BoundaryWindow = {
  /** Statements must start before this (the cutoff plus one millisecond). */
  startBeforeMs: number
  /** ... and after this (the boundary span), for a job that has finished. */
  startAfterMs: number
  /** A job still going (not done, or with no end time yet) is no older than the longest job span either. */
  liveStartAfterMs: number
  /** A finished job of an invocation read may have been created any time JOBS keeps: an invocation has no span limit. */
  invocationStartAfterMs: number
  /** A job must have ended at or after this (the cutoff less the chain window) to be able to join a run. */
  joinEndAtLeastMs: number
  /** A temporary-relation CTAS must end at or after this (the cutoff less the join window). */
  tmpEndAtLeastMs: number
}

export function boundaryWindow(cutoffMs: number, retentionStart = cutoffMs - JOBS_RETENTION_DAYS * DAY_MS): BoundaryWindow {
  const cutoff = Math.trunc(cutoffMs)
  return {
    startBeforeMs: cutoff + 1,
    startAfterMs: cutoff - BOUNDARY_SPAN_MS,
    liveStartAfterMs: cutoff - BOUNDARY_SPAN_MS,
    invocationStartAfterMs: Math.trunc(retentionStart),
    joinEndAtLeastMs: cutoff - BQ_CHAIN_MS,
    tmpEndAtLeastMs: cutoff - BQ_TMP_JOIN_MS,
  }
}

export function bigqueryBoundarySql(input: {
  project: string
  location?: unknown
  needle: string
  view?: JobsView
  window: BoundaryWindow
}): string {
  const at = (ms: number) => `timestamp_millis(${ms})`
  const w = input.window
  // One read, so no job can change state between two: what can join a run that starts after the cutoff is a finished job
  // that ended within a minute before it (or the CTAS into dbt's temporary relation that ended within ten minutes before
  // its final build) and was created in the lookback, or a job still going (not done, or with no end time yet) created
  // no further back than the longest job span. Jobs still going come first, so finished ones cannot crowd them out of the limit.
  const going = `(upper(state) in ('PENDING','RUNNING') or end_time is null)`
  return `select /* run boundary */ /* ${OWN_MARK} */ job_id, user_email, creation_time, end_time, state, statement_type, destination_table.table_id as destination_table_id, destination_table.dataset_id as destination_dataset_id, ${invocationColumn}, ${targetColumn}
from ${bqJobs(input.project, input.location, input.view ?? "JOBS")}
where creation_time < ${at(w.startBeforeMs)}
  and upper(job_type) = 'QUERY'
  and parent_job_id is null
  and (
    (${going} and creation_time > ${at(w.liveStartAfterMs)})
    or (creation_time > ${at(w.startAfterMs)} and upper(state) = 'DONE' and error_result is null and (
      end_time >= ${at(w.joinEndAtLeastMs)}
      or (upper(statement_type) = 'CREATE_TABLE_AS_SELECT' and ends_with(destination_table.table_id, '${DBT_TMP_SUFFIX}')
          and end_time >= ${at(w.tmpEndAtLeastMs)})
    ))
  )
  and ${notOwn}
  and strpos(query, ${sqlString(input.needle)}) > 0
order by ${going} desc, creation_time desc limit ${HISTORY_LIMIT}`
}

/**
 * The jobs of the invocations already read, from before the cutoff and as far back as JOBS keeps them, in a read of their
 * own: an invocation has no span limit, so these are found by id, and a full unlabelled boundary read cannot crowd them out.
 * When this read is full, the invocations are not known to be complete.
 */
export function bigqueryInvocationSql(input: { project: string; location?: unknown; needle: string; view?: JobsView; window: BoundaryWindow; invocations: string[] }): string {
  const at = (ms: number) => `timestamp_millis(${ms})`
  const w = input.window
  const ids = [...new Set(input.invocations)]
  return `select /* invocation jobs */ /* ${OWN_MARK} */ job_id, user_email, creation_time, end_time, state, statement_type, destination_table.table_id as destination_table_id, destination_table.dataset_id as destination_dataset_id, ${invocationColumn}, ${targetColumn}
from ${bqJobs(input.project, input.location, input.view ?? "JOBS")}
where creation_time < ${at(w.startBeforeMs)} and creation_time > ${at(w.invocationStartAfterMs)}
  and upper(job_type) = 'QUERY' and ${LIVE_OR_DONE}
  and parent_job_id is null
  and ${notOwn}
  and strpos(query, ${sqlString(input.needle)}) > 0
  and (select value from unnest(labels) where key = '${INVOCATION_LABEL}') in (${ids.map(sqlString).join(",")})
order by creation_time desc limit ${HISTORY_LIMIT}`
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
  '{{ tojson({"project": target.get("project"), "execution_project": target.get("execution_project"), "location": target.get("location"), "name": target.get("name")}) }}'

export type Row = Record<string, string | null>

export function parseRows(rendered: unknown): Row[] {
  const parsed = typeof rendered === "string" ? JSON.parse(rendered.trim()) : undefined
  if (!parsed || !Array.isArray(parsed.columns) || !Array.isArray(parsed.rows)) throw new Error("the query returned no table")
  const columns: string[] = parsed.columns.map((c: unknown) => String(c).toLowerCase())
  return parsed.rows.map((values: (string | null)[]) => Object.fromEntries(columns.map((c, i) => [c, values[i] ?? null])))
}

// ---- Runs and their statistics ----

/** Why a run could not be priced. */
export type Cause = "noslot" | "bqml" | "nullbytes" | "nochildren" | "cutchildren" | "badtime" | "unknown"
export type Causes = Partial<Record<Cause, number>>

const CAUSE_TEXT: Record<Cause, string> = {
  noslot: "BigQuery gave no slot time for a job that ran in a reservation",
  bqml: "a BigQuery ML job (CREATE MODEL) ran on demand, and its price is not the query rate",
  nullbytes: "BigQuery gave no bytes billed for a job (it hides them for tables under a row access policy)",
  nochildren: "a script's child jobs were not found",
  cutchildren: "a script's child jobs may be cut off at the children query's limit",
  badtime: "a script's start time could not be read",
  unknown: "their cost is not known",
}

const causeList = (causes: Causes) =>
  Object.entries(CAUSE_TEXT)
    .filter(([cause]) => cause in causes)
    .map(([, text]) => text)
    .join("; ")

/** A timestamp as text, read as UTC when it names no zone. */
export function parseTime(value: string | null | undefined): number {
  if (!value) return Number.NaN
  const iso = value.includes("T") ? value : value.replace(" ", "T")
  return Date.parse(/(Z|[+-]\d\d(:?\d\d)?)$/.test(iso.slice(10)) ? iso : `${iso}Z`)
}

/**
 * What lies before the period a history read covers. `cutoff` is the oldest returned statement's start when the read
 * hit its limit, else the start of the window. `stmts` are the matching statements that started before it and could
 * join a run that began earlier; undefined when they could not be read.
 */
export type Boundary = {
  cutoff: number
  stmts?: { user: string | null; start: number; end: number; tmp?: boolean; dataset?: string | null; inv?: string; target?: string }[]
  /** Jobs still going (queued, running, or with no end time) in the window, each lasting to the instant read. They leave out any run they could chain into. */
  live?: { user: string | null; start: number; inv?: string; target?: string }[]
  /** The read of the invocations' own jobs was full: no labelled run is known to be complete. */
  invocationsFull?: boolean
  /** The boundary read was full: it cannot say what it left out, so runs near the cutoff are not trusted besides. */
  full?: boolean
  /** The boundary read was full: every run by these users, who have a job still going, is left out. */
  liveFullUsers?: string[]
}

/** When the boundary read is full or its statements are unknown, runs starting this close to the cutoff are not trusted. */
export const BOUNDARY_FALLBACK_MS = BOUNDARY_SPAN_MS

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function summarize(runs: { start: number; cost: number; native: number }[]) {
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

const none = (reason: string, notes: string[] = [], rate: CostRate | null = null): CostInfo => ({
  basis: "none",
  currency: "USD",
  rate,
  notes,
  unknownReason: reason,
})

/** Where the history was read from: the target's location, or the `us` region a target with none falls back to. */
export function locationNote(location: unknown): string {
  const set = typeof location === "string" && location.trim() !== ""
  const region = `region-${sanitizeBqRegion(location)}`
  return set
    ? `Location read: ${region} (the target's location).`
    : `The target sets no location, so ${region} was read; if the datasets live in another location, set location in the dbt profile.`
}

const PYTHON_NOTE =
  "A Python model runs on Dataproc, not as a BigQuery query job, so it never appears in INFORMATION_SCHEMA.JOBS and its cost cannot be read from it."
const EPHEMERAL_NOTE = "An ephemeral model never runs on its own: its SQL is inlined into the models that ref it, so look at the runs of those models."

function emptyMessage(uniqueId: string, table: string, opts: { materialized?: string; location?: string }): string {
  const parts = [
    `No runs of ${uniqueId} in the last ${HISTORY_DAYS} days were found in ${table} (a project that overrides dbt's query-comment, a role without access, or a different location finds none).`,
    opts.materialized === "ephemeral" ? EPHEMERAL_NOTE : undefined,
    opts.location,
  ]
  return parts.filter(Boolean).join(" ")
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** One BigQuery job, or the children of a script, priced as what they are: bytes billed on demand, slot time in a reservation. */
type BqUnit = {
  cause?: Cause
  user: string
  start: number
  end: number
  /** The dbt invocation id the job is labelled with, or "" when it has none. */
  inv: string
  /** The dbt target the job's query comment names, or "" when it names none. */
  target: string
  /** The destination dataset, when the job names one. */
  dataset: string
  /** A CREATE TABLE AS SELECT into dbt's temporary relation. */
  tmp: boolean
  /** A job that can end a run: MERGE, INSERT or a script. */
  final: boolean
  /** The start and destination dataset of each final job a run holds. */
  finals?: { start: number; dataset: string }[]
  /** The latest end of a temporary CTAS in the run that no final build has taken: its MERGE may still come for ten minutes. */
  unpairedTmpEnd?: number
  /** Set on a temporary CTAS no final build took. */
  unpaired?: boolean
  /** A statement that builds the model's relation (see BQ_BUILD_TYPES). */
  build: boolean
  /** The job is still queued or running. */
  pending: boolean
  cost: number
  known: boolean
  bytes: number
  slotHours: number
  reserved: boolean
  demand: boolean
}

function bqJob(r: Row, cfg: CostConfig, asOfMs?: number): BqUnit {
  const slot = rateOf(cfg.bigquerySlotHourUsd, DEFAULT_RATES.bigquerySlotHourUsd, "USD/slot-hour", "bigquerySlotHourUsd").rate.value
  const demand = rateOf(cfg.bigqueryUsdPerTib, DEFAULT_RATES.bigqueryUsdPerTib, "USD/TiB", "bigqueryUsdPerTib").rate.value
  const reserved = r.reservation_id !== null && r.reservation_id !== undefined && r.reservation_id !== ""
  const slotHours = (num(r.total_slot_ms) ?? 0) / 3_600_000
  const billed = num(r.total_bytes_billed)
  // A cached result bills nothing; a missing figure (BigQuery hides it for tables under a row access policy) is not a zero.
  const cached = String(r.cache_hit).toLowerCase() === "true"
  // A job in a reservation is priced by its slot time, which must be reported too: a missing one is not a zero.
  const ml = BQ_ML_TYPES.includes(stmtType(r))
  const known = reserved ? num(r.total_slot_ms) !== undefined : !ml && (billed !== undefined || cached)
  const pending = isPending(r)
  return {
    cause: known ? undefined : reserved ? ("noslot" as Cause) : ml ? ("bqml" as Cause) : ("nullbytes" as Cause),
    user: r.user_email ?? "",
    // A job still running has no end yet: it lasts to the instant read, or beyond it.
    end: pending ? (asOfMs ?? Number.POSITIVE_INFINITY) : parseTime(r.end_time),
    build: BQ_BUILD_TYPES.includes(stmtType(r)),
    pending,
    inv: r.dbt_invocation_id ?? "",
    target: r.target_name ?? "",
    dataset: r.destination_dataset_id ?? "",
    tmp: stmtType(r) === "CREATE_TABLE_AS_SELECT" && (r.destination_table_id ?? "").endsWith(DBT_TMP_SUFFIX),
    final: BQ_FINAL_TYPES.includes(stmtType(r)),
    start: parseTime(r.creation_time),
    cost: reserved ? slotHours * slot : ((billed ?? 0) / TIB) * demand,
    known,
    bytes: reserved ? 0 : (billed ?? 0),
    slotHours: reserved ? slotHours : 0,
    reserved,
    demand: !reserved,
  }
}

/** A statement type as the warehouse reports it, in upper case. */
const stmtType = (r: Row) => (r.statement_type ?? "").toUpperCase()

/** A row that names a state other than DONE, or a null end time, is a job still queued or running; one that names neither is done. */
const isPending = (r: Row) => (!!r.state && r.state.toUpperCase() !== "DONE") || r.end_time === null

const sumUnits = (start: number, units: BqUnit[], over: { user: string; final: boolean; dataset: string; inv?: string; target?: string }): BqUnit => ({
  cause: units.find((u) => !u.known)?.cause,
  user: over.user,
  end: Math.max(...units.map((u) => u.end)),
  inv: over.inv ?? "",
  target: over.target ?? "",
  dataset: over.dataset,
  tmp: false,
  final: over.final,
  build: units.some((u) => u.build),
  pending: units.some((u) => u.pending),
  start,
  cost: units.reduce((t, u) => t + u.cost, 0),
  known: units.every((u) => u.known),
  bytes: units.reduce((t, u) => t + u.bytes, 0),
  slotHours: units.reduce((t, u) => t + u.slotHours, 0),
  reserved: units.some((u) => u.reserved),
  demand: units.some((u) => u.demand),
})

/** Two jobs may share a run's destination when either names none (a script has no destination of its own) or both name the same dataset. */
const sameDataset = (a: BqUnit, b: BqUnit) => !a.dataset || !b.dataset || a.dataset === b.dataset

/**
 * BigQuery runs. dbt-bigquery labels every job with its invocation id, and jobs with the same id are one run, however far apart.
 * Jobs without the label are grouped by user and time: the model's matched top-level jobs by one user form a run
 * while each job starts within a minute after the previous job of the run ended (a pre- or post-hook, a delete or
 * update, each batch of a microbatch model); a script counts as one job, priced from its children. dbt builds an
 * incremental model's temporary relation with a CREATE TABLE AS SELECT into `<model>__dbt_tmp` in the same dataset and
 * then merges or inserts from it: such a CTAS pairs with the final build (MERGE, INSERT or script) of the same user
 * that starts within ten minutes after it ends, one CTAS to one final build, and the pair is a single job of the run.
 * Jobs that only read (a SELECT hook) or delete join a run but do not make one: a group needs a build job. A group with a
 * job still queued or running, or whose last job ended within a minute before `asOfMs` (the next job may still start),
 * is a run in progress and is left out.
 */
export function bigqueryRuns(
  units: BqUnit[],
  boundary?: Boundary,
  asOfMs?: number,
): { runs: BqUnit[]; skipped: number; dropped: number; inProgress: number; causes: Causes } {
  // Jobs labelled with a dbt invocation id are grouped by it: one invocation is one run, whatever the gaps between its jobs.
  // Jobs without the label (an older adapter, a custom job) are grouped by user and time below.
  const byInvocation = new Map<string, BqUnit[]>()
  for (const u of units.filter((x) => x.inv)) byInvocation.set(u.inv, [...(byInvocation.get(u.inv) ?? []), u])
  // dbt makes one temporary relation per final build, which follows it: each temporary CTAS of an invocation takes the first
  // final build that starts after it ended and no other CTAS has taken. One with none is still waiting for its build, even
  // when an earlier build of the invocation (a microbatch's first batch) exists.
  for (const g of byInvocation.values()) {
    const finals = g.filter((u) => u.final).sort((a, b) => a.start - b.start)
    const taken = new Set<BqUnit>()
    for (const t of g.filter((u) => u.tmp).sort((a, b) => a.end - b.end)) {
      const f = finals.find((x) => !taken.has(x) && x.start >= t.end)
      if (f) taken.add(f)
      else t.unpaired = true
    }
  }
  units = units.filter((x) => !x.inv)
  const heads = units.filter((u) => !u.tmp).sort((a, b) => a.start - b.start)
  const atoms = new Map<BqUnit, BqUnit[]>(heads.map((b) => [b, [b]]))
  const loose: BqUnit[][] = []
  // dbt makes one temporary relation per final build: taken in the order they ended, each CTAS takes the first
  // qualifying final build no other CTAS has claimed.
  const claimed = new Set<BqUnit>()
  for (const t of units.filter((b) => b.tmp).sort((a, b) => a.end - b.end)) {
    const head = heads.find(
      (b) => b.final && !claimed.has(b) && b.user === t.user && sameDataset(b, t) && b.start >= t.end && b.start - t.end <= BQ_TMP_JOIN_MS,
    )
    if (head) {
      claimed.add(head)
      atoms.get(head)!.push(t)
    } else {
      t.unpaired = true
      loose.push([t])
    }
  }
  const byUser = new Map<string, BqUnit[][]>()
  for (const atom of [...atoms.values(), ...loose]) byUser.set(atom[0].user, [...(byUser.get(atom[0].user) ?? []), atom])
  const startOf = (atom: BqUnit[]) => Math.min(...atom.map((u) => u.start))
  const endOf = (atom: BqUnit[]) => Math.max(...atom.map((u) => u.end))
  const grouped: BqUnit[][] = [...byInvocation.values()]
  for (const list of byUser.values()) {
    let current: BqUnit[] = []
    let currentEnd = Number.NaN
    for (const atom of list.sort((a, b) => startOf(a) - startOf(b))) {
      if (current.length && startOf(atom) - currentEnd <= BQ_CHAIN_MS) {
        current.push(...atom)
        currentEnd = Math.max(currentEnd, endOf(atom))
      } else {
        if (current.length) grouped.push(current)
        current = [...atom]
        currentEnd = endOf(atom)
      }
    }
    if (current.length) grouped.push(current)
  }
  const all = grouped.map((g) => {
    const head = g.find((u) => !u.tmp) ?? g[0]
    const finals = g.filter((u) => u.final)
    const unit = sumUnits(Math.min(...g.map((u) => u.start)), g, { user: head.user, final: finals.length > 0, dataset: head.dataset, inv: head.inv, target: head.target })
    // An unpaired temporary CTAS can still be joined by its final build for ten minutes, whatever ran after it.
    const unpairedTmpEnd = Math.max(Number.NEGATIVE_INFINITY, ...g.filter((u) => u.unpaired).map((u) => u.end))
    return { ...unit, finals: finals.map((u) => ({ start: u.start, dataset: u.dataset })), unpairedTmpEnd }
  })
  // Only a group with a build job is a run; a group of reads (`dbt show`) is not priced.
  const candidates = all.filter((r) => r.build)
  // Whether an unread job could belong to a run: the same invocation id when both carry one, else the user-and-time rule.
  const joins = (b: NonNullable<Boundary["stmts"]>[number], r: BqUnit) =>
    // A job belongs to a run of its own target only (jobs naming none, to runs naming none), and labelled and unlabelled
    // jobs are never one run (the main grouping keeps them apart): only like meets like.
    (b.target ?? "") !== r.target
      ? false
      : b.inv || r.inv
      ? !!b.inv && b.inv === r.inv
      : (b.user ?? "") === r.user &&
    (b.end >= r.start - BQ_CHAIN_MS ||
      (!!b.tmp &&
        (r.finals ?? []).some((f) => b.end <= f.start && b.end >= f.start - BQ_TMP_JOIN_MS && (!b.dataset || !f.dataset || b.dataset === f.dataset))))
  // A job before the cutoff that is still running and could join the run makes it a run in progress, not just an uncertain one.
  const liveBefore = (r: BqUnit) =>
    !!boundary &&
    ((!!boundary.liveFullUsers?.includes(r.user) && !!boundary.live?.some((b) => (b.user ?? "") === r.user && (b.target ?? "") === r.target)) ||
      !!boundary.live?.some(
        (b) =>
          (b.target ?? "") === r.target &&
          (b.inv || r.inv ? !!b.inv && b.inv === r.inv : (b.user ?? "") === r.user && r.end >= b.start - BQ_CHAIN_MS),
      ))
  const live = candidates.filter((r) => !(r.pending || (asOfMs !== undefined && (r.end >= asOfMs - BQ_CHAIN_MS || (r.unpairedTmpEnd ?? Number.NEGATIVE_INFINITY) >= asOfMs - BQ_TMP_JOIN_MS)) || liveBefore(r)))
  // Unread statements before the cutoff that would have joined a run, whatever the run now pairs with: a job by the
  // run's user that ended at or after a minute before the run's start, or a temporary-relation CTAS by the same user,
  // into the dataset of a final build (or any, when that build names none), that ended at or before the build's start
  // and within ten minutes of it (an unread CTAS could have been the one that build took). Such a run is not trusted.
  const unsure = (r: BqUnit) =>
    boundary
      ? !!boundary.stmts?.some((b) => joins(b, r)) ||
        (boundary.invocationsFull === true && !!r.inv) ||
        // The time fallback is for unlabelled runs: a labelled run is complete when every job of its invocation was read.
        ((!boundary.stmts || boundary.full === true) && !r.inv && r.start <= boundary.cutoff + BOUNDARY_FALLBACK_MS)
      : false
  const counted = live.filter((r) => !unsure(r))
  const runs = counted.filter((r) => r.known && Number.isFinite(r.start))
  const causes: Causes = {}
  for (const r of counted) if (!r.known) causes[r.cause ?? "unknown"] = (causes[r.cause ?? "unknown"] ?? 0) + 1
  return {
    runs,
    skipped: counted.length - runs.length,
    dropped: live.length - counted.length,
    inProgress: candidates.length - live.length,
    causes,
  }
}

/** The runs left out of the figures because of another target (or none named), by target, each with how it was priced. */
function otherTargetsOf(runs: BqUnit[], demand: CostRate, slot: CostRate): NonNullable<CostInfo["otherTargets"]> {
  const by = new Map<string, BqUnit[]>()
  for (const r of runs) by.set(r.target || "unknown target", [...(by.get(r.target || "unknown target") ?? []), r])
  return [...by.entries()]
    .map(([target, rs]) => {
      const anyDemand = rs.some((r) => r.demand)
      const anySlots = rs.some((r) => r.reserved)
      const attribution = anyDemand && anySlots ? "mixed" : anySlots ? "slot_time" : "bytes_billed"
      return {
        target,
        runs: rs.length,
        typical: median(rs.map((r) => r.cost)),
        attribution: attribution as "slot_time" | "bytes_billed" | "mixed",
        rate: attribution === "slot_time" ? slot : demand,
        ...(attribution === "mixed" && { slotRate: slot }),
      }
    })
    .sort((a, b) => b.runs - a.runs)
}

const rateText = (r: CostRate) => `${r.value} ${r.unit}, ${r.source === "config" ? "your config" : "default"}`
const otherTargetsText = (others: NonNullable<CostInfo["otherTargets"]>) =>
  others
    .map((o) => {
      const how =
        o.attribution === "slot_time"
          ? `attributed slot time at ${rateText(o.rate)}`
          : o.attribution === "mixed"
            ? `bytes billed at ${rateText(o.rate)} and attributed slot time at ${rateText(o.slotRate!)}`
            : `bytes billed at ${rateText(o.rate)}`
      return `${o.target}: ${plural(o.runs, "run")}, typical ${formatMoney(o.typical)} (${how})`
    })
    .join("; ")

export function priceBigquery(
  rows: Row[],
  children: Row[] | undefined,
  uniqueId: string,
  cfg: CostConfig,
  boundary?: Boundary,
  opts: { materialized?: string; location?: string; asOfMs?: number; target?: string } = {},
): { cost: CostInfo; reserved: boolean } {
  const table = "INFORMATION_SCHEMA.JOBS"
  // Every message that says no run was found also says where it looked.
  const withLocation = (text: string) => [text, opts.location].filter(Boolean).join(" ")
  const demand = rateOf(cfg.bigqueryUsdPerTib, DEFAULT_RATES.bigqueryUsdPerTib, "USD/TiB", "bigqueryUsdPerTib")
  const slot = rateOf(cfg.bigquerySlotHourUsd, DEFAULT_RATES.bigquerySlotHourUsd, "USD/slot-hour", "bigquerySlotHourUsd")
  if (!rows.length) return { cost: none(emptyMessage(uniqueId, table, opts), [], demand.rate), reserved: false }
  // Children come newest first, up to a limit: a script that started before the oldest child returned may have more.
  const childrenCut = (children?.length ?? 0) >= BQ_CHILD_LIMIT
  const childBoundary = Math.min(...(children ?? []).map((c) => parseTime(c.creation_time)))
  const units = rows.map((r) => {
    if (stmtType(r) !== "SCRIPT") return bqJob(r, cfg, opts.asOfMs)
    const kids = (children ?? []).filter((c) => c.parent_job_id === r.job_id).map((c) => bqJob(c, cfg))
    // A script's own row is never counted beside its children; with none found, its cost is not known.
    const start = parseTime(r.creation_time)
    // The children carry no end time: the script ended when its own row says.
    const pending = isPending(r)
    const unit = {
      ...sumUnits(start, kids, { user: r.user_email ?? "", final: true, dataset: r.destination_dataset_id ?? "", inv: r.dbt_invocation_id ?? "", target: r.target_name ?? "" }),
      end: pending ? (opts.asOfMs ?? Number.POSITIVE_INFINITY) : parseTime(r.end_time),
      build: true,
      pending,
    }
    // At the limit, a script that began before the oldest child returned may have lost children, found or not.
    // A start that does not parse cannot be compared with the children read's bounds.
    if (!Number.isFinite(start)) return { ...unit, known: false, cause: "badtime" as Cause }
    if (childrenCut && !(start > childBoundary)) return { ...unit, known: false, cause: "cutchildren" as Cause }
    if (!kids.length) return { ...unit, known: false, cause: "nochildren" as Cause }
    return unit
  })
  const truncated = rows.length >= HISTORY_LIMIT
  // The figures are of the current dbt target's runs: a dev run on sampled data is not what the model costs in prod. The jobs
  // are split by target before they are grouped, so a run never mixes targets; jobs whose query comment names no target are
  // an unknown one and are not in the figures either. Other targets' runs are formed the same way and only listed.
  const mine = opts.target ? units.filter((u) => u.target === opts.target) : units
  const { runs, skipped, dropped, inProgress, causes } = bigqueryRuns(mine, boundary, opts.asOfMs)
  const elsewhere = opts.target
    ? otherTargetsOf(
        [...new Set(units.filter((u) => u.target !== opts.target).map((u) => u.target))].flatMap(
          (t) => bigqueryRuns(units.filter((u) => u.target === t), boundary, opts.asOfMs).runs,
        ),
        demand.rate,
        slot.rate,
      )
    : []
  const anyReserved = units.some((u) => u.reserved)
  const notes: string[] = truncated ? [LIMIT_NOTE] : []
  if (dropped) notes.push(boundaryNote(dropped))
  if (skipped) notes.push(`${plural(skipped, "run")} left out: ${causeList(causes)}.`)
  if (boundary?.liveFullUsers?.length) notes.push("The read of jobs before the period was full, so every run by a user with a job still running was left out.")
  if (inProgress) notes.push(inProgress === 1 ? "A run still in progress was left out." : `${inProgress} runs still in progress were left out.`)
  if (!runs.length && elsewhere.length)
    return {
      reserved: anyReserved,
      cost: {
        ...none(
          withLocation(`No run of ${uniqueId} on the current target (${opts.target}) was found in the last ${HISTORY_DAYS} days; ${otherTargetsText(elsewhere)}.`),
          notes,
          demand.rate,
        ),
        target: opts.target,
        otherTargets: elsewhere,
      },
    }
  if (!runs.length && !skipped && !dropped && inProgress)
    return {
      reserved: anyReserved,
      cost: none(withLocation(`Every run of ${uniqueId} found is still in progress (or ended in the last minute), so none is priced.`), notes, demand.rate),
    }
  if (!runs.length && !skipped && !dropped)
    return {
      reserved: anyReserved,
      cost: none(
        [
          // Builds of another target that could not be priced are not "only reads": say what is true of the current target.
          opts.target && units.some((u) => u.build)
            ? `No priced run of ${uniqueId} on the current target (${opts.target}) was found: the builds found are of other targets and could not be priced.`
            : `No run of ${uniqueId} found: the jobs that carry its comment only read data (for example dbt show), and none built it.`,
          opts.location,
        ]
          .filter(Boolean)
          .join(" "),
        notes,
        demand.rate,
      ),
    }
  if (!runs.length && !skipped && dropped)
    return {
      reserved: anyReserved,
      cost: none(withLocation(`Every run of ${uniqueId} found may have started before the period read, so none is priced.`), notes, demand.rate),
    }
  if (!runs.length)
    return {
      reserved: anyReserved,
      cost: none(withLocation(`No run of ${uniqueId} found could be priced: ${causeList(causes)}.`), notes, demand.rate),
    }
  const anyDemand = runs.some((r) => r.demand)
  const allReserved = !anyDemand
  const mixed = runs.some((r) => r.reserved) && anyDemand
  const newest = runs.reduce((a, b) => (b.start > a.start ? b : a))
  const rate = newest.reserved && !newest.demand ? slot.rate : demand.rate
  if (mixed) {
    notes.push("Some runs ran in a reservation (priced by slot time) and some on demand (priced by bytes billed).")
    // Said only when whole runs differ: one run that mixes both (a script's children) says nothing about older ones.
    const newestMode = newest.reserved !== newest.demand ? (newest.reserved ? "reserved" : "demand") : undefined
    if (newestMode && runs.some((r) => r !== newest && r.reserved !== r.demand && r.reserved === (newestMode === "demand")))
      notes.push(
        newestMode === "reserved"
          ? "The newest run was in a reservation and older ones on demand: the project's pricing may have changed."
          : "The newest run was on demand and older ones in a reservation: the project's pricing may have changed.",
      )
    // The headline rate may be the slot rate; the on-demand runs in the figures are priced at this one.
    notes.push(`On-demand runs are priced at ${demand.rate.value} USD/TiB (${demand.rate.source === "config" ? "from your config" : "default"}).`)
  }
  if (runs.some((r) => r.reserved))
    notes.push(
      `Slot time is attributed at ${slot.rate.value} USD/slot-hour; it is an allocation, not the bill: autoscaled slots are billed in steps of 50, by default with a one-minute minimum (reservations with fluid scaling have none), and baseline slots are always charged.`,
    )
  if (elsewhere.length) notes.push(`Runs of other targets are not in these figures: ${otherTargetsText(elsewhere)}.`)
  if (anyDemand) notes.push("On-demand jobs are priced by the bytes BigQuery billed for each job.")
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
      attribution: mixed ? "mixed" : allReserved ? "slot_time" : "bytes_billed",
      ...(opts.target && { target: opts.target }),
      ...(elsewhere.length && { otherTargets: elsewhere }),
      rate,
      notes,
    },
  }
}

// ---- BigQuery's pre-run price ----

/** BigQuery's per-query minimum for on-demand billing. */
export const MIN_BILLED_BYTES = 10 * 1024 ** 2

/** The dry run's bytes at the on-demand rate: an estimate of the SELECT's bill, not a bound on it. */
export function onDemandEstimate(bytes: number, usdPerTib: number): number {
  return (bytes / TIB) * usdPerTib
}

export function bigqueryOnDemandRate(cfg: CostConfig) {
  return rateOf(cfg.bigqueryUsdPerTib, DEFAULT_RATES.bigqueryUsdPerTib, "USD/TiB", "bigqueryUsdPerTib")
}

// ---- Reading the answer ----

export function accessProblem(message: string): string | undefined {
  if (/access denied|permission|not authorized|forbidden/i.test(message))
    return "the role needs bigquery.jobs.create and bigquery.jobs.listAll on the project to read INFORMATION_SCHEMA.JOBS (or bigquery.jobs.create and bigquery.jobs.list for its own jobs, through JOBS_BY_USER)"
  return undefined
}

/** The first line of an error that says something: dbt wraps a warehouse error in a bare "Encountered an error:" line. */
function errorDetail(message: string): string {
  const lines = message
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(\[?error\]?:?\s*)?encountered an error:?$/i.test(l))
  return (lines[0] ?? "").replace(/^\[?error\]?:\s*/i, "").slice(0, 300)
}

export function unreadable(message: string, location?: string): CostInfo {
  const why = accessProblem(message)
  const detail = errorDetail(message)
  return none(`Cost history could not be read${why ? `: ${why}` : ""}${detail ? ` (${detail})` : ""}.${why && location ? ` ${location}` : ""}`)
}

/** A dollar amount as text, to enough digits that a small one is not shown as zero. */
export function formatMoney(value: number): string {
  const digits = value === 0 ? 2 : Math.min(8, Math.max(2, 1 - Math.floor(Math.log10(Math.abs(value)))))
  return `$${value.toFixed(digits)}`
}

const NATIVE_LABEL: Record<NativeUnit, string> = { bytes_billed: "bytes billed", slot_hours: "slot-hours" }

function nativeText(n: NonNullable<CostInfo["native"]>): string {
  const f = (v: number | undefined) => (v === undefined ? "-" : n.unit === "bytes_billed" ? String(Math.round(v)) : String(Number(v.toPrecision(4))))
  return `${NATIVE_LABEL[n.unit]}: last ${f(n.lastRun)}, typical ${f(n.typical)}, highest ${f(n.highest)}`
}

/** The SELECT's estimated on-demand price, with what can make the bill differ. `shown` is the dry run's size as text. */
function selectText(c: CostInfo, shown: string): string {
  return `Pre-run scan estimate (not the model's run history): BigQuery's dry run estimates the SELECT at ${shown}, about ${formatMoney(c.selectOnly!.estimate)} on-demand. BigQuery bills at least 10 MiB per query, which this estimate applies. The bill can differ: a cached or BI Engine result bills nothing, clustered tables often bill less after runtime pruning, and external sources and some queries are not fully counted.`
}

/** The cost as plain sentences, the first being the answer (or why there is none). */
export function costText(c: CostInfo, shown = "the bytes it reports"): string {
  const lines: string[] = []
  // First, before any figure: whose jobs were read.
  const slots = c.basis === "history" && (c.attribution === "slot_time" || c.attribution === "mixed")
  const slotsNote = "reservation runs are attributed slot time, not the bill"
  if (c.scope === "user")
    lines.push(`Only your own jobs were read (no bigquery.jobs.listAll): service-account and other users' runs are missing${slots ? `; ${slotsNote}` : ""}.`)
  if (c.basis === "history") {
    lines.push(
      `Cost from ${c.runs} run${c.runs === 1 ? "" : "s"} in the last ${c.windowDays} days${slots && c.scope !== "user" ? ` (${slotsNote})` : ""}${c.target ? ` on target ${c.target}` : ""}: last run ${formatMoney(c.lastRun!)}, typical ${formatMoney(c.typical!)} (median), highest ${formatMoney(c.highest!)}.`,
    )
    if (c.native) lines.push(`In the warehouse's own unit, ${nativeText(c.native)}.`)
  } else if (c.basis === "dry_run") {
    lines.push(selectText(c, shown))
  } else {
    lines.push(`Cost unknown: ${c.unknownReason}`)
  }
  // With history the SELECT's price is a second figure, and the notes below refer to it.
  if (c.basis !== "dry_run" && c.selectOnly) lines.push(selectText(c, shown))
  if (c.rate) lines.push(`Rate: ${c.rate.value} ${c.rate.unit} (${c.rate.source === "config" ? "from your config" : "default"}).`)
  for (const n of c.notes) lines.push(n)
  return lines.join("\n")
}

// ---- Reading the history ----

/** The boundary read failed: runs still in progress or cut by the period's start cannot be told apart from whole ones. */
class BoundaryUnreadable extends Error {}

/** Test seams. */
export const costHistoryInternals = {
  /** How long the history queries together wait for the warehouse; a slower one is no history, and the scan figure stands. */
  historyTimeoutMs: 60_000,
  /** The instant a call reads the history as of: taken once, and written as a literal into the history and capacity queries and the boundary's cutoff. */
  now: () => Date.now(),
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
 * What the model's earlier runs cost and whether the project is on capacity pricing. The queries run one after another
 * (the Python bridge serialises adapter calls) inside one deadline, and after the scan figure is computed. Never
 * rejects except for a cancelled call: a failure is an answer with no cost and the reason.
 */
export async function loadHistory(input: {
  adapter: Compiler
  model?: string
  manifestPath?: string
  signal: AbortSignal
  cfg: CostConfig
}): Promise<History> {
  const { adapter, signal, cfg } = input
  // One instant for the whole call: the main read, its boundary and the capacity check use it (the children start at their earliest parent).
  const asOfMs = costHistoryInternals.now()
  const windowStart = windowStartMs(asOfMs)
  // A call cancelled while the scan ran stops here, whether or not any history query would have been sent.
  signal.throwIfAborted()
  const deadline = new AbortController()
  const ms = costHistoryInternals.historyTimeoutMs
  const timer = setTimeout(() => deadline.abort(new Error(`the cost history did not answer within ${ms / 1000} s`)), ms)
  const both = AbortSignal.any([signal, deadline.signal])
  const run = <T>(start: () => Promise<T>): Promise<T> => {
    if (both.aborted) return Promise.reject(both.reason)
    return new Promise<T>((resolve, reject) => {
      const stop = () => reject(both.reason)
      both.addEventListener("abort", stop, { once: true })
      start().then(resolve, reject).finally(() => both.removeEventListener("abort", stop))
    })
  }
  const rows = (sql: string) => run(async () => parseRows(await adapter.unsafeCompileQuery(rowsJinja(sql), undefined)))
  let uniqueId: string | undefined
  let materialized: string | undefined
  let language: string | undefined
  let unavailable: string | undefined
  if (!input.model) {
    unavailable = "A SQL input has no run history; pass a model to price its earlier runs."
  } else if (!input.manifestPath) {
    unavailable = "No dbt manifest was found, so the model's unique_id is unknown."
  }
  else {
    const found = modelFromManifest(input.manifestPath, input.model)
    if ("error" in found) {
      unavailable = `Cost history needs the model's unique_id: ${found.error}.`
    }
    else ({ uniqueId, materialized, language } = found)
  }
  const base = { materialized }
  /**
   * The matching statements just before the period `read` covers: the history read's own cutoff when it hit its
   * limit, else the start of the window. A boundary that can't be read (or hit its limit) is unknown.
   */
  const boundaryFor = async (
    read: Row[],
    sqlFor: (window: BoundaryWindow) => string,
    invocationSqlFor?: (window: BoundaryWindow) => string,
  ): Promise<Boundary | undefined> => {
    if (!read.length) return undefined
    const starts = read.map((r) => parseTime(r.creation_time)).filter(Number.isFinite)
    const hit = read.length >= HISTORY_LIMIT && starts.length > 0
    // The cutoff is the oldest statement read when the limit was hit, else the window's own start: the same instant
    // the main read used, never recomputed.
    const cutoff = hit ? Math.min(...starts) : windowStart
    try {
      // The window reaches the cutoff's own instant (a statement that starts exactly at it is read: the main read takes
      // only statements after the window's start, and the oldest statement it returned is at the cutoff itself) while
      // every lookback is measured from the cutoff. The statements already read come back too and are filtered out below.
      const window = boundaryWindow(cutoff, windowStartMs(asOfMs, JOBS_RETENTION_DAYS))
      const boundaryRows = await rows(sqlFor(window))
      // The invocations' own jobs, read apart; both reads' rows are evidence, a job in both counted once.
      const ownRows = invocationSqlFor ? await rows(invocationSqlFor(window)) : []
      const invocationsFull = ownRows.length >= HISTORY_LIMIT
      const seen = new Set(boundaryRows.map((r) => r.job_id))
      const found = [...boundaryRows, ...ownRows.filter((r) => !seen.has(r.job_id))]
      const going = (r: Row) => isPending(r)
      // The cutoff's millisecond also returns statements the history already read: only unread ones are evidence.
      const readIds = new Set(read.map((r) => r.job_id))
      const unread = found.filter((r) => !readIds.has(r.job_id))
      const live = unread.filter(going).map((r) => ({ user: r.user_email ?? null, start: parseTime(r.creation_time), inv: r.dbt_invocation_id ?? "", target: r.target_name ?? "" }))
      // Full: the read cannot say what it left out, so the fallback applies besides all the evidence it did return, and
      // every run by a user with a job still going is left out.
      const full = boundaryRows.length >= HISTORY_LIMIT
      return {
        cutoff,
        live,
        ...(invocationsFull && { invocationsFull }),
        ...(full && { full, liveFullUsers: [...new Set(live.map((j) => j.user ?? ""))] }),
        stmts: unread
          .filter((r) => !going(r))
          .map((r) => ({
            user: r.user_email ?? null,
            start: parseTime(r.creation_time),
            end: parseTime(r.end_time),
            tmp: stmtType(r) === "CREATE_TABLE_AS_SELECT" && (r.destination_table_id ?? "").endsWith(DBT_TMP_SUFFIX),
            dataset: r.destination_dataset_id ?? null,
            inv: r.dbt_invocation_id ?? "",
            target: r.target_name ?? "",
          })),
      }
    } catch (e) {
      // Not knowing which runs are still going or were cut, no run can be vouched for: the history is unknown.
      throw signal.aborted ? e : new BoundaryUnreadable(message(e))
    }
  }
  try {
    return { ...(await bigqueryHistory()), ...base }
  } catch (e) {
    if (signal.aborted) throw e
    return { cost: unreadable(message(e)), ...base }
  } finally {
    clearTimeout(timer)
  }

  async function bigqueryHistory(): Promise<Omit<History, "materialized">> {
    // A Python model runs on Dataproc, not as a BigQuery query job, so it is never in JOBS: no query can find a run.
    if (language === "python") return { cost: none(PYTHON_NOTE) }
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
    const where = locationNote(location)
    const targetName = typeof target.name === "string" && target.name ? target.name : undefined
    // A role that may not list every user's jobs is retried on its own: the answer then covers only its own runs.
    const read = async (sqlFor: (view: JobsView) => string): Promise<{ rows: Row[]; own: boolean; view: JobsView }> => {
      try {
        return { rows: await rows(sqlFor("JOBS")), own: false, view: "JOBS" }
      } catch (e) {
        if (signal.aborted || !accessProblem(message(e))) throw e
        try {
          return { rows: await rows(sqlFor("JOBS_BY_USER")), own: true, view: "JOBS_BY_USER" }
        } catch {
          throw e
        }
      }
    }
    let pricing: boolean | undefined
    // Whose jobs the reads covered, once one succeeded: every later answer, a failure included, says so.
    let scope: CostInfo["scope"]
    const scoped = (cost: CostInfo): CostInfo => ({ ...cost, ...(scope && { scope }) })
    try {
      const { rows: seen, own } = await read((view) => bigqueryCapacitySql({ project, location, view, asOfMs }))
      scope = own ? "user" : "project"
      const reserved = num(seen[0]?.reserved) ?? 0
      pricing = reserved > 0 ? true : (num(seen[0]?.jobs) ?? 0) > 0 ? false : undefined
    } catch (e) {
      if (signal.aborted) throw e
    }
    if (!uniqueId) return { cost: scoped(none(unavailable!)), capacity: pricing }
    const id = uniqueId
    let cost: CostInfo
    let reserved = false
    try {
      const history = await read((view) => bigqueryHistorySql({ project, location, needle: needleFor(id), view, asOfMs }))
      scope = history.own ? "user" : "project"
      // A script whose start does not parse is left out of the children read (its run is unknown), so no NaN reaches the SQL.
      const scripts = history.rows.filter((r) => stmtType(r) === "SCRIPT" && r.job_id && Number.isFinite(parseTime(r.creation_time)))
      const parents = scripts.map((r) => r.job_id!)
      const sinceMs = Math.min(...scripts.map((r) => parseTime(r.creation_time)))
      const children = parents.length
        ? (await read((view) => bigqueryChildrenSql({ project, location, parents, sinceMs, view }))).rows
        : undefined
      // The boundary is read from the view the history came from.
      let boundary: Boundary | undefined
      try {
        const invocations = history.rows.map((r) => r.dbt_invocation_id ?? "").filter(Boolean)
        boundary = await boundaryFor(
          history.rows,
          (window) => bigqueryBoundarySql({ project, location, needle: needleFor(id), view: history.view, window }),
          invocations.length
            ? (window) => bigqueryInvocationSql({ project, location, needle: needleFor(id), view: history.view, window, invocations })
            : undefined,
        )
      } catch (e) {
        if (!(e instanceof BoundaryUnreadable)) throw e
        return {
          cost: scoped(none(`could not check for runs still in progress: ${errorDetail(e.message)}.`)),
          capacity: history.rows.some((r) => r.reservation_id) ? true : pricing,
        }
      }
      ;({ cost, reserved } = priceBigquery(history.rows, children, uniqueId, cfg, boundary, { materialized, location: where, asOfMs, target: targetName }))
      if (scope) cost.scope = scope
      if (cost.basis === "history" && reserved && pricing === false)
        cost.notes.push(
          "This model's runs include reservation jobs, but the project's jobs of the last 7 days were all on demand: the pricing may have changed, so the dry run is not priced.",
        )
      if (cost.basis === "history" && !reserved && pricing === true)
        cost.notes.push(
          "This model's runs were all on demand, but the project's jobs of the last 7 days include reservation jobs: the pricing may have changed, so the dry run is not priced.",
        )
    } catch (e) {
      if (signal.aborted) throw e
      cost = scoped(unreadable(message(e), where))
    }
    return { cost, capacity: reserved ? true : pricing }
  }
}
