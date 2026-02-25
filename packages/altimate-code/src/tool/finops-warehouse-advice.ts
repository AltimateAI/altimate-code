import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const FinopsWarehouseAdviceTool = Tool.define("finops_warehouse_advice", {
  description:
    "Analyze warehouse load and performance to recommend sizing changes. Identifies underutilized, overloaded, and correctly-sized warehouses. Snowflake only.",
  parameters: z.object({
    warehouse: z.string().describe("Warehouse connection name"),
    days: z.number().optional().default(14).describe("Days of history to analyze"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("finops.warehouse_advice", {
        warehouse: args.warehouse,
        days: args.days,
      })

      if (!result.success) {
        return {
          title: "Warehouse Advice: FAILED",
          metadata: { success: false, recommendation_count: 0 },
          output: `Failed to analyze warehouses: ${result.error ?? "Unknown error"}`,
        }
      }

      return {
        title: `Warehouse Advice: ${result.recommendations.length} recommendation${result.recommendations.length !== 1 ? "s" : ""}`,
        metadata: { success: true, recommendation_count: result.recommendations.length },
        output: JSON.stringify({
          recommendations: result.recommendations,
          warehouse_load: result.warehouse_load,
          warehouse_performance: result.warehouse_performance,
        }, null, 2),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Warehouse Advice: ERROR",
        metadata: { success: false, recommendation_count: 0 },
        output: `Failed to analyze warehouses: ${msg}`,
      }
    }
  },
})
