import z from "zod"
import { Effect } from "effect"
import { EffectBridge } from "../../effect/bridge"
import { Truncate } from "../../tool/truncate"
import { legacyToInit, type LegacyToolDef } from "../tool-zod-compat"
import { formatSqlResult, SQL_MAX_PREVIEW_BYTES } from "./sql-result-format"
import { lintSqlResult } from "./sql-result-lint"
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
import { isScratch } from "../native/connections/scratch"
// altimate_change end
// altimate_change start — workspace precedence
import * as Precedence from "../workspace/precedence"
// altimate_change end
// altimate_change start — never render a warehouse failure as an empty result
import { normalizeError } from "./response-normalization"
// altimate_change end

const MAX_SQL_ROWS = 10_000
const LIMIT_ERROR = `limit must be a finite positive integer between 1 and ${MAX_SQL_ROWS}`

const parameters = z.object({
  query: z.string().describe("SQL query to execute"),
  warehouse: z.string().optional().describe("Warehouse connection name"),
  limit: z
    .number({ error: LIMIT_ERROR })
    .int(LIMIT_ERROR)
    .min(1, LIMIT_ERROR)
    .max(MAX_SQL_ROWS, LIMIT_ERROR)
    .optional()
    .default(100)
    .describe(`Max rows to return (1-${MAX_SQL_ROWS}; default 100)`),
  query_timeout_ms: z
    .number()
    .int()
    .min(0)
    .max(3_600_000)
    .optional()
    .describe(
      "Optional per-query execution deadline in ms. Omit to use the configured deadline (connection setting or environment). Set only when a specific query needs a longer or shorter budget; 0 disables.",
    ),
})

