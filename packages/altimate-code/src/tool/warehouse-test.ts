import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const WarehouseTestTool = Tool.define("warehouse_test", {
  description: "Test connectivity to a named warehouse connection. Verifies the connection is reachable and credentials are valid.",
  parameters: z.object({
    name: z.string().describe("Name of the warehouse connection to test"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("warehouse.test", { name: args.name })

      if (result.connected) {
        return {
          title: `Connection '${args.name}': OK`,
          metadata: { connected: true },
          output: `Successfully connected to warehouse '${args.name}'.`,
        }
      }

      return {
        title: `Connection '${args.name}': FAILED`,
        metadata: { connected: false },
        output: `Failed to connect to warehouse '${args.name}'.\nError: ${result.error ?? "Unknown error"}`,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: `Connection '${args.name}': ERROR`,
        metadata: { connected: false },
        output: `Failed to test connection: ${msg}\n\nEnsure the Python bridge is running and altimate-engine is installed.`,
      }
    }
  },
})
