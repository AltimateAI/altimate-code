/**
 * Register native connection handlers with the Dispatcher.
 *
 * Handles: sql.execute, sql.explain, sql.autocomplete, warehouse.list,
 * warehouse.test, warehouse.add, warehouse.remove, warehouse.discover,
 * schema.inspect
 */

import { register } from "../dispatcher"
import * as Registry from "./registry"
import { discoverContainers } from "./docker-discovery"
import { parseDbtProfiles } from "./dbt-profiles"
import type {
  SqlExecuteParams,
  SqlExecuteResult,
  SqlExplainParams,
  SqlExplainResult,
  SqlAutocompleteParams,
  SqlAutocompleteResult,
  WarehouseListResult,
  WarehouseTestParams,
  WarehouseTestResult,
  WarehouseAddParams,
  WarehouseAddResult,
  WarehouseRemoveParams,
  WarehouseRemoveResult,
  WarehouseDiscoverResult,
  SchemaInspectParams,
  SchemaInspectResult,
  DbtProfilesParams,
  DbtProfilesResult,
} from "../types"
import type { ConnectionConfig } from "@altimateai/drivers"
import { Telemetry } from "../../../telemetry"

// ---------------------------------------------------------------------------
// dbt-first execution strategy
// ---------------------------------------------------------------------------

/** Cached dbt adapter (lazily created on first use). */
let dbtAdapter: any | null | undefined = undefined

/**
 * Try to execute SQL via dbt's adapter (which uses profiles.yml for connection).
 * Returns null if dbt is not available or not configured — caller should fall back
 * to native driver.
 *
 * This is the preferred path when working in a dbt project: dbt already knows
 * how to connect, so users don't need to configure a separate connection.
 */
async function tryExecuteViaDbt(
  sql: string,
  limit?: number,
): Promise<SqlExecuteResult | null> {
  // Only attempt dbt once — if it's not configured, don't retry on every query
  if (dbtAdapter === null) return null

  if (dbtAdapter === undefined) {
    try {
      // Check if dbt config exists
      const { read: readDbtConfig } = await import(
        "../../../../../dbt-tools/src/config"
      )
      const dbtConfig = await readDbtConfig()
      if (!dbtConfig) {
        dbtAdapter = null
        return null
      }

      // Check if dbt_project.yml exists
      const fs = await import("fs")
      const path = await import("path")
      if (
        !fs.existsSync(path.join(dbtConfig.projectRoot, "dbt_project.yml"))
      ) {
        dbtAdapter = null
        return null
      }

      // Create the adapter
      const { create } = await import("../../../../../dbt-tools/src/adapter")
      dbtAdapter = await create(dbtConfig)
    } catch {
      // dbt-tools not available or config invalid — fall back to native
      dbtAdapter = null
      return null
    }
  }

  try {
    const raw = limit
      ? await dbtAdapter.immediatelyExecuteSQLWithLimit(sql, "", limit)
      : await dbtAdapter.immediatelyExecuteSQL(sql, "")

    // QueryExecutionResult has: { columnNames, columnTypes, data, rawSql, compiledSql }
    // where data is Record<string, unknown>[] (array of row objects)
    if (raw && raw.columnNames && Array.isArray(raw.data)) {
      const columns: string[] = raw.columnNames
      const allRows = raw.data.map((row: Record<string, unknown>) =>
        columns.map((c) => row[c]),
      )
      // The adapter already applies the limit, so allRows.length <= limit.
      // We report truncated=true when exactly limit rows were returned (likely more exist).
      const truncated = limit ? allRows.length >= limit : false
      const rows = allRows
      return {
        columns,
        rows,
        row_count: rows.length,
        truncated,
      }
    }

    // Legacy format: raw.table with column_names/rows arrays
    if (raw && raw.table) {
      const columns = raw.table.column_names ?? raw.table.columns ?? []
      const rows = raw.table.rows ?? []
      const truncated = limit ? rows.length > limit : false
      const trimmedRows = truncated ? rows.slice(0, limit) : rows
      return {
        columns,
        rows: trimmedRows,
        row_count: trimmedRows.length,
        truncated,
      }
    }

    // Array of objects (e.g. from direct query)
    if (raw && Array.isArray(raw)) {
      if (raw.length === 0) return { columns: [], rows: [], row_count: 0, truncated: false }
      const columns = Object.keys(raw[0])
      const rows = raw.map((r: any) => columns.map((c) => r[c]))
      return { columns, rows, row_count: rows.length, truncated: false }
    }

    return null // Unknown result format — fall back to native
  } catch {
    // dbt execution failed — fall back to native driver silently
    return null
  }
}

