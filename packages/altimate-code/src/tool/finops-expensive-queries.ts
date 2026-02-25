import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const FinopsExpensiveQueriesTool = Tool.define("finops_expensive_queries", {
  description:
    "Find the most expensive queries by bytes scanned. Helps identify optimization targets for cost reduction. Snowflake only.",
  parameters: z.object({
    warehouse: z.string().describe("Warehouse connection name"),
    days: z.number().optional().default(7).describe("Days of history to search"),
    limit: z.number().optional().default(20).describe("Max queries to return"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("finops.expensive_queries", {
        warehouse: args.warehouse,
        days: args.days,
        limit: args.limit,
      })

      if (!result.success) {
        return {
          title: "Expensive Queries: FAILED",
          metadata: { success: false, query_count: 0 },
          output: `Failed to find expensive queries: ${result.error ?? "Unknown error"}`,
        }
      }

      return {
        title: `Expensive Queries: ${result.query_count} found (${result.days_analyzed}d)`,
        metadata: { success: true, query_count: result.query_count },
        output: JSON.stringify(result.queries, null, 2),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Expensive Queries: ERROR",
        metadata: { success: false, query_count: 0 },
        output: `Failed to find expensive queries: ${msg}`,
      }
    }
  },
})
