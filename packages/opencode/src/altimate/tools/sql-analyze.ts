import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import type { Telemetry } from "../telemetry"
import type { SqlAnalyzeResult } from "../native/types"
// altimate_change start — progressive disclosure suggestions
import { PostConnectSuggestions } from "./post-connect-suggestions"
// altimate_change end
import { isRecord, normalizeError } from "./response-normalization"

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
    const hasSchema = !!(args.schema_path || (args.schema_context && Object.keys(args.schema_context).length > 0))
    try {
      const rawResult = (await Dispatcher.call("sql.analyze", {
        sql: args.sql,
        dialect: args.dialect,
        schema_path: args.schema_path,
        schema_context: args.schema_context,
      })) as unknown

      if (!isRecord(rawResult)) {
        return analysisError(args, hasSchema, "Invalid analysis response from dispatcher.")
      }

      const envelopeError = normalizeError(rawResult.error)
      const result = (isRecord(rawResult.data) ? rawResult.data : rawResult) as Partial<SqlAnalyzeResult>

      // The handler returns success=true when analysis completes (issues are
      // reported via issues/issue_count). Only treat it as a failure when
      // there's an actual error (e.g. parse failure).
      const error = normalizeFailureMessage(result.error) ?? envelopeError
      const isRealFailure = error !== undefined || rawResult.success === false || result.success === false
      const failureMessage = error ?? "Analysis failed."
      // altimate_change start — sql quality findings for telemetry
      const findings: Telemetry.Finding[] = (result.issues ?? []).map((issue) => ({
        category: issue.rule ?? issue.type ?? "analysis_issue",
      }))
      // altimate_change end

      // altimate_change start — progressive disclosure suggestions
      let output = isRealFailure ? formatFailure(failureMessage) : formatAnalysis(result)
      const suggestion = !isRealFailure && PostConnectSuggestions.getProgressiveSuggestion("sql_analyze")
      if (suggestion) {
        output += "\n\n" + suggestion
        PostConnectSuggestions.trackSuggestions({
          suggestionType: "progressive_disclosure",
          suggestionsShown: ["schema_inspect"],
          warehouseType: "unknown",
        })
      }
      // altimate_change end
      return {
        title: `Analyze: ${isRealFailure ? "ERROR" : `${result.issue_count ?? 0} issue${(result.issue_count ?? 0) !== 1 ? "s" : ""}`} [${result.confidence ?? "unknown"}]`,
        metadata: {
          success: !isRealFailure,
          issueCount: result.issue_count,
          confidence: result.confidence,
          dialect: args.dialect,
          has_schema: hasSchema,
          ...(isRealFailure && { error: failureMessage }),
          ...(findings.length > 0 && { findings }),
        },
        output,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return analysisError(args, hasSchema, msg)
    }
  },
})

function analysisError(args: { dialect?: string }, hasSchema: boolean, msg: string) {
  return {
    title: "Analyze: ERROR",
    metadata: {
      success: false,
      issueCount: 0,
      confidence: "unknown",
      dialect: args.dialect,
      has_schema: hasSchema,
      error: msg,
    },
    output: `Failed to analyze SQL: ${msg}\n\nCheck your connection configuration and try again.`,
  }
}

function normalizeFailureMessage(value: unknown): string | undefined {
  const message = normalizeError(value)
  if (message === undefined) return undefined
  return message.trim() || undefined
}

function formatFailure(message: string): string {
  return message === "Analysis failed." ? message : `Analysis failed: ${message}`
}

function formatAnalysis(result: Partial<SqlAnalyzeResult>): string {
  const error = normalizeFailureMessage(result.error)
  if (error) {
    return formatFailure(error)
  }

  const issues = result.issues ?? []
  if (issues.length === 0) {
    return "No anti-patterns or issues detected."
  }

  const issueCount = result.issue_count ?? issues.length
  const lines: string[] = [
    `Found ${issueCount} issue${issueCount !== 1 ? "s" : ""} (confidence: ${result.confidence ?? "unknown"}):`,
  ]
  const factors = result.confidence_factors ?? []
  if (factors.length > 0) {
    lines.push(`  Note: ${factors.join("; ")}`)
  }
  lines.push("")

  for (const issue of issues) {
    const loc = issue.location ? ` — ${issue.location}` : ""
    const conf = issue.confidence !== "high" ? ` [${issue.confidence ?? "unknown"} confidence]` : ""
    lines.push(`  [${String(issue.severity ?? "unknown").toUpperCase()}] ${issue.type ?? "unknown"}${conf}`)
    lines.push(`    ${issue.message ?? ""}${loc}`)
    lines.push(`    → ${issue.recommendation ?? ""}`)
    lines.push("")
  }

  return lines.join("\n")
}
