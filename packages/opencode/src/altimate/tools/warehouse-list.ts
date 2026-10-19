import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
// altimate_change start — workspace precedence
import * as Precedence from "../workspace/precedence"
// altimate_change end

// altimate_change start — point at the locations the registry actually reads
import { CONN_ENV_PREFIX, globalConfigPath, localConfigPath } from "../native/connections/registry"

/** The no-connections hint. Paths come from the registry's own helpers so it cannot drift from what is loaded. */
export function noConnectionsMessage(): string {
  return [
    "No warehouse connections configured.",
    "",
    "Connections are read from these sources (later ones override earlier ones):",
    `  1. ${globalConfigPath()} (global)`,
    `  2. ${localConfigPath()} (this project)`,
    `  3. ${CONN_ENV_PREFIX}<NAME> environment variables, each holding one connection's config as JSON`,
    "",
    "Use the warehouse_add tool to add one, or create a connections.json at one of the paths above with:",
    "{",
    '  "my-db": { "type": "postgres", "host": "localhost", "port": 5432, "database": "mydb", "user": "user", "password": "pass" }',
    "}",
    "",
    "Do not put connections.json in .opencode/; it is not read from there.",
  ].join("\n")
}
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
          output: noConnectionsMessage(),
        }
      }

      // altimate_change start — workspace precedence.
      // Annotated here, in this tool's own markdown, rather than on WarehouseInfo:
      // that struct is shared by every consumer of `warehouse.list`, and a field
      // added there would surface far beyond this listing. The notes re-validate the
      // snapshot against the current binding the way the query tools do, so a
      // re-linked project is not told its rows are served by the old workspace.
      const notes = await Precedence.warehouseListNotes(ctx.sessionID, warehouses)
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
