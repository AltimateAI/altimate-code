// altimate_change - new file
import { Decimal } from "decimal.js"
import type { Connector } from "@altimateai/drivers"
import { resolveQueryTimeout } from "@altimateai/drivers/query-timeout"
import type { Tool } from "../../tool/tool"
import { isScratch, SCRATCH_CONFIG, withScratchConnection } from "../native/connections/scratch"

/**
 * Commit-time join-coverage check. When the query that produced a committed answer inner-joins two
 * session scratch tables and the join drops most rows of a grouped (entity) side, answer_commit
 * returns a one-time review instead of committing. The check never executes the join: it counts
 * each side and runs EXISTS semi-joins, after catalog gates bound the rows and key bytes.
 */

/** Marker of the one-time review rejection in the current turn. */
export const REVIEW_MARKER = "answer_commit review:"
/** Every joined table must have at most this many rows (catalog estimate). */
export const ROW_CEILING = 500_000
/** VARCHAR key columns must have a known maximum length at or below this. */
export const MAX_KEY_LENGTH = 256
/** Rows times summed maximum key length per side; bounds the semi-join hash tables. */
export const KEY_CHAR_BUDGET = 16_000_000
/** The check skips when the scratch connection's effective query timeout is below this. */
export const MIN_QUERY_TIMEOUT_MS = 5_000
/** An entity side keeping less than this share of its rows fires. */
export const FIRE_RATIO = 0.5
/** Sides with fewer rows are never reported. */
export const MIN_SIDE_ROWS = 20
const MAX_TABLES = 3
const MAX_KEY_ARITY = 2
const MAX_NESTING = 3
const MAX_VARCHAR_CONSTANT = 64
const MAX_INTEGER_CONSTANT = 4096
/** Fixed-width key types count as this many characters in the byte bound. */
const FIXED_WIDTH_CHARS = 40
const TRUNCATION_HINT = /output was truncated|Full output saved to/i

/** `ALTIMATE_SQL_AUTO_CHECK=off` (or `0`/`false`) disables automatic checks. */
export function autoCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env["ALTIMATE_SQL_AUTO_CHECK"]?.trim().toLowerCase()
  return value !== "off" && value !== "0" && value !== "false"
}

type Json = any
type Messages = Tool.Context["messages"]
type LoosePart = {
  type?: string
  tool?: string
  id?: string
  state?: { status?: string; input?: Json; output?: unknown; error?: unknown }
}

export type JoinSide = { table: string; total: number; matched: number }
export type JoinLoss = {
  left: JoinSide
  right: JoinSide
  keys: string
  entity: ("left" | "right")[]
  chain: boolean
  fired: boolean
}

// ---------------------------------------------------------------------------------------------
// Turn identity and review slot
// ---------------------------------------------------------------------------------------------

function currentTurn(messages: Messages) {
  const start = messages.findLastIndex((message) => message.info.role === "user")
  return { boundary: start < 0 ? undefined : messages[start], messages: start < 0 ? messages : messages.slice(start) }
}

function turnParts(messages: Messages): LoosePart[] {
  return currentTurn(messages).messages.flatMap((message) => message.parts as LoosePart[])
}

/** Id of the current turn's user message; undefined when the history carries none. */
export function turnId(messages: Messages): string | undefined {
  const id = (currentTurn(messages).boundary?.info as { id?: unknown } | undefined)?.id
  return typeof id === "string" && id ? id : undefined
}

const commitRejections = (messages: Messages) =>
  turnParts(messages).filter(
    (part) => part.type === "tool" && part.tool === "answer_commit" && part.state?.status === "error",
  )

/** Earlier review rejections in the current turn. */
export function priorReviews(messages: Messages): number {
  return commitRejections(messages).filter((part) => String(part.state?.error ?? "").includes(REVIEW_MARKER)).length
}

/** Per session, the turn whose review slot is taken; reserved synchronously so concurrent commits cannot both review. */
const reviewedTurn = new Map<string, string>()

/**
 * Reserves the session's review slot for the current turn. Returns a release function, or
 * undefined when the turn has no id, already holds a review (in memory or in its history), or
 * already holds two commit rejections of any kind. Must be called before any await.
 */
