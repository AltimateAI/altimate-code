import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

export const AltimateCoreGradeTool = Tool.define("altimate_core_grade", {
  description:
    "Grade SQL quality on an A-F scale using the Rust-based altimate-core engine. Evaluates readability, performance, correctness, and best practices to produce an overall quality grade.",
  parameters: z.object({
    sql: z.string().describe("SQL query to grade"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("altimate_core.grade", {
        sql: args.sql,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = result.data as Record<string, any>
      const grade = data.overall_grade ?? data.grade
      const score = data.scores?.overall != null ? Math.round(data.scores.overall * 100) : data.score
      return {
        title: `Grade: ${grade ?? "?"}`,
        metadata: { success: result.success, grade, score },
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
  const grade = data.overall_grade ?? data.grade
  lines.push(`Grade: ${grade}`)
  const scores = data.scores
  if (scores) {
    const overall = scores.overall != null ? Math.round(scores.overall * 100) : null
    if (overall != null) lines.push(`Score: ${overall}/100`)
    lines.push("\nCategory scores:")
    if (scores.syntax != null) lines.push(`  syntax: ${Math.round(scores.syntax * 100)}/100`)
    if (scores.style != null) lines.push(`  style: ${Math.round(scores.style * 100)}/100`)
    if (scores.safety != null) lines.push(`  safety: ${Math.round(scores.safety * 100)}/100`)
    if (scores.complexity != null) lines.push(`  complexity: ${Math.round(scores.complexity * 100)}/100`)
  } else if (data.score != null) {
    lines.push(`Score: ${data.score}/100`)
  }
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
