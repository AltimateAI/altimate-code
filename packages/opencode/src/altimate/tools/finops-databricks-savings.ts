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
  clusters_checked?: number
  jobs_checked?: number
  skipped?: { check: string; reason: string }[]
  warehouses?: { id: string; name: string; type: string; size: string | null; window_cost: number }[]
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

const percentOf = (value: unknown) => `${Math.round(Number(value))}%`

/** What a finding rests on, one short line each. */
export function evidenceLines(finding: DatabricksSavingsFinding): string[] {
  const e = finding.evidence as Record<string, number | string | null | boolean> & { kind: string }
  switch (e.kind) {
    case "serverless":
      return [
        `${e.warehouse_type} ${size(e.warehouse_size)} warehouse, ${percent(e.idle_ratio)} idle over ${Number(e.wall_clock_uptime_hours).toFixed(1)} running hours (${Number(e.total_query_count).toLocaleString("en-US")} queries)`,
        `$${Number(e.current_dbu_cost).toFixed(2)} in DBUs over the window; serverless would bill $${Number(e.projected_serverless_dbu_cost).toFixed(2)} for the busy time alone`,
      ]
    case "over_sized":
      return [
        `${size(e.current_size)} warehouse used at most ${(Number(e.p99_utilization) * 100).toFixed(1)}% of its cores (p99 over ${Number(e.parallelism_query_count).toLocaleString("en-US")} queries)`,
        `${percent(e.no_spill_query_pct)} of queries never spilled to disk, ${percent(e.no_queue_query_pct)} never queued`,
        `${size(e.recommended_size)} is enough: ${e.current_dbu_per_hour} → ${e.recommended_dbu_per_hour} DBU an hour, on $${Number(e.total_cost).toFixed(2)} spent over the window`,
      ]
    case "idle_cluster":
      return [
        `All-purpose cluster ${percent(e.idle_ratio)} idle across ${e.active_days} active days (${String(e.idle_pattern).replace(/_/g, " ")}), average worker CPU ${percentOf(e.avg_cpu_active_pct)}, peak ${percentOf(e.peak_cpu_active_pct)}`,
        `Auto-termination ${e.auto_termination_minutes ? `${e.auto_termination_minutes} minutes` : "off"}; $${Number(e.total_cost).toFixed(2)} billed outside job runs over the window`,
      ]
    case "job_on_all_purpose":
      return [
        `${e.run_count} runs (${String(e.trigger_type ?? "manual").toLowerCase()}), ${percent(e.all_purpose_share)} of its cost on all-purpose compute, ${percent(e.job_share_of_cluster)} of its cluster's`,
        `$${Number(e.all_purpose_rate_per_dbu).toFixed(3)} a DBU now; a job cluster would be about $${Number(e.jobs_rate_per_dbu).toFixed(3)}${e.jobs_rate_estimated ? " (estimated: the workspace billed no jobs compute)" : ""}`,
      ]
    default:
      return []
  }
}

export function formatSavings(result: DatabricksSavingsResult): string {
  const report = result.report
  if (!report) return "No report."
  const counted = [
    `${result.warehouses_checked ?? 0} SQL warehouses`,
    `${result.clusters_checked ?? 0} all-purpose clusters`,
    `${result.jobs_checked ?? 0} jobs`,
  ].join(", ")
  const lines: string[] = [`Databricks savings: ${counted} checked, the ${report.lookback_days} days to ${result.window.end}, at list price.`]
  for (const one of result.skipped ?? []) lines.push(`Not checked: ${one.check} (${one.reason})`)
  if (report.findings.length === 0) {
    lines.push("No savings found.")
    return lines.join("\n")
  }
  lines.push(
    `Total: ${range(report.total.monthly_min, report.total.monthly_max)} a month on ${report.total.resources} resource${report.total.resources === 1 ? "" : "s"}, each counted once at its largest saving.`,
    "",
  )
  for (const finding of report.findings) {
    lines.push(
      `${finding.resource_name} (${finding.resource_type.replace("_", " ")}) · ${finding.title} · ${range(finding.monthly_min, finding.monthly_max)} a month (${finding.severity})`,
    )
    for (const line of evidenceLines(finding)) lines.push(`  ${line}`)
  }
  for (const option of report.what_if) {
    lines.push("", `What ${option.resource_name} (now ${option.current_label}, ${dollars(option.current_monthly_cost)} a month) would cost instead:`)
    for (const choice of option.choices) {
      const fit = choice.fits ? "" : ` (too small: ${choice.cores} cores, its queries need ${choice.cores_needed.toFixed(0)})`
      lines.push(`  ${size(choice.label)}: ${dollars(choice.monthly_cost)} a month, saving ${dollars(choice.monthly_saving)}${fit}`)
    }
  }
  return lines.join("\n")
}

export const FinopsDatabricksSavingsTool = Tool.define("finops_databricks_savings", {
  description:
    "Check a Databricks workspace for savings with Altimate's rules: SQL warehouses that would cost less as serverless or smaller, idle all-purpose clusters, and scheduled jobs running on all-purpose compute. Read-only queries over seven days of system tables (billing, compute, query history, jobs) on the connection's SQL warehouse, which Databricks starts if it is stopped. Returns each finding with its monthly dollar range and evidence, and what each flagged warehouse would cost at other sizes.",
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
        title: `Databricks Savings: ${range(total.monthly_min, total.monthly_max)} a month on ${total.resources} resource(s)`,
        metadata: {
          success: true,
          window: result.window,
          warehouse: result.warehouse,
          ran_on: result.ran_on,
          warehouses_checked: result.warehouses_checked,
          clusters_checked: result.clusters_checked,
          jobs_checked: result.jobs_checked,
          skipped: result.skipped,
          warehouses: result.warehouses,
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