export function reserveReview(sessionID: string, messages: Messages): (() => void) | undefined {
  const turn = turnId(messages)
  if (!turn || reviewedTurn.get(sessionID) === turn) return undefined
  if (priorReviews(messages) > 0 || commitRejections(messages).length >= 2) return undefined
  const previous = reviewedTurn.get(sessionID)
  reviewedTurn.set(sessionID, turn)
  return () => {
    if (reviewedTurn.get(sessionID) !== turn) return
    if (previous === undefined) reviewedTurn.delete(sessionID)
    else reviewedTurn.set(sessionID, previous)
  }
}

// ---------------------------------------------------------------------------------------------
// Locating the final query by the committed values
// ---------------------------------------------------------------------------------------------

export type Committed = {
  fields?: { value: string | number }[]
  rows?: { values: (string | number | null)[][]; note?: string }
  basis?: string
}

const NUMERIC = /^-?\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i
const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase()

/** Committed numbers (integers above 10 in magnitude, any decimal) and non-numeric strings of 3+ characters. */
export function committedEvidence(committed: Committed): { numbers: string[]; strings: string[] } {
  const cells: (string | number | null)[] = [
    ...(committed.fields ?? []).map((field) => field.value),
    ...(committed.rows?.values ?? []).flat(),
  ]
  const numbers: string[] = []
  const strings: string[] = []
  for (const cell of cells) {
    if (cell === null) continue
    const text = String(cell).trim()
    const numeric = typeof cell === "number" || NUMERIC.test(text.replace(/,/g, ""))
    if (numeric) {
      const value = new Decimal(typeof cell === "number" ? cell : text.replace(/,/g, ""))
      if (value.isInteger() && value.abs().lte(10)) continue
      numbers.push(value.toFixed())
    } else if (text.length >= 3) strings.push(normalize(text))
  }
  return { numbers, strings }
}

/** True when the output shows the committed number exactly, or a value that rounds half-up or truncates to it. */
function showsNumber(tokens: Decimal[], committed: string): boolean {
  const target = new Decimal(committed)
  const places = target.decimalPlaces()
  return tokens.some(
    (token) =>
      token.eq(target) ||
      token.toDecimalPlaces(places, Decimal.ROUND_HALF_UP).eq(target) ||
      token.toDecimalPlaces(places, Decimal.ROUND_DOWN).eq(target),
  )
}

const normalizeSql = (sql: string) => normalize(sql).replace(/;\s*$/, "")

/**
 * The completed `sql_execute` of the current turn whose output shows every committed value.
 * Undefined when the committed values give no evidence, nothing matches, a matching output was
 * truncated, or matching queries differ in SQL text.
 */
export function finalQuery(
  messages: Messages,
  committed: Committed,
): { sql: string; warehouse: string; part?: string } | undefined {
  const evidence = committedEvidence(committed)
  if (!evidence.numbers.length && !evidence.strings.length) return undefined
  const candidates = turnParts(messages).filter(
    (part) =>
      part.type === "tool" &&
      part.tool === "sql_execute" &&
      part.state?.status === "completed" &&
      typeof part.state.input?.query === "string" &&
      typeof part.state.input?.warehouse === "string" &&
      typeof part.state.output === "string",
  )
  const matches = candidates.filter((part) => {
    const output = String(part.state!.output)
    const tokens = (output.match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi) ?? []).map((token) => new Decimal(token))
    const text = normalize(output)
    return (
      evidence.numbers.every((number) => showsNumber(tokens, number)) &&
      evidence.strings.every((string) => text.includes(string))
    )
  })
  if (!matches.length || matches.some((part) => TRUNCATION_HINT.test(String(part.state!.output)))) return undefined
  if (new Set(matches.map((part) => normalizeSql(part.state!.input.query))).size !== 1) return undefined
  const located = matches.at(-1)!
  return { sql: located.state!.input.query, warehouse: located.state!.input.warehouse, part: located.id }
}

// ---------------------------------------------------------------------------------------------
// Join extraction from DuckDB's serialized AST
// ---------------------------------------------------------------------------------------------

