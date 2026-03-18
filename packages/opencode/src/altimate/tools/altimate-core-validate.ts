import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

export const AltimateCoreValidateTool = Tool.define("altimate_core_validate", {
  description:
    "Validate SQL syntax and schema references using the Rust-based altimate-core engine. Checks if tables/columns exist in the schema and if SQL is valid for the target dialect.",
  parameters: z.object({
    sql: z.string().describe("SQL query to validate"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("altimate_core.validate", {
        sql: args.sql,
        schema_path: args.schema_path ?? "",
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
      return { title: "Validate: ERROR", metadata: { success: false, valid: false }, output: `Failed: ${msg}` }
    }
  },
})

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
