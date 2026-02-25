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
  }),
  async execute(args, ctx) {
    const result = await Bridge.call("lineage.check", {
      sql: args.sql,
      dialect: args.dialect,
    })

    return {
      title: `Lineage: ${result.edges.length} edge${result.edges.length !== 1 ? "s" : ""}, ${result.tables.length} table${result.tables.length !== 1 ? "s" : ""}`,
      metadata: {
        edgeCount: result.edges.length,
        tableCount: result.tables.length,
        columnCount: result.columns.length,
      },
      output: formatLineage(result),
    }
  },
})

function formatLineage(result: LineageCheckResult): string {
  if (result.edges.length === 0) {
    return "No column-level lineage edges detected.\nThis may indicate the query uses SELECT * or has complex expressions that couldn't be traced."
  }

  const lines: string[] = []

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
