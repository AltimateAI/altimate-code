import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const SqlGuardPruneSchemaTool = Tool.define("sqlguard_prune_schema", {
  description:
    "Filter schema to only tables and columns referenced by a SQL query using the Rust-based sqlguard engine. Progressive schema disclosure for minimal context.",
  parameters: z.object({
    sql: z.string().describe("SQL query to determine relevant schema for"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("sqlguard.prune_schema", {
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
  if (data.pruned) return JSON.stringify(data.pruned, null, 2)
  return JSON.stringify(data, null, 2)
}