/** Reset dbt adapter (for testing). */
export function resetDbtAdapter(): void {
  dbtAdapter = undefined
}

// ---------------------------------------------------------------------------
// Telemetry helpers
// ---------------------------------------------------------------------------

export function detectQueryType(sql: string | null | undefined): string {
  if (!sql || typeof sql !== "string") return "OTHER"
  const trimmed = sql.trim().toUpperCase()
  if (trimmed.startsWith("SELECT") || trimmed.startsWith("WITH")) return "SELECT"
  if (trimmed.startsWith("INSERT")) return "INSERT"
  if (trimmed.startsWith("UPDATE")) return "UPDATE"
  if (trimmed.startsWith("DELETE")) return "DELETE"
  if (trimmed.startsWith("CREATE") || trimmed.startsWith("ALTER") || trimmed.startsWith("DROP")) return "DDL"
  if (trimmed.startsWith("SHOW") || trimmed.startsWith("DESCRIBE") || trimmed.startsWith("EXPLAIN")) return "SHOW"
  return "OTHER"
}

export function categorizeQueryError(e: unknown): string {
  const msg = String(e).toLowerCase()
  if (msg.includes("syntax")) return "syntax_error"
  if (msg.includes("permission") || msg.includes("denied") || msg.includes("access")) return "permission_denied"
  if (msg.includes("timeout")) return "timeout"
  if (msg.includes("connection") || msg.includes("closed") || msg.includes("terminated")) return "connection_lost"
  return "other"
}

function getWarehouseType(warehouseName?: string): string {
  if (!warehouseName) {
    const warehouses = Registry.list().warehouses
    if (warehouses.length > 0) return warehouses[0].type
    return "unknown"
  }
  return Registry.getConfig(warehouseName)?.type ?? "unknown"
}

/**
 * Dialect-aware EXPLAIN plan describing how a warehouse should be asked for
 * a query plan.
 *
 *   - `prefix`: the statement prefix to prepend to the SQL ("" means this
 *     warehouse cannot be EXPLAIN'd via a simple statement prefix — the
 *     handler will return a clear error instead of issuing a broken query)
 *   - `actuallyAnalyzed`: whether the prefix actually runs the query and
 *     reports runtime stats. The caller requested `analyze=true`, but some
 *     warehouses silently downgrade to plan-only (e.g. Snowflake), so we
 *     reflect the true mode back to the user in the result envelope.
 */
export interface ExplainPlan {
  prefix: string
  actuallyAnalyzed: boolean
}

/**
 * Build a dialect-aware EXPLAIN plan for the given warehouse type.
 *
 * Warehouse-specific notes:
 *   - Snowflake: `EXPLAIN USING TEXT`. No ANALYZE variant — silently downgraded.
 *   - PostgreSQL: `EXPLAIN` or `EXPLAIN (ANALYZE, BUFFERS)` for runtime stats.
 *   - Redshift: plain `EXPLAIN` only. Redshift does NOT support ANALYZE.
 *   - MySQL / MariaDB: `EXPLAIN` or `EXPLAIN ANALYZE` (MySQL 8+).
 *   - DuckDB: `EXPLAIN` or `EXPLAIN ANALYZE`.
 *   - Databricks / Spark: `EXPLAIN` or `EXPLAIN FORMATTED`.
 *   - ClickHouse: `EXPLAIN` (no ANALYZE form accepted via statement prefix).
 *   - BigQuery: uses a dry-run API instead of any EXPLAIN statement. Not
 *     supported via this code path — return empty prefix.
 *   - Oracle: `EXPLAIN PLAN FOR` stores the plan in PLAN_TABLE rather than
 *     returning it, so a bare prefix does not produce output. Not supported.
 *   - SQL Server: requires `SET SHOWPLAN_TEXT ON` as a session setting.
 *     Not supported via statement prefix.
 */
