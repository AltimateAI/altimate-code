import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"
import { formatBytes, truncateQuery } from "./finops-formatting"

function formatQueryHistory(summary: Record<string, unknown>, queries: unknown[]): string {
  const lines: string[] = []

  lines.push("Query History Summary")
  lines.push("".padEnd(50, "-"))
  lines.push(`Total queries: ${summary.query_count ?? 0}`)
  if (summary.avg_execution_time !== undefined)
    lines.push(`Avg execution time: ${Number(summary.avg_execution_time).toFixed(2)}s`)
  if (summary.total_bytes_scanned !== undefined)
    lines.push(`Total bytes scanned: ${formatBytes(Number(summary.total_bytes_scanned))}`)
  if (summary.period_days !== undefined)
    lines.push(`Period: ${summary.period_days} days`)

  const arr = Array.isArray(queries) ? queries : []
  if (arr.length === 0) {
    lines.push("")
    lines.push("No queries found.")
    return lines.join("\n")
  }

  lines.push("")
  lines.push("Recent Queries")
  lines.push("".padEnd(50, "-"))

  const header = "# | Query | Exec Time | Bytes Scanned | Status"
  const sep = "--|-------|-----------|---------------|-------"
  lines.push(header)
  lines.push(sep)

  for (let i = 0; i < arr.length; i++) {
    const q = arr[i] as Record<string, unknown>
    const queryText = truncateQuery(String(q.query_text ?? q.query ?? ""), 80)
    const execTime = q.execution_time !== undefined ? `${Number(q.execution_time).toFixed(2)}s` : "-"
    const bytesScanned = q.bytes_scanned !== undefined ? formatBytes(Number(q.bytes_scanned)) : "-"
    const queryStatus = q.status ?? q.execution_status ?? "-"
    lines.push(`${i + 1} | ${queryText} | ${execTime} | ${bytesScanned} | ${queryStatus}`)
  }

  return lines.join("\n")
}

export const FinopsQueryHistoryTool = Tool.define("finops_query_history", {
  description:
    "Fetch recent query execution history from a warehouse. Shows query text, execution time, bytes scanned, and status. Snowflake: reads from QUERY_HISTORY. PostgreSQL: reads from pg_stat_statements.",
  parameters: z.object({
    warehouse: z.string().describe("Warehouse connection name"),
    days: z.number().optional().default(7).describe("How many days of history to fetch"),
    limit: z.number().optional().default(100).describe("Maximum number of queries to return"),
    user: z.string().optional().describe("Filter to a specific user (Snowflake only)"),
    warehouse_filter: z.string().optional().describe("Filter to a specific warehouse name (Snowflake only)"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("finops.query_history", {
        warehouse: args.warehouse,
        days: args.days,
        limit: args.limit,
        user: args.user,
        warehouse_filter: args.warehouse_filter,
      })

      if (!result.success) {
        return {
          title: "Query History: FAILED",
          metadata: { success: false, query_count: 0 },
          output: `Failed to fetch query history: ${result.error ?? "Unknown error"}`,
        }
      }

      const summary = result.summary as Record<string, unknown>
      return {
        title: `Query History: ${summary.query_count ?? 0} queries (${args.days}d)`,
        metadata: { success: true, query_count: (summary.query_count as number) ?? 0 },
        output: formatQueryHistory(summary, result.queries as unknown[]),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Query History: ERROR",
        metadata: { success: false, query_count: 0 },
        output: `Failed to fetch query history: ${msg}`,
      }
    }
  },
})