/** Length-non-increasing built-in string functions allowed in keys and side filters. */
const KEY_FUNCTIONS = new Set([
  "upper",
  "lower",
  "trim",
  "ltrim",
  "rtrim",
  "btrim",
  "substr",
  "substring",
  "left",
  "right",
])
/** LIKE-family operators, allowed in side filters only. */
const LIKE_OPERATORS = new Set(["~~", "!~~", "~~*", "!~~*", "like", "ilike", "not like", "not ilike"])
const FILTER_OPERATORS = new Set([
  "OPERATOR_IS_NULL",
  "OPERATOR_IS_NOT_NULL",
  "OPERATOR_NOT",
  "COMPARE_IN",
  "COMPARE_NOT_IN",
  "OPERATOR_COALESCE",
])
const CAST_TYPES = new Set([
  "VARCHAR",
  "TINYINT",
  "SMALLINT",
  "INTEGER",
  "BIGINT",
  "HUGEINT",
  "UTINYINT",
  "USMALLINT",
  "UINTEGER",
  "UBIGINT",
  "DATE",
  "TIMESTAMP",
  "UUID",
])
const FIXED_WIDTH = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|DATE|TIMESTAMP|UUID|BOOLEAN)$/i
const FUNCTION_SCHEMAS = new Set(["", "main", "pg_catalog"])

/** Every node of a parsed statement, depth first. */
function* nodes(value: Json): Generator<Json> {
  if (!value || typeof value !== "object") return
  yield value
  for (const child of Array.isArray(value) ? value : Object.values(value)) yield* nodes(child)
}

export type Table = { index: number; name: string; schema: string; alias: string; node: Json; columns: Set<string> }

const conjuncts = (expr: Json): Json[] =>
  !expr ? [] : expr.class === "CONJUNCTION" && expr.type === "CONJUNCTION_AND" ? expr.children.flatMap(conjuncts) : [expr]

/**
 * The table a column reference belongs to, or undefined when it is ambiguous or unknown. A
 * qualified name matches an alias (or the table name when there is no alias); a bare name must be
 * a column of exactly one table.
 */
export function owner(ref: Json, tables: Table[]): Table | undefined {
  const names: string[] = (ref?.column_names ?? []).map((n: unknown) => String(n).toLowerCase())
  if (names.length === 1) {
    const found = tables.filter((t) => t.columns.has(names[0]!))
    return found.length === 1 ? found[0] : undefined
  }
  if (names.length < 2) return undefined
  const qualifier = names[names.length - 2]!
  const column = names[names.length - 1]!
  const found = tables.filter((t) => (t.alias ? t.alias === qualifier : t.name === qualifier))
  return found.length === 1 && found[0]!.columns.has(column) ? found[0] : undefined
}

type Scan = { tables: Set<number>; functions: Set<string>; ok: boolean }

/**
 * Walks an expression made only of allowlisted nodes, collecting the tables it references and the
 * function names it calls. `filter` admits predicate classes; keys admit only length-bounded wrappers.
 */
function scan(expr: Json, tables: Table[], filter: boolean, scanState: Scan = { tables: new Set(), functions: new Set(), ok: true }, depth = 0): Scan {
  const fail = () => ((scanState.ok = false), scanState)
  if (!scanState.ok || depth > (filter ? MAX_NESTING + 3 : MAX_NESTING)) return fail()
  const children = (list: Json[]) => {
    for (const child of list ?? []) scan(child, tables, filter, scanState, depth + 1)
    return scanState
  }
  switch (expr?.class) {
    case "COLUMN_REF": {
      const table = owner(expr, tables)
      if (!table) return fail()
      scanState.tables.add(table.index)
      return scanState
    }
    case "CONSTANT": {
      const value = expr.value
      if (value?.is_null) return scanState
      const id = String(value?.type?.id ?? "")
      if (id === "VARCHAR") return String(value.value).length <= MAX_VARCHAR_CONSTANT ? scanState : fail()
      if (/INT/.test(id)) {
        const n = Number(value.value)
        return Number.isSafeInteger(n) && (filter || (n >= 0 && n <= MAX_INTEGER_CONSTANT)) ? scanState : fail()
      }
      return filter && /^(DOUBLE|FLOAT|DECIMAL|BOOLEAN|DATE|TIMESTAMP)$/.test(id) ? scanState : fail()
    }
    case "CAST": {
      if (!CAST_TYPES.has(String(expr.cast_type?.id ?? ""))) return fail()
      return scan(expr.child, tables, filter, scanState, depth + 1)
    }
    case "OPERATOR": {
      if (expr.type === "OPERATOR_COALESCE") return children(expr.children)
      return filter && FILTER_OPERATORS.has(expr.type) ? children(expr.children) : fail()
    }
    case "FUNCTION": {
      const name = String(expr.function_name ?? "").toLowerCase()
      if (!FUNCTION_SCHEMAS.has(String(expr.schema ?? "").toLowerCase()) || expr.catalog) return fail()
      if (expr.filter || expr.distinct || expr.order_bys?.orders?.length || expr.export_state) return fail()
      const allowed = expr.is_operator ? filter && LIKE_OPERATORS.has(name) : KEY_FUNCTIONS.has(name)
      if (!allowed) return fail()
      scanState.functions.add(name)
      return children(expr.children)
    }
    case "COMPARISON":
      return filter ? (scan(expr.left, tables, filter, scanState, depth + 1), scan(expr.right, tables, filter, scanState, depth + 1)) : fail()
    case "BETWEEN":
      return filter
        ? (scan(expr.input, tables, filter, scanState, depth + 1),
          scan(expr.lower, tables, filter, scanState, depth + 1),
          scan(expr.upper, tables, filter, scanState, depth + 1))
        : fail()
    case "CONJUNCTION":
      return filter ? children(expr.children) : fail()
    default:
      return fail()
  }
}

