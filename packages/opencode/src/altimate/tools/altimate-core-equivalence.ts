import z from "zod"
import { Tool } from "../../tool/tool"
import { Bridge } from "../bridge/client"

export const AltimateCoreEquivalenceTool = Tool.define("altimate_core_equivalence", {
  description:
    "Check semantic equivalence of two SQL queries using the Rust-based altimate-core engine. Determines if two queries produce the same result set regardless of syntactic differences.",
  parameters: z.object({
    sql1: z.string().describe("First SQL query"),
    sql2: z.string().describe("Second SQL query"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("altimate_core.equivalence", {
        sql1: args.sql1,
        sql2: args.sql2,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = result.data as Record<string, any>
      return {
        title: `Equivalence: ${data.equivalent ? "EQUIVALENT" : "DIFFERENT"}`,
        metadata: { success: result.success, equivalent: data.equivalent },
        output: formatEquivalence(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Equivalence: ERROR", metadata: { success: false, equivalent: false }, output: `Failed: ${msg}` }
    }
  },
})

function formatEquivalence(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  const lines: string[] = []
  lines.push(data.equivalent ? "Queries are semantically equivalent." : "Queries produce different results.")
  if (data.differences?.length) {
    lines.push("\nDifferences:")
    for (const d of data.differences) {
      lines.push(`  - ${d.description ?? d}`)
    }
  }
  if (data.confidence) lines.push(`\nConfidence: ${data.confidence}`)
  return lines.join("\n")
}
