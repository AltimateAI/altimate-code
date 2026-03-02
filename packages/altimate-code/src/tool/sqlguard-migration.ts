import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const SqlGuardMigrationTool = Tool.define("sqlguard_migration", {
  description:
    "Analyze DDL migration safety using the Rust-based sqlguard engine. Detects potential data loss, type narrowing, missing defaults, and other risks in schema migration statements.",
  parameters: z.object({
    sql: z.string().describe("DDL migration SQL to analyze"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("sqlguard.migration", {
        sql: args.sql,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = result.data as Record<string, any>
      const riskCount = data.risks?.length ?? 0
      return {
        title: `Migration: ${riskCount === 0 ? "SAFE" : `${riskCount} risk(s)`}`,
        metadata: { success: result.success, risk_count: riskCount },
        output: formatMigration(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Migration: ERROR", metadata: { success: false, risk_count: 0 }, output: `Failed: ${msg}` }
    }
  },
})

function formatMigration(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  if (!data.risks?.length) return "Migration appears safe. No risks detected."
  const lines = ["Migration risks:\n"]
  for (const r of data.risks) {
    lines.push(`  [${r.severity ?? "warning"}] ${r.type}: ${r.message}`)
    if (r.recommendation) lines.push(`    Recommendation: ${r.recommendation}`)
  }
  return lines.join("\n")
}
