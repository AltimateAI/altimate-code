import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const SqlFormatTool = Tool.define("sql_format", {
  description:
    "Format and beautify SQL code with consistent indentation, keyword casing, and line breaks. Supports all major SQL dialects.",
  parameters: z.object({
    sql: z.string().describe("SQL to format"),
    dialect: z.string().optional().default("snowflake").describe("SQL dialect (snowflake, postgres, bigquery, duckdb, etc.)"),
    indent: z.number().optional().default(2).describe("Indentation width in spaces"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("sql.format", {
        sql: args.sql,
        dialect: args.dialect,
        indent: args.indent,
      })

      if (!result.success) {
        return {
          title: "Format: FAILED",
          metadata: { success: false, statement_count: 0 },
          output: `Failed to format SQL: ${result.error ?? "Unknown error"}`,
        }
      }

      return {
        title: `Format: ${result.statement_count} statement${result.statement_count !== 1 ? "s" : ""}`,
        metadata: { success: true, statement_count: result.statement_count },
        output: result.formatted_sql ?? "",
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Format: ERROR",
        metadata: { success: false, statement_count: 0 },
        output: `Failed to format SQL: ${msg}\n\nEnsure the Python bridge is running and altimate-engine is installed.`,
      }
    }
  },
})
