import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import type { SqlExecuteResult } from "../native/types"
// altimate_change start - SQL write access control + fingerprinting
import { classifyAndCheck, computeSqlFingerprint } from "./sql-classify"
import { Telemetry } from "../telemetry"
// altimate_change end
// altimate_change start — progressive disclosure suggestions
import { PostConnectSuggestions } from "./post-connect-suggestions"
// altimate_change end
// altimate_change start — pre-execution SQL validation via cached schema
import { getCache } from "../native/schema/cache"
import * as Registry from "../native/connections/registry"
// altimate_change end

export const SqlExecuteTool = Tool.define("sql_execute", {
  description: "Execute SQL against a connected data warehouse. Returns results as a formatted table.",
  parameters: z.object({
    query: z.string().describe("SQL query to execute"),
    warehouse: z.string().optional().describe("Warehouse connection name"),
    limit: z.number().optional().default(100).describe("Max rows to return"),
  }),
  async execute(args, ctx) {
    // altimate_change start - SQL write access control
    // Permission checks OUTSIDE try/catch so denial errors propagate to the framework
    const { queryType, blocked } = classifyAndCheck(args.query)
    if (blocked) {
      throw new Error("DROP DATABASE, DROP SCHEMA, and TRUNCATE are blocked for safety. This cannot be overridden.")
    }
    if (queryType === "write") {
      await ctx.ask({
        permission: "sql_execute_write",
        patterns: [args.query.slice(0, 200)],
        always: ["*"],
        metadata: { queryType },
      })
    }
    // altimate_change end

    // altimate_change start — shadow-mode pre-execution SQL validation
    // Runs validation against cached schema and emits sql_pre_validation telemetry,
    // but does NOT block execution. Used to measure catch rate before deciding
    // whether to enable blocking in a future release. Fire-and-forget so it
    // doesn't add latency to the sql_execute hot path.
    preValidateSql(args.query, args.warehouse, queryType).catch(() => {})
    // altimate_change end

    try {
      const result = await Dispatcher.call("sql.execute", {
        sql: args.query,
        warehouse: args.warehouse,
        limit: args.limit,
      })

      let output = formatResult(result)
      // altimate_change start — emit SQL structure fingerprint telemetry
      try {
        const fp = computeSqlFingerprint(args.query)
        if (fp) {
          Telemetry.track({
            type: "sql_fingerprint",
            timestamp: Date.now(),
            session_id: ctx.sessionID,
            statement_types: JSON.stringify(fp.statement_types),
            categories: JSON.stringify(fp.categories),
            table_count: fp.table_count,
            function_count: fp.function_count,
            has_subqueries: fp.has_subqueries,
            has_aggregation: fp.has_aggregation,
            has_window_functions: fp.has_window_functions,
            node_count: fp.node_count,
          })
        }
      } catch {
        // Fingerprinting must never break query execution
      }
      // altimate_change end
      // altimate_change start — progressive disclosure suggestions
      const suggestion = PostConnectSuggestions.getProgressiveSuggestion("sql_execute")
      if (suggestion) {
        output += "\n\n" + suggestion
        PostConnectSuggestions.trackSuggestions({
          suggestionType: "progressive_disclosure",
          suggestionsShown: ["sql_analyze"],
          warehouseType: args.warehouse ?? "default",
        })
      }
      // altimate_change end
      return {
        title: `SQL: ${args.query.slice(0, 60)}${args.query.length > 60 ? "..." : ""}`,
        metadata: { rowCount: result.row_count, truncated: result.truncated },
        output,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "SQL: ERROR",
        metadata: { rowCount: 0, truncated: false, error: msg },
        output: `Failed to execute SQL: ${msg}\n\nEnsure the dispatcher is running and a warehouse connection is configured.`,
      }
    }
  },
})

// altimate_change start — pre-execution SQL validation via cached schema
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
// High ceiling so large warehouses aren't arbitrarily truncated; we emit
// schema_truncated in telemetry when the cap is reached so the shadow sample
// can be interpreted correctly.
const COLUMN_SCAN_LIMIT = 500_000

interface PreValidationResult {
  blocked: boolean
  error?: string
}

