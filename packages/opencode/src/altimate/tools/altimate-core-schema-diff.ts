import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

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
      const result = await Dispatcher.call("altimate_core.schema_diff", {
        schema1_path: args.schema1_path ?? "",
        schema2_path: args.schema2_path ?? "",
        schema1_context: args.schema1_context,
        schema2_context: args.schema2_context,
      })
      const data = result.data as Record<string, any>
      const changeCount = data.changes?.length ?? 0
      const hasBreaking = data.has_breaking_changes ?? data.has_breaking ?? false
      return {
        title: `Schema Diff: ${changeCount} change(s)${hasBreaking ? " (BREAKING)" : ""}`,
        metadata: { success: result.success, change_count: changeCount, has_breaking: hasBreaking },
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
  const hasBreaking = data.has_breaking_changes ?? data.has_breaking ?? false
  if (hasBreaking) lines.push("WARNING: Breaking changes detected!\n")

  // Rust SchemaChange uses tagged enum: { type: "column_added", table: "...", ... }
  const breakingTypes = new Set(["table_removed", "column_removed", "column_type_changed"])
  for (const c of data.changes) {
    const isBreaking = breakingTypes.has(c.type) ||
      (c.type === "nullability_changed" && c.old_nullable && !c.new_nullable)
    const marker = isBreaking ? "BREAKING" : "info"
    const desc = formatChange(c)
    lines.push(`  [${marker}] ${desc}`)
  }

  if (data.summary) lines.push(`\nSummary: ${data.summary}`)
  return lines.join("\n")
}

function formatChange(c: Record<string, any>): string {
  switch (c.type) {
    case "table_added": return `Table '${c.table}' added`
    case "table_removed": return `Table '${c.table}' removed`
    case "column_added": return `Column '${c.table}.${c.column}' added (${c.data_type})`
    case "column_removed": return `Column '${c.table}.${c.column}' removed`
    case "column_type_changed": return `Column '${c.table}.${c.column}' type changed: ${c.old_type} → ${c.new_type}`
    case "nullability_changed": return `Column '${c.table}.${c.column}' nullability: ${c.old_nullable ? "nullable" : "not null"} → ${c.new_nullable ? "nullable" : "not null"}`
    default: return `${c.type}: ${c.description ?? c.message ?? JSON.stringify(c)}`
  }
}
