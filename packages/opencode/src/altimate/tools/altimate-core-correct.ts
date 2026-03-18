import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

export const AltimateCoreCorrectTool = Tool.define("altimate_core_correct", {
  description:
    "Iteratively correct SQL using a propose-verify-refine loop via the Rust-based altimate-core engine. More thorough than fix — applies multiple correction rounds to produce valid SQL.",
  parameters: z.object({
    sql: z.string().describe("SQL query to correct"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("altimate_core.correct", {
        sql: args.sql,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = result.data as Record<string, any>
      return {
        title: `Correct: ${data.success ? "CORRECTED" : "COULD NOT CORRECT"}`,
        metadata: { success: result.success, iterations: data.iterations },
        output: formatCorrect(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Correct: ERROR", metadata: { success: false, iterations: 0 }, output: `Failed: ${msg}` }
    }
  },
})

function formatCorrect(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  const lines: string[] = []
  if (data.corrected_sql) {
    lines.push("Corrected SQL:")
    lines.push(data.corrected_sql)
  }
  if (data.iterations) lines.push(`\nIterations: ${data.iterations}`)
  if (data.changes?.length) {
    lines.push("\nCorrections applied:")
    for (const c of data.changes) {
      lines.push(`  - ${c.description ?? c}`)
    }
  }
  if (!data.corrected_sql && !data.changes?.length) {
    lines.push("Could not correct the SQL after maximum iterations.")
  }
  return lines.join("\n")
}