export type Pair = {
  left: Table
  right: Table
  /** Equality conjuncts, oriented so `[0]` reads the left table and `[1]` the right. */
  keys: [Json, Json][]
  chain: boolean
}

export type Extracted = {
  tables: Table[]
  pairs: Pair[]
  /** WHERE conjuncts per table index. */
  filters: Map<number, Json[]>
  functions: Set<string>
}

/** Base tables of the FROM tree, or undefined when it holds anything but inner joins of base tables. */
function baseTables(from: Json): Json[] | undefined {
  if (from?.type === "BASE_TABLE") {
    if (from.sample || from.at_clause || from.column_name_alias?.length || from.catalog_name) return undefined
    return [from]
  }
  if (from?.type !== "JOIN" || from.join_type !== "INNER" || from.delim_flipped || from.sample) return undefined
  if (from.ref_type !== "REGULAR" && from.ref_type !== "CROSS") return undefined
  const left = baseTables(from.left)
  const right = baseTables(from.right)
  return left && right ? [...left, ...right] : undefined
}

/** Column lists come from the catalog; the AST only shows names. */
export type Catalog = (table: Json) => Set<string> | undefined

/**
 * The qualifying inner-join pairs of a single SELECT, with every WHERE conjunct attributed to one
 * table. Undefined whenever any part of the query falls outside the recognized shape.
 */
export function extractJoins(statement: Json, columns: Catalog): Extracted | undefined {
  if (statement?.statements?.length !== 1) return undefined
  const node = statement.statements[0]?.node
  if (node?.type !== "SELECT_NODE") return undefined
  for (const n of nodes(node)) {
    if (n?.cte_map?.map?.length) return undefined
    if (n?.class === "SUBQUERY" || n?.type === "SUBQUERY" || n?.type === "TABLE_FUNCTION") return undefined
  }
  const bases = baseTables(node.from_table)
  if (!bases || bases.length < 2 || bases.length > MAX_TABLES) return undefined
  const tables: Table[] = []
  for (const [index, base] of bases.entries()) {
    const set = columns(base)
    if (!set) return undefined
    tables.push({
      index,
      name: String(base.table_name).toLowerCase(),
      schema: String(base.schema_name ?? "").toLowerCase(),
      alias: String(base.alias ?? "").toLowerCase(),
      node: base,
      columns: set,
    })
  }
  if (new Set(tables.map((t) => t.alias || t.name)).size !== tables.length) return undefined
  const functions = new Set<string>()
  const keySide = (expr: Json): Table | undefined => {
    const result = scan(expr, tables, false)
    if (!result.ok || result.tables.size !== 1) return undefined
    for (const name of result.functions) functions.add(name)
    return tables[[...result.tables][0]!]
  }
  /** Splits equality conjuncts into one oriented pair; undefined if they do not all join the same two tables. */
  const pairOf = (list: Json[], chain: boolean): Pair | undefined => {
    if (!list.length || list.length > MAX_KEY_ARITY) return undefined
    let left: Table | undefined
    let right: Table | undefined
    const keys: [Json, Json][] = []
    for (const c of list) {
      if (c?.class !== "COMPARISON" || c.type !== "COMPARE_EQUAL") return undefined
      const a = keySide(c.left)
      const b = keySide(c.right)
      if (!a || !b || a === b) return undefined
      if (!left) [left, right] = a.index < b.index ? [a, b] : [b, a]
      if (a === left && b === right) keys.push([c.left, c.right])
      else if (a === right && b === left) keys.push([c.right, c.left])
      else return undefined
    }
    return { left: left!, right: right!, keys, chain }
  }
  const where = conjuncts(node.where_clause)
  const used = new Set<Json>()
  const pairs: Pair[] = []
  const walk = (from: Json): boolean => {
    if (from.type === "BASE_TABLE") return true
    if (!walk(from.left) || !walk(from.right)) return false
    if (from.ref_type === "CROSS") {
      if (tables.length !== 2) return false
      const equalities = where.filter((c) => c?.class === "COMPARISON" && c.type === "COMPARE_EQUAL" && pairOf([c], false))
      const pair = pairOf(equalities, false)
      if (!pair) return false
      for (const c of equalities) used.add(c)
      pairs.push(pair)
      return true
    }
    let list: Json[]
    if (from.using_columns?.length) {
      if (from.condition) return false
      if (from.left.type !== "BASE_TABLE" || from.right.type !== "BASE_TABLE") return false
      const [l, r] = [from.left, from.right].map((side) => tables.find((t) => t.node === side)!)
      list = from.using_columns.map((name: string) => ({
        class: "COMPARISON",
        type: "COMPARE_EQUAL",
        alias: "",
        left: { class: "COLUMN_REF", type: "COLUMN_REF", alias: "", column_names: [l!.alias || l!.name, name] },
        right: { class: "COLUMN_REF", type: "COLUMN_REF", alias: "", column_names: [r!.alias || r!.name, name] },
      }))
    } else list = conjuncts(from.condition)
    const pair = pairOf(list, tables.length > 2)
    if (!pair) return false
    pairs.push(pair)
    return true
  }
  if (!walk(node.from_table) || !pairs.length) return undefined
  const filters = new Map<number, Json[]>(tables.map((t) => [t.index, []]))
  for (const c of where) {
    if (used.has(c)) continue
    const result = scan(c, tables, true)
    if (!result.ok || result.tables.size > 1) return undefined
    for (const name of result.functions) functions.add(name)
    if (result.tables.size === 1) filters.get([...result.tables][0]!)!.push(c)
  }
  return { tables, pairs, filters, functions }
}

