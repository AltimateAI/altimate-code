/**
 * Value grounding for `schema_inspect`: one bounded profiling query per table that
 * returns, per column, the distinct count, null share and the most frequent real
 * values with their counts. The values are what reveal stored formats (case,
 * whitespace, prefixes) that a column name and type never show; uniqueness and the
 * value shape of text columns show keys and code formats at a glance. MongoDB
 * collections get the same profile, computed in TypeScript from sampled documents.
 */
import type { LegacyContext } from "../tool-zod-compat"
import * as Precedence from "../workspace/precedence"
import { Dispatcher } from "../native"
import * as Registry from "../native/connections/registry"
import { isRecord, normalizeError } from "./response-normalization"

/** Rows scanned per table; keeps wide or large tables cheap. */
export const PROFILE_SAMPLE_ROWS = 10_000
/** Hard cap on profiled columns (one UNION ALL branch each). */
export const PROFILE_MAX_COLUMNS = 40
/** A column with at most this many distinct sampled values lists them all. */
export const PROFILE_LOW_CARDINALITY = 20
const PROFILE_EXAMPLES = 3
const PROFILE_VALUE_CHARS = 40
/** Frequency-ranked values fetched per column; feeds examples, counts and shapes. */
const PROFILE_FETCHED_VALUES = 50
/** Fetched values are clipped to this many characters, bounding transfer for long text. */
const PROFILE_FETCH_CHARS = 200
/** Text whose typical value exceeds the normal clip shows one longer example. */
const PROFILE_LONG_EXAMPLE_CHARS = 160
/** Above this average length, or this many distinct shapes, text is free text and gets no shape. */
const PROFILE_SHAPE_MAX_AVG_CHARS = 30
const PROFILE_SHAPE_MAX_VARIETY = 5
const PROFILE_SHAPES_SHOWN = 3
/** Documents sampled for MongoDB collections. */
export const PROFILE_SAMPLE_DOCUMENTS = 100
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

interface ValueCount {
  value: string
  count: number
}

interface ColumnProfile {
  name: string
  total: number
  nonNull: number
  distinct: number
  /** Most frequent values; sorted by `rank` before use. */
  values: ValueCount[]
  text: boolean
  /** Rows or documents with no value, when that differs from `total - nonNull` (unrenderable values). */
  nulls?: number
  /** Set for values that can repeat inside one row (array elements), where uniqueness is meaningless. */
  multi?: boolean
  /** Column type suggests a format already (uuid), so a shape adds nothing. */
  typed?: boolean
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
    // Values are grouped and ranked in full; only the selected entries are clipped for transfer.
    // Each entry is "<count>:<value>"; the count is digits only, so the first colon splits it.
    return (
      `SELECT ${lit} AS col, COUNT(*) AS total, COUNT(${col}) AS nonnull, COUNT(DISTINCT ${col}) AS ndistinct, ` +
      `(SELECT ${aggregate}(CAST(pn AS TEXT) || ':' || SUBSTR(pv, 1, ${PROFILE_FETCH_CHARS})) FROM (SELECT ${col} AS pv, COUNT(*) AS pn FROM s ` +
      `WHERE ${col} IS NOT NULL GROUP BY ${col} ORDER BY pn DESC, pv LIMIT ${PROFILE_FETCHED_VALUES}) AS top_values) AS vals FROM s`
    )
  })
  return `${sample}\n${branches.join("\nUNION ALL\n")}`
}

function clipTo(value: string, max: number): string {
  const chars = Array.from(value)
  return chars.length > max ? chars.slice(0, max).join("") + "…" : value
}

function clip(value: string): string {
  const text = clipTo(value, PROFILE_VALUE_CHARS)
  // Quote anything whose edges would otherwise be invisible.
  return text === "" || text !== text.trim() || /[\r\n\t]/.test(text) ? JSON.stringify(text) : text
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function parseValues(value: unknown): ValueCount[] {
  // SQLite returns JSON text; DuckDB/Postgres return native arrays (or null when empty).
  const entries: unknown = typeof value === "string" ? JSON.parse(value) : value ?? []
  if (!Array.isArray(entries)) throw new Error("unexpected profiling values")
  return entries.map((entry) => {
    const match = typeof entry === "string" ? /^(\d+):([\s\S]*)$/.exec(entry) : null
    if (!match) throw new Error("unexpected profiling values")
    return { value: match[2]!, count: Number(match[1]) }
  })
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
      typed: /uuid/i.test(meta.data_type ?? ""),
    })
  }
  return out
}

