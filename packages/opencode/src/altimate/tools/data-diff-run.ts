import z from "zod"
import { Tool } from "../../tool/tool"
import { Bridge } from "../bridge/client"

export const DataDiffRunTool = Tool.define("data_diff", {
  description:
    "Run deterministic data validation between two database tables using the reladiff engine. " +
    "Compares tables row-by-row using checksums and bisection search (cross-database) or " +
    "FULL OUTER JOIN (same database). Returns a structured diff report.",
  parameters: z.object({
    source_table: z.string().describe("Source table name (without database/schema prefix)"),
    target_table: z.string().describe("Target table name (without database/schema prefix)"),
    source_warehouse: z.string().describe("Source warehouse connection name (from warehouse_list)"),
    target_warehouse: z
      .string()
      .optional()
      .describe("Target warehouse connection name. Defaults to source_warehouse if same database."),
    key_columns: z.array(z.string()).describe("Primary key column(s) that uniquely identify each row"),
    extra_columns: z
      .array(z.string())
      .optional()
      .describe("Additional columns to compare beyond the key columns"),
    algorithm: z
      .enum(["auto", "hashdiff", "joindiff", "profile", "recon", "cascade"])
      .optional()
      .default("auto")
      .describe(
        "Comparison algorithm. auto=JoinDiff if same DB, HashDiff if cross-DB. " +
          "profile=column statistics only. cascade=count→profile→content.",
      ),
    where_clause: z.string().optional().describe("Optional WHERE filter applied to both tables"),
    source_database: z.string().optional().describe("Source database/catalog name"),
    source_schema: z.string().optional().describe("Source schema name"),
    target_database: z.string().optional().describe("Target database/catalog name"),
    target_schema: z.string().optional().describe("Target schema name"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("data_diff.run", {
        source_table: args.source_table,
        target_table: args.target_table,
        source_warehouse: args.source_warehouse,
        target_warehouse: args.target_warehouse,
        key_columns: args.key_columns,
        extra_columns: args.extra_columns,
        algorithm: args.algorithm,
        where_clause: args.where_clause,
        source_database: args.source_database,
        source_schema: args.source_schema,
        target_database: args.target_database,
        target_schema: args.target_schema,
      })

      if (!result.success) {
        return {
          title: `Data Diff: FAILED`,
          metadata: { status: "error", steps: result.steps ?? 0 },
          output: `Error: ${result.error}\n\nSteps completed: ${result.steps ?? 0}`,
        }
      }

      const outcome = result.outcome ?? {}
      const output = formatOutcome(outcome, args, result.steps ?? 0)

      return {
        title: `Data Diff: ${args.source_table} ↔ ${args.target_table}`,
        metadata: { status: "completed", steps: result.steps },
        output,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Data Diff: ERROR",
        metadata: { status: "error", steps: 0 },
        output: `Failed to run data diff: ${msg}\n\nEnsure altimate-core is installed in the engine.`,
      }
    }
  },
})

function formatOutcome(outcome: Record<string, unknown>, args: Record<string, unknown>, steps: number): string {
  const mode = outcome.mode as string | undefined
  const lines: string[] = []

  lines.push("```")
  lines.push("Data Validation Report")
  lines.push("======================")
  lines.push(`Source: ${args.source_warehouse}.${args.source_table}`)
  lines.push(`Target: ${(args.target_warehouse || args.source_warehouse)}.${args.target_table}`)
  lines.push(`Algorithm: ${args.algorithm || "auto"}`)
  lines.push(`Steps: ${steps}`)
  lines.push("")

  if (mode === "diff") {
    const stats = (outcome.stats ?? {}) as Record<string, unknown>
    const diffRows = (outcome.diff_rows ?? []) as unknown[]
    const pass = diffRows.length === 0
    lines.push(`Status: ${pass ? "PASS ✓" : "FAIL ✗"}`)
    lines.push(`Rows table1: ${stats.rows_table1 ?? "?"}`)
    lines.push(`Rows table2: ${stats.rows_table2 ?? "?"}`)
    if (!pass) {
      lines.push(`Exclusive to table1: ${stats.exclusive_table1 ?? 0}`)
      lines.push(`Exclusive to table2: ${stats.exclusive_table2 ?? 0}`)
      lines.push(`Updated: ${stats.updated ?? 0}`)
      lines.push(`Diff %: ${((stats.diff_percent as number) * 100).toFixed(2)}%`)
    } else {
      lines.push(`Unchanged: ${stats.unchanged ?? stats.rows_table1}`)
    }
  } else if (mode === "profile") {
    const verdict = outcome.overall_verdict as string
    lines.push(`Status: ${verdict === "match" ? "PASS ✓" : "FAIL ✗"}`)
    lines.push(`Overall verdict: ${verdict}`)
    const cols = (outcome.columns ?? []) as Record<string, unknown>[]
    for (const col of cols) {
      lines.push(`  ${col.column}: ${col.verdict}`)
    }
  } else if (mode === "cascade") {
    const countResult = (outcome.count_result ?? {}) as Record<string, unknown>
    lines.push(`Stage: ${outcome.stopped_at}`)
    lines.push(`Count table1: ${countResult.count_table1}`)
    lines.push(`Count table2: ${countResult.count_table2}`)
    lines.push(`Count match: ${countResult.match_ ? "YES" : "NO"}`)
  } else {
    lines.push(JSON.stringify(outcome, null, 2))
  }

  lines.push("```")
  return lines.join("\n")
}
