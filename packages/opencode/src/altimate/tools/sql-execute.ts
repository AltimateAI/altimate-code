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
import { classifyAndCheck, classifyMongoCommand, computeSqlFingerprint, isScratchSafeWrite } from "./sql-classify"
import { statementsOf } from "./sql-tokenize"

const MONGO_WAREHOUSE_TYPES = new Set(["mongodb", "mongo"])

function isMongoWarehouse(name: string | undefined): boolean {
  const type = Registry.canonicalType(name ? Registry.getConfig(name)?.type : undefined) ?? ""
  return MONGO_WAREHOUSE_TYPES.has(type)
}
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
import { readSql } from "./sql-check"

const MAX_SQL_ROWS = 10_000
const LIMIT_ERROR = "limit must be a finite positive integer"
const MAX_GENERATED_SQL_BYTES = 1024 * 1024
// Below the default tool-output cap, so a redirect never spills the SQL into a truncated file.
const MAX_REDIRECT_SQL_BYTES = 40 * 1024

function generatedRead(sql: string, warehouse: string, stage: "source" | "result"): string {
  try {
    return readSql(sql, Registry.canonicalType(Registry.getConfig(warehouse)?.type) ?? undefined)
  } catch {
    throw new Error(`query_from ${stage} must be a single read-only SELECT (or WITH ... SELECT).`)
  }
}

