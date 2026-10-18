// altimate_change - new file
import { isLocalFilePath, type Connector } from "@altimateai/drivers"
import * as Registry from "../native/connections/registry"
import { isScratch } from "../native/connections/scratch"

/** Below this matched share of the left side, a join loses most of the population it started from. */
export const LOW_COVERAGE_SHARE = 0.5
/** Whole-check budget. Past it the note is dropped and the query result is returned unchanged. */
export const JOIN_CHECK_BUDGET_MS = 250
/**
 * Each side must be a local DuckDB base table with at most this many rows (catalog estimate).
 * The check never interrupts the engine, so this ceiling is what keeps its work short (a
 * semi-join at this size takes milliseconds) even when the budget has already passed.
 */
export const LOCAL_ROW_CEILING = 500_000
const MAX_JOINS = 2

/** `ALTIMATE_SQL_AUTO_CHECK=off` disables the check; any other value keeps it on for local DuckDB only. */
export function autoCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env["ALTIMATE_SQL_AUTO_CHECK"]?.trim().toLowerCase()
  return value !== "off" && value !== "0" && value !== "false"
}

/** A leading warning when most of the left side has no match, so a large silent loss is not reported as fact. */
export function coverageLoss(matched: number, total: number, unit: string, effect: string): string[] {
  if (!total || matched / total >= LOW_COVERAGE_SHARE) return []
  const lost = total - matched
  return [
    `WARNING coverage loss: ${lost} of ${total} ${unit} (${((lost / total) * 100).toFixed(1)}%) have no match; ${effect}. ` +
      "Before reporting results over the joined rows, confirm this loss is expected (e.g. the other table covers only some entities) " +
      "and state it in the answer, or look for a different key, column or source that covers the population the question asks about.",
  ]
}

type Json = any
type Key = { left: string; right: string; leftFirst: boolean }

const literal = (text: string) => `'${text.replace(/'/g, "''")}'`
// DuckDB resolves quoted identifiers case-insensitively, so quoting every part is safe.
const ident = (name: string) => `"${name.replace(/"/g, '""')}"`
/** A DuckDB path that names remote or extension storage; in-memory, empty and `file:` paths are local. */
const isRemotePath = (path: unknown) =>
  typeof path === "string" && path !== "" && path !== ":memory:" && !/^file:/i.test(path) && !isLocalFilePath(path)

const STAR = {
  class: "STAR",
  type: "STAR",
  alias: "",
  query_location: 0,
  relation_name: "",
  exclude_list: [],
  replace_list: [],
  columns: false,
  expr: null,
  qualified_exclude_list: [],
  rename_list: [],
}

// Expression classes a rebuilt filter may contain: plain comparisons of columns and constants. No
// function calls (including LIKE), CASE or subqueries, so a filtered side costs one cheap scan and
// the uncancellable count stays as short as the size ceiling makes it.
const SIMPLE_CLASSES = new Set(["COMPARISON", "BETWEEN", "OPERATOR", "CAST", "COLUMN_REF", "CONSTANT"])
const SIMPLE_OPERATORS = new Set([
  "COMPARE_IN",
  "COMPARE_NOT_IN",
  "OPERATOR_IS_NULL",
  "OPERATOR_IS_NOT_NULL",
  "OPERATOR_CAST",
])

/**
 * Qualifiers of every column reference in a simple expression, or undefined when it holds anything
 * else (a function, subquery, CASE, bare column...).
 */
function qualifiers(expr: Json, out = new Set<string>()): Set<string> | undefined {
  if (!expr || typeof expr !== "object" || Array.isArray(expr)) return undefined
  if (!SIMPLE_CLASSES.has(expr.class)) return undefined
  if (expr.class === "OPERATOR" && !SIMPLE_OPERATORS.has(expr.type)) return undefined
  if (expr.class === "CONSTANT") return out
  if (expr.class === "COLUMN_REF") {
    if (expr.column_names?.length !== 2) return undefined
    out.add(String(expr.column_names[0]).toLowerCase())
    return out
  }
  const children = [expr.left, expr.right, expr.input, expr.lower, expr.upper, expr.child, ...(expr.children ?? [])]
  for (const child of children.filter((c) => c !== undefined && c !== null))
    if (!qualifiers(child, out)) return undefined
  return out
}

