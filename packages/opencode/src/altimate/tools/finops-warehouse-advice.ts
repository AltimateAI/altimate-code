import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

function formatWarehouseAdvice(
  recommendations: unknown[],
  warehouseLoad: unknown[],
  warehousePerformance: unknown[],
): string {
  const lines: string[] = []

  const recs = Array.isArray(recommendations) ? recommendations : []
  const load = Array.isArray(warehouseLoad) ? warehouseLoad : []
  const perf = Array.isArray(warehousePerformance) ? warehousePerformance : []

  if (load.length > 0 || perf.length > 0) {
    lines.push("Warehouse Performance Summary")
    lines.push("".padEnd(50, "="))

    if (perf.length > 0) {
      lines.push("Warehouse | Avg Exec Time | Avg Queue Time | Queries | Status")
      lines.push("----------|---------------|----------------|---------|-------")
      for (const p of perf) {
        const r = p as Record<string, unknown>
        const name = String(r.warehouse_name ?? r.name ?? "unknown")
        const avgExec = r.avg_execution_time !== undefined ? `${Number(r.avg_execution_time).toFixed(2)}s` : "-"
        const avgQueue = r.avg_queue_time !== undefined ? `${Number(r.avg_queue_time).toFixed(2)}s` : "-"
        const queries = r.query_count ?? r.total_queries ?? "-"
        const statusVal = r.status ?? r.health ?? "-"
        lines.push(`${name} | ${avgExec} | ${avgQueue} | ${queries} | ${statusVal}`)
      }
      lines.push("")
    }

    if (load.length > 0) {
      lines.push("Warehouse Load Metrics")
      lines.push("".padEnd(50, "-"))
      lines.push("Warehouse | Size | Avg Load | Peak Load | Utilization")
      lines.push("----------|------|----------|-----------|------------")
      for (const l of load) {
        const r = l as Record<string, unknown>
        const name = String(r.warehouse_name ?? r.name ?? "unknown")
        const size = String(r.warehouse_size ?? r.size ?? "-")
        const avgLoad = r.avg_load !== undefined ? Number(r.avg_load).toFixed(1) : "-"
        const peakLoad = r.peak_load !== undefined ? Number(r.peak_load).toFixed(1) : "-"
        const util = r.utilization !== undefined ? `${Number(r.utilization).toFixed(1)}%` : "-"
        lines.push(`${name} | ${size} | ${avgLoad} | ${peakLoad} | ${util}`)
      }
      lines.push("")
    }
  }

  if (recs.length > 0) {
    lines.push("Recommendations")
    lines.push("".padEnd(50, "-"))
    for (const rec of recs) {
      const r = rec as Record<string, unknown>
      const warehouse = r.warehouse_name ?? r.warehouse ?? ""
      const action = String(r.action ?? r.recommendation ?? r.message ?? rec)
      const reason = r.reason ? ` (${r.reason})` : ""
      const prefix = warehouse ? `[${warehouse}] ` : ""
      lines.push(`- ${prefix}${action}${reason}`)
    }
  } else {
    lines.push("No recommendations - all warehouses appear correctly sized.")
  }

  return lines.join("\n")
}

export const FinopsWarehouseAdviceTool = Tool.define("finops_warehouse_advice", {
  description:
    "Analyze warehouse load and performance to recommend sizing changes. Identifies underutilized, overloaded, and correctly-sized warehouses. Snowflake only.",
  parameters: z.object({
    warehouse: z.string().describe("Warehouse connection name"),
    days: z.number().optional().default(14).describe("Days of history to analyze"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("finops.warehouse_advice", {
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
        output: formatWarehouseAdvice(
          result.recommendations as unknown[],
          result.warehouse_load as unknown[],
          result.warehouse_performance as unknown[],
        ),
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
