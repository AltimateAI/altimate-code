import z from "zod"
import { Tool } from "../../tool/tool"
import { Bridge } from "../bridge/client"
import type { SchemaCacheStatusResult } from "../bridge/protocol"

export const SchemaCacheStatusTool = Tool.define("schema_cache_status", {
  description: "Show status of the local schema cache — which warehouses are indexed, how many tables/columns, when last refreshed.",
  parameters: z.object({}),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("schema.cache_status", {})

      return {
        title: `Schema Cache: ${result.total_tables} tables, ${result.total_columns} columns`,
        metadata: {
          totalTables: result.total_tables,
          totalColumns: result.total_columns,
          warehouseCount: result.warehouses.length,
        },
        output: formatStatus(result),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Schema Cache Status: ERROR",
        metadata: { totalTables: 0, totalColumns: 0, warehouseCount: 0 },
        output: `Failed to get cache status: ${msg}\n\nEnsure the Python bridge is running.`,
      }
    }
  },
})

function formatStatus(result: SchemaCacheStatusResult): string {
  const lines: string[] = [
    `Cache path: ${result.cache_path}`,
    `Total tables: ${result.total_tables}`,
    `Total columns: ${result.total_columns}`,
    "",
  ]

  if (result.warehouses.length === 0) {
    lines.push("No warehouses indexed yet. Run schema_index to populate the cache.")
  } else {
    lines.push("Warehouse | Type | Schemas | Tables | Columns | Last Indexed")
    lines.push("----------|------|---------|--------|---------|-------------")
    for (const w of result.warehouses) {
      const indexed = w.last_indexed ? new Date(w.last_indexed).toLocaleString() : "never"
      lines.push(
        `${w.name} | ${w.type} | ${w.schemas_count} | ${w.tables_count} | ${w.columns_count} | ${indexed}`,
      )
    }
  }

  return lines.join("\n")
}
