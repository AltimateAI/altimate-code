import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const WarehouseListTool = Tool.define("warehouse_list", {
  description: "List all configured warehouse connections. Shows connection name, type, and database.",
  parameters: z.object({}),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("warehouse.list", {})

      if (result.warehouses.length === 0) {
        return {
          title: "Warehouses: none configured",
          metadata: { count: 0 },
          output: "No warehouse connections configured.\n\nTo add a connection, create a connections.json file in .altimate-code/ with:\n{\n  \"my-db\": { \"type\": \"postgres\", \"host\": \"localhost\", \"port\": 5432, \"database\": \"mydb\", \"user\": \"user\", \"password\": \"pass\" }\n}",
        }
      }

      const lines: string[] = ["Name | Type | Database", "-----|------|--------"]
      for (const wh of result.warehouses) {
        lines.push(`${wh.name} | ${wh.type} | ${wh.database ?? "-"}`)
      }

      return {
        title: `Warehouses: ${result.warehouses.length} configured`,
        metadata: { count: result.warehouses.length },
        output: lines.join("\n"),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Warehouses: ERROR",
        metadata: { count: 0 },
        output: `Failed to list warehouses: ${msg}\n\nEnsure the Python bridge is running and altimate-engine is installed.`,
      }
    }
  },
})
