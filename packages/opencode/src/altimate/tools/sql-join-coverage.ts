// altimate_change - new file
import type { Connector } from "@altimateai/drivers"
import * as Registry from "../native/connections/registry"
import { SCRATCH_NAME, isScratch } from "../native/connections/scratch"
import { executeQuery, type QueryContext } from "../native/query-execution"

/** Below this matched share of the left side, a join loses most of the population it started from. */
export const LOW_COVERAGE_SHARE = 0.5
/** Whole-check budget: parse, count and format. Over budget, the query result is returned unchanged. */
export const JOIN_CHECK_BUDGET_MS = 250
/** Remote warehouses (`all` mode) count at most this many left rows. */
export const REMOTE_ROW_CEILING = 100_000
const MAX_JOINS = 2

export type AutoCheckMode = "off" | "local" | "all"

/** `ALTIMATE_SQL_AUTO_CHECK`: off, local (default: scratch, DuckDB and SQLite only) or all. */
export function autoCheckMode(env: NodeJS.ProcessEnv = process.env): AutoCheckMode {
  const value = env["ALTIMATE_SQL_AUTO_CHECK"]?.trim().toLowerCase()
  if (value === "off" || value === "0" || value === "false") return "off"
  if (value === "all") return "all"
  return "local"
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

const literal = (text: string) => `'${text.replace(/'/g, "''")}'`
const ident = (name: string) => `"${name.replace(/"/g, '""')}"`

function refName(ref: Json): string | undefined {
  if (ref?.type === "BASE_TABLE") return [ref.catalog_name, ref.schema_name, ref.table_name].filter(Boolean).join(".")
  if (ref?.type === "SUBQUERY") return ref.alias ? `(subquery) ${ref.alias}` : undefined
  return undefined
}

/** Equality pairs between the two sides, or undefined when the condition is anything else. */
function equalityKeys(condition: Json, leftAlias: string, rightAlias: string): [string, string][] | undefined {
  const conjuncts = condition?.type === "CONJUNCTION_AND" ? condition.children : condition ? [condition] : []
  if (!conjuncts.length) return undefined
  const keys: [string, string][] = []
  for (const c of conjuncts) {
    if (c?.type !== "COMPARE_EQUAL" || c.left?.type !== "COLUMN_REF" || c.right?.type !== "COLUMN_REF") return undefined
    const a: string[] = c.left.column_names
    const b: string[] = c.right.column_names
    if (a.length !== 2 || b.length !== 2) return undefined
    const lower = (s: string) => s.toLowerCase()
    if (lower(a[0]) === lower(leftAlias) && lower(b[0]) === lower(rightAlias)) keys.push([a[1], b[1]])
    else if (lower(b[0]) === lower(leftAlias) && lower(a[0]) === lower(rightAlias)) keys.push([b[1], a[1]])
    else return undefined
  }
  return keys
}

/** Join nodes whose two inputs are plain relations, in left-to-right order. */
function relationJoins(ref: Json, out: Json[] = []): Json[] {
  if (ref?.type !== "JOIN") return out
  relationJoins(ref.left, out)
  relationJoins(ref.right, out)
  if (ref.left?.type !== "JOIN" && ref.right?.type !== "JOIN") out.push(ref)
  return out
}

async function rows(
  connector: Connector,
  config: Parameters<typeof executeQuery>[0],
  sql: string,
  context: QueryContext,
  timeoutMs: number,
) {
  const response = await executeQuery(
    config,
    { noLimit: true, readOnly: true, queryTimeoutMs: timeoutMs },
    context,
    (options) => connector.execute(sql, undefined, undefined, options),
  )
  return response.rows.map((row: unknown[]) =>
    Object.fromEntries(response.columns.map((col: string, i: number) => [col, row[i]])),
  )
}

/** Parse with DuckDB's own parser. Returns the statement JSON or undefined when it is not one plain SELECT. */
async function parse(parser: Connector, sql: string, context: QueryContext, timeoutMs: number) {
  const [row] = await rows(
    parser,
    { type: "duckdb" },
    `SELECT json_serialize_sql(${literal(sql)}) AS j`,
    context,
    timeoutMs,
  )
  // Locations are uint64 and lose precision in JSON.parse; zero them. Any other huge number
  // (e.g. a BIGINT literal) could be corrupted the same way, so such statements are skipped.
  const text = String(row?.j ?? "").replace(/"query_location":\s*\d+/g, '"query_location":0')
  if (/-?\d{16,}/.test(text)) return undefined
  const parsed = JSON.parse(text)
  if (parsed?.error || parsed?.statements?.length !== 1) return undefined
  if (parsed.statements[0].node?.type !== "SELECT_NODE") return undefined
  return parsed
}

/** DuckDB targets keep subqueries and CTEs; other engines only count plain base tables. */
async function sideSql(
  parser: Connector,
  statement: Json,
  ref: Json,
  duckdb: boolean,
  context: QueryContext,
  timeoutMs: number,
) {
  const node = statement.statements[0].node
  const cteNames = new Set<string>((node.cte_map?.map ?? []).map((entry: Json) => String(entry.key).toLowerCase()))
  if (!duckdb) {
    if (ref.type !== "BASE_TABLE" || cteNames.has(String(ref.table_name).toLowerCase())) return undefined
    return `SELECT * FROM ${[ref.catalog_name, ref.schema_name, ref.table_name].filter(Boolean).map(ident).join(".")}`
  }
  const star = {
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
  const synthetic = {
    ...statement,
    statements: [
      {
        ...statement.statements[0],
        node: {
          ...node,
          select_list: [star],
          from_table: { ...ref, alias: "" },
          where_clause: null,
          group_expressions: [],
          group_sets: [],
          having: null,
          qualify: null,
          modifiers: [],
        },
      },
    ],
  }
  const [row] = await rows(
    parser,
    { type: "duckdb" },
    `SELECT json_deserialize_sql(${literal(JSON.stringify(synthetic))}) AS s`,
    context,
    timeoutMs,
  )
  return typeof row?.s === "string" && row.s ? row.s : undefined
}

/**
 * Advisory note for a successful read: when an equality join keeps under half of its left side,
 * say so. One bounded counting query per join (at most two), run only where policy allows; any
 * failure, ambiguity or timeout returns undefined so the query result is never altered.
 */
export async function joinCoverageNote(
  sql: string,
  warehouse: string | undefined,
  context: QueryContext = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const mode = autoCheckMode(env)
  if (mode === "off") return undefined
  const name = warehouse ?? Registry.list().warehouses[0]?.name
  if (!name) return undefined
  const config = Registry.getConfig(name)
  const type = isScratch(name) ? "duckdb" : Registry.canonicalType(config?.type)
  const local = type === "duckdb" || type === "sqlite"
  if (!local && mode !== "all") return undefined
  if (!/\bjoin\b/i.test(sql)) return undefined

  const started = Date.now()
  const remaining = () => Math.max(0, JOIN_CHECK_BUDGET_MS - (Date.now() - started))
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), JOIN_CHECK_BUDGET_MS)
  })
  const work = async () => {
    const target = await Registry.get(name)
    const duckdb = type === "duckdb"
    const parser = duckdb ? target : await Registry.get(SCRATCH_NAME)
    const statement = await parse(parser, sql, context, remaining())
    if (!statement) return undefined
    const lines: string[] = []
    for (const join of relationJoins(statement.statements[0].node.from_table).slice(0, MAX_JOINS)) {
      const kind = String(join.join_type).toUpperCase()
      if ((kind !== "INNER" && kind !== "LEFT") || join.ref_type !== "REGULAR") continue
      const leftAlias = join.left.alias || join.left.table_name
      const rightAlias = join.right.alias || join.right.table_name
      if (!leftAlias || !rightAlias) continue
      const keys = equalityKeys(join.condition, leftAlias, rightAlias)
      if (!keys?.length) continue
      const leftSql = await sideSql(parser, statement, join.left, duckdb, context, remaining())
      const rightSql = await sideSql(parser, statement, join.right, duckdb, context, remaining())
      if (!leftSql || !rightSql) continue
      const bounded = local ? leftSql : `SELECT * FROM (${leftSql}) AS __jc_src LIMIT ${REMOTE_ROW_CEILING}`
      const match = keys.map(([l, r]) => `__jc_r.${ident(r)} = __jc_l.${ident(l)}`).join(" AND ")
      const count = `WITH __jc_left AS (${bounded}), __jc_right AS (${rightSql})
        SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM __jc_right __jc_r WHERE ${match}) THEN 1 ELSE 0 END), 0) AS matched
        FROM __jc_left __jc_l`
      const [row] = await rows(target, config, count, context, remaining())
      const n = Number(row?.n)
      const matched = Number(row?.matched)
      if (!Number.isFinite(n) || !Number.isFinite(matched)) continue
      const label = `join ${refName(join.left) ?? leftAlias} → ${refName(join.right) ?? rightAlias} on ${keys.map(([l, r]) => `${l} = ${r}`).join(", ")}`
      const scope = local || n < REMOTE_ROW_CEILING ? "left rows" : `left rows (first ${REMOTE_ROW_CEILING} counted)`
      const effect =
        kind === "LEFT" ? "they stay as unmatched rows with NULL right columns" : "the inner join drops them"
      for (const line of coverageLoss(matched, n, scope, effect)) lines.push(`${label}: ${line}`)
    }
    return lines.length ? lines.join("\n") : undefined
  }
  try {
    return await Promise.race([work(), timeout])
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}
