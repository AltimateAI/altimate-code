import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

export const SqlDiffTool = Tool.define("sql_diff", {
  description:
    "Compare two SQL queries and show the differences. Returns a unified diff, change count, and similarity score. Useful for reviewing suggested changes before applying them.",
  parameters: z.object({
    original: z.string().describe("The original SQL"),
    modified: z.string().describe("The modified SQL"),
    context_lines: z.number().optional().default(3).describe("Number of context lines around changes"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("sql.diff", {
        original: args.original,
        modified: args.modified,
        context_lines: args.context_lines,
      })

      if (!result.has_changes) {
        return {
          title: "Diff: no changes",
          metadata: { has_changes: false, change_count: 0, similarity: 1.0 },
          output: "The two SQL queries are identical.",
        }
      }

      const lines: string[] = []
      lines.push(`${result.change_count} change${result.change_count !== 1 ? "s" : ""} (+${result.additions} -${result.deletions}), ${(result.similarity * 100).toFixed(1)}% similar`)
      lines.push("")
      lines.push(result.unified_diff)

      return {
        title: `Diff: ${result.change_count} change${result.change_count !== 1 ? "s" : ""} (${(result.similarity * 100).toFixed(0)}% similar)`,
        metadata: { has_changes: true, change_count: result.change_count, similarity: result.similarity },
        output: lines.join("\n"),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Diff: ERROR",
        metadata: { has_changes: false, change_count: 0, similarity: 0 },
        output: `Failed to diff SQL: ${msg}`,
      }
    }
  },
})
