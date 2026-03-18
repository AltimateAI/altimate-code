import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

export const WarehouseAddTool = Tool.define("warehouse_add", {
  description:
    "Add a new warehouse connection. Stores credentials securely in OS keyring when available, metadata in connections.json.",
  parameters: z.object({
    name: z.string().describe("Name for the warehouse connection"),
    config: z
      .record(z.string(), z.unknown())
      .describe(
        'Connection configuration. Must include "type" (postgres, snowflake, duckdb, etc). Example: {"type": "postgres", "host": "localhost", "port": 5432, "database": "mydb", "user": "admin", "password": "secret"}',
      ),
  }),
  async execute(args, ctx) {
    if (!args.config.type) {
      return {
        title: `Add '${args.name}': FAILED`,
        metadata: { success: false, name: args.name, type: "" },
        output: `Missing required field "type" in config. Specify the database type (postgres, snowflake, duckdb, mysql, sqlserver, bigquery, databricks, redshift).`,
      }
    }

    try {
      const result = await Dispatcher.call("warehouse.add", {
        name: args.name,
        config: args.config,
      })

      if (result.success) {
        return {
          title: `Add '${args.name}': OK`,
          metadata: { success: true, name: result.name, type: result.type },
          output: `Successfully added warehouse '${result.name}' (type: ${result.type}).\n\nUse warehouse_test to verify connectivity.`,
        }
      }

      return {
        title: `Add '${args.name}': FAILED`,
        metadata: { success: false, name: args.name, type: "" },
        output: `Failed to add warehouse '${args.name}'.\nError: ${result.error ?? "Unknown error"}`,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: `Add '${args.name}': ERROR`,
        metadata: { success: false, name: args.name, type: "" },
        output: `Failed to add warehouse: ${msg}`,
      }
    }
  },
})
