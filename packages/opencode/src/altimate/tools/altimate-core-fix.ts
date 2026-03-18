import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

export const AltimateCoreFixTool = Tool.define("altimate_core_fix", {
  description:
    "Auto-fix SQL errors using the Rust-based altimate-core engine. Uses fuzzy matching and iterative re-validation to correct syntax errors, typos, and schema reference issues.",
  parameters: z.object({
    sql: z.string().describe("SQL query to fix"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
    max_iterations: z.number().optional().describe("Maximum fix iterations (default: 5)"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("altimate_core.fix", {
        sql: args.sql,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
        max_iterations: args.max_iterations ?? 5,
      })
      const data = result.data as Record<string, any>
      return {
        title: `Fix: ${data.success ? "FIXED" : "COULD NOT FIX"}`,
        metadata: { success: result.success, fixed: !!data.fixed_sql },
        output: formatFix(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Fix: ERROR", metadata: { success: false, fixed: false }, output: `Failed: ${msg}` }
    }
  },
})

function formatFix(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  const lines: string[] = []
  if (data.fixed_sql && data.fixed !== false) {
    lines.push("Fixed SQL:")
    lines.push(data.fixed_sql)
    const fixes = data.fixes_applied ?? data.changes ?? []
    if (fixes.length) {
      lines.push("\nChanges applied:")
      for (const c of fixes) {
        lines.push(`  - ${c.description ?? c.message ?? c}`)
      }
    }
  } else {
    lines.push("Could not auto-fix the SQL.")
    const unfixable = data.unfixable_errors ?? data.errors ?? []
    if (unfixable.length) {
      lines.push("\nErrors found:")
      for (const e of unfixable) {
        lines.push(`  - ${e.message ?? e.reason ?? e}`)
      }
    }
  }
  return lines.join("\n")
}
