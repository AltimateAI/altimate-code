import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"
import type { LineageCheckResult } from "../bridge/protocol"

export const LineageCheckTool = Tool.define("lineage_check", {
  description:
    "Check column-level lineage for a SQL query. Traces how source columns flow through transformations to output columns. Useful for impact analysis and understanding data flow.",
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
      const result = await Bridge.call("lineage.check", {
        sql: args.sql,
        dialect: args.dialect,
        schema_context: args.schema_context,
      })

      return {
        title: `Lineage: ${result.edges.length} edge${result.edges.length !== 1 ? "s" : ""}, ${result.tables.length} table${result.tables.length !== 1 ? "s" : ""} [${result.confidence}]`,
        metadata: {
          edgeCount: result.edges.length,
          tableCount: result.tables.length,
          columnCount: result.columns.length,
          confidence: result.confidence,
        },
        output: formatLineage(result),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Lineage: ERROR",
        metadata: { edgeCount: 0, tableCount: 0, columnCount: 0, confidence: "unknown" },
        output: `Failed to check lineage: ${msg}\n\nEnsure the Python bridge is running and altimate-engine is installed.`,
      }
    }
  },
})

function formatLineage(result: LineageCheckResult): string {
  const lines: string[] = []

  if (result.confidence_factors.length > 0) {
    lines.push(`Confidence: ${result.confidence}`)
    lines.push(`  Note: ${result.confidence_factors.join("; ")}`)
    lines.push("")
  }

  if (result.edges.length === 0) {
    lines.push("No column-level lineage edges detected.")
    lines.push("This may indicate the query uses SELECT * or has complex expressions that couldn't be traced.")
    return lines.join("\n")
  }

  lines.push("Column Lineage Edges:")
  lines.push("Source Table.Column → Target Table.Column | Transform")
  lines.push("".padEnd(60, "-"))

  for (const edge of result.edges) {
    const transform = edge.transform ? ` | ${edge.transform}` : ""
    lines.push(`${edge.source_table}.${edge.source_column} → ${edge.target_table}.${edge.target_column}${transform}`)
  }

  lines.push("")
  lines.push(`Tables: ${result.tables.join(", ")}`)
  lines.push(`Columns: ${result.columns.join(", ")}`)

  return lines.join("\n")
}
