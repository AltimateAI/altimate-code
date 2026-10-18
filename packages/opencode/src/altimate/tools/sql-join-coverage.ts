// altimate_change - new file
import type { Connector } from "@altimateai/drivers"
import * as Registry from "../native/connections/registry"
import { SCRATCH_NAME, isScratch } from "../native/connections/scratch"
import { executeQuery, type QueryContext } from "../native/query-execution"

/** Below this matched share of the left side, a join loses most of the population it started from. */
export const LOW_COVERAGE_SHARE = 0.5
/** Whole-check budget: parse, catalog lookups, count and format. Over budget, nothing is added. */
export const JOIN_CHECK_BUDGET_MS = 250
/** Local DuckDB counts run only when each side's catalog estimate is at most this many rows. */
export const LOCAL_ROW_CEILING = 2_000_000
/** Remote warehouses (`all` mode) count at most this many left rows. */
export const REMOTE_ROW_CEILING = 100_000
const MAX_JOINS = 2

export type AutoCheckMode = "off" | "local" | "all"

/** `ALTIMATE_SQL_AUTO_CHECK`: off, local (default: the scratch database and local DuckDB files) or all. */
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
type Key = { left: string; right: string; leftFirst: boolean }

const literal = (text: string) => `'${text.replace(/'/g, "''")}'`
const quoted = (name: string) => `"${name.replace(/"/g, '""')}"`
// Remote engines fold unquoted names differently; keep simple names unquoted as users usually write them.
const remoteIdent = (name: string) => (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) ? name : quoted(name))
const isRemotePath = (path: unknown) =>
  typeof path === "string" && (/^(md|motherduck):/i.test(path) || path.includes("://"))

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

/** Join nodes whose two inputs are both plain base tables, in left-to-right order. */
function tableJoins(ref: Json, out: Json[] = []): Json[] {
  if (ref?.type !== "JOIN") return out
  tableJoins(ref.left, out)
  tableJoins(ref.right, out)
  if (ref.left?.type === "BASE_TABLE" && ref.right?.type === "BASE_TABLE") out.push(ref)
  return out
}

/**
 * Advisory note for a successful read: when an equality join between two base tables keeps
 * under half of its left side, say so. One counting query per join (at most two), only where
 * policy allows and only when it is cheap by construction. Every failure, ambiguity or budget
 * overrun returns undefined, so the query result is never altered.
 */
