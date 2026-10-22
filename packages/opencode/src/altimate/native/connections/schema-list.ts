import { absoluteFileUriPath, isLocalFilePath } from "@altimateai/drivers/file-store"
import type { ConnectionConfig } from "@altimateai/drivers/types"
import type { SchemaListParams, SchemaListResult } from "../types"
import { executeQuery, type QueryContext } from "../query-execution"
import { sanitizeBqRegion } from "../finops/bq-utils"
import * as Registry from "./registry"

const TABLE_LIMIT = 500
const SCHEMA_LIMIT = 200
const quoteIdent = (id: string) => `"${id.replace(/"/g, '""')}"`

/** Undefined means this driver has no supported catalog SQL, never a failed catalog query. */
function catalogQuery(type: string, config: ConnectionConfig | undefined, schema?: string): string | undefined {
  if (type === "sqlite") {
    const catalog = `${quoteIdent(schema ?? "main")}.sqlite_master`
    const filter = "type IN ('table','view') AND name NOT LIKE 'sqlite_%'"
    return schema
      ? `SELECT name, type FROM ${catalog} WHERE ${filter} ORDER BY name LIMIT 501`
      : `SELECT 'main', COUNT(*) FROM ${catalog} WHERE ${filter} LIMIT 201`
  }
  if (!["postgres", "mysql", "snowflake", "duckdb", "redshift", "bigquery"].includes(type)) return undefined
  const catalog =
    type === "bigquery"
      ? `\`region-${sanitizeBqRegion(config?.location)}.INFORMATION_SCHEMA.TABLES\``
      : "information_schema.tables"
  const filters = ["t.table_schema NOT IN ('information_schema', 'pg_catalog', 'pg_internal', 'INFORMATION_SCHEMA')"]
  if (type === "duckdb") filters.push("t.table_catalog = current_database()")
  if (schema)
    filters.push(`t.table_schema = ${type === "postgres" || type === "redshift" || type === "duckdb" ? "$1" : "?"}`)
  if (!schema) {
    return `SELECT t.table_schema, COUNT(*) FROM ${catalog} t WHERE ${filters.join(" AND ")} GROUP BY t.table_schema ORDER BY t.table_schema LIMIT 201`
  }
  const stats =
    type === "mysql"
      ? ", t.table_rows"
      : type === "snowflake"
        ? ", t.row_count"
        : type === "postgres"
          ? ", c.reltuples"
          : type === "duckdb"
            ? ", d.estimated_size"
            : ""
  const join =
    type === "postgres"
      ? " LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = t.table_schema LEFT JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = t.table_name"
      : type === "duckdb"
        ? " LEFT JOIN duckdb_tables() d ON d.database_name = current_database() AND d.schema_name = t.table_schema AND d.table_name = t.table_name AND t.table_type = 'BASE TABLE'"
        : ""
  return `SELECT t.table_name, t.table_type${stats} FROM ${catalog} t${join} WHERE ${filters.join(" AND ")} ORDER BY t.table_name LIMIT 501`
}

function nonnegativeCount(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  const count = Number(value)
  return Number.isSafeInteger(count) && count >= 0 ? count : undefined
}

export async function listSchemaTables(params: SchemaListParams, context?: QueryContext): Promise<SchemaListResult> {
  const warehouse = params.warehouse ?? Registry.list().warehouses[0]?.name
  if (!warehouse) throw new Error("No warehouse configured.")
  context?.signal?.throwIfAborted()
  const connector = await Registry.get(warehouse)
  const config = Registry.getConfig(warehouse)
  const type = Registry.canonicalType(config?.type) ?? ""
  const schema = params.schema_name?.trim() || undefined
  const query = catalogQuery(type, config, schema)
  const store = typeof config?.path === "string" ? config.path : ""
  const local =
    type === "sqlite" ||
    (type === "duckdb" && (store === ":memory:" || isLocalFilePath(store) || absoluteFileUriPath(store) !== undefined))
  const run = (sql: string, limit: number, binds?: unknown[]) =>
    executeQuery(
      config,
      { readOnly: true, ...(local ? {} : { queryTimeoutMs: 10_000 }) },
      context,
      (options) => connector.execute(sql, limit, binds, options),
    )
  if (!schema) {
    if (query) {
      const result = await run(query, SCHEMA_LIMIT + 1)
      return {
        warehouse,
        tables: [],
        schemas: result.rows
          .slice(0, SCHEMA_LIMIT)
          .map((row) => ({ name: String(row[0]), table_count: nonnegativeCount(row[1]) })),
        truncated: result.rows.length > SCHEMA_LIMIT || result.truncated,
      }
    }
    const names = await connector.listSchemas()
    const schemas: NonNullable<SchemaListResult["schemas"]> = []
    for (const name of names.slice(0, SCHEMA_LIMIT).sort()) {
      context?.signal?.throwIfAborted()
      let table_count: number | undefined
      if (type === "mongodb") {
        // dbStats returns a scalar catalog count without transferring collection names.
        try {
          const result = await run(JSON.stringify({ command: "dbStats", database: name }), 1)
          table_count = nonnegativeCount(result.rows[0]?.[0])
        } catch {
          context?.signal?.throwIfAborted()
          // Listing authorized databases may be allowed even when dbStats is denied.
        }
      }
      schemas.push({ name, table_count })
    }
    return { warehouse, tables: [], schemas, truncated: names.length > SCHEMA_LIMIT }
  }

  let tables: SchemaListResult["tables"]
  let truncated: boolean
  const fallback = !query && type !== "mongodb"
  if (query || type === "mongodb") {
    const result = await run(
      query ?? JSON.stringify({ command: "listCollections", database: schema }),
      query ? TABLE_LIMIT + 1 : TABLE_LIMIT,
      query && type !== "sqlite" ? [schema] : undefined,
    )
    truncated = result.rows.length > TABLE_LIMIT || result.truncated
    tables = result.rows.slice(0, TABLE_LIMIT).map((row) => ({
      schema,
      name: String(row[0]),
      type: String(row[1]).toLowerCase().includes("view") ? "view" : type === "mongodb" ? "collection" : "table",
      ...(row.length > 2 ? { row_count: nonnegativeCount(row[2]), row_count_estimated: true } : {}),
    }))
  } else {
    const listed = await connector.listTables(schema)
    truncated = listed.length > TABLE_LIMIT
    tables = listed
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, TABLE_LIMIT)
      .map((table) => ({ schema, ...table }))
  }
  return { warehouse, tables, truncated, ...(fallback ? { fallback: true } : {}) }
}
