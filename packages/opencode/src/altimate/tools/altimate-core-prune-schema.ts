import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

export const AltimateCorePruneSchemaTool = Tool.define("altimate_core_prune_schema", {
  description:
    "Filter schema to only tables and columns referenced by a SQL query using the Rust-based altimate-core engine. Progressive schema disclosure for minimal context.",
  parameters: z.object({
    sql: z.string().describe("SQL query to determine relevant schema for"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("altimate_core.prune_schema", {
        sql: args.sql,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = result.data as Record<string, any>
      return {
        title: "Prune Schema: done",
        metadata: { success: result.success },
        output: formatPruneSchema(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Prune Schema: ERROR", metadata: { success: false }, output: `Failed: ${msg}` }
    }
  },
})

function formatPruneSchema(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  const lines: string[] = []
  if (data.tables_pruned != null) {
    lines.push(`Pruned ${data.tables_pruned} of ${data.total_tables} tables to ${data.relevant_tables?.length ?? "?"} relevant.`)
  }
  if (data.relevant_tables?.length) {
    lines.push(`Relevant tables: ${data.relevant_tables.join(", ")}`)
  }
  if (data.pruned_schema_yaml) {
    lines.push("")
    lines.push(data.pruned_schema_yaml)
  } else if (data.pruned) {
    lines.push("")
    lines.push(JSON.stringify(data.pruned, null, 2))
  }
  return lines.length > 0 ? lines.join("\n") : JSON.stringify(data, null, 2)
}
