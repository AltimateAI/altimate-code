import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import type { SchemaInspectResult } from "../native/types"
// altimate_change start — progressive disclosure suggestions
import { PostConnectSuggestions } from "./post-connect-suggestions"
// altimate_change end
import { isRecord, normalizeError } from "./response-normalization"

export const SchemaInspectTool = Tool.define("schema_inspect", {
  description: "Inspect database schema — list columns, types, and constraints for a table.",
  parameters: z.object({
    table: z.string().describe("Table name (optionally schema-qualified, e.g. public.orders)"),
    schema_name: z.string().optional().describe("Schema name if not in table string"),
    warehouse: z.string().optional().describe("Warehouse connection name"),
  }),
  async execute(args, ctx) {
    try {
      const result = (await Dispatcher.call("schema.inspect", {
        table: args.table,
        schema_name: args.schema_name,
        warehouse: args.warehouse,
      })) as unknown

      if (!isRecord(result)) {
        return schemaError("Invalid schema response from dispatcher.")
      }

      const responseError = normalizeError(result.error)
      if (result.success === false || responseError !== undefined) {
        return schemaError(responseError?.trim() || "Schema inspection failed.")
      }

      const schemaResult = (isRecord(result.data) ? result.data : result) as Partial<SchemaInspectResult>

      // altimate_change start — progressive disclosure suggestions
      let output = formatSchema(schemaResult)
      const suggestion = PostConnectSuggestions.getProgressiveSuggestion("schema_inspect")
      if (suggestion) {
        output += "\n\n" + suggestion
        PostConnectSuggestions.trackSuggestions({
          suggestionType: "progressive_disclosure",
          suggestionsShown: ["lineage_check"],
          warehouseType: args.warehouse ?? "unknown",
        })
      }
      // altimate_change end
      return {
        title: `Schema: ${schemaResult.table ?? args.table}`,
        metadata: { success: true, columnCount: (schemaResult.columns ?? []).length, rowCount: schemaResult.row_count },
        output,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return schemaError(msg)
    }
  },
})

function schemaError(msg: string) {
  return {
    title: "Schema: ERROR",
    metadata: { success: false, columnCount: 0, rowCount: undefined, error: msg },
    output: `Failed to inspect schema: ${msg}\n\nEnsure the dispatcher is running and a warehouse connection is configured.`,
  }
}

function formatSchema(result: Partial<SchemaInspectResult>): string {
  const lines: string[] = []
  const table = result.table ?? "unknown"
  const qualified = result.schema_name ? `${result.schema_name}.${table}` : table
  lines.push(`Table: ${qualified}`)
  if (result.row_count !== null && result.row_count !== undefined) {
    lines.push(`Rows: ${result.row_count.toLocaleString()}`)
  }
  lines.push("")
  lines.push("Column | Type | Nullable | PK")
  lines.push("-------|------|----------|---")
  for (const col of result.columns ?? []) {
    lines.push(
      `${col.name} | ${col.data_type ?? "unknown"} | ${col.nullable ? "YES" : "NO"} | ${col.primary_key ? "YES" : ""}`,
    )
  }
  return lines.join("\n")
}
