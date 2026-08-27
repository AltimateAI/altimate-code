import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
// altimate_change start — workspace precedence
import * as Precedence from "../workspace/precedence"
// altimate_change end

export const WarehouseListTool = Tool.define("warehouse_list", {
  description: "List all configured warehouse connections. Shows connection name, type, and database.",
  parameters: z.object({}),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("warehouse.list", {})

      const warehouses = result.warehouses ?? []
      if (warehouses.length === 0) {
        return {
          title: "Warehouses: none configured",
          metadata: { count: 0 },
          output: "No warehouse connections configured.\n\nTo add a connection, create a connections.json file in .opencode/ with:\n{\n  \"my-db\": { \"type\": \"postgres\", \"host\": \"localhost\", \"port\": 5432, \"database\": \"mydb\", \"user\": \"user\", \"password\": \"pass\" }\n}",
        }
      }

      // altimate_change start — workspace precedence.
      // Annotated here, in this tool's own markdown, rather than on WarehouseInfo:
      // that struct is shared by every consumer of `warehouse.list`, and a field
      // added there would surface far beyond this listing.
      const precedence = Precedence.forSession(ctx.sessionID)
      const notes = new Map<string, string>()
      for (const wh of warehouses) {
        const note = Precedence.warehouseListNote(precedence, wh.type)
        if (note) notes.set(wh.name, note)
      }
      const shadowedCount = notes.size

      const lines: string[] = shadowedCount
        ? ["Name | Type | Database | Served by", "-----|------|----------|----------"]
        : ["Name | Type | Database", "-----|------|--------"]
      for (const wh of warehouses) {
        const row = `${wh.name} | ${wh.type} | ${wh.database ?? "-"}`
        lines.push(shadowedCount ? `${row} | ${notes.get(wh.name) ?? "local"}` : row)
      }

      return {
        title: `Warehouses: ${warehouses.length} configured`,
        metadata: { count: warehouses.length, shadowed: shadowedCount },
        output: lines.join("\n"),
      }
      // altimate_change end
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Warehouses: ERROR",
        metadata: { count: 0, error: msg },
        output: `Failed to list warehouses: ${msg}\n\nCheck your connection configuration and try again.`,
      }
    }
  },
})