async function preValidateSql(sql: string, warehouse: string | undefined, queryType: string): Promise<PreValidationResult> {
  const startTime = Date.now()
  // Yield the event loop before heavy synchronous SQLite work so concurrent
  // tasks aren't blocked. Bun's sqlite API is sync and listColumns can touch
  // hundreds of thousands of rows for large warehouses.
  await new Promise<void>((resolve) => setImmediate(resolve))

  // Precompute correlation fields used in every telemetry event this function emits.
  const maskedSqlHash = Telemetry.hashError(Telemetry.maskString(sql))

  try {
    // Resolve the warehouse the same way sql.execute's fallback path does:
    // when caller omits `warehouse`, sql.execute uses Registry.list()[0].
    // Matching that here keeps the shadow validation aligned with actual
    // execution (dbt-routed queries are a known gap — they short-circuit
    // before this fallback, so validation may use a different warehouse
    // than the one dbt selects).
    const registered = Registry.list().warehouses
    let warehouseName = warehouse
    if (!warehouseName) {
      warehouseName = registered[0]?.name
    }
    const warehouseInfo = registered.find((w) => w.name === warehouseName)
    const warehouseType = warehouseInfo?.type ?? "unknown"

    const ctx: TrackCtx = {
      warehouse_type: warehouseType,
      query_type: queryType,
      masked_sql_hash: maskedSqlHash,
    }

    if (!warehouseName) {
      trackPreValidation("skipped", "no_cache", 0, Date.now() - startTime, false, ctx)
      return { blocked: false }
    }

    const cache = await getCache()
    const status = cache.cacheStatus()

    const warehouseStatus = status.warehouses.find((w) => w.name === warehouseName)
    if (!warehouseStatus?.last_indexed) {
      trackPreValidation("skipped", "no_cache", 0, Date.now() - startTime, false, ctx)
      return { blocked: false }
    }

    // Check cache freshness
    const cacheAge = Date.now() - new Date(warehouseStatus.last_indexed).getTime()
    if (cacheAge > CACHE_TTL_MS) {
      trackPreValidation("skipped", "stale_cache", 0, Date.now() - startTime, false, ctx)
      return { blocked: false }
    }

    // Build schema context from cached columns
    const columns = cache.listColumns(warehouseName, COLUMN_SCAN_LIMIT)
    const schemaTruncated = columns.length >= COLUMN_SCAN_LIMIT
    if (columns.length === 0) {
      trackPreValidation("skipped", "empty_cache", 0, Date.now() - startTime, false, ctx)
      return { blocked: false }
    }

    // Build schema context keyed by fully-qualified name (database.schema.table)
    // so multi-database warehouses don't collide on schema+table alone.
    // Dedupe columns per table to defend against residual collisions.
    const schemaContext: Record<string, { name: string; type: string; nullable: boolean }[]> = {}
    const seenColumns: Record<string, Set<string>> = {}
    for (const col of columns) {
      const tableName = [col.database, col.schema_name, col.table].filter(Boolean).join(".")
      if (!tableName) continue
      if (!schemaContext[tableName]) {
        schemaContext[tableName] = []
        seenColumns[tableName] = new Set()
      }
      if (seenColumns[tableName].has(col.name)) continue
      seenColumns[tableName].add(col.name)
      schemaContext[tableName].push({
        name: col.name,
        type: col.data_type || "VARCHAR",
        nullable: col.nullable,
      })
    }

    // Validate SQL against cached schema
    const validationResult = await Dispatcher.call("altimate_core.validate", {
      sql,
      schema_path: "",
      schema_context: schemaContext,
    })

    // If the dispatcher itself failed, don't treat missing data as "valid".
    if (!validationResult.success) {
      trackPreValidation("error", "dispatcher_failed", 0, Date.now() - startTime, false, ctx)
      return { blocked: false }
    }

    const data = (validationResult.data ?? {}) as Record<string, any>
    const errors = Array.isArray(data.errors) ? data.errors : []
    const isValid = data.valid !== false && errors.length === 0

    if (isValid) {
      trackPreValidation("passed", "valid", columns.length, Date.now() - startTime, schemaTruncated, ctx)
      return { blocked: false }
    }

    // Only block on high-confidence structural errors
    const structuralErrors = errors.filter((e: any) => {
      const msg = (e.message ?? "").toLowerCase()
      return /\b(column|table|view|relation|identifier|not found|does not exist)\b/.test(msg)
    })

    if (structuralErrors.length === 0) {
      // Non-structural errors (ambiguous cases) — let them through
      trackPreValidation("passed", "non_structural", columns.length, Date.now() - startTime, schemaTruncated, ctx)
      return { blocked: false }
    }

    trackPreValidation("blocked", "structural_error", columns.length, Date.now() - startTime, schemaTruncated, ctx)
    // Shadow mode: caller discards the result. When blocking is enabled in the
    // future, build errorOutput here with the structural errors and
    // schemaContext keys for user-facing guidance.
    return { blocked: false }
  } catch {
    // Validation failure should never block execution
    const ctx: TrackCtx = { warehouse_type: "unknown", query_type: queryType, masked_sql_hash: maskedSqlHash }
    trackPreValidation("error", "validation_exception", 0, Date.now() - startTime, false, ctx)
    return { blocked: false }
  }
}

interface TrackCtx {
  warehouse_type: string
  query_type: string
  masked_sql_hash: string
}

function trackPreValidation(
  outcome: "skipped" | "passed" | "blocked" | "error",
  reason: string,
  schema_columns: number,
  duration_ms: number,
  schema_truncated: boolean,
  ctx: TrackCtx,
) {
  // Validator errors often embed raw schema identifiers (table / column names)
  // and paths that are PII-adjacent. maskString() only strips string literals,
  // not identifiers, so we intentionally drop the error text entirely from the
  // shadow telemetry payload. The `reason` + `masked_sql_hash` fields are
  // sufficient to correlate events with local logs for diagnosis.
  Telemetry.track({
    type: "sql_pre_validation",
    timestamp: Date.now(),
    session_id: Telemetry.getContext().sessionId,
    outcome,
    reason,
    warehouse_type: ctx.warehouse_type,
    query_type: ctx.query_type,
    masked_sql_hash: ctx.masked_sql_hash,
    schema_columns,
    schema_truncated,
    duration_ms,
  })
}
// altimate_change end

function formatResult(result: SqlExecuteResult): string {
  if (result.row_count === 0) return "(0 rows)"

  const header = result.columns.join(" | ")
  const separator = result.columns.map((c) => "-".repeat(Math.max(c.length, 4))).join("-+-")
  const rows = result.rows.map((r) => r.map((v) => (v === null ? "NULL" : String(v))).join(" | ")).join("\n")

  let output = `${header}\n${separator}\n${rows}\n\n(${result.row_count} rows)`
  if (result.truncated) output += " [truncated]"
  return output
}
