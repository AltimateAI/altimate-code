import z from "zod"
import { Tool } from "../../tool/tool"
import { Bridge } from "../bridge/client"

export const AltimateCoreColumnLineageTool = Tool.define("altimate_core_column_lineage", {
  description:
    "Trace schema-aware column lineage using the Rust-based altimate-core engine. Maps how columns flow through a query from source tables to output. Requires altimate_core.init() with API key.",
  parameters: z.object({
    sql: z.string().describe("SQL query to trace lineage for"),
    dialect: z.string().optional().describe("SQL dialect (e.g. snowflake, bigquery)"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("altimate_core.column_lineage", {
        sql: args.sql,
        dialect: args.dialect ?? "",
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = result.data as Record<string, any>
      const edgeCount = data.column_lineage?.length ?? 0
      return {
        title: `Column Lineage: ${edgeCount} edge(s)`,
        metadata: { success: result.success, edge_count: edgeCount },
        output: formatColumnLineage(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Column Lineage: ERROR", metadata: { success: false, edge_count: 0 }, output: `Failed: ${msg}` }
    }
  },
})

function formatColumnLineage(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  if (!data.column_lineage?.length) return "No column lineage edges found."
  const lines = ["Column lineage:\n"]
  for (const edge of data.column_lineage) {
    lines.push(`  ${edge.source} -> ${edge.target}${edge.transform ? ` (${edge.transform})` : ""}`)
  }
  return lines.join("\n")
}
