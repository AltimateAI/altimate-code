import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const SqlGuardComplexityTool = Tool.define("sqlguard_complexity", {
  description:
    "Score multi-dimensional SQL complexity and estimated cloud cost using the Rust-based sqlguard engine. Returns a 0-100 score, tier classification (Trivial/Simple/Moderate/Complex/VeryComplex), and cost signals.",
  parameters: z.object({
    sql: z.string().describe("SQL query to analyze"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("sqlguard.complexity", {
        sql: args.sql,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = result.data as Record<string, any>
      return {
        title: `Complexity: ${data.score ?? "?"}/100 (${data.tier ?? "unknown"})`,
        metadata: { success: result.success, score: data.score, tier: data.tier },
        output: formatComplexity(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Complexity: ERROR", metadata: { success: false, score: null, tier: null }, output: `Failed: ${msg}` }
    }
  },
})

function formatComplexity(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  const lines: string[] = []
  lines.push(`Score: ${data.score}/100`)
  lines.push(`Tier: ${data.tier}`)
  if (data.dimensions) {
    lines.push("\nDimensions:")
    for (const [key, val] of Object.entries(data.dimensions)) {
      lines.push(`  ${key}: ${val}`)
    }
  }
  if (data.cost) {
    lines.push(`\nEstimated cost: ${JSON.stringify(data.cost)}`)
  }
  return lines.join("\n")
}
