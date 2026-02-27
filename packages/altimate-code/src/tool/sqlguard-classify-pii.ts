import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const SqlGuardClassifyPiiTool = Tool.define("sqlguard_classify_pii", {
  description:
    "Classify PII columns in a schema using the Rust-based sqlguard engine. Identifies columns likely containing personal identifiable information by name patterns and data types.",
  parameters: z.object({
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("sqlguard.classify_pii", {
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = result.data as Record<string, any>
      const findingCount = data.findings?.length ?? 0
      return {
        title: `PII Classification: ${findingCount} finding(s)`,
        metadata: { success: result.success, finding_count: findingCount },
        output: formatClassifyPii(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "PII Classification: ERROR", metadata: { success: false, finding_count: 0 }, output: `Failed: ${msg}` }
    }
  },
})

function formatClassifyPii(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  if (!data.findings?.length) return "No PII columns detected."
  const lines = ["PII columns found:\n"]
  for (const f of data.findings) {
    lines.push(`  ${f.table}.${f.column}: ${f.category} (${f.confidence} confidence)`)
  }
  return lines.join("\n")
}
