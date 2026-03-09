import z from "zod"
import { Tool } from "../../tool/tool"
import { Bridge } from "../bridge/client"
import type { SchemaInspectResult } from "../bridge/protocol"

export const SchemaInspectTool = Tool.define("schema_inspect", {
  description: "Inspect database schema — list columns, types, and constraints for a table.",
  parameters: z.object({
    table: z.string().describe("Table name (optionally schema-qualified, e.g. public.orders)"),
    schema_name: z.string().optional().describe("Schema name if not in table string"),
    warehouse: z.string().optional().describe("Warehouse connection name"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("schema.inspect", {
        table: args.table,
        schema_name: args.schema_name,
        warehouse: args.warehouse,
      })

      return {
        title: `Schema: ${result.table}`,
        metadata: { columnCount: result.columns.length, rowCount: result.row_count },
        output: formatSchema(result),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Schema: ERROR",
        metadata: { columnCount: 0, rowCount: undefined },
        output: `Failed to inspect schema: ${msg}\n\nEnsure the Python bridge is running and a warehouse connection is configured.`,
      }
    }
  },
})

function formatSchema(result: SchemaInspectResult): string {
  const lines: string[] = []
  const qualified = result.schema_name ? `${result.schema_name}.${result.table}` : result.table
  lines.push(`Table: ${qualified}`)
  if (result.row_count !== null && result.row_count !== undefined) {
    lines.push(`Rows: ${result.row_count.toLocaleString()}`)
  }
  lines.push("")
  lines.push("Column | Type | Nullable | PK")
  lines.push("-------|------|----------|---")
  for (const col of result.columns) {
    lines.push(
      `${col.name} | ${col.data_type} | ${col.nullable ? "YES" : "NO"} | ${col.primary_key ? "YES" : ""}`,
    )
  }
  return lines.join("\n")
}
