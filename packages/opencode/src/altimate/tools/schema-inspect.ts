import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import type { SchemaInspectResult } from "../native/types"
// altimate_change start — progressive disclosure suggestions
import { PostConnectSuggestions } from "./post-connect-suggestions"
// altimate_change end
import { isRecord, normalizeError } from "./response-normalization"
// altimate_change start — trace augmentation: use vocab constants for de.* keys
import { DE_WAREHOUSE, DE_SQL } from "../observability/de-attributes"
// altimate_change end

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
      // altimate_change start — trace augmentation: surface row/column counts
      // on the de.* metadata channel.
      const qualifiedTable = schemaResult.schema_name
        ? `${schemaResult.schema_name}.${schemaResult.table ?? args.table}`
        : (schemaResult.table ?? args.table)
      const deAttrs: Record<string, unknown> = {
        ...(schemaResult.row_count !== undefined && schemaResult.row_count !== null && {
          [DE_WAREHOUSE.ROWS_TOTAL]: schemaResult.row_count,
        }),
        ...(qualifiedTable && { [DE_SQL.LINEAGE_OUTPUT_TABLE]: qualifiedTable }),
      }
      // altimate_change end
      return {
        title: `Schema: ${schemaResult.table ?? args.table}`,
        metadata: {
          success: true,
          columnCount: (schemaResult.columns ?? []).length,
          rowCount: schemaResult.row_count,
          ...deAttrs,
        },
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
