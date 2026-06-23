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
      // Field names match what `warehouse-advisor.ts` actually returns from
      // the SIZING SQL: warehouse_name, query_count, avg_time_sec,
      // p95_time_sec, avg_bytes_scanned, total_credits. The previous version
      // of this formatter read `avg_execution_time` / `avg_queue_time` /
      // `status` / `health` — none of which exist in the result rows, so
      // every value rendered as `-` regardless of input. (Same class of
      // bug previously fixed for finops-query-history.ts and
      // finops-expensive-queries.ts.)
      lines.push("Warehouse | Queries | Avg Time | p95 Time | Credits")
      lines.push("----------|---------|----------|----------|--------")
      for (const p of perf) {
        const r = p as Record<string, unknown>
        const name = String(r.warehouse_name ?? r.name ?? "unknown")
        const queries = r.query_count ?? "-"
        const avgTime = r.avg_time_sec !== undefined ? `${Number(r.avg_time_sec).toFixed(2)}s` : "-"
        const p95Time = r.p95_time_sec !== undefined ? `${Number(r.p95_time_sec).toFixed(2)}s` : "-"
        const credits = r.total_credits !== undefined ? Number(r.total_credits).toFixed(2) : "-"
        lines.push(`${name} | ${queries} | ${avgTime} | ${p95Time} | ${credits}`)
      }
      lines.push("")
    }

    if (load.length > 0) {
      // LOAD SQL returns: warehouse_name, avg_concurrency, avg_queue_load,
      // peak_queue_load, sample_count. The previous version read
      // `warehouse_size` / `avg_load` / `peak_load` / `utilization` — none of
      // which are in the result rows. (Same bug pattern.) `warehouse_size` is
      // populated separately in `recommendations[*].current_size` from the
      // SHOW WAREHOUSES probe; surface that in the Recommendations section
      // below, not here.
      lines.push("Warehouse | Avg Concurrency | Avg Queue | Peak Queue | Samples")
      lines.push("----------|-----------------|-----------|------------|--------")
      for (const l of load) {
        const r = l as Record<string, unknown>
        const name = String(r.warehouse_name ?? r.name ?? "unknown")
        const avgConc = r.avg_concurrency !== undefined ? Number(r.avg_concurrency).toFixed(2) : "-"
        const avgQ = r.avg_queue_load !== undefined ? Number(r.avg_queue_load).toFixed(2) : "-"
        const peakQ = r.peak_queue_load !== undefined ? Number(r.peak_queue_load).toFixed(2) : "-"
        const samples = r.sample_count ?? "-"
        lines.push(`${name} | ${avgConc} | ${avgQ} | ${peakQ} | ${samples}`)
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
    "Analyze warehouse load and performance on Snowflake / BigQuery / Databricks to recommend sizing changes. Identifies underutilized, overloaded, and correctly-sized warehouses.",
  parameters: z.object({
    warehouse: z
      .string()
      .optional()
      .describe(
        "Warehouse connection name. Optional — if omitted, the first configured Snowflake/BigQuery/Databricks warehouse is used.",
      ),
    days: z.number().optional().default(14).describe("Days of history to analyze"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("finops.warehouse_advice", {
        warehouse: args.warehouse,
        days: args.days,
      })

      if (!result.success) {
        const error = result.error ?? "Unknown error"
        return {
          title: "Warehouse Advice: FAILED",
          metadata: { success: false, recommendation_count: 0, error },
          output: `Failed to analyze warehouses: ${error}`,
        }
      }

      // Defensive null-coalesce in case the handler ever returns a partial
      // shape (transient dispatcher variance, future schema change). Without
      // this, `.length` on an undefined would throw a TypeError and the user
      // would see a JS stack instead of a structured tool error.
      const recs = (result.recommendations as unknown[] | undefined) ?? []
      return {
        title: `Warehouse Advice: ${recs.length} recommendation${recs.length !== 1 ? "s" : ""}`,
        metadata: { success: true, recommendation_count: recs.length },
        output: formatWarehouseAdvice(
          recs,
          (result.warehouse_load as unknown[] | undefined) ?? [],
          (result.warehouse_performance as unknown[] | undefined) ?? [],
        ),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Warehouse Advice: ERROR",
        metadata: { success: false, recommendation_count: 0, error: msg },
        output: `Failed to analyze warehouses: ${msg}`,
      }
    }
  },
})