export function buildExplainPlan(warehouseType: string | undefined, analyze: boolean): ExplainPlan {
  const type = (warehouseType ?? "").toLowerCase()
  switch (type) {
    case "snowflake":
      // Snowflake: no ANALYZE; USING TEXT returns a readable plan.
      return { prefix: "EXPLAIN USING TEXT", actuallyAnalyzed: false }
    case "postgres":
    case "postgresql":
      return analyze
        ? { prefix: "EXPLAIN (ANALYZE, BUFFERS)", actuallyAnalyzed: true }
        : { prefix: "EXPLAIN", actuallyAnalyzed: false }
    case "redshift":
      // Redshift supports only plain EXPLAIN — no ANALYZE/BUFFERS.
      return { prefix: "EXPLAIN", actuallyAnalyzed: false }
    case "mysql":
    case "mariadb":
      // MySQL 8+ supports `EXPLAIN ANALYZE`. Older versions will reject it
      // at the warehouse and the error will be surfaced to the caller.
      return analyze
        ? { prefix: "EXPLAIN ANALYZE", actuallyAnalyzed: true }
        : { prefix: "EXPLAIN", actuallyAnalyzed: false }
    case "duckdb":
      return analyze
        ? { prefix: "EXPLAIN ANALYZE", actuallyAnalyzed: true }
        : { prefix: "EXPLAIN", actuallyAnalyzed: false }
    case "databricks":
    case "spark":
      // Databricks/Spark `EXPLAIN FORMATTED` returns a more detailed plan but
      // does not actually execute the query — still a plan-only mode.
      return { prefix: analyze ? "EXPLAIN FORMATTED" : "EXPLAIN", actuallyAnalyzed: false }
    case "clickhouse":
      return { prefix: "EXPLAIN", actuallyAnalyzed: false }
    case "bigquery":
      // BigQuery has no EXPLAIN statement — the correct answer is a dry-run
      // job via the BigQuery API, which this tool does not support today.
      return { prefix: "", actuallyAnalyzed: false }
    case "oracle":
      // Oracle's `EXPLAIN PLAN FOR` stores the plan in PLAN_TABLE and returns
      // no rows, so a statement-prefix approach does not work. Callers would
      // need a follow-up `SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY)`.
      return { prefix: "", actuallyAnalyzed: false }
    case "mssql":
    case "sqlserver":
      // SQL Server requires `SET SHOWPLAN_TEXT ON` as a session setting,
      // not a statement prefix. Not supported via this code path.
      return { prefix: "", actuallyAnalyzed: false }
    default:
      // Unknown warehouse — fall back to plain EXPLAIN and let the driver
      // surface a real error if it does not understand the syntax.
      return analyze
        ? { prefix: "EXPLAIN ANALYZE", actuallyAnalyzed: true }
        : { prefix: "EXPLAIN", actuallyAnalyzed: false }
  }
}

/** @deprecated Use buildExplainPlan for richer metadata about the plan mode. */
export function buildExplainPrefix(warehouseType: string | undefined, analyze: boolean): string {
  return buildExplainPlan(warehouseType, analyze).prefix
}

// altimate_change start — actionable alternatives for unsupported EXPLAIN
function explainAlternative(warehouseType: string | undefined): string {
  switch ((warehouseType ?? "").toLowerCase()) {
    case "bigquery":
      return "Use the BigQuery Console's Query Explanation tab, or run a dry-run query via `bq query --dry_run`."
    case "oracle":
      return "Use `EXPLAIN PLAN FOR <sql>` followed by `SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY)` in your SQL client."
    case "mssql":
    case "sqlserver":
      return "Use `SET SHOWPLAN_TEXT ON` in SSMS or Azure Data Studio before running the query."
    default:
      return "This warehouse requires a different plan mechanism that sql_explain cannot issue directly."
  }
}
// altimate_change end

