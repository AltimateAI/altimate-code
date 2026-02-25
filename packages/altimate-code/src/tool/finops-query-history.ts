import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const FinopsQueryHistoryTool = Tool.define("finops_query_history", {
  description:
    "Fetch recent query execution history from a warehouse. Shows query text, execution time, bytes scanned, and status. Snowflake: reads from QUERY_HISTORY. PostgreSQL: reads from pg_stat_statements.",
  parameters: z.object({
    warehouse: z.string().describe("Warehouse connection name"),
    days: z.number().optional().default(7).describe("How many days of history to fetch"),
    limit: z.number().optional().default(100).describe("Maximum number of queries to return"),
    user: z.string().optional().describe("Filter to a specific user (Snowflake only)"),
    warehouse_filter: z.string().optional().describe("Filter to a specific warehouse name (Snowflake only)"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("finops.query_history", {
        warehouse: args.warehouse,
        days: args.days,
        limit: args.limit,
        user: args.user,
        warehouse_filter: args.warehouse_filter,
      })

      if (!result.success) {
        return {
          title: "Query History: FAILED",
          metadata: { success: false, query_count: 0 },
          output: `Failed to fetch query history: ${result.error ?? "Unknown error"}`,
        }
      }

      const summary = result.summary as Record<string, unknown>
      return {
        title: `Query History: ${summary.query_count ?? 0} queries (${args.days}d)`,
        metadata: { success: true, query_count: (summary.query_count as number) ?? 0 },
        output: JSON.stringify({ summary: result.summary, queries: result.queries }, null, 2),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Query History: ERROR",
        metadata: { success: false, query_count: 0 },
        output: `Failed to fetch query history: ${msg}`,
      }
    }
  },
})
