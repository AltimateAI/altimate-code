import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import type { Telemetry } from "../telemetry"

export const AltimateCoreCorrectTool = Tool.define("altimate_core_correct", {
  description:
    "Iteratively correct SQL using a propose-verify-refine loop. More thorough than fix — applies multiple correction rounds to produce valid SQL. Provide schema_context or schema_path for accurate table/column resolution.",
  parameters: z.object({
    sql: z.string().describe("SQL query to correct"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    const hasSchema = !!(args.schema_path || (args.schema_context && Object.keys(args.schema_context).length > 0))
    try {
      const result = await Dispatcher.call("altimate_core.correct", {
        sql: args.sql,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = (result.data ?? {}) as Record<string, any>
      const error = result.error ?? data.error ?? extractCorrectErrors(data)
      // altimate_change start — sql quality findings for telemetry
      const changes = Array.isArray(data.changes) ? data.changes : []
      const findings: Telemetry.Finding[] = changes.map(() => ({
        category: "correction_applied",
      }))
      // altimate_change end
      return {
        title: `Correct: ${data.success ? "CORRECTED" : "COULD NOT CORRECT"}`,
        metadata: {
          success: result.success,
          iterations: data.iterations,
          has_schema: hasSchema,
          ...(error && { error }),
          ...(findings.length > 0 && { findings }),
        },
        output: formatCorrect(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Correct: ERROR", metadata: { success: false, iterations: 0, has_schema: hasSchema, error: msg }, output: `Failed: ${msg}` }
    }
  },
})

function extractCorrectErrors(data: Record<string, any>): string | undefined {
  if (data.final_validation?.errors?.length > 0) {
    const msgs = data.final_validation.errors.map((e: any) => e.message ?? String(e)).filter(Boolean)
    if (msgs.length > 0) return msgs.join("; ")
  }
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    const msgs = data.errors.map((e: any) => e.message ?? String(e)).filter(Boolean)
    if (msgs.length > 0) return msgs.join("; ")
  }
  return undefined
}

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
