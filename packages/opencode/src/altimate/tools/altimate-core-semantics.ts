import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import type { Telemetry } from "../telemetry"

export const AltimateCoreSemanticsTool = Tool.define("altimate_core_semantics", {
  description:
    "Run semantic validation rules against SQL. Detects logical issues like cartesian products, wrong JOIN conditions, NULL misuse, and type mismatches that syntax checking alone misses. Provide schema_context or schema_path for accurate table/column resolution.",
  parameters: z.object({
    sql: z.string().describe("SQL query to validate semantically"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    const hasSchema = !!(args.schema_path || (args.schema_context && Object.keys(args.schema_context).length > 0))
    if (!hasSchema) {
      const error = "No schema provided. Provide schema_context or schema_path so table/column references can be resolved."
      return { title: "Semantics: NO SCHEMA", metadata: { success: false, valid: false, issue_count: 0, has_schema: false, error }, output: `Error: ${error}` }
    }
    try {
      const result = await Dispatcher.call("altimate_core.semantics", {
        sql: args.sql,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = (result.data ?? {}) as Record<string, any>
      const issueCount = data.issues?.length ?? 0
      const error = result.error ?? data.error ?? extractSemanticsErrors(data)
      const hasError = Boolean(error)
      // altimate_change start — sql quality findings for telemetry
      const issues = Array.isArray(data.issues) ? data.issues : []
      const findings: Telemetry.Finding[] = issues.map(() => ({
        category: "semantic_issue",
      }))
      // altimate_change end
      return {
        title: hasError ? "Semantics: ERROR" : `Semantics: ${data.valid ? "VALID" : `${issueCount} issues`}`,
        metadata: {
          success: true, // engine ran — semantic issues are findings, not failures
          valid: data.valid,
          issue_count: issueCount,
          has_schema: hasSchema,
          ...(error && { error }),
          ...(findings.length > 0 && { findings }),
        },
        output: formatSemantics(hasError ? { ...data, error } : data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Semantics: ERROR", metadata: { success: false, valid: false, issue_count: 0, has_schema: hasSchema, error: msg }, output: `Failed: ${msg}` }
    }
  },
})

function extractSemanticsErrors(data: Record<string, any>): string | undefined {
  if (Array.isArray(data.validation_errors) && data.validation_errors.length > 0) {
    const msgs = data.validation_errors
      .map((e: any) => (typeof e === "string" ? e : e.message ?? String(e)))
      .filter(Boolean)
    return msgs.length > 0 ? msgs.join("; ") : undefined
  }
  return undefined
}

function formatSemantics(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  if (data.valid) return "No semantic issues found."
  const lines = ["Semantic issues:\n"]
  for (const issue of data.issues ?? []) {
    lines.push(`  [${issue.severity ?? "warning"}] ${issue.rule ?? issue.type}: ${issue.message}`)
    if (issue.suggestion) lines.push(`    Fix: ${issue.suggestion}`)
  }
  return lines.join("\n")
}
