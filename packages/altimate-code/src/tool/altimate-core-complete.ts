import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const AltimateCoreCompleteTool = Tool.define("altimate_core_complete", {
  description:
    "Get cursor-aware SQL completion suggestions using the Rust-based altimate-core engine. Returns table names, column names, functions, and keywords relevant to the cursor position.",
  parameters: z.object({
    sql: z.string().describe("Partial SQL query"),
    cursor_pos: z.number().describe("Cursor position (0-indexed character offset)"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("altimate_core.complete", {
        sql: args.sql,
        cursor_pos: args.cursor_pos,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = result.data as Record<string, any>
      const count = data.suggestions?.length ?? 0
      return {
        title: `Complete: ${count} suggestion(s)`,
        metadata: { success: result.success, suggestion_count: count },
        output: formatComplete(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Complete: ERROR", metadata: { success: false, suggestion_count: 0 }, output: `Failed: ${msg}` }
    }
  },
})

function formatComplete(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  if (!data.suggestions?.length) return "No completions available."
  const lines = ["Suggestions:\n"]
  for (const s of data.suggestions) {
    lines.push(`  ${s.label ?? s.text} (${s.kind ?? s.type ?? "unknown"})`)
  }
  return lines.join("\n")
}
