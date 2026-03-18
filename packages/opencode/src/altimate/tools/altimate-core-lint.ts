import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

export const AltimateCoreLintTool = Tool.define("altimate_core_lint", {
  description:
    "Lint SQL for anti-patterns using the Rust-based altimate-core engine. Catches issues like NULL comparisons, implicit casts, unused CTEs, and dialect-specific problems.",
  parameters: z.object({
    sql: z.string().describe("SQL query to lint"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("altimate_core.lint", {
        sql: args.sql,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = result.data as Record<string, any>
      return {
        title: `Lint: ${data.clean ? "CLEAN" : `${data.findings?.length ?? 0} findings`}`,
        metadata: { success: result.success, clean: data.clean },
        output: formatLint(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Lint: ERROR", metadata: { success: false, clean: false }, output: `Failed: ${msg}` }
    }
  },
})

function formatLint(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  if (!data.findings?.length) return "No issues found."
  const lines = [`Found ${data.findings.length} finding(s):\n`]
  for (const f of data.findings) {
    lines.push(`  [${f.severity}] ${f.rule}: ${f.message}`)
    if (f.location) lines.push(`    at line ${f.location.line}, col ${f.location.column}`)
    if (f.suggestion) lines.push(`    → ${f.suggestion}`)
    lines.push("")
  }
  return lines.join("\n")
}
