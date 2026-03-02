import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"
import type { PiiDetectResult } from "../bridge/protocol"

export const SchemaDetectPiiTool = Tool.define("schema_detect_pii", {
  description:
    "Scan column names for potential PII (Personally Identifiable Information). Identifies columns likely containing SSN, email, phone, name, address, credit card, and other sensitive data. Requires schema_index to be run first.",
  parameters: z.object({
    warehouse: z.string().optional().describe("Limit scan to a specific warehouse"),
    schema_name: z.string().optional().describe("Limit scan to a specific schema"),
    table: z.string().optional().describe("Limit scan to a specific table"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("schema.detect_pii", {
        warehouse: args.warehouse,
        schema_name: args.schema_name,
        table: args.table,
      })

      if (result.finding_count === 0) {
        return {
          title: `PII Scan: no findings (${result.columns_scanned} columns)`,
          metadata: { finding_count: 0, columns_scanned: result.columns_scanned },
          output: `No PII detected in ${result.columns_scanned} columns. Ensure schema_index has been run.`,
        }
      }

      return {
        title: `PII Scan: ${result.finding_count} findings in ${result.tables_with_pii} tables`,
        metadata: { finding_count: result.finding_count, columns_scanned: result.columns_scanned },
        output: formatPii(result),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "PII Scan: ERROR",
        metadata: { finding_count: 0, columns_scanned: 0 },
        output: `Failed to scan for PII: ${msg}`,
      }
    }
  },
})

function formatPii(result: PiiDetectResult): string {
  const lines: string[] = []
  lines.push(`Scanned ${result.columns_scanned} columns, found ${result.finding_count} potential PII columns in ${result.tables_with_pii} tables.`)
  lines.push("")

  lines.push("=== By Category ===")
  for (const [cat, count] of Object.entries(result.by_category)) {
    lines.push(`  ${cat}: ${count}`)
  }
  lines.push("")

  lines.push("=== Findings ===")
  for (const f of result.findings) {
    lines.push(`  [${f.confidence}] ${f.warehouse}.${f.schema}.${f.table}.${f.column} → ${f.pii_category}`)
  }

  return lines.join("\n")
}
