import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import type { LineageCheckResult } from "../native/types"

export const LineageCheckTool = Tool.define("lineage_check", {
  description:
    "Check column-level lineage for a SQL query using the Rust-based altimate-core engine. Traces how source columns flow through transformations to output columns. Useful for impact analysis and understanding data flow.",
  parameters: z.object({
    sql: z.string().describe("SQL query to trace lineage for"),
    dialect: z
      .string()
      .optional()
      .default("snowflake")
      .describe("SQL dialect (snowflake, postgres, bigquery, duckdb, etc.)"),
    schema_context: z
      .record(z.string(), z.array(z.object({ name: z.string(), data_type: z.string() })))
      .optional()
      .describe("Schema context mapping table names to column definitions for accurate lineage"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("lineage.check", {
        sql: args.sql,
        dialect: args.dialect,
        schema_context: args.schema_context,
      })

      const data = result.data as Record<string, any>
      if (result.error) {
        return {
          title: "Lineage: ERROR",
          metadata: { success: false },
          output: `Error: ${result.error}`,
        }
      }

      return {
        title: `Lineage: ${result.success ? "OK" : "PARTIAL"}`,
        metadata: { success: result.success },
        output: formatLineage(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Lineage: ERROR",
        metadata: { success: false },
        output: `Failed to check lineage: ${msg}\n\nEnsure the dispatcher is running and altimate-core is initialized.`,
      }
    }
  },
})

function formatLineage(data: Record<string, any>): string {
  const lines: string[] = []

  // column_dict: output columns -> source columns mapping
  if (data.column_dict) {
    lines.push("Column Mappings:")
    for (const [target, sources] of Object.entries(data.column_dict)) {
      lines.push(`  ${target} ← ${JSON.stringify(sources)}`)
    }
    lines.push("")
  }

  // column_lineage: detailed edge list
  if (data.column_lineage?.length) {
    lines.push("Lineage Edges:")
    for (const edge of data.column_lineage) {
      lines.push(`  ${JSON.stringify(edge)}`)
    }
  }

  if (lines.length === 0) {
    lines.push(JSON.stringify(data, null, 2))
  }

  return lines.join("\n")
}
