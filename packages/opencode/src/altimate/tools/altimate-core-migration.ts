import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

export const AltimateCoreMigrationTool = Tool.define("altimate_core_migration", {
  description:
    "Analyze DDL migration safety. Detects potential data loss, type narrowing, missing defaults, and other risks in schema migration statements.",
  parameters: z.object({
    old_ddl: z.string().describe("Original DDL (before migration)"),
    new_ddl: z.string().describe("New DDL (after migration)"),
    dialect: z.string().optional().describe("SQL dialect (e.g. snowflake, postgres)"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("altimate_core.migration", {
        old_ddl: args.old_ddl,
        new_ddl: args.new_ddl,
        dialect: args.dialect ?? "",
      })
      const data = (result.data ?? {}) as Record<string, any>
      // Engine shape (MigrationResult): findings[], safe, overall_risk.
      // Informational findings carry risk "safe" — only count real risks.
      const findings = (data.findings ?? data.risks ?? []) as Array<Record<string, any>>
      const riskCount = findings.filter((f) => (f.risk ?? f.severity ?? "risk") !== "safe").length
      const error = result.error ?? data.error
      // Never render SAFE when the engine call itself failed.
      const title = error
        ? "Migration: ERROR"
        : data.safe === false || riskCount > 0
          ? `Migration: ${(data.overall_risk ?? "risk").toString().toUpperCase()} — ${riskCount} risk(s)`
          : "Migration: SAFE"
      return {
        title,
        metadata: { success: result.success, risk_count: riskCount, ...(error && { error }) },
        output: formatMigration(data, error),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Migration: ERROR",
        metadata: { success: false, risk_count: 0, error: msg },
        output: `Failed: ${msg}`,
      }
    }
  },
})

function formatMigration(data: Record<string, any>, error?: string): string {
  if (error ?? data.error) return `Error: ${error ?? data.error}`
  const findings = data.findings ?? data.risks ?? []
  if (!findings.length && data.safe !== false) return "Migration appears safe. No risks detected."
  const lines: string[] = []
  if (data.overall_risk) lines.push(`Overall risk: ${data.overall_risk}`)
  lines.push("Migration findings:\n")
  for (const r of findings) {
    lines.push(`  [${r.risk ?? r.severity ?? "warning"}] ${r.operation ?? r.type ?? "operation"}: ${r.message ?? ""}`)
    if (r.mitigation ?? r.recommendation) lines.push(`    Mitigation: ${r.mitigation ?? r.recommendation}`)
    if (r.rollback_sql) lines.push(`    Rollback: ${r.rollback_sql}`)
  }
  return lines.join("\n")
}
