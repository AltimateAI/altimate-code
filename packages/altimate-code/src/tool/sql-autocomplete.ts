import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"
import type { SqlAutocompleteResult } from "../bridge/protocol"

export const SqlAutocompleteTool = Tool.define("sql_autocomplete", {
  description:
    "Get schema-aware auto-complete suggestions for SQL. Given a partial table/column name, returns matching tables and columns from the indexed warehouse schema cache. Requires schema_index to be run first.",
  parameters: z.object({
    prefix: z.string().describe("Partial name to complete (e.g., 'cust', 'order_d', 'rev')"),
    position: z
      .enum(["table", "column", "schema", "any"])
      .optional()
      .default("any")
      .describe("What kind of suggestion: table names, column names, schema names, or any"),
    warehouse: z.string().optional().describe("Limit to a specific warehouse connection"),
    table_context: z
      .array(z.string())
      .optional()
      .describe("Tables currently in the query — columns from these tables are boosted"),
    limit: z.number().optional().default(20).describe("Max suggestions"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("sql.autocomplete", {
        prefix: args.prefix,
        position: args.position,
        warehouse: args.warehouse,
        table_context: args.table_context,
        limit: args.limit,
      })

      if (result.suggestion_count === 0) {
        return {
          title: `Complete "${args.prefix}": no matches`,
          metadata: { suggestion_count: 0, position: args.position ?? "any" },
          output: `No matches for "${args.prefix}". Ensure schema_index has been run to populate the cache.`,
        }
      }

      return {
        title: `Complete "${args.prefix}": ${result.suggestion_count} match${result.suggestion_count !== 1 ? "es" : ""}`,
        metadata: { suggestion_count: result.suggestion_count, position: args.position ?? "any" },
        output: formatSuggestions(result),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Complete: ERROR",
        metadata: { suggestion_count: 0, position: args.position ?? "any" },
        output: `Failed to get completions: ${msg}\n\nEnsure schema_index has been run and the Python bridge is running.`,
      }
    }
  },
})

function formatSuggestions(result: SqlAutocompleteResult): string {
  const lines: string[] = []

  const tables = result.suggestions.filter((s) => s.type === "table")
  const columns = result.suggestions.filter((s) => s.type === "column")
  const schemas = result.suggestions.filter((s) => s.type === "schema")

  if (tables.length > 0) {
    lines.push("Tables:")
    for (const t of tables) {
      lines.push(`  ${t.name} (${t.detail}) — ${t.fqn}`)
    }
    lines.push("")
  }

  if (columns.length > 0) {
    lines.push("Columns:")
    for (const c of columns) {
      const ctx = c.in_context ? " *" : ""
      lines.push(`  ${c.name} ${c.detail ? `(${c.detail})` : ""} — ${c.table ?? ""}${ctx}`)
    }
    if (columns.some((c) => c.in_context)) {
      lines.push("  (* = column from a table in your current query)")
    }
    lines.push("")
  }

  if (schemas.length > 0) {
    lines.push("Schemas:")
    for (const s of schemas) {
      lines.push(`  ${s.name}`)
    }
  }

  return lines.join("\n")
}