/**
 * Splits the WHERE clause into the conjuncts that filter only the left or only the right side.
 * Undefined when any conjunct spans both sides, another relation, a bare column or a subquery:
 * the count could not reproduce the population the query actually used.
 */
function sideFilters(where: Json, leftAlias: string, rightAlias: string) {
  const left: Json[] = []
  const right: Json[] = []
  if (!where) return { left, right }
  const conjuncts = where.type === "CONJUNCTION_AND" ? where.children : [where]
  for (const conjunct of conjuncts) {
    const names = qualifiers(conjunct)
    if (!names || names.size !== 1) return undefined
    const [name] = names
    if (name === leftAlias.toLowerCase()) left.push(conjunct)
    else if (name === rightAlias.toLowerCase()) right.push(conjunct)
    else return undefined
  }
  return { left, right }
}

/** Equality pairs between the two sides in their written order, or undefined for any other condition. */
function equalityKeys(condition: Json, leftAlias: string, rightAlias: string): Key[] | undefined {
  const conjuncts = condition?.type === "CONJUNCTION_AND" ? condition.children : condition ? [condition] : []
  if (!conjuncts.length) return undefined
  const lower = (s: string) => s.toLowerCase()
  const keys: Key[] = []
  for (const c of conjuncts) {
    if (c?.type !== "COMPARE_EQUAL" || c.left?.type !== "COLUMN_REF" || c.right?.type !== "COLUMN_REF") return undefined
    const a: string[] = c.left.column_names
    const b: string[] = c.right.column_names
    if (a.length !== 2 || b.length !== 2) return undefined
    if (lower(a[0]) === lower(leftAlias) && lower(b[0]) === lower(rightAlias))
      keys.push({ left: a[1], right: b[1], leftFirst: true })
    else if (lower(b[0]) === lower(leftAlias) && lower(a[0]) === lower(rightAlias))
      keys.push({ left: b[1], right: a[1], leftFirst: false })
    else return undefined
  }
  return keys
}

/** Join nodes whose two inputs are both plain base-table references, in left-to-right order. */
function tableJoins(ref: Json, out: Json[] = []): Json[] {
  if (ref?.type !== "JOIN") return out
  tableJoins(ref.left, out)
  tableJoins(ref.right, out)
  if (ref.left?.type === "BASE_TABLE" && ref.right?.type === "BASE_TABLE") out.push(ref)
  return out
}

async function rows(connector: Connector, sql: string): Promise<Record<string, unknown>[]> {
  // No short timeout, session deadline or abort signal: interrupting a local engine restarts its
  // helper and drops session state. Only the connection's own query timeout still applies; the
  // catalog-size gate keeps the work far below it.
  const response = await connector.execute(sql, undefined, undefined, { noLimit: true, readOnly: true })
  return response.rows.map((row: unknown[]) =>
    Object.fromEntries(response.columns.map((col: string, i: number) => [col, row[i]])),
  )
}

/**
 * The relation is admitted only when its name resolves to exactly one local DuckDB base table
 * under the size ceiling, and no view anywhere shares the name (a temporary view could shadow it).
 */
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

/** One side as SQL: the bare table, or the table with the WHERE conjuncts that apply to it alone. */
async function sideSource(connector: Connector, statement: Json, side: Json, filters: Json[]): Promise<string> {
  if (!filters.length)
    return [side.catalog_name, side.schema_name, side.table_name].filter(Boolean).map(ident).join(".")
  const where =
    filters.length === 1
      ? filters[0]
      : { class: "CONJUNCTION", type: "CONJUNCTION_AND", alias: "", query_location: 0, children: filters }
  const node = statement.statements[0].node
  const synthetic = {
    ...statement,
    statements: [
      {
        ...statement.statements[0],
        node: {
          ...node,
          select_list: [STAR],
          from_table: side,
          where_clause: where,
          group_expressions: [],
          group_sets: [],
          having: null,
          qualify: null,
          modifiers: [],
          cte_map: { map: [] },
        },
      },
    ],
  }
  const [row] = await rows(connector, `SELECT json_deserialize_sql(${literal(JSON.stringify(synthetic))}) AS s`)
  if (typeof row?.s !== "string" || !row.s) throw new Error("side could not be rebuilt")
  return `(${row.s})`
}

/**
 * Advisory note for a successful read on the session scratch database or a local DuckDB file:
 * when an equality join between two small base tables keeps under half of its left side, say
 * so. Every failure, ambiguity or budget overrun returns undefined, so the result is never altered.
 */
