// altimate_change - new file
import { isLocalFilePath, type Connector } from "@altimateai/drivers"
import type { Tool } from "../../tool/tool"
import * as Registry from "../native/connections/registry"
import { isScratch } from "../native/connections/scratch"

/**
 * Evidence that answer_commit gathers before accepting an answer: requested filters that removed
 * nothing, and alternative readings whose queries disagree. Every check re-runs bounded queries on
 * local DuckDB only (the session scratch database or a local DuckDB file) and never calls a model.
 */

/** Whole budget for each check. Past it the check is dropped and the commit proceeds unchanged. */
export const EVIDENCE_BUDGET_MS = 250
/**
 * Every base table a re-run reads must be a local DuckDB table with at most this many rows
 * (catalog estimate). Local queries are never interrupted (that restarts the engine and drops the
 * session's scratch tables), so this ceiling is what keeps the work short.
 */
export const LOCAL_ROW_CEILING = 500_000
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

async function rows(connector: Connector, sql: string): Promise<Record<string, unknown>[]> {
  // No short timeout, deadline or abort: interrupting a local engine restarts its helper and drops
  // session state. The row ceiling keeps the work far below the connection's own timeout.
  const response = await connector.execute(sql, undefined, undefined, { noLimit: true, readOnly: true })
  return response.rows.map((row: unknown[]) =>
    Object.fromEntries(response.columns.map((col: string, i: number) => [col, row[i]])),
  )
}

async function serialize(connector: Connector, sql: string): Promise<Json | undefined> {
  const [parsed] = await rows(connector, `SELECT json_serialize_sql(${literal(sql)}) AS j`)
  // uint64 locations lose precision in JSON.parse; they are not needed.
  const statement = JSON.parse(String(parsed?.j ?? "").replace(/"query_location":\s*\d+/g, '"query_location":0'))
  if (statement?.error || statement?.statements?.length !== 1) return undefined
  return statement
}

async function deserialize(connector: Connector, statement: Json): Promise<string | undefined> {
  const [row] = await rows(connector, `SELECT json_deserialize_sql(${literal(JSON.stringify(statement))}) AS s`)
  return typeof row?.s === "string" && row.s ? row.s : undefined
}

/** Every node of a parsed statement, depth first. */
function* nodes(value: Json): Generator<Json> {
  if (!value || typeof value !== "object") return
  yield value
  for (const child of Array.isArray(value) ? value : Object.values(value)) yield* nodes(child)
}

/**
 * Base-table references of a statement, or undefined when it reads anything else that could cost
 * more than a table scan or touch files (table functions such as `read_csv`), or joins without a
 * join condition (comma or CROSS joins), whose re-run without a WHERE filter would count a product.
 */
function baseTables(statement: Json): Json[] | undefined {
  const ctes = new Set<string>()
  for (const node of nodes(statement))
    for (const entry of node?.cte_map?.map ?? []) ctes.add(String(entry.key).toLowerCase())
  const tables: Json[] = []
  for (const node of nodes(statement)) {
    if (node?.type === "TABLE_FUNCTION") return undefined
    if (node?.type === "JOIN" && (node.ref_type !== "REGULAR" || !node.condition)) return undefined
    if (node?.type === "BASE_TABLE" && !ctes.has(String(node.table_name).toLowerCase())) tables.push(node)
  }
  return tables
}

/** The relation resolves to exactly one local DuckDB base table under the ceiling, and no view shares its name. */
async function smallLocalTable(connector: Connector, side: Json): Promise<boolean> {
  const name = literal(String(side.table_name))
  const scope = [
    side.schema_name ? `AND lower(schema_name) = lower(${literal(side.schema_name)})` : "",
    side.catalog_name ? `AND lower(database_name) = lower(${literal(side.catalog_name)})` : "",
  ].join(" ")
  const [views] = await rows(
    connector,
    `SELECT COUNT(*) AS n FROM duckdb_views() WHERE NOT internal AND lower(view_name) = lower(${name})`,
  )
  if (Number(views?.n) !== 0) return false
  const tables = await rows(
    connector,
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

async function allSmallLocal(connector: Connector, tables: Json[]): Promise<boolean> {
  for (const table of tables) if (!(await smallLocalTable(connector, table))) return false
  return true
}

/** Runs work within the budget; any error or overrun yields undefined. The work itself is not interrupted. */
async function withinBudget<T>(work: () => Promise<T | undefined>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), EVIDENCE_BUDGET_MS)
  })
  try {
    return await Promise.race([work().catch(() => undefined), timeout])
  } finally {
    clearTimeout(timer)
  }
}

const isNotNull = (conjunct: Json) => conjunct?.class === "OPERATOR" && conjunct.type === "OPERATOR_IS_NOT_NULL"

/**
 * Re-runs the counting core of the final query with each top-level WHERE filter removed in turn
 * and returns the filters whose removal keeps the same rows: they excluded nothing, which usually
 * means they target a different column than the question means. `IS NOT NULL` guards are skipped.
 */
