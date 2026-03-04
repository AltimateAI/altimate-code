import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const AltimateCoreQueryPiiTool = Tool.define("altimate_core_query_pii", {
  description:
    "Analyze query-level PII exposure using the Rust-based altimate-core engine. Checks if a SQL query accesses columns classified as PII and reports the exposure risk.",
  parameters: z.object({
    sql: z.string().describe("SQL query to check for PII access"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("altimate_core.query_pii", {
        sql: args.sql,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = result.data as Record<string, any>
      const exposureCount = data.exposures?.length ?? 0
      return {
        title: `Query PII: ${exposureCount === 0 ? "CLEAN" : `${exposureCount} exposure(s)`}`,
        metadata: { success: result.success, exposure_count: exposureCount },
        output: formatQueryPii(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Query PII: ERROR", metadata: { success: false, exposure_count: 0 }, output: `Failed: ${msg}` }
    }
  },
})

function formatQueryPii(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  if (!data.exposures?.length) return "Query does not access PII columns."
  const lines = ["PII exposure detected:\n"]
  for (const e of data.exposures) {
    lines.push(`  ${e.column}: ${e.category} (${e.risk ?? "medium"} risk)`)
  }
  return lines.join("\n")
}