/**
 * Character-class pattern of a string: upper letters A, lower letters a, digits 9;
 * punctuation and spaces stay. Runs of one class collapse to a symbol plus "+", so
 * `H01M4/9066` becomes `A9+A9/9+`.
 */
export function valueShape(value: string): string {
  let out = ""
  let prev = ""
  let run = 0
  const flush = () => {
    if (run > 1) out += "+"
    run = 0
    prev = ""
  }
  for (const ch of value) {
    const cls = /\p{Lu}/u.test(ch) ? "A" : /\p{L}/u.test(ch) ? "a" : /\p{Nd}/u.test(ch) ? "9" : ""
    if (!cls) {
      flush()
      out += ch
    } else if (cls === prev) {
      run++
    } else {
      flush()
      out += cls
      prev = cls
      run = 1
    }
  }
  flush()
  return out
}

function rank(values: ValueCount[]): ValueCount[] {
  return [...values].sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
}

function averageLength(values: ValueCount[]): number {
  const weight = values.reduce((n, v) => n + v.count, 0)
  if (weight === 0) return 0
  return values.reduce((n, v) => n + Array.from(v.value).length * v.count, 0) / weight
}

/** Top shapes with their share of the fetched values, or "" when the shape is uninformative. */
function renderShapes(values: ValueCount[], avgLength: number): string {
  if (avgLength > PROFILE_SHAPE_MAX_AVG_CHARS) return ""
  const shapes = new Map<string, number>()
  for (const v of values) {
    const shape = valueShape(v.value)
    shapes.set(shape, (shapes.get(shape) ?? 0) + v.count)
  }
  if (shapes.size > PROFILE_SHAPE_MAX_VARIETY) return ""
  // A lone letters-only shape (`Aa+`) is just "words"; the type already says as much.
  if (shapes.size === 1 && /^[Aa+]+$/.test([...shapes.keys()][0]!)) return ""
  const weight = values.reduce((n, v) => n + v.count, 0)
  return [...shapes]
    .sort((a, b) => b[1] - a[1])
    .slice(0, PROFILE_SHAPES_SHOWN)
    .map(([shape, n]) => (shapes.size === 1 ? `\`${shape}\`` : `\`${shape}\` ${Math.round((n / weight) * 100)}%`))
    .join(", ")
}

function renderProfile(p: ColumnProfile, sampled: boolean): string {
  const missing = p.nulls ?? p.total - p.nonNull
  const nullPct = p.total > 0 ? Math.round((missing / p.total) * 100) : 0
  const nulls = nullPct > 0 ? `, ${nullPct}% null` : missing > 0 ? `, <1% null` : ""
  if (p.nonNull === 0) return `${p.name}: all NULL`
  const approx = sampled ? "~" : ""
  const unique = !p.multi && p.total > 1 && p.nonNull > 1 && p.distinct === p.nonNull
  const head = `${p.name}: ${approx}${p.distinct.toLocaleString()} distinct${unique ? ", unique in sample" : ""}`
  const values = rank(p.values)
  // When every value occurs once the counts carry no information.
  const counted = (text: string, v: ValueCount) => (unique ? text : `${text} (${v.count.toLocaleString()})`)
  if (p.distinct <= PROFILE_LOW_CARDINALITY) {
    return `${head} — ${values.map((v) => counted(clip(v.value), v)).join(", ")}${nulls}`
  }
  if (!p.text || values.length === 0) return `${head}${nulls}`
  const long = averageLength(values) > PROFILE_VALUE_CHARS
  const examples = values
    .slice(0, PROFILE_EXAMPLES)
    .map((v, i) => counted(JSON.stringify(clipTo(v.value, long && i === 0 ? PROFILE_LONG_EXAMPLE_CHARS : PROFILE_VALUE_CHARS)), v))
    .join(", ")
  const shapes = p.typed ? "" : renderShapes(values, averageLength(values))
  return `${head}, e.g. ${examples}${shapes ? `, shape ${shapes}` : ""}${nulls}`
}

function formatProfiles(profiles: ColumnProfile[], header: string, skipped: number, sampled: boolean, notice?: string): string {
  if (profiles.length === 0) return ""
  return [
    ...(notice ? [notice] : []),
    header,
    ...profiles.map((p) => renderProfile(p, sampled)),
    ...(skipped > 0 ? [`(${skipped} more columns not profiled)`] : []),
  ].join("\n")
}

