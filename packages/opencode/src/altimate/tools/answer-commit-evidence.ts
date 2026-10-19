// altimate_change - new file
import { isLocalFilePath, type Connector } from "@altimateai/drivers"
import type { Tool } from "../../tool/tool"
import * as Registry from "../native/connections/registry"
import { isScratch, withScratchSession } from "../native/connections/scratch"

/**
 * Evidence that answer_commit gathers before accepting an answer: requested filters that removed
 * nothing, and alternative readings whose queries disagree. Every check re-runs bounded queries on
 * local DuckDB only (the session scratch database or a local DuckDB file) and never calls a model.
 */

/** Whole budget for each check. Past it no further query is sent and the commit proceeds unchanged. */
export const EVIDENCE_BUDGET_MS = 250
/**
 * Every base table a re-run reads must be a local DuckDB table with at most this many rows
 * (catalog estimate). Local queries are never interrupted (that restarts the engine and drops the
 * session's scratch tables), so the ceiling and the row cap below keep each query short.
 */
export const LOCAL_ROW_CEILING = 500_000
/** Row counts stop at this many joined rows; a larger count cannot be compared and skips the check. */
export const COUNT_CAP = 1_000_000
/** More top-level filters than this skips the vacuous-filter check. */
export const MAX_CONJUNCTS = 6
/** Readings are compared on at most this many result rows; larger results are not compared. */
export const MAX_READING_ROWS = 200
/** Marker that identifies this check's one-time rejection in the current turn. */
export const REVIEW_MARKER = "answer_commit review:"

/** `ALTIMATE_SQL_AUTO_CHECK=off` disables automatic checks; they otherwise run on local DuckDB only. */
export function autoCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env["ALTIMATE_SQL_AUTO_CHECK"]?.trim().toLowerCase()
  return value !== "off" && value !== "0" && value !== "false"
}

type Json = any
type Reading = { clause: string; reading: string; sql?: string; warehouse?: string }

export type VacuousFilter = { filter: string; rows: number }
export type ReadingComparison = { compared: number; agree: boolean }
export type Evidence = {
  vacuous: VacuousFilter[]
  readings?: ReadingComparison
  alternatives: string[]
}

type LoosePart = { type?: string; tool?: string; state?: { status?: string; input?: Json; error?: unknown } }

/** Messages of the current user turn: everything after the latest user message, plus that message. */
function currentTurn(messages: Tool.Context["messages"]) {
  const start = messages.findLastIndex((message) => message.info.role === "user")
  return start < 0 ? messages : messages.slice(start)
}

function turnParts(messages: Tool.Context["messages"]): LoosePart[] {
  return currentTurn(messages).flatMap((message) => message.parts as LoosePart[])
}

/** Earlier review rejections from this check in the current turn. */
export function priorReviews(messages: Tool.Context["messages"]): number {
  return turnParts(messages).filter(
    (part) =>
      part.type === "tool" &&
      part.tool === "answer_commit" &&
      part.state?.status === "error" &&
      String(part.state.error ?? "").includes(REVIEW_MARKER),
  ).length
}

/** The latest completed plain `sql_execute` query of the current turn, with its warehouse. */
export function lastQuery(messages: Tool.Context["messages"]): { sql: string; warehouse: string } | undefined {
  const part = turnParts(messages).findLast(
    (part) =>
      part.type === "tool" &&
      part.tool === "sql_execute" &&
      part.state?.status === "completed" &&
      typeof part.state.input?.query === "string" &&
      typeof part.state.input?.warehouse === "string",
  )
  return part ? { sql: part.state!.input.query, warehouse: part.state!.input.warehouse } : undefined
}

const literal = (text: string) => `'${text.replace(/'/g, "''")}'`
/** A DuckDB path that names remote or extension storage; in-memory, empty and `file:` paths are local. */
const isRemotePath = (path: unknown) =>
  typeof path === "string" && path !== "" && path !== ":memory:" && !/^file:/i.test(path) && !isLocalFilePath(path)