export const SqlExecuteTool = Tool.define(
  "sql_execute",
  Effect.gen(function* () {
    const truncate = yield* Truncate.Service
    return () =>
      Effect.gen(function* () {
        const bridge = yield* EffectBridge.make()
        return yield* legacyToInit({
          description: "Execute SQL against a connected data warehouse. Returns results as a formatted table.",
          parameters,
          formatValidationError: (error) => error.issues?.map((issue) => issue.message).join("; ") || LIMIT_ERROR,
          async execute(args, ctx) {
            // altimate_change start - SQL write access control
            // Permission checks OUTSIDE try/catch so denial errors propagate to the framework
            const { queryType, blocked } = classifyAndCheck(args.query)
            if (blocked) {
              throw new Error(
                "DROP DATABASE, DROP SCHEMA, and TRUNCATE are blocked for safety. This cannot be overridden.",
              )
            }
            // The in-memory scratch database is the session's own workspace (what sql_materialize
            // writes to), so DDL/DML there needs no write permission; the hard-deny list above still applies.
            if (queryType === "write" && !isScratch(args.warehouse)) {
              await ctx.ask({
                permission: "sql_execute_write",
                patterns: [args.query.slice(0, 200)],
                always: ["*"],
                metadata: { queryType },
              })
            }
            // altimate_change end

            // altimate_change start — workspace precedence.
            // Last, after BOTH native safety checks. A redirect returns early, so anything
            // above it stops running — and neither check has an equivalent on the other side:
            // the engine's execution tools apply no hard-deny list, and an engine tool key is
            // matched by the builder's `"*": "allow"` rule while `sql_execute_write` is "ask".
            // Redirecting first would let a write reach the warehouse without the confirmation
            // the same statement needed a moment ago. Approving and then redirecting is not a
            // wasted prompt: the write still happens, through the engine, and what the user
            // authorised is the write — not which connection carries it.
            const precedence = await Precedence.check(ctx.sessionID, "sql_execute", args.warehouse)
            if (precedence.redirect) return precedence.redirect
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
                query_timeout_ms: args.query_timeout_ms,
              })

              // altimate_change start — a failure must not be rendered as "(0 rows)".
              // sql.execute never throws: it catches every connection and query error
              // and returns a result-shaped object carrying `error`, so an unresolvable
              // warehouse used to reach the agent as a successful empty table with no
              // fault string at all. Surface it the way schema_inspect already does.
              const responseError = normalizeError((result as SqlExecuteResult & { error?: unknown }).error)
              if (responseError !== undefined) {
                const msg = responseError.trim() || "SQL execution failed."
                // altimate_change: deliberately NOT fingerprinted. `sql.execute` returns this
                // same result shape both for a warehouse query that ran and failed AND for a
                // pre-execution failure — no warehouse configured, connector setup failed
                // (see connections/register.ts). This branch alone cannot tell those apart, so
                // fingerprinting it would mislabel some never-executed queries as "executed
                // SQL". De-scoped to fingerprint-on-success-only (below) rather than build a
                // failed-execution-vs-never-executed taxonomy in this cleanup PR; tracked as
                // altimate-code#1242.
                // altimate_change — annotate this failure too, same as the catch block below:
                // a fail-open notice that only rides on success under-counts fail-open in
                // precisely the cases most likely to fail.
                return Precedence.annotate(precedence, {
                  title: "SQL: ERROR",
                  metadata: { rowCount: 0, truncated: false, error: msg },
                  output: `Failed to execute SQL: ${msg}`,
                })
              }
              // altimate_change end

              // altimate_change start — emit SQL structure fingerprint telemetry on the
              // success path, BEFORE formatting the result. A query that reached this point
              // genuinely executed against a warehouse; emitting the fingerprint here (rather
              // than after formatting) means a formatting failure below still leaves this
              // execution counted, instead of silently dropping it from the telemetry.
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

              const limits = await bridge.promise(truncate.limits())
              const suggestion = PostConnectSuggestions.getProgressiveSuggestion("sql_execute")
              const extra =
                (suggestion ? "\n\n" + suggestion : "") + (precedence.notice ? precedence.notice + "\n\n" : "")
              const formatted = await formatSqlResult(result, {
                limit: args.limit,
                // The statement text lets the formatter add the empty/near-empty
                // result hint when a string-literal filter is present.
                sql: args.query,
                maxBytes: Math.max(
                  0,
                  Math.min(SQL_MAX_PREVIEW_BYTES, limits.maxBytes) - Buffer.byteLength(extra, "utf8"),
                ),
                maxLines: Math.max(0, limits.maxLines - extra.split("\n").length + 1),
                write: (text) => bridge.promise(truncate.write(text)),
              })
              const lint = await lintSqlResult(args.query, args.warehouse, ctx.sessionID)
              let output = formatted.output + (lint ? "\n\n" + lint.output : "")
              // altimate_change start — progressive disclosure suggestions
              if (suggestion) {
                output += "\n\n" + suggestion
                PostConnectSuggestions.trackSuggestions({
                  suggestionType: "progressive_disclosure",
                  suggestionsShown: ["sql_analyze"],
                  warehouseType: args.warehouse ?? "default",
                })
              }
              // altimate_change end
              // altimate_change — carries the fail-open notice when the target could not be
              // attributed to the workspace; a no-op otherwise.
              const response = Precedence.annotate(precedence, {
                title: `SQL: ${args.query.slice(0, 60)}${args.query.length > 60 ? "..." : ""}`,
                metadata: { ...formatted.metadata, ...(lint && { lint_rules: lint.rules }) },
                output,
              })
              if (precedence.notice && formatted.metadata.truncated) {
                // Keep the result contract first while retaining the routing notice.
                const newline = output.indexOf("\n")
                response.output = output.slice(0, newline + 1) + precedence.notice + "\n\n" + output.slice(newline + 1)
              }
              return response
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e)
              // altimate_change: deliberately NOT fingerprinted, same reasoning as the
              // result-error branch above — this catch only fires when `Dispatcher.call`
              // itself throws, which never happened after a warehouse actually ran the query.
              // altimate_change — annotate the failure too. A fail-open notice that only rides
              // on success is worse than none: the reason vanishes exactly when the call went
              // wrong, and the `precedence` marker under-counts fail-open in precisely the
              // cases most likely to fail.
              return Precedence.annotate(precedence, {
                title: "SQL: ERROR",
                metadata: { rowCount: 0, truncated: false, error: msg },
                output: `Failed to execute SQL: ${msg}\n\nEnsure the dispatcher is running and a warehouse connection is configured.`,
              })
            }
          },
        } satisfies LegacyToolDef<typeof parameters>)
      })
  }),
)

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

async function preValidateSql(
  sql: string,
  warehouse: string | undefined,
  queryType: string,
): Promise<PreValidationResult> {
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
