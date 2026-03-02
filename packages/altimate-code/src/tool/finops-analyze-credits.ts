import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

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
        output: formatCreditsAnalysis(
          result.total_credits as number,
          result.warehouse_summary as unknown[],
          result.recommendations as unknown[],
          result.daily_usage as unknown[],
        ),
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
