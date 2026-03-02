import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"
import type { SchemaDiffResult, ColumnChange } from "../bridge/protocol"

export const SchemaDiffTool = Tool.define("schema_diff", {
  description:
    "Compare two versions of a SQL model to detect column-level breaking changes. Purely static via sqlglot — no warehouse connection needed. Detects dropped columns (BREAKING), type changes (WARNING), added columns (INFO), and renames (WARNING via Levenshtein distance).",
  parameters: z.object({
    old_sql: z.string().describe("Previous version of the SQL model"),
    new_sql: z.string().describe("New version of the SQL model"),
    dialect: z
      .string()
      .optional()
      .default("snowflake")
      .describe("SQL dialect (snowflake, postgres, bigquery, duckdb, etc.)"),
    schema_context: z
      .record(z.string(), z.any())
      .optional()
      .describe('Optional schema mapping for resolving SELECT *. Format: {"table_name": {"col_name": "TYPE", ...}}'),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("sql.schema_diff", {
        old_sql: args.old_sql,
        new_sql: args.new_sql,
        dialect: args.dialect,
        ...(args.schema_context ? { schema_context: args.schema_context } : {}),
      })

      const changeCount = result.changes.length
      const breakingCount = result.changes.filter((c) => c.severity === "breaking").length

      return {
        title: `Schema Diff: ${result.success ? `${changeCount} change${changeCount !== 1 ? "s" : ""}${breakingCount > 0 ? ` (${breakingCount} BREAKING)` : ""}` : "PARSE ERROR"}`,
        metadata: {
          success: result.success,
          changeCount,
          breakingCount,
          hasBreakingChanges: result.has_breaking_changes,
        },
        output: formatSchemaDiff(result),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Schema Diff: ERROR",
        metadata: { success: false, changeCount: 0, breakingCount: 0, hasBreakingChanges: false },
        output: `Failed to diff schema: ${msg}\n\nEnsure the Python bridge is running and altimate-engine is installed.`,
      }
    }
  },
})

function severityBadge(severity: string): string {
  switch (severity) {
    case "breaking":
      return "BREAKING"
    case "warning":
      return "WARNING"
    case "info":
      return "INFO"
    default:
      return severity.toUpperCase()
  }
}

function formatSchemaDiff(result: SchemaDiffResult): string {
  if (!result.success) {
    return `Schema diff failed: ${result.error ?? "Unknown error"}`
  }

  if (result.changes.length === 0) {
    return "No column changes detected between the two versions."
  }

  const lines: string[] = []
  const summary = result.summary

  lines.push(
    `Schema comparison: ${summary.old_column_count ?? "?"} → ${summary.new_column_count ?? "?"} columns`,
  )

  if (result.has_breaking_changes) {
    lines.push("⚠ BREAKING CHANGES DETECTED")
  }

  lines.push("")
  lines.push(`  Dropped: ${summary.dropped ?? 0} | Added: ${summary.added ?? 0} | Type Changed: ${summary.type_changed ?? 0} | Renamed: ${summary.renamed ?? 0}`)
  lines.push("")

  // Group by severity
  const breaking = result.changes.filter((c) => c.severity === "breaking")
  const warnings = result.changes.filter((c) => c.severity === "warning")
  const info = result.changes.filter((c) => c.severity === "info")

  if (breaking.length > 0) {
    lines.push("  Breaking Changes:")
    for (const c of breaking) {
      lines.push(`    [${severityBadge(c.severity)}] ${c.change_type}: ${c.message}`)
    }
    lines.push("")
  }

  if (warnings.length > 0) {
    lines.push("  Warnings:")
    for (const c of warnings) {
      lines.push(`    [${severityBadge(c.severity)}] ${c.change_type}: ${c.message}`)
      if (c.old_type && c.new_type) {
        lines.push(`      Type: ${c.old_type} → ${c.new_type}`)
      }
      if (c.new_name) {
        lines.push(`      Renamed to: ${c.new_name}`)
      }
    }
    lines.push("")
  }

  if (info.length > 0) {
    lines.push("  Info:")
    for (const c of info) {
      lines.push(`    [${severityBadge(c.severity)}] ${c.change_type}: ${c.message}`)
    }
    lines.push("")
  }

  return lines.join("\n")
}