/**
 * Tables whose columns the GROUP BY references: positional items resolve to select items, bare
 * names to input columns. A bare name that is both a select alias and an input column abstains
 * (undefined). No GROUP BY, or one that resolves to no table, makes every table an entity.
 */
export function entityTables(node: Json, tables: Table[]): Set<number> | undefined {
  const groups: Json[] = node?.group_expressions ?? []
  const all = new Set(tables.map((t) => t.index))
  if (!groups.length) return all
  const select: Json[] = node.select_list ?? []
  const aliases = new Map(select.filter((s) => s?.alias).map((s) => [String(s.alias).toLowerCase(), s]))
  const found = new Set<number>()
  const visit = (expr: Json): boolean => {
    for (const n of nodes(expr)) {
      if (n?.class !== "COLUMN_REF") continue
      const table = owner(n, tables)
      if (table) found.add(table.index)
      else if (n.column_names.length === 1) {
        const holders = tables.filter((t) => t.columns.has(String(n.column_names[0]).toLowerCase()))
        if (holders.length > 1) for (const t of holders) found.add(t.index)
        else return false
      } else return false
    }
    return true
  }
  for (const group of groups) {
    if (group?.class === "CONSTANT" && /INT/.test(String(group.value?.type?.id))) {
      const item = select[Number(group.value.value) - 1]
      if (!item || !visit(item)) return undefined
      continue
    }
    if (group?.class === "POSITIONAL_REFERENCE") {
      const item = select[Number(group.index) - 1]
      if (!item || !visit(item)) return undefined
      continue
    }
    if (group?.class === "COLUMN_REF" && group.column_names.length === 1) {
      const name = String(group.column_names[0]).toLowerCase()
      const isColumn = tables.some((t) => t.columns.has(name))
      const alias = aliases.get(name)
      if (alias && isColumn) return undefined
      if (alias) {
        if (!visit(alias)) return undefined
        continue
      }
    }
    if (!visit(group)) return undefined
  }
  return found.size ? found : all
}

/** True when `text` states the pair "<matched> of <total>", "<matched>/<total>" or "<matched> out of <total>". */
export function acknowledged(text: string | undefined, matched: number, total: number): boolean {
  if (!text) return false
  const number = (n: number) => `(?:${n}|${n.toLocaleString("en-US")})`
  return new RegExp(`(?<![\\d.,])${number(matched)}\\s*(?:of|/|out of)\\s*${number(total)}(?![\\d.,]*\\d)`, "i").test(text)
}

