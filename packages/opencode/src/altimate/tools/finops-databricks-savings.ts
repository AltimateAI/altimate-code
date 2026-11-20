// altimate_change - new file
import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import type { DatabricksSavingsFinding, DatabricksSavingsReport, DatabricksSavingsResult } from "../native/types"
import { SAVINGS_RUN_LIMIT_MINUTES } from "../native/finops/savings-run"
import { ROW_LIMIT } from "../native/finops/databricks-savings"
import { dollars, oneLine, range } from "./finops-formatting"

/** One shape for every outcome, so a reader of the metadata never guesses which fields exist. */
type SavingsMetadata = {
  success: boolean
  window?: { start: string; end: string }
  warehouse?: string
  ran_on?: string
  workspaces_checked?: number
  warehouses_checked?: number
  clusters_checked?: number
  jobs_checked?: number
  skipped?: { check: string; reason: string }[]
  limited?: string[]
  warehouses?: { id: string; workspace_id?: string | null; name: string; type: string; size: string | null; window_cost: number }[]
  report?: DatabricksSavingsReport
  error?: string
  /** True when the check did not run because `confirm` was not set. */
  needs_confirmation?: boolean
}

function percent(share: unknown): string {
  return `${Math.round(Number(share) * 100)}%`
}

function size(value: unknown): string {
  return String(value ?? "?").replace(/_/g, "-")
}

const percentOf = (value: unknown) => `${Math.round(Number(value))}%`

/** One decimal; a figure that would round to 0.0 reads "under 0.1". */
const tenths = (value: unknown) =>
  Number(value) < 0.05 ? "under 0.1" : Number(value).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })

/** An estimate to one decimal: "about 1.2", or "under 0.1". */
const aboutTenths = (value: unknown) => {
  const text = tenths(value)
  return text === "under 0.1" ? text : `about ${text}`
}

/** What a finding rests on, one short line each. */
export function evidenceLines(finding: DatabricksSavingsFinding): string[] {
  const e = finding.evidence
  switch (e.kind) {
    case "serverless":
      return [
        // Core reports no size when the warehouse's size is unknown.
        `${e.warehouse_type}${e.warehouse_size ? ` ${size(e.warehouse_size)}` : ""} warehouse, ${percent(e.idle_ratio)} idle over ${Number(e.wall_clock_uptime_hours).toFixed(1)} running hours (${Number(e.total_query_count).toLocaleString("en-US")} queries)`,
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
        `Auto-termination ${e.auto_termination_minutes ? `${e.auto_termination_minutes} minutes` : "off"}; $${Number(e.total_cost).toFixed(2)} billed on all-purpose compute over the window`,
      ]
    case "job_on_all_purpose":
      return [
        `${Number(e.task_runs).toLocaleString("en-US")} task ${Number(e.task_runs) === 1 ? "run" : "runs"} (${String(e.trigger_type).toLowerCase()}), ${tenths(e.task_hours)} hours on all-purpose compute, ${aboutTenths(e.estimated_dbus)} DBUs, most on cluster ${JSON.stringify(oneLine(e.host_cluster_name) || oneLine(e.host_cluster_id))}`,
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
  for (const what of result.limited ?? []) lines.push(`Only the first ${ROW_LIMIT.toLocaleString("en-US")} ${what} were read; any beyond them were not checked.`)
  if (report.findings.length === 0) {
    lines.push(result.skipped?.length || result.limited?.length ? "No savings found in what could be checked." : "No savings found.")
    return lines.join("\n")
  }
  lines.push(
    `Total: ${range(report.total.monthly_min, report.total.monthly_max)} a month on ${report.total.resources} resource${report.total.resources === 1 ? "" : "s"}, each counted once at its largest saving.`,
    "",
  )
  for (const finding of report.findings) {
    lines.push(
      `${oneLine(finding.resource_name) || finding.resource_id} (${finding.resource_type.replace("_", " ")}${finding.workspace_id ? `, workspace ${finding.workspace_id}` : ""}) · ${finding.title} · ${range(finding.monthly_min, finding.monthly_max)} a month (${finding.severity})`,
    )
    for (const line of evidenceLines(finding)) lines.push(`  ${line}`)
  }
  for (const option of report.what_if) {
    lines.push("", `What ${oneLine(option.resource_name) || option.resource_id} (now ${option.current_label}, ${dollars(option.current_monthly_cost)} a month) would cost instead:`)
    for (const choice of option.choices) {
      const fit = choice.fits ? "" : ` (too small: ${choice.cores} cores, its queries need ${choice.cores_needed.toFixed(0)})`
      lines.push(`  ${size(choice.label)}: ${dollars(choice.monthly_cost)} a month, saving ${dollars(choice.monthly_saving)}${fit}`)
    }
  }
  return lines.join("\n")
}

export const FinopsDatabricksSavingsTool = Tool.define("finops_databricks_savings", {
  description:
    "Check a Databricks workspace for savings with Altimate's rules: SQL warehouses that would cost less as serverless or smaller, idle all-purpose clusters, and scheduled or continuous jobs running on all-purpose clusters. Read-only queries over seven days of system tables (billing, compute, query history, jobs), covering every workspace those tables show, on the connection's SQL warehouse, which Databricks starts if it is stopped. Returns each finding with its monthly dollar range and evidence, and what each flagged warehouse would cost at other sizes. Ask the user before running it, and pass confirm: true once they agree; without it nothing runs.",
  parameters: z.object({
    warehouse: z
      .string()
      .optional()
      .describe(
        "Databricks connection name. Optional — omit to use the first configured Databricks connection whose http_path names a SQL warehouse.",
      ),
    confirm: z
      .boolean()
      .optional()
      .describe(
        `Set to true only after the user has agreed to run the check. It runs three queries on their SQL warehouse, which Databricks starts if it is stopped and bills while it runs; the check stops after ${SAVINGS_RUN_LIMIT_MINUTES} minutes, cancelling any query still running.`,
      ),
  }),
  async execute(args, ctx) {
    if (args.confirm !== true) {
      // Asking first is the expected first step, not a failed run.
      return {
        title: "Databricks Savings: not run, needs the user's go-ahead",
        metadata: { success: true, needs_confirmation: true } as SavingsMetadata,
        output:
          "Not run. The Databricks savings check runs three queries over seven days of system tables on the connection's SQL warehouse, " +
          `which Databricks starts if it is stopped and bills while it runs. It stops after ${SAVINGS_RUN_LIMIT_MINUTES} minutes, cancelling any query still running. ` +
          "Ask the user whether to run it; if they agree, call this tool again with confirm: true.",
      }
    }
    try {
      const result = await Dispatcher.call(
        "finops.databricks_savings",
        { warehouse: args.warehouse },
        { signal: ctx.abort, sessionID: ctx.sessionID },
      )
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
          workspaces_checked: result.workspaces_checked,
          warehouses_checked: result.warehouses_checked,
          clusters_checked: result.clusters_checked,
          jobs_checked: result.jobs_checked,
          skipped: result.skipped,
          limited: result.limited,
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
