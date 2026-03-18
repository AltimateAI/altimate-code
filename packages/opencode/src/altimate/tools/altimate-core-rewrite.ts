import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

export const AltimateCoreRewriteTool = Tool.define("altimate_core_rewrite", {
  description:
    "Suggest query optimization rewrites using the Rust-based altimate-core engine. Analyzes SQL and proposes concrete rewrites for better performance.",
  parameters: z.object({
    sql: z.string().describe("SQL query to optimize"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("altimate_core.rewrite", {
        sql: args.sql,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = result.data as Record<string, any>
      const suggestions = data.suggestions ?? data.rewrites ?? []
      const rewriteCount = suggestions.length || (data.rewritten_sql && data.rewritten_sql !== args.sql ? 1 : 0)
      return {
        title: `Rewrite: ${rewriteCount} suggestion(s)`,
        metadata: { success: result.success, rewrite_count: rewriteCount },
        output: formatRewrite(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Rewrite: ERROR", metadata: { success: false, rewrite_count: 0 }, output: `Failed: ${msg}` }
    }
  },
})

function formatRewrite(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  const suggestions = data.suggestions ?? data.rewrites ?? []
  if (!suggestions.length) {
    if (data.rewritten_sql) return `Optimized SQL:\n${data.rewritten_sql}`
    return "No rewrites suggested."
  }
  const lines: string[] = []
  // Use first suggestion's rewritten_sql if top-level rewritten_sql not present
  const bestSql = data.rewritten_sql ?? suggestions[0]?.rewritten_sql
  if (bestSql) {
    lines.push("Optimized SQL:")
    lines.push(bestSql)
    lines.push("")
  }
  lines.push("Rewrites applied:")
  for (const r of suggestions) {
    lines.push(`  - ${r.rule ?? r.type}: ${r.explanation ?? r.description ?? r.improvement}`)
  }
  return lines.join("\n")
}