// ---------------------------------------------------------------------------------------------
// Measurement on the leased scratch connection
// ---------------------------------------------------------------------------------------------

type Run = (sql: string) => Promise<Record<string, unknown>[]>
const literal = (text: string) => `'${text.replace(/'/g, "''")}'`

function runner(connector: Connector): Run {
  return async (sql) => {
    const response = await connector.execute(sql, undefined, undefined, { noLimit: true, readOnly: true })
    return response.rows.map((row: unknown[]) =>
      Object.fromEntries(response.columns.map((col: string, i: number) => [col, row[i]])),
    )
  }
}

async function serialize(run: Run, sql: string): Promise<Json | undefined> {
  const [row] = await run(`SELECT json_serialize_sql(${literal(sql)}) AS j`)
  const text = String(row?.j ?? "").replace(/"query_location":\s*\d+/g, '"query_location":0')
  // JSON.parse would round integer literals beyond double precision.
  if (/"value":\s*-?\d{16,}/.test(text)) return undefined
  const statement = JSON.parse(text)
  if (statement?.error || statement?.statements?.length !== 1) return undefined
  return statement
}

async function deserialize(run: Run, statement: Json): Promise<string | undefined> {
  const [row] = await run(`SELECT json_deserialize_sql(${literal(JSON.stringify(statement))}) AS s`)
  return typeof row?.s === "string" && row.s ? row.s : undefined
}

type TableInfo = { rows: number; columns: Map<string, string> }

/** The scratch base table a reference resolves to, with no view of the same name; undefined otherwise. */
async function scratchTable(run: Run, ref: Json): Promise<TableInfo | undefined> {
  const name = literal(String(ref.table_name))
  const scope = ref.schema_name
    ? `AND (lower(t.schema_name) = lower(${literal(ref.schema_name)}) OR lower(t.database_name) = lower(${literal(ref.schema_name)}))`
    : ""
  const [views] = await run(
    `SELECT count(*) AS n FROM duckdb_views() WHERE NOT internal AND lower(view_name) = lower(${name})`,
  )
  if (Number(views?.n) !== 0) return undefined
  const tables = await run(
    `SELECT t.table_oid AS oid, t.database_name AS db, t.schema_name AS sch, t.estimated_size AS size
     FROM duckdb_tables() t WHERE lower(t.table_name) = lower(${name}) ${scope}`,
  )
  if (tables.length !== 1) return undefined
  const [table] = tables
  if (String(table!.db) !== "scratch" || String(table!.sch) !== "main") return undefined
  const rows = Number(table!.size)
  if (!Number.isFinite(rows) || rows > ROW_CEILING) return undefined
  const cols = await run(`SELECT column_name AS c, data_type AS d FROM duckdb_columns() WHERE table_oid = ${Number(table!.oid)}`)
  return { rows, columns: new Map(cols.map((c) => [String(c.c).toLowerCase(), String(c.d).toUpperCase()])) }
}

/**
 * Upper bound on the characters of one key column, from the catalog: fixed-width types count as
 * FIXED_WIDTH_CHARS; VARCHAR needs a known `Max String Length` for every segment covering every
 * row, with no pending in-place updates (whose statistics are not yet merged). Undefined otherwise.
 */
async function keyWidth(run: Run, table: Json, info: TableInfo, column: string): Promise<number | undefined> {
  const type = info.columns.get(column)
  if (!type) return undefined
  if (FIXED_WIDTH.test(type)) return FIXED_WIDTH_CHARS
  if (type !== "VARCHAR") return undefined
  const segments = await run(
    `SELECT count AS n, stats AS s, has_updates AS u FROM pragma_storage_info(${literal(`scratch.main.${String(table.table_name)}`)})
     WHERE lower(column_name) = ${literal(column)} AND segment_type = 'VARCHAR'`,
  )
  let rows = 0
  let width = 0
  for (const segment of segments) {
    if (segment.u === true || String(segment.u).toLowerCase() === "true") return undefined
    const match = /Max String Length: (\d+)/.exec(String(segment.s ?? ""))
    if (!match) return undefined
    rows += Number(segment.n)
    width = Math.max(width, Number(match[1]))
  }
  if (rows !== info.rows || width > MAX_KEY_LENGTH) return undefined
  return width
}

const columnOf = (expr: Json): string[] =>
  [...nodes(expr)].filter((n) => n?.class === "COLUMN_REF").map((n) => String(n.column_names.at(-1)).toLowerCase())

