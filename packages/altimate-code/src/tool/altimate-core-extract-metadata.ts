import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const AltimateCoreExtractMetadataTool = Tool.define("altimate_core_extract_metadata", {
  description:
    "Extract metadata from SQL using the Rust-based altimate-core engine. Identifies tables, columns, functions, CTEs, and other structural elements referenced in a query.",
  parameters: z.object({
    sql: z.string().describe("SQL query to extract metadata from"),
    dialect: z.string().optional().describe("SQL dialect (e.g. snowflake, bigquery, postgres)"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("altimate_core.metadata", {
        sql: args.sql,
        dialect: args.dialect ?? "",
      })
      const data = result.data as Record<string, any>
      return {
        title: `Metadata: ${data.tables?.length ?? 0} tables, ${data.columns?.length ?? 0} columns`,
        metadata: { success: result.success },
        output: formatMetadata(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Metadata: ERROR", metadata: { success: false }, output: `Failed: ${msg}` }
    }
  },
})

function formatMetadata(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  const lines: string[] = []
  if (data.tables?.length) {
    lines.push("Tables:")
    for (const t of data.tables) lines.push(`  - ${t}`)
  }
  if (data.columns?.length) {
    lines.push("\nColumns:")
    for (const c of data.columns) lines.push(`  - ${c}`)
  }
  if (data.functions?.length) {
    lines.push("\nFunctions:")
    for (const f of data.functions) lines.push(`  - ${f}`)
  }
  if (data.ctes?.length) {
    lines.push("\nCTEs:")
    for (const c of data.ctes) lines.push(`  - ${c}`)
  }
  return lines.length ? lines.join("\n") : "No metadata extracted."
}
