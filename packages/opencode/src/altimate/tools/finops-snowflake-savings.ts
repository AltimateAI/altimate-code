// altimate_change - new file
import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import type { SnowflakeSavingsFinding, SnowflakeSavingsReport, SnowflakeSavingsResult } from "../native/types"
import { dollars, range } from "./finops-databricks-savings"

/** One shape for every outcome, so a reader of the metadata never guesses which fields exist. */
type SavingsMetadata = {
  success: boolean
  window?: { start: string; end: string }
  warehouse?: string
  ran_on?: string
  warehouses_checked?: number
  price?: SnowflakeSavingsResult["price"]
  skipped?: { check: string; reason: string }[]
  limited?: string[]
  warehouses?: SnowflakeSavingsResult["warehouses"]
  report?: SnowflakeSavingsReport
  error?: string
  /** True when the check did not run because `confirm` was not set. */
  needs_confirmation?: boolean
}

const count = (value: unknown) => Number(value).toLocaleString("en-US")
const days = (value: unknown) => {
  const n = Array.isArray(value) ? value.length : 0
  return `${n} day${n === 1 ? "" : "s"}`
}
const hours = (seconds: unknown) => (Number(seconds) / 3_600).toFixed(1)

/** What a finding rests on, one short line each. */
export function evidenceLines(finding: SnowflakeSavingsFinding): string[] {
  const e = finding.evidence as Record<string, unknown> & { kind: string }
  switch (e.kind) {
    case "high_idle_time":
      return [
        `${Math.round(Number(e.idle_ratio) * 100)}% idle on ${days(e.flagged_days)} above 40%: ${hours(e.idle_seconds)} of ${hours(e.active_seconds)} active hours`,
        `${Number(e.credits_used).toFixed(2)} credits on those days, at $${Number(e.price_per_credit).toFixed(2)} a credit`,
      ]
    case "downsize_warehouse": {
      const signals = [
        e.short_period_percent == null ? null : `${Number(e.short_period_percent).toFixed(1)}% of its active periods lasted 80 seconds or less`,
        e.sub_five_second_percent == null
          ? null
          : `${Number(e.sub_five_second_percent).toFixed(1)}% of ${count(e.query_count)} queries ran in 5 seconds or less`,
      ].filter(Boolean)
      return [
        `${e.current_size} could be ${e.recommended_size}: ${signals.join("; ")}`,
        `The saving is a share of $${Number(e.cost_basis).toFixed(2)} over the window`,
      ]
    }
    case "underutilized_cluster":
      return [
        `Cluster ${e.cluster_number} of ${e.max_cluster_count} was barely needed on ${days(e.flagged_days)} (up to ${Number(e.highest_idle_percent).toFixed(0)}% idle)`,
        `Lowering the maximum to ${e.recommended_max_cluster_count} cluster${e.recommended_max_cluster_count === 1 ? "" : "s"} may add some queueing; no dollar estimate`,
      ]
    case "frequent_restart":
      return [
        `${count(e.bounces)} suspend-and-resume bounces inside a billed minute on ${days(e.flagged_days)}`,
        `${count(e.double_billed_seconds)} seconds billed twice at ${e.credits_per_hour} credits an hour`,
      ]
    default:
      return []
  }
}

function priceLine(result: SnowflakeSavingsResult): string {
  const price = result.price
  if (!price) return ""
  return price.source === "rate_sheet"
    ? `$${price.per_credit.toFixed(2)} a credit from the account's rate sheet`
    : `$${price.per_credit.toFixed(2)} a credit, list price (no dollar rate could be read from the account's rate sheet)`
}

function headline(report: SnowflakeSavingsReport): string {
  const { monthly_min, monthly_max, resources } = report.total
  if (resources > 0) return `${range(monthly_min, monthly_max)} a month on ${resources} warehouse${resources === 1 ? "" : "s"}`
  if (report.findings.length === 0) return "no savings found"
  return `${report.findings.length} finding${report.findings.length === 1 ? "" : "s"}, no dollar estimate`
}

