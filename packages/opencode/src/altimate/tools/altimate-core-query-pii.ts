import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

export const AltimateCoreQueryPiiTool = Tool.define("altimate_core_query_pii", {
  description:
    "Analyze query-level PII exposure using the Rust-based altimate-core engine. Checks if a SQL query accesses columns classified as PII and reports the exposure risk.",
  parameters: z.object({
    sql: z.string().describe("SQL query to check for PII access"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("altimate_core.query_pii", {
        sql: args.sql,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = result.data as Record<string, any>
      const piiCols = data.pii_columns ?? data.exposures ?? []
      const exposureCount = piiCols.length
      return {
        title: `Query PII: ${exposureCount === 0 ? "CLEAN" : `${exposureCount} exposure(s)`}`,
        metadata: { success: result.success, exposure_count: exposureCount },
        output: formatQueryPii(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Query PII: ERROR", metadata: { success: false, exposure_count: 0 }, output: `Failed: ${msg}` }
    }
  },
})

function formatQueryPii(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  const piiCols = data.pii_columns ?? data.exposures ?? []
  if (!piiCols.length) return "Query does not access PII columns."
  const lines: string[] = []
  if (data.risk_level) lines.push(`Risk level: ${data.risk_level}`)
  lines.push("PII exposure detected:\n")
  for (const e of piiCols) {
    const classification = e.classification ?? e.category ?? "PII"
    const table = e.table ?? "unknown"
    const column = e.column ?? "unknown"
    lines.push(`  ${table}.${column}: ${classification}`)
    if (e.suggested_masking) lines.push(`    Masking: ${e.suggested_masking}`)
  }
  if (data.suggested_alternatives?.length) {
    lines.push("\nSuggested alternatives:")
    for (const alt of data.suggested_alternatives) {
      lines.push(`  - ${alt}`)
    }
  }
  return lines.join("\n")
}