export async function joinCoverageNote(
  sql: string,
  warehouse: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  // Without an explicit warehouse the query may have run through another adapter; skip.
  if (!warehouse || !autoCheckEnabled(env) || !/\bjoin\b/i.test(sql)) return undefined
  const config = Registry.getConfig(warehouse)
  const scratch = isScratch(warehouse)
  const type = scratch ? "duckdb" : Registry.canonicalType(config?.type)
  if (type !== "duckdb" || (!scratch && isRemotePath((config as { path?: unknown } | undefined)?.path)))
    return undefined

  const started = Date.now()
  const live = () => Date.now() - started < JOIN_CHECK_BUDGET_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), JOIN_CHECK_BUDGET_MS)
  })

  const work = async () => {
    const connector = await Registry.get(warehouse)
    if (!live()) return undefined
    const [parsed] = await rows(connector, `SELECT json_serialize_sql(${literal(sql)}) AS j`)
    // uint64 locations lose precision in JSON.parse; they are not needed.
    const statement = JSON.parse(String(parsed?.j ?? "").replace(/"query_location":\s*\d+/g, '"query_location":0'))
    if (statement?.error || statement?.statements?.length !== 1) return undefined
    const node = statement.statements[0].node
    if (node?.type !== "SELECT_NODE") return undefined
    const cteNames = new Set<string>((node.cte_map?.map ?? []).map((entry: Json) => String(entry.key).toLowerCase()))

    const lines: string[] = []
    for (const join of tableJoins(node.from_table).slice(0, MAX_JOINS)) {
      if (!live()) return undefined
      const kind = String(join.join_type).toUpperCase()
      if ((kind !== "INNER" && kind !== "LEFT") || join.ref_type !== "REGULAR") continue
      const sides = [join.left, join.right]
      // Column alias lists rename columns; CTE names are not tables; samples change row counts.
      if (
        sides.some((s) => s.column_name_alias?.length || s.sample || cteNames.has(String(s.table_name).toLowerCase()))
      )
        continue
      const leftAlias = join.left.alias || join.left.table_name
      const rightAlias = join.right.alias || join.right.table_name
      const keys = equalityKeys(join.condition, leftAlias, rightAlias)
      if (!keys?.length) continue
      // The count must see the same left population as the query: WHERE filters are applied
      // per side, and a WHERE that cannot be split that way skips the check.
      const filters = sideFilters(node.where_clause, leftAlias, rightAlias)
      if (!filters) continue
      // A right-side WHERE on a LEFT JOIN runs after the join and drops the NULL-extended rows,
      // which a pre-filtered count cannot describe.
      if (kind === "LEFT" && filters.right.length) continue
      if (!(await smallLocalTable(connector, join.left)) || !live()) continue
      if (!(await smallLocalTable(connector, join.right)) || !live()) continue
      const leftSource = await sideSource(connector, statement, join.left, filters.left)
      const rightSource = await sideSource(connector, statement, join.right, filters.right)
      if (!live()) return undefined

      const match = keys
        .map((k) =>
          k.leftFirst
            ? `__jc_l.${ident(k.left)} = __jc_r.${ident(k.right)}`
            : `__jc_r.${ident(k.right)} = __jc_l.${ident(k.left)}`,
        )
        .join(" AND ")
      const [row] = await rows(
        connector,
        `SELECT COUNT(*) AS n,
           COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM ${rightSource} __jc_r WHERE ${match}) THEN 1 ELSE 0 END), 0) AS matched
         FROM ${leftSource} __jc_l`,
      )
      const n = Number(row?.n)
      const matched = Number(row?.matched)
      if (!Number.isFinite(n) || !Number.isFinite(matched)) continue
      const plain = (side: Json) => [side.catalog_name, side.schema_name, side.table_name].filter(Boolean).join(".")
      const label = `join ${plain(join.left)} → ${plain(join.right)} on ${keys.map((k) => `${k.left} = ${k.right}`).join(", ")}`
      const effect =
        kind === "LEFT" ? "they stay as unmatched rows with NULL right columns" : "the inner join drops them"
      for (const line of coverageLoss(matched, n, "left rows", effect)) lines.push(`${label}: ${line}`)
    }
    return lines.length && live() ? lines.join("\n") : undefined
  }
  try {
    return await Promise.race([work().catch(() => undefined), timeout])
  } finally {
    clearTimeout(timer)
  }
}
