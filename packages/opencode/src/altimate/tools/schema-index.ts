import z from "zod"
import { Tool } from "../../tool/tool"
import { Bridge } from "../bridge/client"
import type { SchemaIndexResult } from "../bridge/protocol"

export const SchemaIndexTool = Tool.define("schema_index", {
  description:
    "Index a warehouse's schema metadata (databases, schemas, tables, columns) into a local cache for fast search. Run this after connecting to a new warehouse or when schema changes occur.",
  parameters: z.object({
    warehouse: z.string().describe("Warehouse connection name from connections.json"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("schema.index", {
        warehouse: args.warehouse,
      })

      return {
        title: `Schema Indexed: ${result.warehouse}`,
        metadata: {
          schemas: result.schemas_indexed,
          tables: result.tables_indexed,
          columns: result.columns_indexed,
        },
        output: formatIndexResult(result),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Schema Index: ERROR",
        metadata: { schemas: 0, tables: 0, columns: 0 },
        output: `Failed to index warehouse schema: ${msg}\n\nEnsure the warehouse connection is configured in connections.json and the Python bridge is running.`,
      }
    }
  },
})

function formatIndexResult(result: SchemaIndexResult): string {
  const lines: string[] = [
    `Warehouse: ${result.warehouse} (${result.type})`,
    `Schemas indexed: ${result.schemas_indexed}`,
    `Tables indexed: ${result.tables_indexed}`,
    `Columns indexed: ${result.columns_indexed}`,
    `Timestamp: ${result.timestamp}`,
    "",
    "Schema cache is now ready. Use schema_search to find tables and columns by name or description.",
  ]
  return lines.join("\n")
}
