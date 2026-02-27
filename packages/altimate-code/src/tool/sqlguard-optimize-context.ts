import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const SqlGuardOptimizeContextTool = Tool.define("sqlguard_optimize_context", {
  description:
    "Optimize schema for LLM context window using the Rust-based sqlguard engine. Applies 5-level progressive disclosure to reduce schema size while preserving essential information.",
  parameters: z.object({
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("sqlguard.optimize_context", {
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = result.data as Record<string, any>
      return {
        title: `Optimize Context: ${data.levels?.length ?? 0} level(s)`,
        metadata: { success: result.success },
        output: formatOptimizeContext(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Optimize Context: ERROR", metadata: { success: false }, output: `Failed: ${msg}` }
    }
  },
})

function formatOptimizeContext(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  if (data.optimized) return data.optimized
  if (data.levels?.length) {
    const lines = ["Progressive disclosure levels:\n"]
    for (const level of data.levels) {
      lines.push(`  Level ${level.level}: ${level.tokens ?? "?"} tokens — ${level.description ?? ""}`)
    }
    return lines.join("\n")
  }
  return JSON.stringify(data, null, 2)
}