/** True when the warehouse is the session scratch database or a local DuckDB file. */
function localDuckdb(warehouse: string): boolean {
  if (isScratch(warehouse)) return true
  const config = Registry.getConfig(warehouse)
  return (
    Registry.canonicalType(config?.type) === "duckdb" && !isRemotePath((config as { path?: unknown } | undefined)?.path)
  )
}

/**
 * A deadline-aware query runner. Once the budget has passed it refuses to send another query;
 * queries already running are never interrupted (that would restart the local engine).
 */
type Run = (sql: string) => Promise<Record<string, unknown>[]>
function runner(connector: Connector, deadline: number): Run {
  return async (sql) => {
    if (Date.now() >= deadline) throw new Error("evidence budget spent")
    const response = await connector.execute(sql, undefined, undefined, { noLimit: true, readOnly: true })
    return response.rows.map((row: unknown[]) =>
      Object.fromEntries(response.columns.map((col: string, i: number) => [col, row[i]])),
    )
  }
}

/** Runs the work within the budget; any error, refusal or overrun yields undefined. */
async function withinBudget<T>(work: (deadline: number) => Promise<T | undefined>): Promise<T | undefined> {
  const deadline = Date.now() + EVIDENCE_BUDGET_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), EVIDENCE_BUDGET_MS)
  })
  try {
    return await Promise.race([work(deadline).catch(() => undefined), timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function serialize(run: Run, sql: string): Promise<Json | undefined> {
  const [parsed] = await run(`SELECT json_serialize_sql(${literal(sql)}) AS j`)
  // uint64 locations lose precision in JSON.parse; they are not needed.
  const statement = JSON.parse(String(parsed?.j ?? "").replace(/"query_location":\s*\d+/g, '"query_location":0'))
  if (statement?.error || statement?.statements?.length !== 1) return undefined
  return statement
}

async function deserialize(run: Run, statement: Json): Promise<string | undefined> {
  const [row] = await run(`SELECT json_deserialize_sql(${literal(JSON.stringify(statement))}) AS s`)
  return typeof row?.s === "string" && row.s ? row.s : undefined
}

/** Every node of a parsed statement, depth first. */
function* nodes(value: Json): Generator<Json> {
  if (!value || typeof value !== "object") return
  yield value
  for (const child of Array.isArray(value) ? value : Object.values(value)) yield* nodes(child)
}

const isEquality = (n: Json) =>
  n?.type === "COMPARE_EQUAL" && n.left?.class === "COLUMN_REF" && n.right?.class === "COLUMN_REF"
/** A join condition with a column equality, so DuckDB hash-joins it and the row cap stops the work. */
const equiJoin = (condition: Json) =>
  isEquality(condition) || (condition?.type === "CONJUNCTION_AND" && condition.children.some(isEquality))

type PlainSelect = { node: Json; tables: Json[]; functions: Set<string> }
/**
 * The single SELECT of a statement whose cost the checks can bound, with its base tables and called
 * functions; undefined for anything else: set operations, CTEs, subqueries, table functions (which
 * can read files) and joins without a column equality (a nested-loop join is not bounded by the cap).
 */
function plainSelect(statement: Json): PlainSelect | undefined {
  const node = statement?.statements?.[0]?.node
  if (node?.type !== "SELECT_NODE") return undefined
  const tables: Json[] = []
  const functions = new Set<string>()
  for (const n of nodes(node)) {
    if (n?.cte_map?.map?.length) return undefined
    if (n?.class === "SUBQUERY" || n?.type === "SUBQUERY" || n?.type === "TABLE_FUNCTION") return undefined
    if (n?.type === "JOIN" && (n.ref_type !== "REGULAR" || !equiJoin(n.condition))) return undefined
    if (n?.type === "BASE_TABLE") tables.push(n)
    if (n?.class === "FUNCTION" && !n.is_operator) functions.add(String(n.function_name).toLowerCase())
  }
  return tables.length ? { node, tables, functions } : undefined
}

/** The relation resolves to exactly one local DuckDB base table under the ceiling, and no view shares its name. */
async function smallLocalTable(run: Run, side: Json): Promise<boolean> {
  const name = literal(String(side.table_name))
  const scope = [
    side.schema_name ? `AND lower(schema_name) = lower(${literal(side.schema_name)})` : "",
    side.catalog_name ? `AND lower(database_name) = lower(${literal(side.catalog_name)})` : "",
  ].join(" ")
  const [views] = await run(
    `SELECT COUNT(*) AS n FROM duckdb_views() WHERE NOT internal AND lower(view_name) = lower(${name})`,
  )
  if (Number(views?.n) !== 0) return false
  const tables = await run(
    `SELECT d.type AS type, d.path AS path, t.estimated_size AS size
     FROM duckdb_tables() t JOIN duckdb_databases() d USING (database_name)
     WHERE lower(t.table_name) = lower(${name}) ${scope}`,
  )
  const [table] = tables
  return (
    tables.length === 1 &&
    String(table.type).toLowerCase() === "duckdb" &&
    !isRemotePath(table.path) &&
    Number(table.size) <= LOCAL_ROW_CEILING
  )
}

/**
 * Every table is small and local, and every function is built in: a user macro can hide a large
 * read or an attached remote warehouse behind a function call.
 */
async function bounded(run: Run, select: PlainSelect): Promise<boolean> {
  if (select.functions.size) {
    const names = [...select.functions].map(literal).join(", ")
    const [user] = await run(
      `SELECT COUNT(*) AS n FROM duckdb_functions() WHERE NOT internal AND lower(function_name) IN (${names})`,
    )
    if (Number(user?.n) !== 0) return false
  }
  for (const table of select.tables) if (!(await smallLocalTable(run, table))) return false
  return true
}

const and = (filters: Json[]) =>
  !filters.length
    ? null
    : filters.length === 1
      ? filters[0]
      : { class: "CONJUNCTION", type: "CONJUNCTION_AND", alias: "", query_location: 0, children: filters }

/**
 * Counts the rows of the query's FROM under the given filters, stopping at COUNT_CAP + 1 rows so a
 * large join cannot run long. Grouping, HAVING, DISTINCT, ORDER and LIMIT are dropped: the count is
 * of the rows the filters keep. Undefined at or above the cap.
 */
async function cappedCount(run: Run, statement: Json, node: Json, filters: Json[]): Promise<number | undefined> {
  const [one] = (await serialize(run, "SELECT 1 AS __one"))?.statements[0]?.node?.select_list ?? []
  if (!one) return undefined
  const inner = {
    ...statement,
    statements: [
      {
        ...statement.statements[0],
        node: {
          ...node,
          select_list: [one],
          where_clause: and(filters),
          group_expressions: [],
          group_sets: [],
          having: null,
          qualify: null,
          modifiers: [],
        },
      },
    ],
  }
  const text = await deserialize(run, inner)
  if (!text) return undefined
  const [row] = await run(`SELECT COUNT(*) AS __n FROM (${text} LIMIT ${COUNT_CAP + 1}) __capped`)
  const n = Number(row?.__n)
  return Number.isFinite(n) && n <= COUNT_CAP ? n : undefined
}

const isNotNull = (conjunct: Json) => conjunct?.class === "OPERATOR" && conjunct.type === "OPERATOR_IS_NOT_NULL"

/**
 * Re-counts the final query's rows with each top-level WHERE filter removed in turn and returns
 * the filters whose removal keeps the same rows: they excluded nothing, which usually means they
 * target a different column than the question means. `IS NOT NULL` guards are skipped.
 */
export async function vacuousFilters(sql: string, warehouse: string): Promise<VacuousFilter[] | undefined> {
  if (!localDuckdb(warehouse) || !/\bwhere\b/i.test(sql)) return undefined
  return withinBudget(async (deadline) => {
    const run = runner(await Registry.get(warehouse), deadline)
    const statement = await serialize(run, sql)
    const select = plainSelect(statement)
    if (!select?.node.where_clause) return undefined
    const where = select.node.where_clause
    const conjuncts: Json[] = where.type === "CONJUNCTION_AND" ? where.children : [where]
    if (conjuncts.length > MAX_CONJUNCTS || !(await bounded(run, select))) return undefined
    const kept = await cappedCount(run, statement, select.node, conjuncts)
    if (kept === undefined || kept === 0) return undefined
    const found: VacuousFilter[] = []
    for (const [index, conjunct] of conjuncts.entries()) {
      if (isNotNull(conjunct)) continue
      const without = await cappedCount(
        run,
        statement,
        select.node,
        conjuncts.filter((_, i) => i !== index),
      )
      if (without !== kept) continue
      const text = await deserialize(run, {
        ...statement,
        statements: [{ ...statement.statements[0], node: { ...select.node, where_clause: conjunct, modifiers: [] } }],
      })
      const at = text?.search(/\bWHERE\b/i) ?? -1
      const filter = at >= 0 ? text!.slice(at + "WHERE".length).trim() : ""
      if (filter) found.push({ filter, rows: kept })
    }
    return found
  })
}

/** A cell with its type kept, so NULL, `'null'`, `1` and `'1'` stay distinct. */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (typeof value === "bigint") return `n:${value.toString()}`
  if (typeof value === "number") return `n:${value}`
  if (typeof value === "string") return `s:${value}`
  if (typeof value === "boolean") return `b:${value}`
  if (value instanceof Date) return `d:${value.toISOString()}`
  return `o:${JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`
}

/**
 * Executes each reading's SQL (bounded: plain SELECT on local DuckDB, small base tables, at most
 * COUNT_CAP joined rows and MAX_READING_ROWS result rows) and compares the results as unordered row
 * sets. Undefined when fewer than two readings carry SQL or any of them cannot run under these limits.
 */
export async function compareReadings(
  readings: Reading[] | undefined,
  fallbackWarehouse: string | undefined,
): Promise<ReadingComparison | undefined> {
  const runnable = (readings ?? []).filter((r) => typeof r.sql === "string" && r.sql.trim())
  if (runnable.length < 2) return undefined
  return withinBudget(async (deadline) => {
    const results: string[] = []
    for (const reading of runnable) {
      const warehouse = reading.warehouse || fallbackWarehouse
      if (!warehouse || !localDuckdb(warehouse)) return undefined
      const run = runner(await Registry.get(warehouse), deadline)
      const statement = await serialize(run, reading.sql!)
      const select = plainSelect(statement)
      if (!select || !(await bounded(run, select))) return undefined
      const where = select.node.where_clause
      const filters: Json[] = !where ? [] : where.type === "CONJUNCTION_AND" ? where.children : [where]
      // Bound the rows the reading aggregates before running it.
      if ((await cappedCount(run, statement, select.node, filters)) === undefined) return undefined
      const text = await deserialize(run, statement)
      if (!text) return undefined
      const result = await run(`SELECT * FROM (${text}) __reading LIMIT ${MAX_READING_ROWS + 1}`)
      if (result.length > MAX_READING_ROWS) return undefined
      results.push(JSON.stringify(result.map((row) => Object.values(row).map(canonical).join("\u0001")).sort()))
    }
    return { compared: results.length, agree: results.every((result) => result === results[0]) }
  })
}

const DATE_LIKE = /(^|_)(date|time|timestamp|day|month|year|period|week|quarter)s?($|_)|_(at|on)$/i
const STATUS_LIKE = /(^|_)(status|state|stage|phase|type|category|flag|active|is)($|_)/i
const kind = (name: string, type: string) =>
  /^(date|timestamp|time)/i.test(type) || DATE_LIKE.test(name) ? "date" : STATUS_LIKE.test(name) ? "status" : undefined

/**
 * Columns of the same tables that could be meant instead of the date-like or status-like columns the
 * final query filters or groups by. Deterministic from the catalog; no data is read.
 */
export async function alternativeColumns(sql: string, warehouse: string): Promise<string[] | undefined> {
  if (!localDuckdb(warehouse)) return undefined
  return withinBudget(async (deadline) => {
    const run = runner(await Registry.get(warehouse), deadline)
    const select = plainSelect(await serialize(run, sql))
    if (!select || select.tables.length > 4) return undefined
    const used = new Set<string>()
    for (const n of nodes([select.node.where_clause, select.node.group_expressions]))
      if (n?.class === "COLUMN_REF") used.add(String(n.column_names.at(-1)).toLowerCase())
    if (!used.size) return []
    const names = select.tables.map((t) => literal(String(t.table_name).toLowerCase())).join(", ")
    const columns = await run(
      `SELECT table_name AS t, column_name AS c, data_type AS d FROM duckdb_columns()
       WHERE lower(table_name) IN (${names}) ORDER BY table_name, column_index`,
    )
    const lines: string[] = []
    for (const table of new Set(columns.map((c) => String(c.t)))) {
      const own = columns.filter((c) => String(c.t) === table)
      for (const group of ["date", "status"] as const) {
        const members = own.filter((c) => kind(String(c.c), String(c.d)) === group).map((c) => String(c.c))
        const chosen = members.filter((c) => used.has(c.toLowerCase()))
        const others = members.filter((c) => !used.has(c.toLowerCase()))
        if (chosen.length && others.length)
          lines.push(`${table}: uses ${chosen.join(", ")}; other ${group}-like columns: ${others.join(", ")}`)
      }
    }
    return lines
  })
}

/**
 * Synchronous gate: true only when the checks are on, no review ran yet in this turn, and there is
 * something to re-run (a final local query, or at least two readings with SQL). Commits that fail
 * the gate stay fully synchronous.
 */
export function needsEvidence(
  messages: Tool.Context["messages"],
  readings: Reading[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!autoCheckEnabled(env) || priorReviews(messages) > 0) return false
  const query = lastQuery(messages)
  if (query && localDuckdb(query.warehouse)) return true
  return (readings ?? []).filter((r) => typeof r.sql === "string" && r.sql.trim()).length >= 2
}

/**
 * Gathers the evidence for a commit, with the scratch warehouse bound to the committing session.
 * Undefined when the checks are off or nothing could be checked.
 */
export function gatherEvidence(
  sessionID: string,
  messages: Tool.Context["messages"],
  readings: Reading[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Evidence | undefined> {
  return withScratchSession(sessionID, () => evidenceFor(messages, readings, env))
}

async function evidenceFor(
  messages: Tool.Context["messages"],
  readings: Reading[] | undefined,
  env: NodeJS.ProcessEnv,
): Promise<Evidence | undefined> {
  if (!autoCheckEnabled(env)) return undefined
  const query = lastQuery(messages)
  const vacuous = query ? ((await vacuousFilters(query.sql, query.warehouse)) ?? []) : []
  const comparison = await compareReadings(readings, query?.warehouse)
  if (!vacuous.length && !comparison) return undefined
  const findings = vacuous.length > 0 || comparison?.agree === false
  const alternatives = findings && query ? ((await alternativeColumns(query.sql, query.warehouse)) ?? []) : []
  return { vacuous, readings: comparison, alternatives }
}

/** The one-time review text, or undefined when the evidence needs no second look. */
export function reviewMessage(evidence: Evidence | undefined, readingEvidence: string | undefined): string | undefined {
  if (!evidence) return undefined
  const disagree = evidence.readings?.agree === false && !readingEvidence?.trim()
  if (!evidence.vacuous.length && !disagree) return undefined
  const lines = [`${REVIEW_MARKER} not committed yet; check this evidence once.`]
  for (const v of evidence.vacuous)
    lines.push(
      `- Filter ${v.filter} removed 0 of the ${v.rows} rows the other filters keep. Confirm it targets the column the question means; a filter that excludes nothing often sits on the wrong column.`,
    )
  if (disagree)
    lines.push(
      `- The ${evidence.readings!.compared} readings you listed return different results. Choose with data, not wording, and state the deciding fact in reading_evidence.`,
    )
  if (evidence.alternatives.length) {
    lines.push("- Columns that could be meant instead:")
    for (const alternative of evidence.alternatives) lines.push(`  ${alternative}`)
  }
  lines.push(
    "If the answer stands, call answer_commit again with the same answer (add reading_evidence when readings disagree); otherwise revise the query first.",
  )
  return lines.join("\n")
}
