import z from "zod"
import { Tool } from "../../tool/tool"
import { Bridge } from "../bridge/client"

export const AltimateCoreOptimizeForQueryTool = Tool.define("altimate_core_optimize_for_query", {
  description:
    "Prune schema to only tables and columns relevant to a specific query using the Rust-based altimate-core engine. Reduces context size for LLM prompts.",
  parameters: z.object({
    sql: z.string().describe("SQL query to optimize schema for"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("altimate_core.optimize_for_query", {
        sql: args.sql,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = result.data as Record<string, any>
      return {
        title: `Optimize for Query: ${data.tables_kept ?? "?"} tables kept`,
        metadata: { success: result.success },
        output: formatOptimizeForQuery(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Optimize for Query: ERROR", metadata: { success: false }, output: `Failed: ${msg}` }
    }
  },
})

function formatOptimizeForQuery(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  if (data.pruned_schema) return `Pruned schema:\n${JSON.stringify(data.pruned_schema, null, 2)}`
  return JSON.stringify(data, null, 2)
}