/**
 * Translate a raw warehouse/Registry error into an actionable message.
 *
 * Verbatim driver errors like "Connection ? not found. Available: (none)" are
 * useless to an LLM caller that has no way to fix them. Detect common patterns
 * and rewrite them with concrete next steps.
 */
export function translateExplainError(
  raw: unknown,
  warehouseName: string | undefined,
  availableWarehouses: string[],
): string {
  const msg = raw instanceof Error ? raw.message : String(raw)

  // Connection/warehouse lookup failures.
  if (/Connection\s+.+\s+not found/i.test(msg) || /warehouse\s+.+\s+not found/i.test(msg)) {
    if (availableWarehouses.length > 0) {
      return `Warehouse ${JSON.stringify(warehouseName ?? "")} is not configured. Available warehouses: ${availableWarehouses.join(", ")}. Pass one of these as the 'warehouse' parameter, or omit it to use the default.`
    }
    return "No warehouses are configured. Run `warehouse_add` to set one up before calling sql_explain."
  }

  // Unsubstituted-placeholder compilation errors.
  //
  // Bind placeholders come in three flavours: positional `?` (MySQL / JDBC),
  // numbered `$1`, `$2`, ... (PostgreSQL), and named `:name` (Oracle / SQLite /
  // some SQLAlchemy dialects). Drivers phrase the resulting syntax error in
  // many different ways — Snowflake says "unexpected ?", PostgreSQL says
  // `syntax error at or near "$1"`, Oracle says `ORA-00911: invalid character`,
  // etc. Rather than enumerate every phrasing, detect a bind-token next to a
  // syntax-error keyword and translate them all to the same guidance.
  const isSyntaxError = /syntax error|invalid character|unexpected token/i.test(msg)
  // Match a bind token that is delimited by whitespace, start/end, or a quote.
  // The negative lookbehind `(?<!\w)` prevents matching `$1` inside identifiers.
  const containsBindToken =
    /(?<!\w)\?(?!\w)/.test(msg) ||
    /(?<!\w)\$\d+/.test(msg) ||
    /(?<!\w):[a-zA-Z_]\w*/.test(msg)
  // PostgreSQL surfaces bind-param issues with its own distinctive phrasing.
  const isPgBindError = /there is no parameter \$\d+/i.test(msg)
  if ((isSyntaxError && containsBindToken) || isPgBindError) {
    return "SQL compilation error: the query contains an unsubstituted bind placeholder (`?`, `$1`, or `:name`). sql_explain does not support parameterized queries — inline the literal values before calling."
  }

  // Snowflake-specific: ANALYZE not supported.
  if (/EXPLAIN\s+ANALYZE/i.test(msg) && /not\s+supported/i.test(msg)) {
    return "This warehouse does not support EXPLAIN ANALYZE. Retry with analyze=false to get a plan-only EXPLAIN."
  }

  // Permission denials.
  if (/permission\s+denied/i.test(msg) || /access\s+denied/i.test(msg) || /insufficient\s+privilege/i.test(msg)) {
    return `The warehouse user lacks permission to EXPLAIN this query. Check role grants for the objects referenced in the SQL. Original error: ${msg}`
  }

  // Generic SQL compilation error fallback.
  if (/SQL compilation error/i.test(msg) || /syntax error/i.test(msg)) {
    return `SQL compilation error in the query passed to sql_explain. Fix the SQL and retry. Original error: ${msg}`
  }

  // Fall through: return the original but with a hint to aid debugging.
  return msg
}

