import z from "zod"
import { Tool } from "../../tool/tool"
import { Bridge } from "../bridge/client"
import type { WarehouseExploreResult } from "../bridge/protocol"

export const WarehouseExploreTool = Tool.define("warehouse_explore", {
  description:
    "List all schemas and table names in the connected warehouse. " +
    "Use this FIRST to see what tables exist. Then use schema_inspect " +
    "on specific tables to see their column types and details.",
  parameters: z.object({
    warehouse: z.string().optional().describe("Warehouse connection name (auto-detected if omitted)"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("warehouse.explore", {
        warehouse: args.warehouse,
      })

      return {
        title: `Warehouse: ${result.table_count} tables`,
        metadata: { tableCount: result.table_count },
        output: formatExploreResult(result),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Warehouse: ERROR",
        metadata: { tableCount: 0 },
        output: `Failed to explore warehouse: ${msg}\n\nEnsure the Python bridge is running and a warehouse connection is configured.`,
      }
    }
  },
})

function formatExploreResult(result: WarehouseExploreResult): string {
  if (result.table_count === 0) return "(no tables found)"

  const lines: string[] = [`${result.table_count} tables found:`, ""]

  // Group by schema
  const bySchema = new Map<string, typeof result.tables>()
  for (const table of result.tables) {
    const list = bySchema.get(table.schema) || []
    list.push(table)
    bySchema.set(table.schema, list)
  }

  for (const [schema, tables] of bySchema) {
    lines.push(`### ${schema}`)
    for (const t of tables) {
      lines.push(`- ${t.name} (${t.columns.join(", ")})`)
    }
    lines.push("")
  }

  return lines.join("\n")
}
