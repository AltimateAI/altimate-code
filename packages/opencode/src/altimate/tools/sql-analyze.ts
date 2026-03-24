import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import type { Telemetry } from "../telemetry"
import type { SqlAnalyzeResult } from "../native/types"

export const SqlAnalyzeTool = Tool.define("sql_analyze", {
  description:
    "Analyze SQL for anti-patterns, performance issues, and optimization opportunities. Performs lint, semantic, and safety analysis without executing the query. Provide schema_context or schema_path for accurate semantic analysis — without schema, table/column references cannot be resolved.",
  parameters: z.object({
    sql: z.string().describe("SQL query to analyze"),
    dialect: z
      .string()
      .optional()
      .default("snowflake")
      .describe("SQL dialect (snowflake, postgres, bigquery, duckdb, etc.)"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file for table/column resolution"),
    schema_context: z
      .record(z.string(), z.any())
      .optional()
      .describe('Inline schema definition, e.g. {"table_name": {"col": "TYPE"}}'),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("sql.analyze", {
        sql: args.sql,
        dialect: args.dialect,
        schema_path: args.schema_path,
        schema_context: args.schema_context,
      })

      // The handler returns success=true when analysis completes (issues are
      // reported via issues/issue_count). Only treat it as a failure when
      // there's an actual error (e.g. parse failure).
      const isRealFailure = !!result.error
      // altimate_change start — sql quality findings for telemetry
      const findings: Telemetry.Finding[] = result.issues.map((issue) => ({
        category: issue.rule ?? issue.type,
      }))
      // altimate_change end
      return {
        title: `Analyze: ${result.error ? "ERROR" : `${result.issue_count} issue${result.issue_count !== 1 ? "s" : ""}`} [${result.confidence}]`,
        metadata: {
          success: !isRealFailure,
          issueCount: result.issue_count,
          confidence: result.confidence,
          dialect: args.dialect,
          has_schema: false,
          ...(result.error && { error: result.error }),
          ...(findings.length > 0 && { findings }),
        },
        output: formatAnalysis(result),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Analyze: ERROR",
        metadata: { success: false, issueCount: 0, confidence: "unknown", dialect: args.dialect, has_schema: false, error: msg },
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
