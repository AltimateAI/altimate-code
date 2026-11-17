import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import * as Registry from "../native/connections/registry"
import { classifyAndCheck } from "./sql-classify"

export const DataDiffTool = Tool.define("data_diff", {
  description: [
    "Compare two database tables or query results row-by-row to find differences.",
    "",
    "Two use cases:",
    "1. Migration validation — compare the same table across two databases:",
    '   source="orders" source_warehouse="postgres_prod" target_warehouse="snowflake_dw"',
    "2. Query optimization — compare results of two SQL queries on the same database:",
    '   source="SELECT id, amount FROM orders WHERE ..." target="SELECT id, amount FROM orders_v2 WHERE ..."',
    "",
    "Algorithms:",
    "- auto: JoinDiff if same dialect, HashDiff if cross-database (default)",
    "- joindiff: FULL OUTER JOIN (fast, same-database only)",
    "- hashdiff: Bisection with checksums (cross-database, any scale)",
    "- profile: Column-level statistics comparison (no row-level diff)",
    "- cascade: Profile first, then HashDiff on columns that diverged",
    "",
    "For very large tables (>10M rows), set partition_column to split work into smaller",
    "independent diffs (see partition_column parameter for modes).",
    "",
    "⚠ Compliance note: sample diff rows (up to 5) appear in tool output and are sent to the",
    "LLM provider. If comparing PII/PHI/PCI data, use algorithm='profile' (stats only, no values).",
  ].join("\n"),
  parameters: z.object({
    source: z.string().describe(
      "Source table name (e.g. 'orders', 'db.schema.orders') or a full SQL query starting with SELECT/WITH",
    ),
    target: z.string().describe(
      "Target table name or SQL query to compare against source",
    ),
    key_columns: z
      .array(z.string())
      .describe("Primary key columns that uniquely identify each row (e.g. ['id'] or ['order_id', 'line_item'])"),
    source_warehouse: z.string().optional().describe("Source warehouse connection name"),
    target_warehouse: z.string().optional().describe(
      "Target warehouse connection name. Omit to use the same warehouse as source (query comparison mode)",
    ),
    extra_columns: z
      .array(z.string())
      .optional()
      .describe(
        "Columns to compare beyond the key columns. " +
        "IMPORTANT: If omitted AND source is a plain table name, columns are auto-discovered from the schema " +
        "(excluding key columns, audit/timestamp columns matched by name like updated_at/created_at, " +
        "and columns with auto-generating timestamp defaults like DEFAULT NOW()/CURRENT_TIMESTAMP/GETDATE()/SYSDATE). " +
        "If omitted AND source is a SQL query, ONLY key columns are compared — value changes in non-key columns will NOT be detected. " +
        "Always provide explicit extra_columns when comparing SQL queries to ensure value-level comparison."
      ),
    algorithm: z
      .enum(["auto", "joindiff", "hashdiff", "profile", "cascade"])
      .optional()
      .default("auto")
      .describe("Comparison algorithm"),
    where_clause: z.string().optional().describe("Optional WHERE filter applied to both tables"),
    numeric_tolerance: z
      .number()
      .optional()
      .describe("Absolute tolerance for numeric comparisons (e.g. 0.01 for cent-level tolerance)"),
    timestamp_tolerance_ms: z
      .number()
      .optional()
      .describe("Tolerance for timestamp comparisons in milliseconds"),
    partition_column: z
      .string()
      .optional()
      .describe(
        "Column to partition on before diffing. Splits the table into groups and diffs each independently. " +
        "Three modes depending on which other params you set:\n" +
        "  • Date column   → set partition_granularity (day/week/month/year). E.g. partition_column='l_shipdate', partition_granularity='month'\n" +
        "  • Numeric column → set partition_bucket_size. E.g. partition_column='l_orderkey', partition_bucket_size=100000\n" +
        "  • Categorical   → set neither. Works for string/enum/boolean columns like 'status', 'region', 'country'. Groups by distinct values.\n" +
        "Results are aggregated with a per-partition breakdown showing which groups have differences.",
      ),
    partition_granularity: z
      .enum(["day", "week", "month", "year"])
      .optional()
      .describe("For date partition columns: truncation granularity. Omit for numeric or categorical columns."),
    partition_bucket_size: z
      .number()
      .optional()
      .describe("For numeric partition columns: size of each bucket. E.g. 100000 splits l_orderkey into ranges of 100K. Omit for date or categorical columns."),
  }),
  async execute(args, ctx) {
    // Require read permission — data diff executes SELECT queries. Each side is checked in its own
    // warehouse's dialect; one ask covers both when they run on the same warehouse. An omitted or
    // empty source is the registry's first warehouse, as the diff engine resolves it.
    const sourceWarehouse = args.source_warehouse || Registry.list().warehouses[0]?.name
    const targetWarehouse = args.target_warehouse || sourceWarehouse
    const sides =
      targetWarehouse === sourceWarehouse
        ? [{ patterns: [args.source.slice(0, 120), args.target.slice(0, 120)], warehouse: sourceWarehouse }]
        : [
            { patterns: [args.source.slice(0, 120)], warehouse: sourceWarehouse },
            { patterns: [args.target.slice(0, 120)], warehouse: targetWarehouse },
          ]
    // The hard deny is checked on the whole SQL here; the ask's patterns are 120-character previews,
    // which a cut inside a literal would make read differently.
    const dialectOf = (warehouse?: string) => Registry.canonicalType(warehouse ? Registry.getConfig(warehouse)?.type : undefined) ?? undefined
    for (const [sql, warehouse] of [[args.source, sourceWarehouse], [args.target, targetWarehouse]] as const)
      if (classifyAndCheck(sql, dialectOf(warehouse)).blocked)
        throw new Error("DROP DATABASE, DROP SCHEMA and TRUNCATE are blocked for safety. This cannot be overridden.")
    for (const side of sides)
      await ctx.ask({
        permission: "sql_execute_read",
        patterns: side.patterns,
        always: ["*"],
        metadata: { warehouse: side.warehouse, hardDenyChecked: true },
      })

    try {
      const result = await Dispatcher.call("data.diff", {
        source: args.source,
        target: args.target,
        key_columns: args.key_columns,
        source_warehouse: args.source_warehouse,
        target_warehouse: args.target_warehouse || undefined, // "" is the source warehouse, as the ask resolves it
        extra_columns: args.extra_columns,
        algorithm: args.algorithm,
        where_clause: args.where_clause,
        numeric_tolerance: args.numeric_tolerance,
        timestamp_tolerance_ms: args.timestamp_tolerance_ms,
        partition_column: args.partition_column,
        partition_granularity: args.partition_granularity,
        partition_bucket_size: args.partition_bucket_size,
      })

      if (!result.success) {
        return {
          title: "Data diff: ERROR",
          metadata: { success: false, steps: result.steps, error: result.error },
          output: `Data diff failed: ${result.error}`,
        }
      }

      const outcome = result.outcome as any
      let output = formatOutcome(outcome, args.source, args.target)

      if (result.partition_results?.length) {
        output += formatPartitionResults(result.partition_results, args.partition_column!)
      }

      // Report auto-excluded columns so the LLM and user know what was skipped
      const excluded = (result as any).excluded_audit_columns as string[] | undefined
      if (excluded && excluded.length > 0) {
        output += `\n\n  Note: ${excluded.length} column${excluded.length === 1 ? "" : "s"} auto-excluded from comparison (audit name patterns + auto-timestamp defaults like NOW()/CURRENT_TIMESTAMP): ${excluded.join(", ")}`
      }

      return {
        title: `Data diff: ${summarize(outcome)}`,
        metadata: { success: true, steps: result.steps },
        output,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Data diff: ERROR",
        metadata: { success: false, steps: 0, error: msg },
        output: `Data diff failed: ${msg}`,
      }
    }
  },
})

