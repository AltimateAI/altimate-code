import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import type { SqlAnalyzeResult } from "../native/types"

export const SqlAnalyzeTool = Tool.define("sql_analyze", {
  description:
    "Analyze SQL for anti-patterns, performance issues, and optimization opportunities. Performs static analysis without executing the query. Detects issues like SELECT *, cartesian products, missing LIMIT, function-in-filter, correlated subqueries, and more.",
  parameters: z.object({
    sql: z.string().describe("SQL query to analyze"),
    dialect: z
      .string()
      .optional()
      .default("snowflake")
      .describe("SQL dialect (snowflake, postgres, bigquery, duckdb, etc.)"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("sql.analyze", {
        sql: args.sql,
        dialect: args.dialect,
      })

      return {
        title: `Analyze: ${result.error ? "PARSE ERROR" : `${result.issue_count} issue${result.issue_count !== 1 ? "s" : ""}`} [${result.confidence}]`,
        metadata: {
          success: result.success,
          issueCount: result.issue_count,
          confidence: result.confidence,
          ...(result.error && { error: result.error }),
        },
        output: formatAnalysis(result),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Analyze: ERROR",
        metadata: { success: false, issueCount: 0, confidence: "unknown", error: msg },
        output: `Failed to analyze SQL: ${msg}\n\nCheck your connection configuration and try again.`,
      }
    }
  },
})

function formatAnalysis(result: SqlAnalyzeResult): string {
  if (result.error) {
    return `Analysis failed: ${result.error}`
  }

  if (result.issues.length === 0) {
    return "No anti-patterns or issues detected."
  }

  const lines: string[] = [`Found ${result.issue_count} issue${result.issue_count !== 1 ? "s" : ""} (confidence: ${result.confidence}):`]
  if (result.confidence_factors.length > 0) {
    lines.push(`  Note: ${result.confidence_factors.join("; ")}`)
  }
  lines.push("")

  for (const issue of result.issues) {
    const loc = issue.location ? ` — ${issue.location}` : ""
    const conf = issue.confidence !== "high" ? ` [${issue.confidence} confidence]` : ""
    lines.push(`  [${issue.severity.toUpperCase()}] ${issue.type}${conf}`)
    lines.push(`    ${issue.message}${loc}`)
    lines.push(`    → ${issue.recommendation}`)
    lines.push("")
  }

  return lines.join("\n")
}