const and = (list: Json[]) =>
  !list.length
    ? null
    : list.length === 1
      ? list[0]
      : { class: "CONJUNCTION", type: "CONJUNCTION_AND", alias: "", query_location: 0, children: list }

/** A single-table SELECT built by the deserializer from the agent's own AST pieces. */
async function projection(run: Run, template: Json, table: Table, keys: Json[], filters: Json[]): Promise<string | undefined> {
  const [one] = template.statements[0].node.select_list
  const select_list = keys.map((key, i) => ({ ...key, alias: `__k${i}` }))
  const node = {
    ...template.statements[0].node,
    select_list: select_list.length ? select_list : [one],
    from_table: { ...table.node },
    where_clause: and(filters),
  }
  return deserialize(run, { ...template, statements: [{ ...template.statements[0], node }] })
}

async function render(run: Run, template: Json, expressions: Json[]): Promise<string> {
  const node = { ...template.statements[0].node, select_list: expressions.map((e) => ({ ...e, alias: "" })) }
  const text = (await deserialize(run, { ...template, statements: [{ ...template.statements[0], node }] })) ?? ""
  return text.replace(/^SELECT\s+/i, "").replace(/\bmain\."?(\w+)"?\(/g, "$1(")
}

/**
 * Measures every qualifying pair of the located final query. Undefined when the query is outside the
 * recognized shape or any gate fails; never executes the join itself.
 */
export async function measureJoins(sql: string, sessionID: string, env: NodeJS.ProcessEnv = process.env): Promise<JoinLoss[] | undefined> {
  const timeout = resolveQueryTimeout(SCRATCH_CONFIG, undefined, env).ms
  if (timeout !== undefined && timeout < MIN_QUERY_TIMEOUT_MS) return undefined
  return withScratchConnection(async (connection) => {
    const run = runner(connection)
    const statement = await serialize(run, sql)
    if (!statement) return undefined
    const node = statement.statements[0]?.node
    // Catalog gate for every base table before the AST is trusted.
    const infos = new Map<Json, TableInfo>()
    for (const n of nodes(node)) {
      if (n?.type !== "BASE_TABLE") continue
      const info = await scratchTable(run, n)
      if (!info) return undefined
      infos.set(n, info)
    }
    const extracted = extractJoins(statement, (base) => {
      const info = infos.get(base)
      return info ? new Set(info.columns.keys()) : undefined
    })
    if (!extracted) return undefined
    if (extracted.functions.size) {
      const names = [...extracted.functions].map(literal).join(", ")
      const [user] = await run(
        `SELECT count(*) AS n FROM duckdb_functions() WHERE NOT internal AND lower(function_name) IN (${names})`,
      )
      if (Number(user?.n) !== 0) return undefined
    }
    const entity = entityTables(node, extracted.tables)
    if (!entity) return undefined
    const template = await serialize(run, "SELECT 1")
    if (!template) return undefined
    const results: JoinLoss[] = []
    for (const pair of extracted.pairs) {
      for (const [index, table] of [pair.left, pair.right].entries()) {
        const info = infos.get(table.node)!
        let width = 0
        for (const key of pair.keys) {
          const cols = columnOf(key[index])
          if (cols.length !== 1) return undefined
          const w = await keyWidth(run, table.node, info, cols[0]!)
          if (w === undefined) return undefined
          width += w
        }
        if (info.rows * width > KEY_CHAR_BUDGET) return undefined
      }
      const left = await projection(run, template, pair.left, pair.keys.map((k) => k[0]), extracted.filters.get(pair.left.index)!)
      const right = await projection(run, template, pair.right, pair.keys.map((k) => k[1]), extracted.filters.get(pair.right.index)!)
      if (!left || !right) return undefined
      const match = (outer: string, inner: string) =>
        pair.keys.map((_, i) => `${inner}.__k${i} = ${outer}.__k${i}`).join(" AND ")
      const [counts] = await run(
        `WITH __jc_l AS (${left}), __jc_r AS (${right})
         SELECT
           (SELECT count(*) FROM __jc_l) AS l_total,
           (SELECT count(*) FROM __jc_l WHERE EXISTS (SELECT 1 FROM __jc_r WHERE ${match("__jc_l", "__jc_r")})) AS l_matched,
           (SELECT count(*) FROM __jc_r) AS r_total,
           (SELECT count(*) FROM __jc_r WHERE EXISTS (SELECT 1 FROM __jc_l WHERE ${match("__jc_r", "__jc_l")})) AS r_matched`,
      )
      const sides = (["left", "right"] as const).filter((side) => entity.has(pair[side].index))
      const loss: JoinLoss = {
        left: { table: String(pair.left.node.table_name), total: Number(counts?.l_total), matched: Number(counts?.l_matched) },
        right: { table: String(pair.right.node.table_name), total: Number(counts?.r_total), matched: Number(counts?.r_matched) },
        keys: await render(run, template, pair.keys.map(([l, r]) => ({ class: "COMPARISON", type: "COMPARE_EQUAL", alias: "", left: l, right: r }))),
        entity: sides,
        chain: pair.chain,
        fired: false,
      }
      if (![loss.left, loss.right].every((s) => Number.isFinite(s.total) && Number.isFinite(s.matched))) return undefined
      results.push(loss)
    }
    return results
  }, sessionID)
}

const lost = (side: JoinSide) => side.total >= MIN_SIDE_ROWS && side.matched / side.total < FIRE_RATIO

/** Marks pairs whose entity side lost most rows and whose loss the commit text does not already state. */
export function applyFiringRule(losses: JoinLoss[], text: string): JoinLoss[] {
  return losses.map((loss) => ({
    ...loss,
    fired: loss.entity.some((side) => lost(loss[side]) && !acknowledged(text, loss[side].matched, loss[side].total)),
  }))
}

const pct = (side: JoinSide) => `${((side.matched / side.total) * 100).toFixed(1)}%`

/** One review bullet per fired pair. */
export function joinBullet(loss: JoinLoss): string {
  const firedSides = loss.entity.filter((side) => lost(loss[side]))
  const worst = firedSides.reduce((a, b) => (loss[a].matched / loss[a].total <= loss[b].matched / loss[b].total ? a : b))
  const other = worst === "left" ? "right" : "left"
  const head = `- The final query's inner join ${loss.left.table} JOIN ${loss.right.table} ON ${loss.keys}`
  const chain = loss.chain ? " (pairwise; the full join keeps at most this many)" : ""
  const s = loss[worst]
  const o = loss[other]
  const kept =
    firedSides.length === 2
      ? `keeps ${loss.left.matched} of ${loss.left.total} ${loss.left.table} rows (${pct(loss.left)}) and ${loss.right.matched} of ${loss.right.total} ${loss.right.table} rows (${pct(loss.right)})${chain} after the query's own filters; the rest do not appear in the answer.`
      : `keeps ${s.matched} of ${s.total} ${s.table} rows (${pct(s)})${chain} after the query's own filters; the other ${s.total - s.matched} ${s.table} rows do not appear in the answer (${o.table} side: ${o.matched} of ${o.total} rows match).`
  return `${head} ${kept} If the question is about all ${s.total} ${s.table} rows, look for a key, column or source that covers them (compare the key formats on both sides; check other tables or ID columns for these entities). If the ${s.matched} matched rows are the intended population, state "${s.matched} of ${s.total}" in basis and call answer_commit again unchanged.`
}

/** The one-time review text, or undefined when no pair fired. */
export function reviewMessage(losses: JoinLoss[] | undefined): string | undefined {
  const fired = (losses ?? []).filter((loss) => loss.fired)
  if (!fired.length) return undefined
  return [
    `${REVIEW_MARKER} not committed yet; check this evidence once.`,
    ...fired.map(joinBullet),
    "If the answer stands, call answer_commit again with the same answer; otherwise revise the query first.",
  ].join("\n")
}

export type JoinReview = { message?: string; joins?: JoinLoss[]; part?: string; ms: number }

/**
 * The join review for one commit. The review slot must already be reserved by the caller.
 * Any error is swallowed: the commit then proceeds unchanged.
 */
export async function joinReview(
  sessionID: string,
  messages: Messages,
  committed: Committed,
  env: NodeJS.ProcessEnv = process.env,
): Promise<JoinReview> {
  const start = Date.now()
  try {
    const final = finalQuery(messages, committed)
    if (!final || !isScratch(final.warehouse)) return { ms: Date.now() - start }
    const measured = await measureJoins(final.sql, sessionID, env)
    if (!measured) return { part: final.part, ms: Date.now() - start }
    const joins = applyFiringRule(measured, [committed.basis ?? "", committed.rows?.note ?? ""].join("\n"))
    return { message: reviewMessage(joins), joins, part: final.part, ms: Date.now() - start }
  } catch {
    return { ms: Date.now() - start }
  }
}
