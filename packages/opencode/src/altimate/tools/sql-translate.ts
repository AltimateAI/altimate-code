import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import type { SqlTranslateResult } from "../native/types"

export const SqlTranslateTool = Tool.define("sql_translate", {
  description:
    "Translate SQL from one database dialect to another (e.g., Snowflake to PostgreSQL, BigQuery to Snowflake, MySQL to PostgreSQL). Supports all major dialects: snowflake, bigquery, postgres, mysql, tsql, hive, spark, databricks, redshift, duckdb, and more.",
  parameters: z.object({
    sql: z.string().describe("SQL query to translate"),
    source_dialect: z
      .string()
      .describe("Source SQL dialect (e.g., snowflake, bigquery, postgres, mysql, tsql, redshift, duckdb)"),
    target_dialect: z
      .string()
      .describe("Target SQL dialect (e.g., snowflake, bigquery, postgres, mysql, tsql, redshift, duckdb)"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("sql.translate", {
        sql: args.sql,
        source_dialect: args.source_dialect,
        target_dialect: args.target_dialect,
      })

      return {
        title: `Translate: ${args.source_dialect} → ${args.target_dialect} [${result.success ? "OK" : "FAIL"}]`,
        metadata: {
          success: result.success,
          source_dialect: result.source_dialect,
          target_dialect: result.target_dialect,
          warningCount: result.warnings.length,
        },
        output: formatTranslation(result, args.sql),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: `Translate: ERROR`,
        metadata: { success: false, source_dialect: args.source_dialect, target_dialect: args.target_dialect, warningCount: 0 },
        output: `Failed to translate SQL: ${msg}\n\nCheck your connection configuration and try again.`,
      }
    }
  },
})

function formatTranslation(result: SqlTranslateResult, originalSql: string): string {
  if (!result.success) {
    return `Translation failed: ${result.error ?? "Unknown error"}`
  }

  const lines: string[] = []

  lines.push(`Source dialect: ${result.source_dialect}`)
  lines.push(`Target dialect: ${result.target_dialect}`)
  lines.push("")

  lines.push("--- Original SQL ---")
  lines.push(originalSql.trim())
  lines.push("")

  lines.push("--- Translated SQL ---")
  lines.push(result.translated_sql ?? "")
  lines.push("")

  if (result.warnings.length > 0) {
    lines.push("--- Warnings ---")
    for (const warning of result.warnings) {
      lines.push(`  ! ${warning}`)
    }
    lines.push("")
  }

  return lines.join("\n")
}
