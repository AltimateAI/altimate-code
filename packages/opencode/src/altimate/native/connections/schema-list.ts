import { absoluteFileUriPath, isLocalFilePath, requireStorePath } from "@altimateai/drivers/file-store"
import type { SchemaListParams, SchemaListResult } from "../types"
import { executeQuery, type QueryContext } from "../query-execution"
import * as Registry from "./registry"

const TABLE_LIMIT = 500
const quoteIdent = (id: string) => `"${id.replace(/"/g, '""')}"`

export async function listSchemaTables(params: SchemaListParams, context?: QueryContext): Promise<SchemaListResult> {
  const warehouse = params.warehouse ?? Registry.list().warehouses[0]?.name
  if (!warehouse) throw new Error("No warehouse configured.")
  context?.signal?.throwIfAborted()
  const connector = await Registry.get(warehouse)
  const config = Registry.getConfig(warehouse)
  const type = Registry.canonicalType(config?.type)
  // A DuckDB connection can target MotherDuck or another remote store. Only local
  // base tables are eligible; views may scan remote data even in a local file.
  const store = type === "sqlite" || type === "duckdb" ? requireStorePath(config!, type) : undefined
  const countLocal =
    store !== undefined && (store === ":memory:" || isLocalFilePath(store) || absoluteFileUriPath(store) !== undefined)
  const schema = params.schema_name?.trim()
  const schemas = schema ? [schema] : await connector.listSchemas()
  const tables: SchemaListResult["tables"] = []
  let truncated = false
  listing: for (const schema of schemas) {
    context?.signal?.throwIfAborted()
    for (const table of await connector.listTables(schema)) {
      if (tables.length === TABLE_LIMIT) {
        truncated = true
        break listing
      }
      tables.push({ schema, name: table.name, type: table.type })
    }
  }
  if (countLocal) {
    for (const table of tables) {
      context?.signal?.throwIfAborted()
      if (table.type.toLowerCase() !== "table") continue
      try {
        const result = await executeQuery(config, { readOnly: true, queryTimeoutMs: 1_000 }, context, (options) =>
          connector.execute(`SELECT COUNT(*) FROM ${quoteIdent(table.schema)}.${quoteIdent(table.name)}`, 1, undefined, options),
        )
        const count = Number(result.rows[0]?.[0])
        if (Number.isSafeInteger(count) && count >= 0) table.row_count = count
      } catch {
        // Counts are best effort: a denied, dropped or slow table still belongs in
        // the inventory. Never fall back to an unprotected or unbounded scan.
        context?.signal?.throwIfAborted()
      }
    }
  }
  return { warehouse, tables, truncated }
}