interface BsonValue {
  _bsontype?: string
  [key: string]: any
}

const UUID_DASHES = /^(.{8})(.{4})(.{4})(.{4})(.{12})$/

/** MongoDB type name and display text of a value; `text` is absent when it has no useful text form. */
function describeValue(value: unknown): { type: string; text?: string } {
  if (value === null || value === undefined) return { type: "null" }
  if (typeof value === "string") return { type: "string", text: value }
  if (typeof value === "boolean") return { type: "bool", text: String(value) }
  if (typeof value === "number") return { type: Number.isInteger(value) ? "int32" : "double", text: String(value) }
  if (typeof value === "bigint") return { type: "int64", text: String(value) }
  if (Array.isArray(value)) return { type: "array" }
  if (value instanceof Date) return { type: "date", text: Number.isNaN(value.getTime()) ? undefined : value.toISOString() }
  const v = value as BsonValue
  switch (v._bsontype) {
    case undefined:
      return { type: "object" }
    case "ObjectId":
    case "ObjectID":
      return { type: "objectId", text: v.toHexString?.() ?? String(v) }
    case "Decimal128":
      return { type: "decimal128", text: String(v) }
    case "Long":
      return { type: "int64", text: String(v) }
    case "Int32":
      return { type: "int32", text: String(v) }
    case "Double":
      return { type: "double", text: String(v) }
    case "Timestamp":
      // `t` is seconds since the epoch and `i` the ordinal within that second.
      return { type: "timestamp", text: typeof v.t === "number" ? `Timestamp(${v.t}, ${v.i})` : undefined }
    case "BSONRegExp":
      return { type: "regex", text: `/${v.pattern}/${v.options ?? ""}` }
    case "Code":
      return { type: "javascript", text: String(v.code) }
    case "BSONSymbol":
      return { type: "symbol", text: String(v.value) }
    case "MinKey":
      return { type: "minKey", text: "MinKey" }
    case "MaxKey":
      return { type: "maxKey", text: "MaxKey" }
    case "Binary": {
      if (v.sub_type !== 4 || typeof v.toUUID !== "function") return { type: "binary" }
      const hex = String(v.toUUID().toHexString()).replace(/-/g, "")
      return { type: "uuid", text: hex.replace(UUID_DASHES, "$1-$2-$3-$4-$5") }
    }
    default:
      return { type: String(v._bsontype).toLowerCase() }
  }
}

/** Deepest field path reported, counting each key as one segment. */
const NESTED_MAX_DEPTH = 3
const NESTED_MAX_LISTED = 60

