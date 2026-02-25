import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"
import type { SqlFixResult } from "../bridge/protocol"

export const SqlFixTool = Tool.define("sql_fix", {
  description:
    "Diagnose a SQL error and suggest fixes. Given a failing query and the error message from the database, analyzes the root cause and proposes corrections. Handles syntax errors, ambiguous columns, missing objects, type mismatches, GROUP BY issues, and more.",
  parameters: z.object({
    sql: z.string().describe("The failing SQL query"),
    error_message: z.string().describe("Error message returned by the database"),
    dialect: z.string().optional().default("snowflake").describe("SQL dialect"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("sql.fix", {
        sql: args.sql,
        error_message: args.error_message,
        dialect: args.dialect,
      })

      return {
        title: `Fix: ${result.suggestion_count} suggestion${result.suggestion_count !== 1 ? "s" : ""}${result.fixed_sql ? " + auto-fix" : ""}`,
        metadata: {
          success: result.success,
          suggestion_count: result.suggestion_count,
          has_fix: !!result.fixed_sql,
        },
        output: formatFix(result),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Fix: ERROR",
        metadata: { success: false, suggestion_count: 0, has_fix: false },
        output: `Failed to analyze error: ${msg}\n\nEnsure the Python bridge is running and altimate-engine is installed.`,
      }
    }
  },
})

function formatFix(result: SqlFixResult): string {
  const lines: string[] = []

  lines.push(`Error: ${result.error_message}`)
  lines.push("")

  if (result.fixed_sql) {
    lines.push("=== Auto-Fixed SQL ===")
    lines.push(result.fixed_sql)
    lines.push("")
  }

  if (result.suggestions.length > 0) {
    lines.push("=== Suggestions ===")
    for (const s of result.suggestions) {
      lines.push(`  [${s.type}] (${s.confidence} confidence)`)
      lines.push(`    ${s.message}`)
      if (s.fixed_sql && s.fixed_sql !== result.fixed_sql) {
        lines.push(`    Fix: ${s.fixed_sql}`)
      }
      lines.push("")
    }
  }

  return lines.join("\n")
}
