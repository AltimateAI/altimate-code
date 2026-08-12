import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import { EngineCoerce } from "../native/engine-coerce"

export const AltimateCoreQueryPiiTool = Tool.define("altimate_core_query_pii", {
  description:
    "Analyze query-level PII exposure. Checks if a SQL query accesses columns classified as PII and reports the exposure risk. Provide schema_context or schema_path for accurate table/column resolution.",
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
      const data = (result.data ?? {}) as Record<string, any>
      const piiCols = data.pii_columns ?? data.exposures ?? []
      const exposureCount = piiCols.length
      // The engine reports unparseable SQL via data.parse_error with an empty
      // pii_columns list — that is an abstention, not a CLEAN verdict.
      const error = result.error ?? data.error ?? data.parse_error
      // Never render CLEAN when the engine call itself failed.
      const title = error
        ? "Query PII: ERROR"
        : `Query PII: ${exposureCount === 0 ? "CLEAN" : `${exposureCount} exposure(s)`}`
      return {
        title,
        // An abstention (parse_error) is a soft failure — telemetry classifies
        // on metadata.success === false, so it must not report success.
        metadata: { success: result.success && !error, exposure_count: exposureCount, ...(error && { error }) },
        output: error ? `Error: ${error}` : formatQueryPii(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Query PII: ERROR",
        metadata: { success: false, exposure_count: 0, error: msg },
        output: `Failed: ${msg}`,
      }
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
    const classification = EngineCoerce.classificationToString(e.classification ?? e.category)
    const table = e.table ?? "unknown"
    const column = e.column ?? "unknown"
    lines.push(`  ${table}.${column}: ${classification}`)
    if (e.query_targets?.length) lines.push(`    Exposed via: ${e.query_targets.join(", ")}`)
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
