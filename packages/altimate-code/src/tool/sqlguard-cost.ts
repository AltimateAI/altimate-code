import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const SqlGuardCostTool = Tool.define("sqlguard_cost", {
  description:
    "Estimate per-dialect cloud cost for a SQL query using the Rust-based sqlguard engine. Returns estimated bytes scanned, execution time, and USD cost for the target cloud warehouse.",
  parameters: z.object({
    sql: z.string().describe("SQL query to estimate cost for"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
    dialect: z.string().optional().describe("Target dialect (e.g. snowflake, bigquery, redshift)"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("sqlguard.cost", {
        sql: args.sql,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
        dialect: args.dialect ?? "",
      })
      const data = result.data as Record<string, any>
      return {
        title: `Cost: ${data.estimated_usd != null ? `$${data.estimated_usd}` : data.tier ?? "estimated"}`,
        metadata: { success: result.success, estimated_usd: data.estimated_usd },
        output: formatCost(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Cost: ERROR", metadata: { success: false, estimated_usd: null }, output: `Failed: ${msg}` }
    }
  },
})

function formatCost(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  const lines: string[] = []
  if (data.estimated_usd != null) lines.push(`Estimated cost: $${data.estimated_usd}`)
  if (data.bytes_scanned != null) lines.push(`Bytes scanned: ${data.bytes_scanned}`)
  if (data.tier) lines.push(`Cost tier: ${data.tier}`)
  if (data.dialect) lines.push(`Dialect: ${data.dialect}`)
  if (data.breakdown) {
    lines.push("\nBreakdown:")
    for (const [key, val] of Object.entries(data.breakdown)) {
      lines.push(`  ${key}: ${val}`)
    }
  }
  return lines.join("\n")
}
