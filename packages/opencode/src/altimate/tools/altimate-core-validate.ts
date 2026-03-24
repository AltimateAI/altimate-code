import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import type { Telemetry } from "../telemetry"

export const AltimateCoreValidateTool = Tool.define("altimate_core_validate", {
  description:
    "Validate SQL syntax and schema references. Checks if tables/columns exist in the schema and if SQL is valid for the target dialect. IMPORTANT: Provide schema_context or schema_path — without schema, all table/column references will report as 'not found'.",
  parameters: z.object({
    sql: z.string().describe("SQL query to validate"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    const hasSchema = !!(args.schema_path || (args.schema_context && Object.keys(args.schema_context).length > 0))
    const noSchema = !hasSchema
    if (noSchema) {
      const error = "No schema provided. Provide schema_context or schema_path so table/column references can be resolved."
      return { title: "Validate: NO SCHEMA", metadata: { success: false, valid: false, has_schema: false, error }, output: `Error: ${error}` }
    }
    try {
      const result = await Dispatcher.call("altimate_core.validate", {
        sql: args.sql,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = (result.data ?? {}) as Record<string, any>
      const error = result.error ?? data.error ?? extractValidationErrors(data)
      // altimate_change start — sql quality findings for telemetry
      const errors = Array.isArray(data.errors) ? data.errors : []
      const findings: Telemetry.Finding[] = errors.map((err: any) => ({
        category: classifyValidationError(err.message ?? ""),
      }))
      // altimate_change end
      return {
        title: `Validate: ${data.valid ? "VALID" : "INVALID"}`,
        metadata: {
          success: true, // engine ran — validation errors are findings, not failures
          valid: data.valid,
          has_schema: hasSchema,
          ...(error && { error }),
          ...(findings.length > 0 && { findings }),
        },
        output: formatValidate(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Validate: ERROR", metadata: { success: false, valid: false, has_schema: hasSchema, error: msg }, output: `Failed: ${msg}` }
    }
  },
})

function extractValidationErrors(data: Record<string, any>): string | undefined {
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    const msgs = data.errors.map((e: any) => e.message ?? String(e)).filter(Boolean)
    return msgs.length > 0 ? msgs.join("; ") : undefined
  }
  return undefined
}

function classifyValidationError(message: string): string {
  const lower = message.toLowerCase()
  // Column check before table — "column not found in table" would match both
  if (lower.includes("column") && lower.includes("not found")) return "missing_column"
  if (lower.includes("table") && lower.includes("not found")) return "missing_table"
  if (lower.includes("syntax")) return "syntax_error"
  if (lower.includes("type")) return "type_mismatch"
  return "validation_error"
}

function formatValidate(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  if (data.valid) return "SQL is valid."

  const lines = ["Validation failed:\n"]
  for (const err of data.errors ?? []) {
    lines.push(`  • ${err.message}`)
    if (err.location) lines.push(`    at line ${err.location.line}`)
  }
  return lines.join("\n")
}
