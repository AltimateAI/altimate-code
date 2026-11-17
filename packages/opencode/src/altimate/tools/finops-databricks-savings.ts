// altimate_change - new file
import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import type { DatabricksSavingsFinding, DatabricksSavingsReport, DatabricksSavingsResult } from "../native/types"

/** One shape for every outcome, so a reader of the metadata never guesses which fields exist. */
type SavingsMetadata = {
  success: boolean
  window?: { start: string; end: string }
  warehouse?: string
  ran_on?: string
  warehouses_checked?: number
  report?: DatabricksSavingsReport
  error?: string
}

function dollars(value: number): string {
  return value >= 100
    ? `$${Math.round(value).toLocaleString("en-US")}`
    : `$${value.toFixed(2)}`
}

function range(low: number, high: number): string {
  return dollars(low) === dollars(high) ? dollars(high) : `${dollars(low)}–${dollars(high)}`
}

function percent(share: unknown): string {
  return `${Math.round(Number(share) * 100)}%`
}

function size(value: unknown): string {
  return String(value ?? "?").replace(/_/g, "-")
}

/** What a finding rests on, one short line each. */
export function evidenceLines(finding: DatabricksSavingsFinding): string[] {
  const e = finding.evidence as Record<string, number | string | null> & { kind: string }
  if (e.kind === "serverless") {
    return [
      `${e.warehouse_type} ${size(e.warehouse_size)} warehouse, ${percent(e.idle_ratio)} idle over ${Number(e.wall_clock_uptime_hours).toFixed(1)} running hours (${Number(e.total_query_count).toLocaleString("en-US")} queries)`,
      `$${Number(e.current_dbu_cost).toFixed(2)} in DBUs over the window; serverless would bill $${Number(e.projected_serverless_dbu_cost).toFixed(2)} for the busy time alone`,
    ]
  }
  return [
    `${size(e.current_size)} warehouse used at most ${(Number(e.p99_utilization) * 100).toFixed(1)}% of its cores (p99 over ${Number(e.parallelism_query_count).toLocaleString("en-US")} queries)`,
    `${percent(e.no_spill_query_pct)} of queries never spilled to disk, ${percent(e.no_queue_query_pct)} never queued`,
    `${size(e.recommended_size)} is enough: ${e.current_dbu_per_hour} → ${e.recommended_dbu_per_hour} DBU an hour, on $${Number(e.total_cost).toFixed(2)} spent over the window`,
  ]
}

export function formatSavings(result: DatabricksSavingsResult): string {
  const report = result.report
  if (!report) return "No report."
  const lines: string[] = [
    `Databricks SQL warehouse savings, ${result.warehouses_checked ?? 0} warehouses checked, the ${report.lookback_days} days to ${result.window.end} 06:00 UTC, at list price.`,
  ]
  if (report.findings.length === 0) {
    lines.push("No savings found by the Serverless and Over-Sized checks.")
    return lines.join("\n")
  }
  lines.push(
    `Total: ${range(report.total.monthly_min, report.total.monthly_max)} a month on ${report.total.warehouses} warehouse${report.total.warehouses === 1 ? "" : "s"}, each warehouse counted once at its largest saving.`,
    "",
  )
  for (const finding of report.findings) {
    lines.push(`${finding.warehouse_name} · ${finding.title} · ${range(finding.monthly_min, finding.monthly_max)} a month (${finding.severity})`)
    for (const line of evidenceLines(finding)) lines.push(`  ${line}`)
  }
  return lines.join("\n")
}

export const FinopsDatabricksSavingsTool = Tool.define("finops_databricks_savings", {
  description:
    "Check a Databricks workspace's SQL warehouses for savings with Altimate's rules: Classic/Pro warehouses that would cost less as serverless, and warehouses larger than their queries need. Read-only; returns each finding with its monthly dollar range and the measured evidence.",
  parameters: z.object({
    warehouse: z
      .string()
      .optional()
      .describe("Databricks connection name. Optional — omit to use the first configured Databricks connection."),
  }),
  async execute(args) {
    try {
      const result = await Dispatcher.call("finops.databricks_savings", { warehouse: args.warehouse })
      if (!result.success || !result.report) {
        const error = result.error ?? "Unknown error"
        return {
          title: "Databricks Savings: FAILED",
          metadata: { success: false, window: result.window, error } as SavingsMetadata,
          output: `The Databricks savings check failed: ${error}`,
        }
      }
      const total = result.report.total
      return {
        title: `Databricks Savings: ${range(total.monthly_min, total.monthly_max)} a month on ${total.warehouses} warehouse(s)`,
        metadata: {
          success: true,
          window: result.window,
          warehouse: result.warehouse,
          ran_on: result.ran_on,
          warehouses_checked: result.warehouses_checked,
          report: result.report,
        } as SavingsMetadata,
        output: formatSavings(result),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Databricks Savings: ERROR",
        metadata: { success: false, error: msg } as SavingsMetadata,
        output: `The Databricks savings check failed: ${msg}`,
      }
    }
  },
})