/** Register all connection-related handlers. Exported for test re-registration. */
export function registerAll(): void {

// --- sql.execute ---
register("sql.execute", async (params: SqlExecuteParams): Promise<SqlExecuteResult> => {
  const startTime = Date.now()
  const warehouseType = getWarehouseType(params.warehouse)
  try {
    // Strategy: try dbt adapter first (if in a dbt project), then fall back to native driver.
    // dbt knows how to connect using profiles.yml — no separate connection config needed.
    if (!params.warehouse) {
      const dbtResult = await tryExecuteViaDbt(params.sql, params.limit)
      if (dbtResult) return dbtResult
    }

    const warehouseName = params.warehouse
    let result: SqlExecuteResult
    if (!warehouseName) {
      const warehouses = Registry.list().warehouses
      if (warehouses.length === 0) {
        throw new Error(
          "No warehouse configured. Use warehouse.add, set ALTIMATE_CODE_CONN_* env vars, or configure a dbt profile.",
        )
      }
      // Use the first warehouse as default
      const connector = await Registry.get(warehouses[0].name)
      result = await connector.execute(params.sql, params.limit)
    } else {
      const connector = await Registry.get(warehouseName)
      result = await connector.execute(params.sql, params.limit)
    }
    try {
      Telemetry.track({
        type: "warehouse_query",
        timestamp: Date.now(),
        session_id: Telemetry.getContext().sessionId,
        warehouse_type: warehouseType,
        query_type: detectQueryType(params.sql),
        success: true,
        duration_ms: Date.now() - startTime,
        row_count: result.row_count,
        truncated: result.truncated,
      })
    } catch {}
    return result
  } catch (e) {
    const errorMsg = String(e)
    const maskedErrorMsg = Telemetry.maskString(errorMsg).slice(0, 500)
    try {
      Telemetry.track({
        type: "warehouse_query",
        timestamp: Date.now(),
        session_id: Telemetry.getContext().sessionId,
        warehouse_type: warehouseType,
        query_type: detectQueryType(params.sql),
        success: false,
        duration_ms: Date.now() - startTime,
        row_count: 0,
        truncated: false,
        error: maskedErrorMsg,
        error_category: categorizeQueryError(e),
      })
      Telemetry.track({
        type: "sql_execute_failure",
        timestamp: Date.now(),
        session_id: Telemetry.getContext().sessionId,
        warehouse_type: warehouseType,
        query_type: detectQueryType(params.sql),
        error_message: maskedErrorMsg,
        masked_sql: Telemetry.maskString(params.sql).slice(0, 2000),
        duration_ms: Date.now() - startTime,
      })
    } catch {}
    return { columns: [], rows: [], row_count: 0, truncated: false, error: errorMsg } as SqlExecuteResult & { error: string }
  }
})

// --- sql.explain ---
register("sql.explain", async (params: SqlExplainParams): Promise<SqlExplainResult> => {
  let warehouseName: string | undefined
  let warehouseType: string | undefined
  try {
    warehouseName = params.warehouse
    let connector

    if (warehouseName) {
      connector = await Registry.get(warehouseName)
      warehouseType = Registry.getConfig(warehouseName)?.type
    } else {
      const warehouses = Registry.list().warehouses
      if (warehouses.length === 0) {
        throw new Error("No warehouse configured.")
      }
      connector = await Registry.get(warehouses[0].name)
      warehouseType = warehouses[0].type
      warehouseName = warehouses[0].name
    }

    const plan = buildExplainPlan(warehouseType, params.analyze ?? false)
    if (plan.prefix === "") {
      // Warehouse does not support EXPLAIN via a simple statement prefix —
      // return a clear error rather than sending a bare statement to the
      // driver. BigQuery needs a dry-run job, SQL Server needs SHOWPLAN_TEXT,
      // Oracle needs DBMS_XPLAN, etc.
      return {
        success: false,
        plan_rows: [],
        error: `sql_explain is not supported for warehouse type ${JSON.stringify(warehouseType)}. ${explainAlternative(warehouseType)}`,
        warehouse_type: warehouseType,
        analyzed: false,
      }
    }

    const result = await connector.execute(`${plan.prefix} ${params.sql}`, 10000)

    const planText = result.rows.map((r) => String(r[0])).join("\n")
    const planRows = result.rows.map((r, i) => ({
      line: i + 1,
      text: String(r[0]),
    }))

    return {
      success: true,
      plan_text: planText,
      plan_rows: planRows,
      warehouse_type: warehouseType,
      // Reflect the true mode: if Snowflake silently downgraded ANALYZE to a
      // plan-only EXPLAIN, the caller should know the plan is estimated, not
      // observed.
      analyzed: plan.actuallyAnalyzed,
    }
  } catch (e) {
    const available = Registry.list().warehouses.map((w) => w.name)
    return {
      success: false,
      plan_rows: [],
      error: translateExplainError(e, warehouseName, available),
      warehouse_type: warehouseType,
      analyzed: params.analyze ?? false,
    }
  }
})

// --- sql.autocomplete ---
// Deferred to bridge for now (complex, depends on schema cache)
// Not registering native handler — will fall through to bridge

// --- warehouse.list ---
register("warehouse.list", async (): Promise<WarehouseListResult> => {
  return Registry.list()
})

// --- warehouse.test ---
register("warehouse.test", async (params: WarehouseTestParams): Promise<WarehouseTestResult> => {
  return Registry.test(params.name)
})

// --- warehouse.add ---
register("warehouse.add", async (params: WarehouseAddParams): Promise<WarehouseAddResult> => {
  const config = params.config as ConnectionConfig
  if (!config.type) {
    return {
      success: false,
      name: params.name,
      type: "unknown",
      error: "Config must include a 'type' field (e.g., postgres, snowflake, bigquery).",
    }
  }
  return Registry.add(params.name, config)
})

// --- warehouse.remove ---
register("warehouse.remove", async (params: WarehouseRemoveParams): Promise<WarehouseRemoveResult> => {
  return Registry.remove(params.name)
})

// --- warehouse.discover ---
register("warehouse.discover", async (): Promise<WarehouseDiscoverResult> => {
  try {
    const containers = await discoverContainers()
    try {
      Telemetry.track({
        type: "warehouse_discovery",
        timestamp: Date.now(),
        session_id: Telemetry.getContext().sessionId,
        source: "docker",
        connections_found: containers.length,
        warehouse_types: [...new Set(containers.map((c) => c.db_type))],
      })
    } catch {}
    return {
      containers,
      container_count: containers.length,
    }
  } catch (e) {
    return {
      containers: [],
      container_count: 0,
      error: String(e),
    }
  }
})

// --- schema.inspect ---
register("schema.inspect", async (params: SchemaInspectParams): Promise<SchemaInspectResult> => {
  try {
    const warehouseName = params.warehouse
    let connector

    if (warehouseName) {
      connector = await Registry.get(warehouseName)
    } else {
      const warehouses = Registry.list().warehouses
      if (warehouses.length === 0) {
        throw new Error("No warehouse configured.")
      }
      connector = await Registry.get(warehouses[0].name)
    }

    const schemaName = params.schema_name ?? "public"
    // NOTE: params.database is accepted in the type contract but the current
    // Connector.describeTable signature only supports (schema, table). Wiring
    // database through to each driver is a separate refactor. For connections
    // that already scope to a single database (the common case), this is a no-op.
    const columns = await connector.describeTable(schemaName, params.table)

    return {
      table: params.table,
      schema_name: schemaName,
      columns: columns.map((c) => ({
        name: c.name,
        data_type: c.data_type,
        nullable: c.nullable,
        primary_key: false, // would need additional query for PK detection
      })),
    }
  } catch (e) {
    return {
      table: params.table,
      schema_name: params.schema_name ?? "public",
      columns: [],
      error: String(e),
    } as SchemaInspectResult & { error: string }
  }
})

// --- dbt.profiles ---
register("dbt.profiles", async (params: DbtProfilesParams): Promise<DbtProfilesResult> => {
  try {
    const connections = await parseDbtProfiles(params.path, params.projectDir)
    return {
      success: true,
      connections,
      connection_count: connections.length,
    }
  } catch (e) {
    return {
      success: false,
      connections: [],
      connection_count: 0,
      error: String(e),
    }
  }
})

} // end registerAll

// Auto-register on module load
registerAll()
