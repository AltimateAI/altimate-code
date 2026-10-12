/**
 * Value grounding for `schema_inspect`: one bounded profiling query per table that
 * returns, per column, the distinct count, null share and a few real values. The
 * values are what reveal stored formats (case, whitespace, prefixes) that a column
 * name and type never show.
 */
import { Dispatcher } from "../native"
import { isRecord, normalizeError } from "./response-normalization"

/** Rows scanned per table; keeps wide or large tables cheap. */
export const PROFILE_SAMPLE_ROWS = 10_000
/** Hard cap on profiled columns (one UNION ALL branch each). */
export const PROFILE_MAX_COLUMNS = 40
/** A column with at most this many distinct sampled values lists them all. */
export const PROFILE_LOW_CARDINALITY = 20
const PROFILE_EXAMPLES = 3
const PROFILE_VALUE_CHARS = 40
const PROFILE_TIMEOUT_MS = 15_000

export type ProfileDialect = "sqlite" | "duckdb" | "postgres"

const DIALECTS: Record<string, ProfileDialect> = {
  sqlite: "sqlite",
  duckdb: "duckdb",
  postgres: "postgres",
  postgresql: "postgres",
}

export interface ProfileColumn {
  name: string
  data_type?: string
}

interface ColumnProfile {
  name: string
  total: number
  nonNull: number
  distinct: number
  values: string[]
  text: boolean
}

const quote = (id: string) => `"${id.replace(/"/g, '""')}"`

/** Types whose text cast is meaningless or expensive; skipped. */
const UNPROFILABLE = /blob|bytea|binary|geometry|geography|vector/i
const TEXTUAL = /char|text|string|clob|uuid|enum|^$/i

export function profileDialect(type: string | undefined): ProfileDialect | undefined {
  return type ? DIALECTS[type.toLowerCase()] : undefined
}

export function buildProfileSql(table: string, columns: ProfileColumn[], dialect: ProfileDialect = "sqlite"): string {
  const sample = `WITH s AS (SELECT * FROM ${table} LIMIT ${PROFILE_SAMPLE_ROWS})`
  const aggregate = dialect === "sqlite" ? "json_group_array" : "array_agg"
  const branches = columns.map((c) => {
    const col = `CAST(${quote(c.name)} AS TEXT)`
    const lit = `'${c.name.replace(/'/g, "''")}'`
    return (
      `SELECT ${lit} AS col, COUNT(*) AS total, COUNT(${col}) AS nonnull, COUNT(DISTINCT ${col}) AS ndistinct, ` +
      `(SELECT ${aggregate}(v) FROM (SELECT DISTINCT ${col} AS v FROM s WHERE ${col} IS NOT NULL ` +
      `LIMIT ${PROFILE_LOW_CARDINALITY + 1}) AS sampled_values) AS vals FROM s`
    )
  })
  return `${sample}\n${branches.join("\nUNION ALL\n")}`
}

function clipRaw(value: string): string {
  const chars = Array.from(value)
  return chars.length > PROFILE_VALUE_CHARS ? chars.slice(0, PROFILE_VALUE_CHARS).join("") + "…" : value
}

function clip(value: string): string {
  const text = clipRaw(value)
  // Quote anything whose edges would otherwise be invisible.
  return text === "" || text !== text.trim() || /[\r\n\t]/.test(text) ? JSON.stringify(text) : text
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function parseValues(value: unknown): string[] {
  // SQLite returns JSON text; DuckDB/Postgres return native arrays (or null when empty).
  const values: unknown = typeof value === "string" ? JSON.parse(value) : value ?? []
  if (!Array.isArray(values) || !values.every((v) => typeof v === "string")) {
    throw new Error("unexpected profiling values")
  }
  return values
}

function parseRows(rows: unknown[], columns: ProfileColumn[]): ColumnProfile[] {
  const byName = new Map(columns.map((c) => [c.name, c]))
  const out: ColumnProfile[] = []
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    const meta = byName.get(String(row[0]))
    if (!meta) continue
    out.push({
      name: meta.name,
      total: num(row[1]),
      nonNull: num(row[2]),
      distinct: num(row[3]),
      values: parseValues(row[4]),
      text: TEXTUAL.test(meta.data_type ?? ""),
    })
  }
  return out
}

function renderProfile(p: ColumnProfile): string {
  const sampled = p.total >= PROFILE_SAMPLE_ROWS
  const nullPct = p.total > 0 ? Math.round(((p.total - p.nonNull) / p.total) * 100) : 0
  const nulls = nullPct > 0 ? `, ${nullPct}% null` : p.total > p.nonNull ? `, <1% null` : ""
  if (p.nonNull === 0) return `${p.name}: all NULL`
  const approx = sampled ? "~" : ""
  if (p.distinct <= PROFILE_LOW_CARDINALITY) {
    return `${p.name}: ${approx}${p.distinct} distinct — ${p.values.map(clip).join(", ")}${nulls}`
  }
  const examples = p.text && p.values.length ? `, e.g. ${p.values.slice(0, PROFILE_EXAMPLES).map((v) => JSON.stringify(clipRaw(v))).join(", ")}` : ""
  return `${p.name}: ${approx}${p.distinct.toLocaleString()} distinct${examples}${nulls}`
}

export interface ValueProfileInput {
  /** Table reference as it should appear in FROM (already qualified if needed). */
  table: string
  columns: ProfileColumn[]
  warehouse?: string
}

/** Never throws: a failed profile becomes a one-line note. */
export async function profileValues(input: ValueProfileInput): Promise<string> {
  try {
    const list = (await Dispatcher.call("warehouse.list", {})) as unknown
    const warehouses = (isRecord(list) && Array.isArray(list.warehouses) ? list.warehouses : []) as Array<{
      name?: string
      type?: string
    }>
    const target = input.warehouse ? warehouses.find((w) => w.name === input.warehouse) : warehouses[0]
    const dialect = profileDialect(target?.type)
    if (!target?.name || !dialect) {
      return `Value samples skipped: not supported for ${target?.type ?? "this"} connections.`
    }
    const eligible = input.columns.filter((c) => !UNPROFILABLE.test(c.data_type ?? ""))
    const cols = eligible.slice(0, PROFILE_MAX_COLUMNS)
    if (cols.length === 0) return ""
    const sql = buildProfileSql(input.table, cols, dialect)
    const res = (await Dispatcher.call("sql.execute", {
      sql,
      warehouse: target.name,
      limit: PROFILE_MAX_COLUMNS + 1,
      query_timeout_ms: PROFILE_TIMEOUT_MS,
    })) as unknown
    const data = isRecord(res) && isRecord(res.data) ? res.data : res
    const error = normalizeError(isRecord(res) ? res.error : undefined) ?? normalizeError(isRecord(data) ? data.error : undefined)
    if (error) throw new Error(error)
    if (!isRecord(data) || !Array.isArray(data.rows)) throw new Error("unexpected profiling response")
    const profiles = parseRows(data.rows, cols)
    const lines = profiles.map(renderProfile)
    if (lines.length === 0) return ""
    const sampled = profiles.some((p) => p.total >= PROFILE_SAMPLE_ROWS)
    const skipped = eligible.length - cols.length
    return [
      `Value samples${sampled ? ` (first ${PROFILE_SAMPLE_ROWS.toLocaleString()} rows)` : ""}:`,
      ...lines,
      ...(skipped > 0 ? [`(${skipped} more columns not profiled)`] : []),
    ].join("\n")
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 160)
    return `Value samples unavailable: ${msg}`
  }
}
