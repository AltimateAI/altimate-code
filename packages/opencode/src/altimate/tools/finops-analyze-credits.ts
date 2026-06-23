import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

function formatCreditsAnalysis(
  totalCredits: number,
  warehouseSummary: unknown[],
  recommendations: unknown[],
  dailyUsage: unknown[],
): string {
  const lines: string[] = []

  lines.push("Credit Consumption Analysis")
  lines.push("".padEnd(50, "="))
  lines.push(`Total credits consumed: ${totalCredits.toFixed(2)}`)
  lines.push("")

  const warehouses = Array.isArray(warehouseSummary) ? warehouseSummary : []
  if (warehouses.length > 0) {
    lines.push("Warehouse Breakdown")
    lines.push("".padEnd(50, "-"))
    lines.push("Warehouse | Credits | % of Total")
    lines.push("----------|---------|----------")
    for (const wh of warehouses) {
      const w = wh as Record<string, unknown>
      const name = String(w.warehouse_name ?? w.name ?? "unknown")
      const credits = Number(w.credits ?? w.total_credits ?? 0)
      const pct = totalCredits > 0 ? ((credits / totalCredits) * 100).toFixed(1) : "0.0"
      lines.push(`${name} | ${credits.toFixed(2)} | ${pct}%`)
    }
    lines.push("")
  }

  const recs = Array.isArray(recommendations) ? recommendations : []
  if (recs.length > 0) {
    lines.push("Recommendations")
    lines.push("".padEnd(50, "-"))
    for (const rec of recs) {
      const r = rec as Record<string, unknown>
      const severity = r.severity ? `[${String(r.severity).toUpperCase()}]` : ""
      const message = String(r.message ?? r.recommendation ?? r.description ?? rec)
      lines.push(`- ${severity} ${message}`.trim())
    }
    lines.push("")
  }

  const daily = Array.isArray(dailyUsage) ? dailyUsage : []
  if (daily.length > 0) {
    lines.push("Daily Usage")
    lines.push("".padEnd(50, "-"))
    lines.push("Date | Credits")
    lines.push("-----|--------")
    for (const d of daily) {
      const row = d as Record<string, unknown>
      const date = String(row.date ?? row.usage_date ?? "unknown")
      const credits = Number(row.credits ?? row.total_credits ?? 0)
      lines.push(`${date} | ${credits.toFixed(2)}`)
    }
  }

  return lines.join("\n")
}

export const FinopsAnalyzeCreditsTool = Tool.define("finops_analyze_credits", {
  description:
    "Analyze Snowflake/BigQuery/Databricks credit consumption — daily breakdown by warehouse, total credits, and cost optimization recommendations. Requires ACCOUNT_USAGE (Snowflake) / INFORMATION_SCHEMA.JOBS (BigQuery) / system.billing.usage (Databricks) access.",
  parameters: z.object({
    warehouse: z
      .string()
      .optional()
      .describe(
        "Warehouse connection name. Optional — if omitted, the first configured Snowflake/BigQuery/Databricks warehouse is used.",
      ),
    days: z.number().optional().default(30).describe("Days of history to analyze"),
    limit: z.number().optional().default(50).describe("Max daily records"),
    warehouse_filter: z
      .string()
      .optional()
      .describe(
        "Filter result rows by an in-warehouse Snowflake compute name (NOT the connection name). " +
          "Distinct from `warehouse`: `warehouse` picks which connection to query; `warehouse_filter` narrows " +
          "which Snowflake virtual warehouse's queries are returned in the result set. Snowflake only.",
      ),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("finops.analyze_credits", {
        warehouse: args.warehouse,
        days: args.days,
        limit: args.limit,
        warehouse_filter: args.warehouse_filter,
      })

      if (!result.success) {
        const error = result.error ?? "Unknown error"
        return {
          title: "Credit Analysis: FAILED",
          metadata: { success: false, total_credits: 0, error },
          output: `Failed to analyze credits: ${error}`,
        }
      }

      const totalCredits = Number(result.total_credits ?? 0)
      const daysAnalyzed = result.days_analyzed ?? args.days
      return {
        title: `Credits: ${totalCredits.toFixed(2)} over ${daysAnalyzed}d`,
        metadata: { success: true, total_credits: totalCredits },
        output: formatCreditsAnalysis(
          totalCredits,
          (result.warehouse_summary ?? []) as unknown[],
          (result.recommendations ?? []) as unknown[],
          (result.daily_usage ?? []) as unknown[],
        ),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Credit Analysis: ERROR",
        metadata: { success: false, total_credits: 0, error: msg },
        output: `Failed to analyze credits: ${msg}`,
      }
    }
  },
})
