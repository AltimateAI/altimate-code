import z from "zod"
import { Tool } from "../../tool/tool"
import { Bridge } from "../bridge/client"
import type { SqlExecuteResult } from "../bridge/protocol"

export const SqlExecuteTool = Tool.define("sql_execute", {
  description: "Execute SQL against a connected data warehouse. Returns results as a formatted table.",
  parameters: z.object({
    query: z.string().describe("SQL query to execute"),
    warehouse: z.string().optional().describe("Warehouse connection name"),
    limit: z.number().optional().default(100).describe("Max rows to return"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("sql.execute", {
        sql: args.query,
        warehouse: args.warehouse,
        limit: args.limit,
      })

      const output = formatResult(result)
      return {
        title: `SQL: ${args.query.slice(0, 60)}${args.query.length > 60 ? "..." : ""}`,
        metadata: { rowCount: result.row_count, truncated: result.truncated },
        output,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "SQL: ERROR",
        metadata: { rowCount: 0, truncated: false },
        output: `Failed to execute SQL: ${msg}\n\nEnsure the Python bridge is running and a warehouse connection is configured.`,
      }
    }
  },
})

function formatResult(result: SqlExecuteResult): string {
  if (result.row_count === 0) return "(0 rows)"

  const header = result.columns.join(" | ")
  const separator = result.columns.map((c) => "-".repeat(Math.max(c.length, 4))).join("-+-")
  const rows = result.rows.map((r) => r.map((v) => (v === null ? "NULL" : String(v))).join(" | ")).join("\n")

  let output = `${header}\n${separator}\n${rows}\n\n(${result.row_count} rows)`
  if (result.truncated) output += " [truncated]"
  return output
}
