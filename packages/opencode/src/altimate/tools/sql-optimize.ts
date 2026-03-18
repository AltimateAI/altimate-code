import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import type { SqlOptimizeResult, SqlOptimizeSuggestion, SqlAntiPattern } from "../native/types"

export const SqlOptimizeTool = Tool.define("sql_optimize", {
  description:
    "Optimize a SQL query for better performance. Applies sqlglot optimizer passes (simplification, CTE elimination, subquery merging) and detects anti-patterns with concrete rewrite suggestions. Returns optimized SQL when improvements are found.",
  parameters: z.object({
    sql: z.string().describe("SQL query to optimize"),
    dialect: z
      .string()
      .optional()
      .default("snowflake")
      .describe("SQL dialect (snowflake, postgres, bigquery, duckdb, etc.)"),
    schema_context: z
      .record(z.string(), z.any())
      .optional()
      .describe(
        'Optional schema mapping for full optimization. Format: {"table_name": {"col_name": "TYPE", ...}}',
      ),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("sql.optimize", {
        sql: args.sql,
        dialect: args.dialect,
        ...(args.schema_context ? { schema_context: args.schema_context } : {}),
      })

      const suggestionCount = result.suggestions.length
      const antiPatternCount = result.anti_patterns.length

      return {
        title: `Optimize: ${result.success ? `${suggestionCount} suggestion${suggestionCount !== 1 ? "s" : ""}, ${antiPatternCount} anti-pattern${antiPatternCount !== 1 ? "s" : ""}` : "PARSE ERROR"} [${result.confidence}]`,
        metadata: {
          success: result.success,
          suggestionCount,
          antiPatternCount,
          hasOptimizedSql: !!result.optimized_sql,
          confidence: result.confidence,
        },
        output: formatOptimization(result),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Optimize: ERROR",
        metadata: { success: false, suggestionCount: 0, antiPatternCount: 0, hasOptimizedSql: false, confidence: "unknown" },
        output: `Failed to optimize SQL: ${msg}\n\nCheck your connection configuration and try again.`,
      }
    }
  },
})

function impactBadge(impact: string): string {
  switch (impact) {
    case "high":
      return "HIGH"
    case "medium":
      return "MED"
    case "low":
      return "LOW"
    default:
      return impact.toUpperCase()
  }
}

function formatSuggestion(s: SqlOptimizeSuggestion, index: number): string[] {
  const lines: string[] = []
  lines.push(`  ${index + 1}. [${impactBadge(s.impact)}] ${s.type}: ${s.description}`)
  if (s.before) {
    lines.push(`     Before: ${s.before}`)
  }
  if (s.after) {
    lines.push(`     After:  ${s.after}`)
  }
  return lines
}

function formatOptimization(result: SqlOptimizeResult): string {
  if (!result.success) {
    return `Optimization failed: ${result.error ?? "Unknown error"}`
  }

  const lines: string[] = []

  // Summary header
  const suggestionCount = result.suggestions.length
  const antiPatternCount = result.anti_patterns.length

  if (suggestionCount === 0 && antiPatternCount === 0) {
    lines.push("No optimization opportunities found. The query looks good.")
    return lines.join("\n")
  }

  lines.push(
    `Found ${suggestionCount} optimization suggestion${suggestionCount !== 1 ? "s" : ""} and ${antiPatternCount} anti-pattern${antiPatternCount !== 1 ? "s" : ""} (confidence: ${result.confidence})`,
  )
  lines.push("")

  // Optimized SQL
  if (result.optimized_sql) {
    lines.push("=== Optimized SQL ===")
    lines.push(result.optimized_sql)
    lines.push("")
  }

  // Suggestions grouped by impact
  if (result.suggestions.length > 0) {
    lines.push("=== Suggestions ===")

    const high = result.suggestions.filter((s) => s.impact === "high")
    const medium = result.suggestions.filter((s) => s.impact === "medium")
    const low = result.suggestions.filter((s) => s.impact === "low")

    let idx = 0

    if (high.length > 0) {
      lines.push("")
      lines.push("  High Impact:")
      for (const s of high) {
        lines.push(...formatSuggestion(s, idx++))
      }
    }

    if (medium.length > 0) {
      lines.push("")
      lines.push("  Medium Impact:")
      for (const s of medium) {
        lines.push(...formatSuggestion(s, idx++))
      }
    }

    if (low.length > 0) {
      lines.push("")
      lines.push("  Low Impact:")
      for (const s of low) {
        lines.push(...formatSuggestion(s, idx++))
      }
    }

    lines.push("")
  }

  // Anti-patterns summary
  if (result.anti_patterns.length > 0) {
    lines.push("=== Anti-Patterns Detected ===")
    for (const ap of result.anti_patterns) {
      const loc = ap.location ? ` — ${ap.location}` : ""
      const conf = ap.confidence !== "high" ? ` [${ap.confidence} confidence]` : ""
      lines.push(`  [${(ap.severity ?? "warning").toUpperCase()}] ${ap.type}${conf}`)
      lines.push(`    ${ap.message}${loc}`)
      lines.push(`    -> ${ap.recommendation}`)
      lines.push("")
    }
  }

  return lines.join("\n")
}
