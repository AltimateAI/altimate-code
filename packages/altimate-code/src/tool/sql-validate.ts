import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const SqlValidateTool = Tool.define("sql_validate", {
  description:
    "Validate SQL syntax and structure. Checks for parse errors, invalid references, and structural issues.",
  parameters: z.object({
    sql: z.string().describe("SQL query to validate"),
    dialect: z
      .string()
      .optional()
      .describe(
        "SQL dialect (e.g. snowflake, bigquery, postgres, databricks, redshift) — auto-detected from warehouse connections if omitted",
      ),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("sqlguard.validate", {
        sql: args.sql,
        schema_context: args.schema_context,
      })
      const data = result.data as Record<string, any>
      return {
        title: `Validate: ${data.valid ? "VALID" : "INVALID"}`,
        metadata: { success: result.success, valid: data.valid },
        output: formatValidate(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Validate: ERROR",
        metadata: { success: false, valid: false },
        output: `Failed to validate SQL: ${msg}`,
      }
    }
  },
})

function formatValidate(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  if (data.valid) return "SQL is valid."

  const lines = ["Validation failed:\n"]
  for (const err of data.errors ?? []) {
    lines.push(`  - ${err.message}`)
    if (err.location) lines.push(`    at line ${err.location.line}`)
  }
  return lines.join("\n")
}
