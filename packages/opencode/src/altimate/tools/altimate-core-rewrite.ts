import z from "zod"
import { Tool } from "../../tool/tool"
import { Bridge } from "../bridge/client"

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
      const result = await Bridge.call("altimate_core.rewrite", {
        sql: args.sql,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = result.data as Record<string, any>
      const rewriteCount = data.rewrites?.length ?? (data.rewritten_sql && data.rewritten_sql !== args.sql ? 1 : 0)
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
  if (!data.rewrites?.length) {
    if (data.rewritten_sql) return `Optimized SQL:\n${data.rewritten_sql}`
    return "No rewrites suggested."
  }
  const lines: string[] = []
  if (data.rewritten_sql) {
    lines.push("Optimized SQL:")
    lines.push(data.rewritten_sql)
    lines.push("")
  }
  lines.push("Rewrites applied:")
  for (const r of data.rewrites) {
    lines.push(`  - ${r.rule ?? r.type}: ${r.explanation ?? r.description}`)
  }
  return lines.join("\n")
}
