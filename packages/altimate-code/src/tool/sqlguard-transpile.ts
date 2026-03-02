import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const SqlGuardTranspileTool = Tool.define("sqlguard_transpile", {
  description:
    "Transpile SQL between dialects using the Rust-based sqlguard engine. Supports snowflake, postgres, bigquery, databricks, duckdb, mysql, tsql, and more.",
  parameters: z.object({
    sql: z.string().describe("SQL query to transpile"),
    from_dialect: z.string().describe("Source dialect (e.g., snowflake, postgres, bigquery)"),
    to_dialect: z.string().describe("Target dialect (e.g., snowflake, postgres, bigquery)"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("sqlguard.transpile", {
        sql: args.sql,
        from_dialect: args.from_dialect,
        to_dialect: args.to_dialect,
      })
      const data = result.data as Record<string, any>
      return {
        title: `Transpile: ${args.from_dialect} → ${args.to_dialect} [${result.success ? "OK" : "FAIL"}]`,
        metadata: { success: result.success },
        output: formatTranspile(data, args.sql),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Transpile: ERROR", metadata: { success: false }, output: `Failed: ${msg}` }
    }
  },
})

function formatTranspile(data: Record<string, any>, original: string): string {
  if (data.error) return `Error: ${data.error}`

  const lines = [
    `Source: ${data.source_dialect}`,
    `Target: ${data.target_dialect}`,
    "",
    "--- Original ---",
    original.trim(),
    "",
    "--- Transpiled ---",
    data.transpiled_sql ?? "(no output)",
  ]
  return lines.join("\n")
}
