import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"
import { formatBytes, truncateQuery } from "./finops-formatting"

function formatExpensiveQueries(queries: unknown[]): string {
  const arr = Array.isArray(queries) ? queries : []
  if (arr.length === 0) return "No expensive queries found."

  const lines: string[] = []
  lines.push(`Top ${arr.length} Most Expensive Queries`)
  lines.push("".padEnd(50, "="))

  for (let i = 0; i < arr.length; i++) {
    const q = arr[i] as Record<string, unknown>
    const queryText = truncateQuery(String(q.query_text ?? q.query ?? ""), 100)
    const bytesScanned = q.bytes_scanned !== undefined ? formatBytes(Number(q.bytes_scanned)) : "-"
    const execTime = q.execution_time !== undefined ? `${Number(q.execution_time).toFixed(2)}s` : "-"
    const user = q.user_name ?? q.user ?? "-"

    lines.push(`${i + 1}. ${queryText}`)
    lines.push(`   Bytes scanned: ${bytesScanned}`)
    lines.push(`   Execution time: ${execTime}`)
    lines.push(`   User: ${user}`)
    if (q.warehouse_name) lines.push(`   Warehouse: ${q.warehouse_name}`)
    if (q.start_time) lines.push(`   Time: ${q.start_time}`)
    lines.push("")
  }

  return lines.join("\n")
}

export const FinopsExpensiveQueriesTool = Tool.define("finops_expensive_queries", {
  description:
    "Find the most expensive queries by bytes scanned. Helps identify optimization targets for cost reduction. Snowflake only.",
  parameters: z.object({
    warehouse: z.string().describe("Warehouse connection name"),
    days: z.number().optional().default(7).describe("Days of history to search"),
    limit: z.number().optional().default(20).describe("Max queries to return"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("finops.expensive_queries", {
        warehouse: args.warehouse,
        days: args.days,
        limit: args.limit,
      })

      if (!result.success) {
        return {
          title: "Expensive Queries: FAILED",
          metadata: { success: false, query_count: 0 },
          output: `Failed to find expensive queries: ${result.error ?? "Unknown error"}`,
        }
      }

      return {
        title: `Expensive Queries: ${result.query_count} found (${result.days_analyzed}d)`,
        metadata: { success: true, query_count: result.query_count },
        output: formatExpensiveQueries(result.queries as unknown[]),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Expensive Queries: ERROR",
        metadata: { success: false, query_count: 0 },
        output: `Failed to find expensive queries: ${msg}`,
      }
    }
  },
})
