import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const AltimateCoreMigrationTool = Tool.define("altimate_core_migration", {
  description:
    "Analyze DDL migration safety using the Rust-based altimate-core engine. Detects potential data loss, type narrowing, missing defaults, and other risks in schema migration statements.",
  parameters: z.object({
    old_ddl: z.string().describe("Original DDL (before migration)"),
    new_ddl: z.string().describe("New DDL (after migration)"),
    dialect: z.string().optional().describe("SQL dialect (e.g. snowflake, postgres)"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("altimate_core.migration", {
        old_ddl: args.old_ddl,
        new_ddl: args.new_ddl,
        dialect: args.dialect ?? "",
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
