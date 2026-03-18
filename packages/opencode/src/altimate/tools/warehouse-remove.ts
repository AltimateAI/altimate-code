import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

export const WarehouseRemoveTool = Tool.define("warehouse_remove", {
  description: "Remove a warehouse connection. Deletes both the config entry and any stored keyring credentials.",
  parameters: z.object({
    name: z.string().describe("Name of the warehouse connection to remove"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("warehouse.remove", { name: args.name })

      if (result.success) {
        return {
          title: `Remove '${args.name}': OK`,
          metadata: { success: true },
          output: `Successfully removed warehouse '${args.name}' and its stored credentials.`,
        }
      }

      return {
        title: `Remove '${args.name}': FAILED`,
        metadata: { success: false },
        output: `Failed to remove warehouse '${args.name}'.\nError: ${result.error ?? "Connection not found or is defined via environment variable"}`,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: `Remove '${args.name}': ERROR`,
        metadata: { success: false },
        output: `Failed to remove warehouse: ${msg}`,
      }
    }
  },
})