export function formatSavings(result: SnowflakeSavingsResult): string {
  const report = result.report
  if (!report) return "No report."
  const checked = result.warehouses_checked ?? 0
  const lines: string[] = [
    `Snowflake savings: ${checked} warehouse${checked === 1 ? "" : "s"} checked, the ${report.lookback_days} days to ${result.window.end}, at ${priceLine(result)}.`,
  ]
  for (const one of result.skipped ?? []) lines.push(`Not checked: ${one.check} (${one.reason})`)
  for (const what of result.limited ?? []) lines.push(`Only part of the ${what} could be read; the rest was not checked.`)
  if (report.findings.length === 0) {
    lines.push(result.skipped?.length || result.limited?.length ? "No savings found in what could be checked." : "No savings found.")
    return lines.join("\n")
  }
  if (report.total.resources > 0) lines.push(`Total: ${headline(report)}, each counted once at its largest saving.`)
  lines.push("")
  for (const finding of report.findings) {
    const amount = finding.monthly_max > 0 ? `${range(finding.monthly_min, finding.monthly_max)} a month` : "no dollar estimate"
    lines.push(`${finding.resource_name} (warehouse) · ${finding.title} · ${amount} (${finding.severity})`)
    for (const line of evidenceLines(finding)) lines.push(`  ${line}`)
  }
  return lines.join("\n")
}

export const FinopsSnowflakeSavingsTool = Tool.define("finops_snowflake_savings", {
  description:
    "Check a Snowflake account for savings with Altimate's rules: warehouses that sit idle, could run one size smaller, keep an unneeded extra cluster, or restart so often they are billed twice. Read-only: SHOW WAREHOUSES plus five queries over seven days of SNOWFLAKE.ACCOUNT_USAGE and the rate sheet, on the connection's warehouse, which Snowflake resumes if it is suspended and auto-resume is on. Returns each finding with its monthly dollar range and evidence. Ask the user before running it, and pass confirm: true once they agree; without it nothing runs.",
  parameters: z.object({
    warehouse: z
      .string()
      .optional()
      .describe("Snowflake connection name. Optional — omit to use the first configured Snowflake connection."),
    confirm: z
      .boolean()
      .optional()
      .describe(
        "Set to true only after the user has agreed to run the check. It runs six queries on their Snowflake account; five use the connection's warehouse, which Snowflake resumes if it is suspended and auto-resume is on, and which bills while it runs; the check stops after 9 minutes, cancelling any query still running.",
      ),
  }),
  async execute(args, ctx) {
    if (args.confirm !== true) {
      // Asking first is the expected first step, not a failed run.
      return {
        title: "Snowflake Savings: not run, needs the user's go-ahead",
        metadata: { success: true, needs_confirmation: true } as SavingsMetadata,
        output:
          "Not run. The Snowflake savings check runs six queries over seven days of account usage; five use the connection's warehouse, " +
          "which Snowflake resumes if it is suspended and auto-resume is on, and which bills while it runs. It stops after 9 minutes, cancelling any query still running. " +
          "Ask the user whether to run it; if they agree, call this tool again with confirm: true.",
      }
    }
    try {
      const result = await Dispatcher.call(
        "finops.snowflake_savings",
        { warehouse: args.warehouse },
        { signal: ctx.abort, sessionID: ctx.sessionID },
      )
      if (!result.success || !result.report) {
        const error = result.error ?? "Unknown error"
        return {
          title: "Snowflake Savings: FAILED",
          metadata: { success: false, window: result.window, error } as SavingsMetadata,
          output: `The Snowflake savings check failed: ${error}`,
        }
      }
      return {
        title: `Snowflake Savings: ${headline(result.report)}`,
        metadata: {
          success: true,
          window: result.window,
          warehouse: result.warehouse,
          ran_on: result.ran_on,
          warehouses_checked: result.warehouses_checked,
          price: result.price,
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
        title: "Snowflake Savings: ERROR",
        metadata: { success: false, error: msg } as SavingsMetadata,
        output: `The Snowflake savings check failed: ${msg}`,
      }
    }
  },
})
