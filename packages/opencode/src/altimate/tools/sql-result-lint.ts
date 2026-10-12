import type { LintFinding } from "@altimateai/altimate-core"
import * as Registry from "../native/connections/registry"
import { EngineCoerce } from "../native/engine-coerce"
import { getCache } from "../native/schema/cache"
import { readSql } from "./sql-check"

const RULES = new Set([
  "cast_division_to_int",
  "sum_of_ratio",
  "join_fan_out",
  "non_deterministic_dedup",
  "null_in_in_list",
  "not_in_nullable",
  "greatest_least_null",
  "typed_coalesce_mismatch",
  "null_propagating_concat",
  "union_without_all",
  "implicit_cross_join",
  "join_without_condition",
  "outer_join_filter_in_where",
  "count_star_vs_column",
  "division_by_column_no_guard",
  "integer_division",
  "limit_without_order_by",
  "avg_of_avg",
  "reserved_word_alias",
])

const LINT_BUDGET_MS = 250
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const COLUMN_SCAN_LIMIT = 500_000
const SCHEMA_COLUMN_LIMIT = 2_000
const slowSessions = new Set<string>()

type Finding = Pick<LintFinding, "rule" | "message" | "suggestion"> & { severity: string }

export function formatSqlLint(findings: readonly Finding[]) {
  const kept = findings.filter((f) => RULES.has(f.rule) && f.severity.toLowerCase() !== "info").slice(0, 3)
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()
  const lines = kept.map(
    (f) => `Check: ${f.rule}: ${oneLine(f.message)}${f.suggestion ? ` — ${oneLine(f.suggestion)}` : ""}`,
  )
  return { output: lines.length ? `Checks:\n${lines.join("\n")}` : "", rules: [...new Set(kept.map((f) => f.rule))] }
}

/** Advisory only: a failed or slow lint must leave successful query results intact. */
export async function lintSqlResult(sql: string, warehouse: string | undefined, sessionID: string) {
  if (process.env.ALTIMATE_SQL_EXECUTE_LINT === "0" || slowSessions.has(sessionID)) return
  const started = performance.now()
  const expired = () => {
    if (performance.now() - started > LINT_BUDGET_MS) slowSessions.add(sessionID)
    return slowSessions.has(sessionID)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // The general classifier also labels modifying CTEs and SELECT INTO as queries.
    readSql(sql)
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        slowSessions.add(sessionID)
        resolve(undefined)
      }, LINT_BUDGET_MS)
    })
    const run = async () => {
      const [core, { prepareSql }] = await Promise.all([
        import("@altimateai/altimate-core"),
        import("../native/schema-resolver"),
      ])
      if (expired()) return
      const name = warehouse ?? Registry.list().warehouses[0]?.name
      const type = Registry.canonicalType(name ? Registry.getConfig(name)?.type : undefined)
      const dialect = EngineCoerce.dialectHint(type === "sqlserver" ? "tsql" : type)
      const referenced = new Set<string>()
      try {
        for (const table of core.extractMetadata?.(sql, dialect).tables ?? []) referenced.add(table.toLowerCase())
      } catch {
        // Metadata extraction is optional; schema-free rules can still run.
      }
      const hasQualifiedReferences = [...referenced].some((table) => table.includes("."))
      const tables: Record<string, { columns: { name: string; type: string; nullable: boolean }[] }> =
        Object.create(null)
      if (name && referenced.size) {
        const cache = await getCache()
        if (expired()) return
        const status = cache.cacheStatus().warehouses.find((w) => w.name === name)
        const age = status?.last_indexed ? Date.now() - new Date(status.last_indexed).getTime() : NaN
        if (Number.isFinite(age) && age <= CACHE_TTL_MS) {
          const seen = new Map<string, Set<string>>()
          let count = 0
          // SchemaCache has no per-table lookup. Filter its bounded column list
          // before constructing the native schema, whose cost grows with its size.
          for (const column of cache.listColumns(name, COLUMN_SCAN_LIMIT)) {
            if (!referenced.has(column.table.toLowerCase())) {
              if (!hasQualifiedReferences) continue
              const qualified = `${column.schema_name}.${column.table}`.toLowerCase()
              if (!referenced.has(qualified) && !referenced.has(`${column.database}.${qualified}`.toLowerCase())) continue
            }
            const table = [column.database, column.schema_name, column.table].filter(Boolean).join(".")
            if (!seen.has(table)) {
              seen.set(table, new Set())
              tables[table] = { columns: [] }
            }
            if (seen.get(table)!.has(column.name)) continue
            seen.get(table)!.add(column.name)
            tables[table].columns.push({
              name: column.name,
              type: column.data_type || "VARCHAR",
              nullable: column.nullable,
            })
            if (++count >= SCHEMA_COLUMN_LIMIT) break
          }
        }
      }
      // Core requires at least one table, even for rules that need no schema.
      if (!Object.keys(tables).length) tables._empty_ = { columns: [{ name: "id", type: "INT", nullable: true }] }
      if (expired()) return
      const prepared = prepareSql(sql, undefined, { tables, dialect })
      if (expired()) return
      const result = formatSqlLint(prepared.unfold(core.lint(prepared.sql, prepared.schema).findings))
      // NAPI lint is synchronous: the timer cannot interrupt it. Discard an over-budget
      // result and skip later lints in this session, including sql_materialize.
      if (expired() || !result.rules.length) return
      return result
    }
    return await Promise.race([run(), timeout])
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
    expired()
  }
}
