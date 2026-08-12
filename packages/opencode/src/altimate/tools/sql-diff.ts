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
      // Native handler contract (sql/register.ts): { success, diff,
      // equivalence_assessed, equivalent, decidable, equivalence_confidence,
      // differences, error? }. The previous wrapper read fields the handler
      // never returns (has_changes/unified_diff/similarity), so every
      // comparison fell into the "no changes" branch.
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
      // Assessment state comes from the HANDLER (it knows whether the schema
      // actually resolved and the check ran) — not from whether the caller
      // passed a schema object. And `equivalent` is only trustworthy when the
      // engine says `decidable: true`; an undecidable result is unproven, never
      // "equivalent".
      // decidable !== true means the engine ABSTAINED (parse/plan failure) —
      // that is UNDECIDABLE regardless of what `equivalent` says; "not proven"
      // is only claimed when the engine decidably adjudicates equivalent=false.
      const equivalenceLine =
        result.equivalence_assessed !== true
          ? "Semantic equivalence: not assessed (pass schema_context to enable)"
          : result.decidable !== true
            ? "Semantic equivalence: UNDECIDABLE — the engine could not decide; treat as unproven"
            : result.equivalent === true
              ? `Semantic equivalence: equivalent (confidence ${result.equivalence_confidence ?? "unknown"})`
              : "Semantic equivalence: not proven"
      // Consumers gating on metadata.equivalent must never see `true` unless
      // the engine both ran AND decided — an undecidable true is not a proof.
      const provenEquivalent =
        result.equivalence_assessed === true && result.equivalent === true && result.decidable === true
      const equivMeta = {
        equivalence_assessed: result.equivalence_assessed === true,
        equivalent: provenEquivalent,
        decidable: result.decidable === true,
      }

      if (!changeCount) {
        return {
          title: "Diff: no text changes",
          metadata: { has_changes: false, change_count: 0, ...equivMeta },
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
        metadata: { has_changes: true, change_count: changeCount, ...equivMeta },
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
