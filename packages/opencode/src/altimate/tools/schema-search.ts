import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import type { SchemaSearchResult } from "../native/types"

export const SchemaSearchTool = Tool.define("schema_search", {
  description:
    "Search indexed warehouse metadata for tables and columns. Supports natural language queries like 'customer tables', 'price columns', 'order date fields'. Requires schema_index to be run first.",
  parameters: z.object({
    query: z.string().describe("Search query — table names, column names, data types, or natural language descriptions"),
    warehouse: z.string().optional().describe("Limit search to a specific warehouse connection"),
    limit: z.number().optional().describe("Max results per category (default 20)"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("schema.search", {
        query: args.query,
        warehouse: args.warehouse,
        limit: args.limit,
      })

      if (result.match_count === 0) {
        return {
          title: `Schema Search: "${args.query}" — no results`,
          metadata: { matchCount: 0, tableCount: 0, columnCount: 0 },
          output: `No tables or columns matching "${args.query}" found in the schema cache.\n\nMake sure you've run schema_index first to populate the cache.`,
        }
      }

      return {
        title: `Schema Search: "${args.query}" — ${result.match_count} results`,
        metadata: {
          matchCount: result.match_count,
          tableCount: result.tables.length,
          columnCount: result.columns.length,
        },
        output: formatSearchResult(result),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Schema Search: ERROR",
        metadata: { matchCount: 0, tableCount: 0, columnCount: 0 },
        output: `Failed to search schema: ${msg}\n\nEnsure schema_index has been run and the dispatcher is running.`,
      }
    }
  },
})

function formatSearchResult(result: SchemaSearchResult): string {
  const lines: string[] = []

  if (result.tables.length > 0) {
    lines.push(`## Tables (${result.tables.length} matches)`)
    lines.push("")
    lines.push("FQN | Type | Warehouse")
    lines.push("----|------|----------")
    for (const t of result.tables) {
      lines.push(`${t.fqn} | ${t.type} | ${t.warehouse}`)
    }
    lines.push("")
  }

  if (result.columns.length > 0) {
    lines.push(`## Columns (${result.columns.length} matches)`)
    lines.push("")
    lines.push("FQN | Type | Nullable")
    lines.push("----|------|--------")
    for (const c of result.columns) {
      lines.push(`${c.fqn} | ${c.data_type ?? "unknown"} | ${c.nullable ? "YES" : "NO"}`)
    }
  }

  return lines.join("\n")
}
