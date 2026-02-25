import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const FinopsAnalyzeCreditsTool = Tool.define("finops_analyze_credits", {
  description:
    "Analyze Snowflake credit consumption — daily breakdown by warehouse, total credits, and cost optimization recommendations. Requires ACCOUNT_USAGE access.",
  parameters: z.object({
    warehouse: z.string().describe("Warehouse connection name"),
    days: z.number().optional().default(30).describe("Days of history to analyze"),
    limit: z.number().optional().default(50).describe("Max daily records"),
    warehouse_filter: z.string().optional().describe("Filter to a specific Snowflake warehouse"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("finops.analyze_credits", {
        warehouse: args.warehouse,
        days: args.days,
        limit: args.limit,
        warehouse_filter: args.warehouse_filter,
      })

      if (!result.success) {
        return {
          title: "Credit Analysis: FAILED",
          metadata: { success: false, total_credits: 0 },
          output: `Failed to analyze credits: ${result.error ?? "Unknown error"}`,
        }
      }

      return {
        title: `Credits: ${result.total_credits.toFixed(2)} over ${result.days_analyzed}d`,
        metadata: { success: true, total_credits: result.total_credits },
        output: JSON.stringify({
          total_credits: result.total_credits,
          warehouse_summary: result.warehouse_summary,
          recommendations: result.recommendations,
          daily_usage: result.daily_usage,
        }, null, 2),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Credit Analysis: ERROR",
        metadata: { success: false, total_credits: 0 },
        output: `Failed to analyze credits: ${msg}`,
      }
    }
  },
})