const parameters = z
  .object({
  query: z.string().nullish().describe("SQL query to execute; omit when using query_from"),
  query_from: z
    .object({
      warehouse: z.string().describe("Warehouse containing the SQL generator or saved SQL"),
      sql: z.string().describe("Single read-only SELECT returning exactly one row and one SQL string column"),
    })
    .nullish()
    .describe(
      "Fetch SQL internally instead of copying generated SQL through the conversation; requires an explicit target warehouse",
    ),
  warehouse: z.string().optional().describe("Warehouse connection name"),
  limit: z
    .number({ error: LIMIT_ERROR })
    .int(LIMIT_ERROR)
    .min(1, LIMIT_ERROR)
    .optional()
    .describe(
      `Max rows to return; omit to use the default. Ordinary mode caps larger values at ${MAX_SQL_ROWS}; active full_text_columns clamps larger limits to 20 with a result note.`,
    ),
  full_text_columns: z
    .array(z.string().min(1))
    .nullish()
    .describe(
      "Keep all selected columns and prioritize named cell text within the ordinary output budget. Always save all returned rows to result_path; use read with char_offset/max_chars to recover clipped text. [] or null, or omitting this field, turns the mode off. A non-empty list caps preview rows at 20; omit limit to use the default, or larger limits are clamped with a result note. Missing names produce a bounded note listing available columns; rows are still returned.",
    ),
  query_timeout_ms: z
    .number()
    .int()
    .min(1)
    .max(3_600_000)
    .optional()
    .describe(
      "Optional per-query execution deadline in ms. Omit or use 0 to use the configured deadline (connection setting or environment), bounded by the remaining run budget. Set a positive value only when a specific query needs a longer or shorter budget.",
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
          description:
            "Execute SQL against a connected data warehouse. Returns all selected columns as a formatted table. full_text_columns prioritizes named cells within the ordinary output budget and always saves returned rows to result_path; read with char_offset/max_chars recovers clipped text. [] or null, or omitting the field, turns the mode off. A non-empty list caps preview rows at 20: omit limit to use the default; larger limits clamp to 20 with a result note. Missing column names produce a bounded note listing available columns while still returning rows. " +
            "Provide exactly one of query or query_from. query_from runs a read-only generator SELECT and executes its single SQL string result (up to 1 MiB) as a read-only SELECT on warehouse, without previewing or retyping the generated SQL. " +
            "For DuckDB table sets, generate query_table([...], true) with escaped table-name string literals. For thousands of tables, UNION ALL BY NAME batches of at most 128 names to stay within the default expression depth.",
          parameters,
          formatValidationError: (error) => error.issues?.map((issue) => issue.message).join("; ") || LIMIT_ERROR,
          async execute(args, ctx) {
            const fullText = Boolean(args.full_text_columns?.length)
            const limit = fullText ? Math.min(args.limit ?? 20, 20) : Math.min(args.limit ?? 100, MAX_SQL_ROWS)
            const limitNote =
              fullText && args.limit !== undefined && args.limit > 20
                ? `Note: limit ${args.limit} clamped to 20 for full_text_columns.`
                : ""
            let sql = args.query ?? ""
            // Strict-schema clients send null or empty placeholders for unused optional fields.
            const queryFrom = args.query_from?.warehouse.trim() || args.query_from?.sql.trim() ? args.query_from : undefined
            if (Boolean(sql.trim()) === Boolean(queryFrom)) {
              throw new Error("Provide exactly one of query or query_from.")
            }
            let sourcePrecedence: Precedence.Verdict | undefined
            if (queryFrom) {
              if (!queryFrom.warehouse.trim() || !queryFrom.sql.trim()) {
                throw new Error("query_from requires non-empty warehouse and sql.")
              }
              if (!args.warehouse?.trim()) throw new Error("query_from requires an explicit target warehouse.")
              const source = queryFrom
              const sourceSql = generatedRead(source.sql, source.warehouse, "source")
              await ctx.ask({
                permission: "sql_execute",
                patterns: [sourceSql],
                always: ["*"],
                metadata: { warehouse: source.warehouse },
              })
              sourcePrecedence = await Precedence.check(ctx.sessionID, "sql_execute", source.warehouse)
              if (sourcePrecedence.redirect) return sourcePrecedence.redirect
              try {
                const result = await Dispatcher.call("sql.execute", {
                  sql: sourceSql,
                  warehouse: source.warehouse,
                  limit: 2,
                  query_timeout_ms: args.query_timeout_ms,
                  ...(Registry.canonicalType(Registry.getConfig(source.warehouse)?.type) === "postgres"
                    ? { read_only: true }
                    : {}),
                }, { signal: ctx.abort, sessionID: ctx.sessionID })
                const error = normalizeError(result.error)
                if (error !== undefined) {
                  throw new Error(`query_from source failed: ${error.trim() || "SQL execution failed."}`)
                }
                const value = result.rows[0]?.[0]
                if (
                  result.truncated ||
                  result.row_count !== 1 ||
                  result.columns.length !== 1 ||
                  result.rows.length !== 1 ||
                  result.rows[0].length !== 1 ||
                  typeof value !== "string" ||
                  !value.trim()
                ) {
                  throw new Error(
                    "query_from must return exactly one row and one non-empty SQL string column, without truncation.",
                  )
                }
                if (Buffer.byteLength(value, "utf8") > MAX_GENERATED_SQL_BYTES) {
                  throw new Error("query_from generated SQL exceeds the 1 MiB limit.")
                }
                sql = generatedRead(value, args.warehouse, "result")
              } catch (error) {
                if (!sourcePrecedence.notice) throw error
                const message = error instanceof Error ? error.message : String(error)
                throw new Error(`${sourcePrecedence.notice}\n\n${message}`)
              }
              await ctx.ask({
                permission: "sql_execute",
                patterns: [sql],
                always: ["*"],
                metadata: { warehouse: args.warehouse },
              })
            }
            // altimate_change start - SQL write access control
            // Permission checks OUTSIDE try/catch so denial errors propagate to the framework
            // MongoDB warehouses take JSON command documents; the SQL classifier would read
            // every one as a write. Dispatch the normalized `{command, collection}` form.
            const warehouse = args.warehouse || Registry.list().warehouses[0]?.name
            // An omitted warehouse tries dbt before the registry fallback. Its dialect
            // can differ, so only an explicit target can relax conservative SQL lexing.
            const dialect = args.warehouse
              ? (Registry.canonicalType(Registry.getConfig(args.warehouse)?.type) ?? undefined)
              : undefined
            const mongoWarehouse = isMongoWarehouse(warehouse)
            const mongo = mongoWarehouse ? classifyMongoCommand(sql) : null
            if (mongoWarehouse && !mongo) {
              throw new Error(
                'A MongoDB query must be a JSON command, e.g. {"command":"find","collection":"c","filter":{}}. SQL text is not supported.',
              )
            }
            const classification = mongo ?? classifyAndCheck(sql, dialect)
            const { queryType, blocked } = classification
            const query = mongo?.normalized ?? sql
            if (blocked) {
              throw new Error(
                "DROP DATABASE, DROP SCHEMA, TRUNCATE, and executable SQL comments are blocked for safety. This cannot be overridden.",
              )
            }
            const parseError = "parseError" in classification ? classification.parseError : undefined
            if (!mongo && queryType === "read") {
              // classifyAndCheck verifies complete lexical/parser agreement and every
              // statement's read status, including metadata. Unlike check/materialize,
              // execution does not wrap SQL in a subquery and accepts those reads.
              const count = statementsOf(query, dialect).length
              if (count === 0) throw new Error("SQL execution requires a statement.")
              // Connectors expose one result set; several prepare only one statement
              // or cannot normalize a batch response. Do not silently drop reads.
              if (count > 1) {
                throw new Error(
                  "Multi-statement reads are not supported by this execution path. Run each read separately.",
                )
              }
            }
            // The ephemeral scratch database is the session's own workspace (what sql_materialize
            // writes to), so table DDL/row DML there needs no write permission. Statements that can
            // reach outside the engine (COPY TO, ATTACH, INSTALL/LOAD, EXPORT, SET) still ask, and
            // the hard-deny list above still applies.
            if (queryType === "write" && !(isScratch(args.warehouse) && isScratchSafeWrite(sql))) {
              // Unprovable SQL still goes through write approval; the prompt carries the parse error.
              await ctx.ask({
                permission: "sql_execute_write",
                patterns: [sql.slice(0, 200)],
                always: ["*"],
                metadata: { queryType, ...(parseError && { parseError }) },
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
            const precedence = { ...(await Precedence.check(ctx.sessionID, "sql_execute", args.warehouse)) }
            if (precedence.redirect) {
              // The workspace tool needs the SQL; a generated statement exists only in this
              // frame, so hand it to the caller or the redirect cannot be followed.
              if (queryFrom && Buffer.byteLength(sql, "utf8") > MAX_REDIRECT_SQL_BYTES) {
                throw new Error(
                  "query_from generated SQL is too large to hand to the workspace tool; run it on a local connection.",
                )
              }
              const redirect = queryFrom
                ? {
                    ...precedence.redirect,
                    output: `${precedence.redirect.output}\n\nSQL to run:\n${sql}`,
                    metadata: { ...precedence.redirect.metadata, generated_sql: true },
                  }
                : precedence.redirect
              return sourcePrecedence ? Precedence.annotate(sourcePrecedence, redirect) : redirect
            }
            if (sourcePrecedence?.notice) {
              precedence.notice = [sourcePrecedence.notice, precedence.notice].filter(Boolean).join("\n")
              precedence.precedence ??= sourcePrecedence.precedence
            }
            // altimate_change end

            // altimate_change start — shadow-mode pre-execution SQL validation
            // Runs validation against cached schema and emits sql_pre_validation telemetry,
            // but does NOT block execution. Used to measure catch rate before deciding
            // whether to enable blocking in a future release. Fire-and-forget so it
            // doesn't add latency to the sql_execute hot path.
            preValidateSql(sql, args.warehouse, queryType).catch(() => {})
            // altimate_change end

            try {
              // A PostgreSQL view can invoke a writing function even for a parsed read.
              const readOnly = queryType === "read" &&
                Registry.canonicalType(warehouse ? Registry.getConfig(warehouse)?.type : undefined) === "postgres"
              const result = await Dispatcher.call("sql.execute", {
                sql: query,
                warehouse: args.warehouse,
                limit,
                query_timeout_ms: args.query_timeout_ms,
                ...(readOnly ? { read_only: true } : {}),
              }, { signal: ctx.abort, sessionID: ctx.sessionID })

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
                const fp = computeSqlFingerprint(sql, dialect)
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
              const maxBytes = Math.min(limits.maxBytes, SQL_MAX_PREVIEW_BYTES)
              // Reserve the routing explanation before the formatter budgets optional notes.
              const routingNotice = fullText ? Precedence.annotate(precedence, { output: "" }).output : ""
              let routingPrefix = ""
              let routingBytes = 0
              let routingLines = 0
              for (const char of routingNotice) {
                const size = Buffer.byteLength(char, "utf8")
                if (
                  routingBytes + size > maxBytes ||
                  limits.maxLines < 1 ||
                  (char === "\n" && routingLines + 1 >= limits.maxLines)
                )
                  break
                routingPrefix += char
                routingBytes += size
                if (char === "\n") routingLines++
              }
              const routingClipped = routingPrefix !== routingNotice
              const suggestion = ctx.agent === "analyst" ? null : PostConnectSuggestions.getProgressiveSuggestion("sql_execute")
              const lint = await lintSqlResult(sql, args.warehouse, ctx.sessionID)
              const formatted = await formatSqlResult(result, {
                mcpClient: ctx.extra?.mcpClient === true,
                limit,
                fullTextColumns: args.full_text_columns,
                // The statement text lets the formatter add the empty/near-empty
                // result hint when a string-literal filter is present.
                sql: ctx.agent === "analyst" ? undefined : query,
                notes: [
                  fullText ? "" : (precedence.notice ?? ""),
                  limitNote,
                  lint?.output ?? "",
                  suggestion ?? "",
                ].filter(Boolean),
                maxBytes: routingClipped ? 0 : maxBytes - routingBytes,
                maxLines: limits.maxLines - routingLines,
                write: (text) => bridge.promise(truncate.write(text)),
              })
              // altimate_change start — progressive disclosure suggestions
              if (suggestion && formatted.output.includes(suggestion)) {
                PostConnectSuggestions.trackSuggestions({
                  suggestionType: "progressive_disclosure",
                  suggestionsShown: ["sql_analyze"],
                  warehouseType: args.warehouse ?? "default",
                })
              }
              // altimate_change end
              // The full-text routing prefix already has its own reserved output allowance.
              return {
                ...Precedence.annotate(precedence, {
                  title: queryFrom ? "SQL: generated read" : `SQL: ${sql.slice(0, 60)}${sql.length > 60 ? "..." : ""}`,
                  metadata: {
                    ...formatted.metadata,
                    ...(routingClipped && { output_truncated: true, truncated: true }),
                    ...(lint && { lint_rules: lint.rules }),
                  },
                }),
                output: routingPrefix + formatted.output,
              }
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
                output: `Failed to execute SQL: ${msg}`,
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
