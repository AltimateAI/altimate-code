import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

export const AltimateCoreCompareTool = Tool.define("altimate_core_compare", {
  description:
    "Structurally compare two SQL queries. Identifies differences in table references, join conditions, filters, projections, and aggregations.",
  parameters: z.object({
    left_sql: z.string().describe("First SQL query"),
    right_sql: z.string().describe("Second SQL query"),
    dialect: z.string().optional().describe("SQL dialect"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("altimate_core.compare", {
        left_sql: args.left_sql,
        right_sql: args.right_sql,
        dialect: args.dialect ?? "",
      })
      const data = (result.data ?? {}) as Record<string, any>
      // Engine CompareResult: { identical, diff_count, diffs } — `differences`
      // never existed, so every comparison used to render IDENTICAL.
      const diffs = (data.diffs ?? data.differences ?? []) as any[]
      const diffCount = data.diff_count ?? diffs.length
      const error = result.error ?? data.error
      // Never render IDENTICAL when the engine call itself failed.
      const title = error
        ? "Compare: ERROR"
        : data.identical === false || diffCount > 0
          ? `Compare: ${diffCount} difference(s)`
          : "Compare: IDENTICAL"
      return {
        title,
        metadata: { success: result.success, difference_count: diffCount, ...(error && { error }) },
        output: error ? `Error: ${error}` : formatCompare(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Compare: ERROR",
        metadata: { success: false, difference_count: 0, error: msg },
        output: `Failed: ${msg}`,
      }
    }
  },
})

function formatCompare(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  // Engine DiffEntry: { change_type, description }.
  const diffs = (data.diffs ?? data.differences ?? []) as any[]
  if (!diffs.length) return "Queries are structurally identical."
  const lines = ["Structural differences:\n"]
  for (const d of diffs) {
    lines.push(`  [${d.change_type ?? d.type ?? "change"}] ${d.description ?? d.message ?? d}`)
  }
  return lines.join("\n")
}