export async function vacuousFilters(sql: string, warehouse: string): Promise<VacuousFilter[] | undefined> {
  if (!localDuckdb(warehouse) || !/\bwhere\b/i.test(sql)) return undefined
  return withinBudget(async () => {
    const connector = await Registry.get(warehouse)
    const statement = await serialize(connector, sql)
    const node = statement?.statements[0]?.node
    if (node?.type !== "SELECT_NODE" || !node.where_clause || node.cte_map?.map?.length) return undefined
    const tables = baseTables({ from: node.from_table, where: node.where_clause })
    // A subquery anywhere in the source or filters could cost more than the scans the ceiling bounds.
    if (!tables?.length || [...nodes([node.from_table, node.where_clause])].some((n) => n?.class === "SUBQUERY"))
      return undefined
    const where = node.where_clause
    const conjuncts: Json[] = where.type === "CONJUNCTION_AND" ? where.children : [where]
    if (conjuncts.length > MAX_CONJUNCTS || !(await allSmallLocal(connector, tables))) return undefined

    const [count] = (await serialize(connector, "SELECT COUNT(*) AS __n"))?.statements[0]?.node?.select_list ?? []
    if (!count) return undefined
    const counting = (filters: Json[]) => ({
      ...statement,
      statements: [
        {
          ...statement.statements[0],
          node: {
            ...node,
            select_list: [count],
            where_clause: !filters.length
              ? null
              : filters.length === 1
                ? filters[0]
                : { class: "CONJUNCTION", type: "CONJUNCTION_AND", alias: "", query_location: 0, children: filters },
            group_expressions: [],
            group_sets: [],
            having: null,
            qualify: null,
            modifiers: [],
          },
        },
      ],
    })
    const countOf = async (filters: Json[]) => {
      const text = await deserialize(connector, counting(filters))
      if (!text) throw new Error("count could not be rebuilt")
      const [row] = await rows(connector, text)
      return Number(row?.__n)
    }
    const kept = await countOf(conjuncts)
    if (!Number.isFinite(kept) || kept === 0) return undefined
    const found: VacuousFilter[] = []
    for (const [index, conjunct] of conjuncts.entries()) {
      if (isNotNull(conjunct)) continue
      const without = await countOf(conjuncts.filter((_, i) => i !== index))
      if (without !== kept) continue
      const text = await deserialize(connector, counting([conjunct]))
      const filter = text?.slice(text.search(/\bWHERE\b/i) + "WHERE".length).trim()
      if (filter) found.push({ filter, rows: kept })
    }
    return found
  })
}

/**
 * Executes each reading's SQL (bounded: local DuckDB, small base tables, at most MAX_READING_ROWS
 * rows) and compares the results as unordered row sets. Undefined when fewer than two readings carry
 * SQL or any of them cannot run under these limits.
 */
export async function compareReadings(
  readings: Reading[] | undefined,
  fallbackWarehouse: string | undefined,
): Promise<ReadingComparison | undefined> {
  const runnable = (readings ?? []).filter((r) => typeof r.sql === "string" && r.sql.trim())
  if (runnable.length < 2) return undefined
  return withinBudget(async () => {
    const results: string[] = []
    for (const reading of runnable) {
      const warehouse = reading.warehouse || fallbackWarehouse
      if (!warehouse || !localDuckdb(warehouse)) return undefined
      const connector = await Registry.get(warehouse)
      const statement = await serialize(connector, reading.sql!)
      const type = statement?.statements[0]?.node?.type
      if (type !== "SELECT_NODE" && type !== "SET_OPERATION_NODE") return undefined
      const tables = baseTables(statement)
      if (!tables?.length || !(await allSmallLocal(connector, tables))) return undefined
      const result = await rows(connector, `SELECT * FROM (${reading.sql}) __reading LIMIT ${MAX_READING_ROWS + 1}`)
      if (result.length > MAX_READING_ROWS) return undefined
      results.push(
        JSON.stringify(
          result.map((row) => JSON.stringify(Object.values(row).map((value) => String(value)))).sort(),
        ),
      )
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
  return withinBudget(async () => {
    const connector = await Registry.get(warehouse)
    const statement = await serialize(connector, sql)
    const node = statement?.statements[0]?.node
    if (node?.type !== "SELECT_NODE") return undefined
    const tables = baseTables({ from: node.from_table })
    if (!tables?.length || tables.length > 4) return undefined
    const used = new Set<string>()
    for (const n of nodes([node.where_clause, node.group_expressions]))
      if (n?.class === "COLUMN_REF") used.add(String(n.column_names.at(-1)).toLowerCase())
    if (!used.size) return []
    const names = tables.map((t) => literal(String(t.table_name).toLowerCase())).join(", ")
    const columns = await rows(
      connector,
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

/** Gathers the evidence for a commit. Undefined when the checks are off or nothing could be checked. */
export async function gatherEvidence(
  messages: Tool.Context["messages"],
  readings: Reading[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
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
