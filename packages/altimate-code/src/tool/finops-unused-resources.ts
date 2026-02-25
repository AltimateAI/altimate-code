import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const FinopsUnusedResourcesTool = Tool.define("finops_unused_resources", {
  description:
    "Find unused tables and idle warehouses to reduce costs. Identifies stale tables not accessed recently and warehouses with no query activity. Snowflake only.",
  parameters: z.object({
    warehouse: z.string().describe("Warehouse connection name"),
    days: z.number().optional().default(30).describe("Days of inactivity threshold"),
    limit: z.number().optional().default(50).describe("Max resources to return"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("finops.unused_resources", {
        warehouse: args.warehouse,
        days: args.days,
        limit: args.limit,
      })

      if (!result.success) {
        return {
          title: "Unused Resources: FAILED",
          metadata: { success: false, unused_count: 0 },
          output: `Failed to find unused resources: ${result.error ?? "Unknown error"}`,
        }
      }

      const summary = result.summary as Record<string, unknown>
      const total = ((summary.unused_table_count as number) ?? 0) + ((summary.idle_warehouse_count as number) ?? 0)

      return {
        title: `Unused Resources: ${total} found`,
        metadata: { success: true, unused_count: total },
        output: JSON.stringify({
          summary: result.summary,
          unused_tables: result.unused_tables,
          idle_warehouses: result.idle_warehouses,
        }, null, 2),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Unused Resources: ERROR",
        metadata: { success: false, unused_count: 0 },
        output: `Failed to find unused resources: ${msg}`,
      }
    }
  },
})
