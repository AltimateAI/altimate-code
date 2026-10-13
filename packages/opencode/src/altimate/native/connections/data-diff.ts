/**
 * DataParity orchestrator — runs the cooperative Rust state machine against
 * live database connections.
 *
 * The Rust engine (DataParitySession) never touches databases — it emits SQL
 * for us to execute, we feed results back, and it decides the next step.
 * This file is the bridge between that engine and altimate-code's drivers.
 */

import type { DataDiffParams, DataDiffResult, PartitionDiffResult } from "../types"
import * as Registry from "./registry"

// ---------------------------------------------------------------------------
// Dialect mapping — bridge warehouse config types to Rust SqlDialect serde names
// ---------------------------------------------------------------------------

/** Map warehouse config types to Rust SqlDialect serde names. */
const WAREHOUSE_TO_DIALECT: Record<string, string> = {
  sqlserver: "tsql",
  mssql: "tsql",
  fabric: "fabric",
  postgresql: "postgres",
  mariadb: "mysql",
}

/** Convert a warehouse config type to the Rust-compatible SqlDialect name. */
export function warehouseTypeToDialect(warehouseType: string): string {
  return WAREHOUSE_TO_DIALECT[warehouseType.toLowerCase()] ?? warehouseType.toLowerCase()
}

// ---------------------------------------------------------------------------
// Dialect-aware identifier quoting
// ---------------------------------------------------------------------------

/**
 * Quote a SQL identifier using the correct delimiter for the dialect.
 * Used both for partition column/value quoting and for plain-table-name
 * wrapping inside CTEs (via `resolveTableSources`).
 */
function quoteIdentForDialect(identifier: string, dialect: string): string {
  switch (dialect) {
    case "mysql":
    case "mariadb":
    case "clickhouse":
      return `\`${identifier.replace(/`/g, "``")}\``
    case "tsql":
    case "fabric":
    case "sqlserver":
    case "mssql":
      return `[${identifier.replace(/\]/g, "]]")}]`
    default:
      // ANSI SQL: Postgres, Snowflake, BigQuery, DuckDB, Oracle, Redshift, etc.
      return `"${identifier.replace(/"/g, '""')}"`
  }
}

// ---------------------------------------------------------------------------
// Query-source detection
// ---------------------------------------------------------------------------

const SQL_KEYWORDS = /^\s*(SELECT|WITH|VALUES)\b/i

/**
 * Detect whether a string is an arbitrary SQL query (vs a plain table name).
 *
 * A SQL query starts with a keyword AND contains whitespace (e.g., "SELECT * FROM ...").
 * A plain table name — even one named "select" or "with" — is a single token without
 * internal whitespace (possibly dot-separated like schema.table or db.schema.table).
 *
 * The \b in SQL_KEYWORDS already prevents matching "with_metadata" or "select_results",
 * but the whitespace check additionally handles bare keyword table names like "select".
 */
function isQuery(input: string): boolean {
  const trimmed = input.trim()
  return SQL_KEYWORDS.test(trimmed) && /\s/.test(trimmed)
}

/**
 * If either source or target is an arbitrary query, wrap them in CTEs so the
 * DataParity engine can treat them as tables named `__diff_source` / `__diff_target`.
 *
 * Returns both a combined prefix (used for same-warehouse tasks where a JOIN
 * might reference both CTEs) and side-specific prefixes (used for cross-warehouse
 * tasks where each warehouse only has access to its own base tables).
 *
 * **Why side-specific prefixes matter:** T-SQL / Fabric parse-bind every CTE body
 * at parse time, even unreferenced ones. Sending a combined `WITH __diff_source
 * AS (... FROM mssql_only_table), __diff_target AS (... FROM fabric_only_table)`
 * to MSSQL fails because MSSQL can't resolve the Fabric-only table referenced in
 * the unused `__diff_target` CTE.
 *
 * Callers must prepend the appropriate prefix to every SQL task emitted by the
 * engine before execution.
 */
export function resolveTableSources(
  source: string,
  target: string,
  sourceDialect?: string,
  targetDialect?: string,
): {
  table1Name: string
  table2Name: string
  ctePrefix: string | null
  sourceCtePrefix: string | null
  targetCtePrefix: string | null
} {
  const source_is_query = isQuery(source)
  const target_is_query = isQuery(target)

  if (!source_is_query && !target_is_query) {
    // Both are plain table names — pass through unchanged
    return {
      table1Name: source,
      table2Name: target,
      ctePrefix: null,
      sourceCtePrefix: null,
      targetCtePrefix: null,
    }
  }

  // At least one is a query — wrap both in CTEs. Quote plain-table names with
  // the *side's own* dialect so T-SQL / Fabric get `[schema].[table]` and
  // ANSI dialects get `"schema"."table"` — avoids `QUOTED_IDENTIFIER OFF`
  // surprises on MSSQL/Fabric. Fallback to ANSI when dialect is unspecified.
  const quoteTableRef = (name: string, dialect: string | undefined): string => {
    const d = dialect ?? "generic"
    return name.split(".").map((p) => quoteIdentForDialect(p, d)).join(".")
  }
  const srcExpr = source_is_query ? source : `SELECT * FROM ${quoteTableRef(source, sourceDialect)}`
  const tgtExpr = target_is_query ? target : `SELECT * FROM ${quoteTableRef(target, targetDialect)}`

  const sourceCtePrefix = `WITH __diff_source AS (\n${srcExpr}\n)`
  const targetCtePrefix = `WITH __diff_target AS (\n${tgtExpr}\n)`
  const ctePrefix = `WITH __diff_source AS (\n${srcExpr}\n), __diff_target AS (\n${tgtExpr}\n)`
  return {
    table1Name: "__diff_source",
    table2Name: "__diff_target",
    ctePrefix,
    sourceCtePrefix,
    targetCtePrefix,
  }
}