interface DocField {
  /** Key segments from the document root; never re-split from `name`, since keys may contain ".". */
  path: string[]
  /** MongoDB dot notation, as it is written in a filter or projection. */
  name: string
  types: Set<string>
  /** Sampled documents containing the field. */
  docs: number
  /** The path passes through an array of objects. */
  inArray: boolean
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Fields of the sampled documents to depth 3: top-level keys plus nested keys, descending into arrays of objects. */
function collectFields(docs: Record<string, unknown>[]): DocField[] {
  const fields = new Map<string, DocField>()
  for (const doc of docs) {
    const seen = new Set<string>()
    const visit = (value: Record<string, unknown>, parent: string[], inArray: boolean) => {
      for (const [key, child] of Object.entries(value)) {
        const path = [...parent, key]
        const id = path.join("\0")
        const field = fields.get(id) ?? { path, name: path.join("."), types: new Set<string>(), docs: 0, inArray }
        field.types.add(describeValue(child).type)
        // A path seen both inside and outside arrays stays an array element.
        field.inArray ||= inArray
        if (!seen.has(id)) {
          seen.add(id)
          field.docs++
        }
        fields.set(id, field)
        if (path.length >= NESTED_MAX_DEPTH) continue
        if (isPlainObject(child)) visit(child, path, inArray)
        else if (Array.isArray(child)) {
          for (const element of child) if (isPlainObject(element)) visit(element, path, true)
        }
      }
    }
    visit(doc, [], false)
  }
  return [...fields.values()]
}

/** Values at a key path; arrays met on the way are searched element by element. */
function valuesAt(doc: Record<string, unknown>, path: string[]): unknown[] {
  let current: unknown[] = [doc]
  for (const key of path) {
    const next: unknown[] = []
    for (const item of current) {
      for (const candidate of Array.isArray(item) ? item : [item]) {
        if (isRecord(candidate) && Object.hasOwn(candidate, key)) next.push(candidate[key])
      }
    }
    current = next
  }
  return current
}

const CONTAINER_ONLY = /^(object|array)$/

function renderNested(fields: DocField[], docCount: number): string {
  if (fields.length === 0) return ""
  const listed = fields.slice(0, NESTED_MAX_LISTED).map((f) => {
    const notes = [
      ...(f.inArray ? ["array element"] : []),
      ...(f.docs < docCount ? [`in ${Math.round((f.docs / docCount) * 100)}% of docs`] : []),
    ]
    return `${f.name}: ${[...f.types].filter((t) => t !== "null").join(" | ") || "null"}${notes.length ? ` (${notes.join(", ")})` : ""}`
  })
  const more = fields.length - listed.length
  return [`Nested fields (sampled ${docCount} docs):`, ...listed, ...(more > 0 ? [`(${more} more not listed)`] : [])].join("\n")
}

function profileField(docs: Record<string, unknown>[], f: DocField): string | ColumnProfile {
  const counts = new Map<string, number>()
  let present = 0
  let rendered = 0
  for (const doc of docs) {
    let hasValue = false
    let hasText = false
    for (const raw of valuesAt(doc, f.path)) {
      const { text } = describeValue(raw)
      if (raw === null || raw === undefined) continue
      hasValue = true
      if (text === undefined) continue
      hasText = true
      counts.set(text, (counts.get(text) ?? 0) + 1)
    }
    if (hasValue) present++
    if (hasText) rendered++
  }
  const types = [...f.types].filter((t) => t !== "null")
  // Never report "all NULL" for values that exist but have no text form.
  if (present > 0 && rendered === 0) return `${f.name}: values not profiled (${types.join(" | ")})`
  return {
    name: f.name,
    total: docs.length,
    nonNull: rendered,
    nulls: docs.length - present,
    distinct: counts.size,
    // Counted on the full text; only the kept values are clipped.
    values: rank([...counts].map(([value, count]) => ({ value, count })))
      .slice(0, PROFILE_FETCHED_VALUES)
      .map((v) => ({ value: v.value.slice(0, PROFILE_FETCH_CHARS), count: v.count })),
    text: types.some((t) => t === "string" || t === "uuid"),
    multi: f.inArray,
    typed: types.length === 1 && types[0] === "uuid",
  }
}

/**
 * Nested-field listing and value profile for sampled documents, in the same format as the SQL
 * profile. Fields come from the same documents the values do, so presence and counts agree.
 */
export function profileDocuments(docs: Record<string, unknown>[]): string {
  if (docs.length === 0) return ""
  const fields = collectFields(docs).sort((a, b) => a.name.localeCompare(b.name))
  const nested = fields.filter((f) => f.path.length > 1)
  const eligible = fields.filter((f) => {
    const types = [...f.types].filter((t) => t !== "null")
    return types.length === 0 || !types.every((t) => CONTAINER_ONLY.test(t))
  })
  // Top-level fields come first so the column cap never crowds them out with nested paths.
  const ordered = [...eligible.filter((f) => f.path.length === 1), ...eligible.filter((f) => f.path.length > 1)]
  const cols = ordered.slice(0, PROFILE_MAX_COLUMNS)
  const results = cols.map((f) => profileField(docs, f))
  const sampled = docs.length >= PROFILE_SAMPLE_DOCUMENTS
  const lines = results.map((r) => (typeof r === "string" ? r : renderProfile(r, sampled)))
  const values = [
    `Value samples${sampled ? ` (first ${PROFILE_SAMPLE_DOCUMENTS} documents)` : ""}:`,
    ...lines,
    ...(ordered.length > cols.length ? [`(${ordered.length - cols.length} more columns not profiled)`] : []),
  ].join("\n")
  return [renderNested(nested, docs.length), values].filter(Boolean).join("\n\n")
}

export interface ValueProfileInput {
  /** Table reference as it should appear in FROM (already qualified if needed). */
  table: string
  columns: ProfileColumn[]
  warehouse?: string
  /** Database and collection, used instead of `table` for MongoDB. */
  document?: { database: string; collection: string }
}

/** Never throws: a failed profile becomes a one-line note. */
export async function profileValues(
  input: ValueProfileInput,
  ctx: Pick<LegacyContext, "sessionID" | "ask"> & { abort?: AbortSignal },
): Promise<string> {
  try {
    const list = (await Dispatcher.call("warehouse.list", {})) as unknown
    const warehouses = (isRecord(list) && Array.isArray(list.warehouses) ? list.warehouses : []) as Array<{
      name?: string
      type?: string
    }>
    const target = input.warehouse ? warehouses.find((w) => w.name === input.warehouse) : warehouses[0]
    const dialect = profileDialect(target?.type)
    if (target?.name && input.document && Registry.canonicalType(target.type) === "mongodb") {
      return await profileCollection(input.document, target.name, ctx)
    }
    if (!target?.name || !dialect) {
      return `Value samples skipped: not supported for ${target?.type ?? "this"} connections.`
    }
    const eligible = input.columns.filter((c) => !UNPROFILABLE.test(c.data_type ?? ""))
    const cols = eligible.slice(0, PROFILE_MAX_COLUMNS)
    if (cols.length === 0) return ""
    const sql = buildProfileSql(input.table, cols, dialect)
    await ctx.ask({
      permission: "sql_execute",
      patterns: [sql],
      always: ["*"],
      metadata: { warehouse: target.name },
    })
    const precedence = await Precedence.check(ctx.sessionID, "sql_execute", target.name)
    if (precedence.redirect) return `Value samples skipped: ${precedence.redirect.output}`
    const res = (await Dispatcher.call("sql.execute", {
      sql,
      warehouse: target.name,
      limit: PROFILE_MAX_COLUMNS + 1,
      query_timeout_ms: PROFILE_TIMEOUT_MS,
      ...(dialect === "postgres" ? { read_only: true } : {}),
    }, { signal: ctx.abort, sessionID: ctx.sessionID })) as unknown
    const data = isRecord(res) && isRecord(res.data) ? res.data : res
    const error = normalizeError(isRecord(res) ? res.error : undefined) ?? normalizeError(isRecord(data) ? data.error : undefined)
    if (error) throw new Error(error)
    if (!isRecord(data) || !Array.isArray(data.rows)) throw new Error("unexpected profiling response")
    const profiles = parseRows(data.rows, cols)
    const sampled = profiles.some((p) => p.total >= PROFILE_SAMPLE_ROWS)
    return formatProfiles(
      profiles,
      `Value samples${sampled ? ` (first ${PROFILE_SAMPLE_ROWS.toLocaleString()} rows)` : ""}:`,
      eligible.length - cols.length,
      sampled,
      precedence.notice,
    )
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 160)
    return `Value samples unavailable: ${msg}`
  }
}

