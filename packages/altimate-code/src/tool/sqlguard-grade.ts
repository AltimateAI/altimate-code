import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const SqlGuardGradeTool = Tool.define("sqlguard_grade", {
  description:
    "Grade SQL quality on an A-F scale using the Rust-based sqlguard engine. Evaluates readability, performance, correctness, and best practices to produce an overall quality grade.",
  parameters: z.object({
    sql: z.string().describe("SQL query to grade"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("sqlguard.grade", {
        sql: args.sql,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = result.data as Record<string, any>
      return {
        title: `Grade: ${data.grade ?? "?"}`,
        metadata: { success: result.success, grade: data.grade, score: data.score },
        output: formatGrade(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Grade: ERROR", metadata: { success: false, grade: null, score: null }, output: `Failed: ${msg}` }
    }
  },
})

function formatGrade(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  const lines: string[] = []
  lines.push(`Grade: ${data.grade}`)
  if (data.score != null) lines.push(`Score: ${data.score}/100`)
  if (data.categories) {
    lines.push("\nCategory scores:")
    for (const [cat, score] of Object.entries(data.categories)) {
      lines.push(`  ${cat}: ${score}`)
    }
  }
  if (data.feedback?.length) {
    lines.push("\nFeedback:")
    for (const f of data.feedback) {
      lines.push(`  - ${f}`)
    }
  }
  return lines.join("\n")
}
