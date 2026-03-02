import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"
import type { SqlExplainResult } from "../bridge/protocol"

export const SqlExplainTool = Tool.define("sql_explain", {
  description:
    "Run EXPLAIN on a SQL query to get the execution plan. Shows how the database engine will process the query — useful for diagnosing slow queries, identifying full table scans, and understanding join strategies. Requires a warehouse connection.",
  parameters: z.object({
    sql: z.string().describe("SQL query to explain"),
    warehouse: z.string().optional().describe("Warehouse connection name"),
    analyze: z.boolean().optional().default(false).describe("Run EXPLAIN ANALYZE (actually executes the query, slower but more accurate)"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("sql.explain", {
        sql: args.sql,
        warehouse: args.warehouse,
        analyze: args.analyze,
      })

      if (!result.success) {
        return {
          title: "Explain: FAILED",
          metadata: { success: false, analyzed: false, warehouse_type: result.warehouse_type ?? "unknown" },
          output: `Failed to get execution plan: ${result.error ?? "Unknown error"}`,
        }
      }

      return {
        title: `Explain: ${result.analyzed ? "ANALYZE" : "PLAN"} [${result.warehouse_type ?? "unknown"}]`,
        metadata: { success: true, analyzed: result.analyzed, warehouse_type: result.warehouse_type ?? "unknown" },
        output: formatPlan(result),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Explain: ERROR",
        metadata: { success: false, analyzed: false, warehouse_type: "unknown" },
        output: `Failed to run EXPLAIN: ${msg}\n\nEnsure a warehouse connection is configured and the Python bridge is running.`,
      }
    }
  },
})

function formatPlan(result: SqlExplainResult): string {
  const lines: string[] = []
  lines.push(`Warehouse type: ${result.warehouse_type}`)
  lines.push(`Mode: ${result.analyzed ? "EXPLAIN ANALYZE (actual execution)" : "EXPLAIN (estimated plan)"}`)
  lines.push("")
  lines.push("=== Execution Plan ===")
  lines.push(result.plan_text ?? "(no plan)")
  return lines.join("\n")
}
