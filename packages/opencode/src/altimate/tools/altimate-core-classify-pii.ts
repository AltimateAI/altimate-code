import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import { EngineCoerce } from "../native/engine-coerce"

/** Engine PiiReport lists EVERY column; classification "None" means not PII. */
function realPiiColumns(data: Record<string, any>): any[] {
  if (Array.isArray(data.columns)) return EngineCoerce.piiColumnsFromReport(data)
  // Legacy fallback shape.
  return ((data.findings ?? []) as any[]).filter((c) => c.classification !== "None")
}

export const AltimateCoreClassifyPiiTool = Tool.define("altimate_core_classify_pii", {
  description:
    "Classify PII columns in a schema. Identifies columns likely containing personal identifiable information by name patterns and data types. Provide schema_context or schema_path for accurate table/column resolution.",
  parameters: z.object({
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("altimate_core.classify_pii", {
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = (result.data ?? {}) as Record<string, any>
      const piiColumns = realPiiColumns(data)
      const findingCount = piiColumns.length
      const error = result.error ?? data.error
      return {
        // Never render a finding count when the engine call itself failed.
        title: error ? "PII Classification: ERROR" : `PII Classification: ${findingCount} finding(s)`,
        metadata: { success: result.success, finding_count: findingCount, ...(error && { error }) },
        output: error ? `Error: ${error}` : formatClassifyPii(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "PII Classification: ERROR",
        metadata: { success: false, finding_count: 0, error: msg },
        output: `Failed: ${msg}`,
      }
    }
  },
})

function formatClassifyPii(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  const piiColumns = realPiiColumns(data)
  if (!piiColumns.length) return "No PII columns detected."
  const lines: string[] = []
  if (data.risk_level) lines.push(`Risk level: ${data.risk_level}`)
  if (data.pii_count != null) lines.push(`PII columns: ${data.pii_count} of ${data.total_columns}`)
  lines.push("")
  lines.push("PII columns found:")
  for (const f of piiColumns) {
    const classification = EngineCoerce.classificationToString(f.classification ?? f.category)
    const confidence = f.confidence ?? "high"
    const table = f.table ?? "unknown"
    const column = f.column ?? "unknown"
    lines.push(`  ${table}.${column}: ${classification} (${confidence} confidence)`)
    if (f.suggested_masking) lines.push(`    Masking: ${f.suggested_masking}`)
  }
  return lines.join("\n")
}
