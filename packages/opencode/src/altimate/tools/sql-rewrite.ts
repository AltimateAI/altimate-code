import z from "zod"
import { Tool } from "../../tool/tool"
import { Bridge } from "../bridge/client"
import type { SqlRewriteResult, SqlRewriteRule } from "../bridge/protocol"

export const SqlRewriteTool = Tool.define("sql_rewrite", {
  description:
    "Rewrite SQL to fix detected anti-patterns with executable fixes. Transforms SELECT * to explicit columns (requires schema_context), non-sargable function-wrapped WHERE to range predicates, and large IN lists (20+) to CTE VALUES. All rewrites are deterministic AST transforms — no LLM.",
  parameters: z.object({
    sql: z.string().describe("SQL query to rewrite"),
    dialect: z
      .string()
      .optional()
      .default("snowflake")
      .describe("SQL dialect (snowflake, postgres, bigquery, duckdb, etc.)"),
    schema_context: z
      .record(z.string(), z.any())
      .optional()
      .describe(
        'Optional schema mapping for SELECT * expansion. Format: {"table_name": {"col_name": "TYPE", ...}}',
      ),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("sql.rewrite", {
        sql: args.sql,
        dialect: args.dialect,
        ...(args.schema_context ? { schema_context: args.schema_context } : {}),
      })

      const rewriteCount = result.rewrites_applied.length
      const autoApplyCount = result.rewrites_applied.filter((r) => r.can_auto_apply).length

      return {
        title: `Rewrite: ${result.success ? `${rewriteCount} rewrite${rewriteCount !== 1 ? "s" : ""} (${autoApplyCount} auto-applicable)` : "PARSE ERROR"}`,
        metadata: {
          success: result.success,
          rewriteCount,
          autoApplyCount,
          hasRewrittenSql: !!result.rewritten_sql,
        },
        output: formatRewrite(result),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Rewrite: ERROR",
        metadata: { success: false, rewriteCount: 0, autoApplyCount: 0, hasRewrittenSql: false },
        output: `Failed to rewrite SQL: ${msg}\n\nEnsure the Python bridge is running and altimate-engine is installed.`,
      }
    }
  },
})

function formatRewrite(result: SqlRewriteResult): string {
  if (!result.success) {
    return `Rewrite failed: ${result.error ?? "Unknown error"}`
  }

  if (result.rewrites_applied.length === 0) {
    return "No rewritable anti-patterns detected."
  }

  const lines: string[] = []
  const count = result.rewrites_applied.length
  const autoCount = result.rewrites_applied.filter((r) => r.can_auto_apply).length

  lines.push(`Applied ${count} rewrite${count !== 1 ? "s" : ""} (${autoCount} auto-applicable):`)
  lines.push("")

  for (const rule of result.rewrites_applied) {
    const badge = rule.can_auto_apply ? "AUTO" : "SUGGEST"
    lines.push(`  [${badge}] ${rule.rule}`)
    lines.push(`    ${rule.explanation}`)
    if (rule.original_fragment !== rule.rewritten_fragment) {
      lines.push(`    Before: ${rule.original_fragment}`)
      lines.push(`    After:  ${rule.rewritten_fragment}`)
    }
    lines.push("")
  }

  if (result.rewritten_sql) {
    lines.push("=== Rewritten SQL ===")
    lines.push(result.rewritten_sql)
  }

  return lines.join("\n")
}
