import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const AltimateCoreSchemaDiffTool = Tool.define("altimate_core_schema_diff", {
  description:
    "Diff two schemas and detect breaking changes using the Rust-based altimate-core engine. Compares old vs new schema files and identifies added, removed, and modified tables/columns.",
  parameters: z.object({
    schema1_path: z.string().optional().describe("Path to the old/baseline schema file"),
    schema2_path: z.string().optional().describe("Path to the new/changed schema file"),
    schema1_context: z.record(z.string(), z.any()).optional().describe("Inline old/baseline schema definition"),
    schema2_context: z.record(z.string(), z.any()).optional().describe("Inline new/changed schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("altimate_core.schema_diff", {
        schema1_path: args.schema1_path ?? "",
        schema2_path: args.schema2_path ?? "",
        schema1_context: args.schema1_context,
        schema2_context: args.schema2_context,
      })
      const data = result.data as Record<string, any>
      const changeCount = data.changes?.length ?? 0
      return {
        title: `Schema Diff: ${changeCount} change(s)${data.has_breaking ? " (BREAKING)" : ""}`,
        metadata: { success: result.success, change_count: changeCount, has_breaking: data.has_breaking },
        output: formatSchemaDiff(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Schema Diff: ERROR", metadata: { success: false, change_count: 0, has_breaking: false }, output: `Failed: ${msg}` }
    }
  },
})

function formatSchemaDiff(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  if (!data.changes?.length) return "Schemas are identical."
  const lines: string[] = []
  if (data.has_breaking) lines.push("WARNING: Breaking changes detected!\n")
  for (const c of data.changes) {
    const marker = c.breaking ? "BREAKING" : c.severity ?? "info"
    lines.push(`  [${marker}] ${c.type}: ${c.description ?? c.message}`)
  }
  return lines.join("\n")
}
