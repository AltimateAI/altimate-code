import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const SqlGuardFormatTool = Tool.define("sqlguard_format", {
  description:
    "Format SQL using the Rust-based sqlguard engine. Provides fast, deterministic formatting with dialect-aware keyword casing and indentation.",
  parameters: z.object({
    sql: z.string().describe("SQL to format"),
    dialect: z.string().optional().describe("SQL dialect (e.g. snowflake, bigquery, postgres)"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("sqlguard.format", {
        sql: args.sql,
        dialect: args.dialect ?? "",
      })
      const data = result.data as Record<string, any>
      return {
        title: `Format: ${data.success !== false ? "OK" : "FAILED"}`,
        metadata: { success: result.success },
        output: formatFormat(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Format: ERROR", metadata: { success: false }, output: `Failed: ${msg}` }
    }
  },
})

function formatFormat(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  if (data.formatted_sql) return data.formatted_sql
  return "No formatted output."
}