export async function joinCoverageNote(
  sql: string,
  warehouse: string | undefined,
  context: QueryContext = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const mode = autoCheckMode(env)
  if (mode === "off" || !/\bjoin\b/i.test(sql)) return undefined
  const name = warehouse ?? Registry.list().warehouses[0]?.name
  if (!name) return undefined
  const config = Registry.getConfig(name)
  const scratch = isScratch(name)
  const type = scratch ? "duckdb" : Registry.canonicalType(config?.type)
  // Local means a DuckDB engine on this machine: the session scratch or a local DuckDB file.
  const local = type === "duckdb" && (scratch || !isRemotePath((config as { path?: unknown } | undefined)?.path))
  if (!local && (mode !== "all" || type === "duckdb" || type === "sqlite")) return undefined

  const started = Date.now()
  const remaining = () => JOIN_CHECK_BUDGET_MS - (Date.now() - started)
  const live = () => remaining() > 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), JOIN_CHECK_BUDGET_MS)
  })
  // Local DuckDB queries never get a short timeout: a timeout restarts the engine helper and would
  // drop the session's scratch state. They are bounded by the catalog-size gate instead. Remote
  // queries get the remaining budget as their own timeout.
  const query = async (connector: Connector, target: typeof config, text: string, remote: boolean) => {
    if (!live()) throw new Error("join coverage budget spent")
    const options = remote
      ? { noLimit: true, readOnly: true, queryTimeoutMs: Math.max(1, remaining()) }
      : { noLimit: true, readOnly: true }
    const response = await executeQuery(target, options, context, (opts) =>
      connector.execute(text, undefined, undefined, opts),
    )
    return response.rows.map((row: unknown[]) =>
      Object.fromEntries(response.columns.map((col: string, i: number) => [col, row[i]])),
    )
  }

  const work = async () => {
    const target = await Registry.get(name)
    const parser = local ? target : await Registry.get(SCRATCH_NAME)
    const parserConfig = { type: "duckdb" } as typeof config
    const [parsedRow] = await query(parser, parserConfig, `SELECT json_serialize_sql(${literal(sql)}) AS j`, false)
    // uint64 locations lose precision in JSON.parse; they are not needed.
    const text = String(parsedRow?.j ?? "").replace(/"query_location":\s*\d+/g, '"query_location":0')
    const statement = JSON.parse(text)
    if (statement?.error || statement?.statements?.length !== 1) return undefined
    const node = statement.statements[0].node
    if (node?.type !== "SELECT_NODE") return undefined
    const cteNames = new Set<string>((node.cte_map?.map ?? []).map((entry: Json) => String(entry.key).toLowerCase()))

    const lines: string[] = []
    for (const join of tableJoins(node.from_table).slice(0, MAX_JOINS)) {
      if (!live()) break
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

      if (local) {
        // Count only local base tables (not views, not remote attachments) under the size ceiling.
        let small = true
        for (const side of sides) {
          const where = [
            `lower(t.table_name) = lower(${literal(side.table_name)})`,
            side.schema_name ? `lower(t.schema_name) = lower(${literal(side.schema_name)})` : "",
            side.catalog_name ? `lower(t.database_name) = lower(${literal(side.catalog_name)})` : "",
          ].filter(Boolean)
          const found = await query(
            target,
            config,
            `SELECT d.type AS type, d.path AS path, t.estimated_size AS size
             FROM duckdb_tables() t JOIN duckdb_databases() d USING (database_name) WHERE ${where.join(" AND ")}`,
            false,
          )
          const [table] = found
          if (
            found.length !== 1 ||
            String(table.type).toLowerCase() !== "duckdb" ||
            isRemotePath(table.path) ||
            !(Number(table.size) <= LOCAL_ROW_CEILING)
          ) {
            small = false
            break
          }
        }
        if (!small) continue
      }

      const ident = local ? quoted : remoteIdent
      const relation = (side: Json) =>
        [side.catalog_name, side.schema_name, side.table_name].filter(Boolean).map(ident).join(".")
      const leftSource = local
        ? `SELECT * FROM ${relation(join.left)}`
        : `SELECT * FROM ${relation(join.left)} LIMIT ${REMOTE_ROW_CEILING}`
      const match = keys
        .map((k) =>
          k.leftFirst
            ? `__jc_l.${ident(k.left)} = __jc_r.${ident(k.right)}`
            : `__jc_r.${ident(k.right)} = __jc_l.${ident(k.left)}`,
        )
        .join(" AND ")
      const count = `SELECT COUNT(*) AS n,
          COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM ${relation(join.right)} __jc_r WHERE ${match}) THEN 1 ELSE 0 END), 0) AS matched
        FROM (${leftSource}) __jc_l`
      const [row] = await query(target, config, count, !local)
      if (!live()) break
      const n = Number(row?.n)
      const matched = Number(row?.matched)
      if (!Number.isFinite(n) || !Number.isFinite(matched)) continue
      const plain = (side: Json) => [side.catalog_name, side.schema_name, side.table_name].filter(Boolean).join(".")
      const label = `join ${plain(join.left)} → ${plain(join.right)} on ${keys.map((k) => `${k.left} = ${k.right}`).join(", ")}`
      const unit = local || n < REMOTE_ROW_CEILING ? "left rows" : `left rows (first ${REMOTE_ROW_CEILING} counted)`
      const effect =
        kind === "LEFT" ? "they stay as unmatched rows with NULL right columns" : "the inner join drops them"
      for (const line of coverageLoss(matched, n, unit, effect)) lines.push(`${label}: ${line}`)
    }
    return lines.length ? lines.join("\n") : undefined
  }
  try {
    return await Promise.race([work().catch(() => undefined), timeout])
  } finally {
    clearTimeout(timer)
  }
}