type ProfileContext = Pick<LegacyContext, "sessionID" | "ask"> & { abort?: AbortSignal }

/**
 * Read-only: samples documents through the connector rather than `sql.execute`, which flattens
 * each document to strings per column and would lose the nested structure the profile reads.
 * The find is bounded by `maxTimeMS` and cancelled with the tool call.
 */
async function profileCollection(
  document: { database: string; collection: string },
  warehouse: string,
  ctx: ProfileContext,
): Promise<string> {
  const connector = await Registry.get(warehouse)
  if (!connector.sampleDocuments) return "Value samples skipped: not supported for mongodb connections."
  await ctx.ask({
    permission: "sql_execute",
    patterns: [JSON.stringify({ ...document, command: "find", limit: PROFILE_SAMPLE_DOCUMENTS })],
    always: ["*"],
    metadata: { warehouse },
  })
  const precedence = await Precedence.check(ctx.sessionID, "sql_execute", warehouse)
  if (precedence.redirect) return `Value samples skipped: ${precedence.redirect.output}`
  const deadline = AbortSignal.timeout(PROFILE_TIMEOUT_MS)
  const signal = ctx.abort ? AbortSignal.any([ctx.abort, deadline]) : deadline
  const docs = await connector.sampleDocuments(document.database, document.collection, PROFILE_SAMPLE_DOCUMENTS, {
    signal,
    maxTimeMS: PROFILE_TIMEOUT_MS,
  })
  const profile = profileDocuments(docs)
  return profile && precedence.notice ? `${precedence.notice}\n${profile}` : profile
}
