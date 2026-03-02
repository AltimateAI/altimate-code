import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const SqlGuardSemanticsTool = Tool.define("sqlguard_semantics", {
  description:
    "Run semantic validation rules against SQL using the Rust-based sqlguard engine. Detects logical issues like cartesian products, wrong JOIN conditions, NULL misuse, and type mismatches that syntax checking alone misses.",
  parameters: z.object({
    sql: z.string().describe("SQL query to validate semantically"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("sqlguard.semantics", {
        sql: args.sql,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = result.data as Record<string, any>
      const issueCount = data.issues?.length ?? 0
      return {
        title: `Semantics: ${data.valid ? "VALID" : `${issueCount} issues`}`,
        metadata: { success: result.success, valid: data.valid, issue_count: issueCount },
        output: formatSemantics(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Semantics: ERROR", metadata: { success: false, valid: false, issue_count: 0 }, output: `Failed: ${msg}` }
    }
  },
})

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
