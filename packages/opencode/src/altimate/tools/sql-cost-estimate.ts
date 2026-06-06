import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import { Config } from "@/config/config"

/** Format a byte count as a human-readable string (e.g. "4.2 GB"). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown"
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB", "PB"]
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : 2)} ${units[i]}`
}

/** Format a USD cost, using more precision for small values. */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd)) return "unknown"
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

export const SqlCostEstimateTool = Tool.define("sql_cost_estimate", {
  description:
    "Estimate how much data a SQL query will scan and what it will cost — WITHOUT running it. Uses a BigQuery dry-run (exact bytes processed) where supported. Use this before running large analytical queries to avoid surprise warehouse bills. Returns 'estimation unsupported' for warehouses that cannot estimate cheaply.",
  parameters: z.object({
    query: z.string().describe("SQL query to estimate. Inline all values — bind placeholders are not supported."),
    warehouse: z
      .string()
      .optional()
      .describe("Warehouse connection name. Omit to use the first configured warehouse."),
  }),
  async execute(args, _ctx) {
    const cfg = await Config.get().catch(() => ({}) as Awaited<ReturnType<typeof Config.get>>)
    const costPerTib = cfg.governance?.cost_per_tib_usd

    const result = await Dispatcher.call("sql.estimate_cost", {
      sql: args.query,
      warehouse: args.warehouse,
      cost_per_tib_usd: costPerTib,
    })

    if (!result.supported) {
      const reason = result.error ?? result.note ?? "Cost estimation is not supported for this warehouse."
      return {
        title: "Cost estimate: unsupported",
        metadata: { supported: false, warehouse_type: result.warehouse_type, error: result.error },
        output: `Cost estimation unavailable for ${result.warehouse_type}: ${reason}`,
      }
    }

    const lines: string[] = []
    if (result.bytes_scanned != null) lines.push(`Bytes scanned (est.): ${formatBytes(result.bytes_scanned)}`)
    if (result.estimated_cost_usd != null) {
      lines.push(`Estimated cost:       ${formatCost(result.estimated_cost_usd)} (at ${formatCost(result.cost_per_tib_usd ?? 0)}/TiB)`)
    }
    if (result.note) lines.push(`Method:               ${result.note}`)

    return {
      title: `Cost estimate: ${result.estimated_cost_usd != null ? formatCost(result.estimated_cost_usd) : "n/a"}`,
      metadata: {
        supported: true,
        warehouse_type: result.warehouse_type,
        bytes_scanned: result.bytes_scanned,
        estimated_cost_usd: result.estimated_cost_usd,
      },
      output: lines.join("\n") || "No estimate available.",
    }
  },
})
