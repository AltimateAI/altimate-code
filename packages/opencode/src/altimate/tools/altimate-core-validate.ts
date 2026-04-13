import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import type { Telemetry } from "../telemetry"

export const AltimateCoreValidateTool = Tool.define("altimate_core_validate", {
  description:
    "Validate SQL syntax and schema references. Checks if tables/columns exist in the schema and if SQL is valid for the target dialect. If no schema_path or schema_context is provided, validation still runs but schema-dependent checks (table/column existence) are skipped — syntax and dialect checks still apply. For full validation, run `schema_inspect` first on the referenced tables or pass `schema_context` inline.",
  parameters: z.object({
    sql: z.string().describe("SQL query to validate"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, _ctx) {
    const hasSchema = !!(args.schema_path || (args.schema_context && Object.keys(args.schema_context).length > 0))
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
        title: `Validate: ${data.valid ? "VALID" : "INVALID"}${hasSchema ? "" : " (no schema)"}`,
        metadata: {
          success: true, // engine ran — validation errors are findings, not failures
          valid: data.valid,
          has_schema: hasSchema,
          ...(error && { error }),
          ...(findings.length > 0 && { findings }),
        },
        output: formatValidate(data, hasSchema),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Validate: ERROR",
        metadata: { success: false, valid: false, has_schema: hasSchema, error: msg, error_class: "engine_failure" },
        output: `Failed: ${msg}`,
      }
    }
  },
})

// Exported for unit tests.
export const _altimateCoreValidateInternal = {
  extractValidationErrors,
  classifyValidationError,
  formatValidate,
}

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

// Warning appended when validation runs without a schema. Stored without a
// leading blank so it can be pushed into a line array; a blank line is added
// explicitly at each call site where spacing is desired.
//
// The hint uses the flat table-map shape accepted by the tool (see
// schema-resolver.ts), not the verbose SchemaDefinition form — callers that
// already know the inner Rust struct layout can use either, but the flat form
// is strictly easier to construct inline.
const NO_SCHEMA_NOTE =
  "Note: No schema was provided, so table/column existence checks were skipped. " +
  "To catch missing tables or columns, run `schema_inspect` on the referenced tables first " +
  'or pass `schema_context` inline as a table map, for example `{ users: { id: "INTEGER", email: "VARCHAR" } }`.'

function formatValidate(data: Record<string, any>, hasSchema: boolean): string {
  if (data.error) return `Error: ${data.error}`
  if (data.valid) {
    return hasSchema ? "SQL is valid." : `SQL is valid.\n\n${NO_SCHEMA_NOTE}`
  }

  const lines = ["Validation failed:\n"]
  for (const err of data.errors ?? []) {
    lines.push(`  • ${err.message}`)
    if (err.location) lines.push(`    at line ${err.location.line}`)
  }
  if (!hasSchema) {
    // Blank separator line, then the note — avoids the double newline that
    // would appear if the note itself started with `\n\n` and was joined
    // with `\n`.
    lines.push("")
    lines.push(NO_SCHEMA_NOTE)
  }
  return lines.join("\n")
}