function summarize(outcome: any): string {
  if (!outcome) return "complete"

  // Rust serializes ReladiffOutcome as {mode: "diff"|"profile"|..., stats: {...}, diff_rows: [...]}
  if (outcome.mode === "diff") {
    const s = outcome.stats ?? {}
    const e1 = Number(s.exclusive_table1 ?? 0)
    const e2 = Number(s.exclusive_table2 ?? 0)
    const upd = Number(s.updated ?? 0)
    if (e1 === 0 && e2 === 0 && upd === 0) return "IDENTICAL ✓"
    const parts: string[] = []
    if (e1 > 0) parts.push(`${e1} only in source`)
    if (e2 > 0) parts.push(`${e2} only in target`)
    if (upd > 0) parts.push(`${upd} updated`)
    return parts.join(", ")
  }
  if (outcome.mode === "profile") return "profile complete"
  if (outcome.mode === "cascade") return "cascade complete"

  return "complete"
}

function formatOutcome(outcome: any, source: string, target: string): string {
  if (!outcome) return "Comparison complete."

  const lines: string[] = []

  // Rust serializes ReladiffOutcome as {mode: "diff", diff_rows: [...], stats: {...}}
  // stats: rows_table1, rows_table2, exclusive_table1, exclusive_table2, updated, unchanged
  if (outcome.mode === "diff") {
    const s = outcome.stats ?? {}
    const rows1 = Number(s.rows_table1 ?? 0)
    const rows2 = Number(s.rows_table2 ?? 0)
    const e1 = Number(s.exclusive_table1 ?? 0)
    const e2 = Number(s.exclusive_table2 ?? 0)
    const updated = Number(s.updated ?? 0)
    const unchanged = Number(s.unchanged ?? 0)

    if (e1 === 0 && e2 === 0 && updated === 0) {
      lines.push(`✓ Tables are IDENTICAL`)
      if (rows1 > 0) lines.push(`  Rows checked: ${rows1.toLocaleString()}`)
      return lines.join("\n")
    }

    lines.push(`✗ Tables DIFFER`)
    lines.push(``)
    lines.push(`  Source:  ${source}`)
    lines.push(`  Target:  ${target}`)
    lines.push(``)

    if (rows1 > 0) lines.push(`  Source rows:        ${rows1.toLocaleString()}`)
    if (rows2 > 0) lines.push(`  Target rows:        ${rows2.toLocaleString()}`)
    if (e1 > 0) lines.push(`  Only in source:     ${e1.toLocaleString()}`)
    if (e2 > 0) lines.push(`  Only in target:     ${e2.toLocaleString()}`)
    if (updated > 0) lines.push(`  Updated rows:       ${updated.toLocaleString()}`)
    if (unchanged > 0) lines.push(`  Identical rows:     ${unchanged.toLocaleString()}`)

    const diffRows = outcome.diff_rows ?? []
    if (diffRows.length > 0) {
      lines.push(``)
      lines.push(`  Sample differences (first ${Math.min(diffRows.length, 5)}):`)
      for (const d of diffRows.slice(0, 5)) {
        const label = d.sign === "-" ? "source only" : "target only"
        // `d.values?.join(" | ") ?? "(no values)"` misses the common case where
        // `values` is an empty array — `[].join(" | ")` returns "" (not null),
        // so the coalesce never triggers. Gate on length explicitly.
        const values = d.values?.length ? d.values.join(" | ") : "(no values)"
        lines.push(`    [${label}] ${values}`)
      }
    }

    return lines.join("\n")
  }

  if (outcome.mode === "profile") {
    const cols = outcome.column_stats ?? outcome.columns ?? []
    lines.push(`Column Profile Comparison`)
    lines.push(``)
    for (const col of cols) {
      const verdict = col.verdict === "match" ? "✓" : col.verdict === "within_tolerance" ? "~" : "✗"
      lines.push(`  ${verdict} ${col.column}: ${col.verdict}`)
      if (col.source_stats && col.target_stats) {
        lines.push(`      source: count=${col.source_stats.count} nulls=${col.source_stats.null_count} min=${col.source_stats.min} max=${col.source_stats.max}`)
        lines.push(`      target: count=${col.target_stats.count} nulls=${col.target_stats.null_count} min=${col.target_stats.min} max=${col.target_stats.max}`)
      }
    }
    return lines.join("\n")
  }

  return JSON.stringify(outcome, null, 2)
}

function formatPartitionResults(
  partitions: Array<{ partition: string; rows_source: number; rows_target: number; differences: number; status: string; error?: string }>,
  partitionColumn: string,
): string {
  const lines: string[] = ["", `Partition breakdown (by ${partitionColumn}):`]

  const clean = partitions.filter((p) => p.status === "identical")
  const dirty = partitions.filter((p) => p.status === "differ")
  const errored = partitions.filter((p) => p.status === "error")

  if (dirty.length === 0 && errored.length === 0) {
    lines.push(`  ✓ All ${partitions.length} partitions identical`)
    return lines.join("\n")
  }

  for (const p of dirty) {
    lines.push(`  ✗ ${p.partition}  source=${p.rows_source.toLocaleString()}  target=${p.rows_target.toLocaleString()}  diff=${p.differences.toLocaleString()}`)
  }
  for (const p of errored) {
    lines.push(`  ! ${p.partition}  ERROR: ${p.error}`)
  }
  if (clean.length > 0) {
    lines.push(`  ✓ ${clean.length} partition${clean.length === 1 ? "" : "s"} identical`)
  }

  return lines.join("\n")
}