/**
 * Inject a CTE prefix into a SQL statement from the engine.
 *
 * The engine emits standalone SELECT statements. We need to prepend our CTE
 * definitions so `__diff_source`/`__diff_target` resolve correctly.
 *
 * Handles the case where the engine itself emits CTEs (starts with WITH …):
 *   WITH engine_cte AS (…) SELECT … FROM __diff_source
 * becomes:
 *   WITH __diff_source AS (…), __diff_target AS (…), engine_cte AS (…) SELECT …
 */
export function injectCte(sql: string, ctePrefix: string): string {
  const trimmed = sql.trimStart()
  const withMatch = trimmed.match(/^WITH\s+/i)

  if (withMatch) {
    // Engine also has CTEs — merge them: our CTEs first, then engine CTEs
    const afterWith = trimmed.slice(withMatch[0].length)
    // ctePrefix already starts with "WITH …" — strip "WITH " and append ", "
    const ourDefs = ctePrefix.replace(/^WITH\s+/i, "")
    return `WITH ${ourDefs},\n${afterWith}`
  }

  // Plain SELECT — just prepend our CTE block
  return `${ctePrefix}\n${trimmed}`
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

type Rows = (string | null)[][]

/**
 * Execute a SQL statement against a named warehouse and return rows as string[][].
 */
async function executeQuery(sql: string, warehouseName: string | undefined): Promise<Rows> {
  let connector
  if (warehouseName) {
    connector = await Registry.get(warehouseName)
  } else {
    const warehouses = Registry.list().warehouses
    if (warehouses.length === 0) {
      throw new Error("No default warehouse configured.")
    }
    warehouseName = warehouses[0].name
    connector = await Registry.get(warehouseName)
  }

  // Bypass the driver's default LIMIT — data-diff needs complete result sets.
  const result = await connector.execute(sql, undefined, undefined, {
    noLimit: true,
    ...(Registry.canonicalType(Registry.getConfig(warehouseName)?.type) === "postgres" ? { readOnly: true } : {}),
  })

  // Normalise to string[][] — drivers return mixed types
  return result.rows.map((row: unknown[]) =>
    row.map((v) => (v === null || v === undefined ? null : String(v))),
  )
}

// ---------------------------------------------------------------------------
// Column auto-discovery and audit column exclusion
// ---------------------------------------------------------------------------

/**
 * Patterns that match audit/timestamp columns which should be excluded from
 * value comparison by default. These columns typically differ between source
 * and target due to ETL timing, sync metadata, or pipeline bookkeeping —
 * not because of actual data discrepancies.
 */
const AUDIT_COLUMN_PATTERNS = [
  // Exact common names
  /^(created|updated|modified|inserted|deleted|synced|published|ingested|loaded|extracted|refreshed)_(at|on|date|time|timestamp|ts|dt|epoch)$/i,
  // Suffix patterns: *_at, *_on with temporal prefix
  /_(created|updated|modified|inserted|deleted|synced|published|ingested|loaded|extracted|refreshed)$/i,
  // ETL metadata columns
  /^(etl|elt|dbt|pipeline|batch|sync|publish|ingest)_(created|updated|modified|loaded|run|timestamp|ts|time|at|epoch)/i,
  /^(_sdc_|_airbyte_|_fivetran_|_stitch_|__hevo_)/i,
  // Generic timestamp metadata
  /^(last_updated|last_modified|date_updated|date_modified|date_created|row_updated|row_created)$/i,
  /^(publisher_last_updated|publisher_updated)/i,
  // Epoch variants
  /(updated|modified|created|inserted|published|loaded|synced)_epoch/i,
  /epoch_ms$/i,
]

/**
 * Check whether a column name matches known audit/timestamp patterns.
 */
function isAuditColumn(columnName: string): boolean {
  return AUDIT_COLUMN_PATTERNS.some((pattern) => pattern.test(columnName))
}

// ---------------------------------------------------------------------------
// Auto-timestamp default detection (schema-level)
// ---------------------------------------------------------------------------

/**
 * Patterns that detect auto-generated timestamp/date defaults in column_default
 * expressions. These functions produce the current time when a row is inserted
 * (or updated), meaning the column value will inherently differ between source
 * and target — not because of actual data discrepancies, but because of when
 * each copy was written.
 *
 * Covers: PostgreSQL, MySQL/MariaDB, Snowflake, SQL Server, Oracle,
 *         ClickHouse, DuckDB, SQLite, Redshift, BigQuery, Databricks.
 */
const AUTO_TIMESTAMP_DEFAULT_PATTERNS = [
  // PostgreSQL, DuckDB, Redshift
  /\bnow\s*\(\)/i,
  /\bclock_timestamp\s*\(\)/i,
  /\bstatement_timestamp\s*\(\)/i,
  /\btransaction_timestamp\s*\(\)/i,
  /\blocaltimestamp\b/i,
  // Standard SQL — used by most dialects
  /\bcurrent_timestamp\b/i,
  // MySQL / MariaDB — "ON UPDATE CURRENT_TIMESTAMP" in the EXTRA column
  /\bon\s+update\s+current_timestamp/i,
  // Snowflake
  /\bsysdate\s*\(\)/i,
  // SQL Server
  /\bgetdate\s*\(\)/i,
  /\bsysdatetime\s*\(\)/i,
  /\bsysutcdatetime\s*\(\)/i,
  /\bsysdatetimeoffset\s*\(\)/i,
  // Oracle
  /\bSYSDATE\b/i,
  /\bSYSTIMESTAMP\b/i,
  // ClickHouse
  /\btoday\s*\(\)/i,
  // SQLite
  /\bdatetime\s*\(\s*'now'/i,
]

/**
 * Check whether a column_default expression contains an auto-generating
 * timestamp function. Also matches expressions that *contain* these functions
 * (e.g. `(now() + '1 mon'::interval)`).
 */
function isAutoTimestampDefault(defaultExpr: string | null): boolean {
  if (!defaultExpr) return false
  return AUTO_TIMESTAMP_DEFAULT_PATTERNS.some((pattern) => pattern.test(defaultExpr))
}

// ---------------------------------------------------------------------------
// Column discovery (names + defaults) — dialect-aware
// ---------------------------------------------------------------------------

interface ColumnInfo {
  name: string
  defaultExpr: string | null
}

/**
 * Build a query to discover column names and default expressions for a table.
 * Returns both pieces of information in a single round-trip so we can detect
 * auto-timestamp defaults without an extra query.
 */
function buildColumnDiscoverySQL(tableName: string, dialect: string): string {
  // Escape single quotes for safe interpolation into SQL string literals.
  const esc = (s: string) => s.replace(/'/g, "''")

  // Parse schema.table or db.schema.table
  const parts = tableName.split(".")
  let schemaFilter = ""
  let tableFilter = ""

  if (parts.length === 3) {
    schemaFilter = `table_schema = '${esc(parts[1])}'`
    tableFilter = `table_name = '${esc(parts[2])}'`
  } else if (parts.length === 2) {
    schemaFilter = `table_schema = '${esc(parts[0])}'`
    tableFilter = `table_name = '${esc(parts[1])}'`
  } else {
    tableFilter = `table_name = '${esc(parts[0])}'`
  }

  // Validate table name for dialects that can't use parameterized identifiers.
  // Reject anything that doesn't look like a safe identifier (alphanumeric, dots, underscores).
  const SAFE_TABLE_NAME = /^[a-zA-Z0-9_.]+$/

  switch (dialect) {
    case "clickhouse": {
      // DESCRIBE TABLE interpolates directly — validate to prevent injection
      if (!SAFE_TABLE_NAME.test(tableName)) {
        throw new Error(`Unsafe table name for ClickHouse DESCRIBE: ${tableName}`)
      }
      // Quote each part with backticks for ClickHouse
      const chQuoted = tableName.split(".").map((p) => `\`${p.replace(/`/g, "``")}\``).join(".")
      // Returns: name, type, default_type, default_expression, ...
      return `DESCRIBE TABLE ${chQuoted}`
    }
    case "snowflake": {
      // SHOW COLUMNS interpolates directly — validate to prevent injection
      if (!SAFE_TABLE_NAME.test(tableName)) {
        throw new Error(`Unsafe table name for Snowflake SHOW COLUMNS: ${tableName}`)
      }
      // Quote each part with double-quotes for Snowflake
      const sfQuoted = tableName.split(".").map((p) => `"${p.replace(/"/g, '""')}"`).join(".")
      // Returns: table_name, schema_name, column_name, data_type, null?, default, ...
      return `SHOW COLUMNS IN TABLE ${sfQuoted}`
    }
    case "mysql":
    case "mariadb": {
      // MySQL puts "on update CURRENT_TIMESTAMP" in the EXTRA column, not column_default
      const conditions = [tableFilter]
      if (schemaFilter) conditions.push(schemaFilter)
      return `SELECT column_name, column_default, extra FROM information_schema.columns WHERE ${conditions.join(" AND ")} ORDER BY ordinal_position`
    }
    case "oracle": {
      // Oracle uses ALL_TAB_COLUMNS (no information_schema)
      const oracleTable = esc(parts[parts.length - 1])
      const conditions = [`TABLE_NAME = '${oracleTable.toUpperCase()}'`]
      if (parts.length >= 2) {
        conditions.push(`OWNER = '${esc(parts[parts.length - 2]).toUpperCase()}'`)
      }
      return `SELECT COLUMN_NAME, DATA_DEFAULT FROM ALL_TAB_COLUMNS WHERE ${conditions.join(" AND ")} ORDER BY COLUMN_ID`
    }
    case "sqlite": {
      // PRAGMA table_info returns: cid, name, type, notnull, dflt_value, pk
      const table = esc(parts[parts.length - 1])
      return `PRAGMA table_info('${table}')`
    }
    default: {
      // Postgres, Redshift, DuckDB, SQL Server, BigQuery, Databricks, etc.
      const conditions = [tableFilter]
      if (schemaFilter) conditions.push(schemaFilter)
      return `SELECT column_name, column_default FROM information_schema.columns WHERE ${conditions.join(" AND ")} ORDER BY ordinal_position`
    }
  }
}

/**
 * Parse column info (name + default expression) from the discovery query result,
 * handling dialect-specific output formats.
 */
function parseColumnInfo(rows: (string | null)[][], dialect: string): ColumnInfo[] {
  switch (dialect) {
    case "clickhouse":
      // DESCRIBE: name[0], type[1], default_type[2], default_expression[3], ...
      return rows.map((r) => ({
        name: r[0] ?? "",
        defaultExpr: r[3] ?? null,
      })).filter((c) => c.name)
    case "snowflake":
      // SHOW COLUMNS: table_name[0], schema_name[1], column_name[2], data_type[3], null?[4], default[5], ...
      return rows.map((r) => ({
        name: r[2] ?? "",
        defaultExpr: r[5] ?? null,
      })).filter((c) => c.name)
    case "oracle":
      // ALL_TAB_COLUMNS: COLUMN_NAME[0], DATA_DEFAULT[1]
      return rows.map((r) => ({
        name: r[0] ?? "",
        defaultExpr: r[1] ?? null,
      })).filter((c) => c.name)
    case "sqlite":
      // PRAGMA table_info: cid[0], name[1], type[2], notnull[3], dflt_value[4], pk[5]
      return rows.map((r) => ({
        name: r[1] ?? "",
        defaultExpr: r[4] ?? null,
      })).filter((c) => c.name)
    case "mysql":
    case "mariadb":
      // column_name[0], column_default[1], extra[2]
      // Merge default + extra — MySQL puts "on update CURRENT_TIMESTAMP" in extra
      return rows.map((r) => ({
        name: r[0] ?? "",
        defaultExpr: [r[1], r[2]].filter(Boolean).join(" ") || null,
      })).filter((c) => c.name)
    default:
      // Postgres, Redshift, DuckDB, SQL Server, BigQuery: column_name[0], column_default[1]
      return rows.map((r) => ({
        name: r[0] ?? "",
        defaultExpr: r[1] ?? null,
      })).filter((c) => c.name)
  }
}

/**
 * Auto-discover non-key, non-audit columns for a table.
 *
 * When the caller omits `extra_columns`, we query the source table's schema to
 * find all columns, then exclude:
 *   1. Key columns (already used for matching)
 *   2. Audit/timestamp columns matched by name pattern (updated_at, created_at, etc.)
 *   3. Columns with auto-generating timestamp defaults (DEFAULT NOW(), CURRENT_TIMESTAMP,
 *      GETDATE(), SYSDATE, etc.) — detected from the database catalog
 *
 * The schema-level default detection (layer 3) catches columns that don't follow
 * naming conventions but still auto-generate values on INSERT — these inherently
 * differ between source and target due to when each copy was written.
 *
 * Returns the list of columns to compare, or undefined if discovery fails
 * (in which case the engine falls back to key-only comparison).
 */
async function discoverExtraColumns(
  tableName: string,
  keyColumns: string[],
  dialect: string,
  warehouseName: string | undefined,
): Promise<{ columns: string[]; excludedAudit: string[] } | undefined> {
  // Only works for plain table names, not SQL queries
  if (SQL_KEYWORDS.test(tableName)) return undefined

  try {
    const sql = buildColumnDiscoverySQL(tableName, dialect)
    const rows = await executeQuery(sql, warehouseName)
    const columnInfos = parseColumnInfo(rows, dialect)

    if (columnInfos.length === 0) return undefined

    const keySet = new Set(keyColumns.map((k) => k.toLowerCase()))
    const extraColumns: string[] = []
    const excludedAudit: string[] = []

    for (const col of columnInfos) {
      if (keySet.has(col.name.toLowerCase())) continue
      if (isAuditColumn(col.name) || isAutoTimestampDefault(col.defaultExpr)) {
        excludedAudit.push(col.name)
      } else {
        extraColumns.push(col.name)
      }
    }

    return { columns: extraColumns, excludedAudit }
  } catch {
    // Schema discovery failed — fall back to engine default (key-only)
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

const MAX_STEPS = 200

// ---------------------------------------------------------------------------
// Partition support
// ---------------------------------------------------------------------------

/**
 * Build a DATE_TRUNC expression appropriate for the warehouse dialect.
 *
 * Exported for targeted unit testing; not part of the stable public API.
 */
export function dateTruncExpr(granularity: string, column: string, dialect: string): string {
  const g = granularity.toLowerCase()
  switch (dialect) {
    case "bigquery":
      return `DATE_TRUNC(${column}, ${g.toUpperCase()})`
    case "clickhouse":
      return `toStartOf${g.charAt(0).toUpperCase() + g.slice(1)}(${column})`
    case "mysql":
    case "mariadb": {
      const fmt = { day: "%Y-%m-%d", week: "%Y-%u", month: "%Y-%m-01", year: "%Y-01-01" }[g] ?? "%Y-%m-01"
      return `DATE_FORMAT(${column}, '${fmt}')`
    }
    case "oracle": {
      // Oracle uses TRUNC() with format models — 'WEEK' is invalid, use 'IW' for ISO week
      const oracleFmt: Record<string, string> = {
        day: "DD",
        week: "IW",
        month: "MM",
        year: "YYYY",
        quarter: "Q",
        hour: "HH",
        minute: "MI",
      }
      return `TRUNC(${column}, '${oracleFmt[g] ?? g.toUpperCase()}')`
    }
    case "sqlserver":
    case "mssql":
    case "tsql":
    case "fabric":
      // SQL Server 2022+ / Fabric: DATETRUNC expects unquoted datepart keyword
      return `DATETRUNC(${g.toUpperCase()}, ${column})`
    default:
      // Postgres, Snowflake, Redshift, DuckDB, etc.
      return `DATE_TRUNC('${g}', ${column})`
  }
}

/**
 * Determine the partition mode based on which params are provided.
 * - "date"        → partition_granularity is set (or column looks like a date)
 * - "numeric"     → partition_bucket_size is set
 * - "categorical" → neither — use DISTINCT values directly (string, enum, boolean)
 */
function partitionMode(
  granularity: string | undefined,
  bucketSize: number | undefined,
): "date" | "numeric" | "categorical" {
  if (bucketSize != null) return "numeric"
  if (granularity != null) return "date"
  return "categorical"
}

/**
 * Build SQL to discover distinct partition values from the source table.
 */
function buildPartitionDiscoverySQL(
  table: string,
  partitionColumn: string,
  granularity: string | undefined,
  bucketSize: number | undefined,
  dialect: string,
  whereClause?: string,
): string {
  const where = whereClause ? `WHERE ${whereClause}` : ""
  const mode = partitionMode(granularity, bucketSize)
  const quotedCol = quoteIdentForDialect(partitionColumn, dialect)

  let expr: string
  if (mode === "numeric") {
    expr = `FLOOR(${quotedCol} / ${bucketSize}) * ${bucketSize}`
  } else if (mode === "date") {
    expr = dateTruncExpr(granularity!, quotedCol, dialect)
  } else {
    // categorical — raw distinct values, no transformation
    expr = quotedCol
  }

  return `SELECT DISTINCT ${expr} AS _p FROM ${table} ${where} ORDER BY _p`
}

/**
 * Build a WHERE clause that scopes to a single partition.
 *
 * Exported for targeted unit testing; not part of the stable public API.
 */
export function buildPartitionWhereClause(
  partitionColumn: string,
  partitionValue: string,
  granularity: string | undefined,
  bucketSize: number | undefined,
  dialect: string,
): string {
  const mode = partitionMode(granularity, bucketSize)
  // Quote the column identifier using dialect-appropriate delimiters
  const quotedCol = quoteIdentForDialect(partitionColumn, dialect)

  if (mode === "numeric") {
    const lo = Number(partitionValue)
    const hi = lo + bucketSize!
    return `${quotedCol} >= ${lo} AND ${quotedCol} < ${hi}`
  }

  if (mode === "categorical") {
    // Quote the value — works for strings, enums, booleans
    const escaped = partitionValue.replace(/'/g, "''")
    return `${quotedCol} = '${escaped}'`
  }

  // date mode
  const expr = dateTruncExpr(granularity!, quotedCol, dialect)
  // Normalize to ISO `yyyy-mm-dd` ONLY for T-SQL / Fabric, which use
  // `CONVERT(DATE, '…', 23)` (strict ISO-8601 parser). The mssql driver
  // returns date columns as JS Date objects that coerce to strings like
  // "Mon Jan 01 2024 00:00:00 GMT+0000 (UTC)" — that format must be parsed
  // to ISO before CONVERT will accept it.
  //
  // For other dialects, pass the value through unchanged. MySQL/MariaDB
  // produce non-ISO `DATE_FORMAT` outputs (e.g. `YYYY-%u` for ISO week,
  // which is `YYYY-42` not `YYYY-MM-DD`), and forcing ISO conversion would
  // corrupt them — the WHERE would never match. Postgres / BigQuery /
  // ClickHouse accept whatever their own `DATE_TRUNC`/`toStartOf*`
  // emits verbatim on the round trip.
  const needsIso = dialect === "tsql" || dialect === "fabric" ||
    dialect === "sqlserver" || dialect === "mssql"
  const normalized = needsIso
    ? (() => {
        const trimmed = partitionValue.trim()
        if (/^\d{4}-\d{2}-\d{2}(\s|T|$)/.test(trimmed)) return trimmed.slice(0, 10)
        const d = new Date(trimmed)
        return Number.isNaN(d.getTime()) ? trimmed : d.toISOString().slice(0, 10)
      })()
    : partitionValue
  const escaped = normalized.replace(/'/g, "''")

  // Cast the literal appropriately per dialect
  switch (dialect) {
    case "bigquery":
      return `${expr} = '${escaped}'`
    case "clickhouse":
      return `${expr} = toDate('${escaped}')`
    case "mysql":
    case "mariadb":
      return `${expr} = '${escaped}'`
    case "sqlserver":
    case "mssql":
    case "tsql":
    case "fabric":
      // Style 23 = ISO-8601 (yyyy-mm-dd), locale-safe
      return `${expr} = CONVERT(DATE, '${escaped}', 23)`
    default:
      return `${expr} = '${escaped}'`
  }
}

/**
 * Extract DiffStats from a successful outcome (if present).
 *
 * Rust serializes ReladiffOutcome as: {mode: "diff", diff_rows: [...], stats: {...}}
 * stats fields: rows_table1, rows_table2, exclusive_table1, exclusive_table2, updated, unchanged
 */
function extractStats(outcome: unknown): {
  rows_source: number
  rows_target: number
  differences: number
  status: "identical" | "differ"
} {
  const o = outcome as any
  if (!o) return { rows_source: 0, rows_target: 0, differences: 0, status: "identical" }

  if (o.mode === "diff") {
    const s = o.stats ?? {}
    const exclusive1 = Number(s.exclusive_table1 ?? 0)
    const exclusive2 = Number(s.exclusive_table2 ?? 0)
    const updated = Number(s.updated ?? 0)
    const differences = exclusive1 + exclusive2 + updated
    return {
      rows_source: Number(s.rows_table1 ?? 0),
      rows_target: Number(s.rows_table2 ?? 0),
      differences,
      status: differences > 0 ? "differ" : "identical",
    }
  }

  return { rows_source: 0, rows_target: 0, differences: 0, status: "identical" }
}

/**
 * Merge two diff outcomes into one aggregated outcome.
 *
 * Both outcomes use the Rust shape: {mode: "diff", diff_rows: [...], stats: {...}}
 */
function mergeOutcomes(accumulated: unknown, next: unknown): unknown {
  if (!accumulated) return next
  if (!next) return accumulated

  const a = accumulated as any
  const n = next as any

  const aS = a.stats ?? {}
  const nS = n.stats ?? {}

  const rows_table1 = (Number(aS.rows_table1) || 0) + (Number(nS.rows_table1) || 0)
  const rows_table2 = (Number(aS.rows_table2) || 0) + (Number(nS.rows_table2) || 0)
  const exclusive_table1 = (Number(aS.exclusive_table1) || 0) + (Number(nS.exclusive_table1) || 0)
  const exclusive_table2 = (Number(aS.exclusive_table2) || 0) + (Number(nS.exclusive_table2) || 0)
  const updated = (Number(aS.updated) || 0) + (Number(nS.updated) || 0)
  const unchanged = (Number(aS.unchanged) || 0) + (Number(nS.unchanged) || 0)

  const totalRows = rows_table1 + rows_table2
  const totalDiff = exclusive_table1 + exclusive_table2 + updated
  const diff_percent = totalRows > 0 ? (totalDiff / totalRows) * 100 : 0

  return {
    mode: "diff",
    diff_rows: [...(a.diff_rows ?? []), ...(n.diff_rows ?? [])].slice(0, 100),
    stats: { rows_table1, rows_table2, exclusive_table1, exclusive_table2, updated, unchanged, diff_percent },
  }
}

/**
 * Run a partitioned diff: discover partition values, diff each partition independently,
 * then aggregate results.
 */
async function runPartitionedDiff(params: DataDiffParams): Promise<DataDiffResult> {
  // Partitioned diff requires table names — can't partition a SQL query by column
  if (isQuery(params.source) || isQuery(params.target)) {
    return {
      success: false,
      error: "partition_column cannot be used when source or target is a SQL query. Use table names instead, or remove partition_column.",
      steps: 0,
    }
  }

  const resolveDialect = (warehouse: string | undefined): string => {
    if (warehouse) {
      const cfg = Registry.getConfig(warehouse)
      return warehouseTypeToDialect(cfg?.type ?? "generic")
    }
    const warehouses = Registry.list().warehouses
    return warehouseTypeToDialect(warehouses[0]?.type ?? "generic")
  }

  const sourceDialect = resolveDialect(params.source_warehouse)
  const targetDialect = resolveDialect(params.target_warehouse ?? params.source_warehouse)
  const { table1Name, table2Name } = resolveTableSources(
    params.source,
    params.target,
    sourceDialect,
    targetDialect,
  )

  // Discover partition values from BOTH source and target to catch target-only partitions.
  // Without this, rows that exist only in target partitions are silently missed.
  const sourceDiscoverySql = buildPartitionDiscoverySQL(
    table1Name,
    params.partition_column!,
    params.partition_granularity,
    params.partition_bucket_size,
    sourceDialect,
    params.where_clause,
  )
  const targetDiscoverySql = buildPartitionDiscoverySQL(
    table2Name,
    params.partition_column!,
    params.partition_granularity,
    params.partition_bucket_size,
    targetDialect,
    params.where_clause,
  )

  let partitionValues: string[]
  try {
    const [sourceRows, targetRows] = await Promise.all([
      executeQuery(sourceDiscoverySql, params.source_warehouse),
      executeQuery(targetDiscoverySql, params.target_warehouse ?? params.source_warehouse),
    ])
    // Union partition values from both sides, deduplicated
    const allValues = new Set<string>()
    for (const r of sourceRows) {
      const v = r[0]
      if (v != null) allValues.add(String(v))
    }
    for (const r of targetRows) {
      const v = r[0]
      if (v != null) allValues.add(String(v))
    }
    partitionValues = [...allValues].sort()
  } catch (e) {
    return { success: false, error: `Partition discovery failed: ${e}`, steps: 0 }
  }

  if (partitionValues.length === 0) {
    return {
      success: true, steps: 1, partition_results: [],
      outcome: { mode: "diff", stats: { rows_table1: 0, rows_table2: 0, exclusive_table1: 0, exclusive_table2: 0, updated: 0, unchanged: 0 }, diff_rows: [] },
    }
  }

  // Auto-discover extra_columns ONCE here on the plain source table — we wrap
  // each partition's source/target as SELECT subqueries below, which
  // `discoverExtraColumns` skips (it only works on plain table names). If we
  // let the recursive `runDataDiff` try, it'd always see a wrapped query and
  // regress to key-only comparison (value-level diffs silently lost).
  let resolvedExtraColumns = params.extra_columns
  let partitionExcludedAudit: string[] = []
  if (!resolvedExtraColumns || resolvedExtraColumns.length === 0) {
    const discovered = await discoverExtraColumns(
      params.source,
      params.key_columns,
      sourceDialect,
      params.source_warehouse,
    )
    if (discovered) {
      resolvedExtraColumns = discovered.columns
      partitionExcludedAudit = discovered.excludedAudit
    }
  }

  // Diff each partition
  const partitionResults: PartitionDiffResult[] = []
  let aggregatedOutcome: unknown = null
  let totalSteps = 1

  // Build dialect-appropriate table expressions once — used for subquery
  // wrapping below. Splitting on "." preserves schema.table / db.schema.table
  // while ensuring each component is quoted in the side's native dialect.
  const quoteTableRefForDialect = (name: string, dialect: string): string =>
    name.split(".").map((p) => quoteIdentForDialect(p, dialect)).join(".")
  const sourceTableRef = quoteTableRefForDialect(params.source, sourceDialect)
  const targetTableRef = quoteTableRefForDialect(params.target, targetDialect)

  for (const pVal of partitionValues) {
    // Build per-side partition WHERE clauses. The dialects can differ
    // (cross-warehouse diff) — the engine applies `where_clause` to both
    // sides identically, so we can't use it to carry dialect-specific syntax.
    // Bake each side's WHERE into its own subquery-wrapped SQL source instead.
    const sourcePartWhere = buildPartitionWhereClause(
      params.partition_column!,
      pVal,
      params.partition_granularity,
      params.partition_bucket_size,
      sourceDialect,
    )
    const targetPartWhere = buildPartitionWhereClause(
      params.partition_column!,
      pVal,
      params.partition_granularity,
      params.partition_bucket_size,
      targetDialect,
    )

    // Wrap each side's table as a SELECT subquery filtered to this partition.
    // The recursive runDataDiff below will detect these as SQL queries and
    // route them through the CTE-injection path, which is already side-aware.
    const sourceSql = `SELECT * FROM ${sourceTableRef} WHERE ${sourcePartWhere}`
    const targetSql = `SELECT * FROM ${targetTableRef} WHERE ${targetPartWhere}`

    const result = await runDataDiff({
      ...params,
      source: sourceSql,
      target: targetSql,
      // Preserve the user's shared where_clause — it's dialect-neutral.
      where_clause: params.where_clause,
      // Pass auto-discovered extras explicitly — `runDataDiff`'s own
      // discovery path would skip these wrapped SELECT subqueries and
      // regress to key-only comparison.
      extra_columns: resolvedExtraColumns,
      partition_column: undefined, // prevent recursion
    })

    totalSteps += result.steps

    if (!result.success) {
      partitionResults.push({ partition: pVal, rows_source: 0, rows_target: 0, differences: 0, status: "error", error: result.error })
      continue
    }

    const stats = extractStats(result.outcome)
    partitionResults.push({ partition: pVal, ...stats })
    aggregatedOutcome = aggregatedOutcome == null ? result.outcome : mergeOutcomes(aggregatedOutcome, result.outcome)
  }

  return {
    success: true,
    steps: totalSteps,
    outcome: aggregatedOutcome ?? { mode: "diff", stats: { rows_table1: 0, rows_table2: 0, exclusive_table1: 0, exclusive_table2: 0, updated: 0, unchanged: 0 }, diff_rows: [] },
    partition_results: partitionResults,
    ...(partitionExcludedAudit.length > 0 ? { excluded_audit_columns: partitionExcludedAudit } : {}),
  }
}

export async function runDataDiff(params: DataDiffParams): Promise<DataDiffResult> {
  // Dispatch to partitioned diff if partition_column is set
  if (params.partition_column) {
    return runPartitionedDiff(params)
  }

  // Resolve warehouse identity (fall back to the default warehouse when the
  // caller omits a side). Returns the canonical warehouse name so we can detect
  // cross-warehouse mode even when both sides share a dialect (e.g. two
  // independent MSSQL instances).
  const resolveWarehouseName = (warehouse: string | undefined): string | undefined => {
    if (warehouse) return warehouse
    const warehouses = Registry.list().warehouses
    return warehouses[0]?.name
  }

  // Resolve dialect from warehouse config
  const resolveDialect = (warehouse: string | undefined): string => {
    if (warehouse) {
      const cfg = Registry.getConfig(warehouse)
      return warehouseTypeToDialect(cfg?.type ?? "generic")
    }
    const warehouses = Registry.list().warehouses
    return warehouseTypeToDialect(warehouses[0]?.type ?? "generic")
  }

  const resolvedSource = resolveWarehouseName(params.source_warehouse)
  const resolvedTarget = resolveWarehouseName(params.target_warehouse ?? params.source_warehouse)

  const dialect1 = resolveDialect(params.source_warehouse)
  const dialect2 = resolveDialect(params.target_warehouse ?? params.source_warehouse)

  // Input-validation guards — run BEFORE the NAPI import so they produce the
  // right error even in environments where `@altimateai/altimate-core` isn't
  // built locally.
  //
  // JoinDiff cannot work across warehouses: it emits one FULL OUTER JOIN task
  // referencing both CTE aliases, but side-aware injection only defines one
  // side per task — the other alias would be unresolved. Guard early so users
  // get a clear error instead of an obscure SQL parse failure.
  const crossWarehousePre = resolvedSource !== resolvedTarget
  if (params.algorithm === "joindiff" && crossWarehousePre) {
    return {
      success: false,
      steps: 0,
      error:
        "joindiff requires both tables in the same warehouse; use hashdiff or auto for cross-warehouse comparisons.",
    }
  }

  // Dynamically import NAPI module (not available in test environments without the binary)
  let DataParitySession: new (specJson: string) => {
    start(): string
    step(responsesJson: string): string
  }

  try {
    const core = await import("@altimateai/altimate-core")
    DataParitySession = (core as any).DataParitySession
    if (!DataParitySession) throw new Error("DataParitySession not exported from @altimateai/altimate-core")
  } catch (e) {
    return {
      success: false,
      error: `altimate-core NAPI module unavailable: ${e}`,
      steps: 0,
    }
  }

  // Cross-warehouse mode requires side-specific CTE injection: T-SQL / Fabric
  // parse-bind every CTE body even when unreferenced, so sending the combined
  // prefix to a warehouse that lacks the other side's base table fails at parse.
  // Gate on resolved warehouse identity, not dialect — two independent
  // same-dialect warehouses (e.g. two MSSQL instances) still can't resolve each
  // other's base tables. Identity comparison after resolving the default
  // warehouse avoids misclassifying `source_warehouse=undefined` vs the
  // explicit default-warehouse name as different.
  const crossWarehouse = crossWarehousePre

  // Resolve sources (plain table names vs arbitrary queries). Pass dialects so
  // plain-table names inside wrapped CTEs get side-native bracket/quote style.
  const { table1Name, table2Name, ctePrefix, sourceCtePrefix, targetCtePrefix } =
    resolveTableSources(params.source, params.target, dialect1, dialect2)

  // Parse optional qualified names: "db.schema.table" → { database, schema, table }
  const parseQualified = (name: string) => {
    const parts = name.split(".")
    if (parts.length === 3) return { database: parts[0], schema: parts[1], table: parts[2] }
    if (parts.length === 2) return { schema: parts[0], table: parts[1] }
    return { table: name }
  }

  const table1Ref = parseQualified(table1Name)
  const table2Ref = parseQualified(table2Name)

  // Auto-discover extra_columns when not explicitly provided.
  // The Rust engine only compares columns listed in extra_columns — if the list is
  // empty, it compares key existence only and reports all matched rows as "identical"
  // even when non-key values differ. This auto-discovery prevents that silent bug.
  let extraColumns = params.extra_columns
  let excludedAuditColumns: string[] = []

  if (!extraColumns || extraColumns.length === 0) {
    const discovered = await discoverExtraColumns(
      params.source,
      params.key_columns,
      dialect1,
      params.source_warehouse,
    )
    if (discovered) {
      extraColumns = discovered.columns
      excludedAuditColumns = discovered.excludedAudit
    }
  }

  // Build session spec
  const spec = {
    table1: table1Ref,
    table2: table2Ref,
    dialect1,
    dialect2,
    config: {
      algorithm: params.algorithm ?? "auto",
      key_columns: params.key_columns,
      extra_columns: extraColumns ?? [],
      ...(params.where_clause ? { where_clause: params.where_clause } : {}),
      ...(params.numeric_tolerance != null ? { numeric_tolerance: params.numeric_tolerance } : {}),
      ...(params.timestamp_tolerance_ms != null
        ? { timestamp_tolerance_ms: params.timestamp_tolerance_ms }
        : {}),
    },
  }

  // Create session
  let session: InstanceType<typeof DataParitySession>
  try {
    session = new DataParitySession(JSON.stringify(spec))
  } catch (e) {
    return {
      success: false,
      error: `Failed to create DataParitySession: ${e}`,
      steps: 0,
    }
  }

  // Route SQL tasks to the correct warehouse
  const warehouseFor = (tableSide: string): string | undefined =>
    tableSide === "Table2" ? (params.target_warehouse ?? params.source_warehouse) : params.source_warehouse

  // Cooperative loop
  let actionJson = session.start()
  let stepCount = 0

  while (stepCount < MAX_STEPS) {
    const action = JSON.parse(actionJson) as {
      type: string
      tasks?: Array<{ id: string; table_side: string; sql: string; expected_shape: string }>
      outcome?: unknown
      message?: string
    }

    if (action.type === "Done") {
      return {
        success: true,
        steps: stepCount,
        outcome: action.outcome,
        ...(excludedAuditColumns.length > 0 ? { excluded_audit_columns: excludedAuditColumns } : {}),
      }
    }

    if (action.type === "Error") {
      return {
        success: false,
        error: action.message ?? "Unknown engine error",
        steps: stepCount,
      }
    }

    if (action.type !== "ExecuteSql") {
      return {
        success: false,
        error: `Unexpected action type: ${action.type}`,
        steps: stepCount,
      }
    }

    stepCount++

    // Execute all SQL tasks in parallel
    const tasks = action.tasks ?? []
    const taskResults = await Promise.all(
      tasks.map(async (task) => {
        const warehouse = warehouseFor(task.table_side)
        // Inject CTE definitions if we're in query-comparison mode. In
        // cross-warehouse mode each task only gets the CTE for its own side —
        // the other side's base tables aren't bindable on this warehouse.
        let prefix: string | null = null
        if (ctePrefix) {
          if (crossWarehouse) {
            prefix = task.table_side === "Table2" ? targetCtePrefix : sourceCtePrefix
          } else {
            if (task.table_side === "Table1") {
              prefix = sourceCtePrefix
            } else if (task.table_side === "Table2") {
              prefix = targetCtePrefix
            } else {
              prefix = ctePrefix
            }
          }
        }
        const sql = prefix ? injectCte(task.sql, prefix) : task.sql
        try {
          const rows = await executeQuery(sql, warehouse)
          return { id: task.id, rows, error: null }
        } catch (e) {
          return { id: task.id, rows: [] as (string | null)[][], error: String(e) }
        }
      }),
    )

    // Surface any SQL execution errors before feeding to the engine
    const sqlError = taskResults.find((r) => r.error !== null)
    if (sqlError) {
      return {
        success: false,
        error: `SQL execution failed for task ${sqlError.id}: ${sqlError.error}`,
        steps: stepCount,
      }
    }

    const responses = taskResults.map(({ id, rows }) => ({ id, rows }))

    actionJson = session.step(JSON.stringify(responses))
  }

  return {
    success: false,
    error: `Exceeded maximum step limit (${MAX_STEPS}). The diff may require more iterations for this table size.`,
    steps: stepCount,
  }
}
