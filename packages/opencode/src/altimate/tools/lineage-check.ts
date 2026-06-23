import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import type { LineageCheckResult } from "../native/types"
import { isRecord, normalizeError } from "./response-normalization"

export const LineageCheckTool = Tool.define("lineage_check", {
  description:
    "Check column-level lineage for a SQL query using the Rust-based altimate-core engine. Traces how source columns flow through transformations to output columns. Useful for impact analysis and understanding data flow.",
  parameters: z.object({
    sql: z.string().describe("SQL query to trace lineage for"),
    dialect: z
      .string()
      .optional()
      .default("snowflake")
      .describe("SQL dialect (snowflake, postgres, bigquery, duckdb, etc.)"),
    schema_context: z
      .record(z.string(), z.array(z.object({ name: z.string(), data_type: z.string() })))
      .optional()
      .describe("Schema context mapping table names to column definitions for accurate lineage"),
  }),
  async execute(args, ctx) {
    try {
      const rawResult = (await Dispatcher.call("lineage.check", {
        sql: args.sql,
        dialect: args.dialect,
        schema_context: args.schema_context,
      })) as unknown

      if (!isRecord(rawResult)) {
        return lineageError("Invalid lineage response from dispatcher.")
      }

      const result = rawResult as Partial<LineageCheckResult>

      const data = isRecord(result.data) ? result.data : {}
      const responseError = normalizeError(result.error)
      if (responseError !== undefined) {
        return lineageError(responseError.trim() || "Lineage check failed.")
      }

      const error = normalizeError(data.error)
      // Treat the result as OK only when both the envelope and the inner payload
      // report success, matching the two-layer check used by sql_analyze.
      const success = result.success === true && data.success !== false
      return {
        title: `Lineage: ${success ? "OK" : "PARTIAL"}`,
        metadata: { success, ...(error && { error }) },
        output: formatLineage(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return lineageError(msg)
    }
  },
})

function lineageError(msg: string) {
  return {
    title: "Lineage: ERROR",
    metadata: { success: false, error: msg },
    output: `Failed to check lineage: ${msg}\n\nEnsure the dispatcher is running and altimate-core is initialized.`,
  }
}

function formatLineage(data: Record<string, any>): string {
  const lines: string[] = []

  // column_dict: output columns -> source columns mapping
  if (data.column_dict) {
    lines.push("Column Mappings:")
    for (const [target, sources] of Object.entries(data.column_dict)) {
      lines.push(`  ${target} ← ${JSON.stringify(sources)}`)
    }
    lines.push("")
  }

  // column_lineage: detailed edge list
  if (data.column_lineage?.length) {
    lines.push("Lineage Edges:")
    for (const edge of data.column_lineage) {
      lines.push(`  ${JSON.stringify(edge)}`)
    }
  }

  if (lines.length === 0) {
    lines.push(JSON.stringify(data, null, 2))
  }

  return lines.join("\n")
}
