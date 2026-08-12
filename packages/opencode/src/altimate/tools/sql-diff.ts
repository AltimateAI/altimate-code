import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

export const SqlDiffTool = Tool.define("sql_diff", {
  description:
    "Compare two SQL queries and show the differences. Returns a line diff, plus a semantic-equivalence assessment when schema_context is provided (equivalence needs schema to resolve table/column references). Useful for reviewing suggested changes before applying them.",
  parameters: z.object({
    original: z.string().describe("The original SQL"),
    modified: z.string().describe("The modified SQL"),
    context_lines: z.number().optional().default(3).describe("Number of context lines around changes"),
    schema_context: z
      .record(z.string(), z.any())
      .optional()
      .describe("Inline schema definition — required for the semantic-equivalence assessment"),
    dialect: z.string().optional().describe("SQL dialect hint for equivalence (e.g. snowflake, bigquery)"),
  }),
  async execute(args, ctx) {
    try {
      // Native handler contract (sql/register.ts): { success, diff, equivalent,
      // equivalence_confidence, differences, error? }. The previous wrapper read
      // fields the handler never returns (has_changes/unified_diff/similarity),
      // so every comparison fell into the "no changes" branch. The handler only
      // runs the equivalence check when schema_context is present.
      const hasSchema = !!(args.schema_context && Object.keys(args.schema_context).length > 0)
      const result = (await Dispatcher.call("sql.diff", {
        original: args.original,
        modified: args.modified,
        context_lines: args.context_lines,
        schema_context: args.schema_context,
        dialect: args.dialect,
      })) as Record<string, any>

      if (result.success === false) {
        const error = String(result.error ?? "Unknown error")
        return {
          title: "Diff: ERROR",
          metadata: { has_changes: false, change_count: 0, error },
          output: `Failed to diff SQL: ${error}`,
        }
      }

      const diffText = typeof result.diff === "string" ? result.diff : ""
      const changeCount = diffText.length ? diffText.split("\n").filter((l) => /^[+-]/.test(l)).length : 0
      const differences: any[] = Array.isArray(result.differences) ? result.differences : []
      // Without a schema the handler never runs the equivalence check — saying
      // "not proven" there would misrepresent an unassessed comparison.
      const equivalenceLine = !hasSchema
        ? "Semantic equivalence: not assessed (pass schema_context to enable)"
        : result.equivalent === true
          ? `Semantic equivalence: equivalent (confidence ${result.equivalence_confidence ?? "unknown"})`
          : "Semantic equivalence: not proven"

      if (!changeCount) {
        return {
          title: "Diff: no text changes",
          metadata: { has_changes: false, change_count: 0, equivalent: result.equivalent },
          output: `The two SQL queries are textually identical.\n${equivalenceLine}`,
        }
      }

      const lines: string[] = []
      lines.push(`${changeCount} changed line${changeCount !== 1 ? "s" : ""}`)
      lines.push(equivalenceLine)
      if (differences.length) {
        lines.push("Differences:")
        for (const d of differences.slice(0, 10)) lines.push(`  - ${d?.description ?? d}`)
      }
      lines.push("")
      lines.push(diffText)

      return {
        title: `Diff: ${changeCount} changed line${changeCount !== 1 ? "s" : ""}`,
        metadata: { has_changes: true, change_count: changeCount, equivalent: result.equivalent },
        output: lines.join("\n"),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Diff: ERROR",
        metadata: { has_changes: false, change_count: 0, error: msg },
        output: `Failed to diff SQL: ${msg}`,
      }
    }
  },
})
